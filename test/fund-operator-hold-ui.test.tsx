/**
 * Each chain's write in a linked ruleset plan is held by the SDK's write hold under its intent (the
 * project and the chosen action), like every other write: a lost wallet reply refuses another send until
 * the user's exit, and a submission the plan saved before SDK holds is adopted into that hold.
 */
import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import type { Address, PublicClient } from 'viem'
import { buildFundRulesetChange, initialFundRuleset, type FundRulesetSnapshot } from '../src/lib/fund-contracts'
import type { FundProjectState } from '../src/lib/fund-state'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'

const runtime = vi.hoisted(() => ({ states: [] as unknown[] }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), getAccount: () => ({ address: wallet.account, chainId: 8453 }), getPublicClient: () => wallet.client }
})
vi.mock('wagmi', async importOriginal => {
  const { walletHooks } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('wagmi')>()), ...walletHooks }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('./support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/lib/transaction-review', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@/lib/transaction-review')>()), requestContractTransactionReview: wallet.requestReview }
})
vi.mock('@/lib/safe-connector', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/safe-connector')>()), isSafeConnection: () => false, useSafeConnection: () => false }))
vi.mock('@/lib/fund-state', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/fund-state')>(),
  readFundProjectState: async () => runtime.states[0],
  readLinkedFundProjects: async () => runtime.states,
}))
vi.mock('@/components/FundAssetWithdrawals', () => ({ FundAssetWithdrawals: () => null }))
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: undefined, isError: false }),
}))

import { wallet } from './support/fake-wallet'
import { allowanceIntent, deserializeRulesetRecovery, FundOperatorActions, serializeRulesetRecovery } from '../src/components/FundOperatorActions'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const ROOT = { chainId: 8453, projectId: 7n }
const EXIT = 'I checked my wallet. Send again'
const KEY = `homerun:fund-ruleset-recovery:${ROOT.chainId}:${ROOT.projectId}:${ACCOUNT.toLowerCase()}`

function plan() {
  const states = ([8453, 10] as const).map((chainId, index) => {
    const projectId = ROOT.projectId + BigInt(index)
    const rulesetSnapshot: FundRulesetSnapshot = {
      chainId, projectId, blockNumber: 100n, controller: v6Address('JBController', chainId), currentRulesetId: 71n, upcomingRulesetId: 0n,
      configuration: initialFundRuleset(), linkedChainIds: [8453, 10],
    }
    return { chainId, projectId, owner: ACCOUNT, rulesetSnapshot }
  })
  const startsAt = Math.floor(Date.now() / 1000) + 86_400
  const requests = buildFundRulesetChange({ snapshots: states.map(state => state.rulesetSnapshot), action: 'pause', mustStartAtOrAfter: startsAt }).requests
  return { states, requests, action: 'pause', startsAt, account: ACCOUNT } as Parameters<typeof serializeRulesetRecovery>[0]
}
function state(): FundProjectState {
  const configuration = initialFundRuleset()
  return {
    chainId: ROOT.chainId, projectId: ROOT.projectId, blockNumber: 100n, blockTimestamp: 1_000n, owner: ACCOUNT, account: ACCOUNT,
    controller: v6Address('JBController', 8453), supportedController: true, supportedTerminals: true, knownOwnerWrapper: true,
    ruleset: { id: 71 }, metadata: configuration.metadata, totalSupply: 0n, creditBalance: 0n, erc20Balance: 0n,
    pendingReservedTokens: 0n, hasPendingRuleset: false, linkedChainIds: [8453, 10], accountingContexts: [],
    rulesetSnapshot: plan().states[0].rulesetSnapshot,
    permissions: { queueRulesets: true, mintTokens: false },
  } as unknown as FundProjectState
}

let host: HTMLDivElement
let root: Root
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
async function click(text: string) { expect(button(text), `${text}: ${host.textContent}`).toBeDefined(); await act(async () => button(text)!.click()); await settle(); await settle() }
async function render() {
  await act(async () => root.render(<FundOperatorActions state={state()} client={wallet.client as unknown as PublicClient} contextIndex={0} />))
  await settle(); await settle()
}
function save(submissions: Parameters<typeof serializeRulesetRecovery>[1] = new Map()) {
  const saved = plan()
  localStorage.setItem(KEY, serializeRulesetRecovery(saved, submissions, ROOT))
  runtime.states = saved.states.map(peer => ({ ...state(), chainId: peer.chainId, projectId: peer.projectId, blockNumber: 101n, rulesetSnapshot: peer.rulesetSnapshot }))
}

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(ACCOUNT)
  wallet.client.getChainId.mockImplementation(async () => 8453)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { vi.restoreAllMocks(); await act(async () => root.unmount()); host.remove(); localStorage.clear() })

