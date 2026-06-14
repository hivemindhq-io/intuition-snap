/**
 * Bytecode classification — the project-wide rule for deciding whether an
 * `eth_getCode` result represents a real smart contract or a user's wallet.
 *
 * This is a client-side port of the canonical rule in the Hive Mind API
 * (`hivemind-api/app/Services/ContractStatusService.ts#classifyBytecode`). The
 * Snap classifies on the transaction's actual chain via the `ethereum` global
 * (`endowment:ethereum-provider`), so it must apply the exact same rule the API
 * does to avoid misclassifying EIP-7702 delegated EOAs and smart accounts.
 * Keep the two in sync.
 *
 * ---------------------------------------------------------------------------
 * Project-wide classification rule (enforce this everywhere):
 *
 *   An address is a `Contract` iff it has bytecode AND that bytecode is neither
 *     - a 7702 delegation designator (`0xef0100...`), nor
 *     - a known account-abstraction implementation (Safe / 4337 / ...).
 *   Otherwise it is an `Account` (EOA / wallet).
 * ---------------------------------------------------------------------------
 *
 * @module bytecode
 * @see https://eips.ethereum.org/EIPS/eip-7702
 */

/**
 * EIP-7702 delegation designator prefix. `eth_getCode` for a delegated EOA
 * returns `0xef0100 || <impl>` (23 bytes). The address is still a user's
 * wallet, so it must be treated as an Account, not a contract. The prefix is
 * fixed by EIP-7702 and identical on every chain that activated Pectra.
 */
const EIP_7702_DELEGATION_PREFIX = '0xef0100';

/**
 * Known bytecode needles for smart-account / wallet implementations modeled as
 * an Account rather than a Contract. High-precision substrings: a miss falls
 * back to "contract", the safe default.
 *
 * - Gnosis Safe proxy: EIP-1167 minimal-proxy frame from SafeProxyFactory.
 * - ERC-4337 account: `validateUserOp(...)` selector `0x3a871cdd`, required on
 *   every 4337 account implementation.
 */
const SMART_ACCOUNT_BYTECODE_NEEDLES: readonly string[] = [
  '5af43d82803e903d91602b57fd5bf3',
  '3a871cdd',
];

/**
 * Apply the project-wide classification rule to a raw `eth_getCode` result.
 * Pure function — directly unit-testable without RPC.
 *
 * Returns `true` only for a real deployed contract. Returns `false` for no
 * code, a 7702 delegation designator, or a known smart-account implementation.
 *
 * @param code - The raw `eth_getCode` hex string (e.g. `0x`, `0x60806040...`).
 * @returns True when the bytecode is a real contract; false otherwise.
 */
export function classifyBytecode(code: string): boolean {
  const normalized = (code ?? '').toLowerCase();
  if (normalized === '0x' || normalized === '0x0' || normalized === '') {
    return false;
  }
  if (normalized.startsWith(EIP_7702_DELEGATION_PREFIX)) {
    return false;
  }
  for (const needle of SMART_ACCOUNT_BYTECODE_NEEDLES) {
    if (normalized.includes(needle)) {
      return false;
    }
  }
  return true;
}
