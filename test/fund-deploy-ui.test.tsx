import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeFunctionData, parseAbi, zeroAddress, type Hex } from 'viem'
import type { CreateValues } from '../src/components/CreateFlow'
import { buildFundLaunch } from '../src/lib/fund-contracts'
import { FUND_LAUNCH_KEY, decodeLaunchSession, launchIntent, multisigSetupIntent, saveLaunch, updateLaunchStatus, type FundLaunchSession } from '../src/lib/fund-launch-session'
import { safeExecutionLog } from './support/safe-logs'
import { installRecoveryLocks } from './runtime/write-recovery-fixture'
import { checkedItLabel, SAVED_ATTEMPT_CHECK_LINE } from '@bananapus/nana-sdk-core/review'
import type { TxRequest } from '../src/hooks/useSafeTx'
import { multisigDeploymentRequest, predictMultisig, type CreateMultisig } from '../src/lib/create-multisig'

const runtime = vi.hoisted(() => ({ txPhase: 'idle', txReceipt: null as unknown, verifyLaunch: vi.fn(), txError: '' as string, submissionHash: undefined as Hex | undefined, safe: false, send: vi.fn(), track: vi.fn(), adopt: vi.fn(), readContract: vi.fn(), getBlock: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), waitReceipt: vi.fn(), waitSafe: vi.fn(), checkMultisigs: vi.fn(), verifyMultisigs: vi.fn(), publish: vi.fn(), checkDeployment: vi.fn(), relayr: vi.fn(), requestsDead: vi.fn() }))
const navigate = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => navigate }))
const owner = '0x1111111111111111111111111111111111111111' as const
const salt = `0x${'12'.repeat(32)}` as Hex
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }), getPublicClient: () => ({ readContract: runtime.readContract, getBlock: runtime.getBlock, getTransaction: runtime.getTransaction, getTransactionReceipt: runtime.getTransactionReceipt, waitForTransactionReceipt: runtime.waitReceipt, getChainId: async () => 8453 }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: '0x1111111111111111111111111111111111111111', isCenterWallet: true }) }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))
vi.mock('@/components/CreateFlow', () => ({ default: () => null }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => runtime.safe, useSafeConnection: () => false, waitForSafeExecutionHash: runtime.waitSafe }))
vi.mock('@/lib/create-multisig', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/create-multisig')>(), checkCreateMultisigs: runtime.checkMultisigs, verifyCreatedMultisigs: runtime.verifyMultisigs }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: runtime.txPhase, receipt: runtime.txReceipt, isSafe: false, busy: false, error: runtime.txError, submissionHash: runtime.submissionHash, send: runtime.send, track: runtime.track, reset: vi.fn() }) }))
vi.mock('@/lib/publish-fund-project-metadata', () => ({ publishFundProjectMetadata: runtime.publish }))
vi.mock('@/lib/fund-launch-verification', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/fund-launch-verification')>(), checkLaunchDeployment: runtime.checkDeployment, verifyFundLaunch: (...args: unknown[]) => runtime.verifyLaunch(...args) }))
vi.mock('@/lib/fund-launch-relayr', () => ({ runRelayrLaunch: runtime.relayr, launchRequestsDead: runtime.requestsDead }))
import { FundDeploy } from '../src/components/LiveCreate'
import CreateSuccess from '../src/components/CreateSuccess'

function saved(): FundLaunchSession {
  return decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)
}
function failedSafeReceipt(request: TxRequest, proposal: Hex, execution: Hex, kind = 'proven failure') {
  const blockHash = `0x${'aa'.repeat(32)}` as Hex
  const mined = { transactionHash: execution, blockHash, blockNumber: 7n, transactionIndex: 0 }
  const receipt = { ...mined, from: owner, to: owner, status: kind === 'outer revert' ? 'reverted' : 'success',
    logs: kind === 'missing event' ? [] : [{ ...safeExecutionLog(owner, proposal, { failed: true }), ...mined, logIndex: 0, removed: false }] }
  runtime.waitReceipt.mockResolvedValue(receipt)
  runtime.getTransactionReceipt.mockResolvedValue(receipt)
  runtime.getTransaction.mockResolvedValue({ ...mined, hash: execution, from: owner, to: owner, value: 0n,
    input: encodeFunctionData({ abi: parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)']), functionName: 'execTransaction', args: [request.address, kind === 'different executed call' ? 1n : request.value ?? 0n, encodeFunctionData(request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) })
  runtime.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => {
    const number = blockNumber ?? (kind === 'nonfinal failure' ? 6n : 10n)
    return { number, hash: number === 7n ? blockHash : `0x${'bb'.repeat(32)}`, timestamp: 1000n }
  })
}

describe('Create submission recovery', () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    localStorage.clear()
    runtime.txError = ''; runtime.txPhase = 'idle'; runtime.txReceipt = null
    runtime.verifyLaunch.mockReset().mockImplementation(async (...args: unknown[]) => (await import('../src/lib/fund-launch-verification')).verifyFundLaunch(...(args as Parameters<typeof import('../src/lib/fund-launch-verification').verifyFundLaunch>)))
    runtime.submissionHash = undefined
    runtime.safe = false
    runtime.send.mockReset()
    runtime.track.mockReset()
    runtime.waitSafe.mockReset(); runtime.waitReceipt.mockReset(); runtime.checkMultisigs.mockReset().mockResolvedValue(undefined); runtime.verifyMultisigs.mockReset().mockResolvedValue(true)
    runtime.getTransaction.mockReset(); runtime.getTransactionReceipt.mockReset()
    runtime.readContract.mockResolvedValue(0n); runtime.getBlock.mockReset().mockResolvedValue({ timestamp: 1000n }); runtime.publish.mockResolvedValue({ cid: 'bafkreimetadata' }); runtime.checkDeployment.mockResolvedValue(undefined)
    installRecoveryLocks()
    saveLaunch({ version: 1, name: 'Test asset', input: { owner, sender: owner, chainIds: [8453], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt, mustStartAtOrAfter: 0, creationFees: { 8453: 0n } }, statuses: { 8453: { phase: 'ready' } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function launch() {
    await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    const button = [...host.querySelectorAll('button')].find(item => item.textContent === 'Review and deploy FUND')!
    await act(async () => button.click())
  }

  describe('a write the launch record saved before SDK holds', () => {
    const ATTEMPT = '11111111-1111-4111-8111-111111111111'
    const FOUND = `0x${'cd'.repeat(32)}` as Hex
    const render = () => act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    const request = () => buildFundLaunch(saved().input).requests[0]
    function withMultisig(multisigSetup: NonNullable<FundLaunchSession['statuses'][number]['multisigSetup']>) {
      const policy = { owners: [owner, '0x2222222222222222222222222222222222222222' as const], threshold: 2, saltNonce: salt, proxyCreationCode: '0x6000' as Hex }
      const plan: CreateMultisig = { ...policy, role: 'operator', address: predictMultisig(policy) }
      const current = saved()
      localStorage.clear()
      saveLaunch({ ...current, input: { ...current.input, operator: plan.address, multisigs: [plan] }, statuses: { 8453: { phase: 'ready', multisigSetup } } })
      return plan
    }

    const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent === text)
    async function checked(label: string) {
      await vi.waitFor(() => expect(host.textContent).toContain(SAVED_ATTEMPT_CHECK_LINE))
      await act(async () => button(label)!.click())
    }

    it('adopts a hashless launch with its saved nonce into the launch’s hold, and the record reopens', async () => {
      updateLaunchStatus(salt, 8453, { phase: 'signing', safe: false, attemptId: ATTEMPT, nonce: '5', fromBlock: '90' })
      await render()
      await vi.waitFor(() => expect(saved().statuses[8453]).toEqual({ phase: 'ready' }))
      expect(runtime.track).toHaveBeenCalledWith(expect.objectContaining({ chainId: 8453 }), expect.objectContaining({ reviewedAccount: owner, recoveryNamespace: launchIntent(salt) }))
      expect(runtime.send).not.toHaveBeenCalled()
    })

    it('records the outcome of a hashless attempt the hold later settles, from ready', async () => {
      updateLaunchStatus(salt, 8453, { phase: 'signing', safe: false, attemptId: ATTEMPT, nonce: '5', fromBlock: '90' })
      await render()
      await vi.waitFor(() => expect(saved().statuses[8453]).toEqual({ phase: 'ready' }))
      // The SDK found the attempt at its nonce and settled it: its verified receipt reaches the launch.
      const receipt = { transactionHash: FOUND, blockNumber: 9n, status: 'success', logs: [] }
      runtime.getTransactionReceipt.mockResolvedValue(receipt)
      runtime.verifyLaunch.mockResolvedValue(42n)
      runtime.txPhase = 'success'; runtime.txReceipt = receipt; runtime.submissionHash = FOUND
      await render()
      await vi.waitFor(() => expect(saved().statuses[8453]).toMatchObject({ phase: 'confirmed', hash: FOUND, projectId: '42' }))
    })

    it('keeps a saved pending hash this chain’s pending launch while it can’t be read, and sends nothing', async () => {
      updateLaunchStatus(salt, 8453, { phase: 'pending', safe: false, hash: FOUND, walletReturned: true })
      runtime.getTransactionReceipt.mockRejectedValue(new Error('receipt unavailable'))
      await render()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      expect(saved().statuses[8453]).toMatchObject({ phase: 'pending', hash: FOUND })
      expect(button('Review and deploy FUND')).toBeUndefined()
      expect(runtime.send).not.toHaveBeenCalled()
    })

    it('asks for the user’s check on a legacy failure without the wallet’s hash, and that check reopens the record with its evidence', async () => {
      const current = saved(), hash = `0x${'ee'.repeat(32)}` as Hex
      localStorage.clear()
      saveLaunch({ ...current, statuses: { 8453: { phase: 'reverted', hash } } })
      await render()
      await checked(checkedItLabel('Deploy again'))
      // Reopened, the chain keeps the retired attempt's hash, so its recovery still reads as retired.
      await vi.waitFor(() => expect(saved().statuses[8453]).toEqual({ phase: 'ready', releasedHash: hash }))
      await render()
      expect(host.textContent).not.toContain(SAVED_ATTEMPT_CHECK_LINE)
    })

    it('treats a multisig setup saved with its nonce as done once its Safes exist, and the record drops it', async () => {
      withMultisig({ safe: false, attemptId: ATTEMPT, nonce: '5', fromBlock: '90' })
      await render()
      // The setup's own search: every planned Safe is deployed.
      await vi.waitFor(() => expect(saved().statuses[8453]).toEqual({ phase: 'ready' }))
      expect(host.textContent).not.toContain(SAVED_ATTEMPT_CHECK_LINE)
    })

    it('adopts a multisig setup saved with its nonce whose Safes are missing into the setup’s hold, and the record drops it', async () => {
      runtime.verifyMultisigs.mockResolvedValue(false)
      withMultisig({ safe: false, attemptId: ATTEMPT, nonce: '5', fromBlock: '90' })
      await render()
      await vi.waitFor(() => expect(saved().statuses[8453]).toEqual({ phase: 'ready' }))
      expect(runtime.track).toHaveBeenCalledWith(expect.objectContaining({ chainId: 8453 }), expect.objectContaining({ recoveryNamespace: multisigSetupIntent(salt) }))
    })

    it('asks for the user’s check on a multisig setup saved with neither hash nor nonce whose Safes are missing, and the record drops it once checked', async () => {
      runtime.verifyMultisigs.mockResolvedValue(false)
      withMultisig({ safe: false, attemptId: ATTEMPT })
      await render()
      await checked(checkedItLabel('Create multisigs again'))
      await vi.waitFor(() => expect(saved().statuses[8453]).toEqual({ phase: 'ready' }))
      expect(runtime.send).not.toHaveBeenCalled()
    })

    it('moves a saved multisig setup proposal into the setup’s hold, and the record drops it', async () => {
      withMultisig({ safe: true, hash: FOUND, walletReturned: true })
      await render()
      await vi.waitFor(() => expect(saved().statuses[8453]).toEqual({ phase: 'ready' }))
      expect(runtime.track).toHaveBeenCalledWith(expect.objectContaining({ chainId: 8453 }), expect.objectContaining({ recoveryNamespace: multisigSetupIntent(salt), safe: true }))
    })
  })

  it('cancels an unsubmitted launch and preserves the setup draft', async () => {
    localStorage.setItem('homerun:create-draft:v1', 'keep this draft')
    await act(async () => root.render(<FundDeploy />))
    const cancel = [...host.querySelectorAll('button')].find(button => button.textContent === 'Discard and edit details')!
    await act(async () => cancel.click())
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    expect(localStorage.getItem('homerun:create-draft:v1')).toBe('keep this draft')
    expect(host.textContent).toContain('Preview your project')
  })

  it('shows pre-wallet errors outside the collapsed recovery controls', async () => {
    runtime.txError = 'Insufficient funds for gas'
    await act(async () => root.render(<FundDeploy />))
    const visibleAlert = [...host.querySelectorAll('[role="alert"]')].find(node => !node.closest('details'))
    expect(visibleAlert?.textContent).toBe('Insufficient funds for gas')
  })

  it('opens the success page after confirmation and links to the created Homerun project', async () => {
    updateLaunchStatus(salt, 8453, { phase: 'signing' })
    updateLaunchStatus(salt, 8453, { phase: 'confirmed', hash: `0x${'ab'.repeat(32)}`, projectId: '42' })
    await act(async () => root.render(<FundDeploy />))
    expect(navigate.replace).toHaveBeenCalledWith('/create/success')
    await act(async () => root.render(<CreateSuccess />))
    expect(host.textContent).toContain('Project created successfully')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/base:42')
  })

  it('does not claim success for an unfinished deployment', async () => {
    await act(async () => root.render(<CreateSuccess />))
    expect(host.textContent).not.toContain('Project created successfully')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/create/recover')
  })

  it('drops an unsigned four-chain plan when the user selects only Base', async () => {
    localStorage.removeItem(FUND_LAUNCH_KEY)
    saveLaunch({ version: 1, name: 'Test asset', transport: 'relayr', input: { owner, sender: owner, chainIds: [1, 10, 8453, 42161], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt, mustStartAtOrAfter: 1000, creationFees: { 1: 0n, 10: 0n, 8453: 0n, 42161: 0n } }, statuses: Object.fromEntries([1, 10, 8453, 42161].map(id => [id, { phase: 'ready' }])) })
    await act(async () => root.render(<FundDeploy values={{ networkEnvironment: 'production', networks: ['base'] } as CreateValues} />))
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    expect(host.textContent).not.toContain('Continue creation')
    expect(host.textContent).toContain('Create with a transaction')
  })

  describe('a relayed launch whose published requests were found dead', () => {
    const settled = () => saveLaunch({ version: 1, name: 'Test asset', transport: 'relayr', input: { owner, sender: owner, chainIds: [1, 10], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt, mustStartAtOrAfter: 1000, creationFees: { 1: 0n, 10: 0n } },
      statuses: { 1: { phase: 'authorized' }, 10: { phase: 'unresolved', error: 'The launch may already have run.' } },
      relayr: { account: owner, phase: 'executing', paymentChainId: 8453, signed: [], records: [], published: true, abandonable: true } })
    const cancel = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Discard and edit details')

    it('says a chain may have run, and offers cancelling', async () => {
      localStorage.removeItem(FUND_LAUNCH_KEY)
      settled()
      await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
      expect(host.querySelector('.fund-launch-progress')?.textContent).toContain('May have run')
      expect(cancel()).toBeDefined()
    })

    it('removes it only once its requests are proven dead again', async () => {
      localStorage.removeItem(FUND_LAUNCH_KEY)
      settled()
      await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
      runtime.requestsDead.mockResolvedValue(false)
      await act(async () => cancel()!.click())
      expect(runtime.requestsDead).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ salt }) }))
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('can still run')
      expect(localStorage.getItem(FUND_LAUNCH_KEY)).not.toBeNull()
      runtime.requestsDead.mockResolvedValue(true)
      await act(async () => cancel()!.click())
      expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
      expect(host.textContent).toContain('Preview your project')
    })

    it('shows no cancel while its requests are not found dead, and calls its chain checking', async () => {
      localStorage.removeItem(FUND_LAUNCH_KEY)
      const live = settled()
      saveLaunch({ ...live, relayr: { ...live.relayr!, abandonable: undefined } })
      await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
      expect(host.querySelector('.fund-launch-progress')?.textContent).toContain('Checking…')
      expect(cancel()).toBeUndefined()
    })
  })

  it('cancelling review leaves the saved launch ready without claiming a wallet submission', async () => {
    runtime.send.mockImplementation(async () => { expect(saved().statuses[8453].phase).toBe('ready'); return null })
    await launch()
    expect(saved().statuses[8453].phase).toBe('ready')
    expect(host.textContent).not.toContain('Check your wallet history')
  })
  it('records a wallet-returned Safe proposal as this chain’s pending launch', async () => {
    runtime.safe = true
    const hash = `0x${'cd'.repeat(32)}` as Hex
    runtime.waitSafe.mockRejectedValue(new Error('Still awaiting signatures'))
    runtime.send.mockImplementation(async () => { expect(saved().statuses[8453].phase).toBe('ready'); return hash })
    await launch()
    expect(saved().statuses[8453]).toMatchObject({ phase: 'pending', safe: true, hash, walletReturned: true })
    expect(host.textContent).toContain('Safe proposal awaiting execution.')
    expect(host.textContent).not.toContain('FUND deployment verified onchain.')
    expect(runtime.send).toHaveBeenCalledOnce()
  })

  it('sends under the launch’s intent as its saved sender, and records nothing before the wallet returns a hash', async () => {
    runtime.send.mockImplementation(async () => { expect(saved().statuses[8453]).toEqual({ phase: 'ready' }); return null })
    await launch()
    expect(runtime.send.mock.calls.at(-1)![1]).toMatchObject({ reviewedAccount: saved().input.sender, recoveryNamespace: launchIntent(salt) })
    expect(saved().statuses[8453]).toEqual({ phase: 'ready' })
  })

  function savedSafeFailure(kind: string) {
    const proposal = `0x${'ef'.repeat(32)}` as Hex, execution = `0x${'cd'.repeat(32)}` as Hex
    const session = saved()
    localStorage.clear()
    saveLaunch({ ...session, statuses: { 8453: { phase: 'pending', hash: proposal, executionHash: execution, safe: true, ...(kind !== 'legacy hash' ? { walletReturned: true as const } : {}) } } })
    failedSafeReceipt(buildFundLaunch(session.input).requests[0], proposal, execution, kind)
    return { proposal, execution }
  }

  it.each(['legacy hash', 'proven failure'])('reopens a Safe launch whose proposal the hold proves failed at a final block: %s', async kind => {
    savedSafeFailure(kind)
    await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    // The SDK's hold authenticates the proposal's own failed execution, final: it can't run again.
    await vi.waitFor(() => expect(saved().statuses[8453].phase).toBe('reverted'))
    expect(host.textContent).toContain('The deployment reverted. No project was created by this transaction.')
    expect(host.textContent).toContain('Review and deploy FUND')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('keeps a Safe launch whose failure is not final yet pending, and its check unresolved', async () => {
    const { proposal } = savedSafeFailure('nonfinal failure')
    await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    const check = [...host.querySelectorAll('button')].find(item => item.textContent === 'Check confirmation')
    if (!check) throw new Error(host.textContent ?? '')
    await act(async () => check.click())
    // Checking asks the launch's hold; only what it settles is verified and recorded.
    expect(runtime.track).toHaveBeenLastCalledWith(expect.objectContaining({ chainId: 8453 }), expect.objectContaining({ recoveryNamespace: launchIntent(salt), safe: true }))
    expect(saved().statuses[8453].phase).toBe('pending')
    runtime.txPhase = 'error'; runtime.txReceipt = await runtime.getTransactionReceipt(); runtime.submissionHash = proposal
    await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(saved().statuses[8453].phase).toBe('pending')
    expect(host.textContent).toContain('Confirmation is unresolved')
    expect(host.textContent).not.toContain('Review and deploy FUND')
  })

  it('requires onchain verification of confirmations restored from a file', async () => {
    const imported = saved()
    imported.statuses[8453] = { phase: 'confirmed', hash: `0x${'ab'.repeat(32)}`, projectId: '19' }
    const record = JSON.stringify(imported, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
    localStorage.clear()
    await act(async () => root.render(<FundDeploy importedRecord={record} />))
    expect(saved().statuses[8453].phase).toBe('pending')
    expect(saved().statuses[8453].projectId).toBeUndefined()
    expect(host.textContent).toContain('Check confirmation')
    expect(host.textContent).not.toContain('Open FUND project')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('does not accept a recovery file as evidence that a failed hash came from this wallet attempt', async () => {
    const imported = saved()
    const hash = `0x${'ab'.repeat(32)}` as Hex
    imported.statuses[8453] = { phase: 'reverted', hash, walletReturned: true, multisigSetup: { safe: true, hash, walletReturned: true } }
    const record = JSON.stringify(imported, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
    localStorage.clear()
    await act(async () => root.render(<FundDeploy importedRecord={record} />))
    // The restored setup recovers on its own (its Safes exist), and the record keeps only the unproven launch hash.
    await vi.waitFor(() => expect(saved().statuses[8453].multisigSetup, host.textContent ?? '').toBeUndefined())
    expect(saved().statuses[8453]).toMatchObject({ phase: 'pending', hash })
    expect(saved().statuses[8453].walletReturned).toBeUndefined()
    // The launch hash can't be shown as this wallet's attempt: only the user's check reopens it.
    expect(host.textContent).toContain(SAVED_ATTEMPT_CHECK_LINE)
    expect(runtime.send).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Review and deploy FUND')
  })

  it('prepares FUND ownership for the Owner wallet while keeping Operator separate in metadata', async () => {
    localStorage.clear()
    const values = { name: 'Owned asset', fundTokenName: 'Owned asset FUND', fundTicker: 'OWNED', ownerName: 'Asset trust', ownerIntroduction: 'We steward the asset.', ownerWallet: '0x2222222222222222222222222222222222222222', operatorWallet: '0x3333333333333333333333333333333333333333', networks: ['base'], networkEnvironment: 'production' } as CreateValues
    await act(async () => root.render(<FundDeploy values={values} />))
    const prepare = [...host.querySelectorAll('button')].find(item => item.textContent === 'Create with a transaction')!
    await act(async () => prepare.click())
    expect(saved().input.owner).toBe(values.ownerWallet)
    expect(saved().input.sender).toBe(owner)
    expect(runtime.publish).toHaveBeenCalledWith(expect.objectContaining({ ownerWallet: values.ownerWallet, ownerName: values.ownerName, ownerIntroduction: values.ownerIntroduction, operatorWallet: values.operatorWallet }))
    expect(saved().input.projectUri).toBe('ipfs://bafkreimetadata')
  })

  it('does not assign Owner authority to Operator when Owner is missing', async () => {
    localStorage.clear()
    await act(async () => root.render(<FundDeploy values={{ name: 'Missing owner', fundTokenName: 'Missing owner FUND', fundTicker: 'MISSING', ownerWallet: '', operatorWallet: owner, networks: ['base'], networkEnvironment: 'production' } as CreateValues} />))
    const prepare = [...host.querySelectorAll('button')].find(item => item.textContent === 'Create with a transaction')!
    await act(async () => prepare.click())
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })
})
