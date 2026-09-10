/** Discover Homerun's immutable FUND relationship from a canonical INCOME creation transaction. */
import { SUPPORTED_CHAINS, jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeEventLog, getAbiItem, isAddress, isAddressEqual, toEventSelector, zeroAddress, zeroHash, type AbiEvent, type Address, type Hex, type PublicClient } from 'viem'
import { homerunIncomeDeployerAbi, registeredIncomeDeployer } from './income-contracts'
import { readInitialIncomeAllocation } from './income-allocation-state'

const createEvent = getAbiItem({ abi: jbProjectsAbi, name: 'Create' })
const incomeEvent = getAbiItem({ abi: homerunIncomeDeployerAbi, name: 'IncomeDeployed' })
const UINT256_LIMIT = 1n << 256n

type Header = { number: bigint; hash: Hex }
type EvidenceLog = {
  address: Address; blockNumber: bigint; blockHash: Hex; transactionHash: Hex
  logIndex: number; data: Hex; topics: [Hex, ...Hex[]]; args: Record<string, unknown>
}
function validHash(value: unknown): value is Hex { return typeof value === 'string' && /^0x[\da-fA-F]{64}$/.test(value) && value.toLowerCase() !== zeroHash }
function validAddress(value: unknown): value is Address { return typeof value === 'string' && isAddress(value) && !isAddressEqual(value, zeroAddress) }
function uint(value: unknown, label: string, positive = false): bigint {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value >= UINT256_LIMIT) throw new Error(`The ${label} is not a valid uint256.`)
  return value
}
function header(value: { number: bigint | null; hash: Hex | null }, expected?: bigint): Header {
  if (typeof value.number !== 'bigint' || value.number < 0n || value.number >= UINT256_LIMIT || !validHash(value.hash) || (expected !== undefined && value.number !== expected)) throw new Error('The RPC returned an inconsistent INCOME history block.')
  return { number: value.number, hash: value.hash }
}
function decodeHistoryLog(raw: unknown, address: Address, block: Header, event: AbiEvent): EvidenceLog {
  const log = raw as Partial<EvidenceLog> & { removed?: boolean }
  if (!log || log.removed || !validAddress(log.address) || !isAddressEqual(log.address, address) || log.blockNumber !== block.number || !validHash(log.blockHash) || log.blockHash.toLowerCase() !== block.hash.toLowerCase() || !validHash(log.transactionHash) || !Number.isSafeInteger(log.logIndex) || log.logIndex! < 0 || !Array.isArray(log.topics) || !log.topics.length || typeof log.data !== 'string') throw new Error('The RPC returned inconsistent INCOME deployment history.')
  try {
    const decoded = decodeEventLog({ abi: [event], data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true })
    return { ...(log as EvidenceLog), args: decoded.args as Record<string, unknown> }
  } catch (cause) { throw new Error('The INCOME deployment history has invalid event data.', { cause }) }
}
function sameLog(left: EvidenceLog, right: EvidenceLog): boolean {
  return left.logIndex === right.logIndex && left.transactionHash.toLowerCase() === right.transactionHash.toLowerCase()
    && left.data.toLowerCase() === right.data.toLowerCase() && left.topics.length === right.topics.length
    && left.topics.every((topic, index) => topic.toLowerCase() === right.topics[index].toLowerCase())
}
function receiptEvents(logs: readonly unknown[], address: Address, block: Header, event: AbiEvent, field: string, id: bigint): EvidenceLog[] {
  const topic = toEventSelector(event).toLowerCase()
  return logs.flatMap(raw => {
    const log = raw as Partial<EvidenceLog>
    if (!log.address || !isAddress(log.address) || !isAddressEqual(log.address, address) || !Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== topic) return []
    const decoded = decodeHistoryLog(raw, address, block, event)
    return decoded.args[field] === id ? [decoded] : []
  })
}
async function assertCanonical(client: PublicClient, block: Header): Promise<void> {
  const current = header(await client.getBlock({ blockNumber: block.number }), block.number)
  if (current.hash.toLowerCase() !== block.hash.toLowerCase()) throw new Error('The canonical INCOME creation history changed during discovery. Refresh and retry.')
}

/**
 * Generic revnets have no Homerun relationship and return null. Provider errors,
 * conflicting history, and invalid bindings fail visibly instead of hiding holder
 * operations. This discovery requires archive history; a caller that already
 * knows FUND can read the perpetual allocation directly without these old reads.
 */
