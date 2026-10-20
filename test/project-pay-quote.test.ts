import { describe, expect, it, vi } from 'vitest'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { buildUserPayMetadata, v6Address } from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import { prepareProjectPayQuote, readProjectPayTokenOptions, type ProjectPayQuoteInput } from '../src/lib/project-pay-quote'

const CHAIN = 1
const MULTI = v6Address('JBMultiTerminal', CHAIN)
const ROUTER = v6Address('JBRouterTerminalRegistry', CHAIN)
const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const input: ProjectPayQuoteInput = { chainId: CHAIN, projectId: 7n, token: NATIVE_TOKEN, amount: 10n ** 18n, beneficiary: ACCOUNT, terminal: MULTI }
function fixture() {
  const ruleset = { id: 9n, start: 100n, cycleNumber: 1, weight: 10n ** 18n, metadata: 0n }
  const metadata = { dataHook: zeroAddress as Address, useDataHookForPay: false, pausePay: false, reservedPercent: 2000 }
  const options = {
    controller: v6Address('JBController', CHAIN), terminals: [MULTI, ROUTER],
    multi: [ruleset, 100n, 25n, []], router: [ruleset, 90n, 30n, []],
    contexts: [{ token: NATIVE_TOKEN, decimals: 18, currency: 1 }],
  }
  const readContract = vi.fn(async (request: { functionName: string; address: Address; args?: readonly unknown[]; blockNumber?: bigint }) => {
    if (request.functionName === 'controllerOf') return options.controller
    if (request.functionName === 'terminalsOf') return options.terminals
    if (request.functionName === 'currentRulesetOf') return [ruleset, metadata]
    if (request.functionName === 'previewPayFor') return request.address === MULTI ? options.multi : options.router
    if (request.functionName === 'accountingContextsOf') return options.contexts
    // No buyback hook resolves, so prepareUserPay keeps the terminal's counts.
    if (request.functionName === 'hookOf') return zeroAddress
    throw new Error(`Unexpected read ${request.functionName}`)
  })
  const client = { getChainId: vi.fn(async () => CHAIN), getBlockNumber: vi.fn(async () => 100n), getBlock: vi.fn(async () => ({ timestamp: 200n })), readContract, call: vi.fn() }
  return { ruleset, metadata, options, client, rpc: client as unknown as PublicClient }
}
describe('project payment quote parity', () => {
  it('keeps the Center profile on its direct terminal with empty metadata even when a router quotes more tokens', async () => {
    const f = fixture(); f.options.router = [f.ruleset, 120n, 1n, []]
    expect(await prepareProjectPayQuote(f.rpc, { ...input, directTerminalOnly: true })).toMatchObject({ terminal: MULTI, minimumTokenCount: 99n, metadata: '0x' })
    const previews = f.client.readContract.mock.calls.filter(([request]) => request.functionName === 'previewPayFor')
    expect(previews).toHaveLength(1)
    expect(previews[0][0].args?.[4]).toBe('0x')
  })
  it('prepares both listed terminals with the skipSplits pay metadata at one block and returns that metadata', async () => {
    const f = fixture()
    const metadata = buildUserPayMetadata({ chainId: CHAIN })
    const result = await prepareProjectPayQuote(f.rpc, input)
    expect(result).toMatchObject({ terminal: MULTI, minimumTokenCount: 99n, reservedTokenCount: 25n, metadata, blockNumber: 100n })
    expect(f.client.readContract.mock.calls.every(([request]) => request.blockNumber === 100n)).toBe(true)
    const previews = f.client.readContract.mock.calls.filter(([request]) => request.functionName === 'previewPayFor')
    expect(previews.map(([request]) => request.address)).toEqual([MULTI, ROUTER])
    expect(previews.every(([request]) => request.args?.[4] === metadata)).toBe(true)
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
  it('permits a verified 100% reserved payment and protects positive dust with at least one unit', async () => {
    const f = fixture(); f.metadata.reservedPercent = 10_000
    f.options.multi = [f.ruleset, 0n, 100n, []]; f.options.router = [f.ruleset, 0n, 50n, []]
    expect(await prepareProjectPayQuote(f.rpc, input)).toMatchObject({ minimumTokenCount: 0n, reservedTokenCount: 100n })
    f.options.multi = [f.ruleset, 1n, 100n, []]
    expect(await prepareProjectPayQuote(f.rpc, input)).toMatchObject({ minimumTokenCount: 1n })
  })
  it('refuses the quote when the SDK cannot resolve the buyback hook', async () => {
    const f = fixture(); const implementation = f.client.readContract.getMockImplementation()!
    f.client.readContract.mockImplementation(async request => {
      if (request.functionName === 'hookOf') throw new Error('RPC offline')
      return implementation(request)
    })
    await expect(prepareProjectPayQuote(f.rpc, input)).rejects.toThrow('No listed payment route')
  })
  it('refuses a payment with no protected token return', async () => {
    const f = fixture(); f.options.multi = [f.ruleset, 0n, 0n, []]; f.options.router = [f.ruleset, 0n, 0n, []]
    await expect(prepareProjectPayQuote(f.rpc, input)).rejects.toThrow('No protected token return')
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
