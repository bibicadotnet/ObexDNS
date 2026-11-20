import { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { Env, ExecutionContext, ProfileSettings, ResolutionLog } from "../types";
import { LogModel, generateLogId } from "../models/log";
import type { RollupItem } from "../models/log/aggregation";
import { cacheUtils } from "../utils/cache";
import { envNumber } from "../utils/envNumber";
import {
  encryptSensitiveLogData,
  encryptSensitiveLogDataWithDek,
  PqcProfilePublicKey,
} from "../lib/crypto/e2ee";
import {
  ensureActiveDek,
  invalidateActiveDek,
  ActiveDek,
} from "../lib/crypto/dekManager";

export type ProfileLogPublicKey = JsonWebKey | PqcProfilePublicKey;

/** In-memory cache for profile E2EE public keys with 5-minute TTL */
const profileKeyCache = new Map<string, { key: ProfileLogPublicKey | null; expiresAt: number }>();

/**
 * Retrieves the E2EE public key for a profile, using an in-memory cache to avoid repeated D1 reads.
 *
 * `null` means the profile has no E2EE key (plaintext logging is intended). `undefined` means the
 * lookup FAILED, so the E2EE state is unknown: callers must not treat that as "no key", or an E2EE
 * profile's data would be stored in plaintext during a database read error.
 */
export async function getProfileLogPublicKey(
  db: D1Database,
  profileId: string
): Promise<ProfileLogPublicKey | null | undefined> {
  const now = Date.now();
  const cached = profileKeyCache.get(profileId);
  if (cached && cached.expiresAt > now) {
    return cached.key;
  }

  try {
    let row: { public_key: string } | null = null;
    try {
      row = await db
        .prepare("SELECT public_key FROM user_log_keys WHERE profile_id = ? AND (is_active IS NULL OR is_active = 1)")
        .bind(profileId)
        .first<{ public_key: string }>();
    } catch (columnErr: any) {
      if (String(columnErr?.message || columnErr).includes("no such column: is_active")) {
        row = await db
          .prepare("SELECT public_key FROM user_log_keys WHERE profile_id = ?")
          .bind(profileId)
          .first<{ public_key: string }>();
      } else {
        throw columnErr;
      }
    }

    const key = row?.public_key ? (JSON.parse(row.public_key) as ProfileLogPublicKey) : null;
    // Cache active key for 5 minutes; if null (E2EE not enabled), cache for 5 minutes as well
    // Rapid invalidation is handled by invalidateProfileLogKeyCache() when user configures E2EE
    const ttlMs = 5 * 60 * 1000;
    profileKeyCache.set(profileId, { key, expiresAt: now + ttlMs });
    return key;
  } catch (err) {
    console.error(`[E2EE] Failed to fetch log public key for profile ${profileId}:`, err);
    return undefined;
  }
}

/**
 * Invalidates the in-memory E2EE public key and active DEK cache for a profile.
 */
export function invalidateProfileLogKeyCache(profileId: string): void {
  profileKeyCache.delete(profileId);
  invalidateActiveDek(profileId);
}

/** In-memory batch queue of logs waiting to be flushed to D1 */
const logBatchQueue: ResolutionLog[] = [];

/** Default hard ceiling for logBatchQueue (LOG_QUEUE_MAX_ROWS overrides it). */
const DEFAULT_MAX_LOG_QUEUE = 10_000;

/**
 * Hard ceiling for logBatchQueue (LOG_QUEUE_MAX_ROWS, default 10000; values below 100 are ignored). A flush drains only
 * MAX_BATCH_SIZE rows per database round trip, so a slow or failing database lets the queue grow
 * with the cache-miss rate. Beyond this many pending rows new logs are dropped (the oldest, already
 * queued logs keep their place), which bounds RAM (about 1 KB per row) instead of letting it climb
 * until the process is killed.
 */
function getMaxLogQueue(env: Env | undefined): number {
  return Math.floor(envNumber(envOrProcess(env, "LOG_QUEUE_MAX_ROWS"), DEFAULT_MAX_LOG_QUEUE, { min: 100 }));
}

/** Total logs dropped because the queue was full since process start (diagnostics and tests). */
let droppedLogsTotal = 0;
let droppedLogsSinceWarn = 0;
let lastDropWarnAt = 0;
const DROP_WARN_INTERVAL_MS = 60_000;

function noteDroppedLogs(count: number, max: number): void {
  if (count <= 0) return;
  droppedLogsTotal += count;
  droppedLogsSinceWarn += count;
  const now = Date.now();
  if (now - lastDropWarnAt >= DROP_WARN_INTERVAL_MS) {
    console.warn(
      `[LogBatcher] Log queue full (${max} pending): dropped ${droppedLogsSinceWarn} log(s) since the last warning. The database is writing slower than queries arrive.`
    );
    lastDropWarnAt = now;
    droppedLogsSinceWarn = 0;
  }
}

/** Logs of E2EE (or unknown-state) profiles dropped because they could not be encrypted. */
let unprotectedDroppedTotal = 0;
let unprotectedDroppedSinceWarn = 0;
let lastUnprotectedWarnAt = 0;

/**
 * An E2EE profile's log is stored only once it is encrypted. When the key lookup, the DEK or the
 * encryption fails, the log is dropped rather than written in plaintext.
 */
function noteUnprotectedLogsDropped(count: number): void {
  if (count <= 0) return;
  unprotectedDroppedTotal += count;
  unprotectedDroppedSinceWarn += count;
  const now = Date.now();
  if (now - lastUnprotectedWarnAt >= DROP_WARN_INTERVAL_MS) {
    console.warn(
      `[LogBatcher] Dropped ${unprotectedDroppedSinceWarn} log(s) of E2EE profile(s) that could not be encrypted (key lookup, DEK or encryption failed). They are never stored in plaintext.`
    );
    lastUnprotectedWarnAt = now;
    unprotectedDroppedSinceWarn = 0;
  }
}

/** Logs dropped because they could not be encrypted, since process start (diagnostics and tests). */
export function droppedUnprotectedLogCount(): number {
  return unprotectedDroppedTotal;
}

/** Number of logs waiting in the in-memory queue (diagnostics and tests). */
export function pendingLogCount(): number {
  return logBatchQueue.length;
}

/** Logs dropped because the queue was full since process start (diagnostics and tests). */
export function droppedLogCount(): number {
  return droppedLogsTotal;
}

/**
 * Immediately discards any pending in-memory logs for the specified profile IDs.
 * Called before deleting profile logs or deleting a profile to prevent stale logs
 * in logBatchQueue from being written to DB.
 */
/** In-flight batch being flushed */
let currentInFlightLogs: ResolutionLog[] | null = null;

/** Cache-hit rollup deltas taken out of hitCounters and currently being written (see flushLogBatch). */
let currentInFlightHitCounters: RollupItem[] | null = null;

export function discardPendingLogs(profileId: string): number {
  return discardPendingLogsFor([profileId]);
}

export function discardPendingLogsFor(profileIds: Set<string> | string[]): number {
  const pSet = profileIds instanceof Set ? profileIds : new Set(profileIds);
  if (pSet.size === 0) return 0;
  let count = 0;
  // Cache-hit counters of these profiles must not resurrect rollups after logs/profile deletion.
  for (const [k, item] of hitCounters) {
    if (pSet.has(item.profileId)) {
      hitCounters.delete(k);
    }
  }
  for (let i = logBatchQueue.length - 1; i >= 0; i--) {
    if (pSet.has(logBatchQueue[i].profile_id)) {
      logBatchQueue.splice(i, 1);
      count++;
    }
  }
  // Deltas already taken for the running flush: filtered in place so a failed write
  // cannot merge them back (phantom rollups after "delete logs").
  if (currentInFlightHitCounters) {
    for (let i = currentInFlightHitCounters.length - 1; i >= 0; i--) {
      if (pSet.has(currentInFlightHitCounters[i].profileId)) {
        currentInFlightHitCounters.splice(i, 1);
      }
    }
  }
  if (currentInFlightLogs) {
    for (let i = currentInFlightLogs.length - 1; i >= 0; i--) {
      if (pSet.has(currentInFlightLogs[i].profile_id)) {
        currentInFlightLogs.splice(i, 1);
        count++;
      }
    }
  }
  return count;
}

/** Maximum number of statements in a single db.batch() transaction */
const MAX_BATCH_SIZE = 40;

/** Debounce time window for micro-batch flushing (15 seconds) */
const FLUSH_INTERVAL_MS = 15_000;

/** Circuit breaker cooldown duration when D1 write quota is exceeded (1 hour) */
const CIRCUIT_BREAKER_COOLDOWN_SEC = 3600;

/** In-memory timestamp until which write operations are silenced */
let memoryCircuitBreakerUntil = 0;

/** Whether a deferred flush timer has already been scheduled */
let isFlushScheduled = false;

/** Concurrency guard: prevents multiple flush loops from executing simultaneously */
let isFlushing = false;

/** Timestamp of the last successful or attempted flush */
let lastFlushTime = Date.now();

/**
 * Checks if the D1 write quota circuit breaker is currently active.
 *
 * @param cache Cloudflare Cache API instance
 * @returns boolean True if write operations are currently silenced
 */
export async function isWriteQuotaTripped(cache?: any): Promise<boolean> {
  const now = Date.now();
  if (memoryCircuitBreakerUntil > now) {
    return true;
  }

  if (cache) {
    try {
      const trippedUntil = await cacheUtils.get<number>(cache, "d1:write_quota_tripped");
      if (trippedUntil && trippedUntil > Math.floor(now / 1000)) {
        memoryCircuitBreakerUntil = trippedUntil * 1000;
        return true;
      }
    } catch {
      // Non-critical cache read error
    }
  }

  return false;
}

/**
 * Activates the write circuit breaker when a D1 write quota limit error occurs.
 *
 * @param cache Cloudflare Cache API instance
 */
export async function tripWriteCircuitBreaker(cache?: any): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const trippedUntilSec = nowSec + CIRCUIT_BREAKER_COOLDOWN_SEC;
  memoryCircuitBreakerUntil = trippedUntilSec * 1000;

  // Clear pending queue to prevent memory leaks while writes are blocked
  logBatchQueue.length = 0;
  hitCounters.clear();
  isFlushScheduled = false;

  console.warn(
    `[LogBatcher] D1 write quota limit reached! Silencing log writes for ${CIRCUIT_BREAKER_COOLDOWN_SEC}s.`
  );

  if (cache) {
    try {
      await cacheUtils.set(cache, "d1:write_quota_tripped", trippedUntilSec, CIRCUIT_BREAKER_COOLDOWN_SEC);
    } catch {
      // Non-critical cache write error
    }
  }
}

