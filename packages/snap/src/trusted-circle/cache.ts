/**
 * Cache utilities for Trusted Circle data.
 *
 * Uses MetaMask Snap's snap_manageState for persistent storage.
 * Implements TTL-based cache invalidation (1 hour default).
 *
 * @module trusted-circle/cache
 */

import type {
  TrustedContact,
  CachedTrustedCircle,
  TrustedCircleState,
  ExtendedContact,
  CachedExtendedNetwork,
  ExtendedNetworkState,
} from './types';

/** Cache TTL in milliseconds (1 hour) */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Schema version for the cached trust-circle payload. Bump this whenever the
 * definition* of the trust circle changes so old entries are discarded.
 *
 * v2: migrated from `[account] has tag → trustworthy` to `[I] follow [account]`.
 * v3: cache-bust to force a clean refetch of the 1-hop seed set that the 2-hop
 *     (friend-of-a-friend) layer derives from.
 * v4: cache-bust so newly-added follows are picked up immediately alongside the
 *     2-hop case-insensitive (`_ilike`) query fix.
 */
const CACHE_VERSION = 4;

/**
 * Checks if a cached entry is still valid based on TTL.
 *
 * @param timestamp - When the cache was created
 * @returns True if cache is still valid
 */
export function isCacheValid(timestamp: number): boolean {
  return Date.now() - timestamp < CACHE_TTL_MS;
}

/**
 * Retrieves the cached trusted circle for a user.
 * Returns null if cache doesn't exist or is expired.
 *
 * @param userAddress - The user's wallet address
 * @returns Cached trusted contacts or null
 */
export async function getTrustedCircleCache(
  userAddress: string,
): Promise<TrustedContact[] | null> {
  try {
    const state = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as TrustedCircleState | null;

    if (!state) {
      return null;
    }

    const normalizedAddress = userAddress.toLowerCase();
    const cached = state[normalizedAddress];

    if (!cached) {
      return null;
    }

    // Discard entries written under an older trust-circle definition.
    if (cached.version !== CACHE_VERSION) {
      return null;
    }

    if (!isCacheValid(cached.timestamp)) {
      // Cache expired, return null to trigger refresh
      return null;
    }

    return cached.contacts;
  } catch {
    // If state retrieval fails, return null to proceed without cache
    return null;
  }
}

/**
 * Stores the trusted circle for a user in persistent cache.
 *
 * @param userAddress - The user's wallet address
 * @param contacts - List of trusted contacts to cache
 */
export async function setTrustedCircleCache(
  userAddress: string,
  contacts: TrustedContact[],
): Promise<void> {
  try {
    // Get existing state to preserve other users' data
    const existingState = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as TrustedCircleState | null;

    const normalizedAddress = userAddress.toLowerCase();

    const newEntry: CachedTrustedCircle = {
      contacts,
      timestamp: Date.now(),
      version: CACHE_VERSION,
    };

    const newState: TrustedCircleState = {
      ...(existingState || {}),
      [normalizedAddress]: newEntry,
    };

    await snap.request({
      method: 'snap_manageState',
      params: {
        operation: 'update',
        newState: JSON.parse(JSON.stringify(newState)), // Ensure newState is serializable as Json
      },
    });
  } catch {
    // Cache write failure is non-critical, continue silently
  }
}

/**
 * Clears the trusted circle cache for a specific user or all users.
 *
 * @param userAddress - Optional user address. If omitted, clears all.
 */
