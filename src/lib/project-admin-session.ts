/** Pending facts prevent duplicate administrative writes; they are never executable requests. */
import { encodeFunctionData, isAddress, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'
import { displayChainSlug } from './chainDisplay'
import { verifyStickyExecution, type StickyPending } from './sticky-session'

export type ProjectAdminStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type ProjectAdminPending = StickyPending & { id: string }
const PREFIX = 'homerun:project-admin:pending:v1:'
const HASH = /^0x[\da-f]{64}$/i
const UINT = /^(?:0|[1-9]\d{0,77})$/
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const MAX_RECORD_LENGTH = 2 * 1024 * 1024
const KEYS = ['version', 'id', 'chainId', 'projectId', 'holder', 'target', 'data', 'value', 'label', 'safe', 'submittedAt', 'afterBlock', 'hash']
function invalid() { return new Error('Project update recovery data is invalid. Restore the original transaction record before sending another update.') }
function hash(value: unknown): value is Hex { return typeof value === 'string' && HASH.test(value) && value.toLowerCase() !== zeroHash }
function uint(value: unknown): value is string { return typeof value === 'string' && UINT.test(value) && BigInt(value) < 1n << 256n }
function address(value: unknown): value is Address { return typeof value === 'string' && isAddress(value, { strict: false }) && value.toLowerCase() !== zeroAddress }

/** Deliberately shared by metadata, ownership, permissions and split editors, across accounts and tabs. */
export function projectAdminSessionKey(chainId: number, projectId: bigint): string {
  if (!Number.isSafeInteger(chainId) || !displayChainSlug(chainId) || typeof projectId !== 'bigint' || projectId <= 0n || projectId >= 1n << 64n) throw invalid()
  return `${PREFIX}${chainId}:${projectId}`
}
function validateKey(key: string) {
  if (!key.startsWith(PREFIX)) throw invalid()
  const [chainId, projectId, ...extra] = key.slice(PREFIX.length).split(':')
  if (extra.length || !uint(projectId) || !UINT.test(chainId ?? '') || projectAdminSessionKey(Number(chainId), BigInt(projectId)) !== key) throw invalid()
}
function parse(raw: string, key: string): ProjectAdminPending {
  validateKey(key)
  if (raw.length > MAX_RECORD_LENGTH) throw invalid()
  let value: Record<string, unknown>
  try { value = JSON.parse(raw) } catch { throw new Error('Project update recovery data is unreadable. Restore the original record before sending another update.') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => !KEYS.includes(name))
    || value.version !== 1 || typeof value.id !== 'string' || !UUID.test(value.id)
    || !Number.isSafeInteger(value.chainId) || !uint(value.projectId)
    || !address(value.holder) || !address(value.target)
    || typeof value.data !== 'string' || !/^0x(?:[\da-f]{2}){4,}$/i.test(value.data)
    || !uint(value.value) || !uint(value.afterBlock) || typeof value.safe !== 'boolean'
    || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 256 || /[\x00-\x1f\x7f]/.test(value.label)
    || !Number.isSafeInteger(value.submittedAt) || (value.submittedAt as number) <= 0
    || (value.hash !== undefined && !hash(value.hash))
    || projectAdminSessionKey(value.chainId as number, BigInt(value.projectId)) !== key) throw invalid()
  return { version: 1, id: value.id.toLowerCase(), chainId: value.chainId as number, projectId: value.projectId,
    holder: value.holder.toLowerCase() as Address, target: value.target.toLowerCase() as Address,
    data: value.data.toLowerCase() as Hex, value: value.value, label: value.label, safe: value.safe,
    submittedAt: value.submittedAt as number, afterBlock: value.afterBlock,
    ...(value.hash === undefined ? {} : { hash: (value.hash as Hex).toLowerCase() as Hex }) }
}
function encode(record: ProjectAdminPending) { return JSON.stringify(record) }
export function readProjectAdminPending(storage: ProjectAdminStorage, key: string): ProjectAdminPending | null {
  validateKey(key)
  const raw = storage.getItem(key)
  return raw === null ? null : parse(raw, key)
}
function matching(storage: ProjectAdminStorage, key: string, expected: ProjectAdminPending): ProjectAdminPending {
  const current = readProjectAdminPending(storage, key)
  if (!current || encode(current) !== encode(parse(encode(expected), key))) throw new Error('The project update changed in another tab. Reload its saved progress before continuing.')
  return current
}
function persist(storage: ProjectAdminStorage, key: string, record: ProjectAdminPending): ProjectAdminPending {
  const next = parse(encode(record), key)
  const raw = encode(next)
  storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('This browser could not save project update recovery. Do not submit until browser storage is available.')
  return next
}
function clear(storage: ProjectAdminStorage, key: string, record: ProjectAdminPending): void {
  matching(storage, key, record)
  storage.removeItem(key)
  if (storage.getItem(key) !== null) throw new Error('This browser could not clear the resolved project update.')
}

