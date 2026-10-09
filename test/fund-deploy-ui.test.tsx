import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeFunctionData, parseAbi, zeroAddress, type Hex } from 'viem'
import type { CreateValues } from '../src/components/CreateFlow'
import { buildFundLaunch } from '../src/lib/fund-contracts'
import { FUND_LAUNCH_KEY, decodeLaunchSession, saveLaunch, updateLaunchStatus, type FundLaunchSession } from '../src/lib/fund-launch-session'
import { safeExecutionLog } from './support/safe-logs'
import type { TxRequest, TxSendOptions } from '../src/hooks/useSafeTx'
import { multisigDeploymentRequest, predictMultisig, type CreateMultisig } from '../src/lib/create-multisig'
import { failReservationReadback } from './support/reservation-storage'

const runtime = vi.hoisted(() => ({ txError: '' as string, submissionHash: undefined as Hex | undefined, safe: false, send: vi.fn(), readContract: vi.fn(), getBlock: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), waitReceipt: vi.fn(), waitSafe: vi.fn(), checkMultisigs: vi.fn(), verifyMultisigs: vi.fn(), publish: vi.fn(), checkDeployment: vi.fn(), relayr: vi.fn(), requestsDead: vi.fn() }))
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
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, error: runtime.txError, submissionHash: runtime.submissionHash, send: runtime.send, reset: vi.fn() }) }))
vi.mock('@/lib/publish-fund-project-metadata', () => ({ publishFundProjectMetadata: runtime.publish }))
vi.mock('@/lib/fund-launch-verification', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/fund-launch-verification')>(), checkLaunchDeployment: runtime.checkDeployment }))
vi.mock('@/lib/fund-launch-relayr', () => ({ runRelayrLaunch: runtime.relayr, launchRequestsDead: runtime.requestsDead }))
import { FundDeploy } from '../src/components/LiveCreate'
import CreateSuccess from '../src/components/CreateSuccess'

type Callbacks = { durableRecovery: { reserve: () => unknown | Promise<unknown>; releaseUnsubmitted: () => unknown | Promise<unknown> } }
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
    runtime.txError = ''
    runtime.submissionHash = undefined
    runtime.safe = false
    runtime.send.mockReset()
    runtime.waitSafe.mockReset(); runtime.waitReceipt.mockReset(); runtime.checkMultisigs.mockReset().mockResolvedValue(undefined); runtime.verifyMultisigs.mockReset().mockResolvedValue(true)
    runtime.getTransaction.mockReset(); runtime.getTransactionReceipt.mockReset()
    runtime.readContract.mockResolvedValue(0n); runtime.getBlock.mockReset().mockResolvedValue({ timestamp: 1000n }); runtime.publish.mockResolvedValue({ cid: 'bafkreimetadata' }); runtime.checkDeployment.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } })
    saveLaunch({ version: 1, name: 'Test asset', input: { owner, sender: owner, chainIds: [8453], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt, mustStartAtOrAfter: 0, creationFees: { 8453: 0n } }, statuses: { 8453: { phase: 'ready' } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function launch() {
    await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    const button = [...host.querySelectorAll('button')].find(item => item.textContent === 'Review and deploy FUND')!
    await act(async () => button.click())
  }

  it.each(['launch', 'setup'])('cleans failed %s reservation persistence before the wallet without a runtime cleanup callback', async kind => {
    if (kind === 'setup') {
      const policy = { owners: [owner, '0x2222222222222222222222222222222222222222' as const], threshold: 2, saltNonce: salt, proxyCreationCode: '0x6000' as Hex }
      const plan: CreateMultisig = { ...policy, role: 'operator', address: predictMultisig(policy) }
      const current = saved()
      localStorage.clear()
      saveLaunch({ ...current, input: { ...current.input, operator: plan.address, multisigs: [plan] } })
      runtime.verifyMultisigs.mockResolvedValue(false)
    }
    const writer = vi.fn(), storage = localStorage, original = storage.getItem(FUND_LAUNCH_KEY)
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => { await options.durableRecovery.reserve(); writer(); return null })
    vi.stubGlobal('localStorage', failReservationReadback(storage, FUND_LAUNCH_KEY))
    try { await launch() }
    finally { vi.unstubAllGlobals() }
    expect(runtime.send).toHaveBeenCalledOnce()
    expect(writer).not.toHaveBeenCalled()
    expect(storage.getItem(FUND_LAUNCH_KEY)).toBe(original)
    expect(saved().statuses[8453]).toEqual({ phase: 'ready' })
    expect(host.textContent).toContain('Reservation readback failed')
  })

  it('cancels an unsubmitted launch and preserves the setup draft', async () => {
    localStorage.setItem('homerun:create-draft:v1', 'keep this draft')
    await act(async () => root.render(<FundDeploy />))
    const cancel = [...host.querySelectorAll('button')].find(button => button.textContent === 'Cancel creation and edit details')!
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
    const cancel = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Cancel creation and edit details')

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
  it('adopts an existing Safe launch directly into pending recovery without a new signing transition', async () => {
    runtime.safe = true
    const hash = `0x${'cd'.repeat(32)}` as Hex
    runtime.send.mockImplementation(async (request: TxRequest, options: TxSendOptions) => {
      expect(saved().statuses[8453].phase).toBe('ready')
      await options.onExistingProposal?.({ proposalHash: hash, call: { to: request.address, data: encodeFunctionData(request), value: request.value ?? 0n } })
      await options.durableRecovery!.submitted(hash, true)
      expect(saved().statuses[8453]).toMatchObject({ phase: 'pending', safe: true, hash, walletReturned: true })
      return hash
    })
    await launch()
    expect(saved().statuses[8453]).toMatchObject({ phase: 'pending', safe: true, hash })
    expect(host.textContent).toContain('Safe proposal awaiting execution.')
    expect(host.textContent).not.toContain('FUND deployment verified onchain.')
    expect(runtime.send).toHaveBeenCalledOnce()
  })

  it.each(['outer revert', 'missing event', 'different executed call', 'legacy hash', 'nonfinal failure', 'changed setup', 'proven failure'] as const)('preserves multisig recovery unless the exact Safe setup failed: %s', async kind => {
    const proposal = `0x${'ec'.repeat(32)}` as Hex
    const execution = kind === 'different executed call' ? proposal : `0x${'ed'.repeat(32)}` as Hex
    const policy = { owners: [owner, '0x2222222222222222222222222222222222222222' as const], threshold: 2, saltNonce: salt, proxyCreationCode: '0x6000' as Hex }
    const plan: CreateMultisig = { ...policy, role: 'operator', address: predictMultisig(policy) }
    const current = saved()
    localStorage.clear()
    const setup = { safe: true, hash: proposal, ...(kind !== 'legacy hash' ? { walletReturned: true as const } : {}) }
    saveLaunch({ ...current, input: { ...current.input, operator: plan.address, multisigs: [plan] }, statuses: { 8453: { phase: 'ready', multisigSetup: setup } } })
    runtime.safe = true
    runtime.waitSafe.mockResolvedValue(execution)
    const request = multisigDeploymentRequest(8453, [plan])
    failedSafeReceipt(request, proposal, execution, kind)
    const replacement = { ...setup, hash: `0x${'fe'.repeat(32)}` as Hex }
    if (kind === 'changed setup') {
      const getBlock = runtime.getBlock.getMockImplementation()!
      runtime.getBlock.mockImplementation(async args => {
        if (args.blockTag === 'finalized') updateLaunchStatus(salt, 8453, { phase: 'ready', multisigSetup: replacement })
        return getBlock(args)
      })
    }
    await launch()
    if (kind === 'proven failure') {
      expect(saved().statuses[8453].multisigSetup).toBeUndefined()
      expect(host.textContent).toContain('Multisig creation reverted')
    } else {
      expect(saved().statuses[8453].multisigSetup).toEqual(kind === 'changed setup' ? replacement : setup)
      expect(host.textContent).toContain(kind === 'legacy hash' ? 'no recorded wallet-returned hash' : kind === 'nonfinal failure' ? 'Keep this action pending' : kind === 'changed setup' ? 'changed in another tab' : 'The multisig setup is unresolved')
    }
    expect(runtime.send).not.toHaveBeenCalled()
    expect(saved().statuses[8453].phase).toBe('ready')
    expect(runtime.verifyMultisigs).not.toHaveBeenCalled()
  })

  it('records an unknown attempt before the wallet write and preserves it after transport failure', async () => {
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => {
      await options.durableRecovery.reserve()
      expect(saved().statuses[8453].phase).toBe('signing')
      return null
    })
    await launch()
    // Sent as the launch's saved sender, the account it was prepared for.
    expect(runtime.send.mock.calls.at(-1)![1].reviewedAccount).toBe(saved().input.sender)
    expect(saved().statuses[8453].phase).toBe('signing')
    expect(host.textContent).toContain('Check your wallet history')
    expect(host.textContent).not.toContain('Review and deploy FUND')
    expect(host.textContent).not.toContain('I cancelled without submitting')
    expect(host.textContent).not.toContain('I cancelled multisig setup without submitting')
    expect(host.textContent).not.toContain('Verify this transaction')
    expect(host.querySelector('input[type="checkbox"]')).toBeNull()
  })

  it('restores a ready launch only after the runtime proves explicit wallet rejection', async () => {
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => {
      await options.durableRecovery.reserve(); await options.durableRecovery.releaseUnsubmitted(); return null
    })
    await launch()
    expect(saved().statuses[8453].phase).toBe('ready')
    expect(host.textContent).not.toContain('Check your wallet history')
  })

  it('holds a hashless multisig setup without a pasted hash, cancellation or second wallet write', async () => {
    const policy = { owners: [owner, '0x2222222222222222222222222222222222222222' as const], threshold: 2, saltNonce: salt, proxyCreationCode: '0x6000' as Hex }
    const plan: CreateMultisig = { ...policy, role: 'operator', address: predictMultisig(policy) }
    const current = saved()
    localStorage.clear()
    saveLaunch({ ...current, input: { ...current.input, operator: plan.address, multisigs: [plan] }, statuses: { 8453: { phase: 'ready', multisigSetup: { safe: true } } } })
    runtime.submissionHash = `0x${'ee'.repeat(32)}` as Hex
    await launch()
    expect(saved().statuses[8453].multisigSetup).toEqual({ safe: true })
    expect(runtime.send).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Check your wallet activity')
    expect(host.textContent).toContain(runtime.submissionHash)
    expect(host.textContent).not.toContain('Save setup hash')
    expect(host.textContent).not.toContain('Cancel creation and edit details')
    expect(host.querySelector('input')).toBeNull()
  })

  it('holds legacy reverted launches whose recorded hash has no wallet provenance', async () => {
    const current = saved()
    localStorage.clear()
    saveLaunch({ ...current, statuses: { 8453: { phase: 'reverted', hash: `0x${'ee'.repeat(32)}` } } })
    await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    expect(host.textContent).not.toContain('Review and deploy FUND')
    expect(host.textContent).toContain('no recorded wallet-returned hash')
    const resume = [...host.querySelectorAll('button')].find(item => item.textContent === 'Continue creation')
    if (resume) await act(async () => resume.click())
    expect(runtime.send).not.toHaveBeenCalled()
    expect(saved().statuses[8453].phase).toBe('reverted')
  })

  it('restores a ready launch when the write stops before the wallet', async () => {
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => {
      await options.durableRecovery.reserve(); await options.durableRecovery.releaseUnsubmitted(); return null
    })
    await launch()
    expect(saved().statuses[8453].phase).toBe('ready')
    expect(host.textContent).not.toContain('Check your wallet history')
  })

  it('records nothing when the wallet connection stops being the one the launch was read with', async () => {
    let refused: unknown
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => {
      // A WalletConnect peer read lands: the connection now proposes to a Safe.
      runtime.safe = true
      try { await options.durableRecovery.reserve() } catch (error) { refused = error }
      return null
    })
    await launch()
    expect(refused).toEqual(new Error('Wallet connection changed. Review the transaction again.'))
    expect(saved().statuses[8453].phase).toBe('ready')
  })

  it.each(['legacy hash', 'nonfinal failure', 'proven failure'])('reopens only a wallet-recorded finalized Safe launch failure: %s', async kind => {
    const proposal = `0x${'ef'.repeat(32)}` as Hex, execution = `0x${'cd'.repeat(32)}` as Hex
    const session = saved()
    localStorage.clear()
    saveLaunch({ ...session, statuses: { 8453: { phase: 'pending', hash: proposal, executionHash: execution, safe: true, ...(kind !== 'legacy hash' ? { walletReturned: true as const } : {}) } } })
    const request = buildFundLaunch(session.input).requests[0]
    failedSafeReceipt(request, proposal, execution, kind)
    await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    const check = [...host.querySelectorAll('button')].find(item => item.textContent === 'Check confirmation')!
    await act(async () => check.click())
    if (kind === 'proven failure') {
      expect(saved().statuses[8453].phase).toBe('reverted')
      expect(host.textContent).toContain('The deployment reverted. No project was created by this transaction.')
      expect(host.textContent).toContain('Review and deploy FUND')
    } else {
      expect(saved().statuses[8453].phase).toBe('pending')
      expect(host.textContent).toContain('Confirmation is unresolved')
      expect(host.textContent).not.toContain('Review and deploy FUND')
    }
  })

  it('refuses a stale review when another tab has already recorded submission', async () => {
    const write = vi.fn()
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => {
      updateLaunchStatus(salt, 8453, { phase: 'signing' }, 'ready')
      await options.durableRecovery.reserve()
      write()
      return null
    })
    await launch()
    expect(write).not.toHaveBeenCalled()
    expect(saved().statuses[8453].phase).toBe('signing')
    expect(host.textContent).toContain('already being handled')
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
    expect(saved().statuses[8453]).toMatchObject({ phase: 'pending', hash, multisigSetup: { safe: true, hash } })
    expect(saved().statuses[8453].walletReturned).toBeUndefined()
    expect(saved().statuses[8453].multisigSetup?.walletReturned).toBeUndefined()
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