export async function clearTrustedCircleCache(
  userAddress?: string,
): Promise<void> {
  try {
    if (!userAddress) {
      // Clear all
      await snap.request({
        method: 'snap_manageState',
        params: {
          operation: 'update',
          newState: {},
        },
      });
      return;
    }

    const existingState = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as TrustedCircleState | null;

    if (!existingState) {
      return;
    }

    const normalizedAddress = userAddress.toLowerCase();
    const { [normalizedAddress]: _, ...rest } = existingState;

    await snap.request({
      method: 'snap_manageState',
      params: {
        operation: 'update',
        newState: JSON.parse(JSON.stringify(rest)), // Ensure newState is serializable as Json
      },
    });

    // The extended (2-hop) set is derived from this viewer's 1-hop circle, so
    // clear it too when the 1-hop circle is cleared.
    await clearExtendedNetworkCache(normalizedAddress);
  } catch {
    // Clear cache failure is non-critical, continue silently
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Extended network (2-hop) cache.
//
// Stored under a reserved top-level key (`EXTENDED_STATE_KEY`) so it never
// collides with the address-keyed 1-hop entries in the same snap_manageState
// blob. Validity additionally requires the cached `derivedFrom` to match the
// current 1-hop `timestamp`, so the extended set self-invalidates whenever the
// seed circle is refreshed. See docs/extended-network-spec.md §5.
// ────────────────────────────────────────────────────────────────────────────

/** Reserved key under the root state blob that holds the extended-network map. */
const EXTENDED_STATE_KEY = '__extended_network__';

/**
 * Schema version for the cached extended-network payload, independent of the
 * 1-hop `CACHE_VERSION`. Bump when the *definition* of the 2-hop layer changes.
 *
 * v2: cache-bust for the Phase 2 friend-of-a-friend logic (degree-2 safety
 *     attribution + bridge-count gating) so any pre-Phase-2 entries are dropped.
 * v3: cache-bust for the case-insensitive (`_ilike`) seed-matching fix — prior
 *     entries were empty because the case-sensitive `_in` query matched nothing.
 */
const EXTENDED_CACHE_VERSION = 3;

/** TTL for the extended-network cache (1 hour; mirrors the 1-hop circle). */
const EXTENDED_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Reads the root state blob and returns the extended-network sub-map.
 * The 1-hop code keys entries by address; the extended map lives under a
 * reserved key so the two never collide.
 */
async function readExtendedState(): Promise<ExtendedNetworkState> {
  const state = (await snap.request({
    method: 'snap_manageState',
    params: { operation: 'get' },
  })) as
    | (Record<string, unknown> & {
        [EXTENDED_STATE_KEY]?: ExtendedNetworkState;
      })
    | null;

  return state?.[EXTENDED_STATE_KEY] ?? {};
}

/**
 * Reads the 1-hop cache `timestamp` for a viewer (the value the extended set is
 * derived from). Returns null when there is no valid 1-hop entry.
 * @param userAddress
 */
export async function getTrustedCircleTimestamp(
  userAddress: string,
): Promise<number | null> {
  try {
    const state = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as TrustedCircleState | null;

    const cached = state?.[userAddress.toLowerCase()];
    if (!cached || cached.version !== CACHE_VERSION) {
      return null;
    }
    return cached.timestamp;
  } catch {
    return null;
  }
}

/**
 * Retrieves the cached extended network for a viewer.
 * Returns null on miss/expiry/version-mismatch, or when the cached `derivedFrom`
 * no longer matches the current 1-hop timestamp (seed set changed).
 *
 * @param userAddress - The viewer's wallet address
 * @param oneHopTimestamp - Current 1-hop cache timestamp (from getTrustedCircleTimestamp)
 */
export async function getExtendedNetworkCache(
  userAddress: string,
  oneHopTimestamp: number | null,
): Promise<ExtendedContact[] | null> {
  try {
    const extState = await readExtendedState();
    const cached = extState[userAddress.toLowerCase()];

    if (!cached) {
      return null;
    }
    if (cached.version !== EXTENDED_CACHE_VERSION) {
      return null;
    }
    if (Date.now() - cached.timestamp >= EXTENDED_CACHE_TTL_MS) {
      return null;
    }
    // Self-invalidate if the underlying 1-hop seed set was refreshed.
    if (oneHopTimestamp === null || cached.derivedFrom !== oneHopTimestamp) {
      return null;
    }

    return cached.contacts;
  } catch {
    return null;
  }
}

/**
 * Stores the extended network for a viewer, tagged with the 1-hop timestamp it
 * was derived from. Preserves the address-keyed 1-hop entries in the root blob.
 *
 * @param userAddress - The viewer's wallet address
 * @param contacts - Resolved FoaF contacts
 * @param derivedFrom - The 1-hop cache timestamp these were derived from
 */
export async function setExtendedNetworkCache(
  userAddress: string,
  contacts: ExtendedContact[],
  derivedFrom: number,
): Promise<void> {
  try {
    const rootState = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as Record<string, unknown> | null;

    const existingExt =
      (rootState?.[EXTENDED_STATE_KEY] as ExtendedNetworkState | undefined) ??
      {};
    const normalizedAddress = userAddress.toLowerCase();

    const newEntry: CachedExtendedNetwork = {
      contacts,
      timestamp: Date.now(),
      derivedFrom,
      version: EXTENDED_CACHE_VERSION,
    };

    const newRoot = {
      ...(rootState ?? {}),
      [EXTENDED_STATE_KEY]: {
        ...existingExt,
        [normalizedAddress]: newEntry,
      },
    };

    await snap.request({
      method: 'snap_manageState',
      params: {
        operation: 'update',
        newState: JSON.parse(JSON.stringify(newRoot)),
      },
    });
  } catch {
    // Cache write failure is non-critical, continue silently
  }
}

/**
 * Clears the extended-network cache for a specific viewer (or all viewers).
 *
 * @param userAddress - Optional viewer address. If omitted, clears the whole map.
 */
export async function clearExtendedNetworkCache(
  userAddress?: string,
): Promise<void> {
  try {
    const rootState = (await snap.request({
      method: 'snap_manageState',
      params: { operation: 'get' },
    })) as Record<string, unknown> | null;

    if (!rootState) {
      return;
    }

    let newExt: ExtendedNetworkState = {};
    if (userAddress) {
      const existingExt =
        (rootState[EXTENDED_STATE_KEY] as ExtendedNetworkState | undefined) ??
        {};
      const { [userAddress.toLowerCase()]: _removed, ...rest } = existingExt;
      newExt = rest;
    }

    const newRoot = {
      ...rootState,
      [EXTENDED_STATE_KEY]: newExt,
    };

    await snap.request({
      method: 'snap_manageState',
      params: {
        operation: 'update',
        newState: JSON.parse(JSON.stringify(newRoot)),
      },
    });
  } catch {
    // Clear cache failure is non-critical, continue silently
  }
}
