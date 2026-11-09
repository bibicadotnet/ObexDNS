import { D1Database } from "@cloudflare/workers-types";
import { InactivityPolicyResult } from "./types";

/**
 * Handles account activity timestamp tracking and automated data retention / inactivity cleanup policies.
 *
 * Single Responsibility: Account resolution activity tracking and periodic inactivity retention enforcement.
 */
export class UserLifecycleModel {
  constructor(private db: D1Database) {}

  /**
   * Updates the `last_active_at` timestamp of the user who owns the specified profile.
   * Called on incoming DNS queries to keep the user active.
   *
   * @param profileId Profile identifier.
   * @param now Current timestamp in seconds.
   * @returns True if the update succeeded.
   */
  async updateLastActiveByProfile(profileId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE users SET last_active_at = ? WHERE id = (SELECT owner_id FROM profiles WHERE id = ?)")
      .bind(now, profileId)
      .run();
    return result.success;
  }

  /**
   * Applies the inactivity retention policies:
   * 1. Profile resolution inactivity: cleans up query logs, pre-aggregated rollups, and DNS profiles (0 to disable, default 30 days).
   * 2. User login inactivity: deletes zombie user accounts (0 to disable, default 90 days).
   *
   * @param now Current timestamp in seconds.
   * @param profileInactivityDays Days of DNS inactivity before clearing profiles/logs (0 to disable).
   * @param userInactivityDays Days of login inactivity before deleting user accounts (0 to disable).
   * @returns Statistics on cleared profiles and deleted user accounts.
   */
  async applyInactivityPolicy(
    now: number,
    profileInactivityDays = 30,
    userInactivityDays = 90
  ): Promise<InactivityPolicyResult> {
    const stmts: any[] = [];
    let profileDeleteIndex = -1;
    let userDeleteIndex = -1;

    // 1. Clear query logs, rollups, and profiles if profileInactivityDays > 0
    if (profileInactivityDays > 0) {
      const profileThreshold = now - profileInactivityDays * 24 * 3600;

      const deleteRollupsStmt = this.db.prepare(`
        DELETE FROM hourly_rollups
        WHERE profile_id IN (
          SELECT id FROM profiles
          WHERE owner_id IN (
            SELECT id FROM users
            WHERE role = 'user'
              AND (last_active_at < ? OR (last_active_at IS NULL AND created_at < ?))
          )
        )
      `).bind(profileThreshold, profileThreshold);

      const deleteLogsStmt = this.db.prepare(`
        DELETE FROM logs
        WHERE profile_id IN (
          SELECT id FROM profiles
          WHERE owner_id IN (
            SELECT id FROM users
            WHERE role = 'user'
              AND (last_active_at < ? OR (last_active_at IS NULL AND created_at < ?))
          )
        )
      `).bind(profileThreshold, profileThreshold);

      const deleteProfilesStmt = this.db.prepare(`
        DELETE FROM profiles 
        WHERE owner_id IN (
          SELECT id FROM users 
          WHERE role = 'user' 
            AND (last_active_at < ? OR (last_active_at IS NULL AND created_at < ?))
        )
      `).bind(profileThreshold, profileThreshold);

      stmts.push(deleteRollupsStmt, deleteLogsStmt, deleteProfilesStmt);
      profileDeleteIndex = stmts.length - 1;
    }

    // 2. Remove inactive user accounts if userInactivityDays > 0
    if (userInactivityDays > 0) {
      const userThreshold = now - userInactivityDays * 24 * 3600;

      const deleteUsersStmt = this.db.prepare(`
        DELETE FROM users
        WHERE role = 'user'
          AND (last_active_at IS NULL OR last_active_at < ?)
          AND (
            SELECT COALESCE(MAX(timestamp), created_at) 
            FROM user_activity_log 
            WHERE user_id = users.id
          ) < ?
      `).bind(userThreshold, userThreshold);

      stmts.push(deleteUsersStmt);
      userDeleteIndex = stmts.length - 1;
    }

    if (stmts.length === 0) {
      return { clearedProfiles: 0, deletedUsers: 0 };
    }

    const results = await this.db.batch(stmts);

    return {
      clearedProfiles: profileDeleteIndex >= 0 ? (results[profileDeleteIndex]?.meta?.changes || 0) : 0,
      deletedUsers: userDeleteIndex >= 0 ? (results[userDeleteIndex]?.meta?.changes || 0) : 0
    };
  }
}
