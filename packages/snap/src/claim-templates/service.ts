/**
 * Claim-template registry service.
 *
 * Provides getClaimTemplates() which checks the local cache first, fetches
 * from the Hive Mind API on miss, and falls back to a registry derived from
 * the snap's hardcoded chainConfig term IDs on any failure.
 *
 * The snap's primary consumption is the predicate/object term-ID maps, used
 * by the read surface to resolve safety predicates without hardcoding. The
 * hardcoded values in chainConfig serve only as the offline fallback.
 *
 * @module claim-templates/service
 */

import {
  chainConfig,
  SAFETY_PREDICATE_IDS,
  SAFETY_OBJECT_IDS,
  BLACKLISTED_TERM_IDS,
  FAMILIARITY_VOCAB,
} from '../config';
import { getClaimTemplatesCache, setClaimTemplatesCache } from './cache';
import type { ClaimTemplateRegistry, FamiliarityVocabEntry } from './types';

/**
 * Offline fallback registry. Carries the safety + provenance vocabulary the
 * read surface needs (reported for, malicious, suspicious, phishing, …) sourced
 * from the chain-independent constants in `config.ts`, so the safety surface
 * still works when the API is unreachable. The live registry from the API
 * supersedes this whenever it's available.
 */
function buildDefaults(): ClaimTemplateRegistry {
  return {
    version: 0,
    predicates: {
      ...SAFETY_PREDICATE_IDS,
      hasTag: chainConfig.hasTagAtomId,
    },
    objects: {
      ...SAFETY_OBJECT_IDS,
      trustworthy: chainConfig.trustworthyAtomId,
    },
    blacklistedTermIds: [...BLACKLISTED_TERM_IDS],
    familiarityVocab: FAMILIARITY_VOCAB.map(
      (entry): FamiliarityVocabEntry => ({ ...entry }),
    ),
    templates: [],
  };
}

/**
 * Retrieves the current claim-template registry.
 *
 * Resolution order:
 * 1. Local cache (snap_manageState) if within TTL
 * 2. Fresh fetch from the Hive Mind API
 * 3. Fallback derived from chainConfig term IDs
 */
export async function getClaimTemplates(): Promise<ClaimTemplateRegistry> {
  const cached = await getClaimTemplatesCache();
  if (cached) {
    return cached;
  }

  try {
    const url = `${chainConfig.hivemindApiUrl}/atoms/claim-templates`;
    const response = await fetch(url);

    if (!response.ok) {
      return buildDefaults();
    }

    const registry = (await response.json()) as ClaimTemplateRegistry;
    await setClaimTemplatesCache(registry);
    return registry;
  } catch {
    return buildDefaults();
  }
}
