import { clearViewAs } from '../src/lib/viewAs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeFunctionData, type Hex } from 'viem'
import { erc2771ForwarderAbi } from '@bananapus/nana-sdk-core'

const runtime = vi.hoisted(() => ({
  requestDeploy: vi.fn(), requestRelay: vi.fn(), getIntent: vi.fn(), recordDeployment: vi.fn(),
  review: vi.fn(), send: vi.fn(), switchChain: vi.fn(), receipt: vi.fn(), gasPrice: vi.fn(),
  readContract: vi.fn(), getCode: vi.fn(),
  address: '0x1111111111111111111111111111111111111111' as string | undefined, openSignIn: vi.fn(),
  safe: false, connector: { id: 'injected', uid: 'original' }, chainId: 1, getWalletClient: vi.fn(),
}))
vi.mock('@/lib/jbcenter-client', () => ({ jbCenterClient: {
  getIntent: runtime.getIntent, requestDeploy: runtime.requestDeploy,
  requestRelay: runtime.requestRelay, recordDeployment: runtime.recordDeployment,
} }))
// Core's reviewed send over this test's wallet: one review of the action, then each call sent and its receipt read.
vi.mock('@bananapus/nana-sdk-core/review', async importOriginal => {
  const core = await importOriginal<typeof import('@bananapus/nana-sdk-core/review')>()
  return { ...core, sendReviewed: async (action: { calls: { chainId: number; to: string; data: string; value?: bigint }[]; assertWriteState?: () => void; beforeWallet?: (call: unknown, step: number) => Promise<void> | void }) => {
    await runtime.review(action)
    const hashes: Hex[] = [], receipts: { status: string }[] = []
    for (const [index, call] of action.calls.entries()) {
      action.assertWriteState?.()
      await action.beforeWallet?.(call, index)
      const sent = await runtime.send({}, { to: call.to, data: call.data, value: call.value })
      const receipt = await runtime.receipt({}, { chainId: call.chainId, hash: sent })
      if (receipt.status !== 'success') throw new core.ReviewedCallRevertedError(index, sent, receipt)
      hashes.push(sent); receipts.push(receipt)
    }
    return { status: 'done', hashes, receipts }
  } }
})
vi.mock('@/lib/reviewed-send-deps', () => ({ reviewedSendDeps: {}, readableEngine: <E,>(engine: E) => engine }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/safe-connector')>(), isSafeConnection: () => runtime.safe,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.address, openSignIn: runtime.openSignIn }) }))
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: runtime.address, connector: runtime.connector, chainId: runtime.chainId }),
  getPublicClient: () => ({ getGasPrice: runtime.gasPrice, readContract: runtime.readContract, getCode: runtime.getCode }),
  getWalletClient: runtime.getWalletClient,
  switchChain: runtime.switchChain,
  waitForTransactionReceipt: runtime.receipt,
}))

import { describeSafeInitializer, functionFromCall } from '@bananapus/nana-sdk-core/review/decode'
import { SAFE_FACTORY } from '../src/lib/create-multisig'
import { TransactionReviewCancelledError } from '@bananapus/nana-sdk-core/review'
import { DeployChains } from '../src/components/DeployChains'
import { deployRow, deployment, intent, intentId, launchReceipt, relayHash, relayRequest, safeAddress, safeIntent, safeOwners, safeRelayRequest, wallet } from './fixtures/deploy-chains'

