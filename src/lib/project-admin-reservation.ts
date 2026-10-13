import { provenDropped } from './write-hold'
import { lookAtSafeProposal, reportedSafeExecution, waitForSafeExecutionHash } from '@bananapus/nana-sdk-core/safe-service'
import { isAddress, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from 'viem'
import {
  createBrowserWriteRecovery, parseReviewedWriteRecoveryRecord, readBrowserWriteRecovery, sameReviewedWrite, verifyReviewedWriteExpiry, verifyReviewedWriteReceipt,
  type ReviewedWriteRecoveryRecord,
} from '@bananapus/nana-sdk-core/review'

/** One reservation per chain and project, around the SDK's per-account records. */
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const HASH = /^0x[\da-f]{64}$/i
const UINT = /^(?:0|[1-9]\d{0,77})$/

/** One lock per chain and project, held while the project is checked and the reservation made. */
export const projectAdminLockName = (chainId: number, projectId: bigint) => `homerun:project-admin:lock:${chainId}:${projectId}`
export const projectAdminNamespace = (projectId: bigint) => `homerun:project-admin:${projectId}`
const accountsKey = (chainId: number, projectId: bigint) => `homerun:project-admin:accounts:v1:${chainId}:${projectId}`
/** Where the editors kept an unresolved update before the SDK's journal took over. */
const legacyKey = (chainId: number, projectId: bigint) => `homerun:project-admin:pending:v1:${chainId}:${projectId}`

function accountsOf(storage: Store, chainId: number, projectId: bigint): Address[] {
  const raw = storage.getItem(accountsKey(chainId, projectId))
  if (raw === null) return []
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !isAddress(item, { strict: false }))) throw new Error('Saved project update accounts are unreadable. Keep this browser’s data and check your wallet before sending another update.')
  return value as Address[]
}
function writeAccounts(storage: Store, chainId: number, projectId: bigint, accounts: Address[]) {
  const key = accountsKey(chainId, projectId)
  if (!accounts.length) { storage.removeItem(key); return }
  const raw = JSON.stringify(accounts)
  storage.setItem(key, raw)
  if (storage.getItem(key) !== raw) throw new Error('This browser could not save project update recovery. Do not submit until browser storage is available.')
}
/** Name an account that may hold this project's reservation. Call before its wallet opens. */
export function noteProjectAdminAccount(storage: Store, chainId: number, projectId: bigint, account: Address): void {
  const accounts = accountsOf(storage, chainId, projectId)
  if (!accounts.some(item => item.toLowerCase() === account.toLowerCase())) writeAccounts(storage, chainId, projectId, [...accounts, account.toLowerCase() as Address])
}

/**
 * Move an editor record from before the SDK's journal into it, keeping its exact call, account,
 * Safe flag and returned hash, so an update that was broadcast can't be sent again after an upgrade.
 * The old key goes only once the SDK holds the record.
 */
export async function adoptLegacyProjectAdminRecord(storage: Store, chainId: number, projectId: bigint): Promise<void> {
  const key = legacyKey(chainId, projectId)
  const raw = storage.getItem(key)
  if (raw === null) return
  const unreadable = () => new Error('A saved project update could not be read. Keep this browser’s data and check your wallet before sending another update.')
  let value: Record<string, unknown>
  try { value = JSON.parse(raw) } catch { throw unreadable() }
  const { holder, target, data, safe, hash } = value
  if (!value || value.version !== 1 || value.chainId !== chainId || value.projectId !== projectId.toString()
    || typeof holder !== 'string' || !isAddress(holder, { strict: false }) || holder.toLowerCase() === zeroAddress
    || typeof target !== 'string' || !isAddress(target, { strict: false })
    || typeof data !== 'string' || !/^0x(?:[\da-f]{2}){4,}$/i.test(data)
    || typeof value.value !== 'string' || !UINT.test(value.value) || typeof safe !== 'boolean'
    || (hash !== undefined && (typeof hash !== 'string' || !HASH.test(hash) || hash.toLowerCase() === zeroHash))) throw unreadable()
  const input = { chainId, account: holder.toLowerCase() as Address, safe, namespace: projectAdminNamespace(projectId),
    call: { to: target.toLowerCase() as Address, data: data.toLowerCase() as Hex, value: BigInt(value.value) } }
  const journal = createBrowserWriteRecovery(input, { storage: storage as Storage })
  await journal.withLock(async () => {
    const existing = journal.read()
    if (existing) {
      const conflict = () => new Error('Two saved project updates are unresolved. Keep this browser’s data and check your wallet before sending another update.')
      if (!sameReviewedWrite(existing, input)) throw conflict()
      const wanted = hash?.toLowerCase()
      if (wanted && existing.hash && existing.hash.toLowerCase() !== wanted) throw conflict()
      // The old record knows the hash this reservation lacks: merge it, and only then let the old key go.
      if (wanted && !existing.hash) journal.submitted(wanted as Hex, existing)
    } else {
      journal.reserve()
      if (hash) journal.submitted(hash.toLowerCase() as Hex)
    }
  })
  const saved = journal.read()
  if (!saved || (hash && saved.hash?.toLowerCase() !== hash.toLowerCase())) throw unreadable()
  noteProjectAdminAccount(storage, chainId, projectId, input.account)
  storage.removeItem(key)
}

