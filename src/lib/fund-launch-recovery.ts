import { encodeFunctionData, type Address, type PublicClient } from 'viem'
import { checkReviewedWrite, readReviewedWriteNonce, type ReviewedWriteCheck } from '@bananapus/nana-sdk-core/review'
import type { FundTransaction } from './fund-contracts'

/** The account's next nonce when a launch's wallet opened, saved with its pre-wallet marker. */
export type LaunchNonceEvidence = { nonce?: string; fromBlock?: string }

/** Read the evidence before the wallet opens. A node that can't answer saves none: the exit still works. */
export async function readLaunchNonceEvidence(client: PublicClient, sender: Address, safe: boolean): Promise<LaunchNonceEvidence> {
  if (safe) return {}
  try {
    const { nonce, blockNumber } = await readReviewedWriteNonce(client, sender)
    return { nonce: nonce.toString(), fromBlock: blockNumber.toString() }
  } catch { return {} }
}

/**
 * What the chain shows of a launch write whose wallet reply was lost: the SDK's nonce check finds the
 * exact call at the nonce it saved (`sent`, with the hash to verify), or `effect` shows it took effect
 * (`ran`). Anything else stays `pending`, and the user's exit stays open.
 */
export async function proveLostLaunchWrite(client: PublicClient, input: {
  request: FundTransaction; sender: Address; safe: boolean; attemptId: string
} & LaunchNonceEvidence, effect?: (chainId: number) => Promise<boolean>): Promise<ReviewedWriteCheck> {
  if (input.safe) return { status: 'pending' }
  return checkReviewedWrite(client, {
    version: 1, id: input.attemptId, chainId: input.request.chainId, account: input.sender, safe: false,
    call: { to: input.request.address, data: encodeFunctionData(input.request), value: String(input.request.value ?? 0n) },
    ...(input.nonce !== undefined ? { nonce: input.nonce } : {}), ...(input.fromBlock !== undefined ? { fromBlock: input.fromBlock } : {}),
  }, { effect })
}
