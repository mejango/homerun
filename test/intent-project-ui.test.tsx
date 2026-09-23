import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeFunctionData, zeroHash, type Hex } from 'viem'
import { HOMERUN_DEPLOYER } from './fixtures/homerun-deployer'
import { homerunDeployerAbi } from '../src/lib/income-contracts'
import { FULL_SETUP_PIN } from './fixtures/full-setup'

const wallet = '0x1111111111111111111111111111111111111111'
const intentId = '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
const contentHash = `0x${'ab'.repeat(32)}` as Hex
const hash = `0x${'ef'.repeat(32)}` as Hex

const runtime = vi.hoisted(() => ({ getIntent: vi.fn(), requestDeploy: vi.fn(), requestRelay: vi.fn(), recordDeployment: vi.fn() }))
const navigate = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => navigate }))
vi.mock('next/image', () => ({ default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} /> }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: '0x1111111111111111111111111111111111111111', openSignIn: vi.fn() }) }))
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  getPublicClient: () => ({ getGasPrice: async () => 2_000_000_000n }),
  sendTransaction: vi.fn(),
  switchChain: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}))
vi.mock('@/lib/jbcenter-client', () => ({ jbCenterClient: {
  getIntent: runtime.getIntent, requestDeploy: runtime.requestDeploy,
  requestRelay: runtime.requestRelay, recordDeployment: runtime.recordDeployment,
} }))

import { IntentProject } from '../src/components/IntentProject'

const call = (chainId: number, mustStartAtOrAfter = 0) => ({
  chainId, to: HOMERUN_DEPLOYER,
  data: encodeFunctionData({
    abi: homerunDeployerAbi, functionName: 'launchFundFor',
    args: [wallet, 'ipfs://bafkreimetadata', 'Neighborhood Workshop FUND', 'FUND', mustStartAtOrAfter, zeroHash, []],
  }),
})

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: intentId, status: 'undeployed', contentHash, publisher: wallet, signature: `0x${'cd'.repeat(65)}`,
    createdAt: new Date(0).toISOString(), deployments: [], deploys: [],
    name: 'Neighborhood Workshop', description: null, tagline: null, tags: [], logoUri: null, owner: wallet,
    envelope: {
      format: 'homerun.money/fund.v1', deploymentVersion: '6', chainIds: [8453],
      deploymentCalls: [call(8453)],
      jb: { app: 'homerun', kind: 'fund', name: 'Neighborhood Workshop', owner: wallet, chainIds: [8453], tokenName: 'Neighborhood Workshop FUND', ticker: 'FUND', salt: zeroHash, mustStartAtOrAfter: 0, projectUri: 'ipfs://bafkreimetadata' },
    },
    ...overrides,
  }
}

const envelopeFor = (calls: ReturnType<typeof call>[]) => ({
  ...intent().envelope,
  chainIds: calls.map(item => item.chainId),
  deploymentCalls: calls,
  jb: { ...intent().envelope.jb, chainIds: calls.map(item => item.chainId) },
})
const deployRow = (chainId: number, status: string) => ({
  chainId, status, transactionHash: status === 'confirmed' ? hash : null, bundleUuid: null, error: null,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
})
const deployment = (chainId: number, projectId: string) => ({ chainId, projectId, transactionHash: hash, createdAt: new Date(0).toISOString() })

import { SAFE_PROXY_CREATION_CODE } from '@bananapus/nana-sdk-core/safe'
import { SAFE_FACTORY, multisigCreationData, predictMultisig } from '../src/lib/create-multisig'

const safeOwners = ['0x000000000000000000000000000000000000dEaD', '0x2222222222222222222222222222222222222222'] as const
const safePolicy = { owners: [...safeOwners] as `0x${string}`[], threshold: 2, saltNonce: `0x${'ab'.repeat(32)}` as Hex, proxyCreationCode: SAFE_PROXY_CREATION_CODE }
const safeAddress = predictMultisig(safePolicy)
const setupCall = (chainId: number) => ({ chainId, to: SAFE_FACTORY, data: multisigCreationData(safePolicy) })

