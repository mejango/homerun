'use client'

import { jbMultiTerminalAbi, jbTerminalStoreAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { getPublicClient } from '@wagmi/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { decodeEventLog, formatUnits, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient, type TransactionReceipt } from 'viem'
import { txPhaseLabel, useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { buildFundUseAllowance, FUND_CASH_OUTS_DISABLED, parseAmount, type FundTransaction } from '@/lib/fund-contracts'
import { assertFundStateForWrite, readFundProjectState, readLinkedFundProjects, type FundAccountingContext, type FundProjectState } from '@/lib/fund-state'
import { wagmiConfig } from '@/providers/Providers'

export type FundAssetAllowanceConfiguration = { amount: bigint; currency: number; contextIndex: number }

type Props = {
  state: FundProjectState
  client: PublicClient
  contextIndex: number
  /** The operator panel owns the complete, recoverable all-chain ruleset plan. */
  onConfigureAllowance?: (input: FundAssetAllowanceConfiguration) => Promise<void>
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
}

type Allowance = { configured: bigint; used: bigint; remaining: bigint; available: bigint }
type WithdrawalIntent = {
  request: FundTransaction
  chainId: number
  decimals: number
  symbol: string
  account: Address
  terminal: Address
  projectId: bigint
  rulesetId: bigint
  amount: bigint
  netAmount: bigint
  beneficiary: Address
  feeBeneficiary: Address
  memo: string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The withdrawal could not be verified. Refresh the project and try again.'
}

function serial(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)
}

function stateTerms(state: FundProjectState): string {
  const { blockNumber: _block, ...snapshot } = state.rulesetSnapshot
  return serial({ snapshot, owner: state.owner, controller: state.controller, contexts: state.accountingContexts })
}

function amount(value: string, decimals: number): bigint {
  try { return parseAmount(value, decimals) } catch { return 0n }
}

function recipient(value: string): Address | null {
  return isAddress(value) && !isAddressEqual(value, zeroAddress) ? getAddress(value) : null
}

function requireClosed(state: FundProjectState, account: Address, requirePermission = true): void {
  assertFundStateForWrite(state, account)
  if (!state.rulesetSnapshot.configuration || state.hasPendingRuleset) throw new Error('Verify the complete active ruleset, with no pending ruleset change, before using the asset allowance.')
  if (!state.metadata.pausePay || state.metadata.cashOutTaxRate !== FUND_CASH_OUTS_DISABLED) throw new Error('Close fundraising and FUND cash-outs before withdrawing money for the purchase.')
  if (requirePermission && !state.permissions.useAllowance) throw new Error('This wallet does not have permission to use the project’s surplus allowance.')
}

function chainClient(chainId: JBChainId): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error(`The linked FUND RPC on chain ${chainId} is unavailable.`)
  return client as PublicClient
}

/** Amounts share the accounting context's currency and decimals; no FX estimate. */
export async function readAssetAllowance(client: PublicClient, state: FundProjectState, context: FundAccountingContext): Promise<Allowance> {
  const matches = context.surplusAllowances.filter(allowance => allowance.currency === context.currency)
  if (matches.length > 1) throw new Error('The treasury returned duplicate allowance currencies.')
  const configured = matches[0]?.amount ?? 0n
  const used = await client.readContract({
    address: v6Address('JBTerminalStore', state.chainId), abi: jbTerminalStoreAbi,
    functionName: 'usedSurplusAllowanceOf',
    args: [context.terminal, state.projectId, context.token, BigInt(state.ruleset.id), BigInt(context.currency)],
    blockNumber: state.blockNumber,
  })
  if (used > configured) throw new Error('The used allowance exceeds the verified configured amount. Refresh the project state.')
  const block = await client.getBlock({ blockNumber: state.blockNumber })
  if (block.hash !== state.blockHash) throw new Error('The chain changed during the allowance read. Refresh and try again.')
  const remaining = configured - used
  return { configured, used, remaining, available: remaining < context.surplus ? remaining : context.surplus }
}

