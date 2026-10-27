/**
 * One in-app confirmation per action: the site's own review provider and
 * dialog, the real useReviewedAction and core's reviewed run. An action with
 * an approval opens one review for all its steps, sends each step to the
 * wallet once, and its progress dialog has no confirm of its own.
 */
import './dialog-shim'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toFunctionSelector, type Address } from 'viem'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const TERMINAL = '0x3333333333333333333333333333333333333333' as Address
const USDC = '0x7777777777777777777777777777777777777777' as Address
const UNIT = 10n ** 6n
/** Relayr's payment contract as deployed, whose code hash core pins. */
const RELAYR_PAYMENT_RUNTIME = '0x608060405260043610156010575f80fd5b5f3560e01c63103903a7146022575f80fd5b604036600319011260ef576004356fffffffffffffffffffffffffffffffff19811680910360ef5760243564ffffffffff811680910360ef5780421160ce575f341560c6575b5f8080809373755ff2f75a0a586ecfa2b9a3c959cb662458a1053491f11560bb5760407fb96b060a9c075a83da0cf1f9405deeb5df21df681a762de16c3d5eaf99531cd8918151903482526020820152a2005b6040513d5f823e3d90fd5b506108fc6068565b90630f01bd8760e21b5f5260045260245264ffffffffff421660445260645ffd5b5f80fdfea26469706673582212206ea0d2ba1e0cb26cc9293b24f1a7aecc1de7e328ca83d6b3bf5382ac44c7390064736f6c634300081a0033'

vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
const center = vi.hoisted(() => ({ getIntent: vi.fn(), requestDeploy: vi.fn(), requestRelay: vi.fn(), recordDeployment: vi.fn() }))
vi.mock('@/lib/jbcenter-client', () => ({ jbCenterClient: center }))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({ ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(), getProjectCreationFee: async () => 17n }))
// A destination proven onchain creates its project; reading the project's own logs is fund-launch-verification's test.
vi.mock('@/lib/fund-launch-verification', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/fund-launch-verification')>(), verifyFundLaunch: async () => 9n }))
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }) }))
const connectorDrift = vi.hoisted(() => ({ on: false, reads: 0 }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet, walletCore } = await import('./support/fake-wallet')
  // While `connectorDrift.on`, every read sees a new connector, so the adapter refuses before it calls the wallet.
  return { ...(await importOriginal<typeof import('@wagmi/core')>()), ...walletCore, getAccount: () => ({ address: wallet.account, chainId: wallet.chainId,
    connector: { id: 'injected', uid: connectorDrift.on ? `drift-${connectorDrift.reads++}` : 'injected' } }) }
})
vi.mock('wagmi', async importOriginal => {
  const { wallet, walletHooks } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('wagmi')>()), ...walletHooks, useAccount: () => ({ address: wallet.useAccount(), chainId: 1 }) }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('./support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))
// No fee-buyback reads: the notice stays in its unknown state.
vi.mock('@/lib/fee-buyback-client', () => ({ feeBuybackContext: () => { throw new Error('No fee-buyback reads in this test.') } }))
vi.mock('@/lib/project-pay-quote', () => ({
  prepareProjectPayQuote: async () => ({ terminal: TERMINAL, preview: { beneficiaryTokenCount: 100n * 10n ** 18n, reservedTokenCount: 0n }, minimumTokenCount: 99n * 10n ** 18n, reservedTokenCount: 0n, metadata: '0x', blockNumber: 100n, quoteFailed: false }),
  readProjectPayTokenOptions: async () => [{ token: USDC, terminal: TERMINAL, decimals: 6, symbol: 'USDC', viaRouter: false }],
}))

import { sentHash, wallet } from './support/fake-wallet'
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { ProjectPayment } from '@/components/ProjectPayment'
import { DeployChains } from '@/components/DeployChains'
import { SAFE_FACTORY } from '@/lib/create-multisig'
import { deployment, launchReceipt, safeAddress, safeIntent, safeRelayRequest } from './fixtures/deploy-chains'
import { runRelayrLaunch } from '@/lib/fund-launch-relayr'
import { saveLaunch, type FundLaunchSession } from '@/lib/fund-launch-session'
import { RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR } from '@bananapus/nana-sdk-core/review/relayr'

let host: HTMLDivElement
let root: Root
let cache: QueryClient
let reviews: number
let observer: MutationObserver
const settle = () => act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 20)) })
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const reviewOpen = () => !!document.querySelector('button[aria-label="Cancel transaction review"]')

