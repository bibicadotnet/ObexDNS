import { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { SystemSettingsModel } from "../systemSettings";
import { KemKeyModel } from "../kemKey";
import { yieldToEventLoop } from "../../utils/yieldToEventLoop";

/** Extra delete rounds that hand unused per-profile quota to profiles that still have expired rows. */
const MAX_REDISTRIBUTION_ROUNDS = 5;

/** Rows removed per statement when trimming a profile down to its row cap. */
const DEFAULT_CAP_CHUNK_SIZE = 20000;

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
    settingsModel?: SystemSettingsModel
  ) {
    this.settingsModel = settingsModel ?? new SystemSettingsModel(db);
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
    capOptions: { maxLogsPerProfile?: number; chunkSize?: number } = {}
  ): Promise<number> {
    const orphanSafetyWindowSec = orphanKeyOptions.safetyWindowSec ?? 86400;
    const orphanBatchLimit = orphanKeyOptions.batchLimit ?? 100;
    let totalDeleted = 0;
    try {
      const { results: profiles } = await this.db.prepare(
        "SELECT id, settings FROM profiles"
      ).all<{ id: string; settings: string }>();

      if (!profiles || profiles.length === 0) {
        return 0;
      }

      // ── Daily Cleanup Budget Check ──────────────────────────────────────────
      const todayDate = new Date().toISOString().slice(0, 10);
      let deletedToday = 0;

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

      // Distribute batchLimit evenly across profiles, bounded by remaining daily budget
      const effectiveBatchLimit = dailyBudget > 0 ? Math.min(batchLimit, remainingBudget) : batchLimit;
      const perProfileLimit = Math.max(1, Math.floor(effectiveBatchLimit / profiles.length));

      const rollupStatements: D1PreparedStatement[] = [];
      const logDeleteStatements: D1PreparedStatement[] = [];
      const logDeleteTargets: { id: string; threshold: number }[] = [];

      for (const profile of profiles) {
        // ── 1. Time-based retention calculation ─────────────────────────────────
        let days = 30;
        try {
          const settings = JSON.parse(profile.settings);
          if (settings?.log_retention_days != null) {
            days = Number(settings.log_retention_days);
          }
        } catch {
          // Use default on parse error
        }

        // Enforce global hard cap: user setting cannot exceed maxRetentionDays
        const effectiveDays = Math.min(days, maxRetentionDays);
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
        if (canDeleteLogs && effectiveBatchLimit > 0) {
          logDeleteStatements.push(this.buildExpiredLogsDelete(profile.id, threshold, perProfileLimit));
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
      let newlyDeletedLogs = 0;
      if (logDeleteStatements.length > 0) {
        const sum = (values: (number | undefined)[]): number =>
          values.reduce<number>((acc, v) => acc + (v ?? 0), 0);

        const firstPass = await this.runDeleteStatements(logDeleteStatements);
        newlyDeletedLogs += sum(firstPass);

        // Hand quota that profiles without expired rows did not use to the profiles that used all of
        // theirs (they still have a backlog). Without this, one busy profile is limited to
        // batchLimit / profileCount rows per run even when every other profile is idle.
        // Skipped when the driver does not report affected rows.
        let saturated: number[] = [];
        firstPass.forEach((changes, i) => {
          if (changes !== undefined && changes >= perProfileLimit) saturated.push(i);
        });
        let leftover = effectiveBatchLimit - newlyDeletedLogs;
        for (let round = 0; round < MAX_REDISTRIBUTION_ROUNDS; round++) {
          if (leftover <= 0 || saturated.length === 0) break;
          const share = Math.floor(leftover / saturated.length);
          if (share < 1) break;
          await yieldToEventLoop();
          const roundChanges = await this.runDeleteStatements(
            saturated.map((i) => this.buildExpiredLogsDelete(logDeleteTargets[i].id, logDeleteTargets[i].threshold, share))
          );
          const roundTotal = sum(roundChanges);
          newlyDeletedLogs += roundTotal;
          leftover -= roundTotal;
          saturated = saturated.filter((_, k) => roundChanges[k] !== undefined && (roundChanges[k] as number) >= share);
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

      // ── Hard row cap per profile (enabled by the caller on local SQLite only) ─
      let cappedDeleted = 0;
      const maxLogsPerProfile = Math.floor(capOptions.maxLogsPerProfile ?? 0);
      if (maxLogsPerProfile > 0) {
        cappedDeleted = await this.enforceRowCap(
          profiles.map((p) => p.id),
          maxLogsPerProfile,
          capOptions.chunkSize ?? DEFAULT_CAP_CHUNK_SIZE
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

      console.log(
        `[LogRetentionModel] cleanupGlobal: processed ${profiles.length} profile(s), maxRetentionDays=${maxRetentionDays}d, batchLimit=${batchLimit} (effective=${effectiveBatchLimit}, perProfile=${perProfileLimit}), dailyBudget=${dailyBudget} (today: ${deletedToday + newlyDeletedLogs}/${dailyBudget})` +
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
  private async enforceRowCap(profileIds: string[], maxRows: number, chunkSize: number): Promise<number> {
    const chunk = Math.max(1, Math.floor(chunkSize));
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
            await yieldToEventLoop();
          }
          total += deleted;
          if (deleted > 0) {
            console.log(`[LogRetentionModel] Row cap: trimmed ${deleted} oldest log row(s) of profile ${profileId} (cap ${maxRows}).`);
          }
        }
      } catch (err) {
        console.warn(`[LogRetentionModel] Row cap enforcement failed for profile ${profileId}:`, err);
      }
      await yieldToEventLoop();
    }
    return total;
  }
}
