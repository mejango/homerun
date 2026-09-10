import { JB_PROJECT_PAYER_DEPLOYER, jbProjectPayerDeployerAbi, v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAbiItem, parseAbi, zeroAddress, type AbiEvent, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ bendystraw: vi.fn() }))
vi.mock('../src/lib/bendystraw', () => ({ bendystraw: mocks.bendystraw }))
import { buildPayerTransaction, checkPayerFactory, decodePayerAttempt, getProjectPayerAddresses, payerAttemptIdentity, verifyPayerReceipt, type PayerAttempt, type ProjectPayerRow } from '../src/lib/project-payers'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const PAYER = '0x2222222222222222222222222222222222222222' as Address
const IMPL = '0x3333333333333333333333333333333333333333' as Address
const HASH = `0x${'aa'.repeat(32)}` as Hex
const BLOCK = `0x${'bb'.repeat(32)}` as Hex
const PROPOSAL = `0x${'cc'.repeat(32)}` as Hex
const safeAbi = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)', 'event ExecutionSuccess(bytes32 txHash,uint256 payment)', 'event ExecutionFailure(bytes32 txHash,uint256 payment)'])
function attempt(): PayerAttempt {
  return { version: 1, settings: { chainId: 1, projectId: '7', beneficiary: zeroAddress, owner: zeroAddress, addToBalance: false, memo: 'Homerun' }, account: ACCOUNT, safe: false, phase: 'submitted', hash: HASH, afterBlock: '99' }
}
function event(name: string, values: Record<string, unknown>, address = JB_PROJECT_PAYER_DEPLOYER, abi = jbProjectPayerDeployerAbi as readonly unknown[]) {
  const item = getAbiItem({ abi: abi as readonly AbiEvent[], name }) as AbiEvent
  return { address, data: encodeAbiParameters(item.inputs.filter(input => !input.indexed), item.inputs.filter(input => !input.indexed).map(input => values[input.name!])), topics: encodeEventTopics({ abi: [item], eventName: name, args: values }) } as unknown as TransactionReceipt['logs'][number]
}
function fixture() {
  const saved = attempt(), request = buildPayerTransaction(saved.settings)
  const args = { projectPayer: PAYER, defaultProjectId: 7n, defaultBeneficiary: zeroAddress, defaultMemo: 'Homerun', defaultMetadata: '0x', defaultAddToBalance: false, directory: v6Address('JBDirectory', 1), owner: zeroAddress, caller: ACCOUNT }
  const receipt = { transactionHash: HASH, blockNumber: 100n, blockHash: BLOCK, status: 'success', logs: [event('DeployProjectPayer', args)] } as TransactionReceipt
  const transaction = { hash: HASH, chainId: 1, blockNumber: 100n, blockHash: BLOCK, from: ACCOUNT, to: request.address, value: 0n, input: encodeFunctionData(request) }
  const client = { getChainId: vi.fn(async () => 1), getBlock: vi.fn(async () => ({ hash: BLOCK })), getTransaction: vi.fn(async () => transaction), readContract: vi.fn(async () => IMPL), getBytecode: vi.fn(async () => `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`) }
  return { saved, request, args, receipt, transaction, client, rpc: client as unknown as PublicClient }
}
function safe(f: ReturnType<typeof fixture>) {
  f.saved.safe = true; f.saved.hash = PROPOSAL; f.transaction.to = ACCOUNT
  f.transaction.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [f.request.address, 0n, encodeFunctionData(f.request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
  f.receipt.logs.push(event('ExecutionSuccess', { txHash: PROPOSAL, payment: 0n }, ACCOUNT, safeAbi))
}
beforeEach(() => { mocks.bendystraw.mockReset() })

describe('stock project payer transaction and recovery', () => {
  it('builds the SDK factory call with immutable sender-token defaults and empty metadata', () => {
    const request = buildPayerTransaction(attempt().settings)
    expect(request.address).toBe(JB_PROJECT_PAYER_DEPLOYER)
    expect(decodeFunctionData({ abi: request.abi, data: encodeFunctionData(request) })).toEqual({ functionName: 'deployProjectPayer', args: [7n, zeroAddress, 'Homerun', '0x', false, zeroAddress] })
    expect(request).not.toHaveProperty('value')
  })
  it('preserves fixed beneficiary, balance behavior and editable admin when reviewed', () => {
    expect(buildPayerTransaction({ ...attempt().settings, beneficiary: ACCOUNT, owner: IMPL, addToBalance: true }).args).toEqual([7n, ACCOUNT, 'Homerun', '0x', true, IMPL])
  })
  it('rejects invalid addresses and oversized memos before review', () => {
    expect(() => buildPayerTransaction({ ...attempt().settings, beneficiary: 'bad' as Address })).toThrow('Invalid')
    expect(() => buildPayerTransaction({ ...attempt().settings, memo: 'x'.repeat(501) })).toThrow('Invalid')
    expect(() => buildPayerTransaction({ ...attempt().settings, projectId: '0' })).toThrow('positive')
  })
  it('restores an unresolved EOA or Safe without confusing proposal and execution hashes', () => {
    expect(decodePayerAttempt(JSON.stringify(attempt()), 1, 7n)).toEqual(attempt())
    const saved = { ...attempt(), safe: true, hash: PROPOSAL, executionHash: HASH }
    expect(decodePayerAttempt(JSON.stringify(saved), 1, 7n)).toEqual(saved)
  })
  it('binds cached proof identity to every immutable attempt input, excluding its recorded outcome', () => {
    const original = attempt(), identity = payerAttemptIdentity(original)
    expect(payerAttemptIdentity({ ...original, phase: 'confirmed', payer: PAYER })).toBe(identity)
    for (const change of [{ account: PAYER }, { safe: true }, { afterBlock: '100' }, { hash: PROPOSAL }, { executionHash: PROPOSAL }, { id: '11111111-1111-4111-8111-111111111111' }, { settings: { ...original.settings, memo: 'Other memo' } }, { settings: { ...original.settings, beneficiary: PAYER } }, { settings: { ...original.settings, owner: PAYER } }, { settings: { ...original.settings, addToBalance: true } }]) expect(payerAttemptIdentity({ ...original, ...change })).not.toBe(identity)
  })
  it.each([{ phase: 'unknown' }, { hash: '0x12' }, { account: zeroAddress }, { safe: 'false' }, { afterBlock: '-1' }, { afterBlock: undefined }, { phase: 'confirmed', payer: zeroAddress }, { settings: { ...attempt().settings, chainId: 10 } }, { settings: { ...attempt().settings, projectId: '8' } }])('rejects unsafe or foreign saved attempts %#', change => {
    expect(() => decodePayerAttempt(JSON.stringify({ ...attempt(), ...change }), 1, 7n)).toThrow()
  })
})

describe('canonical payer readiness', () => {
  it('checks the SDK factory, directory, existing project and native terminal', async () => {
    const f = fixture()
    f.client.readContract.mockImplementation(async (...input: unknown[]) => {
      const name = (input[0] as { functionName: string }).functionName
      return name === 'DIRECTORY' ? v6Address('JBDirectory', 1) : name === 'ownerOf' ? ACCOUNT : IMPL
    })
    expect(await checkPayerFactory(f.rpc, 1, 7n)).toEqual({ directory: v6Address('JBDirectory', 1), implementation: IMPL, acceptsNative: true })
    expect(f.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: v6Address('JBProjects', 1), functionName: 'ownerOf', args: [7n] }))
  })
  it('reports that ETH forwarding cannot work without an ETH terminal', async () => {
    const f = fixture()
    f.client.readContract.mockImplementation(async (...input: unknown[]) => {
      const name = (input[0] as { functionName: string }).functionName
      return name === 'DIRECTORY' ? v6Address('JBDirectory', 1) : name === 'primaryTerminalOf' ? zeroAddress : ACCOUNT
    })
    expect((await checkPayerFactory(f.rpc, 1, 7n)).acceptsNative).toBe(false)
  })
  it('rejects a missing factory, foreign directory and wrong RPC chain', async () => {
    const f = fixture()
    await expect(checkPayerFactory(f.rpc, 1, 7n)).rejects.toThrow('canonical')
    f.client.getBytecode.mockResolvedValueOnce('0x')
    await expect(checkPayerFactory(f.rpc, 1, 7n)).rejects.toThrow('canonical')
    f.client.getChainId.mockResolvedValueOnce(10)
    await expect(checkPayerFactory(f.rpc, 1, 7n)).rejects.toThrow('wrong chain')
  })
})

