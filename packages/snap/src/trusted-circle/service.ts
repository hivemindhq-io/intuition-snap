/**
 * Trusted Circle Service.
 *
 * Fetches and manages the user's trusted circle — the accounts they follow,
 * expressed as `[I] follow [account]` triples they hold a FOR position on —
 * and cross-references that circle with positions on other triples.
 *
 * @module trusted-circle/service
 */

import { keccak_256 } from '@noble/hashes/sha3';

import type { ClaimTemplateRegistry } from '../claim-templates';
import type { ChainConfig } from '../config';
import {
  chainConfig,
  MAX_SEED_FOLLOWS,
  MIN_BRIDGES,
  BLACKLISTED_TERM_IDS,
  FAMILIARITY_VOCAB,
} from '../config';
import {
  graphQLQuery,
  getUserTrustedCircleQuery,
  getExtendedNetworkQuery,
  getAtomsForAddressesQuery,
  getAllClaimsAboutAtomQuery,
  getSelfClaimsAboutAtomQuery,
} from '../queries';
import {
  getTrustedCircleCache,
  setTrustedCircleCache,
  getTrustedCircleTimestamp,
  getExtendedNetworkCache,
  setExtendedNetworkCache,
} from './cache';
import type {
  TrustedContact,
  TrustedCirclePositions,
  FamiliarContact,
  NetworkFamiliarity,
  ClaimContext,
  ExtendedContact,
  ExtendedNetwork,
  SelfClaim,
  SelfClaims,
} from './types';

/**
 * Response shape from the trusted circle GraphQL query.
 * The followed account is the OBJECT of the `[I] follow [target]` triple.
 * Note: Path is positions → term → triple (not positions → triple directly).
 */
type TrustedCircleQueryResponse = {
  data: {
    positions: {
      term: {
        triple: {
          object_id: string;
          object: {
            label: string;
            data: string;
          };
        };
      };
    }[];
  };
};

/**
 * Checks if a string is a valid EVM address.
 * @param value
 */
function isEvmAddress(value: string | null | undefined): value is string {
  return Boolean(value) && /^0x[a-fA-F0-9]{40}$/i.test(value);
}

/**
 * Canonicalizes an address to its EIP-55 checksummed form — the one canonical
 * form the indexer stores (`account_id`, address-typed `atoms.data`). Use this
 * at every address boundary so GraphQL matches with `_eq`/`_in` and cached/
 * displayed addresses are canonical. Never lowercase an address as a substitute.
 * Returns null when the input is not a valid address.
 *
 * @param value - A possibly-non-canonical address (any casing) or null
 * @returns The checksummed address, or null if invalid
 */
