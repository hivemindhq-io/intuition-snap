/**
 * Safety read-surface service.
 *
 * Fetches safety + provenance triples about the target address atom and
 * classifies them into critical / warning / provenance lanes, gated by the
 * publisher whitelist and the user's trust circle. Implements the read surface
 * described in docs/claim-surface-spec.md §3-§5.
 *
 * Resolution of predicate/object term IDs prefers the live claim-template
 * registry (from the Hive Mind API) and falls back to the chain-independent
 * constants in config.ts when the registry is unavailable.
 *
 * @module safety/service
 */

import type { ClaimTemplateRegistry } from '../claim-templates';
import {
  SAFETY_PREDICATE_IDS,
  SAFETY_OBJECT_IDS,
  MIN_BRIDGES,
} from '../config';
import type {
  PublisherWhitelistRegistry,
  Publisher,
} from '../publisher-whitelist/types';
import { graphQLQuery, getSafetyClaimsAboutAtomQuery } from '../queries';
import { toChecksum } from '../trusted-circle/service';
import type { TrustedContact, ExtendedContact } from '../trusted-circle/types';
import type {
  SafetyData,
  SafetySignal,
  SafetyAuthor,
  SafetyEntity,
} from './types';

/**
 * NOTE: this surface is intentionally negative-only + provenance. Positive
 * claims (e.g. `has tag → trustworthy`, `bullish`) are NOT in scope here — they
 * are reflected in the existing reputation / trust-signal section instead.
 */

/**
 * Hard-lane object metadata, keyed by registry object key.
 * `critical` objects from a whitelisted authority surface at the very top.
 * `entities` limits which entity type the report is meaningful for
 * (e.g. Honeypot/Exploit only make sense for contracts; Sybil for EOAs).
 */
const HARD_OBJECTS: Record<
  string,
  { critical: boolean; entities: SafetyEntity[] }
> = {
  scam: { critical: true, entities: ['eoa', 'contract', 'site'] },
  phishing: { critical: true, entities: ['eoa', 'contract', 'site'] },
  drainer: { critical: true, entities: ['eoa', 'contract', 'site'] },
  honeypot: { critical: true, entities: ['contract'] },
  exploit: { critical: true, entities: ['contract'] },
  sybil: { critical: true, entities: ['eoa'] },
  botReport: { critical: false, entities: ['eoa'] },
  injection: { critical: false, entities: ['contract'] },
  spam: { critical: false, entities: ['eoa', 'contract'] },
};

/** Soft-lane object metadata (surfaced via `has tag`, trust-circle gated). */
const SOFT_OBJECTS: Record<string, { entities: SafetyEntity[] }> = {
  suspicious: { entities: ['eoa', 'contract'] },
  malicious: { entities: ['eoa', 'contract'] },
  scammer: { entities: ['eoa', 'contract'] },
  bot: { entities: ['eoa'] },
  impersonation: { entities: ['eoa', 'site'] },
};

/** Provenance/identity predicate metadata, keyed by registry predicate key. */
const PROVENANCE_PREDICATES: Record<string, { entities: SafetyEntity[] }> = {
  createdBy: { entities: ['contract'] },
  auditedBy: { entities: ['contract'] },
  evaluatedBy: { entities: ['contract'] },
  sameAs: { entities: ['eoa'] },
};

type SafetyAccountRef = {
  id: string;
  label: string;
};

type SafetyTriple = {
  term_id: string;
  predicate_id: string;
  object_id: string;
  creator_id: string | null;
  creator: SafetyAccountRef | null;
  predicate: { label: string } | null;
  object: { label: string } | null;
  positions: {
    account_id: string;
    shares: string;
    account: SafetyAccountRef | null;
  }[];
  counter_positions: { account_id: string; shares: string }[];
};

type SafetyQueryResponse = {
  data: { triples: SafetyTriple[] };
};

const isEvmAddress = (value: string | null | undefined): value is string =>
  Boolean(value) && /^0x[a-fA-F0-9]{40}$/u.test(value);

const formatAddress = (address: string): string =>
  isEvmAddress(address)
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address;

/** Cheap lookup structures for the 2-hop extended network (see trusted-circle). */
export type ExtendedNetworkIndex = {
  ids: Set<string>;
  byAddress: Map<string, ExtendedContact>;
};

