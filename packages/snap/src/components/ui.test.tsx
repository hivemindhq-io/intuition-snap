/**
 * Unit tests for the shared presentational helpers in `ui.tsx`.
 *
 * These components are pure (props in, JSX element tree out), so we assert on
 * the returned element structure directly rather than installing the Snap. We
 * focus on `AccountTypeBadge`, whose copy/visibility encodes the product rule
 * that we never overclaim a verdict we couldn't actually establish.
 */

import { expect, describe, it } from '@jest/globals';

import type { AddressClassification } from '../types';
import { AccountTypeBadge, isHexAddress } from './ui';

/**
 * Flattens a snaps-sdk JSX element tree into its concatenated text content so we
 * can assert on the human-readable copy without coupling to element nesting.
 *
 * @param node - A snaps-sdk JSX element, string, array, or nullish value.
 * @returns The concatenated visible text.
 */
const textOf = (node: unknown): string => {
  if (node === null || node === undefined || node === false) {
    return '';
  }
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join('');
  }
  if (typeof node === 'object' && 'props' in (node as { props?: unknown })) {
    return textOf((node as { props: { children?: unknown } }).props.children);
  }
  return '';
};

describe('isHexAddress', () => {
  it('accepts a 20-byte 0x address', () => {
    expect(isHexAddress('0x1111111111111111111111111111111111111111')).toBe(
      true,
    );
  });

  it('rejects ENS names and malformed input', () => {
    expect(isHexAddress('vitalik.eth')).toBe(false);
    expect(isHexAddress('0x123')).toBe(false);
    expect(isHexAddress('')).toBe(false);
  });
});

describe('AccountTypeBadge', () => {
  it('renders "Smart contract" for a definite contract', () => {
    const classification: AddressClassification = {
      type: 'contract',
      certainty: 'definite',
      source: 'tx_chain',
    };
    const node = AccountTypeBadge({ classification });
    expect(textOf(node)).toContain('Smart contract');
  });

  it('renders "Wallet (EOA)" for a definite EOA', () => {
    const classification: AddressClassification = {
      type: 'eoa',
      certainty: 'definite',
      source: 'tx_chain',
    };
    const node = AccountTypeBadge({ classification });
    expect(textOf(node)).toContain('Wallet (EOA)');
  });

  it('hides the row entirely for a non-EVM chain', () => {
    const classification: AddressClassification = {
      type: 'unknown',
      certainty: 'uncertain',
      reason: 'non_evm',
    };
    expect(AccountTypeBadge({ classification })).toBeNull();
  });

  it('shows a neutral "couldn\'t verify" message when the chain is not added', () => {
    const classification: AddressClassification = {
      type: 'unknown',
      certainty: 'uncertain',
      reason: 'chain_not_added',
    };
    const node = AccountTypeBadge({ classification });
    expect(textOf(node)).toContain("Couldn't verify on this network");
  });

  it('shows the neutral message when eth_getCode failed', () => {
    const classification: AddressClassification = {
      type: 'unknown',
      certainty: 'uncertain',
      reason: 'eth_getCode_failed',
    };
    const node = AccountTypeBadge({ classification });
    expect(textOf(node)).toContain("Couldn't verify on this network");
    // Must NOT overclaim a contract verdict it never established.
    expect(textOf(node)).not.toContain('Smart contract');
  });
});
