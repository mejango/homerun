import { useSyncExternalStore } from 'react'
import type { Address, Hex } from 'viem'
import { registerReviewHandler, type ReviewPrompt } from '@bananapus/nana-sdk-core/review'
import { vi } from 'vitest'
import { providerClient } from './provider-client'

type Receipt = { status: 'success' | 'reverted'; blockNumber: bigint; blockHash: Hex; transactionHash: Hex; transactionIndex: number; from: Address; to: Address; logs: readonly unknown[] }
type WrittenTransaction = { hash: Hex; chainId: number; from: Address; to: Address; nonce: number; input: Hex; value: bigint; blockHash: Hex | null; blockNumber: bigint | null; transactionIndex: number | null }

/** The hash the fake wallet answers its `n`th write (from 1) with. */
export function sentHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`
}

/**
 * The wallet, the chain's receipts and the app review under the real
 * useReviewedAction and core's reviewed send. Flow tests mock `wagmi`,
 * `@wagmi/core` (with `walletCore`) and `@/hooks/useWallet` with the hooks
 * below, so the engine decides what reaches the wallet: `writeContract`
 * records each transaction, named by the function its review decoded.
 *
 * Switching the account re-renders every hook that reads it, as wagmi's
 * account subscription does.
 */
function createFakeWallet() {
  let account: Address | undefined
  let chainId = 1
  const receipts = new Map<string, Receipt>()
  const transactions = new Map<string, WrittenTransaction>()
  /** Flows awaiting a receipt the chain has not reported yet. */
  const awaiting = new Map<string, ((receipt: Receipt) => void)[]>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach(listener => listener())
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  let sentCount = 0
  /** Each reviewed call's function, by its calldata, as core's review decoded it. */
  const reviewed = new Map<string, string>()
  const writeContract = vi.fn(async (request: { address: Address; account: Address; chainId: number; data: Hex; value?: bigint; functionName?: string }) => {
    const hash = sentHash((sentCount += 1))
    chainId = request.chainId
    transactions.set(hash, { hash, chainId, from: request.account, to: request.address, nonce: sentCount - 1,
      input: request.data, value: request.value ?? 0n, blockHash: null, blockNumber: null, transactionIndex: null })
    return hash
  })
  /** Each typed-data signature the wallet was asked for, on the chain it was on. */
  const signTypedData = vi.fn(async (_request: { domain?: { chainId?: number | bigint } }): Promise<Hex> => `0x${'dd'.repeat(65)}`)
  /** The wallet client core's adapter sends and signs through. */
  const walletClient = {
    get chain() { return { id: chainId } },
    signTypedData,
    sendTransaction: ({ account: from, chain, to, data, value }: { account: Address; chain: { id: number }; to: Address; data: Hex; value?: bigint }) =>
      writeContract({ address: to, account: from, chainId: chain.id, data, value, functionName: reviewed.get(data.toLowerCase()) }),
  }
  const requestReview = vi.fn(async (_prompt?: ReviewPrompt) => true)
  registerReviewHandler(async prompt => {
    for (const call of prompt.model.calls) if (call.functionName) reviewed.set(call.data.toLowerCase(), call.functionName)
    return (await requestReview(prompt)) ? prompt.confirmation : null
  })
  const switchChain = vi.fn(async (parameters?: { chainId: number }) => { if (parameters) chainId = parameters.chainId })
  /** One RPC for every chain: simulations pass and receipts are what `confirm` set. */
  const client = {
    getChainId: vi.fn(async () => chainId),
    /** Core's simulation: every call succeeds unless a test says otherwise. */
    request: vi.fn(async ({ method }: { method: string; params?: unknown }): Promise<unknown> => {
      if (method === 'eth_call') return '0x'
      throw new Error(`Unexpected RPC ${method}`)
    }),
    simulateCalls: vi.fn(async ({ calls }: { calls: readonly unknown[] }) => ({ results: calls.map(() => ({ status: 'success' as const })) })),
    estimateGas: vi.fn(async () => 50_000n),
    getBlock: vi.fn(async ({ blockNumber = 1_000n }: { blockNumber?: bigint; blockTag?: string }) => ({ number: blockNumber, hash: sentHash(Number(blockNumber)), timestamp: 1_000n })),
    getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => transactions.get(hash.toLowerCase()) ?? null),
    simulateContract: vi.fn(async (request: Record<string, unknown>) => ({ request: { ...request } })),
    estimateContractGas: vi.fn(async () => 50_000n),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => receipts.get(hash.toLowerCase()) ?? null),
    /** Resolves once `confirm(hash)` reports it. */
    waitForTransactionReceipt: vi.fn(({ hash }: { hash: Hex }) => {
      const key = hash.toLowerCase()
      const found = receipts.get(key)
      if (found) return Promise.resolve(found)
      return new Promise<Receipt>(resolve => awaiting.set(key, [...(awaiting.get(key) ?? []), resolve]))
    }),
    getBalance: vi.fn(async () => 10n ** 30n),
    /** The nonce evidence a held write reads before the wallet opens. */
    getBlockNumber: vi.fn(async () => 1_000n),
    getTransactionCount: vi.fn(async () => 0),
    /** A flow's own reads; each test answers the ones its flow makes. */
    readContract: vi.fn(async (request: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
      throw new Error(`Unexpected read ${request.functionName}`)
    }),
  }

  return {
    client,
    walletClient,
    writeContract,
    signTypedData,
    requestReview,
    switchChain,
    get account() {
      return account
    },
    /** The chain the wallet is on: the last it switched to or sent on. */
    get chainId() {
      return chainId
    },
    /** Connect `next`, as a wallet switching accounts does. */
    connect(next: Address | undefined) {
      account = next
      notify()
    },
    /** The chain reports `hash` as confirmed (or, with `status`, reverted), with `logs`. */
    confirm(hash: Hex, blockNumber = 10n, status: Receipt['status'] = 'success', logs: Receipt['logs'] = []) {
      const key = hash.toLowerCase()
      const transaction = transactions.get(key)!
      const blockHash = sentHash(Number(blockNumber))
      Object.assign(transaction, { blockNumber, blockHash, transactionIndex: 0 })
      const receipt: Receipt = { status, blockNumber, blockHash, transactionHash: hash,
        transactionIndex: 0, from: transaction.from, to: transaction.to, logs }
      receipts.set(key, receipt)
      for (const resolve of awaiting.get(key) ?? []) resolve(receipt)
      awaiting.delete(key)
      notify()
    },
    /** A reload: flows waiting on a receipt stop waiting, and the chain still reports what `confirm` sets later. */
    forget() {
      awaiting.clear()
    },
    /** Whether a flow is waiting on `hash`'s receipt. */
    awaits(hash: Hex) {
      return awaiting.has(hash.toLowerCase())
    },
    /** The exact transactions the wallet was asked to send, in order. */
    sent() {
      return writeContract.mock.calls.map(call => {
        const request = (call as unknown[])[0] as Parameters<typeof writeContract>[0]
        return { chainId: request.chainId, to: request.address.toLowerCase(), data: request.data, value: String(request.value ?? 0n) }
      })
    },
    /** What reached the wallet: each write's function and sender. */
    writes() {
      return writeContract.mock.calls.map(call => {
        const request = (call as unknown[])[0] as { functionName: string; account: unknown }
        return { functionName: request.functionName, account: request.account }
      })
    },
    reset() {
      account = undefined
      sentCount = 0
      reviewed.clear()
      chainId = 1
      receipts.clear()
      transactions.clear()
      awaiting.clear()
      writeContract.mockClear()
      signTypedData.mockClear()
      requestReview.mockClear()
      requestReview.mockImplementation(async () => true)
      switchChain.mockClear()
      client.simulateContract.mockClear()
      client.request.mockReset().mockImplementation(async ({ method }) => {
        if (method === 'eth_call') return '0x'
        throw new Error(`Unexpected RPC ${method}`)
      })
      client.simulateCalls.mockClear()
      client.getChainId.mockReset().mockImplementation(async () => chainId)
      client.getTransaction.mockReset().mockImplementation(async ({ hash }) => transactions.get(hash.toLowerCase()) ?? null)
      client.getBlock.mockReset().mockImplementation(async ({ blockNumber = 1_000n }) => ({ number: blockNumber, hash: sentHash(Number(blockNumber)), timestamp: 1_000n }))
      client.getTransactionReceipt.mockClear()
      client.waitForTransactionReceipt.mockClear()
      client.readContract.mockReset()
      client.readContract.mockImplementation(async request => {
        throw new Error(`Unexpected read ${request.functionName}`)
      })
    },
    /** The connected account, re-rendering on a switch. */
    useAccount() {
      return useSyncExternalStore(subscribe, () => account)
    },
    useReceipt(hash: Hex | undefined) {
      return useSyncExternalStore(subscribe, () => (hash ? receipts.get(hash.toLowerCase()) : undefined))
    },
  }
}

export const wallet = createFakeWallet()

/** The engine's wagmi hooks, answered by the fake wallet. */
export const walletHooks = {
  usePublicClient: () => wallet.client,
  useWriteContract: () => ({ writeContractAsync: wallet.writeContract }),
  useSwitchChain: () => ({ switchChainAsync: wallet.switchChain }),
  useWaitForTransactionReceipt: ({ hash }: { hash?: Hex }) => ({
    data: wallet.useReceipt(hash),
    isError: false,
  }),
}

/** Failures the fake wallet answers with, until a test clears them. */
export const walletFaults = { chainRead: null as Error | null }

/** The engine's `@wagmi/core` actions, answered by the fake wallet; a test adds its own `getAccount`. */
export const walletCore = {
  getPublicClient: () => wallet.client,
  // wagmi's client for the chain asked for, as a wallet on that chain answers it.
  getWalletClient: async (_config: unknown, options?: { chainId?: number }) =>
    providerClient({ ...wallet.walletClient, chain: { id: options?.chainId ?? wallet.walletClient.chain.id }, chainRead: () => walletFaults.chainRead }),
  switchChain: (_config: unknown, parameters: { chainId: number }) => wallet.switchChain(parameters),
}

/** `useWallet`, connected as the fake wallet's account. */
export function useFakeWallet() {
  const address = wallet.useAccount()
  return {
    isConnected: !!address,
    address,
    isCenterWallet: false,
    openSignIn: () => {},
  }
}
