'use client'

import { encodeFunctionData, type Abi, type Address } from 'viem'
import {
  buildTransactionDebugPrompt as buildDebugPrompt,
  buildTransactionReviewPrompt as buildReviewPrompt,
  TransactionReviewCancelledError,
  type TransactionReviewCall,
  type TransactionReviewRequest,
} from '@bananapus/nana-sdk-core/review'
import { displayChainName, explorerOrigin } from '@/lib/chainDisplay'

export {
  fundingChainLabel,
  registerFundingChainSelectionHandler,
  requireFundingChainSelection,
  TransactionReviewCancelledError,
  transactionReviewJson,
  type FundingChainOption,
  type TransactionReviewCall,
  type TransactionReviewRequest,
} from '@bananapus/nana-sdk-core/review'

const display = { chainName: displayChainName, explorerOrigin }

export function buildTransactionDebugPrompt(
  calls: { chainId: number; txHash: string }[],
): string {
  return buildDebugPrompt(calls, display)
}

export function buildTransactionReviewPrompt(
  request: TransactionReviewRequest,
): string {
  return buildReviewPrompt(request, display)
}

// ponytail: SDK 4.0.0 dropped this boolean review queue (3.5.2 reviewQueue.ts and transactionReview.ts, same
// behavior). It stays here only until the last caller sends through core's reviewed paths, which delete it.

export type ContractTransactionReviewCall = {
  chainId: number
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
  value?: bigint
  gas?: bigint
  safeTxGas?: bigint
  account?: Address
}

export type TransactionReviewOptions = Omit<TransactionReviewRequest, 'calls'> & {
  label?: string
  contractName?: string
}

type TransactionReviewHandler = (request: TransactionReviewRequest) => Promise<boolean>

const transactionReviewHandlers: TransactionReviewHandler[] = []

/** The provider registers the only UI that can approve a transaction. */
export function registerTransactionReviewHandler(handler: TransactionReviewHandler): () => void {
  transactionReviewHandlers.push(handler)
  return () => {
    const index = transactionReviewHandlers.lastIndexOf(handler)
    if (index >= 0) transactionReviewHandlers.splice(index, 1)
  }
}

export async function requestTransactionReview(request: TransactionReviewRequest): Promise<boolean> {
  if (!request.calls.length && !request.authorization) throw new Error('There is no transaction to review.')
  const handler = transactionReviewHandlers[transactionReviewHandlers.length - 1]
  if (!handler) throw new Error('Transaction review is unavailable. Reload the page before continuing.')
  return handler(request)
}

export async function requireTransactionReview(request: TransactionReviewRequest): Promise<void> {
  if (!(await requestTransactionReview(request))) throw new TransactionReviewCancelledError()
}

function contractCallForReview(call: ContractTransactionReviewCall, options: Pick<TransactionReviewOptions, 'label' | 'contractName'>): TransactionReviewCall {
  return {
    chainId: call.chainId,
    to: call.address,
    data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args as unknown[] }),
    value: call.value,
    gas: call.gas,
    safeTxGas: call.safeTxGas,
    from: call.account,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    label: options.label,
    contractName: options.contractName,
  }
}

export async function requestContractTransactionReview(call: ContractTransactionReviewCall, options: TransactionReviewOptions = {}): Promise<boolean> {
  const { label, contractName, ...requestOptions } = options
  const reviewed = contractCallForReview(call, { label, contractName })
  if (!(await requestTransactionReview({ ...requestOptions, calls: [reviewed] }))) return false
  const current = contractCallForReview(call, { label, contractName })
  if (
    current.chainId !== reviewed.chainId ||
    current.to.toLowerCase() !== reviewed.to.toLowerCase() ||
    (current.value ?? 0n) !== (reviewed.value ?? 0n) ||
    current.gas !== reviewed.gas ||
    current.safeTxGas !== reviewed.safeTxGas ||
    current.data !== reviewed.data
  ) {
    throw new Error('Transaction data changed after review. Nothing was sent; review it again.')
  }
  return true
}

export async function requireContractTransactionReview(call: ContractTransactionReviewCall, options: TransactionReviewOptions = {}): Promise<void> {
  if (!(await requestContractTransactionReview(call, options))) throw new TransactionReviewCancelledError()
}
