import type {
  ChainId,
  OnTransactionHandler,
  Transaction,
} from '@metamask/snaps-sdk';

import { getAccountData, getAccountType } from './account';
import { getClaimTemplates } from './claim-templates';
import {
  EXTENDED_NETWORK_ENABLED,
  PUBLIC_CLAIMS_ENABLED,
  PUBLIC_CLAIMS_TOP_N,
} from './config';
import {
  showsMoreInfoButton,
  buildPrimaryInsight,
  jsonClone,
  toInterfaceContext,
} from './insight-view';
import type { InsightModel } from './insight-view';
import { getOriginData, getOriginType } from './origin';
import { getPublicClaims, finalizePublicClaims } from './public-claims';
import type { PublicClaims } from './public-claims';
import { getPublisherWhitelist } from './publisher-whitelist';
import { getSafetyData } from './safety';
import type { SafetyData } from './safety';
import {
  getTrustedCircle,
  getNetworkFamiliarity,
  getExtendedNetwork,
  getSelfClaims,
  indexExtendedNetwork,
} from './trusted-circle';
import type { NetworkFamiliarity, SelfClaims } from './trusted-circle';
import type { AccountProps, OriginProps } from './types';
import { isSelfCall, shouldSuppressOrigin } from './util';

/**
 * Adds every familiarity-claim term_id (1-hop familiar contacts + 2-hop extended
 * contacts) into the cross-lane exclude set, so a claim already shown in the
 * network-familiarity lane is not re-shown by the public-claims escape hatch.
 *
 * @param familiarity - The subject's network familiarity, or undefined.
 * @param into - The exclude set to populate (mutated in place).
 */
function collectClaimTermIds(
  familiarity: NetworkFamiliarity | undefined,
  into: Set<string>,
): void {
  if (!familiarity) {
    return;
  }
  const contacts = [
    ...familiarity.familiarContacts,
    ...(familiarity.extendedContacts ?? []),
  ];
  for (const contact of contacts) {
    for (const claim of contact.claims) {
      if (claim.termId) {
        into.add(claim.termId);
      }
    }
  }
}

/**
 * Adds every self-claim term_id (the viewer's own staked claims) into the
 * cross-lane exclude set, so a claim already shown in the "Your take" lane is
 * not re-shown by the public-claims escape hatch.
 *
 * @param selfClaims - The viewer's own claims about the subject, or undefined.
 * @param into - The exclude set to populate (mutated in place).
 */
function collectSelfTermIds(
  selfClaims: SelfClaims | undefined,
  into: Set<string>,
): void {
  if (!selfClaims) {
    return;
  }
  for (const claim of selfClaims.claims) {
    if (claim.termId) {
      into.add(claim.termId);
    }
  }
}

