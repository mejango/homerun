import { describe, expect, it, vi } from 'vitest'
import { erc2771ForwarderAbi, jbControllerAbi, jbProjectsAbi, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { tokenCurrencyId, v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, zeroAddress, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { buildFundLaunch, initialFundRuleset, type FundLaunchInput } from '../src/lib/fund-contracts'
import { homerunDeployerAbi } from '../src/lib/income-contracts'
import { HOMERUN_ALLOWLIST_HOOK } from './fixtures/homerun-deployer'
import { checkLaunchDeployment, fundLaunchFailed, verifyFailedFundLaunch, verifyFundLaunch, verifyReturnedFundWriteFailure } from '../src/lib/fund-launch-verification'
import { safeExecutionLog } from './support/safe-logs'
import { placeReceipt } from './support/recovery-receipt'

vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

const owner = '0x1111111111111111111111111111111111111111' as const
const other = '0x2222222222222222222222222222222222222222' as const
const salt = `0x${'12'.repeat(32)}` as Hex
const hash = `0x${'ab'.repeat(32)}` as Hex
const blockHash = `0x${'cd'.repeat(32)}` as Hex
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
])
function eventLog(address: Address, abi: Abi, name: string, args: Record<string, unknown>) {
  const event = abi.find(item => item.type === 'event' && item.name === name)
  if (!event || event.type !== 'event') throw new Error('Unknown fixture event')
  const fields = event.inputs.filter(field => !field.indexed)
  return { address, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(fields, fields.map(field => args[field.name!])), transactionHash: hash, blockHash, blockNumber: 123n, logIndex: 0, transactionIndex: 0, removed: false }
}
function fixture(options: { linked?: boolean; safe?: boolean; future?: boolean; immediate?: boolean } = {}) {
  const chainId: JBChainId = 8453
  const input: FundLaunchInput = { owner, sender: owner, chainIds: options.linked ? [8453, 10] : [8453], projectUri: 'ipfs://bafkreimetadata', tokenName: 'House FUND', ticker: 'HOUSE', salt, mustStartAtOrAfter: options.immediate ? 0 : options.future ? 2000 : 1000, creationFees: { 8453: 5n, 10: 6n } }
  const request = buildFundLaunch(input).requests[0]
  const controller = v6Address('JBController', chainId)
  const projects = v6Address('JBProjects', chainId)
  const omnichain = v6Address('JBOmnichainDeployer', chainId)
  const config = initialFundRuleset(input.mustStartAtOrAfter)
  // Every FUND goes through the omnichain deployer, linked or not.
  const metadata = { ...config.metadata, dataHook: omnichain, useDataHookForPay: true, useDataHookForCashOut: true }
  const ruleset = { cycleNumber: 1, id: 1100, basedOnId: 0, start: options.immediate ? 1100 : options.future ? 2000 : 1000, duration: 0, weight: config.weight, weightCutPercent: 0, approvalHook: zeroAddress, metadata: 0n }
  const values: Record<string, unknown> = { ownerOf: owner, isFund: true, tokenOf: other, name: 'House FUND', symbol: 'HOUSE', terminalsOf: [v6Address('JBMultiTerminal', chainId), v6Address('JBRouterTerminalRegistry', chainId)], getRulesetOf: [ruleset, metadata], latestQueuedRulesetOf: [ruleset, metadata, 0], controllerOf: controller,
    accountingContextsOf: [{ token: USDC_ADDRESSES[chainId], decimals: 6, currency: tokenCurrencyId(USDC_ADDRESSES[chainId]) }], payoutLimitsOf: [], surplusAllowancesOf: [], uriOf: input.projectUri,
    extraDataHookOf: { dataHook: HOMERUN_ALLOWLIST_HOOK, useDataHookForPay: true, useDataHookForCashOut: false }, isOpen: false, creationFee: 5n, pricePerUnitOf: 1_000_000n }
  const logs = [
    eventLog(projects, jbProjectsAbi, 'Create', { projectId: 7n, owner: omnichain, caller: omnichain }),
    eventLog(controller, jbControllerAbi, 'LaunchRulesets', { rulesetId: 1100n, projectId: 7n, projectUri: input.projectUri, memo: '', caller: omnichain }),
    eventLog(request.address, homerunDeployerAbi as Abi, 'FundLaunched', { projectId: 7n, owner, caller: owner }),
  ]
  const data = encodeFunctionData(request)
  const tx = { from: options.safe ? other : owner, to: options.safe ? owner : request.address, value: options.safe ? 0n : request.value,
    input: options.safe ? encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [request.address, request.value!, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) : data }
  if (options.safe) logs.push(eventLog(owner, safeAbi, 'ExecutionSuccess', { txHash: hash, payment: 0n }))
  const receipt = { status: 'success', transactionHash: hash, blockHash, blockNumber: 123n, logs } as unknown as TransactionReceipt
  const client = {
    getChainId: vi.fn(async () => chainId), getCode: vi.fn(async () => '0x1234'),
    getBlock: vi.fn(async () => ({ hash: blockHash, timestamp: 1100n })),
    getTransaction: vi.fn(async () => tx),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (!(functionName in values)) throw new Error(`Unexpected RPC ${functionName}`)
      return values[functionName]
    }),
  }
  return { client: client as unknown as PublicClient, spies: client, request, input, receipt, tx, values, ruleset, metadata }
}