describe('a published project page', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient
  beforeEach(() => {
    runtime.getIntent.mockReset().mockResolvedValue(intent())
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    HTMLElement.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    runtime.requestDeploy.mockReset()
    runtime.requestRelay.mockReset().mockRejectedValue(new Error('no relay in this test'))
    runtime.recordDeployment.mockReset()
    navigate.replace.mockReset()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      name: 'Neighborhood Workshop',
      description: 'Shared tools that earn revenue through community use.',
      logoUri: 'ipfs://bafkreilogo',
      coverImageUri: 'ipfs://bafkreicover',
      homerun: { version: 1, kind: 'fund', setup: { location: 'Florianópolis' } },
    }), { headers: { 'content-type': 'application/json' } })))
    client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })

  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}><IntentProject intentId={intentId} /></QueryClientProvider>))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  }
  const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.startsWith(label))
  const openTab = async (label: string) => {
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent?.trim() === label)
    await act(async () => { tab!.click() })
  }

  it('renders the FUND from the signed calls and the pinned details', async () => {
    await render()
    expect(host.textContent).toContain('Neighborhood Workshop')
    expect(host.textContent).toContain('Shared tools that earn revenue through community use.')
    expect(host.textContent).toContain('Deploys on first use')
    expect(host.querySelector('#project-status')?.textContent).toBe('Status: Deploys on first use')
    expect(host.textContent).toContain('Base')
    expect(host.textContent).toContain('Neighborhood Workshop FUND')
    expect(host.textContent).toContain('FUND')
    expect(host.textContent).toContain(wallet)
    expect(host.querySelector('img[alt*="cover"]')).toBeTruthy()
    expect(button('Deploy selected')).toBeTruthy()
  })

  it('shows every text the pinned setup carries, each in its own place', async () => {
    const launch = {
      chainId: 8453, to: HOMERUN_DEPLOYER,
      data: encodeFunctionData({
        abi: homerunDeployerAbi, functionName: 'launchFundFor',
        args: [wallet, 'ipfs://bafkreimetadata', 'Workshop Bench FUND', 'WKSHP', 0, zeroHash, []],
      }),
    }
    runtime.getIntent.mockResolvedValue(intent({
      envelope: { ...intent().envelope, deploymentCalls: [launch], jb: { ...intent().envelope.jb, tokenName: 'Workshop Bench FUND', ticker: 'WKSHP' } },
    }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FULL_SETUP_PIN), { headers: { 'content-type': 'application/json' } })))
    await render()
    expect(host.querySelector('h1')?.textContent).toContain('Neighborhood Workshop')
    expect(host.querySelector('.hpl-location')?.textContent).toBe('Florianópolis, Brazil')
    expect(host.textContent).toContain('Shared tools that earn revenue through community use.')
    const owner = host.querySelector('section[aria-label="Owner introduction"]')!
    expect(owner.textContent).toContain('Ada Rios')
    expect(owner.textContent).toContain('She keeps the workshop running.')
    const operator = host.querySelector('section[aria-label="Operator introduction"]')!
    expect(operator.textContent).toContain('Bruno Lima')
    expect(operator.textContent).toContain('He maintains the machines and the books.')
    await openTab('Stages')
    await act(async () => { host.querySelector<HTMLButtonElement>('button[data-journey-phase="earning"]')!.click() })
    const income = host.querySelector('#phase-panel')!
    expect(income.querySelector('.revenue-description')?.textContent).toBe('Members pay monthly for bench time, and visitors pay by the hour.')
    const revenue = income.querySelector('.revenue-plan')!
    expect(revenue.textContent).toContain('Minimum monthly revenue')
    expect(revenue.textContent).toContain('$7,500')
    expect(revenue.textContent).toContain('If revenue falls below the minimum')
    expect(revenue.textContent).toContain('The Owner cuts machine hours and reports the shortfall to holders.')
    await openTab('Owners')
    await openTab('Splits')
    const token = host.querySelector('.demo-published-token')!
    expect(token.textContent).toContain('Token name')
    expect(token.textContent).toContain('Workshop Bench FUND')
    expect(token.textContent).toContain('Ticker')
    expect(token.textContent).toContain('WKSHP')
  })

  it('names every multisig the project creates, with its role, approvals and owners', async () => {
    const launch = {
      chainId: 8453, to: HOMERUN_DEPLOYER,
      data: encodeFunctionData({
        abi: homerunDeployerAbi, functionName: 'launchFundFor',
        args: [safeAddress, 'ipfs://bafkreimetadata', 'Neighborhood Workshop FUND', 'FUND', 0, zeroHash, []],
      }),
    }
    runtime.getIntent.mockResolvedValue(intent({
      envelope: {
        ...intent().envelope,
        deploymentCalls: [setupCall(8453), launch],
        jb: {
          ...intent().envelope.jb, owner: safeAddress,
          safes: [{ role: 'owner', address: safeAddress, owners: [...safeOwners], threshold: 2, saltNonce: safePolicy.saltNonce }],
        },
      },
    }))
    await render()
    await openTab('Owners')
    expect(host.textContent).toContain('Owner: create Safe')
    expect(host.textContent).toContain('along with the project')
    expect(host.textContent).toContain('whether the Safe exists yet or not')
    expect(host.textContent).toContain('2/2 approvals')
    expect(host.textContent).toContain(safeOwners[0])
    expect(host.textContent).toContain(safeOwners[1])
  })

  it('models the published setup, with nothing raised against its goal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      name: 'Neighborhood Workshop',
      homerun: { version: 1, kind: 'fund', setup: {
        name: 'Neighborhood Workshop', location: 'Florianópolis',
        purchaseBudget: 250_000, opsReserve: 50_000, monthlyRent: 10_000, monthlyCosts: 6_000,
      } },
    }), { headers: { 'content-type': 'application/json' } })))
    await render()
    expect(host.textContent).toContain('Goal: $307.7K')
    expect(host.textContent).toContain('Funded: 0%')
    expect(host.querySelector('#pay-panel')).toBeTruthy()
    expect(button('Deploy first')?.disabled).toBe(true)
    await openTab('Stages')
    expect(host.textContent).toContain('$307,692.31')
    expect(host.textContent).toContain('$250,000')
  })

  it('deploys through Center, reports each chain, and opens the created project', async () => {
    runtime.requestDeploy.mockResolvedValue({ deploys: [{ chainId: 8453, status: 'queued', transactionHash: null, bundleUuid: null, error: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }] })
    runtime.getIntent
      .mockResolvedValueOnce(intent())
      .mockResolvedValue(intent({
        status: 'deployed',
        deployments: [{ chainId: 8453, projectId: '42', transactionHash: hash, createdAt: new Date(0).toISOString() }],
        deploys: [{ chainId: 8453, status: 'confirmed', transactionHash: hash, bundleUuid: null, error: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      }))
    await render()
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(runtime.requestDeploy).toHaveBeenCalledWith(intentId, expect.objectContaining({ chainIds: [8453] }))
    // Center's next reported step is the one the SDK polls for, four seconds on.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5_000)) })
    expect(navigate.replace).toHaveBeenCalledWith(`/project/8453/42?intent=${intentId}`)
  }, 20_000)

  it('opens the created project immediately when one already exists', async () => {
    runtime.getIntent.mockResolvedValue(intent({
      status: 'deployed',
      deployments: [{ chainId: 8453, projectId: '7', transactionHash: hash, createdAt: new Date(0).toISOString() }],
    }))
    await render()
    expect(navigate.replace).toHaveBeenCalledWith(`/project/8453/7?intent=${intentId}`)
  })

  it('opens nothing for a deployment on a chain this intent does not carry', async () => {
    runtime.getIntent.mockResolvedValue(intent({
      deployments: [{ chainId: 84532, projectId: '7', transactionHash: hash, createdAt: new Date(0).toISOString() }],
    }))
    await render()
    expect(navigate.replace).not.toHaveBeenCalled()
  })

  it('keeps the signed terms and the Deploy action when the pinned details cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway trouble', { status: 500 })))
    await render()
    expect(host.textContent).toContain('The project details could not be loaded.')
    expect(host.textContent).toContain('Neighborhood Workshop FUND')
    expect(host.textContent).toContain('Deploys on first use')
    expect(host.textContent).toContain('Base')
    expect(host.textContent).not.toContain('gateway trouble')
    expect(button('Deploy selected')).toBeTruthy()
  })

  it('says why Center refused, in Center’s words, without raw provider text', async () => {
    const { JBCenterRequestError } = await import('@bananapus/nana-sdk-core/jbcenter')
    runtime.requestDeploy.mockRejectedValue(new JBCenterRequestError('upstream 503 from provider', 503, 'unavailable'))
    await render()
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent?.length).toBeGreaterThan(0)
    expect(alert?.textContent).not.toContain('upstream 503 from provider')
  })

  it('gives a refusal Center does not word one sentence of its own, never the server’s', async () => {
    const { JBCenterRequestError } = await import('@bananapus/nana-sdk-core/jbcenter')
    runtime.requestDeploy.mockRejectedValue(new JBCenterRequestError('sender 0xabc reverted: nonce too low', 500, 'internal_error'))
    await render()
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Center could not start this deploy right now. Try again shortly.')
    expect(host.textContent).not.toContain('nonce too low')
    expect(button('Deploy selected')!.disabled).toBe(false)
  })

  it('offers Ethereum as a chain the reader pays for, beside the free ones', async () => {
    runtime.getIntent.mockResolvedValue(intent({ envelope: envelopeFor([call(1), call(8453)]) }))
    await render()
    expect(host.textContent).toContain('free')
    expect(host.textContent).toContain('costs gas')
    expect(button('Deploy selected')).toBeTruthy()
  })

  it('words a chain Center recorded as failed as the end of this project', async () => {
    runtime.requestDeploy.mockResolvedValue({ deploys: [deployRow(8453, 'failed')] })
    await render()
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Juicebox Center could not create this project on Base. It cannot be deployed from here; create it again.')
    expect(button('Deploy selected')!.disabled).toBe(true)
  })

  it('links the chain that was created when another chain ended the project', async () => {
    const envelope = envelopeFor([call(8453), call(10)])
    runtime.getIntent.mockResolvedValueOnce(intent({ envelope }))
    runtime.getIntent.mockResolvedValue(intent({ envelope, deployments: [deployment(8453, '42')] }))
    runtime.requestDeploy.mockResolvedValue({ deploys: [deployRow(8453, 'confirmed'), deployRow(10, 'failed')] })
    await render()
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Juicebox Center could not create this project on Optimism. It cannot be deployed from here; create it again.')
    const link = Array.from(host.querySelectorAll('a')).find(a => a.getAttribute('href') === '/project/8453/42')
    expect(link?.textContent).toBe('Deployed on Base')
    expect(navigate.replace).toHaveBeenCalledWith(`/project/8453/42?intent=${intentId}`)
  })

  it('opens the first deployed chain in the intent’s own order', async () => {
    const envelope = envelopeFor([call(10), call(8453)])
    runtime.getIntent.mockResolvedValue(intent({ envelope, deployments: [deployment(8453, '42'), deployment(10, '43')] }))
    await render()
    expect(navigate.replace).toHaveBeenCalledWith(`/project/10/43?intent=${intentId}`)
  })

  it('keeps Deploy offered when no chain was recorded as failed', async () => {
    const { JBCenterRequestError } = await import('@bananapus/nana-sdk-core/jbcenter')
    runtime.requestDeploy.mockRejectedValue(new JBCenterRequestError('sender reverted: nonce too low', 400, 'bad_request'))
    await render()
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Center could not start this deploy right now. Try again shortly.')
    expect(host.textContent).not.toContain('nonce too low')
    expect(button('Deploy selected')!.disabled).toBe(false)
  })

  it('holds a linked project on its progress until its last chain is created', async () => {
    const envelope = envelopeFor([call(8453), call(10)])
    let created = 0
    runtime.getIntent.mockImplementation(async () => intent({
      envelope,
      status: created === 2 ? 'deployed' : 'undeployed',
      deployments: [deployment(8453, '42'), deployment(10, '43')].slice(0, created),
      deploys: created === 0 ? [] : [deployRow(8453, 'confirmed'), deployRow(10, created === 2 ? 'confirmed' : 'queued')],
    }))
    runtime.requestDeploy.mockImplementation(async () => {
      created = 1
      return { deploys: [deployRow(8453, 'confirmed'), deployRow(10, 'queued')] }
    })
    await render()
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
    expect(host.textContent).toContain('Base: created')
    expect(host.textContent).toContain('Optimism: queued at Juicebox Center')
    expect(navigate.replace).not.toHaveBeenCalled()
    created = 2
    // Center's next reported step is the one the SDK polls for, four seconds on.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5_000)) })
    expect(navigate.replace).toHaveBeenCalledWith(`/project/8453/42?intent=${intentId}`)
  }, 20_000)

  it('opens contributions as soon as a project whose start has passed is created', async () => {
    runtime.getIntent.mockResolvedValue(intent({ envelope: envelopeFor([call(8453, Math.floor(Date.now() / 1000) - 3_600)]) }))
    await render()
    expect(host.textContent).toContain('Contributions open: as soon as it is created')
  })

  it('gives the date a project whose contributions open later was signed with', async () => {
    const later = Math.floor(Date.now() / 1000) + 86_400
    runtime.getIntent.mockResolvedValue(intent({ envelope: envelopeFor([call(8453, later)]) }))
    await render()
    expect(host.textContent).toContain(`Contributions open: ${new Date(later * 1000).toLocaleString()}`)
  })

  it('abandons the deploy when the reader leaves the page', async () => {
    runtime.requestDeploy.mockResolvedValue({ deploys: [{ chainId: 8453, status: 'queued', transactionHash: null, bundleUuid: null, error: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }] })
    await render()
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const [, options] = runtime.requestDeploy.mock.calls[0] as [string, { signal?: AbortSignal }]
    expect(options.signal?.aborted).toBe(false)
    await act(async () => root.unmount())
    expect(options.signal?.aborted).toBe(true)
  })
})
