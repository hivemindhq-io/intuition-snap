/**
 * Unit tests for the bytecode classification rule. Pure function — no RPC, so
 * tested directly. Mirrors the canonical rule in the Hive Mind API
 * (`ContractStatusService#classifyBytecode`); keep the two in sync.
 */

import { expect, describe, it } from '@jest/globals';

import { classifyBytecode } from './bytecode';

describe('classifyBytecode', () => {
  it('returns false for an empty account (no code)', () => {
    expect(classifyBytecode('0x')).toBe(false);
    expect(classifyBytecode('0x0')).toBe(false);
    expect(classifyBytecode('')).toBe(false);
  });

  it('returns true for ordinary contract bytecode', () => {
    expect(classifyBytecode('0x6080604052348015600f57600080fd')).toBe(true);
  });

  it('treats an EIP-7702 delegation designator as an account (EOA)', () => {
    // 0xef0100 || <20-byte impl address> — a delegated EOA, still a wallet.
    expect(
      classifyBytecode('0xef0100a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3'),
    ).toBe(false);
  });

  it('is case-insensitive for the 7702 prefix', () => {
    expect(
      classifyBytecode('0xEF0100A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3'),
    ).toBe(false);
  });

  it('treats a Gnosis Safe minimal-proxy as an account', () => {
    // EIP-1167 frame emitted by SafeProxyFactory.
    expect(
      classifyBytecode(
        '0x363d3d373d3d3d363d735af43d82803e903d91602b57fd5bf3',
      ),
    ).toBe(false);
  });

  it('treats an ERC-4337 account (validateUserOp selector) as an account', () => {
    expect(classifyBytecode('0x60806040523a871cdd00112233')).toBe(false);
  });

  it('handles nullish input safely', () => {
    expect(classifyBytecode(undefined as unknown as string)).toBe(false);
  });
});