/** Call only immediately before a reviewed, simulated write, while holding the project lock. */
export function beginProjectAdminSubmission(storage: ProjectAdminStorage, key: string, options: {
  request: TxRequest; projectId: bigint; account: Address; safe: boolean; afterBlock: bigint
}): ProjectAdminPending {
  if (readProjectAdminPending(storage, key)) throw new Error('A project update may already be pending. Verify its execution before submitting another update.')
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Secure project update recovery is unavailable in this browser.')
  const { request, projectId, account, safe, afterBlock } = options
  return persist(storage, key, {
    version: 1, id: globalThis.crypto.randomUUID(), chainId: request.chainId, projectId: projectId.toString(),
    holder: account, target: request.address, data: encodeFunctionData(request), value: (request.value ?? 0n).toString(),
    label: request.label ?? 'Update project', safe, submittedAt: Date.now(), afterBlock: afterBlock.toString(),
  })
}
export function recordProjectAdminHash(storage: ProjectAdminStorage, key: string, record: ProjectAdminPending, transactionHash: Hex): ProjectAdminPending {
  if (!hash(transactionHash)) throw new Error('Use a valid transaction or Safe proposal hash.')
  const current = matching(storage, key, record)
  if (current.hash && current.hash !== transactionHash.toLowerCase()) throw new Error('A different project update hash is already saved. Verify that execution first.')
  return persist(storage, key, { ...current, hash: transactionHash.toLowerCase() as Hex })
}
/** Only typed wallet rejection or the final account gate can discard an unknown submission. */
export function rejectProjectAdminSubmission(storage: ProjectAdminStorage, key: string, record: ProjectAdminPending, reason: 'wallet-rejected' | 'before-write-aborted'): void {
  if (reason !== 'wallet-rejected' && reason !== 'before-write-aborted') throw new Error('An uncertain project update must remain saved until its execution is verified.')
  const current = matching(storage, key, record)
  if (current.hash) throw new Error('A submitted project update cannot be discarded as a wallet rejection.')
  clear(storage, key, current)
}
/** A matching canonical execution is the only way to release a submitted or uncertain record. */
export async function confirmProjectAdminExecution(client: PublicClient, storage: ProjectAdminStorage, key: string, record: ProjectAdminPending, executionHash: Hex): Promise<{ status: 'confirmed' | 'reverted'; blockNumber: bigint }> {
  const current = matching(storage, key, record)
  if (!hash(executionHash)) throw new Error('Use a valid execution transaction hash.')
  if (!current.safe && current.hash && current.hash !== executionHash.toLowerCase()) throw new Error('Use the saved project update transaction hash.')
  try {
    const receipt = await client.getTransactionReceipt({ hash: executionHash })
    if (current.safe && receipt.status !== 'success') throw new Error('The outer Safe transaction reverted before resolving its proposal. Keep this update pending and check Safe for its eventual execution.')
    const pinned = { ...client, getTransactionReceipt: async () => receipt } as PublicClient
    const status = await verifyStickyExecution(pinned, current, executionHash)
    clear(storage, key, current)
    return { status, blockNumber: receipt.blockNumber }
  } catch (error) { throw new Error(error instanceof Error ? error.message.replaceAll('Sticky', 'project update') : 'The project update execution could not be verified.') }
}
/** The lock covers review through hash persistence; a pending record survives after it is released. */
export async function withProjectAdminLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  validateKey(key)
  if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') throw new Error('This browser cannot coordinate project updates across tabs. Use a browser with Web Locks support.')
  return navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('This project has an update being reviewed or submitted in another tab.')
    return task()
  })
}
