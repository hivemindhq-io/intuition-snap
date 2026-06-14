import type { ChainId } from '@metamask/snaps-sdk';

import type { SafetyData } from './safety/types';
import type {
  TrustedCirclePositions,
  NetworkFamiliarity,
} from './trusted-circle/types';

export type Account = {
  id: string;
  data: string;
  label: string;
  image?: string;
  alias?: string;
  term_id: string;
};

/**
 * User's position data from a trust triple query.
 * Represents the user's own stake on a triple.
 */
export type UserPositionData = {
  account_id: string;
  shares: string;
};

// ============================================================================
// Address Classification Types
// ============================================================================

/**
 * Reasons why address classification may be uncertain. Used to track why we
 * couldn't definitively determine if an address is an EOA or contract.
 *
 * `eth_getCode_failed`: an `eth_getCode` RPC call failed (transport/decode).
 * `chain_not_added`: the tx's chain isn't added to MetaMask, so we could not
 * switch to it to classify on the address's actual chain.
 * `non_evm`: the tx chain is non-EVM (e.g. Solana); `eth_getCode` doesn't apply.
 */
export type ClassificationFailureReason =
  | 'eth_getCode_failed'
  | 'chain_not_added'
  | 'non_evm';

/**
 * How a definite classification was reached. Used for logging/diagnostics so we
 * can tell at a glance which path produced the verdict.
 *
 * `calldata`: transaction carried non-empty calldata (a contract call).
 * `tx_chain`: `eth_getCode` on the tx's actual chain (post switch).
 * `api`: the Hive Mind multi-chain contract-status proxy.
 */
export type ClassificationSource = 'calldata' | 'tx_chain' | 'api';

/**
 * Classification result indicating whether an address is an EOA or contract.
 * Includes certainty level to handle cases where we can't verify.
 *
 * definite EOA: bytecode resolved to no code / 7702 / smart-account.
 * definite contract: transaction has calldata OR bytecode is a real contract.
 * uncertain: we couldn't verify (RPC failed, chain not added, or non-EVM); the
 * `reason` distinguishes those cases so the UI can message accurately.
 */
export type AddressClassification =
  | { type: 'eoa'; certainty: 'definite'; source?: ClassificationSource }
  | { type: 'contract'; certainty: 'definite'; source?: ClassificationSource }
  | {
      type: 'unknown';
      certainty: 'uncertain';
      reason: ClassificationFailureReason;
    };

/**
 * Alternate trust data info - used when the non-primary atom format
 * has trust data that might be relevant to the user.
 */
export type AlternateTrustData = {
  /** Whether alternate format has any trust triple with non-zero market cap */
  hasAlternateTrustData: boolean;
  /** The atom ID of the alternate format (for View More link) */
  alternateAtomId?: string | undefined;
  /** Total market cap of the alternate trust triple (support + counter) */
  alternateMarketCap?: string | undefined;
  /** Whether the alternate is the CAIP format (true) or plain 0x (false) */
  alternateIsCaip?: boolean | undefined;
};

export type TripleWithPositions = {
  term_id: string;
  subject_id: string;
  predicate_id: string;
  object_id: string;
  creator_id: string;
  counter_term_id: string;
  term: {
    vaults: {
      term_id: string;
      market_cap: string;
      position_count: number;
      curve_id: string;
    }[];
  };
  counter_term: {
    vaults: {
      term_id: string;
      market_cap: string;
      position_count: number;
      curve_id: string;
    }[];
  };
  triple_term: {
    term_id: string;
    counter_term_id: string;
    total_market_cap: string;
    total_position_count: string;
  };
  triple_vault: {
    term_id: string;
    counter_term_id: string;
    curve_id: string;
    position_count: string;
    market_cap: string;
  };
  positions_aggregate: {
    aggregate: {
      count: number;
      sum: { shares: number };
      avg: { shares: number };
    };
  };
  counter_positions_aggregate: {
    aggregate: {
      count: number;
      sum: { shares: number };
      avg: { shares: number };
    };
  };
  positions: {
    id: string;
    account_id: string;
    term_id: string;
    curve_id: string;
    shares: string;
    account?: {
      id: string;
      label: string;
    };
  }[];
  counter_positions: {
    id: string;
    account_id: string;
    term_id: string;
    curve_id: string;
    shares: string;
    account?: {
      id: string;
      label: string;
    };
  }[];
  /** User's own position on this triple (FOR side) */
  user_position?: UserPositionData[];
  /** User's own counter-position on this triple (AGAINST side) */
  user_counter_position?: UserPositionData[];
};

