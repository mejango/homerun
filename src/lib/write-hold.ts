import { encodeFunctionData, type Abi, type Address } from 'viem'
import { createHeldWriteStorage, createWriteHold, type ReviewedWriteRecoveryInput, type WriteHoldClient, type WriteHoldHandle, type WriteHoldState } from '@bananapus/nana-sdk-core/review'

/** The call a contract write request makes: what its hold is keyed and checked by. */
export function callOf(request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint }): { to: Address; data: `0x${string}`; value?: bigint } {
  return { to: request.address, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args as unknown[] }), value: request.value }
}

/** The browser's storage with the tab's memory behind it: every read of a held write goes through it. */
export const heldStorage = createHeldWriteStorage()

/** The one controller around every held wallet write in this app. */
export const holds = createWriteHold({ storage: heldStorage })

/**
 * Whether two hold states show the same: the same record, status, exit, line, warning, notice and
 * reservation. A view that keeps a state it already shows compares through this, so an exit that a
 * later check offers for the same record and status still appears.
 */
export function sameShownHold(a: WriteHoldState, b: WriteHoldState): boolean {
  const shown = (state: WriteHoldState) => JSON.stringify({
    status: state.status, reservation: state.reservation, notice: state.notice,
    ...(state.status === 'clear' ? { settled: state.settled } : {
      record: state.record, exit: state.exit, line: state.line, warning: 'warning' in state ? state.warning : undefined,
    }),
  })
  return shown(a) === shown(b)
}

/** What a journal from before SDK holds saved about its write: the evidence `hold.adopt` takes. */
export type LegacyWriteEvidence = NonNullable<Parameters<WriteHoldHandle['adopt']>[1]>

/**
 * Move a journal record from before SDK holds into the write's hold, atomically: the hold for
 * `input` reserves it with the saved evidence (its hash, or its Safe proposal; else its nonce) and
 * its saved send time, unless the hold already holds something. From then on the SDK alone holds it,
 * shows its line, offers its exit and settles it.
 *
 * `adopted` says the journal may go: the hold now holds this attempt (adopted, or found already
 * held as this same attempt) or settled it on authenticated evidence. Otherwise the journal stays.
 */
export async function adoptLegacyWrite(input: ReviewedWriteRecoveryInput, evidence: LegacyWriteEvidence, client: WriteHoldClient): Promise<{ state: WriteHoldState; adopted: boolean }> {
  const hold = holds.open(input)
  const snapshot = await hold.state(client)
  if (snapshot.status !== 'clear') return { state: snapshot, adopted: sameAttempt(snapshot.record, input, evidence) }
  const state = await hold.adopt(snapshot, evidence, client)
  return { state, adopted: state.status !== 'clear' || !!state.settled }
}

/** Whether the attempt a hold already holds is the journal's own: its hash, or (with none saved) its exact call. */
function sameAttempt(record: { hash?: string; call: { to: string; data: string; value: string } }, input: ReviewedWriteRecoveryInput, evidence: LegacyWriteEvidence): boolean {
  const saved = evidence.hash ?? evidence.safe?.safeTxHash
  if (saved) return record.hash?.toLowerCase() === saved.toLowerCase()
  return record.call.to.toLowerCase() === input.call.to.toLowerCase() && record.call.data.toLowerCase() === input.call.data.toLowerCase()
    && BigInt(record.call.value) === BigInt(input.call.value ?? 0n)
}

/**
 * What a hold for this intent says of its write, from storage and either kind of wallet: it still
 * holds one (`held`), it settled one with success (`settled`, with its hash), or it keeps no such
 * record (`none`: never written here, cleared from storage, replaced by a later write, or settled otherwise).
 */
export async function holdOutcome(intent: { chainId: number; account: Address; namespace: string }): Promise<{ status: 'held' } | { status: 'settled'; hash: `0x${string}` } | { status: 'none' }> {
  let settled: `0x${string}` | null = null
  for (const safe of [false, true]) {
    const state = holds.open({ ...intent, safe, call: { to: '0x0000000000000000000000000000000000000000', data: '0x' } }).peek()
    if (state.status !== 'clear') return { status: 'held' }
    if (!settled && state.settled && 'hash' in state.settled && state.settled.result === 'success') settled = state.settled.hash
  }
  return settled ? { status: 'settled', hash: settled } : { status: 'none' }
}

/**
 * Recover a saved completion through its intent's hold: while the hold holds the write, nothing is
 * counted (`held`); once it settled with success, `verify` runs the domain checks on that settled
 * transaction (falling back to the saved one); with no hold record, `verify` checks the exact saved
 * call on chain. `verify` returns null when its evidence can't show the completion.
 */
export async function recoverFromHold<T>(intent: { chainId: number; account: Address; namespace: string }, verify: (settledHash?: `0x${string}`) => Promise<T | null>): Promise<T | 'held' | null> {
  const outcome = await holdOutcome(intent)
  if (outcome.status === 'held') return 'held'
  if (outcome.status === 'settled') return await verify(outcome.hash) ?? await verify()
  return verify()
}