/** `exit`: the hold may be ended by the user: it has no known hash, or its hash is proven dropped. */
/**
 * Drop accounts that hold nothing from the list as it is now, keeping `account`. Call it under the
 * project lock: a scan reads the list and waits on the chain, so it never writes one back.
 */
export function pruneProjectAdminAccounts(storage: Store, chainId: number, projectId: bigint, account: Address): void {
  const namespace = projectAdminNamespace(projectId)
  const accounts = accountsOf(storage, chainId, projectId)
  const keep = accounts.filter(other => other.toLowerCase() === account.toLowerCase()
    || !!readBrowserWriteRecovery({ chainId, account: other, namespace }, { storage: storage as Storage }))
  if (keep.length !== accounts.length) writeAccounts(storage, chainId, projectId, keep)
}

export type ProjectAdminHold = { journal: ReturnType<typeof createBrowserWriteRecovery>; record: ReviewedWriteRecoveryRecord; exit: boolean }

/**
 * Unresolved updates this project holds for accounts other than `account`. The chain is asked
 * first: a placed transaction or a mined receipt ends the hold; anything else stays.
 */
export async function otherProjectAdminHolds(storage: Store, client: PublicClient, chainId: number, projectId: bigint, account: Address): Promise<ProjectAdminHold[]> {
  const namespace = projectAdminNamespace(projectId)
  const accounts = accountsOf(storage, chainId, projectId)
  const holds: ProjectAdminHold[] = []
  for (const other of accounts) {
    const mine = other.toLowerCase() === account.toLowerCase()
    const found = readBrowserWriteRecovery({ chainId, account: other, namespace }, { storage: storage as Storage })
    if (!found || mine) continue
    const record = parseReviewedWriteRecoveryRecord(found)
    const journal = createBrowserWriteRecovery({ chainId, account: record.account, safe: record.safe, namespace, call: record.call }, { storage: storage as Storage })
    try {
      await journal.withLock(async () => {
        await journal.resolve(client)
        const current = journal.read()
        if (current?.hash && !current.safe) {
          const receipt = await client.getTransactionReceipt({ hash: current.hash })
          await verifyReviewedWriteReceipt(client, current, receipt)
          journal.clear(current)
        } else if (current?.hash && current.safe) {
          // The Safe's own events decide: replaced, expired and executed are each proven before the hold ends.
          const look = await lookAtSafeProposal(client, chainId, current.account, current.hash)
          if (look === 'replaced') journal.clear(current)
          else if (look === 'expired') { await verifyReviewedWriteExpiry(client, current); journal.clear(current) }
          else {
            const proposal = current.hash
            // A proposal that ran and failed makes the waiter throw; the service's record still names its execution.
            const execution = await waitForSafeExecutionHash(chainId, proposal, { client, signal: AbortSignal.timeout(5_000) })
              .catch(async (reason: unknown) => {
                const reported = await reportedSafeExecution(reason, chainId, current.account, proposal)
                if (!reported) throw reason
                return reported
              })
            const receipt = await client.getTransactionReceipt({ hash: execution })
            await verifyReviewedWriteReceipt(client, current, receipt)
            journal.clear(current)
          }
        }
      })
    } catch { /* The chain can't place it yet: it stays held. */ }
    const current = journal.read()
    if (current) holds.push({ journal, record: current, exit: !current.hash || await provenDropped(client, current).catch(() => false) })
  }
  return holds
}
