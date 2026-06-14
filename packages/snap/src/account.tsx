import type { ChainId, Transaction } from '@metamask/snaps-sdk';

import { classifyBytecode } from './bytecode';
import { type ChainConfig, chainConfig } from './config';
import {
  getListWithHighestStakeQuery,
  getTripleWithPositionsDataQuery,
  graphQLQuery,
  getAddressAtomsQuery,
} from './queries';
import { sumMarketCap } from './term-stats';
import {
  AccountType,
  type Account,
  type TripleWithPositions,
  type AddressClassification,
  type ClassificationFailureReason,
  type AlternateTrustData,
} from './types';
import { addressToCaip10 } from './util';

export type GetAccountDataResult = {
  account: Account | null;
  triple: TripleWithPositions | null;
  isContract: boolean;
  alias: string | null;
  classification: AddressClassification;
  alternateTrustData: AlternateTrustData;
};

/**
 * Timeout for the contract-status API proxy call. The Snap blocks the
 * onTransaction UI on classification, so keep this tight.
 */
const CONTRACT_STATUS_API_TIMEOUT_MS = 4000;

/**
 * Timeout for provider RPC calls (`wallet_switchEthereumChain` + `eth_getCode`)
 * and the direct Intuition `eth_getCode` fallback. `onTransaction` blocks the
 * insight panel on classification, so a hung/slow RPC must not stall the UI.
 */
const PROVIDER_RPC_TIMEOUT_MS = 4000;

/** Prefix for all classification console logs so they're easy to filter. */
const LOG = '[hivemind:isContract]';

/**
 * Sentinel thrown by {@link withTimeout} when the wrapped promise doesn't settle
 * in time. Lets callers distinguish a timeout from a genuine RPC error.
 */
export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Races a promise against a timeout. The underlying provider call cannot be
 * aborted (the `ethereum` provider has no abort signal), so on timeout we stop
 * waiting and let the in-flight request resolve into the void — the classifier
 * degrades to a fallback path rather than blocking the insight UI indefinitely.
 *
 * @param promise - The promise to guard.
 * @param timeoutMs - Max time to wait before rejecting with {@link TimeoutError}.
 * @returns The resolved value, or rejects with {@link TimeoutError} on timeout.
 */
export const withTimeout = async <Value,>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    // @ts-expect-error - assigned synchronously inside the Promise executor.
    clearTimeout(timer);
  }
};

/**
 * Parses a CAIP-2 chain id (e.g. `eip155:1`, `solana:5eykt4...`) into its
 * namespace + reference. Returns `null` for malformed input.
 *
 * @param chainId - The CAIP-2 chain id from `onTransaction`.
 * @returns The `{ namespace, reference }` pair, or null if unparseable.
 */
export const parseCaip2 = (
  chainId: string,
): { namespace: string; reference: string } | null => {
  const [namespace, reference] = chainId.split(':');
  if (!namespace || !reference) {
    return null;
  }
  return { namespace, reference };
};

/**
 * The `0x`-prefixed hex chain id MetaMask expects for
 * `wallet_switchEthereumChain`, derived from a CAIP-2 `eip155:<decimal>` id.
 * Returns `null` for non-eip155 (non-EVM) namespaces or malformed input.
 *
 * @param chainId - The CAIP-2 chain id from `onTransaction`.
 * @returns The hex chain id (e.g. `0x1`), or null when not EVM.
 */
export const caip2ToHexChainId = (chainId: string): string | null => {
  const parsed = parseCaip2(chainId);
  if (!parsed || parsed.namespace !== 'eip155') {
    return null;
  }
  const asNumber = Number(parsed.reference);
  if (!Number.isInteger(asNumber) || asNumber <= 0) {
    return null;
  }
  return `0x${asNumber.toString(16)}`;
};

/**
 * Result of attempting classification on the transaction's actual chain.
 */
type TxChainClassification =
  | { ok: true; isContract: boolean }
  | { ok: false; reason: ClassificationFailureReason };

