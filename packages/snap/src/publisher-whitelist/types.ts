/**
 * Types for the remote publisher whitelist.
 *
 * The snap fetches this from the Hive Mind API (`GET /atoms/publisher-whitelist`)
 * and caches it via snap_manageState. The whitelist gates which authority
 * accounts' hard `reported for` claims surface globally at sign-time (safety
 * overrides reputation, see docs/claim-surface-spec.md §5). When the API is
 * unreachable the snap falls back to an empty whitelist — only trust-circle
 * authored reports surface in that degraded mode.
 *
 * @module publisher-whitelist/types
 */

/** Report categories an authority is trusted to attest. Empty = all categories. */
export type PublisherScope =
  | 'scam'
  | 'phishing'
  | 'drainer'
  | 'honeypot'
  | 'exploit'
  | 'sybil'
  | 'spam'
  | 'injection'
  | 'impersonation';

/** A single whitelisted authority account. */
export type Publisher = {
  /** Lowercase EVM address of the authority account. */
  address: string;
  /** Human-readable name (e.g. "ScamSniffer"). */
  name: string;
  /** Relative authority weight in [0, 1]. */
  weight?: number;
  /** Report categories this authority covers. Empty/undefined = all. */
  scopes?: PublisherScope[];
};

/** Shape returned by GET /atoms/publisher-whitelist on the Hive Mind API. */
export type PublisherWhitelistRegistry = {
  version: number;
  publishers: Publisher[];
};

/** Wrapper stored in snap_manageState with a timestamp for TTL validation. */
export type CachedPublisherWhitelist = {
  registry: PublisherWhitelistRegistry;
  /** Unix timestamp (ms) when this cache entry was written. */
  timestamp: number;
};