beforeEach(() => {
  localStorage.clear(); installRecoveryLocks()
  wallet.reset(); wallet.connect(WALLET)
  // The allowance the terminal has: the approval's, once the wallet sent it.
  wallet.client.readContract.mockImplementation(async ({ functionName }) => {
    if (functionName === 'allowance') return wallet.writes().length ? 2n * UNIT : 0n
    throw new Error(`Unexpected read ${functionName}`)
  })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  // Each review dialog the provider renders, counted as it opens.
  reviews = 0
  let open = false
  observer = new MutationObserver(() => { const now = reviewOpen(); if (now && !open) reviews++; open = now })
  observer.observe(document.body, { childList: true, subtree: true })
})
afterEach(async () => { connectorDrift.on = false; observer.disconnect(); await act(async () => root.unmount()); host.remove(); cache.clear(); localStorage.clear() })

it('wallet-action:one-confirmation pay', async () => {
  await act(async () => root.render(<QueryClientProvider client={cache}><TransactionReviewProvider>
    <ProjectPayment chainId={1} projectId={7n} tokenLabel="FUND" title="Contribute" context={{ token: USDC, terminal: TERMINAL, decimals: 6, symbol: 'USDC' }}
      paused={false} reservedPercent={0} rulesetId="1" verify={async (_account, minimumBlock) => ({ blockNumber: minimumBlock ?? 100n })} />
  </TransactionReviewProvider></QueryClientProvider>))
  const input = host.querySelector('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '2'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await settle()
  await act(async () => buttons().find(button => button.textContent === 'Pay on Ethereum')!.click())
  await vi.waitFor(async () => { await settle(); expect(reviewOpen()).toBe(true) })

  // The approval and the payment are one review, and the progress behind it has no confirm.
  const review = document.querySelector('button[aria-label="Cancel transaction review"]')!.closest('dialog')!
  expect(review.textContent).toMatch(/approve/i)
  expect(review.textContent).toMatch(/pay/i)
  expect(buttons().some(button => /^Confirm & /.test(button.textContent ?? ''))).toBe(false)
  await act(async () => review.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  // Its one confirm; with no fee-return reads here it sends without that estimate.
  const confirm = () => buttons().find(button => button.textContent === 'Submit without estimate')
  await vi.waitFor(async () => { await settle(); expect(confirm()?.disabled).toBe(false) })
  await act(async () => confirm()!.click())

  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledOnce() })
  await act(async () => wallet.confirm(sentHash(1), 101n))
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledTimes(2) })
  await act(async () => wallet.confirm(sentHash(2), 102n))
  await settle()

  expect(reviews).toBe(1)
  // One wallet send per step: the exact approval to the token, then the payment to the terminal.
  expect(wallet.sent().map(sent => [sent.to, sent.data.slice(0, 10)])).toEqual([[USDC, toFunctionSelector('approve(address,uint256)')], [TERMINAL, expect.any(String)]])
  expect(buttons().some(button => /^Confirm & /.test(button.textContent ?? ''))).toBe(false)
})

it('a refusal before the wallet is called releases the held step', async () => {
  await act(async () => root.render(<QueryClientProvider client={cache}><TransactionReviewProvider>
    <ProjectPayment chainId={1} projectId={7n} tokenLabel="FUND" title="Contribute" context={{ token: USDC, terminal: TERMINAL, decimals: 6, symbol: 'USDC' }}
      paused={false} reservedPercent={0} rulesetId="1" verify={async (_account, minimumBlock) => ({ blockNumber: minimumBlock ?? 100n })} />
  </TransactionReviewProvider></QueryClientProvider>))
  const input = host.querySelector('input')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '2'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await settle()
  const payAndConfirm = async (label: string) => {
    await act(async () => buttons().find(button => button.textContent === label)!.click())
    await vi.waitFor(async () => { await settle(); expect(reviewOpen()).toBe(true) })
    const review = document.querySelector('button[aria-label="Cancel transaction review"]')!.closest('dialog')!
    await act(async () => review.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    const confirm = () => buttons().find(button => button.textContent === 'Submit without estimate')
    await vi.waitFor(async () => { await settle(); expect(confirm()?.disabled).toBe(false) })
    await act(async () => confirm()!.click())
  }
  // The connector keeps changing once the review is confirmed: the wallet is never called.
  connectorDrift.on = true
  await payAndConfirm('Pay on Ethereum')
  await vi.waitFor(async () => { await settle(); expect(host.textContent).toContain('Wallet connection changed') })
  expect(wallet.writeContract).not.toHaveBeenCalled()
  expect(buttons().some(button => button.textContent === 'I checked my wallet')).toBe(false)

  // Nothing was sent, so nothing is held: the same payment is reviewed and sent at once.
  connectorDrift.on = false
  await payAndConfirm('Try again')
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledOnce() })
})

