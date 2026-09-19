import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, parseAbi } from 'viem'
import { createHomerunPayment } from '@/lib/center-payment'
const account = '0x1111111111111111111111111111111111111111', terminal = '0x2222222222222222222222222222222222222222', token = '0x3333333333333333333333333333333333333333', hash = '0x' + 'ab'.repeat(32)
function fixture() {
  const data = new Map<string, string>(), events: string[] = []
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
  let status: any = null
  const payments = { preparePayment: vi.fn(async input => { events.push('review'); return status = { status: 'reviewing', operationId: record.id,
    approvalUrl: config.issuer + '/wallet/payment?review=original', expectedPayment: input.expectedPayment } }),
    pendingPayment: () => status, submitPayment: vi.fn(async () => { events.push('send'); status = { ...status, status: 'pending' }; return status }),
    refreshPayment: vi.fn(async () => status), clearPayment: vi.fn(() => { if (!['paid', 'cancelled', 'reverted', 'expired'].includes(status?.status)) throw Error('unresolved'); status = null }) }
  const connection = { address: account, chainId: 8453, accountId: 'eip155:8453:' + account, client: {
    authorizeRead: async () => ({ claims: { accountId: 'eip155:8453:' + account, signer: token, grantId: 'grant-original' } }),
    smartAccounts: () => ({ bindings: async () => ({ items: [binding] }), binding: async () => binding,
      preparePlan: async () => { events.push('plan'); return structuredClone(plan) } }),
    request: async () => { events.push('operation'); return structuredClone(record) },
  } }
  const wallet = { restoreConnection: () => connection, payments: () => payments }
  const create = () => createHomerunPayment({ config, wallet, storage } as never)
  return { data, storage, config, intent, plan, binding, wallet, payments, create, events, setStatus: (state: string) => { status = { ...status, status: state } } }
}
describe('Homerun original Center payment recovery', () => {
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
})