/**
 * Classifies `destinationAddress` on the transaction's ACTUAL chain.
 *
 * Uses the `ethereum` provider global (requires `endowment:ethereum-provider`):
 * switches the Snap's own network context to the tx chain via
 * `wallet_switchEthereumChain` (auto-approved for Snaps), then reads
 * `eth_getCode` and applies the canonical {@link classifyBytecode} rule. The
 * Snap's network switch is isolated per-origin and does NOT change the user's
 * globally-selected wallet network.
 *
 * Works for ANY EVM chain the user has added to MetaMask (custom chains
 * included).
 *
 * @param destinationAddress - The transaction destination address.
 * @param hexChainId - The `0x`-prefixed hex chain id to switch to.
 * @returns `{ ok: true, isContract }` on a definite verdict, or
 * `{ ok: false, reason }` when the chain isn't added or an RPC error occurred.
 */
const classifyOnTxChain = async (
  destinationAddress: string,
  hexChainId: string,
): Promise<TxChainClassification> => {
  // `ethereum` is only defined when the endowment is granted. Guard so a
  // missing endowment degrades gracefully to the fallback path.
  if (typeof ethereum === 'undefined') {
    console.log(`${LOG} ethereum provider unavailable (endowment missing)`);
    return { ok: false, reason: 'eth_getCode_failed' };
  }

  try {
    await withTimeout(
      ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hexChainId }],
      }),
      PROVIDER_RPC_TIMEOUT_MS,
    );
  } catch (error) {
    // 4902 = chain not added to MetaMask. Any switch failure (or timeout) means
    // we cannot read code on the tx chain; surface as "couldn't verify on this
    // network".
    console.log(
      `${LOG} wallet_switchEthereumChain failed for ${hexChainId} — chain likely not added (or timed out)`,
      error,
    );
    return { ok: false, reason: 'chain_not_added' };
  }

  try {
    const code = await withTimeout(
      ethereum.request<string>({
        method: 'eth_getCode',
        params: [destinationAddress, 'latest'],
      }),
      PROVIDER_RPC_TIMEOUT_MS,
    );
    const isContract = classifyBytecode(code ?? '0x');
    console.log(
      `${LOG} tx-chain eth_getCode on ${hexChainId}: codeLen=${
        (code ?? '0x').length
      } -> ${isContract ? 'contract' : 'eoa'}`,
    );
    return { ok: true, isContract };
  } catch (error) {
    console.log(
      `${LOG} tx-chain eth_getCode failed (or timed out) on ${hexChainId}`,
      error,
    );
    return { ok: false, reason: 'eth_getCode_failed' };
  }
};

/**
 * Multi-chain contract-status check via the Hive Mind API proxy.
 *
 * The proxy fans out `eth_getCode` across Ethereum / Base / Intuition (Alchemy
 * for ETH/Base, keys stay server-side) and applies the canonical classification
 * rule (7702 + smart-account aware). Returns `true` for a real contract on at
 * least one chain, `false` for EOA / 7702 / smart-account on all answered
 * chains, or `null` when the API is unreachable / every chain RPC failed.
 *
 * @param destinationAddress - The transaction destination address.
 * @returns The contract status, or null when undecided.
 */
