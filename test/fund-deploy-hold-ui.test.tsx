/**
 * A direct FUND launch is held by the SDK's write hold under its intent (the launch), like every other
 * write: a lost wallet reply refuses another deployment until the user's exit, and an attempt the launch
 * record saved before SDK holds is adopted into that hold, with its saved nonce evidence.
 */
import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'
import { checkedItLabel, HELD_SUCCESS_LINE, SAVED_ATTEMPT_CHECK_LINE } from '@bananapus/nana-sdk-core/review'

vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
/** The chain the wallet is on. */
const connected = vi.hoisted(() => ({ chainId: 8453 }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), getWalletClient: async () => ({ writeContract: wallet.writeContract }), getAccount: () => ({ address: wallet.account, chainId: connected.chainId }), getPublicClient: () => wallet.client }
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
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => null }))
vi.mock('@/components/CreateFlow', () => ({ default: () => null }))
const verification = vi.hoisted(() => ({ launch: null as null | (() => Promise<bigint>) }))
vi.mock('@/lib/fund-launch-verification', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/lib/fund-launch-verification')>()
  return { ...actual, checkLaunchDeployment: async () => undefined, verifyFundLaunch: (...args: Parameters<typeof actual.verifyFundLaunch>) => verification.launch ? verification.launch() : actual.verifyFundLaunch(...args) }
})
vi.mock('@/lib/fund-launch-relayr', () => ({ runRelayrLaunch: vi.fn(), launchRequestsDead: vi.fn() }))

import { wallet } from './support/fake-wallet'
import { FundDeploy } from '../src/components/FundDeploy'
import type { CreateValues } from '../src/components/CreateFlow'
import { FUND_LAUNCH_KEY, decodeLaunchSession, encodeLaunchSession, launchIntent, saveLaunch, updateLaunchStatus, type LaunchStatus } from '../src/lib/fund-launch-session'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const SALT = `0x${'12'.repeat(32)}` as Hex
const EXIT = 'I checked my wallet. Send again'

let host: HTMLDivElement
let root: Root
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
async function click(text: string) { expect(button(text), `${text}: ${host.textContent}`).toBeDefined(); await act(async () => button(text)!.click()); await settle(); await settle() }
async function render() {
  await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
  await settle(); await settle()
}
function save(status: LaunchStatus) {
  saveLaunch({ version: 1, name: 'Test asset', input: { owner: OWNER, sender: OWNER, chainIds: [8453], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt: SALT, mustStartAtOrAfter: 0, creationFees: { 8453: 0n } }, statuses: { 8453: status } })
}
const saved = () => decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).statuses[8453]

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(OWNER)
  connected.chainId = 8453
  wallet.client.getChainId.mockImplementation(async () => 8453)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { verification.launch = null; await act(async () => root.unmount()); host.remove(); localStorage.clear() })

it('refuses another deployment after a lost wallet reply until the user takes the exit', async () => {
  save({ phase: 'ready' })
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Review and deploy FUND')
  expect(button(EXIT)).toBeDefined()
  await act(async () => root.unmount()); root = createRoot(host)
  await render()
  await click('Review and deploy FUND')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  await click(EXIT)
  await click('Review and deploy FUND')
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
})

