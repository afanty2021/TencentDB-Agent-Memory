/**
 * User-scoped instance ids — the single key that maps a user to her own
 * memory store (docs/per-user-stores-v3-design.md §6.1).
 *
 * Under `multiUser.enabled` the v3 dispatch mints `user:<uid>` for a regular
 * user's request (routeV3ByUser in gateway/v2-router.ts). Everything that
 * turns an instance id into a location — StorePool's sqlite path, the
 * gateway's file root, the pipeline executor's data directory — goes through
 * these helpers, so one id always resolves to one directory.
 *
 * The `user:` prefix is reserved: a client-supplied `x-tdai-service-id` that
 * starts with it is rejected at the dispatch, which keeps a client from
 * addressing another user's store directly.
 */
import path from "node:path";

import { normalizeUserId } from "../../utils/user-id.js";

export const USER_SCOPE_PREFIX = "user:";

export interface UserScope {
  uid: string;
}

/**
 * Mint the scoped instance id for a uid. The uid is normalized with the same
 * rule as the request side and must be valid — an invalid one throws. The
 * error carries only the input's length: invalid uids are attacker-controlled
 * request data and are never echoed.
 */
export function buildUserScopeInstanceId(uid: string): string {
  const normalized = normalizeUserId(uid);
  if (normalized === null) {
    const length = typeof uid === "string" ? uid.length : 0;
    throw new Error(`buildUserScopeInstanceId: invalid uid (length=${length})`);
  }
  return `${USER_SCOPE_PREFIX}${normalized}`;
}

/** Parse a scoped instance id. `null` when the id is not a user scope or its uid part is malformed. */
export function parseUserScopeInstanceId(instanceId: string): UserScope | null {
  if (!instanceId.startsWith(USER_SCOPE_PREFIX)) return null;
  const uid = normalizeUserId(instanceId.slice(USER_SCOPE_PREFIX.length));
  return uid === null ? null : { uid };
}

export interface ScopeDataRoot {
  /** Directory that holds this instance's data. */
  dataDir: string;
  /** `true` for a user-scoped instance, `false` for the main store / ordinary instances. */
  scoped: boolean;
}

/**
 * The data root of an instance: `<baseDir>` itself, or `<baseDir>/users/<uid>`
 * for a user-scoped instance. In the standalone layout the sqlite file, the
 * file storage root and the engine's data directory all hang off this one path.
 */
export function resolveScopeDataRoot(baseDir: string, instanceId: string): ScopeDataRoot {
  const scope = parseUserScopeInstanceId(instanceId);
  if (!scope) return { dataDir: baseDir, scoped: false };
  return { dataDir: path.join(baseDir, "users", scope.uid), scoped: true };
}
