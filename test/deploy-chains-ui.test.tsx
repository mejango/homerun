import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, zeroHash, type Hex } from 'viem'
import { erc2771ForwarderAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { HOMERUN_DEPLOYER } from './fixtures/homerun-deployer'
import { homerunDeployerAbi } from '../src/lib/income-contracts'

const wallet = '0x1111111111111111111111111111111111111111'
const intentId = '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
const hash = `0x${'ef'.repeat(32)}` as Hex
const relayHash = `0x${'ab'.repeat(32)}` as Hex

const runtime = vi.hoisted(() => ({
  requestDeploy: vi.fn(), requestRelay: vi.fn(), getIntent: vi.fn(), recordDeployment: vi.fn(),
  review: vi.fn(), send: vi.fn(), switchChain: vi.fn(), receipt: vi.fn(), gasPrice: vi.fn(),
  address: '0x1111111111111111111111111111111111111111' as string | undefined, openSignIn: vi.fn(),
}))
vi.mock('@/lib/jbcenter-client', () => ({ jbCenterClient: {
  getIntent: runtime.getIntent, requestDeploy: runtime.requestDeploy,
  requestRelay: runtime.requestRelay, recordDeployment: runtime.recordDeployment,
} }))
vi.mock('@/lib/transaction-review', () => ({ requireTransactionReview: runtime.review }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, openSignIn: runtime.openSignIn }) }))
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: runtime.address }),
  getPublicClient: () => ({ getGasPrice: runtime.gasPrice }),
  sendTransaction: runtime.send,
  switchChain: runtime.switchChain,
  waitForTransactionReceipt: runtime.receipt,
}))

import { DeployChains } from '../src/components/DeployChains'

const launch = (chainId: number) => ({
  chainId, to: HOMERUN_DEPLOYER,
  data: encodeFunctionData({
    abi: homerunDeployerAbi, functionName: 'launchFundFor',
    args: [wallet, 'ipfs://bafkreimetadata', 'Neighborhood Workshop FUND', 'FUND', 0, zeroHash, []],
  }),
})
const deployRow = (chainId: number, status: string) => ({
  chainId, status, transactionHash: status === 'confirmed' ? hash : null, bundleUuid: null, error: null,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
})
const deployment = (chainId: number, projectId: string) => ({ chainId, projectId, transactionHash: hash, createdAt: new Date(0).toISOString() })
function intent(chainIds: number[], overrides: Record<string, unknown> = {}) {
  return {
    id: intentId, status: 'undeployed', contentHash: `0x${'ab'.repeat(32)}`, publisher: wallet,
    signature: `0x${'cd'.repeat(65)}`, createdAt: new Date(0).toISOString(), deployments: [], deploys: [],
    name: 'Neighborhood Workshop', description: null, tagline: null, tags: [], logoUri: null, owner: wallet,
    envelope: {
      format: 'homerun.money/fund.v1', deploymentVersion: '6', chainIds,
      deploymentCalls: chainIds.map(launch),
      jb: { app: 'homerun', kind: 'fund', name: 'Neighborhood Workshop', owner: wallet, chainIds, tokenName: 'Neighborhood Workshop FUND', ticker: 'FUND', salt: zeroHash, mustStartAtOrAfter: 0, projectUri: 'ipfs://bafkreimetadata' },
    },
    ...overrides,
  }
}
/** The deployer's own FundLaunched event, as a receipt the wallet's transaction produced. */
const launchReceipt = (chainId: number, projectId: bigint) => ({
  status: 'success', transactionHash: relayHash, blockNumber: 1_000n,
  logs: [{
    address: launch(chainId).to,
    topics: encodeEventTopics({ abi: homerunDeployerAbi, eventName: 'FundLaunched', args: { projectId, owner: wallet } }),
    data: encodeAbiParameters([{ type: 'address' }], [`0x${'5e'.repeat(20)}`]),
  }],
})
const relayRequest = (chainId: number) => ({
  chainId, to: v6Address('ERC2771Forwarder', chainId as never), value: 0n, gas: 900_000n,
  deadline: Math.floor(Date.now() / 1000) + 1_800, setup: [],
  data: encodeFunctionData({
    abi: erc2771ForwarderAbi, functionName: 'execute',
    args: [{ from: wallet, to: launch(chainId).to, value: 0n, gas: 900_000n, deadline: Math.floor(Date.now() / 1000) + 1_800, data: launch(chainId).data, signature: `0x${'ab'.repeat(65)}` }],
  }),
})

