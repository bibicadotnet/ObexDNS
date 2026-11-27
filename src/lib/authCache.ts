import { User } from '../types';

/**
 * Shared in-memory auth cache invalidation utilities.
 * Extracted into its own module to break the circular dependency between
 * session.ts (which calls invalidateAuthUserCache) and middleware.ts
 * (which owns the cache but previously imported session.ts indirectly).
 *
 * Both session.ts and middleware.ts import from this file; neither imports
 * from the other.
 */

export interface CachedAuthUser {
  user: User;
  expiresAt: number;
}

export interface SessionActivityRecord {
  lastObserved: number;
  lastWriteAttempt: number;
}

/** Singleton cache maps shared across the Worker isolate lifetime. */
export const authUserMemoryCache = new Map<string, CachedAuthUser>();
export const sessionActivityMemory = new Map<string, SessionActivityRecord>();

/**
 * Removes one session (by sessionId) or all sessions belonging to a user
 * (by userId) from the in-memory auth cache and activity tracker.
 */
export function invalidateAuthUserCache(sessionId?: string, userId?: string): void {
  if (sessionId) {
    authUserMemoryCache.delete(sessionId);
    sessionActivityMemory.delete(sessionId);
  }
  if (userId) {
    for (const [sid, entry] of authUserMemoryCache.entries()) {
      if (entry.user.id === userId) {
        authUserMemoryCache.delete(sid);
        sessionActivityMemory.delete(sid);
      }
    }
  }
}