/** DeployChains for a chain the wallet pays for, whose multisig is created before the project, under the site's review. */
async function renderDeploy() {
  const value = safeIntent([1])
  center.getIntent.mockResolvedValue(value)
  center.requestDeploy.mockResolvedValue({ deploys: [] })
  center.requestRelay.mockImplementation(async (_id: string, chainId: number) => safeRelayRequest(chainId))
  center.recordDeployment.mockResolvedValue(deployment(1, '9'))
  wallet.client.readContract.mockImplementation(async ({ functionName }) => {
    if (functionName === 'creationFee') return 0n
    throw new Error(`Unexpected read ${functionName}`)
  })
  Object.assign(wallet.client, { getGasPrice: vi.fn(async () => 2_000_000_000n), getCode: vi.fn(async () => '0x') })
  await act(async () => root.render(<QueryClientProvider client={cache}><TransactionReviewProvider>
    <DeployChains intent={value as never} heading="Deploy" chainIds={value.envelope.chainIds} />
  </TransactionReviewProvider></QueryClientProvider>))
  await settle()
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"][value="1"]')!.click())
}
/** Presses deploy and confirms its one review. */
async function deployAndConfirm(label: string, confirmLabel = 'Continue to wallet') {
  await act(async () => buttons().find(button => button.textContent === label)!.click())
  await vi.waitFor(async () => { await settle(); expect(reviewOpen()).toBe(true) })
  const review = document.querySelector('button[aria-label="Cancel transaction review"]')!.closest('dialog')!
  expect(buttons().some(button => /^Confirm & /.test(button.textContent ?? ''))).toBe(false)
  await act(async () => review.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  const confirm = () => buttons().find(button => button.textContent === confirmLabel)
  await vi.waitFor(async () => { await settle(); expect(confirm()?.disabled).toBe(false) })
  await act(async () => confirm()!.click())
  return review
}

it('wallet-action:one-confirmation deploy chains', async () => {
  await renderDeploy()
  // The multisig and the project are one review.
  const review = await deployAndConfirm('Deploy selected')
  expect(review.textContent).toMatch(/multisig/i)

  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledOnce() })
  await act(async () => wallet.confirm(sentHash(1), 101n))
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledTimes(2) })
  await act(async () => wallet.confirm(sentHash(2), 102n, 'success', launchReceipt(1, 9n, safeAddress).logs))
  await vi.waitFor(async () => { await settle(); expect(center.recordDeployment).toHaveBeenCalled() })

  expect(reviews).toBe(1)
  // One wallet send per step: the multisig, then the forwarded launch.
  const request: ReturnType<typeof safeRelayRequest> = await center.requestRelay.mock.results.at(-1)!.value
  expect(wallet.sent().map(sent => [sent.to, sent.data])).toEqual([[SAFE_FACTORY.toLowerCase(), request.setup[0].data], [request.to.toLowerCase(), request.data]])
  expect(buttons().some(button => /^Confirm & /.test(button.textContent ?? ''))).toBe(false)
})

it('deploy chains: a launch the wallet rejected after its multisig was created finishes on the next try', async () => {
  await renderDeploy()
  await deployAndConfirm('Deploy selected')
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledOnce() })
  wallet.writeContract.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
  await act(async () => wallet.confirm(sentHash(1), 101n))
  await vi.waitFor(async () => { await settle(); expect(host.querySelector('[role="alert"]')?.textContent).toBe('The wallet did not send the transaction.') })

  // The multisig exists now: the retry reviews and sends only the launch.
  Object.assign(wallet.client, { getCode: vi.fn(async ({ address }: { address: string }) => address.toLowerCase() === safeAddress.toLowerCase() ? '0x6000' : '0x') })
  await deployAndConfirm('Deploy selected')
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledTimes(3) })
  await act(async () => wallet.confirm(sentHash(2), 102n, 'success', launchReceipt(1, 9n, safeAddress).logs))
  await vi.waitFor(async () => { await settle(); expect(center.recordDeployment).toHaveBeenCalled() })
  expect(reviews).toBe(2)
  const request: ReturnType<typeof safeRelayRequest> = await center.requestRelay.mock.results.at(-1)!.value
  expect(wallet.sent().at(-1)).toMatchObject({ to: request.to.toLowerCase(), data: request.data })
})

