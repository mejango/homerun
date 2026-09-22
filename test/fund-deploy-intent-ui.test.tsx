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
  centerWallet: false, safe: false,
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
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: wallet, isCenterWallet: runtime.centerWallet }) }))
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

  it('offers the no-transaction path first on sponsored networks, with the transaction path kept', async () => {
    await render()
    expect(button('Create without a transaction')).toBeTruthy()
    expect(button('Create with a transaction instead')).toBeTruthy()
    expect(button('Create project')).toBeUndefined()
  })

  const signers = [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`]

  it('keeps the transaction path alone for mainnet, a Safe and a Center wallet', async () => {
    await render({ networks: ['ethereum', 'base'] })
    expect(button('Create without a transaction')).toBeUndefined()
    expect(button('Create project')).toBeTruthy()
    runtime.safe = true
    await render()
    expect(button('Create without a transaction')).toBeUndefined()
    runtime.safe = false
    runtime.centerWallet = true
    await render()
    expect(button('Create without a transaction')).toBeUndefined()
  })

  it('offers the no-transaction path when a new multisig is planned', async () => {
    runtime.centerWallet = false
    await render({ ownerMode: 'create', ownerSigners: signers, ownerThreshold: 2 })
    expect(button('Create without a transaction')).toBeTruthy()
  })

  it('reviews the Safe creation before the launch, and publishes both', async () => {
    await render({ ownerMode: 'create', ownerSigners: signers, ownerThreshold: 2 })
    await act(async () => button('Create without a transaction')!.click())
    const review = runtime.review.mock.calls[0][0]
    expect(review.kind).toBe('authorization')
    expect(review.calls).toHaveLength(2)
    expect(review.calls[0].functionName).toBe('createProxyWithNonce')
    expect(review.calls[0].contractName).toBe('SafeProxyFactory')
    expect(review.calls[0].label).toContain('Owner multisig')
    expect(review.calls[0].from).toBeUndefined()
    expect(review.calls[1].functionName).toBe('launchFundFor')
    expect(review.calls[1].from).toBeUndefined()
    expect(review.description).toContain('creates your multisigs and the project')
    expect(review.description).toContain('2/2 approvals')
    const envelope = runtime.publishIntent.mock.calls[0][0]
    expect(envelope.deploymentCalls).toHaveLength(2)
    expect(envelope.jb.safes).toHaveLength(1)
    expect(envelope.jb.safes[0].role).toBe('owner')
    expect(envelope.jb.safes[0].threshold).toBe(2)
    expect(envelope.jb.owner).toBe(envelope.jb.safes[0].address)
    expect(navigate.push).toHaveBeenCalledWith(`/intent/${intentId}`)
  })

  it('reviews the exact calls, signs once, saves the published project and opens its page', async () => {
    await render()
    await act(async () => button('Create without a transaction')!.click())
    const review = runtime.review.mock.calls[0][0]
    expect(review.kind).toBe('authorization')
    expect(review.calls).toHaveLength(1)
    expect(review.calls[0].chainId).toBe(8453)
    expect(review.calls[0].functionName).toBe('launchFundFor')
    // Center's sponsor is `_msgSender()` on every chain, so the merchant must not read their own address as the sender.
    expect(review.calls[0].from).toBeUndefined()
    expect(review.calls[0].label).toContain('Center’s sponsor')
    // Center takes a plain signed message, so the review says message, not typed data.
    expect(review.authorization.kind).toBe('message')
    expect(review.authorization.format).toBe('homerun.money/fund.v1')
    expect(review.authorization.jb.app).toBe('homerun')
    expect(review.authorization.jb.name).toBe('Neighborhood Workshop')
    expect(review.authorization.jb.ticker).toBe('FUND')
    expect(review.authorization.jb.tokenName).toBe('Neighborhood Workshop FUND')
    expect(review.authorization.jb.owner).toBe(wallet)
    expect(review.authorization.chainIds).toEqual([8453])
    expect(runtime.signMessage).toHaveBeenCalledWith({}, { account: wallet, message: publicationMessage })
    const saved = decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)
    expect(saved.transport).toBe('intent')
    expect(saved.intentId).toBe(intentId)
    expect(navigate.push).toHaveBeenCalledWith(`/intent/${intentId}`)
  })

  it('shows a published project as published, with its page and no chain transactions', async () => {
    await render()
    await act(async () => button('Create without a transaction')!.click())
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

  it('starts its own record instead of converting a saved transaction plan', async () => {
    await render()
    const unsigned = {
      version: 1 as const, name: 'Neighborhood Workshop', transport: 'direct' as const,
      input: {
        owner: wallet as `0x${string}`, sender: wallet as `0x${string}`, chainIds: [8453],
        projectUri: 'ipfs://bafkreimetadata', tokenName: 'Neighborhood Workshop FUND', ticker: 'FUND',
        salt: `0x${'12'.repeat(32)}` as Hex, mustStartAtOrAfter: 0, creationFees: { 8453: 0n },
      },
      statuses: { 8453: { phase: 'ready' as const } },
    }
    localStorage.setItem(FUND_LAUNCH_KEY, encodeLaunchSession(unsigned))
    await act(async () => button('Create without a transaction')!.click())
    const saved = decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)
    expect(saved.transport).toBe('intent')
    expect(saved.intentId).toBe(intentId)
    expect(saved.input.salt).not.toBe(unsigned.input.salt)
  })

  it('keeps a saved launch that already has authorizations', async () => {
    await render()
    const submitted = {
      version: 1 as const, name: 'Neighborhood Workshop', transport: 'direct' as const,
      input: {
        owner: wallet as `0x${string}`, sender: wallet as `0x${string}`, chainIds: [8453],
        projectUri: 'ipfs://bafkreimetadata', tokenName: 'Neighborhood Workshop FUND', ticker: 'FUND',
        salt: `0x${'12'.repeat(32)}` as Hex, mustStartAtOrAfter: 0, creationFees: { 8453: 0n },
      },
      statuses: { 8453: { phase: 'pending' as const, hash: `0x${'ef'.repeat(32)}` as Hex } },
    }
    localStorage.setItem(FUND_LAUNCH_KEY, encodeLaunchSession(submitted))
    await act(async () => button('Create without a transaction')!.click())
    expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).transport).toBe('direct')
    expect(runtime.signMessage).not.toHaveBeenCalled()
    const alert = [...host.querySelectorAll('[role="alert"]')].find(node => !node.closest('details'))
    expect(alert?.textContent).toContain('A saved launch already exists')
  })

  it('says a published project must be finished before its networks change', async () => {
    await render()
    await act(async () => button('Create without a transaction')!.click())
    await act(async () => root.render(<FundDeploy values={values({ networks: ['optimism'] })} />))
    const alert = [...host.querySelectorAll('[role="alert"]')].find(node => !node.closest('details'))
    expect(alert?.textContent).toBe('This project is already published on Base. Finish it before changing networks.')
    expect(host.textContent).not.toContain('wallet authorizations')
  })

  it('keeps a prepared plan when the click is refused', async () => {
    await render()
    const unsigned = {
      version: 1 as const, name: 'Neighborhood Workshop', transport: 'direct' as const,
      input: {
        owner: wallet as `0x${string}`, sender: wallet as `0x${string}`, chainIds: [8453],
        projectUri: 'ipfs://bafkreimetadata', tokenName: 'Neighborhood Workshop FUND', ticker: 'FUND',
        salt: `0x${'56'.repeat(32)}` as Hex, mustStartAtOrAfter: 0, creationFees: { 8453: 0n },
      },
      statuses: { 8453: { phase: 'ready' as const } },
    }
    localStorage.setItem(FUND_LAUNCH_KEY, encodeLaunchSession(unsigned))
    runtime.safe = true
    await act(async () => button('Create without a transaction')!.click())
    expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).input.salt).toBe(unsigned.input.salt)
    expect(runtime.signMessage).not.toHaveBeenCalled()
    const alert = [...host.querySelectorAll('[role="alert"]')].find(node => !node.closest('details'))
    expect(alert?.textContent).toContain('signature from a wallet address only')
  })

  it('refuses to publish when the wallet becomes a Safe after the choice was offered', async () => {
    await render()
    runtime.safe = true
    await act(async () => button('Create without a transaction')!.click())
    expect(runtime.signMessage).not.toHaveBeenCalled()
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    const alert = [...host.querySelectorAll('[role="alert"]')].find(node => !node.closest('details'))
    expect(alert?.textContent).toContain('signature from a wallet address only')
  })

  it('words a Center refusal instead of showing raw provider text', async () => {
    const { JBCenterRequestError } = await import('@bananapus/nana-sdk-core/jbcenter')
    runtime.prepareIntent.mockRejectedValue(new JBCenterRequestError('upstream 503 from provider', 503, 'unavailable'))
    await render()
    await act(async () => button('Create without a transaction')!.click())
    const alert = [...host.querySelectorAll('[role="alert"]')].find(node => !node.closest('details'))
    expect(alert?.textContent).not.toContain('upstream 503 from provider')
    expect(alert?.textContent?.length).toBeGreaterThan(0)
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    expect(navigate.push).not.toHaveBeenCalled()
  })
})