export function toChecksum(value: string | null | undefined): string | null {
  if (!isEvmAddress(value)) {
    return null;
  }
  // EIP-55: hash the ASCII bytes of the lowercase hex (no `0x`), then uppercase
  // each nibble whose corresponding hash nibble is >= 8. Self-contained so we
  // avoid heavier deps (e.g. viem) that don't compile under this package's TS.
  const lower = value.slice(2).toLowerCase();
  const hashBytes = keccak_256(new TextEncoder().encode(lower));

  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const char = lower[i] as string;
    // Each hash byte holds two nibbles; pick the one matching char i.
    const byte = hashBytes[i >> 1] ?? 0;
    const nibble = (byte >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/**
 * Fetches the user's trusted circle from GraphQL.
 * These are the accounts the user *follows* — i.e. accounts they hold a FOR
 * position on in an `[I] follow [account]` triple. The followed account is the
 * OBJECT of that triple.
 *
 * @param userAddress - The user's wallet address
 * @returns Array of trusted contacts
 */
async function fetchTrustedCircleFromAPI(
  userAddress: string,
): Promise<TrustedContact[]> {
  const { iAtomId, followAtomId } = chainConfig as ChainConfig;

  const response = (await graphQLQuery(getUserTrustedCircleQuery, {
    userAddress,
    subjectId: iAtomId,
    predicateId: followAtomId,
  })) as TrustedCircleQueryResponse;

  const positions = response?.data?.positions || [];

  // Extract unique contacts (user might have multiple positions on same triple)
  // IMPORTANT: Use the wallet address for matching against positions.
  // The followed account is the triple's OBJECT atom.
  // For ENS-resolved atoms: label = "smilingkylan.eth", data = "0xCF806..."
  // For plain address atoms: label = "0xb14f...", data = "0xb14f..."
  const contactMap = new Map<string, TrustedContact>();

  for (const position of positions) {
    const triple = position.term?.triple;
    if (!triple) {
      continue;
    } // Skip positions that aren't on triples

    const { object } = triple;
    if (!object) {
      continue;
    }

    // Extract wallet address: prefer data if it's an EVM address, else try label
    const walletAddress = isEvmAddress(object.data)
      ? object.data
      : isEvmAddress(object.label)
      ? object.label
      : null;

    if (!walletAddress) {
      continue;
    }

    // Store the canonical EIP-55 checksummed address (the form the indexer uses).
    // The map key stays lowercased purely for de-duplication.
    const canonical = toChecksum(walletAddress) ?? walletAddress;
    const dedupeKey = walletAddress.toLowerCase();
    if (!contactMap.has(dedupeKey)) {
      contactMap.set(dedupeKey, {
        accountId: canonical,
        label: object.label || canonical, // Keep ENS name for display
      });
    }
  }

  const contacts = Array.from(contactMap.values());

  return contacts;
}

/**
 * Gets the user's trusted circle, using cache when available.
 *
 * @param userAddress - The user's wallet address
 * @returns Array of trusted contacts (may be empty)
 */
export async function getTrustedCircle(
  userAddress: string,
): Promise<TrustedContact[]> {
  // Try cache first
  const cached = await getTrustedCircleCache(userAddress);
  if (cached !== null) {
    return cached;
  }

  // Cache miss or expired, fetch fresh data
  const contacts = await fetchTrustedCircleFromAPI(userAddress);

  // Store in cache for next time
  await setTrustedCircleCache(userAddress, contacts);

  return contacts;
}

// ────────────────────────────────────────────────────────────────────────────
// Extended network (2-hop "friend-of-a-friend").
//
// Built from the viewer's OWN 1-hop circle (never the whitelist) via one batched
// `_in` query. Stake is never read — bridge count (distinct direct follows that
// reach a FoaF) is the only weight. See docs/extended-network-spec.md.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Response shape from the extended-network GraphQL query.
 * Each row is a follow position held by one of the viewer's direct follows;
 * `account_id` is the BRIDGE and the triple's OBJECT is the FoaF.
 */
type ExtendedNetworkQueryResponse = {
  data: {
    positions: {
      account_id: string;
      term: {
        triple: {
          object_id: string;
          object: {
            label: string;
            data: string;
          };
        };
      } | null;
    }[];
  };
};

/**
 * Fetches the viewer's extended network (2-hop follows) from GraphQL.
 *
 * Seeds are the addresses of the viewer's direct follows (capped at
 * MAX_SEED_FOLLOWS, in list order — NOT by stake). One batched query returns
 * every follow position those seeds hold; rows are grouped by FoaF and each
 * FoaF's set of distinct bridges is recorded as `via`.
 *
 * @param userAddress - The viewer (excluded from results)
 * @param directCircle - The viewer's resolved 1-hop circle (seeds + exclusion set)
 */
async function fetchExtendedNetworkFromAPI(
  userAddress: string,
  directCircle: TrustedContact[],
): Promise<ExtendedContact[]> {
  const { iAtomId, followAtomId } = chainConfig as ChainConfig;

  const viewer = toChecksum(userAddress);

  // Seeds: viewer's follows only, canonicalized to their EIP-55 checksummed form
  // (the indexer stores `account_id` checksummed). De-duped, capped in list order
  // — NOT by stake. Per the house address standard we match these with `_in`
  // against the canonical address and NEVER lowercase or `_ilike`
  // (see docs/patterns/GRAPHQL-PATTERNS.md). `directSet` is the canonical
  // exclusion set (every address here is checksummed).
  const directSet = new Set<string>();
  const seeds: string[] = [];
  for (const contact of directCircle) {
    const canonical = toChecksum(contact.accountId);
    if (!canonical || directSet.has(canonical)) {
      continue;
    }
    directSet.add(canonical);
    seeds.push(canonical);
    if (seeds.length >= MAX_SEED_FOLLOWS) {
      break;
    }
  }

  if (seeds.length === 0) {
    return [];
  }

  const response = (await graphQLQuery(getExtendedNetworkQuery, {
    followerAddresses: seeds,
    subjectId: iAtomId,
    predicateId: followAtomId,
  })) as ExtendedNetworkQueryResponse;

  const positions = response?.data?.positions || [];

  // Group rows by FoaF; accumulate distinct bridges in `via`. Every address is
  // canonicalized to its checksummed form, so comparisons and stored values stay
  // canonical (no lowercasing).
  const foafMap = new Map<
    string,
    { accountId: string; label: string; via: Set<string> }
  >();

  for (const position of positions) {
    const triple = position.term?.triple;
    if (!triple) {
      continue;
    }

    const { object } = triple;
    if (!object) {
      continue;
    }

    const bridge = toChecksum(position.account_id);
    if (!bridge) {
      continue;
    }

    // Extract the FoaF wallet address (data first, then label) and canonicalize.
    const foaf = toChecksum(
      isEvmAddress(object.data)
        ? object.data
        : isEvmAddress(object.label)
        ? object.label
        : null,
    );
    if (!foaf) {
      continue;
    }

    // Exclude the viewer and anyone already in the 1-hop circle.
    if (foaf === viewer) {
      continue;
    }
    if (directSet.has(foaf)) {
      continue;
    }

    const existing = foafMap.get(foaf);
    if (existing) {
      existing.via.add(bridge);
    } else {
      foafMap.set(foaf, {
        accountId: foaf,
        label: object.label || foaf,
        via: new Set([bridge]),
      });
    }
  }

  // Materialize, sort by bridge count (via.length) desc, then label.
  const contacts: ExtendedContact[] = Array.from(foafMap.values()).map((c) => ({
    accountId: c.accountId,
    label: c.label,
    via: Array.from(c.via),
  }));

  contacts.sort((a, b) => {
    if (b.via.length !== a.via.length) {
      return b.via.length - a.via.length;
    }
    return a.label.localeCompare(b.label);
  });

  return contacts;
}

/**
 * Gets the viewer's extended network (2-hop), using cache when available.
 *
 * The extended set is derived from the already-resolved 1-hop circle and cached
 * under its own version + TTL, tied to the 1-hop timestamp so it self-invalidates
 * when the seed circle is refreshed.
 *
 * @param userAddress - The viewer's wallet address
 * @param directCircle - The viewer's resolved 1-hop circle
 * @returns The extended network (empty when the circle is empty)
 */
export async function getExtendedNetwork(
  userAddress: string,
  directCircle: TrustedContact[],
): Promise<ExtendedNetwork> {
  if (directCircle.length === 0) {
    return { contacts: [] };
  }

  // The 1-hop timestamp anchors cache validity (seeds changed ⇒ invalidate).
  const oneHopTimestamp = await getTrustedCircleTimestamp(userAddress);

  const cached = await getExtendedNetworkCache(userAddress, oneHopTimestamp);
  if (cached !== null) {
    return { contacts: cached };
  }

  const contacts = await fetchExtendedNetworkFromAPI(userAddress, directCircle);

  // Only cache when we have a 1-hop timestamp to anchor to; otherwise skip the
  // write so a future, properly-anchored read re-derives.
  if (oneHopTimestamp !== null) {
    await setExtendedNetworkCache(userAddress, contacts, oneHopTimestamp);
  }

  return { contacts };
}

/**
 * Builds cheap lookup structures for gating/attribution against the 2-hop layer.
 *
 * @param net - The resolved extended network
 * @returns A Set of checksummed FoaF addresses and a Map for label/bridge lookup
 */
export function indexExtendedNetwork(net: ExtendedNetwork): {
  ids: Set<string>;
  byAddress: Map<string, ExtendedContact>;
} {
  const ids = new Set<string>();
  const byAddress = new Map<string, ExtendedContact>();

  for (const contact of net.contacts) {
    // contact.accountId is already canonical (checksummed); key by it directly.
    const canonical = toChecksum(contact.accountId) ?? contact.accountId;
    ids.add(canonical);
    byAddress.set(canonical, contact);
  }

  return { ids, byAddress };
}

/**
 * Position data from a triple query.
 */
type PositionWithAccount = {
  account_id: string;
  shares?: string;
  account?: {
    id: string;
    label: string;
  };
};

/**
 * Filters positions to only include trusted contacts.
 * Cross-references the user's trusted circle with positions on a triple.
 * Excludes the user's own address since their position is shown separately.
 *
 * @param trustedCircle - The user's trusted contacts
 * @param forPositions - Positions staking FOR
 * @param againstPositions - Positions staking AGAINST
 * @param userAddress - The current user's address to exclude from results
 * @returns Trusted contacts with their stance (FOR/AGAINST)
 */
export function getTrustedContactsWithPositions(
  trustedCircle: TrustedContact[],
  forPositions: PositionWithAccount[],
  againstPositions: PositionWithAccount[],
  userAddress?: string,
): TrustedCirclePositions {
  const normalizedUserAddress = userAddress?.toLowerCase();

  // Create a Set for O(1) lookup of trusted account IDs
  const trustedIds = new Set(
    trustedCircle.map((c) => c.accountId.toLowerCase()),
  );

  // Also create a map for quick label lookup
  const trustedLabels = new Map(
    trustedCircle.map((c) => [c.accountId.toLowerCase(), c.label]),
  );

  // Filter FOR positions to trusted contacts, excluding the user's own position
  const forContacts: TrustedContact[] = [];
  for (const position of forPositions) {
    const accountId = position.account_id?.toLowerCase();
    if (accountId === normalizedUserAddress) {
      continue;
    }
    const isTrusted = accountId && trustedIds.has(accountId);
    if (isTrusted) {
      forContacts.push({
        accountId: position.account_id,
        label:
          trustedLabels.get(accountId) ||
          position.account?.label ||
          formatAddress(position.account_id),
        shares: position.shares || '0',
      });
    }
  }

  // Filter AGAINST positions to trusted contacts, excluding the user's own position
  const againstContacts: TrustedContact[] = [];
  for (const position of againstPositions) {
    const accountId = position.account_id?.toLowerCase();
    if (accountId === normalizedUserAddress) {
      continue;
    }
    const isTrusted = accountId && trustedIds.has(accountId);
    if (isTrusted) {
      againstContacts.push({
        accountId: position.account_id,
        label:
          trustedLabels.get(accountId) ||
          position.account?.label ||
          formatAddress(position.account_id),
        shares: position.shares || '0',
      });
    }
  }

  // Sort by shares (highest stake first)
  forContacts.sort((a, b) => {
    const sharesA = BigInt(a.shares ?? '0');
    const sharesB = BigInt(b.shares ?? '0');
    if (sharesB > sharesA) {
      return 1;
    }
    if (sharesB < sharesA) {
      return -1;
    }
    return 0;
  });

  againstContacts.sort((a, b) => {
    const sharesA = BigInt(a.shares ?? '0');
    const sharesB = BigInt(b.shares ?? '0');
    if (sharesB > sharesA) {
      return 1;
    }
    if (sharesB < sharesA) {
      return -1;
    }
    return 0;
  });

  return { forContacts, againstContacts };
}

/**
 * Formats an address for display (first 6 + last 4 chars).
 *
 * @param address - Full address string
 * @returns Truncated address like "0x1234...5678"
 */
function formatAddress(address: string): string {
  if (!address || address.length < 12) {
    return address || 'Unknown';
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Response shape from the "all claims about atom" query.
 */
type AllClaimsResponse = {
  data: {
    triples: {
      term_id: string;
      predicate_id: string;
      object_id: string;
      predicate: { label: string } | null;
      object: { label: string } | null;
      positions: { account_id: string; shares: string }[];
      counter_positions: { account_id: string; shares: string }[];
    }[];
  };
};

/**
 * Sentinel object key meaning "match any object" for a self-describing predicate
 * (e.g. `vouchFor`). Mirrors the `object: "*"` convention in the API config.
 */
const FAMILIARITY_OBJECT_WILDCARD = '*';

/**
 * Resolved familiarity whitelist: maps a triple's on-chain `(predicate_id,
 * object_id)` to its placement tier. Built from the registry's named keys, so a
 * vocab entry only contributes when BOTH its predicate and object keys resolve to
 * term IDs via the registry maps (offline-seed objects that aren't in the maps
 * simply don't apply — graceful degradation).
 */
type FamiliarityWhitelist = {
  /** `${predicateId}|${objectId}` → tier, for object-specific entries. */
  pairs: Map<string, 'primary' | 'secondary'>;
  /** `predicateId` → tier, for wildcard (`object: "*"`) entries. */
  wildcards: Map<string, 'primary' | 'secondary'>;
};

/**
 * Builds the default-deny familiarity whitelist by resolving the vocab entries'
 * named predicate/object keys to on-chain term IDs through the registry maps.
 *
 * The live registry's `familiarityVocab` is unioned with the local offline seed
 * (`FAMILIARITY_VOCAB`) so a known-good claim still surfaces from a stale cache
 * or when the API omits the field. When two entries resolve to the same pair, the
 * stronger (`primary`) tier wins.
 *
 * @param registry - The claim-template registry (predicate/object maps + vocab).
 * @returns The resolved whitelist (pair + wildcard lookups), possibly empty.
 */
function buildFamiliarityWhitelist(
  registry: ClaimTemplateRegistry | undefined,
): FamiliarityWhitelist {
  const pairs = new Map<string, 'primary' | 'secondary'>();
  const wildcards = new Map<string, 'primary' | 'secondary'>();

  const predicates = registry?.predicates ?? {};
  const objects = registry?.objects ?? {};

  // Union the live vocab with the offline seed. Entries are deduped implicitly by
  // the maps; `primary` beats `secondary` on collision.
  const entries = [...(registry?.familiarityVocab ?? []), ...FAMILIARITY_VOCAB];

  const strongest = (
    existing: 'primary' | 'secondary' | undefined,
    next: 'primary' | 'secondary',
  ): 'primary' | 'secondary' =>
    existing === 'primary' || next === 'primary' ? 'primary' : 'secondary';

  for (const entry of entries) {
    const predicateId = predicates[entry.predicate];
    if (!predicateId) {
      continue;
    }

    if (entry.object === FAMILIARITY_OBJECT_WILDCARD) {
      wildcards.set(
        predicateId,
        strongest(wildcards.get(predicateId), entry.tier),
      );
      continue;
    }

    const objectId = objects[entry.object];
    if (!objectId) {
      continue;
    }
    const key = `${predicateId}|${objectId}`;
    pairs.set(key, strongest(pairs.get(key), entry.tier));
  }

  return { pairs, wildcards };
}

/**
 * Resolves a triple's placement tier against the whitelist, or `null` when the
 * claim is not whitelisted at all. Object-specific entries take precedence over a
 * predicate wildcard.
 *
 * @param whitelist - The resolved familiarity whitelist.
 * @param predicateId - The triple's predicate term ID.
 * @param objectId - The triple's object term ID.
 * @returns The claim's tier, or null when not whitelisted.
 */
function resolveFamiliarityTier(
  whitelist: FamiliarityWhitelist,
  predicateId: string,
  objectId: string,
): 'primary' | 'secondary' | null {
  const pairTier = whitelist.pairs.get(`${predicateId}|${objectId}`);
  if (pairTier) {
    return pairTier;
  }
  return whitelist.wildcards.get(predicateId) ?? null;
}

/**
 * Fetches all claims about an atom and cross-references with the user's trust circle.
 * Returns contacts who have ANY claim about the target address,
 * de-duplicated against those already shown in the TrustedCircle section.
 *
 * When an `extendedIndex` is supplied (2-hop layer), the SAME claim triples are
 * also cross-referenced against the friend-of-a-friend set, producing a separate
 * `extendedContacts` list gated by MIN_BRIDGES. No extra query is issued.
 *
 * @param subjectAtomId - The term_id of the target address's atom
 * @param trustedCircle - The user's trust circle contacts
 * @param alreadyDisplayedIds - Set of account IDs already shown in TrustedCircle section (normalized lowercase)
 * @param userAddress - The current user's address to exclude
 * @param extendedIndex - Optional 2-hop lookup (FoaF ids + per-contact bridges)
 * @param extendedIndex.ids
 * @param excludeTermIds - Optional set of triple term_ids already surfaced in the
 * safety section. Matching claims are skipped so each claim has exactly one home
 * (Opt 3 dedup); contacts left with zero claims are naturally dropped.
 * @param extendedIndex.byAddress
 * @param registry - Optional claim-template registry. When supplied, each claim's
 * `predicate_id` is resolved to its first-class key (e.g. 'hasTag') so the UI can
 * render natural-language phrasing. Absent ⇒ claims fall back to verbatim labels.
 * @returns Network familiarity data, or undefined if no relevant contacts
 */
export async function getNetworkFamiliarity(
  subjectAtomId: string,
  trustedCircle: TrustedContact[],
  alreadyDisplayedIds: Set<string>,
  userAddress?: string,
  extendedIndex?: { ids: Set<string>; byAddress: Map<string, ExtendedContact> },
  excludeTermIds?: Set<string>,
  registry?: ClaimTemplateRegistry,
): Promise<NetworkFamiliarity | undefined> {
  if (trustedCircle.length === 0) {
    return undefined;
  }

  try {
    const response = (await graphQLQuery(getAllClaimsAboutAtomQuery, {
      subjectId: subjectAtomId,
    })) as AllClaimsResponse;

    const triples = response?.data?.triples || [];
    if (triples.length === 0) {
      return undefined;
    }

    const normalizedUserAddress = userAddress?.toLowerCase();
    const trustedIds = new Set(
      trustedCircle.map((c) => c.accountId.toLowerCase()),
    );
    const trustedLabels = new Map(
      trustedCircle.map((c) => [c.accountId.toLowerCase(), c.label]),
    );

    // Reverse the registry's `key -> term_id` predicate map so we can resolve each
    // claim's `predicate_id` to its first-class key (e.g. 'hasTag'). Direct string
    // match, mirroring the safety service (no normalization). Empty when absent.
    const predIdToKey = new Map<string, string>(
      registry
        ? Object.entries(registry.predicates).map(([key, id]) => [id, key])
        : [],
    );

    // Suppression set: union the live registry blacklist with the local offline
    // seed so a known rogue/duplicate atom (e.g. a non-canonical "has tag") is
    // always filtered, even from a stale cache or when the API omits the field.
    const blacklist = new Set<string>([
      ...(registry?.blacklistedTermIds ?? []),
      ...BLACKLISTED_TERM_IDS,
    ]);

    // Default-deny familiarity whitelist (predicate+object → tier). The surface
    // shows ONLY whitelisted claims; everything else is suppressed unless the
    // escape hatch below fires.
    const whitelist = buildFamiliarityWhitelist(registry);

    // Escape hatch: if NOTHING on this subject is whitelisted, fall back to
    // showing the (post-blacklist) claims verbatim — but only in More info, by
    // stamping them `secondary`. This keeps long-tail/unknown predicates visible
    // when there is no curated signal at all, while never letting them reach the
    // inline primary tier. A single whitelisted claim disables the hatch.
    const anyWhitelisted = triples.some(
      (t) =>
        !excludeTermIds?.has(t.term_id) &&
        !blacklist.has(t.predicate_id) &&
        !blacklist.has(t.object_id) &&
        !blacklist.has(t.term_id) &&
        resolveFamiliarityTier(whitelist, t.predicate_id, t.object_id) !== null,
    );

    // Collect claims per trusted contact, skipping already-displayed and the user.
    const contactClaimsMap = new Map<
      string,
      { accountId: string; label: string; claims: ClaimContext[] }
    >();
    // Separate accumulator for degree-2 (friend-of-a-friend) contacts.
    const extendedClaimsMap = new Map<
      string,
      {
        accountId: string;
        label: string;
        claims: ClaimContext[];
        bridgeCount: number;
      }
    >();

    /**
     * De-dupes a claim into a contact's running claim list.
     * @param claims
     * @param claim
     */
    const pushClaim = (claims: ClaimContext[], claim: ClaimContext): void => {
      const hasClaim = claims.some(
        (c) =>
          c.predicateLabel === claim.predicateLabel &&
          c.objectLabel === claim.objectLabel,
      );
      if (!hasClaim) {
        claims.push(claim);
      }
    };

    for (const triple of triples) {
      // Dedup (Opt 3): this claim already lives in the safety surface, so skip it
      // here to avoid showing the same triple in two places.
      if (excludeTermIds?.has(triple.term_id)) {
        continue;
      }

      // Suppress blacklisted atoms (non-canonical / duplicate). Match on the
      // predicate, object, or triple term ID so one list can kill a rogue
      // predicate, a rogue object, or a single bad triple.
      if (
        blacklist.has(triple.predicate_id) ||
        blacklist.has(triple.object_id) ||
        blacklist.has(triple.term_id)
      ) {
        continue;
      }

      // Default-deny: resolve this claim's placement tier from the whitelist.
      // A whitelisted claim keeps its tier; a non-whitelisted claim is dropped
      // unless the escape hatch is active (nothing whitelisted on the subject),
      // in which case it surfaces verbatim but pinned to `secondary` (More info).
      const matchedTier = resolveFamiliarityTier(
        whitelist,
        triple.predicate_id,
        triple.object_id,
      );
      if (matchedTier === null && anyWhitelisted) {
        continue;
      }
      const tier: 'primary' | 'secondary' = matchedTier ?? 'secondary';

      const predicateLabel = triple.predicate?.label || 'unknown';
      const objectLabel = triple.object?.label || 'unknown';
      const predicateKey = predIdToKey.get(triple.predicate_id);

      const claim: ClaimContext = {
        predicateLabel,
        objectLabel,
        tier,
        termId: triple.term_id,
        ...(predicateKey ? { predicateKey } : {}),
      };

      const allPositionAccounts = [
        ...triple.positions.map((p) => p.account_id),
        ...triple.counter_positions.map((p) => p.account_id),
      ];

      for (const accountId of allPositionAccounts) {
        const normalized = accountId.toLowerCase();

        if (normalized === normalizedUserAddress) {
          continue;
        }
        if (alreadyDisplayedIds.has(normalized)) {
          continue;
        }

        // 1-hop: direct follow (trust circle).
        if (trustedIds.has(normalized)) {
          const existing = contactClaimsMap.get(normalized);
          if (existing) {
            pushClaim(existing.claims, claim);
          } else {
            contactClaimsMap.set(normalized, {
              accountId,
              label: trustedLabels.get(normalized) || formatAddress(accountId),
              claims: [claim],
            });
          }
          continue;
        }

        // 2-hop: friend-of-a-friend, gated by MIN_BRIDGES. The extended index is
        // keyed by canonical (checksummed) address, so look up by that — never a
        // lowercased form. The index already excludes the viewer and all direct
        // follows by construction.
        const canonicalAccount = toChecksum(accountId);
        if (canonicalAccount && extendedIndex?.ids.has(canonicalAccount)) {
          const ext = extendedIndex.byAddress.get(canonicalAccount);
          if (!ext || ext.via.length < MIN_BRIDGES) {
            continue;
          }

          const existing = extendedClaimsMap.get(canonicalAccount);
          if (existing) {
            pushClaim(existing.claims, claim);
          } else {
            extendedClaimsMap.set(canonicalAccount, {
              accountId: canonicalAccount,
              label: ext.label || formatAddress(canonicalAccount),
              claims: [claim],
              bridgeCount: ext.via.length,
            });
          }
        }
      }
    }

    const familiarContacts: FamiliarContact[] = Array.from(
      contactClaimsMap.values(),
    );

    const extendedContacts: FamiliarContact[] = Array.from(
      extendedClaimsMap.values(),
    )
      .map((c) => ({
        accountId: c.accountId,
        label: c.label,
        claims: c.claims,
        degree: 2 as const,
        bridgeCount: c.bridgeCount,
      }))
      // Most-bridged FoaF first; ties broken by label.
      .sort((a, b) => {
        const bridgeDiff = (b.bridgeCount ?? 0) - (a.bridgeCount ?? 0);
        return bridgeDiff !== 0 ? bridgeDiff : a.label.localeCompare(b.label);
      });

    if (familiarContacts.length === 0 && extendedContacts.length === 0) {
      return undefined;
    }

    const result: NetworkFamiliarity = {
      familiarContacts,
      totalClaimsAboutAddress: triples.length,
    };
    if (extendedContacts.length > 0) {
      result.extendedContacts = extendedContacts;
    }
    return result;
  } catch (error) {
    console.error('[TrustedCircle] Network familiarity query failed:', error);
    return undefined;
  }
}

/**
 * Response shape from the "self claims about atom" query.
 */
type SelfClaimsResponse = {
  data: {
    triples: {
      term_id: string;
      predicate_id: string;
      object_id: string;
      predicate: { label: string } | null;
      object: { label: string } | null;
      user_position: { shares: string }[];
      user_counter_position: { shares: string }[];
    }[];
  };
};

/**
 * Whether a shares array carries a non-zero stake. The query already filters to
 * triples the viewer holds a position on, but a stale/zeroed row could slip
 * through, so shares are read defensively rather than trusting mere presence.
 *
 * @param positions - The viewer's position rows for one side of a triple.
 * @returns True when at least one row carries a positive (or non-numeric) stake.
 */
function hasStake(positions: { shares: string }[] | undefined): boolean {
  if (!positions || positions.length === 0) {
    return false;
  }
  for (const position of positions) {
    try {
      if (BigInt(position.shares ?? '0') > 0n) {
        return true;
      }
    } catch {
      // Non-numeric shares — treat the row's presence as a held position.
      return true;
    }
  }
  return false;
}

/**
 * Fetches the VIEWER'S OWN claims about a subject atom — the "Self" lane.
 *
 * Returns every triple about `subjectAtomId` on which the viewer holds a
 * position (FOR or AGAINST), classified by stance. Unlike
 * {@link getNetworkFamiliarity} this is NOT gated by the familiarity whitelist
 * (any claim the viewer staked is theirs to see) and does NOT depend on the
 * trusted circle — it surfaces a personal signal back to the viewer.
 *
 * The blacklist (non-canonical/duplicate atoms) and the safety-dedup exclusion
 * set are still applied so a rogue atom is suppressed and no claim that already
 * lives in the safety surface renders twice.
 *
 * @param subjectAtomId - The term_id of the subject atom (address or origin).
 * @param userAddress - The viewer's wallet address.
 * @param excludeTermIds - Triple term_ids already surfaced by the safety lane.
 * @param registry - Optional claim-template registry for predicate-key phrasing.
 * @returns The viewer's claims, or undefined when there are none.
 */
export async function getSelfClaims(
  subjectAtomId: string,
  userAddress: string,
  excludeTermIds?: Set<string>,
  registry?: ClaimTemplateRegistry,
): Promise<SelfClaims | undefined> {
  try {
    const response = (await graphQLQuery(getSelfClaimsAboutAtomQuery, {
      subjectId: subjectAtomId,
      userAddress,
    })) as SelfClaimsResponse;

    const triples = response?.data?.triples || [];
    if (triples.length === 0) {
      return undefined;
    }

    // Resolve each claim's `predicate_id` to its first-class registry key (e.g.
    // 'hasTag') for natural-language phrasing, mirroring the familiarity lane.
    const predIdToKey = new Map<string, string>(
      registry
        ? Object.entries(registry.predicates).map(([key, id]) => [id, key])
        : [],
    );

    // Suppression set: union the live registry blacklist with the offline seed.
    const blacklist = new Set<string>([
      ...(registry?.blacklistedTermIds ?? []),
      ...BLACKLISTED_TERM_IDS,
    ]);

    const claims: SelfClaim[] = [];
    for (const triple of triples) {
      // Dedup: already surfaced in the safety lane — skip so it has one home.
      if (excludeTermIds?.has(triple.term_id)) {
        continue;
      }

      // Suppress blacklisted (non-canonical / duplicate) atoms.
      if (
        blacklist.has(triple.predicate_id) ||
        blacklist.has(triple.object_id) ||
        blacklist.has(triple.term_id)
      ) {
        continue;
      }

      // Derive stance: FOR when the viewer holds a support position, else
      // AGAINST when they hold a counter position. A row with both (rare) is
      // treated as FOR, since support is the primary lane.
      const isFor = hasStake(triple.user_position);
      const isAgainst = hasStake(triple.user_counter_position);
      if (!isFor && !isAgainst) {
        continue;
      }
      const stance: 'for' | 'against' = isFor ? 'for' : 'against';

      const predicateLabel = triple.predicate?.label || 'unknown';
      const objectLabel = triple.object?.label || 'unknown';
      const predicateKey = predIdToKey.get(triple.predicate_id);

      claims.push({
        predicateLabel,
        objectLabel,
        // The viewer's own claims are always inline-eligible (primary tier).
        tier: 'primary',
        stance,
        termId: triple.term_id,
        ...(predicateKey ? { predicateKey } : {}),
      });
    }

    if (claims.length === 0) {
      return undefined;
    }

    return { claims };
  } catch (error) {
    console.error('[SelfClaims] Self claims query failed:', error);
    return undefined;
  }
}

/**
 * Response shape from the atoms for addresses query.
 */
type AtomsForAddressesResponse = {
  data: {
    atoms: {
      term_id: string;
      label: string;
      data: string;
      image: string | null;
    }[];
  };
};

/**
 * Enriches trusted contacts with resolved labels (ENS names, etc.).
 * The Intuition backend resolves ENS names automatically, so we just need
 * to fetch the atom data for the addresses.
 *
 * @param positions - The trusted circle positions to enrich
 * @returns Enriched positions with resolved labels
 */
export async function enrichContactLabels(
  positions: TrustedCirclePositions,
): Promise<TrustedCirclePositions> {
  // Collect all unique addresses from both FOR and AGAINST contacts
  const allContacts = [...positions.forContacts, ...positions.againstContacts];
  if (allContacts.length === 0) {
    return positions;
  }

  // Collect unique addresses (both lowercase for query flexibility)
  const addresses = [...new Set(allContacts.map((c) => c.accountId))];
  const lowercaseAddresses = addresses.map((a) => a.toLowerCase());

  // Query for all addresses in one batch
  const allAddresses = [...addresses, ...lowercaseAddresses];

  try {
    const response = (await graphQLQuery(getAtomsForAddressesQuery, {
      addresses: allAddresses,
    })) as AtomsForAddressesResponse;

    const atoms = response?.data?.atoms || [];

    // Build a map of address -> resolved label
    // Priority: atom with ENS-like label > atom with address label > original address
    const labelMap = new Map<string, string>();

    for (const atom of atoms) {
      // The atom's data or label contains the address
      const addressFromData = atom.data?.toLowerCase();
      const addressFromLabel = atom.label?.toLowerCase();

      // Check if this atom's label is a resolved name (not an address)
      const isResolvedName =
        atom.label && !/^0x[a-fA-F0-9]{40}$/iu.test(atom.label);

      // Map both possible address sources to the label
      if (addressFromData && isResolvedName) {
        // Prefer resolved name over existing entry
        labelMap.set(addressFromData, atom.label);
      }
      if (
        addressFromLabel &&
        isResolvedName &&
        addressFromLabel !== addressFromData
      ) {
        labelMap.set(addressFromLabel, atom.label);
      }
    }

    // Update contacts with resolved labels
    const enrichContact = (contact: TrustedContact): TrustedContact => {
      const normalizedAddress = contact.accountId.toLowerCase();
      const resolvedLabel = labelMap.get(normalizedAddress);

      if (resolvedLabel) {
        return { ...contact, label: resolvedLabel };
      }

      // Fallback to formatted address if no resolved name
      if (/^0x[a-fA-F0-9]{40}$/iu.test(contact.label)) {
        return { ...contact, label: formatAddress(contact.label) };
      }

      return contact;
    };

    return {
      forContacts: positions.forContacts.map(enrichContact),
      againstContacts: positions.againstContacts.map(enrichContact),
    };
  } catch (error) {
    // If enrichment fails, return original positions with formatted addresses
    console.error('[TrustedCircle] Label enrichment failed:', error);

    const formatContact = (contact: TrustedContact): TrustedContact => ({
      ...contact,
      label: /^0x[a-fA-F0-9]{40}$/iu.test(contact.label)
        ? formatAddress(contact.label)
        : contact.label,
    });

    return {
      forContacts: positions.forContacts.map(formatContact),
      againstContacts: positions.againstContacts.map(formatContact),
    };
  }
}