/**
 * Flushes a batch of logs to D1 via db.batch().
 *
 * @param env Cloudflare Worker environment bindings
 * @param ctx ExecutionContext to extend background lifetime
 */
export async function flushLogBatch(env: Env, ctx?: ExecutionContext): Promise<void> {
  if (isFlushing) {
    return;
  }
  if (logBatchQueue.length === 0 && hitCounters.size === 0) {
    return;
  }

  isFlushing = true;
  let batchCommitted = false;
  try {
    isFlushScheduled = false;
    lastFlushTime = Date.now();

    const cache = (caches as any).default;
    if (await isWriteQuotaTripped(cache)) {
      logBatchQueue.length = 0;
      hitCounters.clear();
      return;
    }

    // Atomically extract up to MAX_BATCH_SIZE raw logs from the front of the queue
    // (may be empty when only cache-hit counters are pending)
    const logsToFlush = logBatchQueue.splice(0, MAX_BATCH_SIZE);

    if (logsToFlush.length === 0 && hitCounters.size === 0) {
      return;
    }

    currentInFlightLogs = logsToFlush;
    const logModel = new LogModel(env.DB);
    const statements: D1PreparedStatement[] = [];

    // Group logs by profile to batch E2EE public key lookup
    const profileIds = Array.from(new Set(logsToFlush.map((l) => l.profile_id)));
    const keyMap = new Map<string, ProfileLogPublicKey | null>();
    const dekMap = new Map<string, ActiveDek | null>();
    // Profiles whose E2EE state could not be determined (key lookup failed): never written in plaintext.
    const unknownProfiles = new Set<string>();

    await Promise.all(
      profileIds.map(async (pid) => {
        const pubKey = await getProfileLogPublicKey(env.DB, pid);
        if (pubKey === undefined) {
          unknownProfiles.add(pid);
          return;
        }
        if (pubKey) {
          keyMap.set(pid, pubKey);
          if ("pqc_pk" in pubKey) {
            // Directly ensure an active, unexpired DEK is provisioned.
            // ensureActiveDek checks in-memory expiration (existing.expiresAt > now)
            // and rotates only when the key has expired, incurring zero D1 I/O while valid.
            try {
              const activeDek = await ensureActiveDek(env.DB, pid, pubKey.pqc_pk);
              if (activeDek) {
                dekMap.set(pid, activeDek);
              }
            } catch (dekErr) {
              // No DEK: this profile's logs are dropped below (not stored in plaintext).
              console.error(`[LogBatcher] DEK provisioning failed for profile ${pid}:`, dekErr);
            }
          }
        }
      })
    );

    // Cache-hit counters ride in the same batch. Their profiles need the same E2EE decision
    // (key lookups are RAM-cached for 5 minutes); no DEK provisioning is needed for them.
    const hitProfileIds = new Set<string>();
    for (const item of hitCounters.values()) hitProfileIds.add(item.profileId);
    await Promise.all(
      Array.from(hitProfileIds)
        .filter((pid) => !profileIds.includes(pid))
        .map(async (pid) => {
          const pubKey = await getProfileLogPublicKey(env.DB, pid);
          if (pubKey === undefined) unknownProfiles.add(pid);
          else if (pubKey) keyMap.set(pid, pubKey);
        })
    );

    // No await between taking the hit deltas and building the statements below.
    const hitChunkSize = getHitChunkSize(env);
    // Profiles with an unknown E2EE state keep their counters in RAM until the lookup works again.
    const checkedHitProfiles = new Set(Array.from(hitProfileIds).filter((pid) => !unknownProfiles.has(pid)));
    const hitItems = takeHitItems(checkedHitProfiles, new Set(keyMap.keys()), hitChunkSize);
    currentInFlightHitCounters = hitItems;
    statements.push(...logModel.aggregation.createUpsertStatementsFromItems(hitItems));

    // Logs of profiles with an unknown E2EE state are dropped, never written in plaintext.
    const writableLogs =
      unknownProfiles.size > 0 ? logsToFlush.filter((l) => !unknownProfiles.has(l.profile_id)) : logsToFlush;
    noteUnprotectedLogsDropped(logsToFlush.length - writableLogs.length);

    if (writableLogs.length === 0 && statements.length === 0) {
      return;
    }

    // Generate atomic rollup UPSERT statements from unencrypted in-memory logs BEFORE sensitive data encryption.
    // Profiles with an E2EE key (keyMap) only get action totals: no plaintext domain/client/country rollups.
    const rollupStatements = logModel.aggregation.createRollupUpsertStatements(
      writableLogs,
      new Set(keyMap.keys())
    );
    if (rollupStatements.length > 0) {
      statements.push(...rollupStatements);
    }

    let unencryptedCount = 0;
    for (const raw of writableLogs) {
      // Encrypt and blank a COPY: `raw` stays plaintext in logsToFlush so that a failed write, which
      // re-queues it, encrypts again from the real data instead of from already blanked fields.
      const log: ResolutionLog = { ...raw };
      const pubKey = keyMap.get(log.profile_id);
      if (pubKey) {
        try {
          const sensitiveData = {
            domain: log.domain,
            client_ip: log.client_ip,
            geo_country: log.geo_country,
            answer: log.answer,
            dest_geoip: log.dest_geoip,
            dest_country_code: log.dest_country_code,
            dest_country: log.dest_country,
            dest_isp: log.dest_isp,
            ecs: log.ecs,
            upstream: log.upstream,
            reason: log.reason,
          };

          if ("pqc_pk" in pubKey) {
            // Post-Quantum Periodic Envelope Encryption
            // ZERO expiration checks here: directly use the active DEK
            const activeDek = dekMap.get(log.profile_id);
            if (activeDek) {
              const encrypted = await encryptSensitiveLogDataWithDek(activeDek.dek, sensitiveData);
              log.encrypt_version = 2;
              log.kem_key_id = activeDek.kemKeyId;
              log.encrypted_payload = encrypted;
            }
          } else if ("kty" in pubKey) {
            // Legacy P-256 E2EE (ECDH JWK)
            const encrypted = await encryptSensitiveLogData(pubKey, sensitiveData);
            log.encrypt_version = 1;
            log.kem_key_id = null;
            log.encrypted_payload = encrypted;
          }

          if (log.encrypt_version && log.encrypt_version > 0) {
            log.domain = "";
            log.client_ip = "";
            log.geo_country = "";
            log.answer = undefined;
            log.dest_geoip = undefined;
            log.dest_country_code = null;
            log.dest_country = null;
            log.dest_isp = null;
            log.ecs = undefined;
            log.upstream = undefined;
            log.reason = undefined;
          }
        } catch (encErr) {
          console.error(`[LogBatcher] Encryption failed for profile ${log.profile_id}:`, encErr);
        }
        // E2EE profile but the log is not encrypted (no DEK, unsupported key, encryption error):
        // drop it instead of storing domain and client IP in plaintext.
        if (!(log.encrypt_version && log.encrypt_version > 0)) {
          unencryptedCount++;
          continue;
        }
      } else {
        log.encrypt_version = 0;
        log.kem_key_id = null;
      }
      statements.push(logModel.createInsertStatement(log));
    }
    noteUnprotectedLogsDropped(unencryptedCount);

    // Nothing left to write (e.g. every log of this batch was dropped).
    if (statements.length === 0) {
      return;
    }

    try {
      // One transaction for hit counters, log rollups and log rows
      await env.DB.batch(statements);
      batchCommitted = true;
    } catch (err: any) {
      const errorMsg = String(err?.message || err);

      // Detect Cloudflare D1 row write quota exhaustion
      if (
        errorMsg.includes("exceeded D1's free tier daily row write limit") ||
        errorMsg.includes("row write limit") ||
        errorMsg.includes("daily write limit")
      ) {
        await tripWriteCircuitBreaker(cache);
      } else {
        console.warn(`[LogBatcher] Batch write failed (${statements.length} stmts):`, errorMsg);
        // Re-queue the failed logs at the front so they aren't lost, as far as the queue has room.
        const maxQueue = getMaxLogQueue(env);
        const room = Math.max(0, maxQueue - logBatchQueue.length);
        if (room >= logsToFlush.length) {
          logBatchQueue.unshift(...logsToFlush);
        } else {
          logBatchQueue.unshift(...logsToFlush.slice(0, room));
          noteDroppedLogs(logsToFlush.length - room, maxQueue);
        }
        // Merge uncommitted hit deltas back (already filtered by discardPendingLogsFor)
        if (hitCounters.size < MAX_HIT_COUNTER_KEYS) {
          for (const item of hitItems) addRollupDelta(hitCounters, item);
        }
      }
    }
  } finally {
    currentInFlightLogs = null;
    currentInFlightHitCounters = null;
    isFlushing = false;
    if (batchCommitted && hitCounters.size >= getHitChunkSize(env) && !isLogWriteSilenced()) {
      // Backlog larger than one chunk: same pattern as log cleanup - small chunk, short pause
      // (lets DNS sockets run, SQLite is synchronous in serverfull), then the next chunk.
      // Only after a successful write, so a failing DB cannot cause a tight retry loop.
      const next = new Promise<void>((resolve) => setTimeout(resolve, getChunkPauseMs(env)))
        .then(() => flushLogBatch(env, ctx))
        .catch(() => {});
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(next);
    } else if (logBatchQueue.length > 0 || hitCounters.size > 0) {
      // If there are still items remaining, schedule the next batch
      scheduleDeferredFlush(env, ctx);
    }
  }
}

