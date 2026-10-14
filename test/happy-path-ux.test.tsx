/**
 * The normal path stays as it was on main: on launch, pay and cash-out, one press reaches the wallet
 * once, with no recovery notice before or after. Run against main's worktree with the same file to
 * compare (the click counts and notices printed match).
 */
import './dialog-shim'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from 'viem'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'

vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
/** The chain the wallet is on. */
const connected = vi.hoisted(() => ({ chainId: 8453 }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), getAccount: () => ({ address: wallet.account, chainId: connected.chainId }), getPublicClient: () => wallet.client }
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
import { FundDeploy } from '../src/components/LiveCreate'
import type { CreateValues } from '../src/components/CreateFlow'
import { saveLaunch } from '../src/lib/fund-launch-session'
import { useSafeTx } from '../src/hooks/useSafeTx'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x2222222222222222222222222222222222222222' as Address
const SALT = `0x${'12'.repeat(32)}` as Hex
/** Any recovery wording on screen means the normal path grew a step. */
const NOTICE = /checked|went through|held|Check your wallet|Send it again|may already be/i

let host: HTMLDivElement
let root: Root
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
let clicks = 0
async function click(text: string) { expect(button(text), `${text}: ${host.textContent}`).toBeDefined(); clicks += 1; await act(async () => button(text)!.click()); await settle(); await settle() }
/** Presses until the wallet opens, then reports the presses and the time it took. */
async function toWallet(press: () => Promise<void>) {
  const started = performance.now()
  await press()
  return { clicks, writes: wallet.writeContract.mock.calls.length, reviews: wallet.requestReview.mock.calls.length, ms: Math.round(performance.now() - started) }
}

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks(); clicks = 0
  wallet.reset(); wallet.connect(OWNER)
  connected.chainId = 8453
  wallet.client.getChainId.mockImplementation(async () => 8453)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear() })

it('launch: one press reaches the wallet once, with no recovery notice', async () => {
  saveLaunch({ version: 1, name: 'Test asset', input: { owner: OWNER, sender: OWNER, chainIds: [8453], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt: SALT, mustStartAtOrAfter: 0, creationFees: { 8453: 0n } }, statuses: { 8453: { phase: 'ready' } } })
  await act(async () => root.render(<FundDeploy values={{} as CreateValues} />)); await settle(); await settle()
  expect(host.textContent).not.toMatch(NOTICE)
  const result = await toWallet(() => click('Review and deploy FUND'))
  console.info('happy path launch', JSON.stringify(result))
  expect(result).toMatchObject({ clicks: 1, writes: 1, reviews: 1 })
  expect(host.textContent).not.toMatch(NOTICE)
})

const PAY = parseAbi(['function pay(uint256 projectId, address token, uint256 amount, address beneficiary, uint256 minReturnedTokens, string memo, bytes metadata) payable returns (uint256)'])
const CASH_OUT = parseAbi(['function cashOutTokensOf(address holder, uint256 projectId, uint256 cashOutCount, address tokenToReclaim, uint256 minTokensReclaimed, address beneficiary, bytes metadata) returns (uint256)'])
function Action({ label, request, namespace }: { label: string; request: Parameters<ReturnType<typeof useSafeTx>['send']>[0]; namespace: string }) {
  const tx = useSafeTx(8453)
  const [done, setDone] = useState(false)
  return <><button type="button" onClick={() => void tx.send(request, { reviewedAccount: OWNER, recoveryNamespace: namespace }).then(() => setDone(true))}>{label}</button>{done && <p>{tx.notice}</p>}</>
}

it.each([
  ['pay', { chainId: 8453, address: TERMINAL, abi: PAY, functionName: 'pay', args: [7n, '0x000000000000000000000000000000000000EEEe', 10n ** 15n, OWNER, 0n, '', '0x'], value: 10n ** 15n }],
  ['cash-out', { chainId: 8453, address: TERMINAL, abi: CASH_OUT, functionName: 'cashOutTokensOf', args: [OWNER, 7n, 10n ** 18n, '0x000000000000000000000000000000000000EEEe', 0n, OWNER, '0x'] }],
] as const)('%s: one press reaches the wallet once, with no recovery notice', async (name, request) => {
  void encodeFunctionData; void erc20Abi
  await act(async () => root.render(<Action label={`Review ${name}`} request={request as never} namespace={`intent:${name}:happy-path`} />)); await settle()
  const result = await toWallet(() => click(`Review ${name}`))
  console.info(`happy path ${name}`, JSON.stringify(result))
  expect(result).toMatchObject({ clicks: 1, writes: 1, reviews: 1 })
  expect(host.textContent).not.toMatch(NOTICE)
})
