import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_TOKEN, jbContractAddress } from '@bananapus/nana-sdk-core'
import { chooseBestPayRoute, uniswapV4Deployment, v6Address } from '@bananapus/nana-sdk-core/v6'
import { type DirectPaySwapQuote } from '@bananapus/nana-sdk-core/v6/direct-pay'
import { zeroAddress, type Address, type PublicClient } from 'viem'
const mocks = vi.hoisted(() => ({ direct: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6/direct-pay', async importOriginal => ({ ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6/direct-pay')>(), quoteDirectPaySwap: mocks.direct }))
import { prepareProjectPayQuote, readProjectPayTokenOptions, type ProjectPayQuoteInput } from '../src/lib/project-pay-quote'

const CHAIN = 1
const MULTI = v6Address('JBMultiTerminal', CHAIN)
const ROUTER = v6Address('JBRouterTerminalRegistry', CHAIN)
const REGISTRY = jbContractAddress[6].JBBuybackHookRegistry[CHAIN]!
const REV_OWNER = jbContractAddress[6].REVOwner[CHAIN]!
const OMNI = jbContractAddress[6].JBOmnichainDeployer[CHAIN]!
const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const PROJECT_TOKEN = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const input: ProjectPayQuoteInput = { chainId: CHAIN, projectId: 7n, token: NATIVE_TOKEN, amount: 10n ** 18n, beneficiary: ACCOUNT, terminal: MULTI }
function fixture() {
  const ruleset = { id: 9n, start: 100n, cycleNumber: 1, weight: 10n ** 18n }
  const metadata = { dataHook: zeroAddress as Address, useDataHookForPay: false, pausePay: false, reservedPercent: 2000 }
  const options = {
    controller: v6Address('JBController', CHAIN), terminals: [MULTI, ROUTER],
    multi: [ruleset, 100n, 25n, []], router: [ruleset, 90n, 30n, []],
    contexts: [{ token: NATIVE_TOKEN, decimals: 18, currency: 1 }],
    pool: { currency0: zeroAddress, currency1: PROJECT_TOKEN, hooks: HOOK, fee: 3000, tickSpacing: 60 },
    extra: { dataHook: REGISTRY, useDataHookForPay: true },
  }
  const readContract = vi.fn(async (request: { functionName: string; address: Address; args?: readonly unknown[]; blockNumber?: bigint }) => {
    if (request.functionName === 'controllerOf') return options.controller
    if (request.functionName === 'terminalsOf') return options.terminals
    if (request.functionName === 'currentRulesetOf') return [ruleset, metadata]
    if (request.functionName === 'previewPayFor') return request.address === MULTI ? options.multi : options.router
    if (request.functionName === 'extraDataHookOf') return options.extra
    if (request.functionName === 'hookOf') return HOOK
    if (request.functionName === 'accountingContextsOf') return options.contexts
    if (request.functionName === 'tokenOf') return PROJECT_TOKEN
    if (request.functionName === 'poolKeyOf') return options.pool
    throw new Error(`Unexpected read ${request.functionName}`)
  })
  const client = { getChainId: vi.fn(async () => CHAIN), getBlockNumber: vi.fn(async () => 100n), getBlock: vi.fn(async () => ({ timestamp: 200n })), readContract, call: vi.fn() }
  return { ruleset, metadata, options, client, rpc: client as unknown as PublicClient }
}
function directQuote(): DirectPaySwapQuote {
  return { kind: 'direct-swap', poolKey: { currency0: zeroAddress, currency1: PROJECT_TOKEN, hooks: HOOK, fee: 3000, tickSpacing: 60 }, zeroForOne: true, quotedTokenCount: 200n, minimumTokenCount: 198n, beneficiaryTokenCount: 198n, reservedTokenCount: 0n, inputRoute: { kind: 'single-v4' } }
}
beforeEach(() => { mocks.direct.mockReset(); mocks.direct.mockResolvedValue(null) })