/**
 * Schedules a background deferred flush after FLUSH_INTERVAL_MS if one is not already pending.
 *
 * @param env Cloudflare Worker environment bindings
 * @param ctx ExecutionContext to extend background lifetime
 */
function scheduleDeferredFlush(env: Env, ctx?: ExecutionContext): void {
  if (isFlushScheduled) {
    return;
  }
  isFlushScheduled = true;

  // Use a promise timer resolved in background execution context
  const flushPromise = new Promise((resolve) => setTimeout(resolve, FLUSH_INTERVAL_MS))
    .then(() => flushLogBatch(env, ctx))
    .catch((e) => {
      isFlushScheduled = false;
      console.error("[LogBatcher] Deferred flush error:", e);
    });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(flushPromise);
  }
}

/**
 * Decides whether a query would actually be persisted by enqueueLog.
 * Callers MUST check this before doing any log-only enrichment (e.g. GeoIP),
 * so no network lookups are spent on logs that are going to be discarded.
 */
export function shouldLogQuery(
  settings: ProfileSettings | undefined,
  action: string | undefined
): boolean {
  return isLogPolicyEnabled(settings, action) && !isLogWriteSilenced();
}

/**
 * Pure profile-policy part of shouldLogQuery (no transient state):
 * false when retention is 0 or when PASS queries are configured to be skipped.
 */
