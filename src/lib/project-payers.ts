import { jbDirectoryAbi, jbProjectsAbi, NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import { buildDeployProjectPayerTx, JB_PROJECT_PAYER_DEPLOYER, jbProjectPayerDeployerAbi, v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeEventLog, decodeFunctionData, encodeFunctionData, isAddress, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem'
import { bendystraw } from './bendystraw'

export type ProjectPayerRow = {
  chainId: number; projectId: number; version: number; address: Address
  defaultAddToBalance: boolean; defaultBeneficiary: Address; owner: Address
  paymentsCount: number; addToBalanceCount: number; totalFacilitated: string; totalFacilitatedUsd: string
}
const PROJECT_PAYERS_QUERY = `query HomerunProjectPayers($where: projectPayerFilter!, $limit: Int!, $offset: Int!) {
  projectPayers(where: $where, orderBy: "totalFacilitatedUsd", orderDirection: "desc", limit: $limit, offset: $offset) {
    totalCount
    items { chainId projectId version address defaultAddToBalance defaultBeneficiary owner paymentsCount addToBalanceCount totalFacilitated totalFacilitatedUsd }
  }
}`

/** Exact chain/project/version filtering; never substitute a terminal for a payer. */
export async function getProjectPayerAddresses(chainId: JBChainId, projectId: bigint): Promise<ProjectPayerRow[]> {
  if (projectId <= 0n || projectId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The project ID cannot be queried by the indexer.')
  const rows: ProjectPayerRow[] = []
  for (let offset = 0; ; offset += 250) {
    const data = await bendystraw<{ projectPayers: { totalCount: number; items: ProjectPayerRow[] } }>(PROJECT_PAYERS_QUERY,
      { where: { chainId, projectId: Number(projectId), version: 6 }, limit: 250, offset }, { chainId, policy: 'live' })
    const page = data.projectPayers
    rows.push(...page.items.filter(row => row.chainId === chainId && row.projectId === Number(projectId) && row.version === 6 && isAddress(row.address) && !isAddressEqual(row.address, zeroAddress) && isAddress(row.defaultBeneficiary) && isAddress(row.owner) && typeof row.defaultAddToBalance === 'boolean'))
    if (offset + page.items.length >= page.totalCount) break
    if (page.items.length < 250) throw new Error('The payer address index is incomplete. Retry to load the complete list.')
    if (offset >= 24_750) throw new Error('This project has too many payer addresses to load at once.')
  }
  return [...new Map(rows.map(row => [row.address.toLowerCase(), row])).values()]
}

export const payerFactoryReadAbi = parseAbi(['function DIRECTORY() view returns (address)', 'function IMPLEMENTATION() view returns (address)'])
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)', 'event ExecutionFailure(bytes32 txHash,uint256 payment)',
])
export type PayerSettings = {
  chainId: JBChainId; projectId: string; beneficiary: Address; owner: Address; memo: string; addToBalance: boolean
}
export type PayerAttempt = {
  version: 1; settings: PayerSettings; account: Address; safe: boolean
  /** Distinguishes new attempts with otherwise identical reviewed settings. */
  id?: string
  /** A recovered unknown submission cannot be settled by an older matching call. */
  afterBlock: string
  phase: 'signing' | 'submitted' | 'confirmed' | 'reverted'; hash?: Hex; executionHash?: Hex; payer?: Address
}
export function buildPayerTransaction(settings: PayerSettings) {
  if (!isAddress(settings.beneficiary) || !isAddress(settings.owner) || typeof settings.memo !== 'string' || settings.memo.length > 500 || typeof settings.addToBalance !== 'boolean') throw new Error('Invalid payer address settings.')
  return buildDeployProjectPayerTx({ ...settings, projectId: BigInt(settings.projectId), metadata: '0x' })
}
export function payerAttemptKey(chainId: JBChainId, projectId: bigint) { return `homerun:payer:${chainId}:${projectId}:v1` }
/** All immutable proof inputs, excluding status and untrusted saved outputs. */
export function payerAttemptIdentity(attempt: PayerAttempt): string {
  const { settings } = attempt
  return JSON.stringify([attempt.version, attempt.id ?? null, settings.chainId, settings.projectId, settings.beneficiary.toLowerCase(), settings.owner.toLowerCase(), settings.memo, settings.addToBalance, attempt.account.toLowerCase(), attempt.safe, attempt.afterBlock, attempt.hash?.toLowerCase() ?? null, attempt.executionHash?.toLowerCase() ?? null])
}
export function decodePayerAttempt(raw: string, chainId: JBChainId, projectId: bigint): PayerAttempt {
  const attempt = JSON.parse(raw) as PayerAttempt
  if (attempt.version !== 1 || attempt.settings?.chainId !== chainId || attempt.settings.projectId !== String(projectId) || !isAddress(attempt.account) || isAddressEqual(attempt.account, zeroAddress) || typeof attempt.safe !== 'boolean' || !/^\d+$/.test(attempt.afterBlock) || !['signing', 'submitted', 'confirmed', 'reverted'].includes(attempt.phase)
    || (attempt.id !== undefined && (typeof attempt.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(attempt.id)))
    || [attempt.hash, attempt.executionHash].some(hash => hash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(hash))
    || (['submitted', 'confirmed', 'reverted'].includes(attempt.phase) && !attempt.hash && !attempt.executionHash)
    || (attempt.phase === 'confirmed' && (!attempt.payer || !isAddress(attempt.payer) || isAddressEqual(attempt.payer, zeroAddress)))) throw new Error('The saved payer deployment is invalid. Keep it for recovery and check the original wallet transaction.')
  buildPayerTransaction(attempt.settings)
  return attempt
}