describe('FUND launch confirmation', () => {
  it.each(['finalized', 'nonfinal', 'different hash', 'missing provenance', 'wrong calldata'])('requires the wallet-recorded ordinary failure at finality: %s', async kind => {
    const f = fixture()
    Object.assign(f.receipt, { status: 'reverted', logs: [] })
    const transaction = { ...f.tx, hash, blockHash, blockNumber: f.receipt.blockNumber }
    if (kind === 'wrong calldata') transaction.input = '0x'
    placeReceipt(transaction, f.receipt)
    const client = { ...f.client,
      getTransaction: vi.fn(async () => transaction),
      getTransactionReceipt: vi.fn(async () => f.receipt),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? (kind === 'nonfinal' ? 122n : 123n), hash: blockHash, timestamp: 1100n })),
    } as unknown as PublicClient
    const proof = verifyReturnedFundWriteFailure(client, f.request, f.input, f.receipt, {
      hash: kind === 'different hash' ? `0x${'ef'.repeat(32)}` : hash, safe: false,
      ...(kind !== 'missing provenance' ? { walletReturned: true as const } : {}),
    })
    if (kind === 'finalized') await expect(proof).resolves.toBeUndefined()
    else await expect(proof).rejects.toThrow()
  })
  it('verifies relayed launches against the signed call and every project postcondition', async () => {
    const f = fixture({ linked: true })
    const target = v6Address('ERC2771Forwarder', 8453)
    const data = encodeFunctionData({ abi: erc2771ForwarderAbi, functionName: 'execute', args: [{
      from: owner, to: f.request.address, value: f.request.value!, gas: 2_000_000n,
      deadline: 2000, data: encodeFunctionData(f.request), signature: `0x${'dd'.repeat(65)}`,
    }] })
    const entry = { chain: 8453, target, data, value: f.request.value!.toString() }
    Object.assign(f.tx, { from: other, to: target, input: data })
    expect(await verifyFundLaunch(f.client, f.request, f.input, f.receipt, false, entry)).toBe(7n)
    f.values.ownerOf = other
    await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, false, entry)).rejects.toThrow()
    f.values.ownerOf = owner
    f.values.uriOf = 'ipfs://wrong'
    await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, false, entry)).rejects.toThrow()
    f.values.uriOf = f.input.projectUri
    await expect(verifyFundLaunch(f.client, f.request, { ...f.input, sender: other }, f.receipt, false, entry)).rejects.toThrow(/saved project configuration/)
    Object.assign(f.tx, { to: other })
    await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, false, entry)).rejects.toThrow(/signed forwarder/)
  })
  it('checks current fee, correct RPC and deployed code before signing', async () => {
    const f = fixture()
    await checkLaunchDeployment(f.client, f.request)
    f.values.creationFee = 6n
    await expect(checkLaunchDeployment(f.client, f.request)).rejects.toThrow(/fee changed/)
    f.spies.getChainId.mockResolvedValue(10 as 8453)
    await expect(checkLaunchDeployment(f.client, f.request)).rejects.toThrow(/wrong chain/)
  })
  it.each([{ linked: false }, { linked: true }, { linked: false, future: true }, { linked: true, future: true }, { immediate: true }])('verifies the exact new project for %j', async options => {
    const f = fixture(options)
    expect(await verifyFundLaunch(f.client, f.request, f.input, f.receipt, false)).toBe(7n)
    expect(f.spies.readContract.mock.calls.every(([args]) => !('blockNumber' in args) || args.blockNumber === 123n)).toBe(true)
    expect(f.spies.readContract.mock.calls.some(([args]) => args.functionName === 'getRulesetOf')).toBe(true)
    expect(f.spies.readContract.mock.calls.some(([args]) => args.functionName === 'currentRulesetOf')).toBe(false)
  })
  it('preserves the exact past shared start observed on the Base local fork', async () => {
    const f = fixture({ linked: true })
    expect(await verifyFundLaunch(f.client, f.request, f.input, f.receipt, false)).toBe(7n)
    f.ruleset.start = 1100
    await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, false)).rejects.toThrow(/initial FUND rules/)
  })
  it('requires both canonical creation and the correct canonical launch event', async () => {
    const f = fixture({ linked: true })
    f.receipt.logs.splice(0, 1)
    await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, false)).rejects.toThrow(/project NFT/)
    const fake = fixture()
    fake.receipt.logs[1].address = other
    await expect(verifyFundLaunch(fake.client, fake.request, fake.input, fake.receipt, false)).rejects.toThrow(/through the omnichain deployer/)
    const duplicate = fixture()
    duplicate.receipt.logs.push(duplicate.receipt.logs[2])
    await expect(verifyFundLaunch(duplicate.client, duplicate.request, duplicate.input, duplicate.receipt, false)).rejects.toThrow(/exactly one matching/)
    const impostor = fixture()
    impostor.receipt.logs[2].address = other
    await expect(verifyFundLaunch(impostor.client, impostor.request, impostor.input, impostor.receipt, false)).rejects.toThrow(/exactly one matching/)
    const unrecorded = fixture()
    unrecorded.values.isFund = false
    await expect(verifyFundLaunch(unrecorded.client, unrecorded.request, unrecorded.input, unrecorded.receipt, false)).rejects.toThrow(/does not record/)
  })
  it('rejects wrong owners, hidden withdrawals, changed metadata and future-rule changes', async () => {
    for (const key of ['ownerOf', 'payoutLimitsOf', 'surplusAllowancesOf', 'uriOf', 'controllerOf']) {
      const f = fixture({ future: true })
      f.values[key] = key === 'payoutLimitsOf' || key === 'surplusAllowancesOf' ? [{ amount: 1n, currency: 2 }] : other
      await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, false)).rejects.toThrow()
    }
    const f = fixture({ future: true })
    f.metadata.allowSetTerminals = true
    await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, false)).rejects.toThrow(/initial FUND rules/)
    const untokenized = fixture(); untokenized.values.tokenOf = zeroAddress
    await expect(verifyFundLaunch(untokenized.client, untokenized.request, untokenized.input, untokenized.receipt, false)).rejects.toThrow(/ERC-20 was not deployed/)
    const renamed = fixture(); renamed.values.symbol = 'OTHER'
    await expect(verifyFundLaunch(renamed.client, renamed.request, renamed.input, renamed.receipt, false)).rejects.toThrow(/name or ticker/)
    const unrouted = fixture(); unrouted.values.terminalsOf = [v6Address('JBMultiTerminal', 8453)]
    await expect(verifyFundLaunch(unrouted.client, unrouted.request, unrouted.input, unrouted.receipt, false)).rejects.toThrow(/terminals differ/)
    const ungated = fixture(); ungated.values.extraDataHookOf = { dataHook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false }
    await expect(verifyFundLaunch(ungated.client, ungated.request, ungated.input, ungated.receipt, false)).rejects.toThrow(/missing its payment allowlist/)
    const opened = fixture(); opened.values.isOpen = true
    await expect(verifyFundLaunch(opened.client, opened.request, opened.input, opened.receipt, false)).rejects.toThrow(/closed allowlist/)
  })
  it('does not confirm a wrong fee/payload/sender or a reorganized receipt', async () => {
    const wrong = fixture(); wrong.tx.value = 6n
    await expect(verifyFundLaunch(wrong.client, wrong.request, wrong.input, wrong.receipt, false)).rejects.toThrow(/mined transaction/)
    const reorg = fixture(); reorg.spies.getBlock.mockResolvedValue({ hash: hash, timestamp: 1100n })
    await expect(verifyFundLaunch(reorg.client, reorg.request, reorg.input, reorg.receipt, false)).rejects.toThrow(/canonical chain/)
    const source = fixture(); source.tx.from = other
    await expect(verifyFundLaunch(source.client, source.request, source.input, source.receipt, false)).rejects.toThrow(/mined transaction/)
  })
  it('verifies a Safe execution by its exact inner payload and onchain success event', async () => {
    const f = fixture({ safe: true, linked: true })
    expect(await verifyFundLaunch(f.client, f.request, f.input, f.receipt, true)).toBe(7n)
    f.receipt.logs.pop()
    await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, true)).rejects.toThrow('has no ExecutionSuccess or ExecutionFailure from Safe')
  })
  describe('Safe execution events', () => {
    const PROPOSAL = `0x${'ef'.repeat(32)}` as Hex
    /** The Safe executing the launch, with `events` in place of its execution event. */
    const safeFixture = (...events: ReturnType<typeof safeExecutionLog>[]) => {
      const f = fixture({ safe: true })
      f.receipt.logs.splice(-1, 1, ...events as unknown as TransactionReceipt['logs'])
      return f
    }
    it('confirms a Safe 1.4.1 execution, whose txHash is indexed', async () => {
      const f = safeFixture(safeExecutionLog(owner, PROPOSAL))
      expect(await verifyFundLaunch(f.client, f.request, f.input, f.receipt, true)).toBe(7n)
      expect(fundLaunchFailed(f.receipt, f.input, true, PROPOSAL)).toBe(false)
    })
    it('reads a Safe 1.4.1 ExecutionFailure as a failed launch that can be retried', async () => {
      const f = safeFixture(safeExecutionLog(owner, PROPOSAL, { failed: true }))
      await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, true)).rejects.toThrow('its call failed (ExecutionFailure)')
      expect(fundLaunchFailed(f.receipt, f.input, true, PROPOSAL)).toBe(true)
      await expect(verifyFailedFundLaunch(f.client, f.request, f.input, f.receipt, true, PROPOSAL)).resolves.toBeUndefined()
      // Without the proposal it names, a successful receipt proves no failure.
      await expect(verifyFailedFundLaunch(f.client, f.request, f.input, f.receipt, true)).rejects.toThrow(/reverted deployment/)
    })
    it('confirms a Safe 1.3 execution, whose txHash is in data', async () => {
      const f = safeFixture(safeExecutionLog(owner, PROPOSAL, { version: '1.3' }))
      expect(await verifyFundLaunch(f.client, f.request, f.input, f.receipt, true)).toBe(7n)
    })
    it('ignores another Safe’s failure in the same receipt', async () => {
      const f = safeFixture(safeExecutionLog(other, PROPOSAL, { failed: true }), safeExecutionLog(owner, PROPOSAL))
      expect(await verifyFundLaunch(f.client, f.request, f.input, f.receipt, true)).toBe(7n)
      expect(fundLaunchFailed(f.receipt, f.input, true, PROPOSAL)).toBe(false)
    })
  })
  it('cannot use the Safe flag to bypass exact request binding', async () => {
    const f = fixture({ safe: true })
    f.tx.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [other, f.request.value!, encodeFunctionData(f.request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    await expect(verifyFundLaunch(f.client, f.request, f.input, f.receipt, true)).rejects.toThrow(/different deployment payload/)
    const wrongSafe = fixture({ safe: true }); wrongSafe.tx.to = other
    await expect(verifyFundLaunch(wrongSafe.client, wrongSafe.request, wrongSafe.input, wrongSafe.receipt, true)).rejects.toThrow(/not executed by the Safe/)
  })
  it('only a matching canonical reverted transaction can unlock retry', async () => {
    const f = fixture()
    await expect(verifyFailedFundLaunch(f.client, f.request, f.input, f.receipt, false)).rejects.toThrow(/reverted deployment/)
    f.receipt.status = 'reverted'
    await expect(verifyFailedFundLaunch(f.client, f.request, f.input, f.receipt, false)).resolves.toBeUndefined()
    f.tx.from = other
    await expect(verifyFailedFundLaunch(f.client, f.request, f.input, f.receipt, false)).rejects.toThrow(/mined transaction/)
    const reorg = fixture(); reorg.receipt.status = 'reverted'
    reorg.spies.getBlock.mockResolvedValue({ hash, timestamp: 1100n })
    await expect(verifyFailedFundLaunch(reorg.client, reorg.request, reorg.input, reorg.receipt, false)).rejects.toThrow(/canonical chain/)
  })
  it('retains a Safe proposal after an outer revert and still rejects unrelated calldata', async () => {
    const f = fixture({ safe: true })
    f.receipt.status = 'reverted'; f.receipt.logs.length = 0
    await expect(verifyFailedFundLaunch(f.client, f.request, f.input, f.receipt, true)).rejects.toThrow('without resolving its proposal')
    f.tx.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [other, f.request.value!, encodeFunctionData(f.request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
    await expect(verifyFailedFundLaunch(f.client, f.request, f.input, f.receipt, true)).rejects.toThrow(/different deployment payload/)
  })
})
