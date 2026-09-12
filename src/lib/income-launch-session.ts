/** INCOME launch recovery is duplicate protection, never evidence of execution. */
import { MappableAsset, parseSuckerDeployerConfig, type JBChainId } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, isAddressEqual, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { FUND_CHAIN_IDS, type FundTransaction } from './fund-contracts'
import { homerunIncomeRecoveryAbi, INITIAL_INCOME_SUPPLY, INCOME_QUARTER_SECONDS, registeredIncomeDeployer } from './income-contracts'
import { verifyStickyExecution, type StickyPending, type StickyStorage } from './sticky-session'

export type IncomeLaunchPending = StickyPending & {
  kind: 'income-launch'
  /** Independent of time and wallet ownership, so stale tabs cannot resolve a later submission. */
  sessionId: string
  phase: 'unknown' | 'pending'
}
export type IncomeLaunchStorage = StickyStorage

const PREFIX = 'homerun:income-launch:pending:v1:'
const UINT = /^(?:0|[1-9]\d*)$/
const HASH = /^0x[\da-fA-F]{64}$/
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const UINT256_LIMIT = 1n << 256n
const MAX_RECORD_LENGTH = 32_768
const FIELDS = ['version', 'kind', 'sessionId', 'phase', 'chainId', 'projectId', 'holder', 'target', 'data', 'value', 'label', 'safe', 'submittedAt', 'afterBlock', 'hash']
const invalid = () => new Error('The INCOME launch recovery record is invalid or belongs to another project. Restore its original record before submitting another launch.')

function uint(value: unknown, positive = false): value is string {
  return typeof value === 'string' && value.length <= 78 && UINT.test(value) && BigInt(value) < UINT256_LIMIT && (!positive || BigInt(value) > 0n)
}
function positive(value: bigint): boolean { return value > 0n && value < UINT256_LIMIT }
function nonzeroHash(value: unknown): value is Hex { return typeof value === 'string' && HASH.test(value) && value.toLowerCase() !== zeroHash }
function validAddress(value: unknown): value is Address { return typeof value === 'string' && isAddress(value) && !isAddressEqual(value, zeroAddress) }
function ipfs(value: string): boolean { return value.length <= 2_048 && /^ipfs:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(value) }

export function incomeLaunchSessionKey(chainId: number, projectId: bigint): string {
  if (!FUND_CHAIN_IDS.some(id => id === chainId) || typeof projectId !== 'bigint' || !positive(projectId)) throw invalid()
  return `${PREFIX}${chainId}:${projectId}`
}

function validateKey(key: string): void {
  if (!key.startsWith(PREFIX)) throw invalid()
  const [chainId, projectId, ...extra] = key.slice(PREFIX.length).split(':')
  if (extra.length || !uint(projectId, true) || !UINT.test(chainId ?? '') || incomeLaunchSessionKey(Number(chainId), BigInt(projectId)) !== key) throw invalid()
}