/** Require the same canonical factory/directory as the reference apps before any wallet write. */
export async function checkPayerFactory(client: PublicClient, chainId: JBChainId, projectId: bigint) {
  if (projectId <= 0n || await client.getChainId() !== chainId) throw new Error('The payer request has the wrong chain or project.')
  const [code, directory, implementation] = await Promise.all([
    client.getBytecode({ address: JB_PROJECT_PAYER_DEPLOYER }),
    client.readContract({ address: JB_PROJECT_PAYER_DEPLOYER, abi: payerFactoryReadAbi, functionName: 'DIRECTORY' }),
    client.readContract({ address: JB_PROJECT_PAYER_DEPLOYER, abi: payerFactoryReadAbi, functionName: 'IMPLEMENTATION' }),
  ])
  if (!code || code === '0x' || !isAddressEqual(directory, v6Address('JBDirectory', chainId)) || isAddressEqual(implementation, zeroAddress)) throw new Error('The canonical Juicebox V6 payer factory could not be verified on this chain.')
  const [owner, terminal] = await Promise.all([
    client.readContract({ address: v6Address('JBProjects', chainId), abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId] }),
    client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'primaryTerminalOf', args: [projectId, NATIVE_TOKEN] }),
  ])
  if (isAddressEqual(owner, zeroAddress)) throw new Error('This Juicebox project does not exist.')
  return { directory, implementation, acceptsNative: !isAddressEqual(terminal, zeroAddress) }
}

/** Exact call, canonical receipt, deployment settings and clone bytecode, for EOA and Safe. */
export async function verifyPayerReceipt(client: PublicClient, attempt: PayerAttempt, receipt: TransactionReceipt): Promise<{ status: 'confirmed'; payer: Address } | { status: 'reverted' }> {
  const { settings, account } = attempt
  const request = buildPayerTransaction(settings)
  if (await client.getChainId() !== settings.chainId) throw new Error('The receipt RPC returned a different chain.')
  const [transaction, block] = await Promise.all([client.getTransaction({ hash: receipt.transactionHash }), client.getBlock({ blockNumber: receipt.blockNumber })])
  if (!receipt.blockHash || block.hash !== receipt.blockHash || transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber || transaction.hash !== receipt.transactionHash || transaction.chainId !== settings.chainId || receipt.blockNumber <= BigInt(attempt.afterBlock)) throw new Error('The payer receipt is no longer a matching canonical execution, or predates this attempt.')
  const data = encodeFunctionData(request)
  const safeEvents = receipt.logs.flatMap(log => {
    if (!isAddressEqual(log.address, account)) return []
    try { return [decodeEventLog({ abi: safeAbi, data: log.data, topics: log.topics, strict: true })] } catch { return [] }
  }).filter(event => !attempt.hash || event.args.txHash.toLowerCase() === attempt.hash.toLowerCase())
  if (attempt.safe) {
    if (!transaction.to || !isAddressEqual(transaction.to, account)) throw new Error('The payer transaction did not execute through the reviewed Safe.')
    const decoded = decodeFunctionData({ abi: safeAbi, data: transaction.input })
    const [target, value, innerData, operation] = decoded.args
    if (!isAddressEqual(target, request.address) || value !== 0n || innerData.toLowerCase() !== data.toLowerCase() || operation !== 0) throw new Error('The Safe executed a different payer deployment call.')
    if (receipt.status === 'reverted') throw new Error('The Safe execution attempt reverted without consuming the proposal. The original proposal may still execute; keep it pending.')
    if (receipt.status === 'success' && safeEvents.some(event => event.eventName === 'ExecutionFailure')) return { status: 'reverted' }
    if (receipt.status === 'success' && !safeEvents.some(event => event.eventName === 'ExecutionSuccess')) throw new Error('The receipt does not prove successful execution of the reviewed Safe payer proposal.')
  } else if (!transaction.to || !isAddressEqual(transaction.to, request.address) || !isAddressEqual(transaction.from, account) || transaction.value !== 0n || transaction.input.toLowerCase() !== data.toLowerCase() || (attempt.hash && attempt.hash !== receipt.transactionHash)) throw new Error('The transaction differs from the reviewed payer deployment.')
  if (receipt.status === 'reverted') return { status: 'reverted' }
  const matches = receipt.logs.flatMap(log => {
    if (!isAddressEqual(log.address, request.address)) return []
    try {
      const { args } = decodeEventLog({ abi: jbProjectPayerDeployerAbi, eventName: 'DeployProjectPayer', data: log.data, topics: log.topics, strict: true })
      return args.defaultProjectId === BigInt(settings.projectId) && isAddressEqual(args.defaultBeneficiary, settings.beneficiary) && args.defaultMemo === settings.memo && args.defaultMetadata === '0x'
        && args.defaultAddToBalance === settings.addToBalance && isAddressEqual(args.owner, settings.owner) && isAddressEqual(args.caller, account) && isAddressEqual(args.directory, v6Address('JBDirectory', settings.chainId)) && !isAddressEqual(args.projectPayer, zeroAddress) ? [args.projectPayer] : []
    } catch { return [] }
  })
  if (matches.length !== 1) throw new Error('The receipt does not contain exactly one matching payer deployment.')
  const [implementation, code] = await Promise.all([
    client.readContract({ address: request.address, abi: payerFactoryReadAbi, functionName: 'IMPLEMENTATION', blockNumber: receipt.blockNumber }),
    client.getBytecode({ address: matches[0], blockNumber: receipt.blockNumber }),
  ])
  if (isAddressEqual(implementation, zeroAddress) || code?.toLowerCase() !== `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`) throw new Error('The payer address is not the canonical factory’s expected clone.')
  return { status: 'confirmed', payer: matches[0] }
}
