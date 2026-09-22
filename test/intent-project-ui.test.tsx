import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeFunctionData, zeroHash, type Hex } from 'viem'
import { HOMERUN_DEPLOYER } from './fixtures/homerun-deployer'
import { homerunDeployerAbi } from '../src/lib/income-contracts'

const wallet = '0x1111111111111111111111111111111111111111'
const intentId = '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
const contentHash = `0x${'ab'.repeat(32)}` as Hex
const hash = `0x${'ef'.repeat(32)}` as Hex

const runtime = vi.hoisted(() => ({ getIntent: vi.fn(), requestDeploy: vi.fn() }))
const navigate = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => navigate }))
vi.mock('next/image', () => ({ default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} /> }))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <span>Wallet</span> }))
vi.mock('@/lib/jbcenter-client', () => ({ jbCenterClient: { getIntent: runtime.getIntent, requestDeploy: runtime.requestDeploy } }))

import { IntentProject } from '../src/components/IntentProject'

const call = (chainId: number) => ({
  chainId, to: HOMERUN_DEPLOYER,
  data: encodeFunctionData({
    abi: homerunDeployerAbi, functionName: 'launchFundFor',
    args: [wallet, 'ipfs://bafkreimetadata', 'Neighborhood Workshop FUND', 'FUND', 0, zeroHash, []],
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

describe('a published project page', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient
  beforeEach(() => {
    runtime.getIntent.mockReset().mockResolvedValue(intent())
    runtime.requestDeploy.mockReset()
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

  it('renders the FUND from the signed calls and the pinned details', async () => {
    await render()
    expect(host.textContent).toContain('Neighborhood Workshop')
    expect(host.textContent).toContain('Shared tools that earn revenue through community use.')
    expect(host.textContent).toContain('Deploys on first use')
    expect(host.textContent).toContain('Base')
    expect(host.textContent).toContain('Neighborhood Workshop FUND')
    expect(host.textContent).toContain('FUND')
    expect(host.textContent).toContain(wallet)
    expect(host.querySelector('img[alt*="cover"]')).toBeTruthy()
    expect(button('Deploy')).toBeTruthy()
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
    await act(async () => { button('Deploy')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(runtime.requestDeploy).toHaveBeenCalledWith(intentId, expect.anything())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(navigate.replace).toHaveBeenCalledWith('/project/8453/42')
  })

  it('opens the created project immediately when one already exists', async () => {
    runtime.getIntent.mockResolvedValue(intent({
      status: 'deployed',
      deployments: [{ chainId: 84532, projectId: '7', transactionHash: hash, createdAt: new Date(0).toISOString() }],
    }))
    await render()
    expect(navigate.replace).toHaveBeenCalledWith('/project/84532/7')
  })

  it('keeps the signed terms and the Deploy action when the pinned details cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway trouble', { status: 500 })))
    await render()
    expect(host.textContent).toContain('The project details could not be loaded.')
    expect(host.textContent).toContain('Neighborhood Workshop FUND')
    expect(host.textContent).toContain('Deploys on first use')
    expect(host.textContent).toContain('Base')
    expect(host.textContent).not.toContain('gateway trouble')
    expect(button('Deploy')).toBeTruthy()
  })

  it('says why Center refused, in Center’s words, without raw provider text', async () => {
    const { JBCenterRequestError } = await import('@bananapus/nana-sdk-core/jbcenter')
    runtime.requestDeploy.mockRejectedValue(new JBCenterRequestError('upstream 503 from provider', 503, 'unavailable'))
    await render()
    await act(async () => { button('Deploy')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent?.length).toBeGreaterThan(0)
    expect(alert?.textContent).not.toContain('upstream 503 from provider')
  })

  it('gives a refusal Center does not word one sentence of its own, never the server’s', async () => {
    const { JBCenterRequestError } = await import('@bananapus/nana-sdk-core/jbcenter')
    runtime.requestDeploy.mockRejectedValue(new JBCenterRequestError('sender 0xabc reverted: nonce too low', 500, 'internal_error'))
    await render()
    await act(async () => { button('Deploy')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Center could not start this deploy right now. Try again shortly.')
    expect(host.textContent).not.toContain('nonce too low')
    expect(button('Deploy')!.disabled).toBe(false)
  })

  it('abandons the deploy when the reader leaves the page', async () => {
    runtime.requestDeploy.mockResolvedValue({ deploys: [{ chainId: 8453, status: 'queued', transactionHash: null, bundleUuid: null, error: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }] })
    await render()
    await act(async () => { button('Deploy')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    const [, options] = runtime.requestDeploy.mock.calls[0] as [string, { signal?: AbortSignal }]
    expect(options.signal?.aborted).toBe(false)
    await act(async () => root.unmount())
    expect(options.signal?.aborted).toBe(true)
  })
})
