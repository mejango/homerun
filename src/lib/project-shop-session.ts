/** Recovery facts block duplicate writes; only fresh, exact on-chain executions advance a shop update. */
import { encodeFunctionData, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import { FUND_CHAIN_IDS } from './fund-contracts'
import { parseProjectShopWrite, projectShopWriteRequest, serializeProjectShopWrite, type PreparedProjectShopWrite } from './project-shop-write'
import { verifyStickyExecution, type StickyPending } from './sticky-session'
import { writeIntentKey, type ReviewedWriteRecoveryInput } from '@bananapus/nana-sdk-core/review'
import { callOf, holds, type LegacyWriteEvidence } from './write-hold'

export type ShopWriteStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type ShopWriteSubmission = { afterBlock: string; safe: boolean; startedAt: number; hash?: Hex; attemptId?: string }
export type ShopWriteSession = {
  version: 1
  id: string
  plan: PreparedProjectShopWrite
  completed: Array<{ submission: ShopWriteSubmission; executionHash: Hex }>
  pending?: ShopWriteSubmission
  /** Abandon unsubmitted shop creation and restore the confirmed temporary grant. */
  restoring?: true
}
export type ShopWriteRejection = 'wallet-rejected' | 'before-write-aborted'

const PREFIX = 'homerun:shop:write:v1:'
const HASH = /^0x[\da-f]{64}$/i
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const UINT = /^(?:0|[1-9]\d{0,77})$/
const MAX_RECORD_LENGTH = 7 * 1024 * 1024

function invalid(): Error { return new Error('Shop recovery data is invalid or belongs to another project. Restore the original record before submitting another update.') }
function hash(value: unknown): value is Hex { return typeof value === 'string' && HASH.test(value) && value.toLowerCase() !== zeroHash }
function uint(value: unknown): value is string { return typeof value === 'string' && UINT.test(value) && BigInt(value) < 1n << 256n }
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key))
}

/** The project scope deliberately covers every account and every browser tab. */
export function shopWriteSessionKey(chainId: number, projectId: bigint): string {
  if (!FUND_CHAIN_IDS.some(id => id === chainId) || typeof projectId !== 'bigint' || projectId <= 0n || projectId >= 1n << 64n) throw invalid()
  return `${PREFIX}${chainId}:${projectId}`
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !key.startsWith(PREFIX)) throw invalid()
  const [chainId, projectId, ...extra] = key.slice(PREFIX.length).split(':')
  if (extra.length || !uint(projectId) || !UINT.test(chainId ?? '') || shopWriteSessionKey(Number(chainId), BigInt(projectId)) !== key) throw invalid()
}

function submission(value: unknown, minimumBlock: bigint): ShopWriteSubmission {
  if (!object(value, ['afterBlock', 'safe', 'startedAt', 'hash', 'attemptId']) || !uint(value.afterBlock)
    || BigInt(value.afterBlock) < minimumBlock || typeof value.safe !== 'boolean'
    || !Number.isSafeInteger(value.startedAt) || (value.startedAt as number) <= 0
    || (value.attemptId !== undefined && (typeof value.attemptId !== 'string' || !UUID.test(value.attemptId)))
    || (value.hash !== undefined && !hash(value.hash))) throw invalid()
  return { afterBlock: value.afterBlock, safe: value.safe, startedAt: value.startedAt as number,
    ...(value.attemptId === undefined ? {} : { attemptId: value.attemptId as string }),
    ...(value.hash === undefined ? {} : { hash: (value.hash as Hex).toLowerCase() as Hex }) }
}