export async function readIncomeFundBinding(client: PublicClient, input: {
  chainId: number; incomeProjectId: bigint
}): Promise<bigint | null> {
  if (!Number.isSafeInteger(input.chainId) || !Object.hasOwn(SUPPORTED_CHAINS, input.chainId)) throw new Error('A supported INCOME chain is required.')
  const incomeProjectId = uint(input.incomeProjectId, 'INCOME project ID', true)
  const chainId = input.chainId as JBChainId
  const deployer = registeredIncomeDeployer(chainId)
  if (!deployer) return null
  const projects = v6Address('JBProjects', chainId)
  const [actualChainId, observedBlock] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: 'latest' })])
  if (actualChainId !== chainId) throw new Error('The INCOME discovery RPC is connected to a different chain.')
  const observed = header(observedBlock)
  const [helperCode, projectsCode, latestCount] = await Promise.all([
    client.getCode({ address: deployer, blockNumber: observed.number }),
    client.getCode({ address: projects, blockNumber: observed.number }),
    client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'count', blockNumber: observed.number }),
  ])
  if (!helperCode || helperCode === '0x' || !projectsCode || projectsCode === '0x') throw new Error('The registered INCOME launcher or canonical project registry has no deployed code.')
  if (uint(latestCount, 'project count') < incomeProjectId) throw new Error('This INCOME project does not exist at the observed block.')

  // JBProjects IDs increase monotonically. Only the exact creation block needs
  // log queries; no indexer hint, guessed FUND ID, or full-history event scan.
  let low = 0n, high = observed.number
  while (low < high) {
    const middle = (low + high) / 2n
    const code = await client.getCode({ address: projects, blockNumber: middle })
    const count = !code || code === '0x' ? 0n : uint(await client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'count', blockNumber: middle }), 'historical project count')
    if (count >= incomeProjectId) high = middle
    else low = middle + 1n
  }
  const created = header(await client.getBlock({ blockNumber: low }), low)
  const [creationLogs, incomeLogs] = await Promise.all([
    client.getLogs({ address: projects, event: createEvent, args: { projectId: incomeProjectId }, fromBlock: created.number, toBlock: created.number, strict: true }),
    client.getLogs({ address: deployer, event: incomeEvent, args: { incomeProjectId }, fromBlock: created.number, toBlock: created.number, strict: true }),
  ])
  if (creationLogs.length !== 1) throw new Error('The canonical INCOME project creation event could not be verified.')
  const creation = decodeHistoryLog(creationLogs[0], projects, created, createEvent)
  if (creation.args.projectId !== incomeProjectId) throw new Error('The RPC returned creation history for a different INCOME project.')
  if (incomeLogs.length > 1) throw new Error('The RPC returned duplicate INCOME launch events.')
  const launch = incomeLogs.length ? decodeHistoryLog(incomeLogs[0], deployer, created, incomeEvent) : null
  if (launch && (launch.args.incomeProjectId !== incomeProjectId || launch.logIndex <= creation.logIndex || launch.transactionHash.toLowerCase() !== creation.transactionHash.toLowerCase())) throw new Error('The INCOME launch event does not belong to this project’s creation transaction.')
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: creation.transactionHash }),
    client.getTransactionReceipt({ hash: creation.transactionHash }),
  ])
  if (receipt.status !== 'success' || !validHash(receipt.transactionHash) || !validHash(receipt.blockHash) || !validHash(transaction.hash) || !validHash(transaction.blockHash) || receipt.transactionHash.toLowerCase() !== creation.transactionHash.toLowerCase() || receipt.blockNumber !== created.number || receipt.blockHash.toLowerCase() !== created.hash.toLowerCase() || transaction.hash.toLowerCase() !== creation.transactionHash.toLowerCase() || transaction.blockNumber !== created.number || !transaction.blockHash || transaction.blockHash.toLowerCase() !== created.hash.toLowerCase()) throw new Error('The INCOME creation transaction is not a canonical successful execution.')
  const recordedCreations = receiptEvents(receipt.logs, projects, created, createEvent, 'projectId', incomeProjectId)
  if (recordedCreations.length !== 1 || !sameLog(creation, recordedCreations[0])) throw new Error('The creation receipt does not corroborate the canonical INCOME creation event.')
  const recordedLaunches = receiptEvents(receipt.logs, deployer, created, incomeEvent, 'incomeProjectId', incomeProjectId)
  if (!launch) {
    if (recordedLaunches.length) throw new Error('The RPC omitted an INCOME deployment event from its indexed history.')
    await Promise.all([assertCanonical(client, created), assertCanonical(client, observed)])
    return null
  }
  if (recordedLaunches.length !== 1 || !sameLog(launch, recordedLaunches[0])) throw new Error('The creation receipt does not corroborate the exact Homerun INCOME launch.')
  const fundProjectId = uint(launch.args.fundProjectId, 'FUND project ID', true)
  const vault = launch.args.initialAllocationVault
  if (fundProjectId === incomeProjectId || !validAddress(vault) || !validAddress(launch.args.operator) || !validAddress(launch.args.fundToken) || !validAddress(launch.args.rewardToken) || typeof launch.args.merkleRoot !== 'string' || !/^0x[\da-fA-F]{64}$/.test(launch.args.merkleRoot)) throw new Error('The Homerun INCOME launch contains invalid project or vault identities.')
  const allocation = await readInitialIncomeAllocation(client, { chainId, incomeProjectId, fundProjectId })
  if (!allocation || allocation.chainId !== chainId || allocation.fundProjectId !== fundProjectId || allocation.incomeProjectId !== incomeProjectId || allocation.blockNumber < created.number || !isAddressEqual(allocation.deployer, deployer) || !isAddressEqual(allocation.vault, vault) || allocation.merkleRoot.toLowerCase() !== launch.args.merkleRoot.toLowerCase()) throw new Error('The discovered FUND does not match the verified INCOME project and initial-allocation vault.')
  await Promise.all([assertCanonical(client, created), assertCanonical(client, observed)])
  return fundProjectId
}
