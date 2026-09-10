import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import { CCIP_SUCKER_TRANSPORT_VALUES, NATIVE_SUCKER_TRANSPORT_VALUES, suckerBranchRoot, suckerLeafHash, suckerLeafProof, tokenCurrencyId, v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeFunctionData, padHex, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { initialFundRuleset, type FundTransaction } from '../src/lib/fund-contracts'
import { type FundAccountingContext, type FundProjectState } from '../src/lib/fund-state'
import {
  buildFundBridgeApproval, buildFundBridgePrepare, buildFundBridgeSend, buildFundBridgeClaim,
  readFundBridgePrepareQuote, readFundBridgeSendValue, type FundBridgeRoute, type FundBridgeMovement,
} from '../src/lib/fund-bridge'

const account = '0x1111111111111111111111111111111111111111' as const
const beneficiary = '0x2222222222222222222222222222222222222222' as const
const sourceSucker = '0x3333333333333333333333333333333333333333' as const
const destinationSucker = '0x4444444444444444444444444444444444444444' as const
const sourceFund = '0x5555555555555555555555555555555555555555' as const
const destinationFund = '0x6666666666666666666666666666666666666666' as const
const otherAddress = '0x7777777777777777777777777777777777777777' as const
const blockHash = `0x${'ab'.repeat(32)}` as Hex
const amount = 100n * 10n ** 18n
const minimum = 99_000_000n

function context(chainId: 8453 | 10): FundAccountingContext {
  const terminal = v6Address('JBMultiTerminal', chainId)
  const token = USDC_ADDRESSES[chainId]
  return { terminal, primaryTerminal: terminal, isPrimary: true, token, currency: tokenCurrencyId(token), decimals: 6,
    balance: 1_000_000_000n, surplus: 1_000_000_000n, symbol: 'USDC', payoutLimits: [], surplusAllowances: [] }
}

function state(chainId: 8453 | 10): FundProjectState {
  const configuration = initialFundRuleset()
  configuration.metadata.dataHook = v6Address('JBOmnichainDeployer', chainId)
  configuration.metadata.useDataHookForPay = true
  configuration.metadata.useDataHookForCashOut = true
  const projectId = chainId === 8453 ? 7n : 19n
  const treasury = context(chainId)
  const controller = v6Address('JBController', chainId)
  return {
    chainId, projectId, blockNumber: 100n, blockHash, blockTimestamp: 1_800_000_000n,
    owner: account, operator: account, account, controller, supportedController: true, knownOwnerWrapper: true,
    terminals: [treasury.terminal], supportedTerminals: true,
    ruleset: { cycleNumber: 1, id: 1, basedOnId: 0, start: 1_799_000_000, duration: 0,
      weight: configuration.weight, weightCutPercent: 0, approvalHook: zeroAddress, metadata: 0n },
    metadata: configuration.metadata, upcoming: null, queued: null, hasPendingRuleset: false,
    projectUri: 'ipfs://verified-fund-metadata', tokenAddress: chainId === 8453 ? sourceFund : destinationFund,
    tokenSymbol: 'FUND', tokenDecimals: 18, totalSupply: amount * 10n, totalCreditSupply: amount * 2n,
    pendingReservedTokens: 0n, totalSupplyWithReservedTokens: amount * 10n,
    creditBalance: amount, erc20Balance: amount, totalBalance: amount * 2n,
    accountingContexts: [treasury], permissions: { queueRulesets: false, mintTokens: false, useAllowance: false,
      sendPayouts: false, deployErc20: false, setProjectUri: false },
    linkedPeers: [{ chainId: chainId === 8453 ? 10 : 8453,
      localSuckerAddress: chainId === 8453 ? sourceSucker : destinationSucker,
      suckerAddress: chainId === 8453 ? destinationSucker : sourceSucker }],
    linkedChainIds: [8453, 10], linkedProjects: [{ chainId: 8453, projectId: 7n }, { chainId: 10, projectId: 19n }],
    rulesetSnapshot: { chainId, projectId, blockNumber: 100n, controller, currentRulesetId: 1n, upcomingRulesetId: 0n,
      configuration, linkedChainIds: [8453, 10], accountingContexts: [treasury],
      omnichainHooks: { dataHook: zeroAddress, tiered721Hook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false } },
    issues: [],
  }
}

function route(): FundBridgeRoute {
  const source = state(8453)
  const destination = state(10)
  return { source, destination, sourceSucker, destinationSucker, sourceToken: USDC_ADDRESSES[8453], destinationToken: USDC_ADDRESSES[10],
    sourceContext: source.accountingContexts[0], destinationContext: destination.accountingContexts[0],
    transport: 'ccip', baseFee: 1000n, canPrepare: true, prepareIssue: null }
}

function movement(): FundBridgeMovement {
  const leaf = { index: 0n, beneficiary: padHex(beneficiary, { size: 32 }), projectTokenCount: amount,
    terminalTokenAmount: 100_000_000n, metadata: zeroHash }
  const leafHash = suckerLeafHash(leaf)
  const proof = suckerLeafProof([leafHash], 0)
  const root = suckerBranchRoot(leafHash, proof, 0)
  return { sourceSucker, destinationSucker, sourceChainId: 8453, destinationChainId: 10, sourceProjectId: 7n, destinationProjectId: 19n, beneficiary,
    sourceToken: USDC_ADDRESSES[8453], remoteToken: USDC_ADDRESSES[10], leaf, leafHash,
    outboxRoot: root, inboxRoot: root, blockNumber: 99n, status: 'claimable', canExecute: false, proof }
}

function decode(request: FundTransaction) {
  return decodeFunctionData({ abi: request.abi, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) })
}