export type GetSafetyDataOptions = {
  registry: ClaimTemplateRegistry;
  trustedCircle: TrustedContact[];
  whitelist: PublisherWhitelistRegistry;
  userAddress?: string | undefined;
  /**
   * Whether the subject address is a contract (vs an EOA). Used to derive the
   * entity type when `entity` is not provided explicitly. Optional so callers
   * scoping a non-address subject (e.g. a site origin) can pass `entity` instead.
   */
  isContract?: boolean;
  /**
   * Explicit entity type for the subject atom. When provided it takes precedence
   * over `isContract`; otherwise the entity is derived from `isContract`
   * (`true` → 'contract', else 'eoa'). Used to scope the vocabulary to a
   * non-address subject such as a site origin (`'site'`).
   */
  entity?: SafetyEntity | undefined;
  /**
   * Optional 2-hop extended-network index. When present, an asserting account
   * that is neither whitelisted nor in the 1-hop trust circle but reachable via
   * ≥ MIN_BRIDGES distinct follows is attributed as a degree-2 author. This adds
   * a separate, clearly-labeled 2nd-degree block; it never gates critical.
   */
  extendedIndex?: ExtendedNetworkIndex | undefined;
};

/**
 * Fetches and classifies safety signals about a subject atom.
 *
 * @param subjectAtomTermId - term_id of the target address's atom
 * @param options - registry, trust circle, whitelist, user address, entity type
 * @returns Categorized SafetyData, or undefined if nothing surfaceable
 */
