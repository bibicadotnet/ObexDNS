import { D1Database } from "@cloudflare/workers-types";

/**
 * Handles primary password credentials and client session-lock security configurations.
 *
 * Single Responsibility: Primary authentication credentials and session-lock policy management.
 */
export class UserSecurityModel {
  constructor(private db: D1Database) {}

  /**
   * Updates the hashed password and associated password version for a user.
   *
   * @param id The user ID.
   * @param passwordHash The new hashed password string.
   * @param passwordVersion The credential version (default: 2).
   * @returns True if the update succeeded.
   */
  async updatePassword(id: string, passwordHash: string, passwordVersion: number = 2): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE users SET hashed_password = ?, password_version = ? WHERE id = ?")
      .bind(passwordHash, passwordVersion, id)
      .run();
    return result.success;
  }

  /**
   * Updates or clears the quick-unlock PIN hash for a user.
   *
   * @param id The user ID.
   * @param pinHash The new PIN hash, or null to remove the PIN.
   * @returns True if the update succeeded.
   */
  async updatePinHash(id: string, pinHash: string | null): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE users SET pin_hash = ? WHERE id = ?")
      .bind(pinHash, id)
      .run();
    return result.success;
  }

  /**
   * Updates the client session lock timeout duration (in minutes or seconds).
   *
   * @param id The user ID.
   * @param timeout The timeout duration value.
   * @returns True if the update succeeded.
   */
  async updateSessionLockTimeout(id: string, timeout: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE users SET session_lock_timeout = ? WHERE id = ?")
      .bind(timeout, id)
      .run();
    return result.success;
  }
}