describe('payer deployment receipt proof', () => {
  it('confirms an exact EOA factory deployment and canonical clone', async () => {
    const f = fixture()
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).resolves.toEqual({ status: 'confirmed', payer: PAYER })
    expect(f.client.getBytecode).toHaveBeenCalledWith({ address: PAYER, blockNumber: 100n })
  })
  it('confirms the exact Safe inner call and exact proposal success', async () => {
    const f = fixture(); safe(f)
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).resolves.toEqual({ status: 'confirmed', payer: PAYER })
    f.receipt.logs.pop()
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow('reviewed Safe')
    f.receipt.logs.push(event('ExecutionSuccess', { txHash: HASH, payment: 0n }, ACCOUNT, safeAbi))
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow('reviewed Safe')
  })
  it('releases only an EOA revert or a consumed Safe proposal with ExecutionFailure', async () => {
    const f = fixture(); f.receipt.status = 'reverted'; f.receipt.logs = []
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).resolves.toEqual({ status: 'reverted' })
    safe(f)
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow('without consuming the proposal')
    f.receipt.status = 'success'; f.receipt.logs = [event('ExecutionFailure', { txHash: PROPOSAL, payment: 0n }, ACCOUNT, safeAbi)]
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).resolves.toEqual({ status: 'reverted' })
    f.transaction.input = '0x'
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow()
  })
  it.each(['from', 'to', 'value', 'input', 'hash', 'chainId', 'blockHash', 'blockNumber'] as const)('rejects mismatched transaction %s', async field => {
    const f = fixture()
    Object.assign(f.transaction, { [field]: field === 'value' || field === 'blockNumber' ? 1n : field === 'chainId' ? 10 : field === 'input' ? '0x' : field === 'hash' || field === 'blockHash' ? PROPOSAL : IMPL })
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow()
  })
  it.each(['defaultProjectId', 'defaultBeneficiary', 'defaultMemo', 'defaultMetadata', 'defaultAddToBalance', 'directory', 'owner', 'caller', 'projectPayer'] as const)('rejects changed deployment setting %s', async field => {
    const f = fixture()
    const change = field === 'defaultProjectId' ? 8n : field === 'defaultMemo' ? 'changed' : field === 'defaultMetadata' ? '0x01' : field === 'defaultAddToBalance' ? true : field === 'projectPayer' ? zeroAddress : PAYER
    f.receipt.logs = [event('DeployProjectPayer', { ...f.args, [field]: change })]
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow('exactly one')
  })
  it('rejects forged or duplicate deploy events and noncanonical clone bytecode', async () => {
    const f = fixture()
    f.receipt.logs[0].address = ACCOUNT
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow('exactly one')
    f.receipt.logs = [event('DeployProjectPayer', f.args), event('DeployProjectPayer', f.args)]
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow('exactly one')
    f.receipt.logs.pop(); f.client.getBytecode.mockResolvedValueOnce('0x1234')
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow('clone')
  })
  it('rejects a reorg and old matching receipt supplied to recover an unknown submission', async () => {
    const f = fixture(); f.saved.hash = undefined; f.saved.afterBlock = '100'
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow('predates')
    f.saved.afterBlock = '99'; f.client.getBlock.mockResolvedValueOnce({ hash: PROPOSAL })
    await expect(verifyPayerReceipt(f.rpc, f.saved, f.receipt)).rejects.toThrow('canonical')
  })
})