export const onTransaction: OnTransactionHandler = async ({
  transaction,
  chainId,
  transactionOrigin,
}: {
  transaction: Transaction;
  chainId: ChainId;
  transactionOrigin?: string;
}) => {
  // "to" ENS addresses arrive here as EVM addresses, EVM addresses arrive as EVM addresses
  const userAddress: string | undefined = transaction.from;

  // Self-call detection: when the destination is the user's own account the
  // transaction is a smart-account batch (EIP-5792 / ERC-7821) whose real
  // counterparties live inside the calldata, not in `to`. Vetting the user's own
  // address is semantically meaningless, so the destination surface is
  // suppressed entirely (mirrors `suppressOrigin`).
  const suppressAccount = isSelfCall(transaction.to, userAddress);

  const [
    accountData,
    originData,
    trustedCircle,
    claimTemplates,
    publisherWhitelist,
  ] = await Promise.all([
    getAccountData(transaction, chainId, userAddress),
    getOriginData(transactionOrigin),
    userAddress ? getTrustedCircle(userAddress) : Promise.resolve([]),
    // Claim-template registry: predicate/object term IDs the safety read
    // surface resolves against. Falls back to chainConfig constants internally.
    getClaimTemplates(),
    // Publisher whitelist: authority accounts whose hard reports surface
    // globally. Falls back to an empty whitelist internally.
    getPublisherWhitelist(),
  ]);

  const accountType = getAccountType(accountData);
  const originType = getOriginType(originData, transactionOrigin);

  // Derive the 2-hop "extended network" off the resolved 1-hop circle (cached;
  // one batched round-trip on cold start, ~0 in steady state). Seeds are the
  // viewer's follows ONLY — never the whitelist. Gated by EXTENDED_NETWORK_ENABLED.
  const extendedNetwork =
    EXTENDED_NETWORK_ENABLED && userAddress && trustedCircle.length > 0
      ? await getExtendedNetwork(userAddress, trustedCircle)
      : { contacts: [] };
  const extendedIndex = indexExtendedNetwork(extendedNetwork);

  // Whether the dApp-origin surface is suppressed (no origin, MetaMask, or a
  // localhost/dev URL). Computed here so origin safety/familiarity work can be
  // skipped entirely when there is nothing to show. Hoisted above the lane work
  // so the origin phase can run concurrently with the account phase.
  const suppressOrigin = shouldSuppressOrigin(
    transactionOrigin,
    originData.hostname,
  );

  // Public-claims (escape-hatch) lane: fire BOTH fetches now, BEFORE the
  // safety/familiarity/self lanes, so their round-trips overlap all of that
  // work. The fetch is dependency-free (no cross-lane exclusion) — the dedup +
  // sort + top-N happens after every lane resolves via finalizePublicClaims.
  // Gated by PUBLIC_CLAIMS_ENABLED + atom presence + the per-subject suppress
  // flag. `undefined` promises resolve to `undefined` (no lane).
  const accountPublicPromise: Promise<PublicClaims | undefined> =
    PUBLIC_CLAIMS_ENABLED && accountData.account && !suppressAccount
      ? getPublicClaims(accountData.account.term_id, claimTemplates)
      : Promise.resolve(undefined);
  const originPublicPromise: Promise<PublicClaims | undefined> =
    PUBLIC_CLAIMS_ENABLED && originData.origin && !suppressOrigin
      ? getPublicClaims(originData.origin.term_id, claimTemplates)
      : Promise.resolve(undefined);

  // The account and origin lanes share no data, so run them concurrently. WITHIN
  // each phase, safety MUST resolve first because its surfaced term_ids feed the
  // familiarity escape-hatch + the familiarity/self dedup; familiarity and self
  // are mutually independent, so they run in parallel after safety.
  const [accountLane, originLane] = await Promise.all([
    (async () => {
      // Safety read surface FIRST (critical reports, soft flags, provenance).
      let safety: SafetyData | undefined;
      if (accountData.account && !suppressAccount) {
        safety = await getSafetyData(accountData.account.term_id, {
          registry: claimTemplates,
          trustedCircle,
          whitelist: publisherWhitelist,
          userAddress,
          isContract: accountData.isContract,
          extendedIndex: EXTENDED_NETWORK_ENABLED ? extendedIndex : undefined,
        });
      }

      // Triple term_ids already surfaced by the safety lane (critical + warnings
      // + provenance) — excluded from familiarity/self so each claim has one home.
      const termIds = new Set<string>();
      if (safety) {
        for (const signal of [
          ...safety.critical,
          ...safety.warnings,
          ...safety.provenance,
        ]) {
          termIds.add(signal.termId);
        }
      }

      const [familiarity, selfClaims] = await Promise.all([
        // Network familiarity (trusted contacts with ANY claim about this
        // address). `has tag → trustworthy` surfaces here as a regular claim.
        trustedCircle.length > 0 && accountData.account && !suppressAccount
          ? getNetworkFamiliarity(
              accountData.account.term_id,
              trustedCircle,
              new Set<string>(),
              userAddress,
              EXTENDED_NETWORK_ENABLED ? extendedIndex : undefined,
              termIds,
              claimTemplates,
            )
          : Promise.resolve(undefined),
        // The viewer's OWN staked claims ("Your take") — always surfaced back to
        // the viewer, independent of the trusted circle.
        userAddress && accountData.account && !suppressAccount
          ? getSelfClaims(
              accountData.account.term_id,
              userAddress,
              termIds,
              claimTemplates,
            )
          : Promise.resolve(undefined),
      ]);

      return { safety, termIds, familiarity, selfClaims };
    })(),
    (async () => {
      // Origin (dApp) safety read surface — same pipeline as the address, scoped
      // to the URL/site claim vocabulary (entity 'site').
      let safety: SafetyData | undefined;
      if (originData.origin && !suppressOrigin) {
        safety = await getSafetyData(originData.origin.term_id, {
          registry: claimTemplates,
          trustedCircle,
          whitelist: publisherWhitelist,
          userAddress,
          entity: 'site',
          extendedIndex: EXTENDED_NETWORK_ENABLED ? extendedIndex : undefined,
        });
      }

      const termIds = new Set<string>();
      if (safety) {
        for (const signal of [
          ...safety.critical,
          ...safety.warnings,
          ...safety.provenance,
        ]) {
          termIds.add(signal.termId);
        }
      }

      const [familiarity, selfClaims] = await Promise.all([
        // Origin familiarity — trusted contacts (1-hop + 2-hop) with ANY claim
        // about the dApp atom, with the safety-surfaced claims excluded.
        trustedCircle.length > 0 && originData.origin && !suppressOrigin
          ? getNetworkFamiliarity(
              originData.origin.term_id,
              trustedCircle,
              new Set<string>(),
              userAddress,
              EXTENDED_NETWORK_ENABLED ? extendedIndex : undefined,
              termIds,
              claimTemplates,
            )
          : Promise.resolve(undefined),
        // The viewer's OWN staked claims about the dApp origin ("Your take").
        userAddress && originData.origin && !suppressOrigin
          ? getSelfClaims(
              originData.origin.term_id,
              userAddress,
              termIds,
              claimTemplates,
            )
          : Promise.resolve(undefined),
      ]);

      return { safety, termIds, familiarity, selfClaims };
    })(),
  ]);

  const accountSafety = accountLane.safety;
  const safetyTermIds = accountLane.termIds;
  const accountNetworkFamiliarity = accountLane.familiarity;
  const accountSelfClaims = accountLane.selfClaims;

  const originSafety = originLane.safety;
  const originSafetyTermIds = originLane.termIds;
  const originNetworkFamiliarity = originLane.familiarity;
  const originSelfClaims = originLane.selfClaims;

  // Resolve the public-claims fetches now that the other lanes are done. Build
  // each subject's cross-lane exclude set — "claims you haven't seen" = every
  // term_id already surfaced by the safety, familiarity (1-hop + 2-hop), and self
  // lanes for that subject — then finalize (exclude + sort by stake + top-N).
  const [accountPublicRaw, originPublicRaw] = await Promise.all([
    accountPublicPromise,
    originPublicPromise,
  ]);

  const accountExclude = new Set<string>(safetyTermIds);
  collectClaimTermIds(accountNetworkFamiliarity, accountExclude);
  collectSelfTermIds(accountSelfClaims, accountExclude);

  const originExclude = new Set<string>(originSafetyTermIds);
  collectClaimTermIds(originNetworkFamiliarity, originExclude);
  collectSelfTermIds(originSelfClaims, originExclude);

  const accountPublicClaims = finalizePublicClaims(
    accountPublicRaw,
    accountExclude,
    PUBLIC_CLAIMS_TOP_N,
  );
  const originPublicClaims = finalizePublicClaims(
    originPublicRaw,
    originExclude,
    PUBLIC_CLAIMS_TOP_N,
  );

  // Create properly typed props based on account type
  const accountProps: AccountProps = {
    ...accountData,
    accountType,
    address: transaction.to,
    userAddress,
    chainId,
    transactionOrigin,
    // The account-level "Your Trust Circle" FOR/AGAINST block (driven by the
    // `has tag → trustworthy` triple) is no longer surfaced; that signal now
    // flows through network familiarity as a regular claim. `trustedCircle` is
    // intentionally omitted here (optional on AccountProps).
    networkFamiliarity: accountNetworkFamiliarity,
    safety: accountSafety,
  } as AccountProps; // Type assertion needed due to the discriminated union

  // Create origin props
  const originProps: OriginProps = {
    ...originData,
    originType,
    originUrl: transactionOrigin,
  } as OriginProps; // Type assertion needed due to the discriminated union

  // Build the serializable model that drives both the primary insight and the
  // interactive "More info" page. The nested `safety`/`networkFamiliarity` on
  // `accountProps` are dropped first (the model carries each payload exactly
  // once); JSON-cloning then guarantees a plain `Json` structure (drops
  // `undefined`/functions/Sets/Maps) before it enters the interface context.
  const {
    safety: _droppedSafety,
    networkFamiliarity: _droppedFamiliarity,
    ...footerAccountProps
  } = accountProps;
  const model: InsightModel = jsonClone({
    safety: accountSafety ?? null,
    familiarity: accountNetworkFamiliarity ?? null,
    selfClaims: accountSelfClaims ?? null,
    originSafety: originSafety ?? null,
    originFamiliarity: originNetworkFamiliarity ?? null,
    originSelfClaims: originSelfClaims ?? null,
    publicClaims: accountPublicClaims,
    originPublicClaims,
    accountProps: footerAccountProps as AccountProps,
    originProps,
    suppressOrigin,
    suppressAccount,
  });

  // An interactive interface is only needed when a "More info" button renders —
  // i.e. the primary tier has content AND there is additional content behind it.
  // When the primary tier is empty the more-info content is promoted inline, and
  // a truly empty panel shows the static notice; both return static content.
  if (showsMoreInfoButton(model)) {
    const id = await snap.request({
      method: 'snap_createInterface',
      params: {
        ui: buildPrimaryInsight(model),
        context: toInterfaceContext(model),
      },
    });
    return { id };
  }

  return { content: buildPrimaryInsight(model) };
};