export function isLogPolicyEnabled(
  settings: ProfileSettings | undefined,
  action: string | undefined
): boolean {
  // 1. Zero-retention policy: logging fully disabled
  if (settings && Number(settings.log_retention_days) === 0) {
    return false;
  }

  // 2. Skip PASS queries when skip_log_on_pass is enabled
  if (settings?.skip_log_on_pass && (action || "PASS").toUpperCase() === "PASS") {
    return false;
  }

  return true;
}

/** Fast memory circuit-breaker check (D1 write quota exceeded). */
export function isLogWriteSilenced(): boolean {
  return memoryCircuitBreakerUntil > Date.now();
}

/**
 * Enqueues a DNS resolution log for 15-second micro-batching and quota protection.
 *
 * @param log ResolutionLog object to insert
 * @param settings Current profile settings
 * @param env Cloudflare Worker environment bindings
 * @param ctx ExecutionContext to extend background lifetime
 */
export function enqueueLog(
  log: ResolutionLog,
  settings: ProfileSettings | undefined,
  env: Env,
  ctx: ExecutionContext
): void {
  if (!shouldLogQuery(settings, log.action)) {
    return;
  }

  // Ensure unique id is assigned before queueing raw log
  if (!log.id) {
    log.id = generateLogId();
  }

  // Enqueue the raw log entry, unless the queue is full (database outage / overload).
  // The flush logic below still runs so the backlog keeps being drained.
  const maxQueue = getMaxLogQueue(env);
  if (logBatchQueue.length >= maxQueue) {
    noteDroppedLogs(1, maxQueue);
  } else {
    logBatchQueue.push(log);
  }

  // Determine if an immediate flush is required or a deferred flush should be scheduled
  const now = Date.now();
  if (
    logBatchQueue.length >= MAX_BATCH_SIZE ||
    now - lastFlushTime >= FLUSH_INTERVAL_MS
  ) {
    ctx.waitUntil(flushLogBatch(env, ctx));
  } else {
    scheduleDeferredFlush(env, ctx);
  }
}

