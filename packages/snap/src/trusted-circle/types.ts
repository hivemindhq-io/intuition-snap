/**
 * Types for Trusted Circle feature.
 *
 * The trusted circle represents the accounts the current user follows — i.e.
 * accounts they hold a FOR position on in an `[I] follow [account]` triple.
 *
 * @module trusted-circle/types
 */

/**
 * A trusted contact with minimal display information.
 */
export type TrustedContact = {
  /** The account's wallet address */
  accountId: string;
  /** Display label (address, ENS, or other identifier) */
  label: string;
  /** Shares staked as string (for sorting by stake amount, stored as string for JSON serialization) */
  shares?: string;
};

/**
 * Cached trusted circle data with timestamp for TTL validation.
 */
export type CachedTrustedCircle = {
  /** List of trusted contacts */
  contacts: TrustedContact[];
  /** Timestamp when cache was created (ms since epoch) */
  timestamp: number;
  /**
   * Schema version of the cached payload. Bumped whenever the *definition* of
   * the trust circle changes (e.g. the migration from `[account] has tag →
   * trustworthy` to `[I] follow [account]`). Entries with a missing/mismatched
   * version are treated as invalid so stale pre-migration circles self-heal.
   */
  version?: number;
};

/**
 * State structure stored via snap_manageState.
 * Keyed by user address for multi-account support.
 */
export type TrustedCircleState = {
  /** Map of user address to their cached trusted circle */
  [userAddress: string]: CachedTrustedCircle;
};

/**
 * Contacts from the trusted circle who have positions on a triple.
 * Used to display "Your Trust Circle" section.
 */
export type TrustedCirclePositions = {
  /** Trusted contacts who staked FOR */
  forContacts: TrustedContact[];
  /** Trusted contacts who staked AGAINST */
  againstContacts: TrustedContact[];
};

/**
 * A single claim (triple) that a familiar contact has a position on.
 * Used to show context like "tagged as DeFi Protocol".
 */
export type ClaimContext = {
  /** Human-readable predicate label (e.g., "has tag") */
  predicateLabel: string;
  /** Human-readable object label (e.g., "DeFi Protocol") */
  objectLabel: string;
  /** Resolved first-class registry key (e.g. 'hasTag'); absent if not first-class. */
  predicateKey?: string;
  /**
   * The underlying triple's term_id. Used as the cross-lane dedup key so a claim
   * already shown in the familiarity / self lanes can be excluded from the
   * public-claims escape-hatch lane (one home per claim). Absent on older
   * payloads ⇒ the claim simply doesn't contribute to the public-claims exclude
   * set.
   */
  termId?: string;
  /**
   * Placement tier resolved from the familiarity vocabulary whitelist.
   *   - `'primary'`   → eligible to render inline (1-hop) and in More info (2-hop).
   *   - `'secondary'` → always demoted to More info, even from a direct follow.
   * Absent ⇒ the claim came through the verbatim escape hatch (no whitelist match
   * anywhere on the subject) and is treated as `'secondary'` by renderers.
   */
  tier?: 'primary' | 'secondary';
};

/**
 * A contact from the user's trust circle who has made any claim
 * about the target address (beyond just "hasTag trustworthy").
 *
 * Displayed in the "Network Familiarity" section to show that
 * people the user trusts have interacted with this address.
 */
export type FamiliarContact = {
  /** The contact's wallet address */
  accountId: string;
  /** Display label (ENS name or truncated address) */
  label: string;
  /** Claims this contact has positions on for the target address */
  claims: ClaimContext[];
  /**
   * Degree of separation. 1 = direct follow (trust circle), 2 = friend-of-a-friend.
   * Absent ⇒ treat as 1 (back-compat with the existing 1-hop familiarity set).
   */
  degree?: TrustDegree;
  /**
   * For degree-2 only: number of distinct bridges (the viewer's direct follows
   * that reach this account). Drives the "via N of your follows" copy and the
   * MIN_BRIDGES gate. Undefined for degree-1.
   */
  bridgeCount?: number;
};

/**
 * Aggregated network familiarity data for an address.
 * Shows trusted contacts who have ANY claim about the address,
 * de-duplicated from the trust circle section.
 */