test('bridge approval spends exactly the reviewed FUND ERC20 amount, with the source sucker as spender', () => {
  const request = buildFundBridgeApproval(route(), amount)
  assert.equal(request.address, sourceFund)
  assert.notEqual(request.address, USDC_ADDRESSES[8453])
  assert.equal(request.chainId, 8453)
  assert.equal(decode(request).functionName, 'approve')
  assert.deepEqual(decode(request).args, [sourceSucker, amount])
})

test('prepare encodes source treasury token, padded destination recipient and positive backing protection', () => {
  const current = route()
  const original = structuredClone(current)
  const request = buildFundBridgePrepare(current, { amount, beneficiary, minTokensReclaimed: minimum })
  assert.equal(request.address, sourceSucker)
  assert.equal(request.chainId, 8453)
  assert.equal(request.value ?? 0n, 0n)
  assert.equal(decode(request).functionName, 'prepare')
  assert.deepEqual(decode(request).args, [amount, padHex(beneficiary, { size: 32 }), minimum, USDC_ADDRESSES[8453], zeroHash])
  assert.deepEqual(current, original)
})

test('prepare and approval require a usable route, an existing ERC20 and sufficient ERC20 balance', () => {
  for (const change of [
    { canPrepare: false, prepareIssue: 'Sending is disabled.' },
    { source: { ...state(8453), tokenAddress: null } },
    { source: { ...state(8453), tokenAddress: zeroAddress } },
    { source: { ...state(8453), erc20Balance: amount - 1n, creditBalance: amount * 10n, totalBalance: amount * 11n - 1n } },
  ]) {
    const current = { ...route(), ...change }
    assert.throws(() => buildFundBridgePrepare(current, { amount, beneficiary, minTokensReclaimed: minimum }))
    assert.throws(() => buildFundBridgeApproval(current, amount))
  }
})

test('prepare rejects zero or overflowing token amounts, zero protection and malformed recipients', () => {
  for (const value of [0n, -1n, 1n << 128n]) {
    const current = route()
    current.source.erc20Balance = 1n << 129n
    assert.throws(() => buildFundBridgePrepare(current, { amount: value, beneficiary, minTokensReclaimed: minimum }))
    assert.throws(() => buildFundBridgeApproval(current, value))
  }
  for (const value of [0n, -1n]) {
    assert.throws(() => buildFundBridgePrepare(route(), { amount, beneficiary, minTokensReclaimed: value }))
  }
  for (const recipient of [zeroAddress, '0x1234' as Address]) {
    assert.throws(() => buildFundBridgePrepare(route(), { amount, beneficiary: recipient, minTokensReclaimed: minimum }))
  }
})

test('send encodes the source outbox token with registry fee plus a positive CCIP transport budget', () => {
  const current = route()
  const value = current.baseFee + 1_000_000_000_000_000n
  const request = buildFundBridgeSend(current, value)
  assert.equal(request.address, sourceSucker)
  assert.equal(request.chainId, 8453)
  assert.equal(request.value, value)
  assert.equal(decode(request).functionName, 'toRemote')
  assert.deepEqual(decode(request).args, [USDC_ADDRESSES[8453]])
  for (const invalid of [-1n, 0n, current.baseFee - 1n, current.baseFee]) {
    assert.throws(() => buildFundBridgeSend(current, invalid))
  }
  assert.throws(() => buildFundBridgeSend({ ...current, transport: 'unknown' }, value))
})

test('native transport can send the exact registry fee, and still rejects an underpaid registry fee', () => {
  const current = { ...route(), transport: 'native' as const }
  assert.equal(buildFundBridgeSend(current, current.baseFee).value, current.baseFee)
  assert.throws(() => buildFundBridgeSend(current, current.baseFee - 1n))
})