it('adopts a hashless attempt the launch record saved before SDK holds with its nonce: the record reopens, and only the exit deploys again', async () => {
  save({ phase: 'signing', safe: false, attemptId: '11111111-1111-4111-8111-111111111111', nonce: '0', fromBlock: '900' })
  await render()
  // The hold has it at its nonce: the chain can still settle it, and its exit is the user's.
  expect(saved().phase).toBe('ready')
  expect(saved().attemptId).toBeUndefined()
  expect(button(EXIT), host.textContent ?? '').toBeDefined()
  expect(wallet.writeContract).not.toHaveBeenCalled()
  await click(EXIT)
  await click('Review and deploy FUND')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('refuses to discard a launch whose deployment is held, and keeps its exit', async () => {
  save({ phase: 'ready' })
  wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
  await render()
  await click('Review and deploy FUND')
  expect(button(EXIT)).toBeDefined()
  await click('Discard and edit details')
  expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
  expect(host.textContent).toContain('Finish or exit the pending launch first.')
  expect(button(EXIT)).toBeDefined()
  // A network change does not discard it either.
  await act(async () => root.render(<FundDeploy values={{ networkEnvironment: 'production', networks: ['optimism'] } as unknown as CreateValues} />))
  await settle(); await settle()
  expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
  expect(button(EXIT)).toBeDefined()
})

it('does not confirm a launch from a mined receipt until its hold settles', async () => {
  save({ phase: 'ready' })
  // The node has a receipt, and the domain checks would pass, but the transaction still reads as pending.
  verification.launch = async () => 42n
  const chainReceipt = wallet.client.getTransactionReceipt.getMockImplementation()!
  wallet.client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({ status: 'success', transactionHash: hash, blockNumber: 10n, blockHash: `0x${'0a'.repeat(32)}`, transactionIndex: 0, from: OWNER, to: OWNER, logs: [] }) as never)
  await render()
  await click('Review and deploy FUND')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  if (button('Check confirmation')) await click('Check confirmation')
  expect(saved().phase).not.toBe('confirmed')
  // The chain places it: the hold settles, and only then is the launch confirmed.
  wallet.client.getTransactionReceipt.mockImplementation(chainReceipt)
  await act(async () => { wallet.confirm(`0x${'1'.padStart(64, '0')}` as Hex) })
  await settle(); await settle(); await settle()
  expect(saved()).toMatchObject({ phase: 'confirmed', projectId: '42' })
})

describe('a two-chain direct launch', () => {
  const twoChains = () => saveLaunch({ version: 1, name: 'Test asset', transport: 'direct', input: { owner: OWNER, sender: OWNER, chainIds: [8453, 10], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt: SALT, mustStartAtOrAfter: 1_000, creationFees: { 8453: 0n, 10: 0n } }, statuses: { 8453: { phase: 'ready' }, 10: { phase: 'ready' } } })
  const first = `0x${'1'.padStart(64, '0')}` as Hex

  it('sends the next chain on its own once the first hold settles with success', async () => {
    twoChains()
    verification.launch = async () => 42n
    await render()
    // The wallet and the node follow the chain the wallet was last switched to.
    wallet.client.getChainId.mockImplementation(async () => connected.chainId)
    wallet.switchChain.mockImplementation(async ({ chainId }: { chainId: number }) => { connected.chainId = chainId })
    await click('Continue creation')
    expect(wallet.writeContract).toHaveBeenCalledOnce()
    await act(async () => { wallet.confirm(first) })
    await settle(); await settle(); await settle()
    expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).statuses[8453].phase).toBe('confirmed')
    // No press: the second chain's send follows the first's settlement.
    await vi.waitFor(() => expect(wallet.writeContract, host.textContent ?? '').toHaveBeenCalledTimes(2))
    expect(wallet.writeContract.mock.calls[1][0]).toMatchObject({ chainId: 10 })
  })

  it('does not continue on its own after the user takes a chain’s exit', async () => {
    twoChains()
    wallet.client.getChainId.mockImplementation(async () => connected.chainId)
    wallet.switchChain.mockImplementation(async ({ chainId }: { chainId: number }) => { connected.chainId = chainId })
    wallet.writeContract.mockRejectedValueOnce(new Error('Wallet reply was lost after broadcast'))
    await render()
    await click('Continue creation')
    await click(EXIT)
    // The first chain is later confirmed elsewhere (another tab): nothing sends on its own.
    const pending = updateLaunchStatus(SALT, 8453, { phase: 'pending', hash: first, safe: false, walletReturned: true })
    const raw = encodeLaunchSession(updateLaunchStatus(SALT, 8453, { phase: 'confirmed', hash: first, safe: false, walletReturned: true, projectId: '42' }, undefined, pending.statuses[8453]))
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: FUND_LAUNCH_KEY, newValue: raw })) })
    await settle(); await settle()
    expect(wallet.writeContract).toHaveBeenCalledOnce()
  })

  it('stops when the first settles without success', async () => {
    twoChains()
    verification.launch = async () => 42n
    await render()
    await click('Continue creation')
    expect(wallet.writeContract).toHaveBeenCalledOnce()
    await act(async () => { wallet.confirm(first, 10n, 'reverted') })
    await settle(); await settle(); await settle()
    expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).statuses[8453].phase).not.toBe('confirmed')
    expect(wallet.writeContract).toHaveBeenCalledOnce()
  })
})