/** Decode and re-encode the complete canonical call, rejecting selectors, trailing data and foreign targets. */
function validateCall(record: IncomeLaunchPending): void {
  const registered = registeredIncomeDeployer(record.chainId as JBChainId)
  if (!registered || !isAddressEqual(registered, record.target)) throw new Error('The saved INCOME launcher is not the currently registered deployment. Keep the record and verify its execution before another launch.')
  try {
    const decoded = decodeFunctionData({ abi: homerunIncomeRecoveryAbi, data: record.data })
    if (decoded.functionName !== 'deployIncome') throw invalid()
    const [fundProjectId, snapshot, description, operatorBps, fundHoldersBps, stickyProjectId, startsAtOrAfter, , operator] = decoded.args
    const local = snapshot.allocations.find(entry => entry.chainId === record.chainId)
    let previousChain = 0
    let totalIncome = 0n
    let totalLeaves = 0n
    for (const entry of snapshot.allocations) {
      if (!FUND_CHAIN_IDS.some(id => id === entry.chainId) || entry.chainId <= previousChain
        || !positive(entry.fundProjectId) || !positive(entry.snapshotBlockNumber) || !nonzeroHash(entry.snapshotBlockHash)
        || entry.leafCount > 1n << 160n || (entry.leafCount === 0n) !== (entry.merkleRoot === zeroHash)
        || (entry.leafCount === 0n && entry.incomeAmount !== 0n)) throw invalid()
      previousChain = entry.chainId
      totalIncome += entry.incomeAmount
      totalLeaves += entry.leafCount
    }
    const isMainnet = (chainId: number) => [1, 10, 8453, 42161].includes(chainId)
    if (fundProjectId !== BigInt(record.projectId)
      || !local || local.fundProjectId !== fundProjectId || local.snapshotBlockNumber > BigInt(record.afterBlock)
      || !nonzeroHash(snapshot.sourceSetHash) || !positive(snapshot.totalFundSupply)
      || totalIncome !== INITIAL_INCOME_SUPPLY || !positive(totalLeaves)
      || snapshot.allocations.some(entry => isMainnet(entry.chainId) !== isMainnet(record.chainId))
      || !nonzeroHash(snapshot.manifestHash) || !ipfs(snapshot.manifestUri)
      || !description.name.trim() || description.name.length > 160 || description.ticker !== 'INCOME'
      || !ipfs(description.uri) || !nonzeroHash(description.salt)
      || fundHoldersBps <= 0 || operatorBps + fundHoldersBps > 10_000
      || (operator !== undefined && !validAddress(operator))
      || !positive(stickyProjectId) || stickyProjectId === fundProjectId
      || startsAtOrAfter <= 0 || startsAtOrAfter + INCOME_QUARTER_SECONDS * 8 >= 2 ** 48
      || encodeFunctionData({ abi: homerunIncomeRecoveryAbi, functionName: 'deployIncome', args: decoded.args }).toLowerCase() !== record.data.toLowerCase()) throw invalid()
    // Recovery accepts only the reviewed stock USDC/CCIP topology. Imported JSON cannot replace peers or tokens.
    const sdkSuckers = parseSuckerDeployerConfig(record.chainId as JBChainId, snapshot.allocations.map(entry => entry.chainId as JBChainId), [MappableAsset.USDC], { version: 6, bridge: 'ccip', salt: description.salt })
    const suckers = { ...sdkSuckers, deployerConfigurations: sdkSuckers.deployerConfigurations.map(entry => {
      if (!('peer' in entry)) throw invalid()
      return { ...entry, peer: entry.peer }
    }) }
    const canonicalArgs = [fundProjectId, snapshot, description, operatorBps, fundHoldersBps, stickyProjectId, startsAtOrAfter, suckers] as const
    if (encodeFunctionData({ abi: homerunIncomeRecoveryAbi, functionName: 'deployIncome', args: operator === undefined ? canonicalArgs : [...canonicalArgs, operator] }).toLowerCase() !== record.data.toLowerCase()) throw invalid()
  } catch { throw invalid() }
}

function parseRecord(raw: string, key: string): IncomeLaunchPending {
  validateKey(key)
  if (typeof raw !== 'string' || raw.length > MAX_RECORD_LENGTH) throw invalid()
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('INCOME launch recovery data is unreadable. Restore the saved transaction record before submitting another launch.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid()
  const value = parsed as IncomeLaunchPending
  if (Object.keys(value).some(field => !FIELDS.includes(field))
    || value.version !== 1 || value.kind !== 'income-launch'
    || typeof value.sessionId !== 'string' || !UUID.test(value.sessionId)
    || !['unknown', 'pending'].includes(value.phase)
    || !Number.isSafeInteger(value.chainId) || !uint(value.projectId, true)
    || !validAddress(value.holder) || !validAddress(value.target)
    || typeof value.data !== 'string' || !/^0x(?:[\da-fA-F]{2})+$/.test(value.data)
    || !uint(value.value) || !uint(value.afterBlock) || value.label !== 'Deploy INCOME'
    || typeof value.safe !== 'boolean' || !Number.isSafeInteger(value.submittedAt) || value.submittedAt <= 0
    || (value.phase === 'unknown' ? value.hash !== undefined : !nonzeroHash(value.hash))
    || key !== incomeLaunchSessionKey(value.chainId, BigInt(value.projectId))) throw invalid()
  validateCall(value)
  // Stable serialization supports exact-record compare-and-set even when imports reordered JSON fields.
  return {
    version: 1, kind: 'income-launch', sessionId: value.sessionId, phase: value.phase,
    chainId: value.chainId, projectId: value.projectId, holder: getAddress(value.holder),
    target: getAddress(value.target), data: value.data.toLowerCase() as Hex, value: value.value,
    label: 'Deploy INCOME', safe: value.safe, submittedAt: value.submittedAt, afterBlock: value.afterBlock,
    ...(value.hash === undefined ? {} : { hash: value.hash.toLowerCase() as Hex }),
  }
}

export function readIncomeLaunchPending(storage: IncomeLaunchStorage, key: string): IncomeLaunchPending | null {
  validateKey(key)
  const saved = storage.getItem(key)
  return saved === null ? null : parseRecord(saved, key)
}

function persist(storage: IncomeLaunchStorage, key: string, record: IncomeLaunchPending): IncomeLaunchPending {
  const validated = parseRecord(JSON.stringify(record), key)
  const encoded = JSON.stringify(validated)
  storage.setItem(key, encoded)
  if (storage.getItem(key) !== encoded) throw new Error('The browser could not save INCOME launch recovery data. Do not submit another launch until the saved record is restored.')
  return validated
}

/** Call from beforeWrite, while holding withIncomeLaunchLock across review and wallet submission. */
export function beginIncomeLaunchSubmission(storage: IncomeLaunchStorage, key: string, request: FundTransaction, projectId: bigint, holder: Address, safe: boolean, afterBlock: bigint): IncomeLaunchPending {
  if (readIncomeLaunchPending(storage, key)) throw new Error('An INCOME launch may already be pending for this FUND. Verify its execution before submitting another.')
  if (typeof afterBlock !== 'bigint' || afterBlock < 0n || afterBlock >= UINT256_LIMIT || typeof request.value !== 'undefined' && typeof request.value !== 'bigint') throw invalid()
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Secure browser transaction recovery is unavailable. Use a supported secure browser before launching INCOME.')
  const record: IncomeLaunchPending = {
    version: 1, kind: 'income-launch', sessionId: globalThis.crypto.randomUUID(), phase: 'unknown',
    chainId: request.chainId, projectId: projectId.toString(), holder, target: request.address,
    data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }),
    value: (request.value ?? 0n).toString(), label: 'Deploy INCOME', safe, submittedAt: Date.now(), afterBlock: afterBlock.toString(),
  }
  return persist(storage, key, record)
}