const fetchContractStatusFromApi = async (
  destinationAddress: string,
): Promise<boolean | null> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    CONTRACT_STATUS_API_TIMEOUT_MS,
  );

  try {
    const url = `${chainConfig.hivemindApiUrl}/addresses/${destinationAddress}/contract-status`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      isContract: boolean | null;
      contractChainId: number | null;
    };

    console.log(
      `${LOG} api contract-status: isContract=${String(
        data.isContract,
      )} chain=${String(data.contractChainId)}`,
    );
    return data.isContract;
  } catch (error) {
    console.log(`${LOG} api contract-status failed`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Classifies an address as EOA, contract, or unknown, tracking certainty.
 *
 * Resolution order (first definite verdict wins):
 * 1. Non-empty calldata: definite contract (a contract call).
 * 2. Non-EVM tx chain: uncertain (`non_evm`); eth_getCode doesn't apply.
 * 3. Tx chain's own RPC: `wallet_switchEthereumChain` + `eth_getCode` on the
 * transaction's ACTUAL chain (works for any user-added custom chain).
 * 4. Hive Mind API proxy: multi-chain contract-status (ETH/Base/Intuition).
 *
 * When the tx chain isn't added to MetaMask we cannot switch to it; we still
 * try the API fallback, but if it also can't decide we preserve the
 * `chain_not_added` reason so the UI can message accurately rather than
 * overclaiming. The transaction's chain is irrelevant for trust lookups — those
 * always resolve against the configured Intuition chain where trust data lives.
 *
 * @param destinationAddress - The transaction destination address.
 * @param transactionData - The transaction calldata (`0x` when empty).
 * @param chainId - The transaction's CAIP-2 chain id (e.g. `eip155:1`).
 * @returns The address classification with certainty + source/reason.
 */
export const classifyAddress = async (
  destinationAddress: string,
  transactionData: string,
  chainId: string,
): Promise<AddressClassification> => {
  console.log(
    `${LOG} classify start: to=${destinationAddress} chain=${chainId} hasCalldata=${
      transactionData !== '0x'
    }`,
  );

  // 1. Calldata is the strongest signal — a contract call, full stop.
  if (transactionData !== '0x') {
    console.log(`${LOG} verdict=contract source=calldata`);
    return { type: 'contract', certainty: 'definite', source: 'calldata' };
  }

  // 2. Non-EVM chains (Solana, etc.): eth_getCode is meaningless. Never claim a
  // contract/EOA verdict — surface a neutral "couldn't verify" instead.
  const hexChainId = caip2ToHexChainId(chainId);
  if (!hexChainId) {
    console.log(`${LOG} verdict=uncertain reason=non_evm (chain=${chainId})`);
    return { type: 'unknown', certainty: 'uncertain', reason: 'non_evm' };
  }

  // 3. Classify on the transaction's ACTUAL chain via the ethereum provider.
  const txChainResult = await classifyOnTxChain(destinationAddress, hexChainId);
  if (txChainResult.ok) {
    console.log(
      `${LOG} verdict=${
        txChainResult.isContract ? 'contract' : 'eoa'
      } source=tx_chain`,
    );
    return txChainResult.isContract
      ? { type: 'contract', certainty: 'definite', source: 'tx_chain' }
      : { type: 'eoa', certainty: 'definite', source: 'tx_chain' };
  }

  // Remember why the tx-chain path couldn't decide so we can preserve an
  // accurate reason if every fallback also fails to produce a verdict.
  const txChainFailReason: ClassificationFailureReason = txChainResult.reason;

  // 4. Hive Mind API multi-chain proxy (ETH/Base/Intuition).
  const apiResult = await fetchContractStatusFromApi(destinationAddress);
  if (apiResult === true) {
    console.log(`${LOG} verdict=contract source=api`);
    return { type: 'contract', certainty: 'definite', source: 'api' };
  }
  if (apiResult === false) {
    console.log(`${LOG} verdict=eoa source=api`);
    return { type: 'eoa', certainty: 'definite', source: 'api' };
  }

  // Nothing could decide. Preserve the most informative reason: if the tx chain
  // simply wasn't added, that's the actionable message ("add the network");
  // otherwise report a generic verification failure.
  console.log(
    `${LOG} verdict=uncertain reason=${txChainFailReason} (all paths exhausted)`,
  );
  return {
    type: 'unknown',
    certainty: 'uncertain',
    reason: txChainFailReason,
  };
};

/**
 * Calculates the total market cap of a trust triple (support + counter)
 * by summing across ALL curves on each side. Returns 0n if triple is null
 * or has no vault data.
 *
 * See `term-stats.ts` for why we aggregate across curves instead of reading
 * `vaults[0]` (curve_id=1).
 * @param triple
 */
const getTrustMarketCap = (triple: TripleWithPositions | null): bigint => {
  if (!triple) {
    return 0n;
  }
  const supportCap = BigInt(sumMarketCap(triple.term?.vaults));
  const counterCap = BigInt(sumMarketCap(triple.counter_term?.vaults));
  return supportCap + counterCap;
};

/**
 * Selects the primary atom based on classification and trust signal.
 * For uncertain classifications, uses whichever format has higher trust stake.
 * @param classification
 * @param plainAtom
 * @param caipAtom
 * @param plainTrustTriple
 * @param caipTrustTriple
 */
const selectPrimaryAtom = (
  classification: AddressClassification,
  plainAtom: Account | null,
  caipAtom: Account | null,
  plainTrustTriple: TripleWithPositions | null,
  caipTrustTriple: TripleWithPositions | null,
): {
  primary: Account | null;
  primaryTriple: TripleWithPositions | null;
  alternate: Account | null;
  alternateTriple: TripleWithPositions | null;
  usedCaip: boolean;
} => {
  // Neither exists
  if (!caipAtom && !plainAtom) {
    return {
      primary: null,
      primaryTriple: null,
      alternate: null,
      alternateTriple: null,
      usedCaip: false,
    };
  }

  // Only one format exists
  if (!caipAtom) {
    return {
      primary: plainAtom,
      primaryTriple: plainTrustTriple,
      alternate: null,
      alternateTriple: null,
      usedCaip: false,
    };
  }
  if (!plainAtom) {
    return {
      primary: caipAtom,
      primaryTriple: caipTrustTriple,
      alternate: null,
      alternateTriple: null,
      usedCaip: true,
    };
  }

  // Both exist - selection depends on classification
  if (classification.certainty === 'definite') {
    if (classification.type === 'contract') {
      // Definite contract: use CAIP as primary
      return {
        primary: caipAtom,
        primaryTriple: caipTrustTriple,
        alternate: plainAtom,
        alternateTriple: plainTrustTriple,
        usedCaip: true,
      };
    }
    // Definite EOA: use plain as primary
    return {
      primary: plainAtom,
      primaryTriple: plainTrustTriple,
      alternate: caipAtom,
      alternateTriple: caipTrustTriple,
      usedCaip: false,
    };
  }

  // Uncertain classification: compare trust signal, use higher market cap
  const caipMarketCap = getTrustMarketCap(caipTrustTriple);
  const plainMarketCap = getTrustMarketCap(plainTrustTriple);

  if (caipMarketCap >= plainMarketCap) {
    return {
      primary: caipAtom,
      primaryTriple: caipTrustTriple,
      alternate: plainAtom,
      alternateTriple: plainTrustTriple,
      usedCaip: true,
    };
  }
  return {
    primary: plainAtom,
    primaryTriple: plainTrustTriple,
    alternate: caipAtom,
    alternateTriple: caipTrustTriple,
    usedCaip: false,
  };
};

export const getAccountData = async (
  transaction: Transaction,
  chainId: ChainId,
  userAddress?: string,
): Promise<GetAccountDataResult> => {
  const { to: destinationAddress, data: transactionData } = transaction;
  const caipAddress = addressToCaip10(destinationAddress, chainId);

  // Step 1: Classification and the atom lookup are independent — classification
  // only feeds `isContract` + `selectPrimaryAtom`, neither of which the atom
  // query needs. Fire both together so the classification RPC round-trip
  // (provider switch + eth_getCode, possibly the API) overlaps the GraphQL atom
  // fetch instead of blocking it. (The provider network switch is HTTP-isolated
  // from the GraphQL endpoint, so concurrency is safe.)
  try {
    const [classification, atomsResponse] = await Promise.all([
      classifyAddress(destinationAddress, transactionData, chainId),
      graphQLQuery(getAddressAtomsQuery, {
        plainAddress: destinationAddress,
        caipAddress,
      }),
    ]);

    // Derive isContract from classification (for downstream safety/atom logic).
    // A definite contract is a contract. For UNCERTAIN cases we default to
    // contract EXCEPT non-EVM, where "contract" is meaningless — there we
    // default to false so we don't imply an EVM contract verdict on e.g. Solana.
    const isContract =
      classification.type === 'contract' ||
      (classification.certainty === 'uncertain' &&
        classification.reason !== 'non_evm');
    console.log(`${LOG} derived isContract=${isContract}`);

    const { plainAtoms, caipAtoms } = atomsResponse.data;
    const plainAtom = plainAtoms?.[0] as Account | undefined;
    const caipAtom = caipAtoms?.[0] as Account | undefined;

    // If neither atom exists, return early
    if (!plainAtom && !caipAtom) {
      return {
        account: null,
        triple: null,
        isContract,
        alias: null,
        classification,
        alternateTrustData: { hasAlternateTrustData: false },
      };
    }

    // Step 3: Query trust triples for BOTH atom formats (if they exist)
    const { hasTagAtomId, trustworthyAtomId, hasAliasAtomId } =
      chainConfig as ChainConfig;

    // Build parallel queries for trust data
    const trustQueries: Promise<any>[] = [];
    const queryKeys: ('plain' | 'caip')[] = [];

    // Use empty string if userAddress is undefined (GraphQL will match nothing)
    const userAddressParam = userAddress || '';

    if (plainAtom) {
      trustQueries.push(
        graphQLQuery(getTripleWithPositionsDataQuery, {
          subjectId: plainAtom.term_id,
          predicateId: hasTagAtomId,
          objectId: trustworthyAtomId,
          userAddress: userAddressParam,
        }),
      );
      queryKeys.push('plain');
    }

    if (caipAtom) {
      trustQueries.push(
        graphQLQuery(getTripleWithPositionsDataQuery, {
          subjectId: caipAtom.term_id,
          predicateId: hasTagAtomId,
          objectId: trustworthyAtomId,
          userAddress: userAddressParam,
        }),
      );
      queryKeys.push('caip');
    }

    const trustResponses = await Promise.all(trustQueries);

    // Map responses back to their keys
    const trustResults: {
      plain?: TripleWithPositions;
      caip?: TripleWithPositions;
    } = {};
    queryKeys.forEach((key, idx) => {
      trustResults[key] = trustResponses[idx].data.triples[0] || null;
    });

    // Step 4: Select primary atom based on classification and trust signal
    const selection = selectPrimaryAtom(
      classification,
      plainAtom || null,
      caipAtom || null,
      trustResults.plain || null,
      trustResults.caip || null,
    );

    // Step 5: Check if alternate has significant trust data
    const alternateMarketCap = getTrustMarketCap(selection.alternateTriple);
    const alternateTrustData: AlternateTrustData = {
      hasAlternateTrustData: alternateMarketCap > 0n,
      alternateAtomId: selection.alternate?.term_id,
      alternateMarketCap: alternateMarketCap.toString(),
      alternateIsCaip: !selection.usedCaip, // If we used CAIP, alternate is plain (and vice versa)
    };

    // Step 6: Query alias for the primary atom
    let alias: string | null = null;
    if (selection.primary) {
      const aliasResponse = await graphQLQuery(getListWithHighestStakeQuery, {
        subjectId: selection.primary.term_id,
        predicateId: hasAliasAtomId,
      });
      const aliasTriple = aliasResponse.data.triples[0];
      alias = aliasTriple?.object?.label || null;
    }

    return {
      account: selection.primary,
      triple: selection.primaryTriple,
      isContract,
      alias,
      classification,
      alternateTrustData,
    };
  } catch (error: any) {
    throw error;
  }
};

export const getAccountType = (
  accountData: GetAccountDataResult,
): AccountType => {
  const { account, triple } = accountData;

  // Since we're now using atoms directly, check if we have atom data
  if (!account) {
    return AccountType.NoAtom;
  }

  if (triple === null) {
    return AccountType.AtomWithoutTrustTriple;
  }

  return AccountType.AtomWithTrustTriple;
};
