/**
 * jango's connector-switch reproduction, against real wagmi and viem: a change that lands after
 * the adapter's checks, while viem awaits its own reads before it sends, never reaches a wallet.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WalletNotInvokedError, isDefiniteWalletRejection } from '@bananapus/nana-sdk-core/review'

const account = '0x1111111111111111111111111111111111111111'
const s = vi.hoisted(() => ({
  sends: [] as string[], armed: false, scheduled: false, safe: false,
  /** A wallet that refuses eth_sendTransaction as unsupported, so viem falls back to wallet_sendTransaction; `onRefuse` runs as it refuses. */
  walletNamespace: false, onRefuse: (() => {}) as () => void,
  /** A wallet error that may have broadcast, answered to the first send. */
  ambiguous: false,
  /** Answers for each eth_sendTransaction the wallet receives, in order; each runs as it is received and may throw. */
  answers: [] as (() => void)[], dispatches: [] as string[],
  /** The change under test, run in a microtask after the adapter's first read once the client is fetched. */
  change: (() => {}) as () => void,
  config: undefined as unknown as { state: { current: string; connections: Map<string, { accounts: string[]; chainId: number; connector: unknown }> } },
}))
const connector = (id: string, uid = id) => ({ id, uid, getAccounts: async () => [account], getChainId: async () => 1,
  getProvider: async () => ({ request: async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_sendTransaction') s.dispatches.push(uid)
    if (method === 'eth_sendTransaction' && s.answers.length) s.answers.shift()!()
    if (method === 'eth_sendTransaction' && s.walletNamespace) { s.onRefuse(); throw Object.assign(new Error('unsupported'), { code: -32601 }) }
    if (method === 'eth_sendTransaction' || method === 'wallet_sendTransaction' || method === 'personal_sign') {
      s.sends.push(`${method}:${uid}`)
      if (s.ambiguous) throw Object.assign(new Error('Internal error'), { code: -32603 })
      return `0x${'12'.repeat(32)}`
    }
    throw new Error(method)
  } }) })
s.config = { chains: [{ id: 1, name: 'Ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://unused'] } } }],
  state: { current: 'old', status: 'connected', connections: new Map() } } as never

vi.mock('@wagmi/core', async importOriginal => {
  const wagmi = await importOriginal<typeof import('@wagmi/core')>()
  return { ...wagmi,
    getAccount: (config: never) => {
      const snapshot = wagmi.getAccount(config)
      if (s.armed && !s.scheduled) { s.scheduled = true; queueMicrotask(() => s.change()) }
      return snapshot
    },
    getWalletClient: async (...args: Parameters<typeof wagmi.getWalletClient>) => {
      const client = await wagmi.getWalletClient(...args)
      s.armed = true
      return client
    },
  }
})
vi.mock('@/providers/Providers', () => ({ get wagmiConfig() { return s.config } }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => s.safe }))

import { walletAdapter } from '@/lib/reviewed-send-deps'
import { clearViewAs, setViewAs } from '@/lib/viewAs'

beforeEach(() => {
  Object.assign(s, { sends: [], armed: false, scheduled: false, safe: false, change: () => {}, walletNamespace: false, onRefuse: () => {}, ambiguous: false, answers: [], dispatches: [] })
  s.config.state.current = 'old'
  s.config.state.connections = new Map([
    ['old', { accounts: [account], chainId: 1, connector: connector('old') }],
    ['current', { accounts: [account], chainId: 1, connector: connector('current') }],
    ['center', { accounts: [account], chainId: 1, connector: connector('juicebox-center', 'center') }],
  ])
})
afterEach(() => clearViewAs())

const send = () => walletAdapter.sendTransaction({ chainId: 1, to: account, data: '0x', value: 0n, gas: 21_000n })

const changes = [
  ['a same-account connector switch', () => { s.config.state.current = 'current' }, 'Wallet connection changed'],
  ['view-as turned on', () => setViewAs('0x2222222222222222222222222222222222222222'), 'View'],
  ['a Safe connection', () => { s.safe = true }, 'Wallet connection changed'],
  ['the Center wallet', () => { s.config.state.current = 'center' }, 'Wallet connection changed'],
  ['another account', () => { s.config.state.connections.get('old')!.accounts = ['0x3333333333333333333333333333333333333333'] }, 'account changed'],
] as const

it.each(changes)('never sends after %s lands while viem prepares the send, and the step is released', async (_label, change, line) => {
  s.change = change
  const refused = await send().catch(error => error)
  expect(s.sends).toEqual([])
  expect(refused).toBeInstanceOf(WalletNotInvokedError)
  expect(refused.message).toMatch(new RegExp(line, 'i'))
})

it('sends through the connector that stayed', async () => {
  await expect(send()).resolves.toBe(`0x${'12'.repeat(32)}`)
  expect(s.sends).toEqual(['eth_sendTransaction:old'])
})

it.each(changes)("never sends viem's wallet_sendTransaction fallback after %s, and keeps it held: a request already went out", async (_label, change) => {
  s.walletNamespace = true
  s.onRefuse = change
  const refused = await send().catch(error => error)
  expect(s.sends).toEqual([])
  expect(refused).not.toBeInstanceOf(WalletNotInvokedError)
})

it('sends once, never retrying a wallet error that may have broadcast', async () => {
  s.ambiguous = true
  const failed = await send().catch(error => error)
  expect(s.sends).toEqual(['eth_sendTransaction:old'])
  expect(failed).not.toBeInstanceOf(WalletNotInvokedError)
})

const rpcError = (code: number) => Object.assign(new Error(`rpc ${code}`), { code })

it("never retries a send on the old connector after it changed: wagmi's client retries an internal error after a wait", async () => {
  s.answers = [() => { s.config.state.current = 'current'; throw rpcError(-32603) }]
  const failed = await send().catch(error => error)
  expect(s.dispatches).toEqual(['old'])
  expect(s.sends).toEqual([])
  // The first request may have reached the wallet: never unsent.
  expect(failed).not.toBeInstanceOf(WalletNotInvokedError)
  expect(isDefiniteWalletRejection(failed)).toBe(false)
})

it('never releases a send whose first request failed ambiguously, whatever a retry would answer', async () => {
  s.answers = [() => { throw rpcError(-32603) }, () => { throw rpcError(4001) }]
  const failed = await send().catch(error => error)
  expect(s.dispatches).toEqual(['old'])
  expect(isDefiniteWalletRejection(failed)).toBe(false)
  expect(failed).not.toBeInstanceOf(WalletNotInvokedError)
})