/** A successful receipt alone does not prove the requested beneficiary received funds. */
export function confirmedAssetWithdrawal(receipt: TransactionReceipt, intent: WithdrawalIntent): bigint {
  if (receipt.status !== 'success') throw new Error('The asset withdrawal reverted onchain.')
  const matches: bigint[] = []
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, intent.terminal)) continue
    try {
      const event = decodeEventLog({ abi: jbMultiTerminalAbi, data: log.data, topics: log.topics })
      if (event.eventName !== 'UseAllowance') continue
      const values = event.args
      if (values.projectId === intent.projectId && values.rulesetId === intent.rulesetId &&
        values.amount === intent.amount && values.amountPaidOut === intent.amount &&
        values.netAmountPaidOut >= intent.netAmount && values.memo === intent.memo &&
        isAddressEqual(values.beneficiary, intent.beneficiary) &&
        isAddressEqual(values.feeBeneficiary, intent.feeBeneficiary) && isAddressEqual(values.caller, intent.account)) {
        matches.push(values.netAmountPaidOut)
      }
    } catch { /* Unrelated terminal events are not evidence of this withdrawal. */ }
  }
  if (matches.length !== 1) throw new Error('Execution was confirmed, but the expected asset withdrawal event could not be verified. Inspect the transaction before taking another withdrawal action.')
  return matches[0]
}