describe('choosing the chains a published project is deployed on', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient
  beforeEach(() => {
    localStorage.clear()
    clearViewAs()
    runtime.safe = false
    runtime.connector = { id: 'injected', uid: 'original' }
    runtime.chainId = 1
    runtime.getWalletClient.mockReset().mockImplementation(async (_config: unknown, { chainId }: { chainId: number }) => ({ chain: { id: chainId }, sendTransaction: (request: unknown) => runtime.send({}, request) }))
    runtime.address = wallet
    runtime.requestDeploy.mockReset().mockResolvedValue({ deploys: [] })
    runtime.requestRelay.mockReset().mockImplementation(async (_id: string, chainId: number) => relayRequest(chainId))
    runtime.recordDeployment.mockReset().mockResolvedValue(deployment(1, '9'))
    runtime.review.mockReset().mockResolvedValue(undefined)
    runtime.send.mockReset().mockResolvedValue(relayHash)
    runtime.switchChain.mockReset().mockImplementation(async (_config: unknown, { chainId }: { chainId: number }) => { runtime.chainId = chainId })
    runtime.receipt.mockReset().mockResolvedValue(launchReceipt(1, 9n))
    runtime.gasPrice.mockReset().mockResolvedValue(2_000_000_000n)
    runtime.readContract.mockReset().mockResolvedValue(0n)
    runtime.getCode.mockReset().mockResolvedValue('0x')
    client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0, gcTime: Infinity } } })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })

  async function render(value: ReturnType<typeof intent>, heading: 'Deploy' | 'Deploy on more networks' = 'Deploy') {
    runtime.getIntent.mockResolvedValue(value)
    await act(async () => root.render(<QueryClientProvider client={client}>
      <DeployChains intent={value as never} heading={heading} chainIds={value.envelope.chainIds} />
    </QueryClientProvider>))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  }
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
  const alert = () => host.querySelector('[role="alert"]')?.textContent
  const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.startsWith(label))
  const rowFor = (chainId: number) => host.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${chainId}"]`)

  it('labels a sponsored chain free and prices a chain the visitor pays for', async () => {
    await render(intent([1, 10, 8453]))
    expect(host.textContent).toContain('Free')
    expect(host.textContent).toContain('~0.0018 ETH')
    expect(rowFor(10)!.checked).toBe(true)
    expect(rowFor(8453)!.checked).toBe(true)
    expect(rowFor(1)!.checked).toBe(false)
  })

  it('says a price is still being read while the request loads', async () => {
    runtime.requestRelay.mockImplementation(() => new Promise(() => {}))
    await render(intent([1, 8453]))
    expect(host.textContent).toContain('Gas + fee')
  })

  it('links a chain that is already created and offers no checkbox for it', async () => {
    await render(intent([10, 8453], { deployments: [deployment(8453, '42')] }))
    expect(rowFor(8453)).toBeNull()
    const link = [...host.querySelectorAll('a')].find(item => item.getAttribute('href') === '/base:42')
    expect(link?.getAttribute('aria-label')).toBe('Deployed on Base')
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
    expect(runtime.review).toHaveBeenCalledOnce()
    expect(runtime.review.mock.calls[0][0]).toMatchObject({ account: wallet, scope: `homerun:deploy:${intentId}:1` })
    expect(runtime.review.mock.calls[0][0].calls.map((call: { chainId: number; functionName: string }) => [call.chainId, call.functionName])).toEqual([[1, 'execute']])
    // The request Center served, whose deadline is the second it was made.
    const served = await runtime.requestRelay.mock.results.at(-1)!.value
    expect(runtime.send).toHaveBeenCalledWith({}, { to: served.to, data: served.data, value: 0n })
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

  it('creates a multisig this chain does not have yet, before the project', async () => {
    const value = safeIntent([1])
    runtime.requestRelay.mockImplementation(async (_id: string, chainId: number) => safeRelayRequest(chainId))
    runtime.receipt.mockResolvedValue(launchReceipt(1, 9n, safeAddress))
    await render(value)
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(runtime.review.mock.calls[0][0].calls).toHaveLength(2)
    // The review decodes the factory call's own bytes, down to the Safe's owners and threshold.
    const [creation] = runtime.review.mock.calls[0][0].calls
    expect(functionFromCall(creation)?.name).toBe('createProxyWithNonce')
    expect(describeSafeInitializer(1, creation.args?.[1])?.[0].rows).toEqual(expect.arrayContaining([
      ['Owners', safeOwners.join(', ')],
      ['Threshold', '2 of 2'],
    ]))
    expect(runtime.send).toHaveBeenCalledTimes(2)
    expect(runtime.send.mock.calls[0][1].to).toBe(SAFE_FACTORY)
    expect(runtime.recordDeployment).toHaveBeenCalled()
  })

  it('skips a multisig the chain already has, so a second attempt is not refused', async () => {
    const value = safeIntent([1])
    runtime.requestRelay.mockImplementation(async (_id: string, chainId: number) => safeRelayRequest(chainId))
    runtime.receipt.mockResolvedValue(launchReceipt(1, 9n, safeAddress))
    runtime.getCode.mockResolvedValue('0x6080')
    await render(value)
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(runtime.review.mock.calls[0][0].calls).toHaveLength(1)
    expect(runtime.send).toHaveBeenCalledTimes(1)
    expect(runtime.send.mock.calls[0][1].to).toBe(relayRequest(1).to)
    expect(alert()).toBeUndefined()
  })

  it('refuses a relay that asks for more than this chain\u2019s creation fee', async () => {
    runtime.readContract.mockResolvedValue(1_000n)
    runtime.requestRelay.mockImplementation(async (_id: string, chainId: number) => relayRequest(chainId, 2_000n))
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(runtime.send).not.toHaveBeenCalled()
    expect(alert()).toBe('The deploy asked for more than the creation fee.')
  })

  it('leaves the gas for the transaction it sends to the wallet', async () => {
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(Object.hasOwn(runtime.send.mock.calls[0][1] as object, 'gas')).toBe(false)
  })

  it('says the wallet did not send only for its explicit rejection, without the wallet\u2019s own text', async () => {
    runtime.send.mockRejectedValue(Object.assign(new Error('User rejected the request.\nDetails: rejected\nVersion: viem@2.55.19'), { code: 4001 }))
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(alert()).toBe('The wallet did not send the transaction.')
  })

  it('never says a wallet failure other than a rejection sent nothing', async () => {
    runtime.send.mockRejectedValue(new Error('Internal JSON-RPC error.\nVersion: viem@2.55.19'))
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(alert()).toBe('Your wallet may have sent this transaction. Check its activity before you try again.')
  })

  it('says a closed review sent nothing, not that the wallet failed', async () => {
    runtime.review.mockRejectedValue(new TransactionReviewCancelledError())
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(runtime.send).not.toHaveBeenCalled()
    expect(alert()).toBe('Review closed. Nothing was sent.')
  })

  it('refuses a Safe before switching chains or reviewing anything', async () => {
    runtime.safe = true
    try {
      await render(intent([1]))
      await act(async () => { rowFor(1)!.click() })
      await act(async () => { button('Deploy selected')!.click() })
      await settle()
      expect(runtime.switchChain).not.toHaveBeenCalled()
      expect(runtime.review).not.toHaveBeenCalled()
      expect(runtime.send).not.toHaveBeenCalled()
      expect(alert()).toBe('Deploying from a Safe isn’t supported here. Connect an ordinary wallet to deploy these networks.')
    } finally {
      runtime.safe = false
    }
  })

  it('sends nothing when the connection turns out to be a Safe during the review', async () => {
    // A WalletConnect peer read lands while the review is open.
    runtime.review.mockImplementationOnce(async () => { runtime.safe = true })
    try {
      await render(intent([1]))
      await act(async () => { rowFor(1)!.click() })
      await act(async () => { button('Deploy selected')!.click() })
      await settle()
      expect(runtime.review).toHaveBeenCalledOnce()
      expect(runtime.send).not.toHaveBeenCalled()
      expect(alert()).toBe('Deploying from a Safe isn’t supported here. Connect an ordinary wallet to deploy these networks.')
    } finally {
      runtime.safe = false
    }
  })

  it('says the transaction reverted on the chain it was sent to', async () => {
    runtime.receipt.mockResolvedValue({ ...launchReceipt(1, 9n), status: 'reverted' })
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(alert()).toContain('failed onchain')
    expect(runtime.recordDeployment).not.toHaveBeenCalled()
  })

  it('says a created project is not recorded yet, and records it without the wallet next time', async () => {
    runtime.recordDeployment.mockRejectedValueOnce(new Error('center gateway 503'))
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(alert()).toBe('Your Ethereum transaction went through, but the project page has not picked it up yet. Try again to finish.')
    const relays = runtime.requestRelay.mock.calls.length
    await act(async () => { button('Finish deploy')!.click() })
    await settle()
    // Center refuses a second relay for a creation that exists, so none is asked for.
    expect(runtime.requestRelay).toHaveBeenCalledTimes(relays)
    expect(runtime.send).toHaveBeenCalledTimes(1)
    expect(runtime.review).toHaveBeenCalledTimes(1)
    expect(runtime.recordDeployment).toHaveBeenCalledTimes(2)
    expect(runtime.recordDeployment.mock.calls[1].slice(0, 2)).toEqual([intentId, { chainId: 1, projectId: '9', transactionHash: relayHash }])
    expect(alert()).toBeUndefined()
  })

  it('holds a created project through a reload, and records it there without the wallet', async () => {
    runtime.recordDeployment.mockRejectedValueOnce(new Error('center gateway 503'))
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(JSON.parse(localStorage.getItem('homerun:relay-held:v1')!)).toEqual([
      { intentId, chainId: 1, projectId: '9', transactionHash: relayHash },
    ])
    // The reader reloads before Center has recorded the project.
    await act(async () => root.unmount())
    runtime.send.mockClear(); runtime.review.mockClear(); runtime.recordDeployment.mockClear()
    root = createRoot(host)
    await render(intent([1]))
    expect(host.textContent).toContain('Created, finishing')
    expect(rowFor(1)!.checked).toBe(true)
    await act(async () => { button('Finish deploy')!.click() })
    await settle()
    expect(runtime.send).not.toHaveBeenCalled()
    expect(runtime.review).not.toHaveBeenCalled()
    expect(runtime.recordDeployment.mock.calls[0].slice(0, 2)).toEqual([intentId, { chainId: 1, projectId: '9', transactionHash: relayHash }])
    expect(localStorage.getItem('homerun:relay-held:v1')).toBeNull()
  })

  it('records a held project for a reader who has no wallet connected', async () => {
    runtime.recordDeployment.mockRejectedValueOnce(new Error('center gateway 503'))
    await render(intent([1]))
    await act(async () => { rowFor(1)!.click() })
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    await act(async () => root.unmount())
    runtime.address = undefined
    root = createRoot(host)
    await render(intent([1]))
    await act(async () => { button('Finish deploy')!.click() })
    await settle()
    expect(runtime.openSignIn).not.toHaveBeenCalled()
    expect(runtime.recordDeployment).toHaveBeenCalledTimes(2)
  })

  it('keeps the other chains deployable when Center fails one', async () => {
    runtime.requestDeploy.mockResolvedValue({ deploys: [deployRow(8453, 'failed')] })
    await render(intent([1, 10, 8453]))
    await act(async () => { button('Deploy selected')!.click() })
    await settle()
    expect(alert()).toBe('This project could not be created on Base. It cannot be deployed from here; create it again.')
    expect(rowFor(8453)!.disabled).toBe(true)
    expect(rowFor(10)!.disabled).toBe(false)
    expect(rowFor(1)!.disabled).toBe(false)
    expect(button('Deploy selected')!.disabled).toBe(false)
  })

  it('names the networks a created project can still be deployed on', async () => {
    await render(intent([1, 8453]), 'Deploy on more networks')
    expect(host.querySelector('h2')?.textContent).toBe('Deploy on more networks')
  })

  it('drops a chain from the selection once a refetch shows it created', async () => {
    const value = intent([10, 8453])
    await render(value)
    expect(rowFor(10)!.checked).toBe(true)
    await act(async () => root.render(<QueryClientProvider client={client}>
      <DeployChains intent={{ ...value, deployments: [deployment(10, '41')] } as never} heading="Deploy" chainIds={value.envelope.chainIds} />
    </QueryClientProvider>))
    await act(async () => { rowFor(8453)!.click() })
    expect(button('Deploy selected')!.disabled).toBe(true)
  })

  it('reads a relay cost once for a chain, however often the panel is shown', async () => {
    await render(intent([1, 8453]))
    await act(async () => root.unmount())
    root = createRoot(host)
    await render(intent([1, 8453]))
    expect(runtime.requestRelay).toHaveBeenCalledTimes(1)
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
