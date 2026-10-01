import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeConnector = { id: string; name: string; getProvider?: () => Promise<unknown> }
type Account = { connector?: FakeConnector }

const runtime = vi.hoisted(() => ({
  connector: undefined as FakeConnector | undefined,
  onChange: undefined as ((account: Account) => void) | undefined,
  unwatch: vi.fn(),
  clients: new Map<number, unknown>(),
}))

vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ connector: runtime.connector }),
  getPublicClient: (_config: unknown, { chainId }: { chainId: number }) => runtime.clients.get(chainId),
  watchAccount: (_config: unknown, { onChange }: { onChange: (account: Account) => void }) => {
    runtime.onChange = onChange
    return runtime.unwatch
  },
}))
// The SDK's own wait runs; the spy records what the adapter hands it.
vi.mock('@bananapus/nana-sdk-core/safe-service', async importOriginal => {
  const sdk = await importOriginal<typeof import('@bananapus/nana-sdk-core/safe-service')>()
  return { ...sdk, waitForSafeExecutionHash: vi.fn(sdk.waitForSafeExecutionHash) }
})

import { waitForSafeExecutionHash as sdkWait } from '@bananapus/nana-sdk-core/safe-service'
import { toEventSelector, type Hex } from 'viem'
import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  SAFE_PREFIX,
  SAFE_SERVICE_PREFIX,
  safeExecutionFailed,
  safeServiceBase,
  swapDeadline,
  useSafeConnection,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'
import { watchSafeWalletPeer } from '@/lib/safe-wallet-peer'

const CONFIG = {} as never
const SAFE = '0x1111111111111111111111111111111111111111' as const
const PROPOSAL = `0x${'ab'.repeat(32)}` as const
const EXECUTION = `0x${'cd'.repeat(32)}` as const