function parse(raw: string, key: string): ShopWriteSession {
  validateKey(key)
  if (typeof raw !== 'string' || raw.length > MAX_RECORD_LENGTH) throw invalid()
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Shop recovery data is unreadable. Restore the original record before submitting another update.') }
  if (!object(value, ['version', 'id', 'plan', 'completed', 'pending', 'restoring']) || value.version !== 1
    || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.plan !== 'string'
    || !Array.isArray(value.completed) || (value.restoring !== undefined && value.restoring !== true)) throw invalid()
  const plan = parseProjectShopWrite(value.plan)
  if (!plan || key !== shopWriteSessionKey(plan.snapshot.chainId, plan.snapshot.projectId)
    || typeof plan.snapshot.blockNumber !== 'bigint' || plan.snapshot.blockNumber < 0n
    || plan.snapshot.blockNumber >= 1n << 256n) throw invalid()
  if (value.restoring && (plan.requestKinds.join(',') !== 'grant,create,restore' || value.completed.length < 1)) throw invalid()
  const stepCount = value.restoring ? 2 : plan.requests.length
  if (value.completed.length > stepCount) throw invalid()
  let minimumBlock = plan.snapshot.blockNumber
  const hashes = new Set<string>()
  const completed = value.completed.map(entry => {
    if (!object(entry, ['submission', 'executionHash']) || !hash(entry.executionHash)) throw invalid()
    const saved = submission(entry.submission, minimumBlock)
    const executionHash = entry.executionHash.toLowerCase() as Hex
    if ((!saved.safe && saved.hash && saved.hash !== executionHash) || hashes.has(executionHash)) throw invalid()
    hashes.add(executionHash)
    minimumBlock = BigInt(saved.afterBlock)
    return { submission: saved, executionHash }
  })
  const pending = value.pending === undefined ? undefined : submission(value.pending, minimumBlock)
  if (pending && (completed.length === stepCount || pending.hash && !pending.safe && hashes.has(pending.hash))) throw invalid()
  return { version: 1, id: value.id.toLowerCase(), plan, completed, ...(pending ? { pending } : {}), ...(value.restoring ? { restoring: true as const } : {}) }
}

/** Only serializable plan facts are persisted: never a caller-provided ABI, target or executable request. */
function encode(session: ShopWriteSession): string {
  return JSON.stringify({ version: session.version, id: session.id, plan: serializeProjectShopWrite(session.plan),
    completed: session.completed, ...(session.pending ? { pending: session.pending } : {}), ...(session.restoring ? { restoring: true } : {}) })
}

function validated(session: ShopWriteSession, key = shopWriteSessionKey(session.plan.snapshot.chainId, session.plan.snapshot.projectId)): ShopWriteSession {
  return parse(encode(session), key)
}

export function readShopWriteSession(storage: ShopWriteStorage, key: string): ShopWriteSession | null {
  validateKey(key)
  const raw = storage.getItem(key)
  return raw === null ? null : parse(raw, key)
}

function matchingCurrent(storage: ShopWriteStorage, key: string, session: ShopWriteSession): ShopWriteSession {
  const expected = validated(session, key)
  const current = readShopWriteSession(storage, key)
  if (!current || encode(current) !== encode(expected)) throw new Error('Shop recovery changed in another tab. Reload the saved update before changing its progress.')
  return current
}

function persist(storage: ShopWriteStorage, key: string, session: ShopWriteSession): ShopWriteSession {
  const next = validated(session, key)
  const raw = encode(next)
  storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('The browser could not save shop recovery data. Do not submit until the saved record is restored.')
  return next
}

/** Call while holding withShopWriteLock; an existing record must be resolved, regardless of its account. */
export function startShopWriteSession(storage: ShopWriteStorage, key: string, plan: PreparedProjectShopWrite): ShopWriteSession {
  if (readShopWriteSession(storage, key)) throw new Error('Another shop update is already saved for this project. Resume or resolve it before starting another.')
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Secure browser shop recovery is unavailable. Use a supported secure browser.')
  return persist(storage, key, { version: 1, id: globalThis.crypto.randomUUID(), plan, completed: [] })
}

/** Canonical plan indices are preserved even when cleanup skips an unsubmitted creation step. */
export function shopWriteRequestIndices(session: ShopWriteSession): readonly number[] {
  return session.restoring ? [0, 2] : session.plan.requests.map((_request, index) => index)
}

export function shopWriteRequestIndex(session: ShopWriteSession): number | null {
  return shopWriteRequestIndices(session)[session.completed.length] ?? null
}