it('deploy chains: a launch sent before a reload is recorded on the next try, with no new review or relay', async () => {
  await renderDeploy()
  await deployAndConfirm('Deploy selected')
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledOnce() })
  await act(async () => wallet.confirm(sentHash(1), 101n))
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledTimes(2) })
  // The page reloads while the launch is pending, and the launch lands meanwhile.
  wallet.forget()
  await act(async () => root.unmount())
  root = createRoot(host)
  await act(async () => wallet.confirm(sentHash(2), 102n, 'success', launchReceipt(1, 9n, safeAddress).logs))
  const relays = center.requestRelay.mock.calls.length
  await renderDeploy()
  await act(async () => buttons().find(button => button.textContent === 'Deploy selected')!.click())
  await vi.waitFor(async () => { await settle(); expect(center.recordDeployment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ chainId: 1, projectId: '9', transactionHash: sentHash(2) }), expect.anything()) })
  expect(reviews).toBe(1)
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
  expect(center.requestRelay.mock.calls.length).toBe(relays)
})

it('deploy chains: a launch the wallet may have sent waits for the wallet check, then is reviewed again', async () => {
  await renderDeploy()
  await deployAndConfirm('Deploy selected')
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledOnce() })
  wallet.writeContract.mockRejectedValueOnce(new Error('Internal JSON-RPC error.'))
  await act(async () => wallet.confirm(sentHash(1), 101n))
  const alert = () => host.querySelector('[role="alert"]')?.textContent
  await vi.waitFor(async () => { await settle(); expect(alert()).toBe('Your wallet may have sent this transaction. Check its activity before you try again.') })
  const check = () => buttons().find(button => button.textContent === 'I checked my wallet')
  expect(check()).toBeDefined()
  // Until the visitor checks, the launch is held: nothing is sent.
  await act(async () => buttons().find(button => button.textContent === 'Deploy selected')!.click())
  await settle()
  expect(wallet.writeContract).toHaveBeenCalledTimes(2)
  await act(async () => check()!.click())
  await vi.waitFor(async () => { await settle(); expect(check()).toBeUndefined() })

  // The saved launch, as first reviewed, is reviewed once more and sent.
  await deployAndConfirm('Deploy selected', 'Agree & continue')
  await vi.waitFor(async () => { await settle(); expect(wallet.writeContract).toHaveBeenCalledTimes(3) })
  await act(async () => wallet.confirm(sentHash(2), 102n, 'success', launchReceipt(1, 9n, safeAddress).logs))
  await vi.waitFor(async () => { await settle(); expect(center.recordDeployment).toHaveBeenCalled() })
  expect(reviews).toBe(2)
})