export async function getSafetyData(
  subjectAtomTermId: string,
  options: GetSafetyDataOptions,
): Promise<SafetyData | undefined> {
  const {
    registry,
    trustedCircle,
    whitelist,
    userAddress,
    isContract,
    entity: entityOption,
    extendedIndex,
  } = options;
  const entity: SafetyEntity =
    entityOption ?? (isContract ? 'contract' : 'eoa');

  // Resolve term IDs: prefer the live registry, fall back to shared constants.
  const objId = (key: string): string | undefined =>
    registry.objects?.[key] ??
    (SAFETY_OBJECT_IDS as Record<string, string>)[key];
  const predId = (key: string): string | undefined =>
    registry.predicates?.[key] ??
    (SAFETY_PREDICATE_IDS as Record<string, string>)[key];

  const reportedForId = predId('reportedFor');
  const hasTagId = predId('hasTag');
  if (!reportedForId || !hasTagId) {
    return undefined;
  }

  // Build reverse maps (term ID -> registry key) for classification.
  const hardIdToKey = new Map<string, string>();
  for (const key of Object.keys(HARD_OBJECTS)) {
    const id = objId(key);
    if (id) {
      hardIdToKey.set(id, key);
    }
  }
  const softIdToKey = new Map<string, string>();
  for (const key of Object.keys(SOFT_OBJECTS)) {
    const id = objId(key);
    if (id) {
      softIdToKey.set(id, key);
    }
  }
  const provPredIdToKey = new Map<string, string>();
  for (const key of Object.keys(PROVENANCE_PREDICATES)) {
    const id = predId(key);
    if (id) {
      provPredIdToKey.set(id, key);
    }
  }

  const softObjectIds = Array.from(softIdToKey.keys());
  const provenancePredicateIds = Array.from(provPredIdToKey.keys());

  let triples: SafetyTriple[] = [];
  try {
    const response = (await graphQLQuery(getSafetyClaimsAboutAtomQuery, {
      subjectId: subjectAtomTermId,
      reportedForId,
      hasTagId,
      softObjectIds,
      provenancePredicateIds,
    })) as SafetyQueryResponse;
    triples = response?.data?.triples || [];
  } catch (error) {
    console.error('[Safety] query failed:', error);
    return undefined;
  }

  if (triples.length === 0) {
    return undefined;
  }

  // Author lookup maps.
  const normalizedUser = userAddress?.toLowerCase();
  const whitelistMap = new Map<string, Publisher>(
    whitelist.publishers.map((p) => [p.address.toLowerCase(), p]),
  );
  const trustMap = new Map<string, string>(
    trustedCircle.map((c) => [c.accountId.toLowerCase(), c.label]),
  );

  // On-chain identity labels for asserting accounts, harvested from the graph
  // (creators + position holders). Authorities and trust-circle contacts are
  // both displayed by their identity (ENS name, else truncated hex address)
  // rather than any hard-coded authority title.
  const accountLabelMap = new Map<string, string>();
  for (const triple of triples) {
    if (triple.creator?.id && triple.creator.label) {
      accountLabelMap.set(
        triple.creator.id.toLowerCase(),
        triple.creator.label,
      );
    }
    for (const p of triple.positions || []) {
      if (p.account?.id && p.account.label) {
        accountLabelMap.set(p.account.id.toLowerCase(), p.account.label);
      }
    }
  }

  /**
   * Resolves an asserting account's display label: an ENS-style name when one
   * is known (from the graph or an explicit fallback), otherwise a truncated
   * hex address. Never returns a hard-coded authority title.
   *
   * @param address - lowercased asserting address
   * @param fallback - optional label to consider before the address (e.g. a
   * trust-circle contact's stored label)
   */
  const resolveLabel = (address: string, fallback?: string): string => {
    const candidate = accountLabelMap.get(address) ?? fallback;
    return candidate && !isEvmAddress(candidate)
      ? candidate
      : formatAddress(address);
  };

  const critical: SafetySignal[] = [];
  const warnings: SafetySignal[] = [];
  const provenance: SafetySignal[] = [];

  for (const triple of triples) {
    // Collect asserting accounts: the creator plus everyone staking FOR.
    const authorAddresses = new Set<string>();
    if (triple.creator_id) {
      authorAddresses.add(triple.creator_id.toLowerCase());
    }
    for (const p of triple.positions || []) {
      if (p.account_id) {
        authorAddresses.add(p.account_id.toLowerCase());
      }
    }

    const predicateLabel = triple.predicate?.label || 'unknown';
    const objectLabel = triple.object?.label || 'unknown';

    // --- Provenance lane -----------------------------------------------------
    const provKey = provPredIdToKey.get(triple.predicate_id);
    if (provKey) {
      const provMeta = PROVENANCE_PREDICATES[provKey];
      if (!provMeta || !provMeta.entities.includes(entity)) {
        continue;
      }
      const authors = buildAuthors(
        authorAddresses,
        whitelistMap,
        trustMap,
        resolveLabel,
        normalizedUser,
        undefined,
        extendedIndex,
      );
      // Provenance signals are suppressed unless an author is in the publisher
      // whitelist, the user's trust circle, or (degree-2 enrichment) the
      // extended network.
      if (
        !authors.fromWhitelist &&
        !authors.fromTrustCircle &&
        !authors.fromExtendedNetwork
      ) {
        continue;
      }
      provenance.push({
        termId: triple.term_id,
        lane: 'provenance',
        predicateLabel,
        objectLabel: formatAddress(objectLabel),
        objectId: triple.object_id,
        attributedAuthors: authors.list,
        fromWhitelist: authors.fromWhitelist,
        fromTrustCircle: authors.fromTrustCircle,
        fromExtendedNetwork: authors.fromExtendedNetwork,
        critical: false,
      });
      continue;
    }

    // --- Hard lane (reported for) -------------------------------------------
    if (triple.predicate_id === reportedForId) {
      const hardKey = hardIdToKey.get(triple.object_id);
      if (!hardKey) {
        continue;
      }
      const meta = HARD_OBJECTS[hardKey];
      if (!meta || !meta.entities.includes(entity)) {
        continue;
      }

      const authors = buildAuthors(
        authorAddresses,
        whitelistMap,
        trustMap,
        resolveLabel,
        normalizedUser,
        hardKey,
        extendedIndex,
      );
      // Anonymous hard reports (author not in whitelist or trust circle) are
      // suppressed at sign-time. A degree-2 (extended-network) author NEVER
      // un-suppresses a hard report — a FoaF is not an authority — so it is
      // intentionally excluded from this gate.
      if (!authors.fromWhitelist && !authors.fromTrustCircle) {
        continue;
      }

      // A report is "critical" (danger banner) only when it comes from a
      // whitelisted authority. Degree-2 authors NEVER make a report critical.
      const isCritical = meta.critical && authors.fromWhitelist;
      const signal: SafetySignal = {
        termId: triple.term_id,
        lane: 'hard',
        predicateLabel,
        objectLabel,
        objectId: triple.object_id,
        attributedAuthors: authors.list,
        fromWhitelist: authors.fromWhitelist,
        fromTrustCircle: authors.fromTrustCircle,
        fromExtendedNetwork: authors.fromExtendedNetwork,
        critical: isCritical,
      };
      if (isCritical) {
        critical.push(signal);
      } else {
        warnings.push(signal);
      }
      continue;
    }

    // --- Soft lane (has tag -> safety object) -------------------------------
    if (triple.predicate_id === hasTagId) {
      const softKey = softIdToKey.get(triple.object_id);
      if (!softKey) {
        continue;
      }
      const softMeta = SOFT_OBJECTS[softKey];
      if (!softMeta || !softMeta.entities.includes(entity)) {
        continue;
      }

      const authors = buildAuthors(
        authorAddresses,
        whitelistMap,
        trustMap,
        resolveLabel,
        normalizedUser,
        undefined,
        extendedIndex,
      );
      // The soft lane is gated. 1-hop: an author in the trust circle. 2-hop: an
      // extended-network author with ≥ MIN_BRIDGES distinct bridges (computed in
      // buildAuthors). Both gates flip on together.
      if (!authors.fromTrustCircle && !authors.fromExtendedNetwork) {
        continue;
      }

      warnings.push({
        termId: triple.term_id,
        lane: 'soft',
        predicateLabel,
        objectLabel,
        objectId: triple.object_id,
        attributedAuthors: authors.list,
        fromWhitelist: authors.fromWhitelist,
        fromTrustCircle: authors.fromTrustCircle,
        fromExtendedNetwork: authors.fromExtendedNetwork,
        critical: false,
      });
    }
  }

  if (
    critical.length === 0 &&
    warnings.length === 0 &&
    provenance.length === 0
  ) {
    return undefined;
  }

  return { critical, warnings, provenance };
}