/** Cleanup changes the next reviewed call, never claims the skipped creation was executed. */
export function restoreShopWritePermissions(storage: ShopWriteStorage, key: string, session: ShopWriteSession): ShopWriteSession {
  const current = matchingCurrent(storage, key, session)
  if (shopHeldWrite(current)) throw new Error(SHOP_HELD_LINE)
  if (current.restoring || current.pending || current.completed.length !== 1 || current.plan.requestKinds.join(',') !== 'grant,create,restore') {
    throw new Error('Verify any pending shop creation before switching to permission restoration.')
  }
  return persist(storage, key, { ...current, restoring: true })
}

function stickyRecord(session: ShopWriteSession, step: number, saved: ShopWriteSubmission): StickyPending {
  const request = projectShopWriteRequest(session.plan, step)
  return { version: 1, chainId: request.chainId, projectId: session.plan.snapshot.projectId.toString(), holder: session.plan.snapshot.account,
    target: request.address, data: encodeFunctionData(request), value: (request.value ?? 0n).toString(), label: request.label ?? 'Update shop',
    safe: saved.safe, afterBlock: saved.afterBlock, submittedAt: saved.startedAt, ...(saved.hash ? { hash: saved.hash } : {}) }
}

async function verify(client: PublicClient, session: ShopWriteSession, step: number, saved: ShopWriteSubmission, executionHash: Hex): Promise<{ status: 'confirmed' | 'reverted'; blockNumber: bigint }> {
  if (!hash(executionHash)) throw new Error('Use a valid shop execution transaction hash.')
  if (!saved.safe && saved.hash && saved.hash !== executionHash.toLowerCase()) throw new Error('Use the saved shop transaction hash. A different transaction cannot resolve this submission.')
  try {
    const receipt = await client.getTransactionReceipt({ hash: executionHash })
    const pinned = { ...client, getTransactionReceipt: async () => receipt } as PublicClient
    const status = await verifyStickyExecution(pinned, stickyRecord(session, step, saved), executionHash)
    return { status, blockNumber: receipt.blockNumber }
  }
  catch (error) { throw new Error(error instanceof Error ? error.message.replaceAll('Sticky', 'shop') : 'The shop execution could not be verified. Keep the saved update and try again.') }
}

/** Recheck every prior exact call and canonical receipt; a saved completion flag is never sufficient. */
export async function verifyShopWriteProgress(client: PublicClient, session: ShopWriteSession): Promise<bigint> {
  const current = validated(session)
  let minimumBlock = 0n
  const indices = shopWriteRequestIndices(current)
  for (const [step, completed] of current.completed.entries()) {
    if (BigInt(completed.submission.afterBlock) < minimumBlock) throw new Error('The saved shop transaction order does not match its confirmed prerequisites.')
    const execution = await verify(client, current, indices[step], completed.submission, completed.executionHash)
    if (execution.status !== 'confirmed') throw new Error('A previously completed shop transaction reverted. Keep this record and resolve its remaining permissions before continuing.')
    minimumBlock = execution.blockNumber
  }
  return minimumBlock
}

/**
 * The step the SDK's write hold settled: its exact execution is verified against the plan and its
 * confirmed prerequisites, then recorded as completed. A revert records nothing, so the step can be
 * reviewed again. `submission` is what was sent: the Safe flag, its returned hash, and the block its
 * prerequisites were confirmed at.
 */
export async function confirmShopWriteStep(client: PublicClient, storage: ShopWriteStorage, key: string, session: ShopWriteSession, submission: Pick<ShopWriteSubmission, 'safe' | 'hash'> & { afterBlock: bigint }, executionHash: Hex): Promise<{ session: ShopWriteSession; status: 'confirmed' | 'reverted' }> {
  const current = matchingCurrent(storage, key, session)
  const index = shopWriteRequestIndex(current)
  if (index === null) throw new Error('This shop update has already completed.')
  const minimumBlock = await verifyShopWriteProgress(client, current)
  const afterBlock = submission.afterBlock > minimumBlock ? submission.afterBlock : minimumBlock
  const saved: ShopWriteSubmission = { safe: submission.safe, afterBlock: afterBlock.toString(), startedAt: Date.now(), ...(submission.hash ? { hash: submission.hash.toLowerCase() as Hex } : {}) }
  const { status } = await verify(client, current, index, saved, executionHash)
  matchingCurrent(storage, key, session)
  // A step the journal saved as pending before SDK holds is settled with it.
  const { pending: _pending, ...rest } = current
  void _pending
  return { status, session: persist(storage, key, status === 'confirmed' ? { ...rest, completed: [...rest.completed, { submission: saved, executionHash: executionHash.toLowerCase() as Hex }] } : rest) }
}

