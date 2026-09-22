import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import type { Hex } from 'viem'
import { CREATE_DEFAULTS, CREATE_DRAFT_KEY } from '../web/create-model.mjs'
import { FUND_LAUNCH_KEY, decodeLaunchSession, encodeLaunchSession } from '../src/lib/fund-launch-session'

const wallet = '0x1111111111111111111111111111111111111111'
const intentId = '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
const contentHash = `0x${'ab'.repeat(32)}` as Hex
const signature = `0x${'cd'.repeat(65)}` as Hex
const publicationMessage = `Juice Central project intent\nVersion: 1\nContent hash: ${contentHash}`

const runtime = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as string | undefined, centerWallet: false, safe: false, openSignIn: vi.fn(),
  readContract: vi.fn(), getBlock: vi.fn(), getCode: vi.fn(), publish: vi.fn(), checkDeployment: vi.fn(),
  signMessage: vi.fn(), review: vi.fn(), prepareIntent: vi.fn(), publishIntent: vi.fn(),
}))
const navigate = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => navigate }))
vi.mock('next/image', () => ({ default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} /> }))
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: runtime.address }),
  getPublicClient: () => ({ readContract: runtime.readContract, getBlock: runtime.getBlock, getCode: runtime.getCode }),
  signMessage: runtime.signMessage,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, isCenterWallet: runtime.centerWallet, openSignIn: runtime.openSignIn }) }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => runtime.safe, waitForSafeExecutionHash: vi.fn() }))
vi.mock('@/lib/publish-fund-project-metadata', () => ({ publishFundProjectMetadata: runtime.publish }))
vi.mock('@/lib/fund-launch-verification', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/fund-launch-verification')>(),
  checkLaunchDeployment: runtime.checkDeployment,
}))
vi.mock('@/lib/transaction-review', () => ({ requireTransactionReview: runtime.review }))
vi.mock('@/lib/jbcenter-client', () => ({ jbCenterClient: { prepareIntent: runtime.prepareIntent, publishIntent: runtime.publishIntent } }))
vi.mock('@bananapus/nana-sdk-core/safe', async original => {
  const sdk = await original<typeof import('@bananapus/nana-sdk-core/safe')>()
  return { ...sdk, resolveSafeAddress: vi.fn(async (input: Parameters<typeof sdk.resolveSafeAddress>[0]) => {
    if (input.kind === 'existing') return sdk.resolveSafeAddress(input, [])
    const policy = { owners: input.owners, threshold: input.threshold, saltNonce: input.saltNonce, proxyCreationCode: sdk.SAFE_PROXY_CREATION_CODE }
    return { address: sdk.predictSafeAddress(policy), plan: { ...policy, address: sdk.predictSafeAddress(policy) } }
  }) }
})

import CreatePreview from '../src/components/CreatePreview'

const signers = [`0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`]

const saved = (overrides: Record<string, unknown> = {}) => ({
  raw: {
    ...CREATE_DEFAULTS,
    name: 'Neighborhood Workshop',
    location: 'Florianópolis',
    description: 'Shared tools that earn revenue through community use.',
    fundTokenName: 'Neighborhood Workshop FUND',
    fundTicker: 'FUND',
    photo: 'data:image/jpeg;base64,/9j/previews',
    ownerMode: 'existing', ownerWallet: wallet, ownerIsOperator: true,
    operatorMode: 'existing', operatorWallet: wallet,
    networks: ['base'], networkEnvironment: 'production',
    ...overrides,
  },
  step: 4,
  incomeDefaultsVersion: 3,
})

