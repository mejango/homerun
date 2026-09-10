import { jbSuckerV6Abi, type JBClaim } from '@bananapus/nana-sdk-core/v6'
import { decodeEventLog, decodeFunctionData, encodeFunctionData, erc20Abi, isAddressEqual, parseAbi, type Address, type PublicClient, type TransactionReceipt } from 'viem'
import type { FundTransaction } from './fund-contracts'

const safeAbi = parseAbi(['function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)'])
// IJBSucker.sol events omitted by the SDK's deliberately small write ABI.
const receiptEvents = parseAbi([
  'event RootToRemote(bytes32 indexed root,address indexed token,uint256 index,uint64 nonce,address caller)',
  'event Claimed(bytes32 beneficiary,address token,uint256 projectTokenCount,uint256 terminalTokenAmount,uint256 index,bytes32 metadata,address caller)',
])

/** Source confirmation is never described as destination delivery. */
export async function verifyFundBridgeReceipt(client: PublicClient, request: FundTransaction, receipt: TransactionReceipt, account: Address, safe: boolean): Promise<'approved' | 'prepared' | 'sent' | 'claimed'> {
  if (receipt.status !== 'success') throw new Error('The bridge transaction did not succeed onchain.')
  if (await client.getChainId() !== request.chainId) throw new Error('The bridge receipt RPC returned the wrong chain.')
  const [block, tx] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getTransaction({ hash: receipt.transactionHash }),
  ])
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('The bridge receipt is no longer in the canonical chain.')
  const data = encodeFunctionData(request)
  if (!safe) {
    if (!isAddressEqual(tx.from, account) || !tx.to || !isAddressEqual(tx.to, request.address) || tx.value !== (request.value ?? 0n) || tx.input.toLowerCase() !== data.toLowerCase()) throw new Error('The mined call does not match the reviewed bridge transaction.')
  } else {
    if (!tx.to || !isAddressEqual(tx.to, account)) throw new Error('The expected Safe did not execute this transaction.')
    let decoded
    try { decoded = decodeFunctionData({ abi: safeAbi, data: tx.input }) }
    catch { throw new Error('This Safe execution format cannot be verified here. Check the execution in Safe.') }
    const [to, value, innerData, operation] = decoded.args
    if (!isAddressEqual(to, request.address) || value !== (request.value ?? 0n) || innerData.toLowerCase() !== data.toLowerCase() || operation !== 0) throw new Error('The Safe executed a different bridge payload.')
  }
  if (request.functionName === 'approve') {
    const [spender, amount] = request.args as readonly [Address, bigint]
    const allowance = await client.readContract({ address: request.address, abi: erc20Abi, functionName: 'allowance', args: [account, spender], blockNumber: receipt.blockNumber })
    const approved = receipt.logs.some(log => {
      if (!isAddressEqual(log.address, request.address)) return false
      try {
        const { args } = decodeEventLog({ abi: erc20Abi, eventName: 'Approval', data: log.data, topics: log.topics })
        return isAddressEqual(args.owner, account) && isAddressEqual(args.spender, spender) && args.value === amount
      } catch { return false }
    })
    if (!approved || allowance < amount) throw new Error('The receipt does not prove the exact project-token approval remains available.')
    return 'approved'
  }
  const eventName = request.functionName === 'prepare' ? 'InsertToOutboxTree' : request.functionName === 'toRemote' ? 'RootToRemote' : request.functionName === 'claim' ? 'Claimed' : null
  if (!eventName) throw new Error('Unsupported bridge receipt verification.')
  const matching = receipt.logs.filter(log => {
    if (!isAddressEqual(log.address, request.address)) return false
    try {
      if (eventName === 'InsertToOutboxTree') {
        const decoded = decodeEventLog({ abi: jbSuckerV6Abi, eventName: 'InsertToOutboxTree', data: log.data, topics: log.topics })
        if (!isAddressEqual(decoded.args.caller, account)) return false
        const [count, beneficiary, minimum, token, metadata] = request.args as readonly [bigint, string, bigint, Address, string]
        return decoded.args.projectTokenCount === count && decoded.args.beneficiary.toLowerCase() === beneficiary.toLowerCase() && decoded.args.terminalTokenAmount >= minimum && isAddressEqual(decoded.args.token, token) && decoded.args.metadata.toLowerCase() === metadata.toLowerCase()
      }
      if (eventName === 'RootToRemote') {
        const decoded = decodeEventLog({ abi: receiptEvents, eventName: 'RootToRemote', data: log.data, topics: log.topics })
        return isAddressEqual(decoded.args.caller, account) && isAddressEqual(decoded.args.token, request.args[0] as Address)
      }
      const decoded = decodeEventLog({ abi: receiptEvents, eventName: 'Claimed', data: log.data, topics: log.topics })
      const claim = request.args[0] as JBClaim
      return isAddressEqual(decoded.args.caller, account) && isAddressEqual(decoded.args.token, claim.token) && decoded.args.index === claim.leaf.index && decoded.args.projectTokenCount === claim.leaf.projectTokenCount && decoded.args.terminalTokenAmount === claim.leaf.terminalTokenAmount && decoded.args.beneficiary.toLowerCase() === claim.leaf.beneficiary.toLowerCase() && decoded.args.metadata.toLowerCase() === claim.leaf.metadata.toLowerCase()
    } catch { return false }
  })
  if (matching.length !== 1) throw new Error('The receipt does not prove exactly one matching bridge action. Refresh the movement history before continuing.')
  return request.functionName === 'prepare' ? 'prepared' : request.functionName === 'toRemote' ? 'sent' : 'claimed'
}