/**
 * Resolves the asserting accounts against the whitelist and trust circle.
 *
 * Both whitelisted authorities and trust-circle contacts are attributed by
 * their on-chain identity (ENS name, else truncated hex address) via
 * `resolveLabel` — never by a hard-coded authority title.
 *
 * @param authorAddresses - lowercased asserting addresses
 * @param whitelistMap - lowercased address -> Publisher
 * @param trustMap - lowercased address -> contact label
 * @param resolveLabel - resolves an address to its ENS/hex display label
 * @param normalizedUser - the current user's lowercased address (excluded)
 * @param category - optional hard-report category for scope filtering
 * @param extendedIndex - optional 2-hop index; an asserting account that is not
 * whitelisted and not in the 1-hop trust circle but is reachable via
 * ≥ MIN_BRIDGES distinct follows is recorded as a degree-2 author. Stake is
 * never read here — bridge count is the only 2-hop weight.
 */
function buildAuthors(
  authorAddresses: Set<string>,
  whitelistMap: Map<string, Publisher>,
  trustMap: Map<string, string>,
  resolveLabel: (address: string, fallback?: string) => string,
  normalizedUser: string | undefined,
  category?: string,
  extendedIndex?: ExtendedNetworkIndex | undefined,
): {
  list: SafetyAuthor[];
  fromWhitelist: boolean;
  fromTrustCircle: boolean;
  fromExtendedNetwork: boolean;
} {
  const byAddress = new Map<string, SafetyAuthor>();
  let fromWhitelist = false;
  let fromTrustCircle = false;
  let fromExtendedNetwork = false;

  for (const address of authorAddresses) {
    if (address === normalizedUser) {
      continue;
    }

    const publisher = whitelistMap.get(address);
    if (publisher && publisherCoversCategory(publisher, category)) {
      fromWhitelist = true;
      byAddress.set(address, {
        accountId: address,
        label: resolveLabel(address),
        source: 'authority',
        degree: 1,
      });
      continue;
    }

    const trustLabel = trustMap.get(address);
    if (trustLabel) {
      fromTrustCircle = true;
      if (!byAddress.has(address)) {
        byAddress.set(address, {
          accountId: address,
          label: resolveLabel(address, trustLabel),
          source: 'follow',
          degree: 1,
        });
      }
      continue;
    }

    // Degree-2: not whitelisted, not a direct follow, but reachable through the
    // viewer's follows. The extended index is keyed by canonical (checksummed)
    // address, so look it up by that — never a lowercased form. Only surfaces if
    // it has ≥ MIN_BRIDGES distinct bridges. `ext.accountId`/`ext.via` are already
    // canonical; `ext.label` carries the FoaF's ENS (or canonical hex) fallback.
    const canonical = toChecksum(address);
    const ext = canonical ? extendedIndex?.byAddress.get(canonical) : undefined;
    if (ext && ext.via.length >= MIN_BRIDGES) {
      fromExtendedNetwork = true;
      if (!byAddress.has(address)) {
        byAddress.set(address, {
          accountId: ext.accountId,
          label: resolveLabel(ext.accountId, ext.label),
          source: 'extended',
          degree: 2,
          via: ext.via,
        });
      }
    }
  }

  return {
    list: Array.from(byAddress.values()),
    fromWhitelist,
    fromTrustCircle,
    fromExtendedNetwork,
  };
}

/**
 * Whether a publisher's scopes cover the given report category.
 * No scopes (empty/undefined) means the authority covers all categories.
 * @param publisher
 * @param category
 */
function publisherCoversCategory(
  publisher: Publisher,
  category?: string,
): boolean {
  if (!category) {
    return true;
  }
  if (!publisher.scopes || publisher.scopes.length === 0) {
    return true;
  }
  return (publisher.scopes as string[]).includes(category);
}