export function FundAssetWithdrawals({ state, client, contextIndex, onConfigureAllowance, disabled = false, onBusyChange }: Props) {
  const { address } = useWallet()
  const cache = useQueryClient()
  const tx = useSafeTx(state.chainId)
  const [allowanceAmount, setAllowanceAmount] = useState('')
  const [allowanceAcknowledged, setAllowanceAcknowledged] = useState(false)
  const [withdrawalAmount, setWithdrawalAmount] = useState('')
  const [beneficiaryInput, setBeneficiaryInput] = useState('')
  const [feeBeneficiaryInput, setFeeBeneficiaryInput] = useState('')
  const [purchaseReference, setPurchaseReference] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intent, setIntent] = useState<WithdrawalIntent | null>(null)
  const [confirmedNet, setConfirmedNet] = useState<bigint | null>(null)
  const refreshedReceipt = useRef<string | null>(null)
  const context = state.accountingContexts[contextIndex]
  const ownsAction = preparing || tx.busy || tx.phase === 'review' || (tx.phase === 'success' && !!intent && confirmedNet === null)
  const locked = disabled || ownsAction
  const closed = state.metadata.pausePay && state.metadata.cashOutTaxRate === FUND_CASH_OUTS_DISABLED
  const configuredAmount = context ? amount(allowanceAmount, context.decimals) : 0n
  const requestedAmount = context ? amount(withdrawalAmount, context.decimals) : 0n
  const beneficiary = recipient(beneficiaryInput)
  const feeBeneficiary = recipient(feeBeneficiaryInput)
  const currentAllowance = useQuery({
    queryKey: ['fund-asset-allowance', state.chainId, state.projectId.toString(), context?.terminal, context?.token, state.blockNumber.toString()],
    enabled: !!context,
    queryFn: () => {
      if (!context) throw new Error('Select a verified treasury currency.')
      return readAssetAllowance(client, state, context)
    },
    staleTime: Infinity,
    retry: 1,
  })

  useEffect(() => { onBusyChange?.(ownsAction) }, [onBusyChange, ownsAction])

  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || !intent || refreshedReceipt.current === tx.receipt.transactionHash) return
    refreshedReceipt.current = tx.receipt.transactionHash
    try {
      const net = confirmedAssetWithdrawal(tx.receipt, intent)
      setConfirmedNet(net)
      void cache.invalidateQueries({ queryKey: ['fund-project', intent.chainId, intent.projectId.toString()] })
      void cache.invalidateQueries({ queryKey: ['fund-asset-allowance', intent.chainId, intent.projectId.toString()] })
    } catch (reason) { setError(message(reason)) }
  }, [cache, intent, state.chainId, state.projectId, tx.phase, tx.receipt])

  async function configure(clear = false) {
    if (locked || !onConfigureAllowance || !context) return
    setError(null); setPreparing(true)
    try {
      if (!allowanceAcknowledged || (clear ? !currentAllowance.data || currentAllowance.data.configured <= 0n : configuredAmount <= 0n)) throw new Error('Review and acknowledge the explicit purchase allowance change.')
      await onConfigureAllowance({ amount: clear ? 0n : configuredAmount, currency: context.currency, contextIndex })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }

  async function withdraw() {
    if (locked || tx.phase === 'success') return
    setError(null); setPreparing(true)
    try {
      if (!address || !context || !beneficiary || !feeBeneficiary || requestedAmount <= 0n) throw new Error('Enter a positive amount and both recipient addresses.')
      if (!purchaseReference.trim()) throw new Error('Enter a public purchase reference for the withdrawal review.')
      const current = await readFundProjectState(client, { chainId: state.chainId, projectId: state.projectId, account: address })
      requireClosed(current, address)
      if (!isAddressEqual(current.owner, state.owner)) throw new Error('Project ownership changed. Refresh and review the current operator.')
      const peers = current.linkedChainIds.length > 1 ? await readLinkedFundProjects(chainClient, current) : [current]
      for (const peer of peers) requireClosed(peer, address, false)
      const currentContext = current.accountingContexts.find(item => isAddressEqual(item.token, context.token) && isAddressEqual(item.terminal, context.terminal))
      if (!currentContext || currentContext.currency !== context.currency || currentContext.decimals !== context.decimals) throw new Error('The treasury accounting context changed. Refresh and review again.')
      const allowance = await readAssetAllowance(client, current, currentContext)
      if (requestedAmount > allowance.available) throw new Error('The withdrawal exceeds the remaining allowance or available treasury surplus.')
      const memo = `Homerun asset purchase: ${purchaseReference.trim()}`
      const input = { snapshot: current.rulesetSnapshot, terminal: currentContext.terminal, token: currentContext.token,
        amount: requestedAmount, currency: currentContext.currency, beneficiary, feeBeneficiary, memo }
      // This eth_call cannot move funds. The contract itself quotes fees and
      // exemptions for the exact sender, amount and both recipient addresses.
      const quoteRequest = buildFundUseAllowance({ ...input, minTokensPaidOut: 1n })
      const quote = await client.simulateContract({ ...quoteRequest, account: address, blockNumber: current.blockNumber })
      if (typeof quote.result !== 'bigint' || quote.result <= 0n || quote.result > requestedAmount) throw new Error('The terminal did not return a valid net withdrawal quote.')
      const netAmount = quote.result
      const request = buildFundUseAllowance({ ...input, minTokensPaidOut: netAmount })
      const nextIntent = { request, account: address, chainId: current.chainId, decimals: currentContext.decimals,
        symbol: currentContext.symbol, terminal: currentContext.terminal, projectId: current.projectId,
        rulesetId: BigInt(current.ruleset.id), amount: requestedAmount, netAmount, beneficiary, feeBeneficiary, memo }
      setIntent(nextIntent); setConfirmedNet(null)
      const submitted = await tx.send({ ...request, label: `Withdraw ${formatUnits(requestedAmount, context.decimals)} ${context.symbol} for the asset purchase` }, {
        reviewNotice: `The treasury spends ${formatUnits(requestedAmount, context.decimals)} ${context.symbol}. At least ${formatUnits(netAmount, context.decimals)} ${context.symbol} must reach ${beneficiary}, after the quoted protocol fee of ${formatUnits(requestedAmount - netAmount, context.decimals)} ${context.symbol}. Fee-project tokens go to ${feeBeneficiary}. This sends money directly to the entered recipient; the contract does not verify the asset purchase.`,
        reverify: async () => {
          const latest = await readFundProjectState(client, { chainId: state.chainId, projectId: state.projectId, account: address })
          requireClosed(latest, address)
          if (stateTerms(latest) !== stateTerms(current)) throw new Error('The rules, allowance, treasury balance, or project ownership changed during review. Refresh and review again.')
          const latestPeers = latest.linkedChainIds.length > 1 ? await readLinkedFundProjects(chainClient, latest) : [latest]
          if (latestPeers.length !== peers.length) throw new Error('The linked FUND membership changed during review.')
          for (const peer of peers) {
            const latestPeer = latestPeers.find(item => item.chainId === peer.chainId && item.projectId === peer.projectId)
            if (!latestPeer || stateTerms(latestPeer) !== stateTerms(peer)) throw new Error('A linked FUND project changed during review. Verify the closed campaign on every chain before withdrawing.')
            requireClosed(latestPeer, address, false)
          }
          const latestContext = latest.accountingContexts.find(item => isAddressEqual(item.token, currentContext.token) && isAddressEqual(item.terminal, currentContext.terminal))
          if (!latestContext) throw new Error('The selected treasury context changed during review.')
          const latestAllowance = await readAssetAllowance(client, latest, latestContext)
          if (serial(latestAllowance) !== serial(allowance) || requestedAmount > latestAllowance.available) throw new Error('The remaining surplus allowance changed during review.')
          const rebuilt = buildFundUseAllowance({ ...input, snapshot: latest.rulesetSnapshot, minTokensPaidOut: netAmount })
          if (serial(rebuilt) !== serial(request)) throw new Error('The exact withdrawal request changed during review.')
        },
      })
      if (!submitted) setIntent(null)
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }

  const explorer = tx.hash && !tx.safeProposalHash ? explorerTxUrl(state.chainId, tx.hash) : null
  const inputClass = 'min-h-12 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base'
  return <section className="grid gap-4 border-t border-[#c4cdbb] pt-5" aria-labelledby="fund-asset-withdrawals">
    <h3 id="fund-asset-withdrawals" className="text-xl">Pay for the asset</h3>
    <p className="text-sm">Close fundraising and FUND cash-outs, then set an explicit purchase allowance. The allowance is a contract withdrawal limit. The asset price and cash reserve in the model do not authorize spending.</p>
    {!closed && <p role="status" className="text-sm">The active contract rules must close both contributions and cash-outs before purchase withdrawals are available.</p>}
    {context ? <>
      <dl className="grid gap-3 rounded border border-[#c4cdbb] p-4 text-sm sm:grid-cols-3">
        <div><dt>Configured allowance</dt><dd>{currentAllowance.data ? `${formatUnits(currentAllowance.data.configured, context.decimals)} ${context.symbol}` : 'Checking…'}</dd></div>
        <div><dt>Already withdrawn this ruleset</dt><dd>{currentAllowance.data ? `${formatUnits(currentAllowance.data.used, context.decimals)} ${context.symbol}` : 'Checking…'}</dd></div>
        <div><dt>Available now</dt><dd>{currentAllowance.data ? `${formatUnits(currentAllowance.data.available, context.decimals)} ${context.symbol}` : 'Checking…'}</dd></div>
      </dl>
      {currentAllowance.isError && <p role="alert" className="text-sm text-red-800">{message(currentAllowance.error)}</p>}
      {context.surplusAllowances.some(allowance => allowance.currency !== context.currency) && <p className="text-sm">This panel uses allowances in the treasury token’s accounting currency. Review other allowance currencies in Juicebox.</p>}
      <details className="rounded border border-[#c4cdbb] p-4">
        <summary className="cursor-pointer text-sm font-medium">Configure a purchase allowance</summary>
        <div className="mt-4 grid gap-4">
          <label className="grid gap-2 text-sm">New allowance in {context.symbol}, before fees<input className={inputClass} value={allowanceAmount} onChange={event => { setAllowanceAmount(event.target.value); setAllowanceAcknowledged(false) }} inputMode="decimal" autoComplete="off" disabled={locked} /></label>
          <p className="text-sm">A new ruleset starts a new allowance budget. Enter only the amount that may be withdrawn after that ruleset starts. Every linked chain is reviewed in the configuration plan.</p>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0" checked={allowanceAcknowledged} onChange={event => setAllowanceAcknowledged(event.target.checked)} disabled={locked} />I have reconciled previous withdrawals and reviewed this allowance change.</label>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-secondary min-h-11 w-fit px-4" onClick={() => void configure()} disabled={locked || !onConfigureAllowance || !state.permissions.queueRulesets || !closed || state.hasPendingRuleset || !state.rulesetSnapshot.configuration || !currentAllowance.data || configuredAmount <= 0n || !allowanceAcknowledged}>Review purchase allowance</button>
            {currentAllowance.data && currentAllowance.data.configured > 0n && <button type="button" className="btn-secondary min-h-11 w-fit px-4" onClick={() => void configure(true)} disabled={locked || !onConfigureAllowance || !state.permissions.queueRulesets || !closed || state.hasPendingRuleset || !state.rulesetSnapshot.configuration || !allowanceAcknowledged}>Review removing purchase allowance</button>}
          </div>
          <p className="text-sm">Remove the purchase allowance once the payment is complete, before enabling success mints. This prevents a later ruleset from renewing a spent budget.</p>
          {!state.permissions.queueRulesets && <p className="text-sm">This wallet does not have permission to configure the project’s rules.</p>}
        </div>
      </details>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm">Withdraw in {context.symbol}, before fees<input className={inputClass} value={withdrawalAmount} onChange={event => setWithdrawalAmount(event.target.value)} inputMode="decimal" autoComplete="off" disabled={locked || tx.phase === 'success'} /></label>
        <label className="grid gap-2 text-sm">Asset purchase recipient<input className={inputClass} value={beneficiaryInput} onChange={event => setBeneficiaryInput(event.target.value)} autoComplete="off" spellCheck={false} disabled={locked || tx.phase === 'success'} /></label>
        <label className="grid gap-2 text-sm">Fee token recipient<input className={inputClass} value={feeBeneficiaryInput} onChange={event => setFeeBeneficiaryInput(event.target.value)} autoComplete="off" spellCheck={false} disabled={locked || tx.phase === 'success'} /></label>
        <label className="grid gap-2 text-sm">Public purchase reference<input className={inputClass} value={purchaseReference} maxLength={200} onChange={event => setPurchaseReference(event.target.value)} autoComplete="off" disabled={locked || tx.phase === 'success'} /></label>
      </div>
      <p className="text-sm">The review quotes the amount the purchase recipient receives after protocol fees. The fee token recipient receives any project tokens minted in exchange for the fee. Use a reference without personal information.</p>
      <button type="button" className="btn-primary min-h-11 w-fit px-4" onClick={() => void withdraw()} disabled={locked || tx.phase === 'success' || !state.permissions.useAllowance || !closed || state.hasPendingRuleset || !state.rulesetSnapshot.configuration || !currentAllowance.data || requestedAmount <= 0n || requestedAmount > currentAllowance.data.available || !beneficiary || !feeBeneficiary || !purchaseReference.trim()}>{preparing ? 'Verifying the allowance and fee…' : txPhaseLabel(tx.phase, { idle: 'Review asset withdrawal', pending: 'Confirming withdrawal…' })}</button>
      {!state.permissions.useAllowance && <p className="text-sm">This wallet does not have permission to withdraw the project’s surplus allowance.</p>}
      {confirmedNet !== null && <button type="button" className="btn-secondary min-h-11 w-fit px-4" disabled={locked} onClick={() => { tx.reset(); setIntent(null); setConfirmedNet(null); setWithdrawalAmount(''); setBeneficiaryInput(''); setFeeBeneficiaryInput(''); setPurchaseReference(''); setError(null) }}>Prepare another withdrawal</button>}
    </> : <p className="text-sm">Select a verified treasury currency to configure or use a purchase allowance.</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    <div role="status" aria-live="polite" className="break-words text-sm">
      {tx.safeProposalHash ? <p>Proposed to Safe. No withdrawal is confirmed until the Safe executes it onchain.</p>
        : confirmedNet !== null && intent ? <p>Asset withdrawal confirmed. The purchase recipient received {formatUnits(confirmedNet, intent.decimals)} {intent.symbol}.</p>
          : tx.phase === 'pending' ? <p>Submitted. Waiting for the withdrawal receipt…</p> : null}
      {tx.error && <p className="text-red-800">{tx.error}</p>}
      {explorer && <a href={explorer} target="_blank" rel="noreferrer" className="underline">View withdrawal transaction</a>}
    </div>
  </section>
}
