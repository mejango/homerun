import { expect, it, vi } from 'vitest'
import { buildBridgePrepareTx, buildBridgeClaimTx, buildToRemoteTx, jbSuckerV6Abi, type JBClaim } from '@bananapus/nana-sdk-core/v6'
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, padHex, parseAbi, zeroAddress, zeroHash, type Abi, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { verifyFundBridgeReceipt } from '../src/lib/fund-bridge-receipts'
import type { FundTransaction } from '../src/lib/fund-contracts'

const account = '0x1111111111111111111111111111111111111111' as const
const sucker = '0x2222222222222222222222222222222222222222' as const
const token = '0x3333333333333333333333333333333333333333' as const
const other = '0x4444444444444444444444444444444444444444' as const
const hash = `0x${'ab'.repeat(32)}` as Hex
const blockHash = `0x${'cd'.repeat(32)}` as Hex
const safeAbi = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)'])
const events = parseAbi([
  'event RootToRemote(bytes32 indexed root,address indexed token,uint256 index,uint64 nonce,address caller)',
  'event Claimed(bytes32 beneficiary,address token,uint256 projectTokenCount,uint256 terminalTokenAmount,uint256 index,bytes32 metadata,address caller)',
])
function log(address: Address, abi: Abi, name: string, args: Record<string, unknown>) {
  const event = abi.find(item => item.type === 'event' && item.name === name)
  if (!event || event.type !== 'event') throw new Error('Unknown test event')
  const fields = event.inputs.filter(field => !field.indexed)
  return { address, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(fields, fields.map(field => args[field.name!])), transactionHash: hash, blockHash, blockNumber: 42n, logIndex: 0, transactionIndex: 0, removed: false }
}
function fixture(kind: 'prepare' | 'send' | 'claim' | 'approve' = 'prepare', safe = false) {
  const claim: JBClaim = { token, leaf: { index: 2n, beneficiary: padHex(account, { size: 32 }), projectTokenCount: 100n, terminalTokenAmount: 9n, metadata: zeroHash }, proof: Array(32).fill(zeroHash) as unknown as JBClaim['proof'] }
  const request: FundTransaction = kind === 'prepare' ? buildBridgePrepareTx({ chainId: 8453, sucker, token, projectTokenCount: 100n, beneficiary: account, minTokensReclaimed: 8n })
    : kind === 'send' ? buildToRemoteTx({ chainId: 8453, sucker, token, value: 100n })
      : kind === 'claim' ? buildBridgeClaimTx({ chainId: 8453, sucker, claim })
        : { chainId: 8453, address: token, abi: erc20Abi, functionName: 'approve', args: [sucker, 100n] }
  const event = kind === 'prepare' ? log(sucker, jbSuckerV6Abi, 'InsertToOutboxTree', { beneficiary: claim.leaf.beneficiary, token, hashed: hash, index: 2n, root: hash, projectTokenCount: 100n, terminalTokenAmount: 9n, metadata: zeroHash, caller: account })
    : kind === 'send' ? log(sucker, events, 'RootToRemote', { root: hash, token, index: 3n, nonce: 1n, caller: account })
      : kind === 'claim' ? log(sucker, events, 'Claimed', { ...claim.leaf, token, caller: account })
        : log(token, erc20Abi, 'Approval', { owner: account, spender: sucker, value: 100n })
  const data = encodeFunctionData(request)
  const transaction = { from: safe ? other : account, to: safe ? account : request.address, value: safe ? 0n : request.value ?? 0n,
    input: safe ? encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [request.address, request.value ?? 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) : data }
  const receipt = { status: 'success', transactionHash: hash, blockHash, blockNumber: 42n, logs: [event] } as unknown as TransactionReceipt
  const rpc = { getChainId: vi.fn(async () => 8453), getBlock: vi.fn(async () => ({ hash: blockHash })), getTransaction: vi.fn(async () => transaction), readContract: vi.fn(async () => 100n) }
  return { client: rpc as unknown as PublicClient, rpc, request, receipt, transaction }
}

it.each([['prepare', 'prepared'], ['send', 'sent'], ['claim', 'claimed'], ['approve', 'approved']] as const)('confirms only the exact %s step', async (kind, expected) => {
  const f = fixture(kind)
  expect(await verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, false)).toBe(expected)
  if (kind === 'approve') expect(f.rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 42n, args: [account, sucker] }))
})
it('rejects a successful outer receipt with no matching sucker effect', async () => {
  const f = fixture('claim', true)
  f.receipt.logs = []
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, true)).rejects.toThrow(/exactly one matching/)
})
it.each(['sender', 'target', 'payload', 'value'] as const)('rejects a different mined %s', async field => {
  const f = fixture()
  if (field === 'sender') f.transaction.from = other
  if (field === 'target') f.transaction.to = other
  if (field === 'payload') f.transaction.input = '0x'
  if (field === 'value') f.transaction.value = 1n
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, false)).rejects.toThrow(/mined call/)
})
it('checks direct Safe call identity and its exact successful sucker event', async () => {
  const f = fixture('prepare', true)
  expect(await verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, true)).toBe('prepared')
  f.transaction.input = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [other, 0n, encodeFunctionData(f.request), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] })
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, true)).rejects.toThrow(/different bridge payload/)
})
it('rejects wrong-chain, reverted and reorganized receipts', async () => {
  const f = fixture()
  f.rpc.getChainId.mockResolvedValueOnce(10)
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, false)).rejects.toThrow(/wrong chain/)
  f.receipt.status = 'reverted'
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, false)).rejects.toThrow(/did not succeed/)
  f.receipt.status = 'success'; f.rpc.getBlock.mockResolvedValueOnce({ hash })
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, false)).rejects.toThrow(/canonical chain/)
})
it('rejects an event from an unrelated emitter or a duplicate event', async () => {
  const f = fixture()
  f.receipt.logs[0].address = other
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, false)).rejects.toThrow(/exactly one/)
  f.receipt.logs[0].address = sucker; f.receipt.logs.push(f.receipt.logs[0])
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, false)).rejects.toThrow(/exactly one/)
})
it('requires the exact approval and its resulting allowance', async () => {
  const f = fixture('approve')
  f.rpc.readContract.mockResolvedValueOnce(99n)
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, false)).rejects.toThrow(/approval remains/)
  f.receipt.logs = []
  await expect(verifyFundBridgeReceipt(f.client, f.request, f.receipt, account, false)).rejects.toThrow(/approval remains/)
})