test('claim validates a real SDK proof and encodes the destination token and exact proven leaf', () => {
  const current = movement()
  const original = structuredClone(current)
  const request = buildFundBridgeClaim(route(), current)
  assert.equal(request.address, destinationSucker)
  assert.equal(request.chainId, 10)
  assert.equal(decode(request).functionName, 'claim')
  assert.deepEqual(decode(request).args, [{ token: USDC_ADDRESSES[10], leaf: current.leaf, proof: current.proof }])
  assert.deepEqual(current, original)
})

test('claim rejects unfinished, already settled and unproven movements', () => {
  for (const change of [
    { status: 'pending' as const }, { status: 'claimed' as const }, { proof: null }, { inboxRoot: null }, { inboxRoot: zeroHash },
  ]) assert.throws(() => buildFundBridgeClaim(route(), { ...movement(), ...change }))
})

test('claim rejects inconsistent routes, forged preimages, invalid roots and mismatched review beneficiaries', () => {
  const current = movement()
  const tamperedProof: [...NonNullable<typeof current.proof>] = [...current.proof!]
  tamperedProof[0] = blockHash
  for (const change of [
    { sourceChainId: 1 }, { destinationChainId: 8453 }, { sourceProjectId: 19n }, { destinationProjectId: 7n },
    { sourceToken: otherAddress }, { remoteToken: otherAddress },
    { sourceSucker: zeroAddress }, { destinationSucker: zeroAddress }, { beneficiary: otherAddress },
    { leafHash: zeroHash }, { inboxRoot: blockHash },
    { leaf: { ...current.leaf, projectTokenCount: amount + 1n } },
    { leaf: { ...current.leaf, metadata: blockHash } },
    { proof: tamperedProof },
  ]) assert.throws(() => buildFundBridgeClaim(route(), { ...current, ...change }))
})

test('a verified historical movement can claim through its historical sucker rather than the active route', () => {
  const current = { ...movement(), sourceSucker: otherAddress, destinationSucker: sourceFund }
  const request = buildFundBridgeClaim({ ...route(), canPrepare: false, prepareIssue: 'This bridge no longer accepts new transfers.' }, current)
  assert.equal(request.address, sourceFund)
  assert.equal(request.chainId, 10)
})

type ReadRequest = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint; account?: Address }
function quoteClient(options: { gross?: bigint; tax?: bigint; feeFreeSurplus?: bigint; feeless?: boolean; allowance?: bigint; chainId?: number; hash?: Hex; fail?: string } = {}) {
  const current = route()
  const readContract = vi.fn(async (request: ReadRequest): Promise<unknown> => {
    assert.equal(request.blockNumber, current.source.blockNumber)
    if (request.functionName === options.fail) throw new Error(`RPC unavailable: ${request.functionName}`)
    switch (request.functionName) {
      case 'previewCashOutFrom':
        assert.equal(request.address, current.sourceContext.terminal)
        assert.equal(request.account, sourceSucker)
        assert.deepEqual(request.args, [sourceSucker, 7n, amount, USDC_ADDRESSES[8453], sourceSucker, '0x'])
        return [current.source.ruleset, options.gross ?? 100_000_000n, options.tax ?? 0n, []]
      case 'feeFreeSurplusOf':
        assert.equal(request.address, current.sourceContext.terminal)
        assert.deepEqual(request.args, [7n, USDC_ADDRESSES[8453]])
        return options.feeFreeSurplus ?? 50_000_000n
      case 'FEELESS_ADDRESSES':
        assert.equal(request.address, current.sourceContext.terminal)
        return otherAddress
      case 'isFeelessFor':
        assert.equal(request.address, otherAddress)
        assert.deepEqual(request.args, [sourceSucker, 7n, sourceSucker])
        return options.feeless ?? false
      case 'allowance':
        assert.equal(request.address, sourceFund)
        assert.deepEqual(request.args, [account, sourceSucker])
        return options.allowance ?? amount / 2n
      default: throw new Error(`Unexpected RPC read: ${request.functionName}`)
    }
  })
  const getBlock = vi.fn(async (request: { blockNumber: bigint }) => {
    assert.equal(request.blockNumber, current.source.blockNumber)
    return { number: current.source.blockNumber, hash: options.hash ?? blockHash }
  })
  const client = { getChainId: vi.fn(async () => options.chainId ?? 8453), readContract, getBlock } as unknown as PublicClient
  return { client, readContract, getBlock }
}

test('bridge quote pins the snapshot block and quotes the sucker holder with FUND allowance, fees and slippage', async () => {
  const fixture = quoteClient()
  const quote = await readFundBridgePrepareQuote(fixture.client, route(), amount)
  assert.deepEqual(quote, {
    amount, grossReclaimAmount: 100_000_000n, fee: 1_250_000n, netReclaimAmount: 98_750_000n,
    minTokensReclaimed: 97_762_500n, allowance: amount / 2n,
  })
  assert.equal(fixture.readContract.mock.calls.length, 5)
  assert.equal(fixture.getBlock.mock.calls.length, 1)
})