/** A WalletConnect connection whose session names `url` as the peer. */
const walletConnect = (url: string): FakeConnector => ({
  id: 'walletConnect',
  name: 'WalletConnect',
  getProvider: async () => ({ session: { peer: { metadata: { url } } } }),
})
/** Connects `connector` and lets the watcher read its session. */
async function connect(connector: FakeConnector | undefined) {
  runtime.connector = connector
  await act(async () => {
    runtime.onChange!({ connector })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  runtime.clients.clear()
  // Every test starts watching a disconnected wallet, with no peer recorded.
  runtime.connector = undefined
  watchSafeWalletPeer(CONFIG)
})

describe('Safe connection', () => {
  it('does not take a wallet named like Safe for one', () => {
    runtime.connector = { id: 'injected', name: 'SafePal' }
    expect(isSafeConnection(CONFIG)).toBe(false)
    runtime.connector = { id: 'app.safepal', name: 'SafePal Wallet' }
    expect(isSafeConnection(CONFIG)).toBe(false)
  })

  it('is the Safe app connector', () => {
    runtime.connector = { id: 'safe', name: 'Safe' }
    expect(isSafeConnection(CONFIG)).toBe(true)
  })

  it('is Safe{Wallet} over WalletConnect, and no other peer', async () => {
    await connect(walletConnect('https://app.safe.global'))
    expect(isSafeConnection(CONFIG)).toBe(true)
    await connect(walletConnect('https://www.safepal.com'))
    expect(isSafeConnection(CONFIG)).toBe(false)
    await connect(walletConnect('https://app.safe.global.example'))
    expect(isSafeConnection(CONFIG)).toBe(false)
  })

  it('checks the connection once when it starts watching, and returns the unwatch', async () => {
    runtime.connector = walletConnect('https://app.safe.global')
    let unwatch!: () => void
    await act(async () => {
      unwatch = watchSafeWalletPeer(CONFIG)
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(isSafeConnection(CONFIG)).toBe(true)
    expect(unwatch).toBe(runtime.unwatch)
  })

  it('keeps Safe{Wallet} while it reads the session again after a chain switch', async () => {
    await connect(walletConnect('https://app.safe.global'))
    // Gas chosen during the read must still be the Safe's.
    runtime.onChange!({ connector: { ...runtime.connector!, getProvider: () => new Promise(() => {}) } })
    expect(isSafeConnection(CONFIG)).toBe(true)
  })

  it('keeps the newest answer when an earlier session read finishes later', async () => {
    let finish!: (provider: unknown) => void
    runtime.onChange!({
      connector: { id: 'walletConnect', name: 'WalletConnect', getProvider: () => new Promise(resolve => { finish = resolve }) },
    })
    await connect(walletConnect('https://www.safepal.com'))
    finish({ session: { peer: { metadata: { url: 'https://app.safe.global' } } } })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(isSafeConnection(CONFIG)).toBe(false)
  })

  it('forgets Safe{Wallet} when a session cannot be read', async () => {
    await connect(walletConnect('https://app.safe.global'))
    await connect({ id: 'walletConnect', name: 'WalletConnect', getProvider: async () => { throw new Error('No session') } })
    expect(isSafeConnection(CONFIG)).toBe(false)
  })

  it('renders again once Safe{Wallet} is recognized', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const Probe = () => String(useSafeConnection(CONFIG))
    await act(async () => root.render(createElement(Probe)))
    expect(host.textContent).toBe('false')
    await connect(walletConnect('https://app.safe.global'))
    expect(host.textContent).toBe('true')
    await act(async () => root.unmount())
  })

  it('explains the authoritative nonce selector', () => {
    expect(SAFE_NONCE_GUIDANCE).toMatch(/next available/i)
    expect(SAFE_NONCE_GUIDANCE).toMatch(/queued nonces/i)
  })
})

describe('Safe execution failure', () => {
  const FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)')
  const PAYMENT = `0x${'00'.repeat(32)}` as Hex
  const OTHER = `0x${'ef'.repeat(32)}` as Hex
  const receipt = (...logs: { address: string; topics: Hex[]; data: Hex }[]) => ({ transactionHash: EXECUTION as Hex, logs })

  it('finds the proposal’s ExecutionFailure in Safe 1.4 (indexed) and Safe 1.3 (data) logs', () => {
    expect(safeExecutionFailed(receipt({ address: SAFE, topics: [FAILURE, PROPOSAL], data: PAYMENT }), SAFE, PROPOSAL)).toBe(true)
    expect(safeExecutionFailed(receipt({ address: SAFE, topics: [FAILURE], data: `${PROPOSAL}${PAYMENT.slice(2)}` }), SAFE, PROPOSAL)).toBe(true)
  })

  it('ignores another proposal’s failure, another Safe’s, and a receipt with none', () => {
    expect(safeExecutionFailed(receipt({ address: SAFE, topics: [FAILURE, OTHER], data: PAYMENT }), SAFE, PROPOSAL)).toBe(false)
    expect(safeExecutionFailed(receipt({ address: OTHER.slice(0, 42), topics: [FAILURE, PROPOSAL], data: PAYMENT }), SAFE, PROPOSAL)).toBe(false)
    expect(safeExecutionFailed(receipt(), SAFE, PROPOSAL)).toBe(false)
  })

  it('takes any failure of the Safe when the wallet replied with the execution itself', () => {
    expect(safeExecutionFailed(receipt({ address: SAFE, topics: [FAILURE, OTHER], data: PAYMENT }), SAFE, EXECUTION)).toBe(true)
  })
})

describe('Safe connector transaction boundaries', () => {
  it('gives swaps a 20-minute deadline for EOAs and 30 days for Safe signature collection', () => {
    const nowMs = 1_700_000_000_000
    const nowSec = 1_700_000_000
    // EOA: proposal and execution are one act, so 20 minutes is plenty.
    expect(swapDeadline(false, nowMs)).toBe(BigInt(nowSec + 20 * 60))
    // Safe: co-signer collection routinely outlives 20 minutes — match the
    // 30-day Permit2 windows so the executed swap doesn't revert on deadline.
    expect(swapDeadline(true, nowMs)).toBe(BigInt(nowSec + 30 * 24 * 60 * 60))
  })

  it('reads the chain through the watched config, so an execution hash resolves without the service', async () => {
    const client = { getTransaction: vi.fn(async () => ({ hash: EXECUTION })) }
    runtime.clients.set(8453, client)
    await expect(
      waitForSafeExecutionHash(8453, EXECUTION, { pollingIntervalMs: 1 }),
    ).resolves.toBe(EXECUTION)
    expect(sdkWait).toHaveBeenCalledWith(8453, EXECUTION, { pollingIntervalMs: 1, client })
    expect(client.getTransaction).toHaveBeenCalledWith({ hash: EXECUTION })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets an explicit client win over the watched config', async () => {
    const watchedClient = { getTransaction: vi.fn() }
    runtime.clients.set(8453, watchedClient)
    const client = { getTransaction: vi.fn(async () => ({ hash: EXECUTION })) }
    await expect(waitForSafeExecutionHash(8453, EXECUTION, { client })).resolves.toBe(EXECUTION)
    expect(sdkWait).toHaveBeenCalledWith(8453, EXECUTION, { client })
    expect(watchedClient.getTransaction).not.toHaveBeenCalled()
  })

  it('resolves a proposal identifier to the mined execution hash before receipt polling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          isExecuted: true,
          isSuccessful: true,
          transactionHash: EXECUTION,
        }),
      })),
    )

    await expect(waitForSafeExecutionHash(8453, PROPOSAL)).resolves.toBe(EXECUTION)
    // The polling URL must come from the hosted-service map, never the wider
    // app-URL map — `basesep` is hosted while `opsepolia`/`arb1-sep` 404.
    expect(fetch).toHaveBeenCalledWith(
      `https://api.safe.global/tx-service/base/api/v1/multisig-transactions/${PROPOSAL}/`,
    )
  })

  it('keeps the app-URL map wider than the hosted-service map (deliberate split)', () => {
    // Unifying these maps is what previously made service calls fire at
    // chains with none. The connector supports Safe links on all eight
    // chains; only six have a hosted transaction service.
    expect(Object.keys(SAFE_PREFIX).map(Number).sort()).toEqual(
      [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614].sort(),
    )
    expect(Object.keys(SAFE_SERVICE_PREFIX).map(Number).sort()).toEqual(
      [1, 10, 8453, 42161, 11155111, 84532].sort(),
    )
    expect(safeServiceBase(11155420)).toBeNull()
    expect(safeServiceBase(421614)).toBeNull()
    expect(safeServiceBase(84532)).toBe(
      'https://api.safe.global/tx-service/basesep',
    )
  })

  it('fails immediately on chains without a hosted transaction service instead of polling forever', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // OP Sepolia and Arbitrum Sepolia have Safe app URLs but no hosted
    // service — polling `tx-service/{opsepolia,arb1-sep}` 404s forever, which
    // left every Safe write there stuck at "pending" with retry blocked.
    await expect(waitForSafeExecutionHash(11155420, PROPOSAL)).rejects.toThrow(
      /does not host a transaction service/i,
    )
    await expect(waitForSafeExecutionHash(421614, PROPOSAL)).rejects.toThrow(
      /does not host a transaction service/i,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats sustained 404s from the service as terminal instead of pending forever', async () => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      waitForSafeExecutionHash(8453, PROPOSAL, { pollingIntervalMs: 1 }),
    ).rejects.toThrow(/no record of this proposal/i)
    expect(fetchMock).toHaveBeenCalledTimes(12)
  })

  it('rides out a transient 404 once the service starts responding', async () => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        // The service can lag a just-created proposal briefly.
        if (calls < 3) return { ok: false, status: 404 }
        return {
          ok: true,
          json: async () => ({
            isExecuted: true,
            isSuccessful: true,
            transactionHash: EXECUTION,
          }),
        }
      }),
    )

    await expect(
      waitForSafeExecutionHash(8453, PROPOSAL, { pollingIntervalMs: 1 }),
    ).resolves.toBe(EXECUTION)
  })
})