// ---------------------------------------------------------------------------
// Cache-hit counters
//
// A DNS cache hit is served from RAM and never produces a detailed log row (only misses do),
// but it is still a real query. Hits are therefore counted in memory and folded into the same
// hourly_rollups keys as logged queries, with `count = count + n`, every FLUSH_INTERVAL_MS.
// Rows written depend on the number of distinct keys, not on the number of queries.
// ---------------------------------------------------------------------------

/** Everything the rollup needs to know about one cache-hit query. */
export interface CacheHitEvent {
  profileId: string;
  accessPointId?: string;
  /** Unix seconds. */
  timestamp: number;
  action: string;
  domain: string;
  clientIp: string;
  geoCountry: string;
  destCountryCode?: string | null;
  destCountry?: string | null;
}

/** Pending cache-hit rollup deltas keyed like the hourly_rollups primary key. */
const hitCounters = new Map<string, RollupItem>();

/** Flush early when this many distinct keys are pending (bounds RAM, not accuracy). */
const MAX_HIT_COUNTER_KEYS = 5000;

/**
 * Hard RAM ceiling. If the database keeps failing, flushes cannot drain the map; beyond this many
 * distinct keys new hits are dropped (statistics lose a few counts, the process never balloons).
 */
const MAX_HIT_COUNTER_HARD_KEYS = MAX_HIT_COUNTER_KEYS * 4;