// AccountType enum
export enum AccountType {
  NoAtom = 'NoAtom',
  AtomWithoutTrustTriple = 'AtomWithoutTrustTriple',
  AtomWithTrustTriple = 'AtomWithTrustTriple',
}

/** Common props shared across all account states */
type BaseAccountProps = {
  chainId: ChainId;
  /** The destination address of the transaction */
  address: string;
  /** The connected user's wallet address (for checking existing positions) */
  userAddress?: string;
  alias: string | null;
  /** Whether the address is a contract (derived from classification) */
  isContract: boolean;
  transactionOrigin?: string;
  /** Classification result with certainty level */
  classification: AddressClassification;
  /** Info about trust data in alternate atom format (CAIP vs 0x) */
  alternateTrustData: AlternateTrustData;
  /** Trusted contacts who have positions on this address's trust triple */
  trustedCircle?: TrustedCirclePositions;
  /** Trusted contacts who have ANY claim about this address (de-duped from trustedCircle) */
  networkFamiliarity?: NetworkFamiliarity;
  /** Classified safety read surface (critical reports, soft flags, provenance) */
  safety?: SafetyData;
};

// Discriminated union types for proper AccountProps typing
export type AccountProps =
  | (BaseAccountProps & {
      accountType: AccountType.NoAtom;
      account: null;
      triple: null;
    })
  | (BaseAccountProps & {
      accountType: AccountType.AtomWithoutTrustTriple;
      account: Account;
      triple: null;
    })
  | (BaseAccountProps & {
      accountType: AccountType.AtomWithTrustTriple;
      account: Account;
      triple: TripleWithPositions;
    });

// Helper type to extract props for a specific account type
export type PropsForAccountType<T extends AccountType> = Extract<
  AccountProps,
  { accountType: T }
>;

// ============================================================================
// Origin Types (for transaction origin URL trust signals)
// ============================================================================

/**
 * Represents an origin (dApp URL) atom from Intuition.
 * Similar structure to Account but for URLs.
 */
export type Origin = {
  id: string;
  data: string;
  label: string;
  image?: string;
  term_id: string;
};

// OriginType enum — origin is now classified purely by atom presence; the
// legacy trust-triple variants (Trustworthy % / FOR-AGAINST circle) are gone.
export enum OriginType {
  NoOrigin = 'NoOrigin',
  NoAtom = 'OriginNoAtom',
  HasAtom = 'OriginHasAtom',
}

/** Common props shared across all origin states */
type BaseOriginProps = {
  /** The raw origin URL from the transaction */
  originUrl: string | undefined;
  /** Extracted hostname for display */
  hostname: string | undefined;
};

// Discriminated union types for proper OriginProps typing
export type OriginProps =
  | (BaseOriginProps & {
      originType: OriginType.NoOrigin;
      origin: null;
    })
  | (BaseOriginProps & {
      originType: OriginType.NoAtom;
      origin: null;
    })
  | (BaseOriginProps & {
      originType: OriginType.HasAtom;
      origin: Origin;
    });

// Helper type to extract props for a specific origin type
export type PropsForOriginType<T extends OriginType> = Extract<
  OriginProps,
  { originType: T }
>;
