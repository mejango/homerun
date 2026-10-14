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

/**
 * A value in a write's intent key the app may have filled in itself (a default currency, a default
 * fee): the user's choice keys its value, and an app default keys as `auto:<field>`, so the hold
 * follows the choice of "the default" whatever the default resolves to by the retry.
 */
export function chosenOrAuto<T>(field: string, value: T, chosen: boolean): T | string {
  return chosen ? value : `auto:${field}`
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
