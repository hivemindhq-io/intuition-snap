/**
 * Types for the remote structured claim-template registry.
 *
 * The snap fetches this from the Hive Mind API (`GET /atoms/claim-templates`)
 * and caches it via snap_manageState. Today the snap consumes the
 * predicate/object term-ID maps so its read surface can resolve safety
 * predicates (`reported for`, `malicious`, `suspicious`, …) without
 * hardcoding term IDs. The structured `templates` are carried through for
 * future use (e.g. surfacing creatable claims).
 *
 * @module claim-templates/types
 */

export type ClaimSlot = {
  type: 'detected' | 'fixed' | 'user-input';
  atomRef?: string;
  label?: string;
  inputType?: 'text' | 'search';
  placeholder?: string;
  inputLabel?: string;
  schemaType?: string;
};

export type ClaimTemplate = {
  id: string;
  label: string;
  description: string;
  icon: string;
  iconColor?: string;
  disabled?: boolean;
  disabledReason?: string;
  subject: ClaimSlot;
  predicate: ClaimSlot;
  object: ClaimSlot;
};

export type ClaimTemplateMapping = {
  id: string;
  name: string;
  match: {
    entityType?: string;
    addressKind?: string;
    labelPatterns?: string[];
  };
  potentialTriples: ClaimTemplate[];
};

/** Placement tier for a whitelisted familiarity claim. */
export type FamiliarityTier = 'primary' | 'secondary';

/**
 * A single allowed entry on the familiarity read surface. The familiarity surface
 * is default-deny: only claims whose (predicate, object) pair matches an entry
 * here render. `predicate`/`object` reference the named keys in the registry's
 * `predicates`/`objects` maps; `object: "*"` matches any object for a
 * self-describing predicate (e.g. `vouchFor`). `tier` is the placement ceiling
 * (`primary` = inline-eligible at 1-hop; `secondary` = always demoted to More info).
 */
export type FamiliarityVocabEntry = {
  predicate: string;
  object: string;
  tier: FamiliarityTier;
};

/** Shape returned by GET /atoms/claim-templates on the Hive Mind API. */
export type ClaimTemplateRegistry = {
  version: number;
  /** Named predicate term IDs (e.g. { reportedFor: "0x…" }). */
  predicates: Record<string, string>;
  /** Named object term IDs (e.g. { malicious: "0x…", suspicious: "0x…" }). */
  objects: Record<string, string>;
  /**
   * Term IDs suppressed from the read surface (non-canonical / duplicate atoms).
   * Optional so older cached payloads that predate the field still type-check;
   * consumers union it with the local offline seed in `config.ts`.
   */
  blacklistedTermIds?: string[];
  /**
   * Default-deny allowlist for the familiarity read surface (NOT safety).
   * Optional so older cached payloads still type-check; consumers union it with
   * the local offline seed (`FAMILIARITY_VOCAB`) in `config.ts`.
   */
  familiarityVocab?: FamiliarityVocabEntry[];
  templates: ClaimTemplateMapping[];
};

/** Wrapper stored in snap_manageState with a timestamp for TTL validation. */
export type CachedClaimTemplates = {
  registry: ClaimTemplateRegistry;
  /** Unix timestamp (ms) when this cache entry was written. */
  timestamp: number;
};
