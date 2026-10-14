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
 * shows its line, offers its exit and settles it. Returns what the hold says now.
 */
export async function adoptLegacyWrite(input: ReviewedWriteRecoveryInput, evidence: LegacyWriteEvidence, client: WriteHoldClient): Promise<WriteHoldState> {
  const hold = holds.open(input)
  const snapshot = await hold.state(client)
  if (snapshot.status !== 'clear') return snapshot
  return hold.adopt(snapshot, evidence, client)
}
