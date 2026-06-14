/**
 * Cache layer for the remote claim-template registry.
 *
 * Uses snap_manageState for persistent storage with TTL-based invalidation.
 * Stored under the `_claimTemplates` key to avoid collision with
 * trusted-circle address keys (which start with `0x`) and the
 * `_featureConfig` key.
 *
 * @module claim-templates/cache
 */

import type { ClaimTemplateRegistry, CachedClaimTemplates } from './types';

/** Reserved key in the shared snap state object. */
const STATE_KEY = '_claimTemplates';

/** TTL in seconds. Template changes are rare and non-urgent. */
const TTL_SECONDS = 3600; // 1 hour

/**
 *
 * @param cached
 */
function isCacheValid(cached: CachedClaimTemplates): boolean {
  return Date.now() - cached.timestamp < TTL_SECONDS * 1000;
}

/**
 * Retrieves the cached registry from snap state.
 * Returns null if no cache exists or if the TTL has expired.
 */
export async function getClaimTemplatesCache(): Promise<ClaimTemplateRegistry | null> {
  try {
    const state = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as Record<string, unknown> | null;

    if (!state) {
      return null;
    }

    const cached = state[STATE_KEY] as CachedClaimTemplates | undefined;
    if (!cached) {
      return null;
    }

    if (!isCacheValid(cached)) {
      return null;
    }

    return cached.registry;
  } catch {
    return null;
  }
}

/**
 * Stores a registry in snap state with the current timestamp.
 * @param registry
 */
export async function setClaimTemplatesCache(
  registry: ClaimTemplateRegistry,
): Promise<void> {
  try {
    const existingState = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as Record<string, unknown> | null;

    const entry: CachedClaimTemplates = {
      registry,
      timestamp: Date.now(),
    };

    const newState = {
      ...(existingState || {}),
      [STATE_KEY]: entry,
    };

    await snap.request({
      method: 'snap_manageState',
      params: {
        operation: 'update',
        newState: JSON.parse(JSON.stringify(newState)),
      },
    });
  } catch {
    // Cache write failure is non-critical
  }
}
