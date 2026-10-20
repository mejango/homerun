import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, keccak256, parseAbi, stringToHex } from 'viem'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { createHomerunPayment, signaPayFailure } from '@/lib/center-payment'
import { buildUserPayMetadata } from '@bananapus/nana-sdk-core/v6'
const account = '0x1111111111111111111111111111111111111111', terminal = '0x2222222222222222222222222222222222222222', token = '0x3333333333333333333333333333333333333333', hash = '0x' + 'ab'.repeat(32)
function fixture() {
  const data = new Map<string, string>(), events: string[] = [], planInputs: unknown[] = []
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const config = { issuer: 'https://my.juicebox.center', audience: 'https://juicebox.center', manifest: { id: 'reviewed', revision: hash }, maximumNetworkFee: '100000000000000' }
  const intent = { projectId: '7', token, terminal, amount: '1000000', minimumReturnedTokens: '99', returnPath: '/project/8453/7' }
  const plan = { id: 'plan-original', smartAccount: { address: account, chainId: 8453 }, draft: { calls: [{ chainId: 8453, to: terminal, value: '0',
    data: encodeFunctionData({ abi: parseAbi(['function pay(uint256,address,uint256,address,uint256,string,bytes)']), functionName: 'pay', args: [7n, token, 1000000n, account, 100n, '', '0x'] }) }] } }
  const binding = { id: hash, ownerAccountId: 'eip155:8453:' + account, manifestId: 'reviewed', wallet: { chainId: 8453, address: account },
    state: { address: account, chainId: 8453, manifestId: 'reviewed', manifestRevision: hash, moduleConfigurationVerified: true,
      modules: { complete: true, arbitrarySigningDisabled: true, wildcardExecutionDisabled: true }, threshold: 1, executionVerified: false,
      ownerProfile: { version: 'center-passkey-v1', signer: { kind: 'contract', address: token } }, owners: [token, terminal],
      evidence: { chainId: 8453, source: 'onchain', timestamp: String(Math.floor(Date.now() / 1000)) } } }
  const record = { id: 'operation-original', signing: { ownerProfile: 'center-passkey-v1' } }
  let status: { status: string; operationId?: string; approvalUrl?: string; expectedPayment?: unknown } | null = null
  const payments = { preparePayment: vi.fn(async input => { events.push('review'); return status = { status: 'reviewing', operationId: record.id,
    approvalUrl: config.issuer + '/wallet/payment?review=original', expectedPayment: input.expectedPayment } }),
    pendingPayment: () => status, submitPayment: vi.fn(async () => { events.push('send'); status = { ...status, status: 'pending' }; return status }),
    refreshPayment: vi.fn(async () => status), clearPayment: vi.fn(() => { if (!['paid', 'cancelled', 'reverted', 'expired'].includes(status?.status ?? '')) throw Error('unresolved'); status = null }) }
  const connection = { address: account, chainId: 8453, accountId: 'eip155:8453:' + account, client: {
    authorizeRead: vi.fn(async () => ({ claims: { accountId: 'eip155:8453:' + account, signer: token, grantId: 'grant-original' } })),
    smartAccounts: () => ({ bindings: async () => ({ items: [binding] }), binding: async () => binding,
      preparePlan: async (...args: unknown[]) => { events.push('plan'); planInputs.push(args[2]); return structuredClone(plan) } }),
    request: async () => { events.push('operation'); return structuredClone(record) },
  } }
  const wallet = { restoreConnection: () => connection, payments: () => payments }
  const create = () => createHomerunPayment({ config, wallet, storage } as never)
  return { connection, data, storage, config, intent, plan, binding, wallet, payments, create, events, planInputs, setStatus: (state: string) => { status = { ...status, status: state } } }
}
describe('Homerun original Center payment recovery', () => {
  beforeEach(() => clearViewAs())
  it.each(['prepare', 'submit'] as const)('rejects view-as activated during final %s authorization without losing recovery', async action => {
    const f = fixture(), controller = f.create()
    await controller.prepare(f.intent as never)
    f.setStatus('approved')
    f.payments.preparePayment.mockClear()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const authorizing = new Promise<void>(resolve => { entered = resolve })
    const original = f.connection.client.authorizeRead.getMockImplementation()!
    // Preparing an existing operation authorizes once on entry and once before its review.
    if (action === 'prepare') f.connection.client.authorizeRead.mockImplementationOnce(original)
    f.connection.client.authorizeRead.mockImplementationOnce(async () => { entered(); await waiting; return original() })
    const result = action === 'prepare' ? controller.prepare(f.intent as never) : controller.submit()
    await authorizing
    setViewAs(account)
    release()
    await expect(result).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(f.payments.preparePayment).not.toHaveBeenCalled()
    expect(f.payments.submitPayment).not.toHaveBeenCalled()
    expect(controller.pending()?.submitted).toBe(false)
    await controller.refresh()
    expect(f.payments.refreshPayment).toHaveBeenCalledOnce()
    clearViewAs()
    await controller.submit()
    setViewAs(account)
    await controller.submit()
    expect(f.payments.submitPayment).toHaveBeenCalledOnce()
    expect(f.payments.refreshPayment).toHaveBeenCalledTimes(2)
  })

  it('does not archive an unresolved review and still closes it after a terminal result', async () => {
    const f = fixture(), controller = f.create(); await controller.prepare(f.intent as never)
    expect(() => controller.clear()).toThrow()
    expect([...f.data.keys()].some(key => key.endsWith(':history'))).toBe(false)
    f.setStatus('paid'); controller.clear(); expect(controller.pending()).toBeNull()
  })
  it('closes a payment that expired before inclusion: nothing was charged and the customer can pay again', async () => {
    const f = fixture(), controller = f.create(); await controller.prepare(f.intent as never)
    f.setStatus('expired'); controller.clear(); expect(controller.pending()).toBeNull()
  })
  it('uses the deployed passkey binding without requiring a prior cached execution and reviews an equal or better minimum', async () => {
    const f = fixture(), controller = f.create()
    expect((await controller.prepare(f.intent as never)).status).toBe('reviewing')
    expect(f.events).toEqual(['plan', 'operation', 'review'])
    expect(f.payments.preparePayment.mock.calls[0]![0].expectedPayment).toMatchObject({ account, amount: '1000000', projectId: '7', minimumReturnedTokens: '100', maximumNetworkFee: f.config.maximumNetworkFee })
    expect(f.payments.submitPayment).not.toHaveBeenCalled()
    expect(f.create().pending()?.intent).toEqual(f.intent)
  })
  it('plans and reviews the quote metadata, and refuses a plan that drops or changes it', async () => {
    const metadata = buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 99n, tiers: { metadataIdTarget: `0x${'11'.repeat(20)}`, tierIdsToMint: [1n, 2n] } })
    const pay = (bytes: `0x${string}`) => encodeFunctionData({ abi: parseAbi(['function pay(uint256,address,uint256,address,uint256,string,bytes)']), functionName: 'pay', args: [7n, token, 1000000n, account, 100n, '', bytes] })
    const f = fixture(), intent = { ...f.intent, metadata }
    f.plan.draft.calls[0]!.data = pay(metadata)
    expect((await f.create().prepare(intent as never)).status).toBe('reviewing')
    expect(f.planInputs[0]).toMatchObject({ metadata, slippageBps: 100 })
    expect(f.payments.preparePayment.mock.calls[0]![0].expectedPayment).toMatchObject({ metadata })
    expect(f.create().pending()?.intent).toEqual(intent)
    for (const bytes of ['0x', buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 98n })] as const) {
      const g = fixture(); g.plan.draft.calls[0]!.data = pay(bytes)
      await expect(g.create().prepare({ ...g.intent, metadata } as never)).rejects.toThrow('differs')
      expect(g.payments.preparePayment).not.toHaveBeenCalled()
    }
    const g = fixture(); g.plan.draft.calls[0]!.data = pay(metadata)
    await expect(g.create().prepare(g.intent as never)).rejects.toThrow('differs')
    await expect(fixture().create().prepare({ ...g.intent, metadata: '0x1' } as never)).rejects.toThrow('metadata')
  })
  it('closes a preparation that never reached review, then prepares a fresh quote', async () => {
    const f = fixture(), controller = f.create()
    f.connection.client.request = async () => { throw new Error('simulation reverted below the minimum') }
    await expect(controller.prepare(f.intent as never)).rejects.toThrow('simulation reverted')
    await expect(controller.prepare({ ...f.intent, minimumReturnedTokens: '90' } as never)).rejects.toThrow('Finish or close')
    // Repeated failed preparations never fill the bounded payment history.
    for (let i = 0; i < 70; i++) {
      controller.clear(); expect(controller.pending()).toBeNull()
      await expect(controller.prepare(f.intent as never)).rejects.toThrow('simulation reverted')
    }
    controller.clear()
    expect([...f.data.keys()].some(key => key.endsWith(':history'))).toBe(false)
    f.connection.client.request = async () => structuredClone({ id: 'operation-original', signing: { ownerProfile: 'center-passkey-v1' } })
    expect((await controller.prepare({ ...f.intent, minimumReturnedTokens: '90' } as never)).status).toBe('reviewing')
  })
  it('does not open a review for a journal another controller closed during preparation', async () => {
    const f = fixture(), first = f.create()
    f.connection.client.request = async () => { throw new Error('operation unavailable') }
    await expect(first.prepare(f.intent as never)).rejects.toThrow('operation unavailable')
    f.connection.client.request = async () => structuredClone({ id: 'operation-original', signing: { ownerProfile: 'center-passkey-v1' } })
    // The resumed preparation waits on its final authorization while a remounted page starts over.
    const original = f.connection.client.authorizeRead.getMockImplementation()!
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), authorizing = new Promise<void>(resolve => { entered = resolve })
    f.connection.client.authorizeRead.mockImplementationOnce(original).mockImplementationOnce(original)
      .mockImplementationOnce(async () => { entered(); await waiting; return original() })
    const resumed = first.prepare(f.intent as never)
    await authorizing
    f.create().clear()
    release()
    await expect(resumed).rejects.toThrow()
    expect(f.payments.preparePayment).not.toHaveBeenCalled()
  })
  it('re-derives a restored plan against its intent before review, even when storage integrity is recomputed', async () => {
    const f = fixture(), controller = f.create()
    f.payments.preparePayment.mockRejectedValueOnce(new Error('review unavailable'))
    await expect(controller.prepare(f.intent as never)).rejects.toThrow('review unavailable')
    const key = [...f.data.keys()].find(name => name.endsWith(':payment:v1'))!
    const saved = JSON.parse(f.data.get(key)!) as { value: { plan: typeof f.plan; expectedPayment: { minimumReturnedTokens: string } } }
    saved.value.plan.draft.calls[0]!.data = encodeFunctionData({ abi: parseAbi(['function pay(uint256,address,uint256,address,uint256,string,bytes)']), functionName: 'pay', args: [7n, token, 1000000n, account, 98n, '', '0x'] })
    saved.value.expectedPayment.minimumReturnedTokens = '98'
    f.data.set(key, JSON.stringify({ value: saved.value, integrity: keccak256(stringToHex(JSON.stringify(saved.value))) }))
    await expect(f.create().prepare(f.intent as never)).rejects.toThrow()
    expect(f.payments.preparePayment).toHaveBeenCalledOnce()
  })
  it('reviews a payment started on a project page whose address holds a colon, and keeps that page to return to', async () => {
    const f = fixture(), intent = { ...f.intent, returnPath: '/op:11' }
    expect((await f.create().prepare(intent as never)).status).toBe('reviewing')
    expect(f.create().pending()?.intent.returnPath).toBe('/op:11')
  })
  it('rejects a changed recipient, amount, terminal, minimum or stale owner observation before payment review', async () => {
    for (const args of [[8n, token, 1000000n, account, 100n, '', '0x'], [7n, token, 2000000n, account, 100n, '', '0x'], [7n, token, 1000000n, terminal, 100n, '', '0x'], [7n, token, 1000000n, account, 98n, '', '0x']]) {
      const f = fixture()
      f.plan.draft.calls[0]!.data = encodeFunctionData({ abi: parseAbi(['function pay(uint256,address,uint256,address,uint256,string,bytes)']), functionName: 'pay', args: args as never })
      await expect(f.create().prepare(f.intent as never)).rejects.toThrow()
      expect(f.payments.preparePayment).not.toHaveBeenCalled()
    }
    const f = fixture(); f.binding.state.evidence.timestamp = '1'
    await expect(f.create().prepare(f.intent as never)).rejects.toThrow()
    expect(f.events).toEqual([])
  })
  it('preserves the original operation across a lost response and never submits again on refresh or retry', async () => {
    const f = fixture(), controller = f.create(); await controller.prepare(f.intent as never); f.setStatus('approved')
    f.payments.submitPayment.mockImplementation(async () => { throw Error('response lost') })
    await expect(controller.submit()).rejects.toThrow('response lost')
    await f.create().refresh(); await f.create().submit()
    expect(f.payments.submitPayment).toHaveBeenCalledOnce()
    expect(f.events.filter(event => event === 'operation')).toHaveLength(1)
    await expect(f.create().prepare({ ...f.intent, amount: '2' } as never)).rejects.toThrow()
  })
  it('does not send when the original submission marker cannot be persisted', async () => {
    const f = fixture(), controller = f.create(); await controller.prepare(f.intent as never); f.setStatus('approved')
    f.storage.setItem = () => { throw Error('full') }
    await expect(controller.submit()).rejects.toThrow()
    expect(f.payments.submitPayment).not.toHaveBeenCalled()
  })
  it('archives completed history before clearing the SDK and can recover a failed final removal', async () => {
    const f = fixture(), controller = f.create(); await controller.prepare(f.intent as never); f.setStatus('paid')
    const remove = f.storage.removeItem
    f.storage.removeItem = () => { throw Error('blocked') }
    expect(() => controller.clear()).toThrow()
    expect(f.payments.clearPayment).toHaveBeenCalledOnce()
    f.storage.removeItem = remove
    expect(() => f.create().clear()).not.toThrow()
    expect(f.create().pending()).toBeNull()
    expect([...f.data.keys()].some(key => key.endsWith(':history'))).toBe(true)
  })
  it('plans with the slippage the payer chose and refuses one Signa would not accept', async () => {
    const f = fixture(), intent = { ...f.intent, slippageBps: 250 }
    expect((await f.create().prepare(intent as never)).status).toBe('reviewing')
    expect(f.planInputs[0]).toMatchObject({ slippageBps: 250 })
    expect(f.create().pending()?.intent).toEqual(intent)
    for (const slippageBps of [4951, -1, 2.5, '250'])
      await expect(fixture().create().prepare({ ...f.intent, slippageBps } as never)).rejects.toThrow('slippage')
  })
  it("reads Signa's payFailure from a status, its observation or an error, and nothing from an older Signa", () => {
    const failure = { reason: 'TERMINAL_UNDER_MIN', received: '98', minimum: '99', zeroFill: false, adjustable: 'minimum', message: 'This payment would get fewer tokens than your minimum, so lower your minimum or try again.' }
    expect(signaPayFailure({ status: 'reverted', observation: { state: 'reverted', payFailure: failure } })).toEqual({ ...failure, received: 98n, minimum: 99n })
    // Only the SDK's own values pass; anything else is left out, so nothing is relaxed without it.
    expect(signaPayFailure({ payFailure: { ...failure, adjustable: 'slippage', zeroFill: 'no' } })).toEqual({ reason: failure.reason, message: failure.message, received: 98n, minimum: 99n })
    // Contradictory or out-of-range fields never authorize a looser minimum.
    const base = { reason: failure.reason, message: failure.message }
    expect(signaPayFailure({ payFailure: { ...failure, zeroFill: true } })).toEqual({ ...base, received: 98n, minimum: 99n })
    expect(signaPayFailure({ payFailure: { ...failure, zeroFill: 'false' } })).toEqual({ ...base, received: 98n, minimum: 99n })
    expect(signaPayFailure({ payFailure: { ...failure, zeroFill: null } })).toEqual({ ...base, received: 98n, minimum: 99n })
    expect(signaPayFailure({ payFailure: { ...failure, zeroFill: undefined } })).toEqual({ ...base, received: 98n, minimum: 99n, adjustable: 'minimum' })
    expect(signaPayFailure({ payFailure: { ...failure, reason: 'ROUTER_SLIPPAGE_EXCEEDED' } })).toEqual({ ...base, reason: 'ROUTER_SLIPPAGE_EXCEEDED', received: 98n, minimum: 99n, zeroFill: false })
    expect(signaPayFailure({ payFailure: { ...failure, received: '0', zeroFill: true } })).toEqual({ ...base, received: 0n, minimum: 99n, zeroFill: true })
    expect(signaPayFailure({ payFailure: { ...failure, received: '99' } })).toEqual(base)
    expect(signaPayFailure({ payFailure: { ...failure, minimum: (2n ** 256n).toString() } })).toEqual(base)
    expect(signaPayFailure({ status: 'reverted', payFailure: failure })).toMatchObject({ received: 98n, minimum: 99n })
    expect(signaPayFailure(Object.assign(new Error('rejected'), { payFailure: { reason: 'PAYMENTS_PAUSED', message: 'Paused.' } }))).toEqual({ reason: 'PAYMENTS_PAUSED', message: 'Paused.' })
    expect(signaPayFailure({ payFailure: { ...failure, received: '9x' } })).toEqual({ reason: failure.reason, message: failure.message })
    for (const source of [{ status: 'reverted', observation: { state: 'reverted' } }, null, 'reverted', { payFailure: { reason: 'x', message: 'y' } }, { payFailure: { reason: 'A', message: '' } }])
      expect(signaPayFailure(source)).toBeNull()
  })
})