describe('choosing the chains a published project is deployed on', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient
  beforeEach(() => {
    runtime.address = wallet
    runtime.requestDeploy.mockReset().mockResolvedValue({ deploys: [] })
    runtime.requestRelay.mockReset().mockImplementation(async (_id: string, chainId: number) => relayRequest(chainId))
    runtime.recordDeployment.mockReset().mockResolvedValue(deployment(1, '9'))
    runtime.review.mockReset().mockResolvedValue(undefined)
    runtime.send.mockReset().mockResolvedValue(relayHash)
    runtime.switchChain.mockReset().mockResolvedValue(undefined)
    runtime.receipt.mockReset().mockResolvedValue(launchReceipt(1, 9n))
    runtime.gasPrice.mockReset().mockResolvedValue(2_000_000_000n)
    client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })

  async function render(value: ReturnType<typeof intent>) {
    runtime.getIntent.mockResolvedValue(value)
    await act(async () => root.render(<QueryClientProvider client={client}>
      <DeployChains intent={value as never} heading="Deploy" chainIds={value.envelope.chainIds} />
    </QueryClientProvider>))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  }
  const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.startsWith(label))
  const rowFor = (chainId: number) => host.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${chainId}"]`)

  it('labels a sponsored chain free and prices a chain the visitor pays for', async () => {
    await render(intent([1, 10, 8453]))
    expect(host.textContent).toContain('free')
    expect(host.textContent).toContain('costs ~0.0018 ETH')
    expect(rowFor(10)!.checked).toBe(true)
    expect(rowFor(8453)!.checked).toBe(true)
    expect(rowFor(1)!.checked).toBe(false)
  })

  it('says a price is still being read while the request loads', async () => {
    runtime.requestRelay.mockImplementation(() => new Promise(() => {}))
    await render(intent([1, 8453]))
    expect(host.textContent).toContain('costs gas')
  })

  it('links a chain that is already created and offers no checkbox for it', async () => {
    await render(intent([10, 8453], { deployments: [deployment(8453, '42')] }))
    expect(rowFor(8453)).toBeNull()
    const link = [...host.querySelectorAll('a')].find(item => item.getAttribute('href') === '/project/8453/42')
    expect(link?.textContent).toBe('Deployed on Base')
  })

  it('queues only the sponsored chains the reader ticked', async () => {
    const value = intent([1, 10, 8453])
    await render(value)
    await act(async () => { rowFor(8453)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(runtime.requestDeploy).toHaveBeenCalledWith(intentId, expect.objectContaining({ chainIds: [10] }))
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('sends the chain the visitor pays for from their own wallet, after a review', async () => {
    const value = intent([1, 8453])
    runtime.getIntent.mockResolvedValue({ ...value, deployments: [deployment(1, '9'), deployment(8453, '42')], deploys: [deployRow(1, 'confirmed'), deployRow(8453, 'confirmed')] })
    await render(value)
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
    expect(runtime.review.mock.calls[0][0].kind).toBe('transaction')
    expect(runtime.review.mock.calls[0][0].calls[0].functionName).toBe('execute')
    expect(runtime.switchChain).toHaveBeenCalledWith({}, { chainId: 1 })
    expect(runtime.send).toHaveBeenCalledWith({}, expect.objectContaining({ chainId: 1, to: relayRequest(1).to, value: 0n }))
    expect(runtime.recordDeployment.mock.calls[0].slice(0, 2)).toEqual([intentId, { chainId: 1, projectId: '9', transactionHash: relayHash }])
    expect(runtime.requestDeploy).toHaveBeenCalledWith(intentId, expect.objectContaining({ chainIds: [8453] }))
  })

  it('records nothing when the paid transaction created no project', async () => {
    runtime.receipt.mockResolvedValue({ ...launchReceipt(1, 9n), logs: [] })
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
    expect(runtime.send).toHaveBeenCalled()
    expect(runtime.recordDeployment).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('did not create this project')
  })

  it('refuses a relay request that forwards a different call, and sends nothing', async () => {
    runtime.requestRelay.mockImplementation(async (_id: string, chainId: number) => ({
      ...relayRequest(chainId),
      data: encodeFunctionData({
        abi: erc2771ForwarderAbi, functionName: 'execute',
        args: [{ from: wallet, to: `0x${'22'.repeat(20)}`, value: 0n, gas: 900_000n, deadline: Math.floor(Date.now() / 1000) + 1_800, data: '0xdeadbeef', signature: `0x${'ab'.repeat(65)}` }],
      }),
    }))
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
    expect(runtime.send).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('does not match the project this link publishes')
  })

  it('asks an unconnected reader to sign in before a chain they pay for', async () => {
    runtime.address = undefined
    await render(intent([1, 8453]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(runtime.openSignIn).toHaveBeenCalled()
    expect(runtime.send).not.toHaveBeenCalled()
  })
})