const envOrProcess = (env: Env | undefined, key: string): unknown =>
  (env as any)?.[key] ?? (typeof process !== "undefined" ? process.env?.[key] : undefined);

/** Pause between two chunks of a backlog; shares the knob used by log cleanup (LOG_CLEANUP_YIELD_SLEEP_MS, default 10 ms). */
function getChunkPauseMs(env: Env): number {
  return Math.floor(envNumber(envOrProcess(env, "LOG_CLEANUP_YIELD_SLEEP_MS"), 10, { min: 0 }));
}

/** Max distinct counter rows written per flush (CACHE_HIT_FLUSH_CHUNK_SIZE, default 200, min 20). */
function getHitChunkSize(env: Env): number {
  return Math.floor(envNumber(envOrProcess(env, "CACHE_HIT_FLUSH_CHUNK_SIZE"), 200, { min: 20 }));
}

/** Number of pending cache-hit counter rows (diagnostics and tests). */
export function pendingHitCounterRows(): number {
  return hitCounters.size;
}

function rollupMapKey(item: Omit<RollupItem, "count">): string {
  return `${item.profileId}|${item.metricType}|${item.hourTimestamp}|${item.key}|${item.subKey}|${item.accessPointId}`;
}

function addRollupDelta(
  map: Map<string, RollupItem>,
  item: RollupItem
): void {
  const k = rollupMapKey(item);
  const existing = map.get(k);
  if (existing) {
    existing.count += item.count;
  } else {
    map.set(k, { ...item });
  }
}

