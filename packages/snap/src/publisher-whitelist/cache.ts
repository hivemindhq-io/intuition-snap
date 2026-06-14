/**
 * Cache layer for the remote publisher whitelist.
 *
 * Uses snap_manageState for persistent storage with TTL-based invalidation.
 * Stored under the `_publisherWhitelist` key to avoid collision with
 * trusted-circle address keys (which start with `0x`), `_featureConfig`, and
 * `_claimTemplates`.
 *
 * @module publisher-whitelist/cache
 */

import type {
  PublisherWhitelistRegistry,
  CachedPublisherWhitelist,
} from './types';

/** Reserved key in the shared snap state object. */
const STATE_KEY = '_publisherWhitelist';

/** TTL in seconds. Whitelist changes are rare and non-urgent. */
const TTL_SECONDS = 3600; // 1 hour

/**
 *
 * @param cached
 */
function isCacheValid(cached: CachedPublisherWhitelist): boolean {
  return Date.now() - cached.timestamp < TTL_SECONDS * 1000;
}

/**
 * Retrieves the cached whitelist from snap state.
 * Returns null if no cache exists or if the TTL has expired.
 */
export async function getPublisherWhitelistCache(): Promise<PublisherWhitelistRegistry | null> {
  try {
    const state = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as Record<string, unknown> | null;

    if (!state) {
      return null;
    }

    const cached = state[STATE_KEY] as CachedPublisherWhitelist | undefined;
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
 * Stores a whitelist in snap state with the current timestamp.
 * @param registry
 */
export async function setPublisherWhitelistCache(
  registry: PublisherWhitelistRegistry,
): Promise<void> {
  try {
    const existingState = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as Record<string, unknown> | null;

    const entry: CachedPublisherWhitelist = {
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
