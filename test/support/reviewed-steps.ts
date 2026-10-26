import type { Hex } from 'viem'
import type { TxRequest, TxSendOptions, TxStep } from '@/hooks/useReviewedAction'

/** A lone request as one step, with its hold keys from the options, as `useReviewedAction().send` reads it. */
export function stepsOf(requested: TxRequest | readonly TxStep[], options: Partial<TxSendOptions> = {}): TxStep[] {
  return 'address' in requested
    ? [{ ...requested as TxRequest, recoveryNamespace: options.recoveryNamespace, recoveryLegacy: options.recoveryLegacy, simulationBlockNumber: options.simulationBlockNumber }]
    : [...requested as readonly TxStep[]]
}

/**
 * Runs a mocked `send` the way core's reviewed run does: each step is rechecked (with the block the
 * step before it confirmed in, after `review`) and written in order; a Safe stops at the first step it proposes.
 * `write` returns the step's hash, or null to stop as a cancel does.
 */
export async function runSteps(requested: TxRequest | readonly TxStep[], options: Partial<TxSendOptions>, write: (step: TxStep, index: number, options: Partial<TxSendOptions>) => Hex | null | Promise<Hex | null>, chain: { safe?: boolean; review?: (step: TxStep, index: number) => unknown; receipt?: (hash: Hex) => Promise<{ blockNumber: bigint }> } = {}): Promise<Hex | null> {
  const steps = stepsOf(requested, options)
  let prior: { chainId: number; blockNumber: bigint; blockHash: Hex } | undefined
  let hash: Hex | null = null
  for (const [index, step] of steps.entries()) {
    await chain.review?.(step, index)
    await options.reverify?.(step, index, prior)
    options.assertWriteState?.()
    hash = await write(step, index, { ...options, recoveryNamespace: step.recoveryNamespace, recoveryLegacy: step.recoveryLegacy, simulationBlockNumber: step.simulationBlockNumber })
    if (!hash) return null
    options.onStepSubmitted?.(index, hash, !!chain.safe)
    if (index === steps.length - 1 || chain.safe) return hash
    const receipt = chain.receipt ? await chain.receipt(hash) : { blockNumber: 0n }
    prior = { chainId: step.chainId, blockNumber: receipt.blockNumber, blockHash: `0x${'0'.repeat(64)}` }
  }
  return hash
}