/** A step's hold: the update this session plans and the step. TODO(SDK 2.38): the SDK's shared builder. */
export const SHOP_HELD_LINE = 'Finish or exit the pending update first.'

/** Whether the SDK holds a write of any of this update's steps (from storage, either wallet kind). */
export function shopHeldWrite(session: ShopWriteSession): boolean {
  const placeholder = { to: '0x0000000000000000000000000000000000000000' as Address, data: '0x' as Hex }
  return session.plan.requests.some((_, step) => [false, true].some(safe => holds.open({
    chainId: session.plan.snapshot.chainId, account: session.plan.snapshot.account, safe, namespace: shopStepIntent(session, step), call: placeholder,
  }).peek().status !== 'clear'))
}

export function shopStepIntent(session: ShopWriteSession, step: number): string {
  return writeIntentKey('shop-step', { project: session.plan.snapshot.projectId, update: session.id, step })
}

/**
 * The hold a step the journal saved as pending before SDK holds is adopted into, with what it saved
 * (its hash or Safe proposal, and when it was sent), or null when nothing is pending.
 */
export function shopPendingHold(session: ShopWriteSession): { input: ReviewedWriteRecoveryInput; evidence: LegacyWriteEvidence; step: number } | null {
  const pending = session.pending
  const step = shopWriteRequestIndex(session)
  if (!pending || step === null) return null
  const request = projectShopWriteRequest(session.plan, step)
  return {
    step,
    input: { chainId: request.chainId, account: session.plan.snapshot.account, safe: pending.safe, namespace: shopStepIntent(session, step), call: callOf(request) },
    evidence: { submittedAt: pending.startedAt, ...(pending.hash ? pending.safe ? { safe: { safeTxHash: pending.hash } } : { hash: pending.hash } : {}) },
  }
}

/** Drop a pending step the SDK's hold now holds: the session keeps only its plan and completed steps. */
export function dropShopWritePending(storage: ShopWriteStorage, key: string, session: ShopWriteSession): ShopWriteSession {
  const current = matchingCurrent(storage, key, session)
  const { pending: _pending, ...next } = current
  void _pending
  return persist(storage, key, next)
}

/** Partial progress must survive until permission restoration completes. Finished records require fresh proof. */
export async function clearShopWriteSession(storage: ShopWriteStorage, key: string, session: ShopWriteSession, client?: PublicClient): Promise<void> {
  const current = matchingCurrent(storage, key, session)
  // A held step keeps its update, and its exit, until it settles or the user takes that exit.
  if (shopHeldWrite(current)) throw new Error(SHOP_HELD_LINE)
  if (current.completed.length) {
    if (shopWriteRequestIndex(current) !== null) throw new Error('This shop update still has unfinished steps. Complete them, including restoring deployer permissions, before clearing it.')
    if (!client) throw new Error('Verify every completed shop execution before clearing this update.')
    await verifyShopWriteProgress(client, current)
    matchingCurrent(storage, key, session)
  }
  storage.removeItem(key)
  if (storage.getItem(key) !== null) throw new Error('The browser could not clear the resolved shop update.')
}

/** Hold across review, simulation and wallet submission; unknown submissions remain durable after release. */
export async function withShopWriteLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  validateKey(key)
  if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') throw new Error('This browser cannot safely coordinate shop updates across tabs. Use a browser with Web Locks support.')
  return navigator.locks.request(key, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('This project’s shop is being reviewed or submitted in another tab.')
    return task()
  })
}