/**
 * Counts one cache hit into the in-memory rollup counters. Pure RAM work, no I/O.
 * Mirrors the metrics produced for logged queries (action, domain, client, destination)
 * so Analytics totals, per-device views and top-domain lists include cache hits.
 */
export function recordCacheHit(event: CacheHitEvent, env: Env, ctx?: ExecutionContext): void {
  if (!event.profileId) return;
  if (hitCounters.size >= MAX_HIT_COUNTER_HARD_KEYS) {
    scheduleDeferredFlush(env, ctx);
    return;
  }
  const hourTs = Math.floor(event.timestamp / 3600) * 3600;
  const apId = event.accessPointId || "";
  const base = { profileId: event.profileId, hourTimestamp: hourTs, accessPointId: apId, count: 1 };

  if (event.action) {
    addRollupDelta(hitCounters, { ...base, metricType: "action", key: event.action, subKey: "" });
  }
  if (event.domain && event.domain !== "[Encrypted]") {
    addRollupDelta(hitCounters, { ...base, metricType: "domain", key: event.domain, subKey: event.action || "" });
  }
  if (event.clientIp && event.clientIp !== "[Encrypted]") {
    addRollupDelta(hitCounters, { ...base, metricType: "client", key: event.clientIp, subKey: event.geoCountry || "" });
  }
  if (event.destCountryCode) {
    addRollupDelta(hitCounters, {
      ...base,
      metricType: "dest",
      key: event.destCountryCode.toUpperCase(),
      subKey: event.destCountry || ""
    });
  }

  // No timer of its own: hits are written by flushLogBatch, in the same 15s cycle and the same
  // db.batch() transaction as the log rows (a single writer for SQLite).
  if (hitCounters.size >= MAX_HIT_COUNTER_KEYS) {
    const p = flushLogBatch(env, ctx).catch(() => {});
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  } else {
    scheduleDeferredFlush(env, ctx);
  }
}

/**
 * Removes up to `limit` pending deltas from hitCounters and returns them.
 * Only profiles whose E2EE state was checked are taken. For E2EE profiles only the privacy-neutral
 * `action` totals are kept; their domain/client/destination deltas are dropped.
 */
function takeHitItems(checkedProfiles: Set<string>, e2eeProfiles: Set<string>, limit: number): RollupItem[] {
  const taken: RollupItem[] = [];
  for (const [k, item] of hitCounters) {
    if (taken.length >= limit) break;
    if (!checkedProfiles.has(item.profileId)) continue;
    hitCounters.delete(k);
    if (e2eeProfiles.has(item.profileId) && item.metricType !== "action") continue;
    taken.push(item);
  }
  return taken;
}

/**
 * Flushes everything pending (logs and cache-hit counters), e.g. on shutdown.
 * Stops when a flush makes no progress (write failure, circuit breaker, concurrent flush).
 */
export async function flushAllPending(env: Env, ctx?: ExecutionContext): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const before = logBatchQueue.length + hitCounters.size;
    if (before === 0) return;
    await flushLogBatch(env, ctx);
    if (logBatchQueue.length + hitCounters.size >= before) return;
  }
}