export type NetworkFamiliarity = {
  /** 1-hop contacts (trust circle) with non-trustworthy claims */
  familiarContacts: FamiliarContact[];
  /** Total number of distinct claims about this address (for context) */
  totalClaimsAboutAddress: number;
  /**
   * 2-hop (friend-of-a-friend) contacts with non-trustworthy claims, gated by
   * MIN_BRIDGES. Rendered in a SEPARATE "Extended Network" subsection, never
   * mixed with `familiarContacts`. Absent/empty ⇒ no 2-hop subsection.
   */
  extendedContacts?: FamiliarContact[];
};

// ────────────────────────────────────────────────────────────────────────────
// Self lane — the viewer's OWN claims about a subject.
//
// Independent of the trusted circle and the familiarity whitelist: any claim the
// viewer has personally staked (FOR or AGAINST) on the subject is surfaced back
// to them inline ("Your take"). The blacklist and the safety-dedup exclusion set
// still apply so a rogue/duplicate atom is suppressed and no claim renders twice.
// ────────────────────────────────────────────────────────────────────────────

/**
 * A single claim the VIEWER has staked on about the subject, with the stance
 * derived from which side they hold a position on:
 *   - `'for'`     → the viewer holds a FOR position (they assert the claim),
 *   - `'against'` → the viewer holds an AGAINST position (they dispute it).
 */
export type SelfClaim = {
  /** Which side the viewer staked on. */
  stance: 'for' | 'against';
} & ClaimContext;

/**
 * The viewer's own claims about a subject (address or origin). Absent/empty ⇒
 * the viewer has no staked opinion on the subject and the "Your take" block is
 * not rendered.
 */
export type SelfClaims = {
  /** The viewer's staked claims, ordered by total market cap (desc). */
  claims: SelfClaim[];
};

// ────────────────────────────────────────────────────────────────────────────
// Extended network (2-hop "friend-of-a-friend") — see docs/extended-network-spec.md
//
// The extended network is the union of `[F] follow [G]` edges for every direct
// follow `F` in the viewer's OWN 1-hop circle, minus the viewer and minus the
// 1-hop set. Seeds are the viewer's follows only (never the whitelist). Stake is
// never read; bridge count (number of distinct direct follows that reach a FoaF)
// is the only weight. Renders in its own section, gated by MIN_BRIDGES.
// ────────────────────────────────────────────────────────────────────────────

/** Degree of separation from the viewer. 1 = direct follow, 2 = friend-of-a-friend. */
export type TrustDegree = 1 | 2;

/**
 * A 2-hop contact: an account followed by one or more of the viewer's direct
 * follows, but NOT followed by the viewer directly (and not the viewer).
 */
export type ExtendedContact = {
  /** The FoaF's wallet address */
  accountId: string;
  /** Display label (ENS name or truncated hex address) */
  label: string;
  /**
   * Lowercased addresses of the direct follows who bridge to this account.
   * `via.length` is the bridge count — the only trust weight for degree 2.
   */
  via: string[];
};

/** Resolved 2-hop layer for a viewer (excludes self + all direct follows). */
export type ExtendedNetwork = {
  /** FoaF contacts, sorted by bridge count (via.length) desc. */
  contacts: ExtendedContact[];
};

/**
 * Cached extended network with TTL + schema version, tied to the 1-hop
 * timestamp it was derived from so it self-invalidates when the seed set
 * (the 1-hop circle) changes.
 */
export type CachedExtendedNetwork = {
  contacts: ExtendedContact[];
  /** When this extended set was computed (ms since epoch). */
  timestamp: number;
  /**
   * The 1-hop cache `timestamp` this set was derived from. If the 1-hop circle
   * is refreshed (different timestamp), this extended entry is treated as stale.
   */
  derivedFrom: number;
  /** Bumped when the *definition* of the extended layer changes. */
  version?: number;
};

/**
 * State structure for extended-network cache, stored via snap_manageState under
 * a key prefix separate from the 1-hop circle. Keyed by lowercased user address.
 */
export type ExtendedNetworkState = {
  [userAddress: string]: CachedExtendedNetwork;
};