it('refuses another send on a chain after a lost wallet reply until the user takes the exit', async () => {
  save()
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Verify and resume queued plan')
  await click('Review transaction 1 of 2')
  expect(button(EXIT)).toBeDefined()
  await act(async () => root.unmount()); root = createRoot(host)
  await render()
  await click('Verify and resume queued plan')
  await click('Review transaction 1 of 2')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await click(EXIT)
  await click('Review transaction 1 of 2')
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
})

it('adopts a hashless submission the plan saved before SDK holds; with no saved send time its warned exit is due at once', async () => {
  save(new Map([[8453, { kind: 'submission-unknown' as const, attemptId: crypto.randomUUID() }]]))
  await render()
  await click('Verify and resume queued plan')
  expect(host.textContent).not.toContain('add its execution hash')
  // The plan no longer holds the submission: the SDK's hold does.
  expect(deserializeRulesetRecovery(localStorage.getItem(KEY)!, ROOT, ACCOUNT).submissions.size).toBe(0)
  expect(button('Review transaction 1 of 2')?.disabled ?? true).toBe(true)
  await act(async () => root.unmount()); root = createRoot(host)
  await render()
  await click('Verify and resume queued plan')
  await click('Review transaction 1 of 2')
  expect(wallet.writeContract).not.toHaveBeenCalled()
  await click(EXIT)
  await click('Review transaction 1 of 2')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('shows a held send and its exit after a reload past the plan deadline, before the plan can resume', async () => {
  save()
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Verify and resume queued plan')
  await click('Review transaction 1 of 2')
  expect(button(EXIT)).toBeDefined()
  // A reload after the shared start: the plan can no longer resume, but its held send is still shown with its exit.
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 86_400_000)
  try {
    await act(async () => root.unmount()); root = createRoot(host)
    await render()
    expect(button(EXIT), host.textContent ?? '').toBeDefined()
    await click('Verify and resume queued plan')
    expect(host.textContent).toContain('deadline has passed')
    expect(button(EXIT)).toBeDefined()
    await click(EXIT)
    expect(button(EXIT)).toBeUndefined()
  } finally { clock.mockRestore() }
})

it('shows a held owner action and its exit after a reload, while its own button is disabled by the rules now', async () => {
  // A single-chain project: owner actions are sent directly, held by the project and the action.
  const single = (pausePay: boolean) => {
    const current = state()
    return { ...current, linkedChainIds: [8453], metadata: { ...current.metadata, pausePay }, rulesetSnapshot: { ...current.rulesetSnapshot, linkedChainIds: [8453] } } as unknown as FundProjectState
  }
  runtime.states = [single(false)]
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  const show = (current: FundProjectState) => act(async () => root.render(<FundOperatorActions state={current} client={wallet.client as unknown as PublicClient} contextIndex={0} />))
  await show(single(false)); await settle(); await settle()
  await click('Review pause')
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-tx-confirm] button')].find(node => node.textContent === 'Confirm & queue')!.click())
  await settle(); await settle()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  // Reloaded after another action (close) changed the rules: pause is no longer offered.
  await act(async () => root.unmount()); root = createRoot(host)
  runtime.states = [single(true)]
  await show(single(true)); await settle(); await settle()
  expect(button('Review pause')?.disabled).toBe(true)
  expect(button(EXIT), host.textContent ?? '').toBeDefined()
  await click(EXIT)
  expect(button(EXIT)).toBeUndefined()
})

it('shows a held purchase-allowance write and its exit after a reload, with allowance configuration unavailable', async () => {
  const TERMINAL = '0x3333333333333333333333333333333333333333' as Address, TOKEN = '0x4444444444444444444444444444444444444444' as Address
  const current = { ...state(), linkedChainIds: [8453], accountingContexts: [{ terminal: TERMINAL, token: TOKEN, decimals: 6, currency: 1, symbol: 'USDC', balance: 0n, surplus: 0n, surplusAllowances: [] }],
    permissions: { queueRulesets: false, mintTokens: false } } as unknown as FundProjectState
  // An allowance change the wallet never answered for, from before the reload.
  const { adoptLegacyWrite } = await import('@/lib/write-hold')
  await adoptLegacyWrite({ chainId: 8453, account: ACCOUNT, safe: false, namespace: allowanceIntent(7n, { terminal: TERMINAL, token: TOKEN }), call: { to: TERMINAL, data: '0x12345678', value: 0n } }, {}, wallet.client as never)
  await act(async () => root.render(<FundOperatorActions state={current} client={wallet.client as unknown as PublicClient} contextIndex={0} />))
  await settle(); await settle()
  expect(button(EXIT), host.textContent ?? '').toBeDefined()
  await click(EXIT)
  expect(button(EXIT)).toBeUndefined()
})

