import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeFunctionData, parseAbi, zeroAddress, type Hex } from 'viem'
import type { CreateValues } from '../src/components/CreateFlow'
import { buildFundLaunch } from '../src/lib/fund-contracts'
import { FUND_LAUNCH_KEY, decodeLaunchSession, saveLaunch, updateLaunchStatus, type FundLaunchSession } from '../src/lib/fund-launch-session'
import { safeExecutionLog } from './support/safe-logs'

const runtime = vi.hoisted(() => ({ txError: '' as string, safe: false, send: vi.fn(), readContract: vi.fn(), getBlock: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), publish: vi.fn(), checkDeployment: vi.fn() }))
const navigate = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => navigate }))
const owner = '0x1111111111111111111111111111111111111111' as const
const salt = `0x${'12'.repeat(32)}` as Hex
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }), getPublicClient: () => ({ readContract: runtime.readContract, getBlock: runtime.getBlock, getTransaction: runtime.getTransaction, getTransactionReceipt: runtime.getTransactionReceipt, getChainId: async () => 8453 }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: '0x1111111111111111111111111111111111111111', isCenterWallet: true }) }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))
vi.mock('@/components/CreateFlow', () => ({ default: () => null }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => runtime.safe, useSafeConnection: () => false, waitForSafeExecutionHash: vi.fn() }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, error: runtime.txError, send: runtime.send, reset: vi.fn() }) }))
vi.mock('@/lib/publish-fund-project-metadata', () => ({ publishFundProjectMetadata: runtime.publish }))
vi.mock('@/lib/fund-launch-verification', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/fund-launch-verification')>(), checkLaunchDeployment: runtime.checkDeployment }))
import { FundDeploy } from '../src/components/LiveCreate'
import CreateSuccess from '../src/components/CreateSuccess'

type Callbacks = { beforeWrite: () => void; onWriteRejected: () => void; onBeforeWriteAborted: () => void }
function saved(): FundLaunchSession {
  return decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)
}

describe('Create submission recovery', () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    localStorage.clear()
    runtime.txError = ''
    runtime.safe = false
    runtime.send.mockReset()
    runtime.readContract.mockResolvedValue(0n); runtime.getBlock.mockResolvedValue({ timestamp: 1000n }); runtime.publish.mockResolvedValue({ cid: 'bafkreimetadata' }); runtime.checkDeployment.mockResolvedValue(undefined)
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

  it('cancelling review leaves the saved launch ready without claiming a wallet submission', async () => {
    runtime.send.mockImplementation(async () => { expect(saved().statuses[8453].phase).toBe('ready'); return null })
    await launch()
    expect(saved().statuses[8453].phase).toBe('ready')
    expect(host.textContent).not.toContain('Check your wallet history')
  })

  it('records an unknown attempt before the wallet write and preserves it after transport failure', async () => {
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => {
      options.beforeWrite()
      expect(saved().statuses[8453].phase).toBe('signing')
      return null
    })
    await launch()
    // Sent as the launch's saved sender, the account it was prepared for.
    expect(runtime.send.mock.calls.at(-1)![1].reviewedAccount).toBe(saved().input.sender)
    expect(saved().statuses[8453].phase).toBe('signing')
    expect(host.textContent).toContain('Check your wallet history')
    expect(host.textContent).not.toContain('Review and deploy FUND')
  })

  it('restores a ready launch only after the runtime proves explicit wallet rejection', async () => {
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => {
      options.beforeWrite(); options.onWriteRejected(); return null
    })
    await launch()
    expect(saved().statuses[8453].phase).toBe('ready')
    expect(host.textContent).not.toContain('Check your wallet history')
  })

  it('restores a ready launch when the write stops before the wallet', async () => {
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => {
      options.beforeWrite(); options.onBeforeWriteAborted(); return null
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
      try { options.beforeWrite() } catch (error) { refused = error }
      return null
    })
    await launch()
    expect(refused).toEqual(new Error('Wallet connection changed. Review the transaction again.'))
    expect(saved().statuses[8453].phase).toBe('ready')
  })

  it('reopens a Safe launch whose execution logged ExecutionFailure, so it can be deployed again', async () => {
    const proposal = `0x${'ef'.repeat(32)}` as Hex, execution = `0x${'cd'.repeat(32)}` as Hex, blockHash = `0x${'aa'.repeat(32)}` as Hex
    const session = saved()
    localStorage.clear()
    saveLaunch({ ...session, statuses: { 8453: { phase: 'pending', hash: proposal, executionHash: execution, safe: true } } })
    const request = buildFundLaunch(session.input).requests[0]
    runtime.getBlock.mockResolvedValue({ hash: blockHash, timestamp: 1000n })
    runtime.getTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: execution, blockHash, blockNumber: 7n,
      logs: [safeExecutionLog(owner, proposal, { failed: true })] })
    runtime.getTransaction.mockResolvedValue({ hash: execution, to: owner, from: '0x2222222222222222222222222222222222222222', value: 0n,
      input: encodeFunctionData({ abi: parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)']),
        functionName: 'execTransaction', args: [request.address, request.value ?? 0n, encodeFunctionData(request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) })
    await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    const check = [...host.querySelectorAll('button')].find(item => item.textContent === 'Check confirmation')!
    await act(async () => check.click())
    expect(saved().statuses[8453].phase).toBe('reverted')
    expect(host.textContent).toContain('The deployment reverted. No project was created by this transaction.')
    expect(host.textContent).toContain('Review and deploy FUND')
  })

  it('refuses a stale review when another tab has already recorded submission', async () => {
    const write = vi.fn()
    runtime.send.mockImplementation(async (_request: unknown, options: Callbacks) => {
      updateLaunchStatus(salt, 8453, { phase: 'signing' }, 'ready')
      options.beforeWrite()
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
