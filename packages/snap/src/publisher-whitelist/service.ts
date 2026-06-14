/**
 * Publisher whitelist service.
 *
 * Provides getPublisherWhitelist() which checks the local cache first, fetches
 * from the Hive Mind API on miss, and falls back to an empty whitelist on any
 * failure. An empty whitelist means no authority reports surface globally —
 * only trust-circle-authored reports are shown (a safe degraded mode).
 *
 * @module publisher-whitelist/service
 */

import { chainConfig } from '../config';
import {
  getPublisherWhitelistCache,
  setPublisherWhitelistCache,
} from './cache';
import type { PublisherWhitelistRegistry } from './types';

/** Safe empty default returned when the API is unreachable or cache is empty. */
const EMPTY: PublisherWhitelistRegistry = {
  version: 0,
  publishers: [],
};

/**
 * Retrieves the current publisher whitelist.
 *
 * Resolution order:
 * 1. Local cache (snap_manageState) if within TTL
 * 2. Fresh fetch from the Hive Mind API
 * 3. Empty whitelist fallback
 */
export async function getPublisherWhitelist(): Promise<PublisherWhitelistRegistry> {
  const cached = await getPublisherWhitelistCache();
  if (cached) {
    return cached;
  }

  const url = `${chainConfig.hivemindApiUrl}/atoms/publisher-whitelist`;
  try {
    const response = await fetch(url);

    if (!response.ok) {
      console.warn(
        `[Whitelist] fetch failed: HTTP ${response.status} ${response.statusText} from ${url} — using EMPTY whitelist (no authorities will surface)`,
      );
      return EMPTY;
    }

    const registry = (await response.json()) as PublisherWhitelistRegistry;
    // Normalize addresses to lowercase for casing-agnostic matching.
    const normalized: PublisherWhitelistRegistry = {
      version: registry.version,
      publishers: (registry.publishers || []).map((p) => ({
        ...p,
        address: p.address.toLowerCase(),
      })),
    };
    await setPublisherWhitelistCache(normalized);
    return normalized;
  } catch (error) {
    console.warn(
      `[Whitelist] fetch threw for ${url} — using EMPTY whitelist (no authorities will surface):`,
      error,
    );
    return EMPTY;
  }
}
