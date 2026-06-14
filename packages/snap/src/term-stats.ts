/**
 * Cross-curve aggregation helpers.
 *
 * Background: queries used to filter `vaults(where: { curve_id: { _eq: "1" } })`
 * (or `vaults(limit: 1)`) and consumers read `term.vaults[0].market_cap` /
 * `vaults[0].position_count`. That silently dropped curve >= 2 data and
 * under-reported headline numbers (see triple 0x66f9... where AGAINST was
 * showing ~5 TRUST instead of the true ~28.5 TRUST).
 *
 * We now fetch ALL curves (no `curve_id` filter, no `limit`) and roll up here.
 *
 * For unique-staker counts, prefer `positions_aggregate(where: { shares: { _gt: "0" } })
 * { aggregate { count(columns: account_id, distinct: true) } }` directly in the query —
 * summing `position_count` across vaults double-counts accounts that staked on
 * multiple curves.
 *
 * Per-curve fields (`total_shares`, `current_share_price`) are NOT comparable across
 * curves; use `linearVault()` to extract the default-curve view when you need them.
 *
 * Snap-specific notes:
 * - Market caps are wei-scale strings; we use BigInt math and return strings to
 *   match the rest of the snap codebase (see `account.tsx` `getTrustMarketCap`,
 *   `util.ts` `stringToDecimal`).
 * - The Snap runs in a hardened SES environment, so we keep this dependency-free.
 */

export type CurveVault = {
  market_cap?: string | number | null;
  position_count?: string | number | null;
  total_shares?: string | number | null;
  current_share_price?: string | number | null;
  curve_id?: string | number | null;
};

/**
 * Sum `market_cap` (in wei) across a multi-curve vaults[] array.
 *
 * @param vaults - The multi-curve vaults array (may be undefined/empty)
 * @returns The total market cap as a wei-scale BigInt string. Returns "0"
 * when the array is missing or empty.
 */
export const sumMarketCap = (vaults?: CurveVault[] | null): string => {
  if (!vaults || vaults.length === 0) {
    return '0';
  }
  let total = 0n;
  for (const v of vaults) {
    const raw = v?.market_cap;
    if (raw === null || raw === undefined) {
      continue;
    }
    try {
      total += BigInt(raw as string);
    } catch {
      // ignore unparseable values
    }
  }
  return total.toString();
};

/**
 * Sum `position_count` across vaults. NOTE: this is total *positions* (one per
 * curve per account), not unique stakers. If a single account has staked on
 * multiple curves it will be counted multiple times. Use a distinct-account
 * aggregate where unique-staker semantics matter.
 *
 * @param vaults - The multi-curve vaults array (may be undefined/empty)
 * @returns The summed position count. Returns 0 when the array is missing or empty.
 */
export const sumPositionCount = (vaults?: CurveVault[] | null): number => {
  if (!vaults || vaults.length === 0) {
    return 0;
  }
  let total = 0;
  for (const v of vaults) {
    const raw = v?.position_count;
    if (raw === null || raw === undefined) {
      continue;
    }
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n)) {
      total += n;
    }
  }
  return total;
};

/**
 * Pick the default (linear, curve_id=1) vault row from a multi-curve array.
 * Used when callers need per-curve fields (`total_shares`, `current_share_price`)
 * that aren't summable across curves, or when interacting with the LinearCurve
 * contract for stake/unstake math.
 *
 * Falls back to the first vault if no curve_id=1 entry is present, mirroring
 * the explorer's helper.
 *
 * @param vaults - The multi-curve vaults array (may be undefined/empty)
 * @returns The linear (curve_id=1) vault, or `undefined` if the array is empty.
 */
export const linearVault = <T extends CurveVault>(
  vaults?: T[] | null,
): T | undefined => {
  if (!vaults || vaults.length === 0) {
    return undefined;
  }
  return vaults.find((v) => String(v?.curve_id ?? '') === '1') ?? vaults[0];
};
