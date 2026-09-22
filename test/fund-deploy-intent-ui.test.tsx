import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import type { Hex } from 'viem'
import { CREATE_DEFAULTS } from '../web/create-model.mjs'
import type { CreateValues } from '../src/components/CreateFlow'
import { FUND_LAUNCH_KEY, decodeLaunchSession, encodeLaunchSession } from '../src/lib/fund-launch-session'

const wallet = '0x1111111111111111111111111111111111111111'
const intentId = '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
const contentHash = `0x${'ab'.repeat(32)}` as Hex
const signature = `0x${'cd'.repeat(65)}` as Hex
// Center's own signing message, word for word (docs/rest/PROJECT_INTENTS.md).
const publicationMessage = `Juice Central project intent\nVersion: 1\nContent hash: ${contentHash}`

const runtime = vi.hoisted(() => ({
  wallet: '0x1111111111111111111111111111111111111111' as string | undefined, centerWallet: false, safe: false,
  readContract: vi.fn(), getBlock: vi.fn(), getCode: vi.fn(), publish: vi.fn(), checkDeployment: vi.fn(),
  signMessage: vi.fn(), review: vi.fn(), prepareIntent: vi.fn(), publishIntent: vi.fn(),
}))
const navigate = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => navigate }))
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  getPublicClient: () => ({ readContract: runtime.readContract, getBlock: runtime.getBlock, getCode: runtime.getCode }),
  signMessage: runtime.signMessage,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.wallet, isCenterWallet: runtime.centerWallet, openSignIn: vi.fn() }) }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))
vi.mock('@/components/CreateFlow', () => ({ default: () => null }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => runtime.safe, waitForSafeExecutionHash: vi.fn() }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, error: '', send: vi.fn(), reset: vi.fn() }) }))
vi.mock('@/lib/publish-fund-project-metadata', () => ({ publishFundProjectMetadata: runtime.publish }))
vi.mock('@/lib/fund-launch-verification', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/fund-launch-verification')>(),
  checkLaunchDeployment: runtime.checkDeployment,
}))
vi.mock('@/lib/transaction-review', () => ({ requireTransactionReview: runtime.review }))
vi.mock('@/lib/jbcenter-client', () => ({
  jbCenterClient: { prepareIntent: runtime.prepareIntent, publishIntent: runtime.publishIntent },
}))
vi.mock('@bananapus/nana-sdk-core/safe', async original => {
  const sdk = await original<typeof import('@bananapus/nana-sdk-core/safe')>()
  return { ...sdk, resolveSafeAddress: vi.fn(async (input: Parameters<typeof sdk.resolveSafeAddress>[0]) => {
    if (input.kind === 'existing') return sdk.resolveSafeAddress(input, [])
    const policy = { owners: input.owners, threshold: input.threshold, saltNonce: input.saltNonce, proxyCreationCode: sdk.SAFE_PROXY_CREATION_CODE }
    return { address: sdk.predictSafeAddress(policy), plan: { ...policy, address: sdk.predictSafeAddress(policy) } }
  }) }
})

import { FundDeploy } from '../src/components/LiveCreate'

function values(overrides: Partial<CreateValues> = {}): CreateValues {
  return {
    ...CREATE_DEFAULTS,
    name: 'Neighborhood Workshop',
    fundTokenName: 'Neighborhood Workshop FUND',
    fundTicker: 'FUND',
    ownerMode: 'existing', ownerWallet: wallet, ownerIsOperator: true,
    operatorMode: 'existing', operatorWallet: wallet,
    networks: ['base'], networkEnvironment: 'production',
    ...overrides,
  } as CreateValues
}

