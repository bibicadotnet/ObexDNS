import { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { Env } from "../../types";
import { SystemSettingsModel } from "../systemSettings";
import { KemKeyModel } from "../kemKey";
import { yieldToEventLoop } from "../../utils/yieldToEventLoop";
import { envNumber } from "../../utils/envNumber";

/** Extra delete rounds that hand unused per-profile quota to profiles that still have expired rows. */
const MAX_REDISTRIBUTION_ROUNDS = 5;

/** Rows affected by a D1-style result, or undefined when the driver did not report it. */
function changesOf(res: { meta?: { changes?: number; rows_written?: number } } | undefined): number | undefined {
  const meta = res?.meta;
  if (meta?.changes !== undefined) return meta.changes;
  if (meta?.rows_written !== undefined) return meta.rows_written;
  return undefined;
}

/**
 * Model responsible for enforcing log retention policies and purging
 * expired raw resolution logs and rollup records.
 */
export class LogRetentionModel {
  private readonly settingsModel: SystemSettingsModel;

  constructor(
    private readonly db: D1Database,
    settingsModel?: SystemSettingsModel,
    private readonly env?: Env
  ) {
    this.settingsModel = settingsModel ?? new SystemSettingsModel(db);
  }

  private getChunkSize(explicit?: number): number {
    if (explicit !== undefined && !isNaN(explicit)) return Math.max(100, Math.floor(explicit));
    const envVal = Number(this.env?.LOG_CLEANUP_CHUNK_SIZE);
    if (!isNaN(envVal) && envVal > 0) return Math.max(100, Math.floor(envVal));
    if (typeof process !== 'undefined') {
      const procVal = Number(process.env?.LOG_CLEANUP_CHUNK_SIZE);
      if (!isNaN(procVal) && procVal > 0) return Math.max(100, Math.floor(procVal));
    }
    return 2500;
  }

  private getYieldSleepMs(explicit?: number): number {
    if (explicit !== undefined && !isNaN(explicit)) return Math.max(0, Math.floor(explicit));
    const envVal = this.env?.LOG_CLEANUP_YIELD_SLEEP_MS !== undefined ? Number(this.env.LOG_CLEANUP_YIELD_SLEEP_MS) : undefined;
    if (envVal !== undefined && !isNaN(envVal) && envVal >= 0) return Math.max(0, Math.floor(envVal));
    if (typeof process !== 'undefined' && process.env?.LOG_CLEANUP_YIELD_SLEEP_MS !== undefined) {
      const procVal = Number(process.env.LOG_CLEANUP_YIELD_SLEEP_MS);
      if (!isNaN(procVal) && procVal >= 0) return Math.max(0, Math.floor(procVal));
    }
    return 10;
  }

  /**
   * Global log cleanup: runs on every cron trigger.
   *
   * Applies three independent safety caps:
   *   1. Time-based: deletes logs older than min(user_setting, MAX_LOG_RETENTION_DAYS).
   *      The global cap prevents users from setting arbitrarily long retention periods
   *      (e.g. 360 days) that would cause D1 to overflow.
   *   2. Batch limiting: deletes bounded rows per profile per run based on batchLimit
   *      to prevent write spikes.
   *   3. Daily quota budget: tracks deleted rows today via SystemSettingsModel,
   *      capping total deletions at dailyBudget per UTC day to prevent exhausting
   *      Cloudflare D1 daily write quota (100k writes/day).
   *
   * @param maxRetentionDays - Hard cap on log retention days (default 30).
   * @param batchLimit - Maximum total log rows deleted across all profiles in this run (default 1000).
   * @param dailyBudget - Maximum total log rows deleted across all profiles per day (default 20000).
   * @param orphanKeyOptions - Orphaned kem_keys cleanup tuning: minimum key age in seconds (default 86400)
   *   and max keys deleted per run (default 100).
   * @param capOptions - Optional hard cap on stored rows per profile. When `maxLogsPerProfile` > 0, the oldest
   *   rows beyond that count are deleted (in chunks of `chunkSize`, default 20000, yielding to the event loop
   *   between chunks). This trimming is NOT limited by batchLimit / dailyBudget and does not consume the daily
   *   budget. It costs one indexed lookup per profile, so callers should enable it only on backends where
   *   reads are free (local SQLite), not on metered ones (Cloudflare D1).
   * @returns Total number of raw log rows deleted by this run (retention + row cap).
   */
  async cleanupGlobal(
    maxRetentionDays = 30,
    batchLimit = 1000,
    dailyBudget = 20000,
    orphanKeyOptions: { safetyWindowSec?: number; batchLimit?: number } = {},
    capOptions: { maxLogsPerProfile?: number; chunkSize?: number; yieldSleepMs?: number } = {},
    roleOptions: { normalUserMaxDays?: number; adminMaxDays?: number } = {}
  ): Promise<number> {
    const orphanSafetyWindowSec = orphanKeyOptions.safetyWindowSec ?? 86400;
    const orphanBatchLimit = orphanKeyOptions.batchLimit ?? 100;
    let totalDeleted = 0;
    try {
      const globalMax = Math.max(0, maxRetentionDays);
      const normalUserCap = roleOptions.normalUserMaxDays !== undefined
        ? Math.max(0, Math.min(roleOptions.normalUserMaxDays, globalMax))
        : envNumber(this.env?.NORMAL_USER_MAX_LOG_RETENTION_DAYS, Math.min(7, globalMax), { max: globalMax });
      const adminCap = roleOptions.adminMaxDays !== undefined
        ? Math.max(0, Math.min(roleOptions.adminMaxDays, globalMax))
        : envNumber(this.env?.ADMIN_USER_MAX_LOG_RETENTION_DAYS, globalMax, { max: globalMax });

      const { results: profiles } = await this.db.prepare(`
        SELECT p.id, p.settings, COALESCE(u.role, 'user') AS role
        FROM profiles p
        LEFT JOIN users u ON p.owner_id = u.id
      `).all<{ id: string; settings: string; role?: string }>();

      const profileList = profiles || [];
      const todayDate = new Date().toISOString().slice(0, 10);
      let newlyDeletedLogs = 0;
      let deletedToday = 0;
      let effectiveBatchLimit = batchLimit;
      let perProfileLimit = 10000;

      if (profileList.length > 0) {
        // ── Daily Cleanup Budget Check ──────────────────────────────────────────
        if (dailyBudget > 0) {
          try {
            const savedDate = await this.settingsModel.get("log_cleanup_daily_date");
            const savedCount = await this.settingsModel.get("log_cleanup_daily_count");
            if (savedDate === todayDate && savedCount) {
              deletedToday = parseInt(savedCount, 10) || 0;
            }
          } catch (err) {
            console.warn("[LogRetentionModel] Failed to read daily cleanup settings:", err);
          }
        }

        const remainingBudget = dailyBudget > 0 ? Math.max(0, dailyBudget - deletedToday) : batchLimit;
        const canDeleteLogs = dailyBudget <= 0 || remainingBudget > 0;

        if (dailyBudget > 0 && remainingBudget <= 0) {
          console.log(
            `[LogRetentionModel] cleanupGlobal: daily budget reached (${deletedToday}/${dailyBudget}), skipping raw log deletion for today (${todayDate})`
          );
        }

        const isUnmetered = dailyBudget <= 0 && batchLimit <= 0;
        effectiveBatchLimit = dailyBudget > 0
          ? (batchLimit > 0 ? Math.min(batchLimit, remainingBudget) : remainingBudget)
          : batchLimit;
        perProfileLimit = isUnmetered
          ? 10000
          : Math.max(1, Math.floor(effectiveBatchLimit / profileList.length));

        const rollupStatements: D1PreparedStatement[] = [];
        const logDeleteStatements: D1PreparedStatement[] = [];
        const logDeleteTargets: { id: string; threshold: number }[] = [];

        for (const profile of profileList) {
          // ── 1. Time-based retention calculation ─────────────────────────────────
          let days = 30;
          try {
            const settings = JSON.parse(profile.settings);
            if (settings?.log_retention_days != null) {
              const parsed = Number(settings.log_retention_days);
              if (Number.isFinite(parsed)) {
                days = Math.max(0, parsed);
              }
            }
          } catch {
            // Use default on parse error
          }

          // Enforce role-based hard cap: user setting cannot exceed roleCap (adminCap or normalUserCap)
          const role = profile.role || 'user';
          const roleCap = role === 'admin' ? adminCap : normalUserCap;
          const effectiveDays = Math.max(0, Math.min(days, Math.max(0, roleCap)));
          const threshold = Math.floor(Date.now() / 1000 - effectiveDays * 24 * 3600);

          // Purge expired rollups matching retention policy across all metric types.
          // Specifying metric_type allows SQLite to utilize the composite primary key
          // (profile_id, metric_type, hour_timestamp) for instant index range seeks,
          // avoiding profile-wide table scans.
          const METRIC_TYPES = ['action', 'client', 'dest', 'domain'] as const;
          for (const metric of METRIC_TYPES) {
            rollupStatements.push(
              this.db.prepare(
                "DELETE FROM hourly_rollups WHERE profile_id = ? AND metric_type = ? AND hour_timestamp < ?"
              ).bind(profile.id, metric, threshold)
            );
          }

          // Delete bounded number of rows per profile per hourly cron run if budget remains
          if (canDeleteLogs && (isUnmetered || effectiveBatchLimit > 0)) {
            if (!isUnmetered) {
              logDeleteStatements.push(this.buildExpiredLogsDelete(profile.id, threshold, perProfileLimit));
            }
            logDeleteTargets.push({ id: profile.id, threshold });
          }
        }

        // Execute rollup deletions in chunks
        const CHUNK_SIZE = 50;
        if (rollupStatements.length > 0) {
          for (let i = 0; i < rollupStatements.length; i += CHUNK_SIZE) {
            const chunk = rollupStatements.slice(i, i + CHUNK_SIZE);
            await this.db.batch(chunk);
          }
        }

        // Execute log deletions in chunks and track affected rows
        if (logDeleteTargets.length > 0) {
          const sum = (values: (number | undefined)[]): number =>
            values.reduce<number>((acc, v) => acc + (v ?? 0), 0);

          if (isUnmetered) {
            // ── Strategy 3: Unmetered Chunked Loop with Cooperative Yielding (Serverfull) ──
            // Deletes all expired logs per profile in chunks of 2,500, yielding to the event loop
            // between chunks so DNS queries can insert logs without latency spikes or lock contention.
            const unmeteredChunk = this.getChunkSize(capOptions.chunkSize);
            const sleepMs = this.getYieldSleepMs(capOptions.yieldSleepMs);
            for (const target of logDeleteTargets) {
              for (;;) {
                const [res] = await this.db.batch([
                  this.buildExpiredLogsDelete(target.id, target.threshold, unmeteredChunk)
                ]);
                const n = changesOf(res) ?? 0;
                if (n <= 0) break;
                newlyDeletedLogs += n;
                if (n < unmeteredChunk) break;
                if (sleepMs > 0) {
                  await new Promise((r) => setTimeout(r, sleepMs));
                } else {
                  await yieldToEventLoop();
                }
              }
            }
          } else {
            // ── Metered Batch Deletion with Full Redistribution (Serverless / Budgeted) ──
            const firstPass = await this.runDeleteStatements(logDeleteStatements);
            newlyDeletedLogs += sum(firstPass);

            let saturated: number[] = [];
            firstPass.forEach((changes, i) => {
              if (changes !== undefined && changes >= perProfileLimit) saturated.push(i);
            });
            let leftover = effectiveBatchLimit - newlyDeletedLogs;
            while (leftover > 0 && saturated.length > 0) {
              const share = Math.floor(leftover / saturated.length);
              if (share < 1) {
                const roundChanges = await this.runDeleteStatements(
                  saturated.slice(0, leftover).map((i) => this.buildExpiredLogsDelete(logDeleteTargets[i].id, logDeleteTargets[i].threshold, 1))
                );
                const roundTotal = sum(roundChanges);
                newlyDeletedLogs += roundTotal;
                leftover -= roundTotal;
                break;
              }
              await yieldToEventLoop();
              const roundChanges = await this.runDeleteStatements(
                saturated.map((i) => this.buildExpiredLogsDelete(logDeleteTargets[i].id, logDeleteTargets[i].threshold, share))
              );
              const roundTotal = sum(roundChanges);
              newlyDeletedLogs += roundTotal;
              leftover -= roundTotal;
              if (roundTotal === 0) break;
              saturated = saturated.filter((_, k) => roundChanges[k] !== undefined && (roundChanges[k] as number) >= share);
            }
          }

          // Persist daily cleanup counter to system_settings
          if (dailyBudget > 0) {
            const updatedTotal = deletedToday + newlyDeletedLogs;
            try {
              await this.settingsModel.setMany({
                log_cleanup_daily_date: todayDate,
                log_cleanup_daily_count: String(updatedTotal)
              });
            } catch (err) {
              console.warn("[LogRetentionModel] Failed to persist daily cleanup count:", err);
            }
          }
        }
      }

      // ── Hard row cap per profile (enabled by the caller on local SQLite only) ─
      let cappedDeleted = 0;
      const maxLogsPerProfile = Math.floor(capOptions.maxLogsPerProfile ?? 0);
      if (maxLogsPerProfile > 0) {
        const resolvedChunkSize = this.getChunkSize(capOptions.chunkSize);
        const resolvedSleepMs = this.getYieldSleepMs(capOptions.yieldSleepMs);
        cappedDeleted = await this.enforceRowCap(
          profileList.map((p) => p.id),
          maxLogsPerProfile,
          resolvedChunkSize,
          resolvedSleepMs
        );
      }
      totalDeleted = newlyDeletedLogs + cappedDeleted;

      // ── Orphan kem_keys cleanup (Zero Dependents) ───────────────────────────
      // Automatically purges kem_keys that have zero referencing logs in D1,
      // strictly ensuring keys with active dependent logs are preserved regardless of age.
      // Performance optimization: only run orphan key cleanup if logs were actually purged
      // in this run (newlyDeletedLogs > 0), OR once a day during the first UTC run.
      // This eliminates redundant subqueries during normal hours when zero logs were deleted.
      let isDailyOrphanCheckDue = false;
      try {
        const lastOrphanCleanupDate = await this.settingsModel.get("kem_orphan_cleanup_date");
        if (lastOrphanCleanupDate !== todayDate) {
          isDailyOrphanCheckDue = true;
        }
      } catch {
        // Fallback to checking newlyDeletedLogs only
      }

      if (totalDeleted > 0 || isDailyOrphanCheckDue) {
        try {
          const kemKeyModel = new KemKeyModel(this.db);
          const deletedOrphanKeys = await kemKeyModel.cleanupOrphans(orphanSafetyWindowSec, orphanBatchLimit);
          if (isDailyOrphanCheckDue) {
            await this.settingsModel.set("kem_orphan_cleanup_date", todayDate).catch(() => {});
          }
          if (deletedOrphanKeys > 0) {
            console.log(
              `[LogRetentionModel] Cleaned up ${deletedOrphanKeys} orphaned kem_keys with zero referencing logs.`
            );
          }
        } catch (kemErr) {
          console.warn("[LogRetentionModel] Failed to cleanup orphaned kem_keys:", kemErr);
        }
      }

      // ── Orphan logs & rollups cleanup (Deleted Profiles) ──────────────────────
      // Uses SQLite loose index scan (recursive CTE, ~0.5ms) over clustered PRIMARY KEY (profile_id, timestamp, id)
      // to identify any orphan profile IDs whose rows exist in logs/rollups but not in profiles.
      // Bounded recursion depth (< 500) prevents hitting SQLite's 1000 recursion depth limit.
      try {
        const orphanLogProfiles = await this.db.prepare(`
          WITH RECURSIVE ids(pid, depth) AS (
            SELECT min(profile_id), 1 FROM logs
            UNION ALL
            SELECT (SELECT min(profile_id) FROM logs WHERE profile_id > pid), depth + 1
            FROM ids WHERE pid IS NOT NULL AND depth < 500
          )
          SELECT pid FROM ids WHERE pid IS NOT NULL AND pid NOT IN (SELECT id FROM profiles)
        `).all<{ pid: string }>();

        if (orphanLogProfiles?.results && orphanLogProfiles.results.length > 0) {
          for (const row of orphanLogProfiles.results) {
            if (row.pid) {
              await this.db.prepare("DELETE FROM logs WHERE profile_id = ?").bind(row.pid).run();
              console.log(`[LogRetentionModel] Cleaned up orphaned logs for deleted profile ${row.pid}`);
            }
          }
        }
      } catch {
        // Fallback for drivers/environments without recursive CTE support
        try {
          await this.db.prepare("DELETE FROM logs WHERE profile_id NOT IN (SELECT id FROM profiles)").run();
        } catch {}
      }

      try {
        const orphanRollupProfiles = await this.db.prepare(`
          WITH RECURSIVE ids(pid, depth) AS (
            SELECT min(profile_id), 1 FROM hourly_rollups
            UNION ALL
            SELECT (SELECT min(profile_id) FROM hourly_rollups WHERE profile_id > pid), depth + 1
            FROM ids WHERE pid IS NOT NULL AND depth < 500
          )
          SELECT pid FROM ids WHERE pid IS NOT NULL AND pid NOT IN (SELECT id FROM profiles)
        `).all<{ pid: string }>();

        if (orphanRollupProfiles?.results && orphanRollupProfiles.results.length > 0) {
          for (const row of orphanRollupProfiles.results) {
            if (row.pid) {
              await this.db.prepare("DELETE FROM hourly_rollups WHERE profile_id = ?").bind(row.pid).run();
              console.log(`[LogRetentionModel] Cleaned up orphaned hourly_rollups for deleted profile ${row.pid}`);
            }
          }
        }
      } catch {
        try {
          await this.db.prepare("DELETE FROM hourly_rollups WHERE profile_id NOT IN (SELECT id FROM profiles)").run();
        } catch {}
      }

      console.log(
        `[LogRetentionModel] cleanupGlobal: processed ${profileList.length} profile(s), maxRetentionDays=${maxRetentionDays}d, batchLimit=${batchLimit} (effective=${effectiveBatchLimit}, perProfile=${perProfileLimit}), dailyBudget=${dailyBudget} (today: ${deletedToday + newlyDeletedLogs}/${dailyBudget})` +
          (maxLogsPerProfile > 0 ? `, rowCap=${maxLogsPerProfile}/profile (trimmed ${cappedDeleted})` : "")
      );
    } catch (e: any) {
      console.error("[LogRetentionModel] cleanupGlobal failed:", e.message || e);
    }
    return totalDeleted;
  }

  /** Builds the bounded DELETE for expired raw logs of one profile. */
  private buildExpiredLogsDelete(profileId: string, threshold: number, limit: number): D1PreparedStatement {
    return this.db.prepare(`
              DELETE FROM logs WHERE (profile_id, timestamp, id) IN (
                SELECT profile_id, timestamp, id FROM logs WHERE profile_id = ? AND timestamp < ? LIMIT ?
              )
            `).bind(profileId, threshold, limit);
  }

  /**
   * Runs delete statements in batches of 50 and returns the rows affected by each statement
   * (undefined where the driver does not report it).
   */
  private async runDeleteStatements(statements: D1PreparedStatement[]): Promise<(number | undefined)[]> {
    const CHUNK_SIZE = 50;
    const affected: (number | undefined)[] = [];
    for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
      const chunk = statements.slice(i, i + CHUNK_SIZE);
      const results = await this.db.batch(chunk);
      for (let j = 0; j < chunk.length; j++) {
        affected.push(Array.isArray(results) ? changesOf(results[j]) : undefined);
      }
    }
    return affected;
  }

  /**
   * Trims every profile down to at most `maxRows` raw log rows by deleting the oldest ones.
   *
   * One lookup per profile finds the (maxRows + 1)-th newest row; it returns nothing when the profile is
   * within the cap, so the normal case costs a single indexed query. Rows at or before that key are
   * deleted in chunks, yielding to the event loop between chunks and profiles so DNS stays responsive.
   *
   * @returns Number of rows deleted.
   */
  private async enforceRowCap(profileIds: string[], maxRows: number, chunkSize?: number, yieldSleepMs?: number): Promise<number> {
    const chunk = this.getChunkSize(chunkSize);
    const sleepMs = this.getYieldSleepMs(yieldSleepMs);
    let total = 0;
    for (const profileId of profileIds) {
      try {
        const cutoff = await this.db
          .prepare("SELECT timestamp, id FROM logs WHERE profile_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1 OFFSET ?")
          .bind(profileId, maxRows)
          .first<{ timestamp: number; id: number }>();
        if (cutoff) {
          let deleted = 0;
          for (;;) {
            const [res] = await this.db.batch([
              this.db
                .prepare(
                  "DELETE FROM logs WHERE (profile_id, timestamp, id) IN (SELECT profile_id, timestamp, id FROM logs WHERE profile_id = ? AND (timestamp, id) <= (?, ?) LIMIT ?)"
                )
                .bind(profileId, cutoff.timestamp, cutoff.id, chunk)
            ]);
            const n = changesOf(res) ?? 0;
            if (n <= 0) break;
            deleted += n;
            if (n < chunk) break;
            if (sleepMs > 0) {
              await new Promise((r) => setTimeout(r, sleepMs));
            } else {
              await yieldToEventLoop();
            }
          }
          total += deleted;
          if (deleted > 0) {
            console.log(`[LogRetentionModel] Row cap: trimmed ${deleted} oldest log row(s) of profile ${profileId} (cap ${maxRows}).`);
          }
        }
      } catch (err) {
        console.warn(`[LogRetentionModel] Row cap enforcement failed for profile ${profileId}:`, err);
      }
      if (sleepMs > 0) {
        await new Promise((r) => setTimeout(r, sleepMs));
      } else {
        await yieldToEventLoop();
      }
    }
    return total;
  }
}
