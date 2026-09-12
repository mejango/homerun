import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import type { CreateValues } from '../src/components/CreateFlow'
import { FUND_LAUNCH_KEY, decodeLaunchSession, saveLaunch, updateLaunchStatus, type FundLaunchSession } from '../src/lib/fund-launch-session'

const runtime = vi.hoisted(() => ({ send: vi.fn(), readContract: vi.fn(), getBlock: vi.fn(), publish: vi.fn(), checkDeployment: vi.fn() }))
const owner = '0x1111111111111111111111111111111111111111' as const
const salt = `0x${'12'.repeat(32)}` as Hex
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }), getPublicClient: () => ({ readContract: runtime.readContract, getBlock: runtime.getBlock }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: '0x1111111111111111111111111111111111111111' }) }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))
vi.mock('@/components/CreateFlow', () => ({ default: () => null }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => false, waitForSafeExecutionHash: vi.fn() }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, send: runtime.send, reset: vi.fn() }) }))
vi.mock('@/lib/publish-fund-project-metadata', () => ({ publishFundProjectMetadata: runtime.publish }))
vi.mock('@/lib/fund-launch-verification', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/fund-launch-verification')>(), checkLaunchDeployment: runtime.checkDeployment }))
import { FundDeploy } from '../src/components/LiveCreate'

type Callbacks = { beforeWrite: () => void; onWriteRejected: () => void }
function saved(): FundLaunchSession {
  return decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)
}

describe('Create submission recovery', () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    localStorage.clear()
    runtime.send.mockReset()
    runtime.readContract.mockResolvedValue(0n); runtime.getBlock.mockResolvedValue({ timestamp: 1000n }); runtime.publish.mockResolvedValue({ cid: 'bafkreimetadata' }); runtime.checkDeployment.mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } })
    saveLaunch({ version: 1, name: 'Test asset', input: { owner, sender: owner, chainIds: [8453], projectUri: 'ipfs://bafkreimetadata', salt, mustStartAtOrAfter: 0, creationFees: { 8453: 0n } }, statuses: { 8453: { phase: 'ready' } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  async function launch() {
    await act(async () => root.render(<FundDeploy values={{} as CreateValues} />))
    const button = [...host.querySelectorAll('button')].find(item => item.textContent === 'Review and deploy FUND')!
    await act(async () => button.click())
  }

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
    await act(async () => root.render(<FundDeploy />))
    const input = host.querySelector('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [{ size: record.length, text: async () => record }] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(saved().statuses[8453].phase).toBe('pending')
    expect(saved().statuses[8453].projectId).toBeUndefined()
    expect(host.textContent).toContain('Check confirmation')
    expect(host.textContent).not.toContain('Open FUND project')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('prepares FUND ownership for the Owner wallet while keeping Operator separate in metadata', async () => {
    localStorage.clear()
    const values = { name: 'Owned asset', ownerWallet: '0x2222222222222222222222222222222222222222', operatorWallet: '0x3333333333333333333333333333333333333333', networks: ['base'], networkEnvironment: 'production' } as CreateValues
    await act(async () => root.render(<FundDeploy values={values} />))
    const prepare = [...host.querySelectorAll('button')].find(item => item.textContent === 'Create project')!
    await act(async () => prepare.click())
    expect(saved().input.owner).toBe(values.ownerWallet)
    expect(saved().input.sender).toBe(owner)
    expect(runtime.publish).toHaveBeenCalledWith(expect.objectContaining({ ownerWallet: values.ownerWallet, operatorWallet: values.operatorWallet }))
  })

  it('does not assign Owner authority to Operator when Owner is missing', async () => {
    localStorage.clear()
    await act(async () => root.render(<FundDeploy values={{ name: 'Missing owner', ownerWallet: '', operatorWallet: owner, networks: ['base'], networkEnvironment: 'production' } as CreateValues} />))
    const prepare = [...host.querySelectorAll('button')].find(item => item.textContent === 'Create project')!
    await act(async () => prepare.click())
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })
})