describe('the preview of a project that is not created yet', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(saved()))
    runtime.address = wallet
    runtime.centerWallet = false
    runtime.safe = false
    runtime.openSignIn.mockReset()
    runtime.readContract.mockReset().mockResolvedValue(0n)
    runtime.getBlock.mockReset().mockResolvedValue({ timestamp: 1_800_000_000n })
    runtime.getCode.mockReset().mockResolvedValue('0x6000')
    runtime.publish.mockReset().mockResolvedValue({ cid: 'bafkreimetadata' })
    runtime.checkDeployment.mockReset().mockResolvedValue(undefined)
    runtime.review.mockReset().mockResolvedValue(undefined)
    runtime.signMessage.mockReset().mockResolvedValue(signature)
    runtime.prepareIntent.mockReset().mockImplementation(async (envelope: unknown) => ({ contentHash, message: publicationMessage, envelope }))
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
  const alert = () => [...host.querySelectorAll('[role="alert"]')].find(node => !node.closest('details'))
  const render = async () => { await act(async () => root.render(<CreatePreview />)) }

  it('renders the saved setup as the project page, and says nothing is created', async () => {
    await render()
    expect(host.textContent).toContain('Preview. Nothing is created yet.')
    expect(host.textContent).toContain('Neighborhood Workshop')
    expect(host.textContent).toContain('Florianópolis')
    expect(host.textContent).toContain('Shared tools that earn revenue through community use.')
    expect(host.textContent).toContain('Neighborhood Workshop FUND')
    expect(host.textContent).toContain('Base')
    expect(host.textContent).toContain(wallet)
    expect(host.querySelector('img[alt*="cover"]')?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/previews')
    expect(button('Edit')).toBeTruthy()
    expect(button('Create')).toBeTruthy()
  })

  it('names a multisig the project will create, without claiming an address', async () => {
    localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(saved({
      ownerMode: 'create', ownerSigners: signers, ownerThreshold: 2, ownerWallet: '',
    })))
    await render()
    expect(host.textContent).toContain('2/2 approvals')
    expect(host.textContent).toContain(signers[0])
    expect(host.textContent).not.toContain('Deploys on first use')
  })

  it('goes back to the setup without changing it', async () => {
    await render()
    const before = localStorage.getItem(CREATE_DRAFT_KEY)
    await act(async () => { button('Edit')!.click() })
    expect(navigate.push).toHaveBeenCalledWith('/create')
    expect(localStorage.getItem(CREATE_DRAFT_KEY)).toBe(before)
  })

  it('publishes the intent and opens its page', async () => {
    await render()
    await act(async () => { button('Create')!.click() })
    const review = runtime.review.mock.calls[0][0]
    expect(review.kind).toBe('authorization')
    expect(review.calls[0].functionName).toBe('launchFundFor')
    expect(review.calls[0].from).toBeUndefined()
    expect(review.calls[0].label).toContain('Center’s sponsor')
    expect(review.authorization.kind).toBe('message')
    expect(review.authorization.format).toBe('homerun.money/fund.v1')
    expect(review.authorization.chainIds).toEqual([8453])
    expect(runtime.signMessage).toHaveBeenCalledWith({}, { account: wallet, message: publicationMessage })
    const session = decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)
    expect(session.transport).toBe('intent')
    expect(session.intentId).toBe(intentId)
    expect(navigate.push).toHaveBeenCalledWith(`/intent/${intentId}`)
  })

  it('reviews the Safe creation before the launch, and publishes both', async () => {
    localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(saved({
      ownerMode: 'create', ownerSigners: signers, ownerThreshold: 2, ownerWallet: '',
    })))
    await render()
    await act(async () => { button('Create')!.click() })
    const review = runtime.review.mock.calls[0][0]
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
    expect(envelope.jb.safes).toHaveLength(1)
    expect(envelope.jb.safes[0].role).toBe('owner')
    expect(envelope.jb.owner).toBe(envelope.jb.safes[0].address)
    expect(navigate.push).toHaveBeenCalledWith(`/intent/${intentId}`)
  })

  it('asks an unconnected visitor to sign in, and publishes nothing', async () => {
    runtime.address = undefined
    await render()
    await act(async () => { button('Create')!.click() })
    expect(runtime.openSignIn).toHaveBeenCalled()
    expect(runtime.publishIntent).not.toHaveBeenCalled()
  })

  it('says a Safe or passkey connection has to create with a transaction', async () => {
    runtime.safe = true
    await render()
    await act(async () => { button('Create')!.click() })
    expect(alert()?.textContent).toContain('create with a transaction')
    expect(runtime.publishIntent).not.toHaveBeenCalled()
  })

  it('starts its own record instead of converting a saved transaction plan', async () => {
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
    await render()
    await act(async () => { button('Create')!.click() })
    const session = decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!)
    expect(session.transport).toBe('intent')
    expect(session.intentId).toBe(intentId)
    expect(session.input.salt).not.toBe(unsigned.input.salt)
  })

  it('keeps a saved launch that already has authorizations', async () => {
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
    await render()
    await act(async () => { button('Create')!.click() })
    expect(decodeLaunchSession(localStorage.getItem(FUND_LAUNCH_KEY)!).transport).toBe('direct')
    expect(runtime.signMessage).not.toHaveBeenCalled()
    expect(alert()?.textContent).toContain('A saved launch already exists')
  })

  it('words a Center refusal instead of showing raw provider text', async () => {
    const { JBCenterRequestError } = await import('@bananapus/nana-sdk-core/jbcenter')
    runtime.prepareIntent.mockRejectedValue(new JBCenterRequestError('upstream 503 from provider', 503, 'unavailable'))
    await render()
    await act(async () => { button('Create')!.click() })
    expect(alert()?.textContent).not.toContain('upstream 503 from provider')
    expect(alert()?.textContent?.length).toBeGreaterThan(0)
    expect(localStorage.getItem(FUND_LAUNCH_KEY)).toBeNull()
    expect(navigate.push).not.toHaveBeenCalled()
  })

  it('sends a visitor with no saved setup back to the form', async () => {
    localStorage.removeItem(CREATE_DRAFT_KEY)
    await render()
    expect(host.textContent).toContain('This project’s setup could not be read in this browser.')
    expect(host.querySelector<HTMLAnchorElement>('a[href="/create"]')).toBeTruthy()
    expect(button('Create')).toBeUndefined()
  })
})
