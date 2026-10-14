import { encodeFunctionData, type Abi, type Address } from 'viem'
import { createHeldWriteStorage, createSavedAttemptRecovery, createWriteHold, type WriteHoldClient } from '@bananapus/nana-sdk-core/review'

/** The call a contract write request makes: what its hold is keyed and checked by. */
export function callOf(request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint }): { to: Address; data: `0x${string}`; value?: bigint } {
  return { to: request.address, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args as unknown[] }), value: request.value }
}

/** The browser's storage with the tab's memory behind it: every read of a held write goes through it. */
export const heldStorage = createHeldWriteStorage()

/** The one controller around every held wallet write in this app. */
export const holds = createWriteHold({ storage: heldStorage })

/** The one saved-attempt recovery: every launch, plan, shop step and payer recovers through it. */
export const attempts = createSavedAttemptRecovery({ hold: holds, storage: heldStorage })

/**
 * Move a write a journal saved before SDK holds with only its pre-wallet nonce into its hold (the
 * SDK's `adopt`), so the hold can find it at that nonce on chain. Recovery then reads the hold; this
 * decides nothing, and a refused or unreadable adoption leaves recovery to ask the user.
 */
export async function adoptSavedNonce(input: Parameters<typeof holds.open>[0], evidence: { nonce?: bigint; fromBlock?: bigint }, client: WriteHoldClient): Promise<void> {
  const handle = holds.open(input)
  try { await handle.adopt(await handle.state(client), evidence, client) } catch { /* Recovery asks the user. */ }
}