function matchingCurrent(storage: IncomeLaunchStorage, key: string, record: IncomeLaunchPending): IncomeLaunchPending {
  const expected = parseRecord(JSON.stringify(record), key)
  const current = readIncomeLaunchPending(storage, key)
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('INCOME launch recovery changed in another tab. Reload the pending record before changing its progress.')
  return current
}

export function recordIncomeLaunchHash(storage: IncomeLaunchStorage, key: string, record: IncomeLaunchPending, hash: Hex): IncomeLaunchPending {
  if (!nonzeroHash(hash)) throw new Error('Invalid INCOME transaction or Safe proposal hash.')
  const current = matchingCurrent(storage, key, record)
  if (current.hash && current.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('A different INCOME transaction is already pending. Verify that execution before recording another hash.')
  return persist(storage, key, { ...current, phase: 'pending', hash })
}

/** Only after an explicit wallet rejection or an exact confirmed/reverted execution; never after timeout or an RPC error. */
export function clearIncomeLaunchPending(storage: IncomeLaunchStorage, key: string, record: IncomeLaunchPending): void {
  matchingCurrent(storage, key, record)
  storage.removeItem(key)
  if (storage.getItem(key) !== null) throw new Error('The browser could not clear the resolved INCOME launch record.')
}

export function exportIncomeLaunchPending(record: IncomeLaunchPending): string {
  return JSON.stringify(parseRecord(JSON.stringify(record), incomeLaunchSessionKey(record.chainId, BigInt(record.projectId))), null, 2)
}

/** Imported data can only restore a pending attempt. It never establishes successful deployment. */
export function importIncomeLaunchPending(storage: IncomeLaunchStorage, key: string, raw: string): IncomeLaunchPending {
  const record = parseRecord(raw, key)
  const existing = readIncomeLaunchPending(storage, key)
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Another INCOME launch record is already saved. Verify that attempt before importing a different record.')
  return persist(storage, key, record)
}

/** Use the same exact EOA/Safe payload and canonical receipt verification as the native Sticky flow. */
export async function verifyIncomeLaunchExecution(client: PublicClient, record: IncomeLaunchPending, hash: Hex): Promise<'confirmed' | 'reverted'> {
  const validated = parseRecord(JSON.stringify(record), incomeLaunchSessionKey(record.chainId, BigInt(record.projectId)))
  if (!validated.safe && validated.hash && validated.hash.toLowerCase() !== hash.toLowerCase()) throw new Error('Use the saved INCOME transaction hash. Another transaction cannot resolve this pending submission.')
  return verifyStickyExecution(client, validated, hash)
}

/** Hold this lock for the entire review and write, including beforeWrite persistence. No timeout releases uncertain attempts. */
export async function withIncomeLaunchLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  validateKey(key)
  if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') throw new Error('This browser cannot safely coordinate INCOME launches across tabs. Use a browser with Web Locks support.')
  return navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('This FUND’s INCOME launch is being reviewed or submitted in another tab.')
    return task()
  })
}
