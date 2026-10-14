import type { Address } from 'viem'
import { intent, writeIntentKey } from '@bananapus/nana-sdk-core/review'

/**
 * ERC-20 `approve` without a declared return. Some tokens (mainnet USDT)
 * return nothing, and a declared bool makes the simulation fail to decode
 * their approval. The calldata is the same as erc20Abi's.
 */
const erc20ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

/**
 * The hold name of an approval step inside a flow: its parent intent (the user's action), the token,
 * the spender and the step. Never the amount, which the flow calculates (a repay ceiling, say).
 */
export function approvalIntentKey(parent: string, { token, spender, step }: { token: Address; spender: Address; step: string }): string {
  return writeIntentKey('approve', { intent: parent, token: intent.address(token), spender: intent.address(spender), step })
}

/** Exact ERC-20 allowance request shared by every approval: payments, loans, bridging, Sticky and treasury returns. */
export function buildErc20ApproveRequest({
  chainId,
  token,
  spender,
  amount,
}: {
  chainId: number
  token: Address
  spender: Address
  amount: bigint
}) {
  return {
    chainId,
    address: token,
    abi: erc20ApproveAbi,
    functionName: 'approve' as const,
    args: [spender, amount] as const,
  }
}
