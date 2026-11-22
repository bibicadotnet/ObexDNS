import { D1Database } from "@cloudflare/workers-types";
import { UserRecord } from "./types";
import { encryptEnvelope, decryptEnvelope, rotateEnvelopeDek } from "../../utils/envelope";

/**
 * Handles envelope encryption, decryption, transparent migration from legacy plaintext,
 * and automatic DEK rotation for sensitive user secrets (TOTP secret & recovery keys).
 *
 * Single Responsibility: Cryptographic envelope vault management for user credentials.
 */
export class UserSecretProcessor {
  constructor(private db: D1Database, private env?: unknown) {}

  /**
   * Transparently processes user secret fields:
   * 1. Decrypts envelope-encrypted TOTP secret and recovery keys.
   * 2. Automatically rotates DEK if a newer KEK version is active in the environment.
   * 3. Migrates legacy plaintext secrets to envelope encryption on read.
   * 4. Persists any rotated or migrated secrets back to D1.
   *
   * @param user Raw user record fetched from D1.
   * @returns Processed user record with decrypted secret fields, or null if input was null.
   */
  async processUserSecrets(user: UserRecord | null): Promise<UserRecord | null> {
    if (!user) return null;

    const updatedFields: Record<string, unknown> = {};
    let shouldUpdateDb = false;

    // 1. Process totp_secret
    let totpSecret = user.totp_secret;
    if (user.totp_secret_encrypted && user.totp_secret_dek) {
      try {
        totpSecret = await decryptEnvelope(user.totp_secret_encrypted, user.totp_secret_dek, this.env);

        // Check for DEK rotation (vN -> vN+1)
        const rotatedDek = await rotateEnvelopeDek(user.totp_secret_dek, this.env);
        if (rotatedDek) {
          updatedFields.totp_secret_dek = rotatedDek;
          shouldUpdateDb = true;
        }
      } catch (e: unknown) {
        const err = e instanceof Error ? e.stack || e.message : String(e);
        console.error(`[Envelope Encryption] Failed to decrypt/rotate totp_secret for user ${user.id}:`, err);
      }
    } else if (user.totp_secret) {
      // Legacy plain-text secret found. If KEK is active, migrate to envelope encryption!
      try {
        const encrypted = await encryptEnvelope(user.totp_secret, this.env);
        if (encrypted) {
          updatedFields.totp_secret_encrypted = encrypted.dataEncrypted;
          updatedFields.totp_secret_dek = encrypted.dekEncrypted;
          updatedFields.totp_secret = null; // Clear plain-text column
          shouldUpdateDb = true;
        }
      } catch (e: unknown) {
        console.error(`[Envelope Encryption] Migration failed for totp_secret of user ${user.id}:`, e);
      }
    }

    // 2. Process totp_recovery_keys
    let totpRecoveryKeys = user.totp_recovery_keys;
    if (user.totp_recovery_keys_encrypted && user.totp_recovery_keys_dek) {
      try {
        totpRecoveryKeys = await decryptEnvelope(user.totp_recovery_keys_encrypted, user.totp_recovery_keys_dek, this.env);

        // Check for DEK rotation (vN -> vN+1)
        const rotatedDek = await rotateEnvelopeDek(user.totp_recovery_keys_dek, this.env);
        if (rotatedDek) {
          updatedFields.totp_recovery_keys_dek = rotatedDek;
          shouldUpdateDb = true;
        }
      } catch (e: unknown) {
        const err = e instanceof Error ? e.stack || e.message : String(e);
        console.error(`[Envelope Encryption] Failed to decrypt/rotate totp_recovery_keys for user ${user.id}:`, err);
      }
    } else if (user.totp_recovery_keys) {
      // Legacy plain-text recovery keys found. If KEK is active, migrate to envelope encryption!
      try {
        const encrypted = await encryptEnvelope(user.totp_recovery_keys, this.env);
        if (encrypted) {
          updatedFields.totp_recovery_keys_encrypted = encrypted.dataEncrypted;
          updatedFields.totp_recovery_keys_dek = encrypted.dekEncrypted;
          updatedFields.totp_recovery_keys = null; // Clear plain-text column
          shouldUpdateDb = true;
        }
      } catch (e: unknown) {
        console.error(`[Envelope Encryption] Migration failed for totp_recovery_keys of user ${user.id}:`, e);
      }
    }

    // Update D1 database if migration or rotation occurred
    if (shouldUpdateDb) {
      try {
        const updateParts: string[] = [];
        const bindings: unknown[] = [];
        for (const [key, val] of Object.entries(updatedFields)) {
          updateParts.push(`${key} = ?`);
          bindings.push(val);
        }
        bindings.push(user.id);

        await this.db
          .prepare(`UPDATE users SET ${updateParts.join(", ")} WHERE id = ?`)
          .bind(...bindings)
          .run();

        // Merge the newly updated/encrypted values to the returned user object
        Object.assign(user, updatedFields);
      } catch (e: unknown) {
        console.error(`[Envelope Encryption] Failed to save rotated/migrated secrets for user ${user.id}:`, e);
      }
    }

    // Return the user object with decrypted totp_secret and totp_recovery_keys
    return {
      ...user,
      totp_secret: totpSecret,
      totp_recovery_keys: totpRecoveryKeys
    };
  }
}
