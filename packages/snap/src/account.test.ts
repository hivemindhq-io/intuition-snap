/**
 * Unit tests for address-classification helpers in `account.tsx`.
 *
 * These cover the pure CAIP parsing helpers, the `withTimeout` guard, and the
 * decision branches of `classifyAddress` that we can drive deterministically by
 * mocking the `ethereum` provider global and `fetch`. The GraphQL/atom side of
 * `getAccountData` is intentionally out of scope — it needs the snap worker and
 * is exercised manually in MetaMask Flask (see `index.test.tsx`).
 */

import {
  expect,
  describe,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';

import {
  parseCaip2,
  caip2ToHexChainId,
  classifyAddress,
  withTimeout,
  TimeoutError,
} from './account';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const REAL_CONTRACT_CODE = '0x6080604052348015600f57600080fd';
const NO_CODE = '0x';

type EthereumRequest = (args: {
  method: string;
  params?: unknown[];
}) => Promise<unknown>;

/**
 * Builds a minimal `fetch` Response stand-in. The `Response` constructor is
 * disallowed by lint (not guaranteed in the target environment), so we hand-roll
 * the small surface `classifyAddress` actually reads (`ok` + `json()`).
 *
 * @param body - The JSON body to return from `.json()`.
 * @param ok - Whether the response is successful; defaults to true.
 * @returns A duck-typed Response usable by the code under test.
 */
const jsonResponse = (
  body: unknown,
  ok = true,
): Awaited<ReturnType<typeof fetch>> =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Awaited<ReturnType<typeof fetch>>);

/**
 * Installs a mocked `ethereum` provider global (as granted by
 * `endowment:ethereum-provider`) for the duration of a test.
 *
 * @param request - The mock implementation for `ethereum.request`.
 */
const setEthereum = (request: EthereumRequest): void => {
  (
    globalThis as unknown as { ethereum: { request: EthereumRequest } }
  ).ethereum = { request };
};

/**
 * Removes the `ethereum` global so we can exercise the
 * "endowment missing / provider unavailable" path.
 */
const clearEthereum = (): void => {
  delete (globalThis as unknown as { ethereum?: unknown }).ethereum;
};

describe('parseCaip2', () => {
  it('parses a well-formed eip155 chain id', () => {
    expect(parseCaip2('eip155:1')).toStrictEqual({
      namespace: 'eip155',
      reference: '1',
    });
  });

  it('parses a non-evm namespace', () => {
    expect(parseCaip2('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toStrictEqual(
      {
        namespace: 'solana',
        reference: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      },
    );
  });

  it('returns null for malformed input', () => {
    expect(parseCaip2('eip155')).toBeNull();
    expect(parseCaip2('')).toBeNull();
    expect(parseCaip2(':1')).toBeNull();
  });
});

describe('caip2ToHexChainId', () => {
  it('converts eip155 decimal references to 0x hex', () => {
    expect(caip2ToHexChainId('eip155:1')).toBe('0x1');
    expect(caip2ToHexChainId('eip155:8453')).toBe('0x2105');
    expect(caip2ToHexChainId('eip155:13579')).toBe('0x350b');
  });

  it('returns null for non-eip155 (non-EVM) namespaces', () => {
    expect(caip2ToHexChainId('solana:5eykt4Us')).toBeNull();
    expect(caip2ToHexChainId('bip122:000000000019d6689c085ae1')).toBeNull();
  });

  it('returns null for malformed or non-positive references', () => {
    expect(caip2ToHexChainId('eip155:abc')).toBeNull();
    expect(caip2ToHexChainId('eip155:0')).toBeNull();
    expect(caip2ToHexChainId('eip155:-1')).toBeNull();
    expect(caip2ToHexChainId('garbage')).toBeNull();
  });
});

describe('withTimeout', () => {
  it('resolves with the wrapped value when it settles in time', async () => {
    expect(await withTimeout(Promise.resolve('ok'), 1000)).toBe('ok');
  });

  it('rejects with TimeoutError when the wrapped promise hangs', async () => {
    const hang = new Promise<string>(() => {
      // never resolves
    });
    let caught: unknown;
    try {
      await withTimeout(hang, 5);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
  });

  it('propagates the wrapped promise rejection', async () => {
    const boom = Promise.reject(new Error('boom'));
    let caught: unknown;
    try {
      await withTimeout(boom, 1000);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('boom');
  });
});

describe('classifyAddress', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    clearEthereum();
  });

  afterEach(() => {
    clearEthereum();
  });

  it('classifies as a definite contract from calldata (no RPC)', async () => {
    // Calldata present => contract call. No provider/fetch should be touched.
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(null));

    const result = await classifyAddress(ADDRESS, '0xdeadbeef', 'eip155:1');

    expect(result).toStrictEqual({
      type: 'contract',
      certainty: 'definite',
      source: 'calldata',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns uncertain/non_evm for a non-EVM chain (no RPC)', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(null));

    const result = await classifyAddress(
      ADDRESS,
      '0x',
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    );

    expect(result).toStrictEqual({
      type: 'unknown',
      certainty: 'uncertain',
      reason: 'non_evm',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('classifies on the tx chain when the provider returns contract bytecode', async () => {
    const request = jest.fn<EthereumRequest>(async ({ method }) => {
      if (method === 'wallet_switchEthereumChain') {
        return null;
      }
      if (method === 'eth_getCode') {
        return REAL_CONTRACT_CODE;
      }
      throw new Error(`unexpected method ${method}`);
    });
    setEthereum(request);

    const result = await classifyAddress(ADDRESS, '0x', 'eip155:1');

    expect(result).toStrictEqual({
      type: 'contract',
      certainty: 'definite',
      source: 'tx_chain',
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'wallet_switchEthereumChain' }),
    );
  });

  it('classifies on the tx chain as EOA when the provider returns no code', async () => {
    const request = jest.fn<EthereumRequest>(async ({ method }) =>
      method === 'eth_getCode' ? NO_CODE : null,
    );
    setEthereum(request);

    const result = await classifyAddress(ADDRESS, '0x', 'eip155:1');

    expect(result).toStrictEqual({
      type: 'eoa',
      certainty: 'definite',
      source: 'tx_chain',
    });
  });

  it('falls back to the API when the tx chain is not added, and preserves chain_not_added if all fail', async () => {
    // Switch fails => chain_not_added. API + Intuition RPC also fail => we must
    // surface the most actionable reason (chain_not_added), not a generic error.
    const request = jest.fn<EthereumRequest>(async ({ method }) => {
      if (method === 'wallet_switchEthereumChain') {
        throw new Error('Unrecognized chain ID (4902)');
      }
      throw new Error(`unexpected method ${method}`);
    });
    setEthereum(request);

    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network down'));

    const result = await classifyAddress(ADDRESS, '0x', 'eip155:999999');

    expect(result).toStrictEqual({
      type: 'unknown',
      certainty: 'uncertain',
      reason: 'chain_not_added',
    });
  });

  it('uses the API verdict when the tx chain is unreachable but the API answers', async () => {
    const request = jest.fn<EthereumRequest>(async () => {
      throw new Error('Unrecognized chain ID (4902)');
    });
    setEthereum(request);

    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({ isContract: true, contractChainId: 1 }),
      );

    const result = await classifyAddress(ADDRESS, '0x', 'eip155:999999');

    expect(result).toStrictEqual({
      type: 'contract',
      certainty: 'definite',
      source: 'api',
    });
  });
});