describe('creating a FUND without a transaction', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    localStorage.clear()
    runtime.wallet = wallet
    runtime.centerWallet = false
    runtime.safe = false
    runtime.readContract.mockReset().mockResolvedValue(0n)
    runtime.getBlock.mockReset().mockResolvedValue({ timestamp: 1_800_000_000n })
    runtime.getCode.mockReset().mockResolvedValue('0x6000')
    runtime.publish.mockReset().mockResolvedValue({ cid: 'bafkreimetadata' })
    runtime.checkDeployment.mockReset().mockResolvedValue(undefined)
    runtime.review.mockReset().mockResolvedValue(undefined)
    runtime.signMessage.mockReset().mockResolvedValue(signature)
    runtime.prepareIntent.mockReset().mockImplementation(async (envelope: unknown) => ({
      contentHash, message: publicationMessage, envelope,
    }))
    runtime.publishIntent.mockReset().mockImplementation(async (body: Record<string, unknown>) => ({
      id: intentId, status: 'undeployed', contentHash, envelope: body, publisher: wallet, signature,
      createdAt: new Date(0).toISOString(), deployments: [], deploys: [],
      name: 'Neighborhood Workshop', description: null, tagline: null, tags: [], logoUri: null, owner: wallet,
    }))
    navigate.push.mockReset()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })

  const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)

  async function render(props: Partial<CreateValues> = {}) {
    await act(async () => root.render(<FundDeploy values={values(props)} />))
  }

  const publish = () => localStorage.setItem(FUND_LAUNCH_KEY, encodeLaunchSession({
    version: 1, name: 'Neighborhood Workshop', transport: 'intent', intentId,
    input: {
      owner: wallet as `0x${string}`, sender: wallet as `0x${string}`, chainIds: [8453],
      projectUri: 'ipfs://bafkreimetadata', tokenName: 'Neighborhood Workshop FUND', ticker: 'FUND',
      salt: `0x${'78'.repeat(32)}` as Hex, mustStartAtOrAfter: 0, creationFees: { 8453: 0n },
    },
    statuses: { 8453: { phase: 'ready' } },
  }))

  it('offers one way forward, the preview', async () => {
    await render()
    expect(button('Show preview')).toBeTruthy()
    expect(button('Create project')).toBeUndefined()
    expect(button('Create without a transaction')).toBeUndefined()
    expect(button('Create with a transaction')).toBeUndefined()
    await act(async () => button('Show preview')!.click())
    expect(navigate.push).toHaveBeenCalledWith('/create/preview')
  })

  it('offers the preview on mainnet too', async () => {
    await render({ networks: ['ethereum', 'base'] })
    expect(button('Show preview')).toBeTruthy()
  })

  it('keeps the transaction path for a connection Center cannot verify', async () => {
    runtime.safe = true
    await render()
    expect(button('Show preview')).toBeTruthy()
    expect(button('Create with a transaction')).toBeTruthy()
    runtime.safe = false
    runtime.centerWallet = true
    await render()
    expect(button('Create with a transaction')).toBeTruthy()
  })

  it('shows the preview before a wallet is connected', async () => {
    runtime.wallet = undefined
    await render()
    expect(button('Show preview')!.disabled).toBe(false)
  })

  it('shows a published project as published, with its page and no chain transactions', async () => {
    publish()
    await act(async () => root.render(<FundDeploy />))
    expect(host.textContent).toContain('This project is published')
    expect(host.querySelector<HTMLAnchorElement>(`a[href="/intent/${intentId}"]`)).toBeTruthy()
    expect(button('Review and deploy FUND')).toBeUndefined()
  })

  it('offers no project page for a restored record that was never published', async () => {
    localStorage.setItem(FUND_LAUNCH_KEY, encodeLaunchSession({
      version: 1, name: 'Neighborhood Workshop', transport: 'intent',
      input: {
        owner: wallet as `0x${string}`, sender: wallet as `0x${string}`, chainIds: [8453],
        projectUri: 'ipfs://bafkreimetadata', tokenName: 'Neighborhood Workshop FUND', ticker: 'FUND',
        salt: `0x${'34'.repeat(32)}` as Hex, mustStartAtOrAfter: 0, creationFees: { 8453: 0n },
      },
      statuses: { 8453: { phase: 'ready' } },
    }))
    await act(async () => root.render(<FundDeploy />))
    expect(host.querySelector('a[href^="/intent/"]')).toBeNull()
    expect(host.textContent).not.toContain('This project is published')
    expect(button('Cancel creation and edit details')).toBeTruthy()
  })

  it('says a published project must be finished before its networks change', async () => {
    publish()
    await act(async () => root.render(<FundDeploy values={values({ networks: ['optimism'] })} />))
    const alert = [...host.querySelectorAll('[role="alert"]')].find(node => !node.closest('details'))
    expect(alert?.textContent).toBe('This project is already published on Base. Finish it before changing networks.')
    expect(host.textContent).not.toContain('wallet authorizations')
  })

})
