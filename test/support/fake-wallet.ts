import { useSyncExternalStore } from 'react'
import type { Address, Hex } from 'viem'
import { vi } from 'vitest'

type Receipt = { status: 'success'; blockNumber: bigint; transactionHash: Hex }

/** The hash the fake wallet answers its `n`th write (from 1) with. */
export function sentHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`
}

/**
 * The wallet, the chain's receipts and the app review under the real
 * useSafeTx and the SDK's reviewed write. Flow tests mock `wagmi`,
 * `@wagmi/core` and `@/hooks/useWallet` with the hooks below, so the engine
 * decides what reaches the wallet: `writeContract` records it.
 *
 * Switching the account re-renders every hook that reads it, as wagmi's
 * account subscription does.
 */
function createFakeWallet() {
  let account: Address | undefined
  const receipts = new Map<string, Receipt>()
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
  const writeContract = vi.fn(async () => sentHash((sentCount += 1)))
  const requestReview = vi.fn(async () => true)
  const switchChain = vi.fn(async () => undefined)
  /** One RPC for every chain: simulations pass and receipts are what `confirm` set. */
  const client = {
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
    /** A flow's own reads; each test answers the ones its flow makes. */
    readContract: vi.fn(async (request: { functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
      throw new Error(`Unexpected read ${request.functionName}`)
    }),
  }

  return {
    client,
    writeContract,
    requestReview,
    switchChain,
    get account() {
      return account
    },
    /** Connect `next`, as a wallet switching accounts does. */
    connect(next: Address | undefined) {
      account = next
      notify()
    },
    /** The chain reports `hash` as confirmed. */
    confirm(hash: Hex, blockNumber = 10n) {
      const key = hash.toLowerCase()
      const receipt: Receipt = { status: 'success', blockNumber, transactionHash: hash }
      receipts.set(key, receipt)
      for (const resolve of awaiting.get(key) ?? []) resolve(receipt)
      awaiting.delete(key)
      notify()
    },
    /** Whether a flow is waiting on `hash`'s receipt. */
    awaits(hash: Hex) {
      return awaiting.has(hash.toLowerCase())
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
      receipts.clear()
      awaiting.clear()
      writeContract.mockClear()
      requestReview.mockClear()
      requestReview.mockImplementation(async () => true)
      switchChain.mockClear()
      client.simulateContract.mockClear()
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