describe('indexed payer address listing', () => {
  const row: ProjectPayerRow = { chainId: 1, projectId: 7, version: 6, address: PAYER, defaultAddToBalance: false, defaultBeneficiary: zeroAddress, owner: zeroAddress, paymentsCount: 2, addToBalanceCount: 0, totalFacilitated: '123', totalFacilitatedUsd: '0' }
  it('filters chain, project, version and malformed addresses without inventing a payer', async () => {
    mocks.bendystraw.mockResolvedValue({ projectPayers: { totalCount: 6, items: [row, { ...row, chainId: 10 }, { ...row, projectId: 8 }, { ...row, version: 5 }, { ...row, address: zeroAddress }, { ...row, defaultBeneficiary: 'bad' }] } })
    expect(await getProjectPayerAddresses(1, 7n)).toEqual([row])
    expect(mocks.bendystraw).toHaveBeenCalledWith(expect.stringContaining('HomerunProjectPayers'), { where: { chainId: 1, projectId: 7, version: 6 }, limit: 250, offset: 0 }, { chainId: 1, policy: 'live' })
  })
  it('paginates rather than silently dropping addresses', async () => {
    mocks.bendystraw.mockResolvedValueOnce({ projectPayers: { totalCount: 251, items: Array.from({ length: 250 }, () => row) } }).mockResolvedValueOnce({ projectPayers: { totalCount: 251, items: [{ ...row, address: IMPL }] } })
    expect(await getProjectPayerAddresses(1, 7n)).toEqual([row, { ...row, address: IMPL }])
    expect(mocks.bendystraw.mock.calls[1][1].offset).toBe(250)
  })
  it('reports incomplete indexer data and rejects an inexact Float project ID', async () => {
    mocks.bendystraw.mockResolvedValue({ projectPayers: { totalCount: 2, items: [row] } })
    await expect(getProjectPayerAddresses(1, 7n)).rejects.toThrow('incomplete')
    await expect(getProjectPayerAddresses(1, BigInt(Number.MAX_SAFE_INTEGER) + 1n)).rejects.toThrow('project ID')
  })
})