test('bridge quote applies zero fees for feeless suckers and full terminal fees when the preview reports a tax', async () => {
  const feeless = await readFundBridgePrepareQuote(quoteClient({ feeless: true }).client, route(), amount, 0)
  assert.equal(feeless.fee, 0n)
  assert.equal(feeless.minTokensReclaimed, 100_000_000n)
  const taxed = await readFundBridgePrepareQuote(quoteClient({ tax: 1000n }).client, route(), amount, 500)
  assert.equal(taxed.fee, 2_500_000n)
  assert.equal(taxed.minTokensReclaimed, 92_625_000n)
})

test('bridge quote fails closed on missing RPC evidence, chain mismatches, reorgs and unusable backing floors', async () => {
  for (const options of [
    { chainId: 10 }, { hash: zeroHash }, { gross: 0n }, { gross: 1n, feeFreeSurplus: 0n },
    { fail: 'previewCashOutFrom' }, { fail: 'allowance' }, { fail: 'isFeelessFor' },
  ]) await assert.rejects(() => readFundBridgePrepareQuote(quoteClient(options).client, route(), amount))
  for (const slippage of [-1, 501, 0.5, Number.NaN]) {
    await assert.rejects(() => readFundBridgePrepareQuote(quoteClient().client, route(), amount, slippage))
  }
})

function sendClient(options: { transport?: 'ccip' | 'native' | 'unknown'; fee?: bigint; chainId?: number; failAttempts?: number } = {}) {
  const current = route()
  const transport = options.transport ?? 'ccip'
  const readContract = vi.fn(async (request: ReadRequest): Promise<unknown> => {
    if (request.functionName === 'toRemoteFee') {
      assert.equal(request.address, v6Address('JBSuckerRegistry', 8453))
      return options.fee ?? current.baseFee
    }
    assert.equal(request.address, sourceSucker)
    if (request.functionName === 'CCIP_ROUTER' && transport === 'ccip') return otherAddress
    if (request.functionName === 'OPMESSENGER' && transport === 'native') return otherAddress
    if (['CCIP_ROUTER', 'OPMESSENGER', 'ARBINBOX'].includes(request.functionName)) throw new Error('Probe unavailable')
    throw new Error(`Unexpected RPC read: ${request.functionName}`)
  })
  let attempts = 0
  const simulateContract = vi.fn(async (request: FundTransaction & { account: Address }) => {
    assert.equal(request.address, sourceSucker)
    assert.equal(request.account, account)
    assert.equal(request.chainId, 8453)
    assert.equal(request.functionName, 'toRemote')
    assert.deepEqual(request.args, [USDC_ADDRESSES[8453]])
    if (attempts++ < (options.failAttempts ?? 0)) throw new Error('Insufficient transport payment')
    return { request }
  })
  const client = { getChainId: vi.fn(async () => options.chainId ?? 8453), readContract, simulateContract } as unknown as PublicClient
  return { client, readContract, simulateContract }
}

test('CCIP send quote adds the live registry fee to bounded positive transport candidates and simulates the exact account', async () => {
  const fixture = sendClient({ failAttempts: 1 })
  const current = route()
  const value = await readFundBridgeSendValue(fixture.client, current, account)
  assert.equal(value, current.baseFee + CCIP_SUCKER_TRANSPORT_VALUES[1])
  assert.deepEqual(fixture.simulateContract.mock.calls.map(([request]) => request.value),
    CCIP_SUCKER_TRANSPORT_VALUES.slice(0, 2).map(transport => current.baseFee + transport))
})

test('native send quote tries zero transport plus the registry fee before paid transport options', async () => {
  const fixture = sendClient({ transport: 'native' })
  const current = { ...route(), transport: 'native' as const }
  assert.equal(await readFundBridgeSendValue(fixture.client, current, account), current.baseFee)
  assert.deepEqual(fixture.simulateContract.mock.calls.map(([request]) => request.value), [current.baseFee + NATIVE_SUCKER_TRANSPORT_VALUES[0]])
})

test('send quote rejects changed fees or transport, wrong-chain RPCs and an exhausted simulation budget', async () => {
  for (const options of [{ fee: 1001n }, { transport: 'native' as const }, { transport: 'unknown' as const }, { chainId: 10 }]) {
    const fixture = sendClient(options)
    await assert.rejects(() => readFundBridgeSendValue(fixture.client, route(), account))
    assert.equal(fixture.simulateContract.mock.calls.length, 0)
  }
  const exhausted = sendClient({ failAttempts: Number.POSITIVE_INFINITY })
  await assert.rejects(() => readFundBridgeSendValue(exhausted.client, route(), account))
  assert.equal(exhausted.simulateContract.mock.calls.length, CCIP_SUCKER_TRANSPORT_VALUES.length)
})
