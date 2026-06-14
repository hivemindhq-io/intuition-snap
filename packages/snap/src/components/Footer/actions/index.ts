/**
 * Footer action components.
 *
 * Model A (one link per subject) is driven by the consolidated single-link
 * actions:
 * - {@link AddressAction} - one link for the destination address.
 * - {@link SiteAction} - one link for the dApp origin (site).
 *
 * The legacy per-state self-gating components (CreateTrustTriple, StakePrompt,
 * CreateAlias, ViewMore) are retained for the standalone {@link Footer} (used by
 * non-insight surfaces) but are no longer used by the unified insight footer.
 */
export { AddressAction } from './AddressAction';
export { SiteAction } from './SiteActions';
export { CreateTrustTriple } from './CreateTrustTriple';
export { StakePrompt } from './StakePrompt';
export { CreateAlias } from './CreateAlias';
export { ViewMore } from './ViewMore';