it('wallet-action:one-confirmation fund launch with Relayr', async () => {
  // Relayr: each posted bundle quoted on Ethereum and Optimism, its records pending until the payment lands.
  const now = Math.floor(Date.now() / 1000)
  const bundles = new Map<string, { records: { tx_uuid: string; request: Record<string, unknown>; status: unknown }[] }>()
  let paid = false
  const destination = (chain: number) => `0x${chain.toString(16).padStart(64, 'd')}` as `0x${string}`
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/bundle/prepaid')) {
      const n = bundles.size + 1
      const uuid = `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
      const { transactions } = JSON.parse(String(init!.body)) as { transactions: Record<string, unknown>[] }
      const records = transactions.map((request, i) => ({ tx_uuid: `00000000-0000-4000-8000-${(n * 100 + i).toString().padStart(12, '0')}`, request, status: { state: 'Pending' } }))
      bundles.set(uuid, { records })
      const deadline = now + 900
      const payment_info = [1, 10].map(chain => ({ chain, amount: '200', target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, payment_deadline: deadline,
        calldata: `${RELAYR_PAYMENT_SELECTOR}${uuid.replaceAll('-', '').padEnd(64, '0')}${deadline.toString(16).padStart(64, '0')}` }))
      return json({ bundle_uuid: uuid, tx_uuids: records.map(record => record.tx_uuid), payment_info, transactions: records })
    }
    const uuid = url.split('/').pop()!
    const { records } = bundles.get(uuid)!
    return json({ bundle_uuid: uuid, payment_received: paid, transactions: paid
      ? records.map(record => ({ ...record, status: { state: 'Success', data: { hash: destination(record.request.chain as number) } } }))
      : records })
  }))
  // Each chain's reads: an ordinary wallet, the deployed forwarder, and launches that estimate and verify.
  const forwarded = new Map<string, Record<string, unknown>>()
  wallet.client.readContract.mockImplementation(async ({ functionName }) => {
    if (functionName === 'nonces') return 0n
    if (functionName === 'isTrustedForwarder' || functionName === 'verify') return true
    throw new Error(`Unexpected read ${functionName}`)
  })
  const own = { getTransaction: wallet.client.getTransaction.getMockImplementation()!, getTransactionReceipt: wallet.client.getTransactionReceipt.getMockImplementation()! }
  Object.assign(wallet.client, {
    getCode: vi.fn(async ({ address }: { address: string }) => address.toLowerCase() === WALLET.toLowerCase() ? '0x'
      : address.toLowerCase() === RELAYR_PAYMENT_ADDRESS.toLowerCase() ? RELAYR_PAYMENT_RUNTIME : '0x6000'),
    call: vi.fn(async () => ({ data: '0x' })),
    getGasPrice: vi.fn(async () => 1_000_000_000n),
  })
  wallet.client.getTransaction.mockImplementation(async ({ hash }) => (forwarded.get(hash.toLowerCase()) as never) ?? own.getTransaction({ hash }))
  wallet.client.getTransactionReceipt.mockImplementation(async ({ hash }) => {
    const transaction = forwarded.get(hash.toLowerCase())
    return transaction ? { status: 'success', transactionHash: hash, to: transaction.to, blockHash: transaction.blockHash, blockNumber: transaction.blockNumber, logs: [] } as never : own.getTransactionReceipt({ hash })
  })

  const session: FundLaunchSession = { version: 1, name: 'Asset', transport: 'relayr',
    input: { owner: WALLET, sender: WALLET, chainIds: [1, 10], projectUri: 'ipfs://launch', tokenName: 'House FUND', ticker: 'HOUSE',
      salt: `0x${'cc'.repeat(32)}`, mustStartAtOrAfter: now, creationFees: { 1: 17n, 10: 17n } },
    statuses: { 1: { phase: 'ready' }, 10: { phase: 'ready' } } } as never
  saveLaunch(session)
  await act(async () => root.render(<QueryClientProvider client={cache}><TransactionReviewProvider><span /></TransactionReviewProvider></QueryClientProvider>))
  let launched!: Promise<void>
  await act(async () => { launched = runRelayrLaunch({ session, account: WALLET, onStatus: () => {}, onProgress: () => {} }) })
  let failure: unknown
  launched.catch(error => { failure = error })
  const running = () => { if (failure) throw failure }
  await vi.waitFor(async () => { await settle(); running(); expect(reviewOpen()).toBe(true) })

  // Both launches and Relayr's fee are one review, with no confirm behind it.
  const review = document.querySelector('button[aria-label="Cancel transaction review"]')!.closest('dialog')!
  expect(review.textContent).toMatch(/relayr/i)
  expect(buttons().some(button => /^Confirm & /.test(button.textContent ?? ''))).toBe(false)
  await act(async () => review.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  const confirm = () => buttons().find(button => button.textContent === 'Continue to wallet')
  await vi.waitFor(async () => { await settle(); running(); expect(confirm()?.disabled).toBe(false) })
  await act(async () => confirm()!.click())

  // The payment, once both launches are signed: Relayr then runs each one.
  await vi.waitFor(async () => { await settle(); running(); expect(wallet.writeContract).toHaveBeenCalledOnce() })
  for (const { records } of bundles.values()) for (const { request } of records) {
    forwarded.set(destination(request.chain as number), { hash: destination(request.chain as number), chainId: request.chain, to: request.target, input: request.data,
      value: BigInt(request.value as string), blockHash: sentHash(500), blockNumber: 500n, transactionIndex: 0 })
  }
  paid = true
  await act(async () => wallet.confirm(sentHash(1), 101n))
  await act(async () => launched)

  expect(reviews).toBe(1)
  // One wallet prompt per step: a signature for each chain, then one payment.
  expect(wallet.signTypedData.mock.calls.map(([request]) => Number(request.domain?.chainId))).toEqual([1, 10])
  expect(wallet.sent().map(sent => [sent.chainId, sent.to])).toEqual([[1, RELAYR_PAYMENT_ADDRESS.toLowerCase()]])
  expect(buttons().some(button => /^Confirm & /.test(button.textContent ?? ''))).toBe(false)
  vi.unstubAllGlobals()
})