/** A deployment sent here, read as ready again (its wallet reply lost), then placed and settled while the page is away. */
async function launchSettledAway() {
  save({ phase: 'ready' })
  await render()
  await click('Review and deploy FUND')
  expect(wallet.writeContract).toHaveBeenCalledOnce()
  const hash = `0x${'1'.padStart(64, '0')}` as Hex
  const pending = decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).statuses[8453]
  updateLaunchStatus(SALT, 8453, { phase: 'ready' }, 'pending', pending)
  await act(async () => root.unmount()); root = createRoot(host)
  await act(async () => { wallet.confirm(hash) })
  const { holds } = await import('@/lib/write-hold')
  const hold = holds.open({ chainId: 8453, account: OWNER, safe: false, namespace: launchIntent(SALT), call: { to: OWNER, data: '0x' } })
  expect(await hold.onReceipt(await wallet.client.getTransactionReceipt({ hash }) as never, wallet.client as never)).toMatchObject({ status: 'clear', settled: { result: 'success' } })
  return hash
}

it('records a FUND its hold settled while the page was away, and never offers that deployment again', async () => {
  verification.launch = async () => 42n
  await launchSettledAway()
  await render()
  expect(saved()).toMatchObject({ phase: 'confirmed', projectId: '42' })
  expect(button('Review and deploy FUND')).toBeUndefined()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('sends nothing when Continue is pressed while recovery of a deployment settled away is still reading the chain', async () => {
  verification.launch = async () => 42n
  const hash = await launchSettledAway()
  // The receipt read is slow; Continue is pressed meanwhile.
  const chainReceipt = wallet.client.getTransactionReceipt.getMockImplementation()!
  let answer!: () => void
  const slow = new Promise<void>(resolve => { answer = resolve })
  wallet.client.getTransactionReceipt.mockImplementation(async args => { await slow; return chainReceipt(args) })
  await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
  if (button('Continue creation')) await act(async () => button('Continue creation')!.click())
  await act(async () => { answer() })
  await settle(); await settle(); await settle()
  expect(saved()).toMatchObject({ phase: 'confirmed', hash })
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

it('keeps a deployment that settled away as done when it cannot be shown: never a check, never deployed again, never discarded', async () => {
  verification.launch = async () => { throw new Error('Not this launch') }
  await launchSettledAway()
  await render()
  // A settled success always wins: it went through, and its only action is to check again.
  expect(host.textContent).toContain(HELD_SUCCESS_LINE)
  expect(host.textContent).not.toContain(SAVED_ATTEMPT_CHECK_LINE)
  expect(button('Review and deploy FUND')?.disabled).toBe(true)
  await click('Check again')
  expect(button('Review and deploy FUND')?.disabled).toBe(true)
  // Its result isn't recorded yet: the launch can't be discarded.
  if (button('Discard and edit details')) await click('Discard and edit details')
  expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
  expect(wallet.writeContract).toHaveBeenCalledOnce()
})

/**
 * The nine gaps the recovery audit found on main (ALIGN/hr-inv.md), each closed by the SDK's
 * saved-attempt recovery and pinned here (gaps 2, 3, 7 and 8 live with the payer, shop and Sticky suites).
 */
describe('recovery audit gaps', () => {
  const holdOf = async (namespace: string, submittedAt: number) => {
    const { holds } = await import('@/lib/write-hold')
    const hold = holds.open({ chainId: 8453, account: OWNER, safe: false, namespace, call: { to: OWNER, data: '0x' } })
    return hold.adopt(await hold.state(wallet.client as never), { submittedAt }, wallet.client as never)
  }

  it('gap 1: a saved submission with no hold record and nothing on chain is never sendable on that absence', async () => {
    // An unproven failure the wallet never confirmed: the chain doesn't know its hash, and no hold remembers it.
    save({ phase: 'reverted', hash: `0x${'ee'.repeat(32)}` as Hex })
    await render()
    expect(button('Review and deploy FUND')?.disabled ?? true).toBe(true)
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  it('gap 4: a saved launch its builder now refuses still shows its held write and exit', async () => {
    // Mixing a testnet into a mainnet launch: the builder refuses it, the record still loads.
    saveLaunch({ version: 1, name: 'Test asset', input: { owner: OWNER, sender: OWNER, chainIds: [8453, 84532], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt: SALT, mustStartAtOrAfter: 1_000, creationFees: { 8453: 0n, 84532: 0n } }, statuses: { 8453: { phase: 'ready' }, 84532: { phase: 'ready' } } })
    expect(await holdOf(launchIntent(SALT), Date.now() - 31 * 60_000)).toMatchObject({ status: 'held-no-hash' })
    await render()
    expect(button(EXIT), host.textContent ?? '').toBeDefined()
    expect(button('Review and deploy FUND')?.disabled ?? true).toBe(true)
  })

  it('gap 5: an exit the chain refuses (the write settled meanwhile) never reopens the launch', async () => {
    save({ phase: 'ready' })
    verification.launch = async () => 42n
    await render()
    await click('Review and deploy FUND')
    const hash = `0x${'1'.padStart(64, '0')}` as Hex
    expect(saved()).toMatchObject({ phase: 'pending', hash })
    // The node forgets the hash for over half an hour: the hold offers its warned exit.
    const known = wallet.client.getTransaction.getMockImplementation()!, chainReceipt = wallet.client.getTransactionReceipt.getMockImplementation()!
    wallet.client.getTransaction.mockImplementation(async () => null)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000)
    try {
      await act(async () => root.unmount()); root = createRoot(host)
      await render(); await settle()
      expect(button(EXIT), host.textContent ?? '').toBeDefined()
      // It is mined, and only the exit's own last look at the chain finds it: the exit is refused, and the success is recorded.
      const sent = (await known({ hash }))!
      const placed = { blockNumber: 10n, blockHash: `0x${'0a'.repeat(32)}` as Hex, transactionIndex: 0 }
      wallet.client.getTransaction.mockImplementation(async () => ({ ...sent, ...placed }) as never)
      wallet.client.getTransactionReceipt.mockImplementation(async () => ({ status: 'success', transactionHash: hash, from: sent.from, to: sent.to, logs: [], ...placed }) as never)
      wallet.client.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? 1_000n, hash: blockNumber === 10n ? placed.blockHash : `0x${'0b'.repeat(32)}`, timestamp: 1_000n }) as never)
      await click(EXIT); await settle(); await settle()
      expect(saved(), host.textContent ?? '').toMatchObject({ phase: 'confirmed', projectId: '42' })
      expect(wallet.writeContract).toHaveBeenCalledOnce()
    } finally { clock.mockRestore(); wallet.client.getTransactionReceipt.mockImplementation(chainReceipt) }
  })

  it('gap 6: the user’s check is kept across a reload, and the launch reopens once', async () => {
    // A legacy attempt that saved neither hash nor nonce: nothing can show it, so only the user's check reopens it.
    save({ phase: 'signing', safe: false, attemptId: '11111111-1111-4111-8111-111111111111' })
    await render()
    await click(checkedItLabel('Deploy again'))
    expect(saved().phase).toBe('ready')
    await act(async () => root.unmount()); root = createRoot(host)
    await render()
    expect(host.textContent).not.toContain(SAVED_ATTEMPT_CHECK_LINE)
    expect(button('Review and deploy FUND')?.disabled).toBe(false)
  })

  it('gap 9: a launch whose write settled with a result not yet recorded is never discarded', async () => {
    verification.launch = async () => { throw new Error('The RPC has not caught up') }
    await launchSettledAway()
    await render()
    if (button('Discard and edit details')) await click('Discard and edit details')
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
    // Nor can a change of networks discard it.
    await act(async () => root.render(<FundDeploy values={{ networkEnvironment: 'production', networks: ['optimism'] } as unknown as CreateValues} />))
    await settle(); await settle()
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
  })
})