describe('project payment quote parity', () => {
  it('compares both listed terminal previews at one block and applies one protected minimum', async () => {
    const f = fixture()
    const result = await prepareProjectPayQuote(f.rpc, input)
    expect(result).toMatchObject({ kind: 'pay', terminal: MULTI, minimumTokenCount: 99n, reservedTokenCount: 25n, blockNumber: 100n })
    expect(f.client.readContract.mock.calls.every(([request]) => request.blockNumber === 100n)).toBe(true)
    expect(f.client.readContract.mock.calls.filter(([request]) => request.functionName === 'previewPayFor')).toHaveLength(2)
    expect(mocks.direct).not.toHaveBeenCalled()
  })
  it('chooses the router for better beneficiary return and uses reserved output only to break ties', async () => {
    const f = fixture(); f.options.router = [f.ruleset, 120n, 1n, []]
    expect(await prepareProjectPayQuote(f.rpc, input)).toMatchObject({ terminal: ROUTER, minimumTokenCount: 118n })
    f.options.router = [f.ruleset, 100n, 30n, []]
    expect(await prepareProjectPayQuote(f.rpc, input)).toMatchObject({ terminal: ROUTER })
    f.options.router = [f.ruleset, 100n, 25n, []]
    expect(await prepareProjectPayQuote(f.rpc, input)).toMatchObject({ terminal: MULTI })
  })
  it('never previews an unlisted router or accepts a caller-supplied arbitrary terminal', async () => {
    const f = fixture(); f.options.terminals = [MULTI]
    await prepareProjectPayQuote(f.rpc, input)
    expect(f.client.readContract.mock.calls.filter(([request]) => request.functionName === 'previewPayFor')).toHaveLength(1)
    await expect(prepareProjectPayQuote(f.rpc, { ...input, terminal: ACCOUNT })).rejects.toThrow('no longer listed')
  })
  it('can use a surviving listed route when the other terminal cannot accept the token', async () => {
    const f = fixture(); const implementation = f.client.readContract.getMockImplementation()!
    f.client.readContract.mockImplementation(async request => {
      if (request.functionName === 'previewPayFor' && request.address === MULTI) throw new Error('Unsupported token')
      return implementation(request)
    })
    expect(await prepareProjectPayQuote(f.rpc, input)).toMatchObject({ terminal: ROUTER, minimumTokenCount: 89n })
  })
  it('uses the current REVOwner buyback pool and preserves the SDK direct-swap floor without a second haircut', async () => {
    const f = fixture(); f.metadata.dataHook = REV_OWNER; f.metadata.useDataHookForPay = true
    mocks.direct.mockResolvedValue(directQuote())
    const quote = await prepareProjectPayQuote(f.rpc, input)
    expect(quote).toMatchObject({ kind: 'direct-swap', terminal: uniswapV4Deployment(CHAIN)!.universalRouter, minimumTokenCount: 198n, reservedTokenCount: 0n, preview: { beneficiaryTokenCount: 198n, reservedTokenCount: 0n } })
    expect(mocks.direct).toHaveBeenCalledWith(expect.objectContaining({ chainId: CHAIN, paymentToken: NATIVE_TOKEN, amount: input.amount, payPreview: { beneficiaryTokenCount: 100n, reservedTokenCount: 25n }, slippageBps: 100n }))
  })
  it('does not resolve the registry default before the active ruleset enables its data hook', async () => {
    const f = fixture(); f.metadata.dataHook = REV_OWNER
    await prepareProjectPayQuote(f.rpc, input)
    expect(f.client.readContract.mock.calls.some(([request]) => request.functionName === 'hookOf')).toBe(false)
    f.metadata.useDataHookForPay = true
    await prepareProjectPayQuote(f.rpc, input)
    expect(f.client.readContract.mock.calls.some(([request]) => request.functionName === 'hookOf')).toBe(true)
  })
  it('unwraps the current omnichain hook configuration and honors a disabled extra pay hook', async () => {
    const f = fixture(); f.metadata.dataHook = OMNI; f.metadata.useDataHookForPay = true
    await prepareProjectPayQuote(f.rpc, input)
    expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'extraDataHookOf', args: [7n, 9n], blockNumber: 100n }))
    expect(mocks.direct).toHaveBeenCalledOnce()
    f.options.extra.useDataHookForPay = false; mocks.direct.mockClear()
    await prepareProjectPayQuote(f.rpc, input)
    expect(mocks.direct).not.toHaveBeenCalled()
  })
  it('passes a USDC accounting pool and ETH input to the SDK bridge route without inventing a pool', async () => {
    const f = fixture(); f.metadata.dataHook = REV_OWNER; f.metadata.useDataHookForPay = true
    f.options.contexts = [{ token: USDC, decimals: 6, currency: 2 }]
    f.options.pool = { currency0: PROJECT_TOKEN, currency1: USDC, hooks: HOOK, fee: 3000, tickSpacing: 60 }
    await prepareProjectPayQuote(f.rpc, input)
    expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'poolKeyOf', args: [7n, USDC.toLowerCase()] }))
    expect(mocks.direct).toHaveBeenCalledWith(expect.objectContaining({ paymentToken: NATIVE_TOKEN, pairIsCurrency0: false, poolKey: f.options.pool }))
  })
  it('rejects a pool whose output token belongs to a different project', async () => {
    const f = fixture(); f.metadata.dataHook = REV_OWNER; f.metadata.useDataHookForPay = true; f.options.pool.currency1 = ACCOUNT
    await expect(prepareProjectPayQuote(f.rpc, input)).rejects.toThrow('does not match this project')
    expect(mocks.direct).not.toHaveBeenCalled()
  })
  it('does not treat active-hook zero issuance as zero customer output when the swap cannot be quoted', async () => {
    const f = fixture(); f.metadata.dataHook = REV_OWNER; f.metadata.useDataHookForPay = true
    f.options.multi = [f.ruleset, 0n, 0n, []]; f.options.router = [f.ruleset, 0n, 0n, []]
    mocks.direct.mockRejectedValue(new Error('Quoter unavailable'))
    await expect(prepareProjectPayQuote(f.rpc, input)).rejects.toThrow('protected token return')
    mocks.direct.mockResolvedValue(directQuote())
    expect(await prepareProjectPayQuote(f.rpc, input)).toMatchObject({ kind: 'direct-swap', minimumTokenCount: 198n })
  })
  it('permits a verified 100% reserved payment and protects positive dust with at least one unit', async () => {
    const f = fixture(); f.metadata.reservedPercent = 10_000
    f.options.multi = [f.ruleset, 0n, 100n, []]; f.options.router = [f.ruleset, 0n, 50n, []]
    expect(await prepareProjectPayQuote(f.rpc, input)).toMatchObject({ minimumTokenCount: 0n, reservedTokenCount: 100n })
    f.options.multi = [f.ruleset, 1n, 100n, []]
    expect(await prepareProjectPayQuote(f.rpc, input)).toMatchObject({ minimumTokenCount: 1n })
  })
  it('blocks wrong-chain, unsupported-controller, future-stage, paused, and zero amount requests', async () => {
    const f = fixture()
    f.client.getChainId.mockResolvedValueOnce(10 as 1)
    await expect(prepareProjectPayQuote(f.rpc, input)).rejects.toThrow('wrong chain')
    f.options.controller = ACCOUNT
    await expect(prepareProjectPayQuote(f.rpc, input)).rejects.toThrow('controller')
    f.options.controller = v6Address('JBController', CHAIN); f.ruleset.start = 201n
    await expect(prepareProjectPayQuote(f.rpc, input)).rejects.toThrow('not started')
    f.ruleset.start = 100n; f.metadata.pausePay = true
    await expect(prepareProjectPayQuote(f.rpc, input)).rejects.toThrow('paused')
    await expect(prepareProjectPayQuote(f.rpc, { ...input, amount: 0n })).rejects.toThrow('positive')
  })
  it('uses the SDK route threshold: optimistic AMM return alone cannot displace terminal issuance', () => {
    const pay = { beneficiaryTokenCount: 100n, reservedTokenCount: 25n }
    expect(chooseBestPayRoute({ pay, paySettlement: 'issuance', directSwapQuote: 101n })).toMatchObject({ kind: 'pay' })
    expect(chooseBestPayRoute({ pay, paySettlement: 'issuance', directSwapQuote: 104n })).toMatchObject({ kind: 'direct-swap', beneficiaryTokenCount: 102n, reservedTokenCount: 0n })
  })
  it('adds live routed USDC for an ETH treasury without altering its accounting contexts', async () => {
    const f = fixture()
    expect(await readProjectPayTokenOptions(f.rpc, input)).toEqual([
      { token: NATIVE_TOKEN, decimals: 18, symbol: 'ETH', terminal: MULTI, viaRouter: false },
      { token: USDC, decimals: 6, symbol: 'USDC', terminal: MULTI, viaRouter: true },
    ])
    expect(f.options.contexts).toHaveLength(1)
    expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: ROUTER, functionName: 'previewPayFor', args: [7n, USDC, 1_000_000n, '0x0000000000000000000000000000000000000001', '0x'], blockNumber: 100n }))
  })
  it('adds live routed ETH for a USDC treasury and preserves the treasury terminal anchor', async () => {
    const f = fixture(); f.options.contexts = [{ token: USDC, decimals: 6, currency: 2 }]
    const options = await readProjectPayTokenOptions(f.rpc, input)
    expect(options).toEqual([
      { token: USDC, decimals: 6, symbol: 'USDC', terminal: MULTI, viaRouter: false },
      { token: NATIVE_TOKEN, decimals: 18, symbol: 'ETH', terminal: MULTI, viaRouter: true },
    ])
  })
  it('does not list a missing, reverted, or empty-ruleset router input', async () => {
    const f = fixture(); f.options.terminals = [MULTI]
    expect(await readProjectPayTokenOptions(f.rpc, input)).toHaveLength(1)
    f.options.terminals = [MULTI, ROUTER]; f.options.router = [{ ...f.ruleset, id: 0n }, 0n, 0n, []]
    expect(await readProjectPayTokenOptions(f.rpc, input)).toHaveLength(1)
    const implementation = f.client.readContract.getMockImplementation()!
    f.client.readContract.mockImplementation(async request => {
      if (request.functionName === 'previewPayFor') throw new Error('No pool path')
      return implementation(request)
    })
    expect(await readProjectPayTokenOptions(f.rpc, input)).toHaveLength(1)
  })
  it('does not duplicate directly accepted ETH or USDC in the router choices', async () => {
    const f = fixture(); f.options.contexts.push({ token: USDC, decimals: 6, currency: 2 })
    const options = await readProjectPayTokenOptions(f.rpc, input)
    expect(options).toHaveLength(2)
    expect(options.every(option => !option.viaRouter)).toBe(true)
    expect(f.client.readContract.mock.calls.some(([request]) => request.functionName === 'previewPayFor')).toBe(false)
  })
})
