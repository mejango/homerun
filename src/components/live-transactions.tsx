'use client'

import { buildBurnTokensTx, getHookAwareCashOutQuote, prepareHookAwareCashOut } from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { erc20Abi, formatUnits, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import { FundOperatorActions } from '@/components/FundOperatorActions'
import { ProjectPayment } from '@/components/ProjectPayment'
import { useSafeTx, txPhaseLabel, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { readFundProjectState, type FundProjectState } from '@/lib/fund-state'
import { buildFundAllowlistChange, buildFundAllowlistOpen, parseAmount } from '@/lib/fund-contracts'
import { readableError } from '@/lib/readable-error'

/** Reject rounded, negative, exponent and over-precise financial inputs. */
function positiveAmount(value: string, decimals: number): bigint {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed) || (trimmed.split('.')[1]?.length ?? 0) > decimals) return 0n
  try { return parseAmount(trimmed, decimals) } catch { return 0n }
}

export function errorMessage(error: unknown): string {
  return readableError(error, 'Unable to prepare this transaction. Refresh the project and try again.')
}

function units(value: bigint, decimals = 18): string {
  return formatUnits(value, decimals)
}

type Tx = ReturnType<typeof useSafeTx>

function TransactionStatus({ tx, chainId }: { tx: Tx; chainId: number }) {
  const explorer = tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null
  return <div role="status" aria-live="polite" className="mt-4 text-sm break-words">
    {tx.safeProposalHash ? <p>Proposed to Safe. Execution and onchain confirmation are still required.</p>
      : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p>
        : tx.phase === 'success' ? <p>Confirmed onchain.</p>
          : tx.phase === 'review' ? <p>Review the exact transaction before continuing.</p> : null}
    {tx.error && <p className="text-red-800">{tx.error}</p>}
    {explorer && <a href={explorer} target="_blank" rel="noreferrer" className="underline">View transaction</a>}
  </div>
}

export function ActionSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="demo-section">
    <h2>{title}</h2>{children}
  </section>
}

function Input({ label, value, onChange, placeholder, inputMode = 'decimal' }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; inputMode?: 'text' | 'decimal'
}) {
  return <label className="grid gap-2 text-sm">{label}
    <input className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 text-base" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} inputMode={inputMode} autoComplete="off" />
  </label>
}

/** Invalidate only after successful execution, including Safe execution. */
function useConfirmedRefresh(tx: Tx, state: FundProjectState) {
  const cache = useQueryClient()
  const lastReceipt = useRef<string | null>(null)
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || tx.receipt.transactionHash === lastReceipt.current) return
    lastReceipt.current = tx.receipt.transactionHash
    void cache.invalidateQueries({ queryKey: ['fund-project', state.chainId, state.projectId.toString()] })
    void cache.invalidateQueries({ queryKey: ['fund-allowance', state.chainId, state.projectId.toString()] })
    void cache.invalidateQueries({ queryKey: ['fund-pay-quote', state.chainId, state.projectId.toString()] })
    void cache.invalidateQueries({ queryKey: ['fund-cash-out-quote', state.chainId, state.projectId.toString()] })
  }, [cache, state.chainId, state.projectId, tx.phase, tx.receipt])
}

function useProjectTransaction(state: FundProjectState) {
  const tx = useSafeTx(state.chainId)
  useConfirmedRefresh(tx, state)
  return tx
}

async function freshState(client: PublicClient, state: FundProjectState, account: Address, minimumBlock?: bigint) {
  const fresh = await readFundProjectState(client, { chainId: state.chainId, projectId: state.projectId, account })
  if (!fresh.supportedController || !fresh.supportedTerminals || !fresh.knownOwnerWrapper) throw new Error('This project no longer matches the verified FUND integration. Refresh the project before continuing.')
  if (minimumBlock !== undefined && fresh.blockNumber < minimumBlock) throw new Error('The network has not caught up with your confirmed approval. Wait a moment and try again.')
  if (!isAddressEqual(fresh.controller, state.controller)) throw new Error('The project controller changed. Refresh and review the project again.')
  return fresh
}

export function PaymentPanel({ state, client, contextIndex, chainSelector, onBusyChange }: { state: FundProjectState; client: PublicClient; contextIndex: number; chainSelector?: ReactNode; onBusyChange?: (busy: boolean) => void }) {
  const context = state.accountingContexts[contextIndex] ?? state.accountingContexts[0]
  const { address } = useWallet()
  // The hook reverts for anyone not on the list; say so before a doomed review instead of after.
  if (state.allowlist && !state.allowlist.open && address && state.allowlist.accountAllowed === false) {
    return <div className="pay-panel"><h2 className="mb-2 text-base font-medium">Contribute</h2><p role="status">Your wallet is not on this FUND’s allowlist. The owner or their allowlist operator adds contributors before they can pay.</p></div>
  }
  return <ProjectPayment chainSelector={chainSelector} onBusyChange={onBusyChange} chainId={state.chainId} projectId={state.projectId} tokenLabel="FUND" title="Contribute" context={context} paused={state.metadata.pausePay} reservedPercent={state.metadata.reservedPercent} rulesetId={state.ruleset.id.toString()} verify={async (account, minimumBlock) => {
    const current = await freshState(client, state, account, minimumBlock)
    const active = current.accountingContexts.find(item => isAddressEqual(item.token, context.token) && isAddressEqual(item.terminal, context.terminal))
    if (!active || active.decimals !== context.decimals || active.currency !== context.currency || current.metadata.pausePay || current.ruleset.id !== state.ruleset.id) throw new Error('The payment terminal or project rules changed. Refresh and review the payment again.')
    return current
  }} />
}

export function CashOutPanel({ state, client, contextIndex }: { state: FundProjectState; client: PublicClient; contextIndex: number }) {
  const { address } = useWallet()
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const tx = useProjectTransaction(state)
  const context = state.accountingContexts[contextIndex] ?? state.accountingContexts[0]
  const count = positiveAmount(amount, 18)
  const total = state.creditBalance + state.erc20Balance
  const quote = useQuery({
    queryKey: ['fund-cash-out-quote', state.chainId, state.projectId.toString(), context.terminal, context.token, count.toString(), address],
    enabled: !!address && count > 0n && count <= total && state.metadata.cashOutTaxRate < 10_000,
    retry: false,
    staleTime: 10_000,
    queryFn: () => getHookAwareCashOutQuote(client, { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, holder: address!, beneficiary: address!, tokenToReclaim: context.token, cashOutCount: count, slippageBps: 100n }),
  })
  async function submit() {
    if (!address || count <= 0n || count > total || !quote.data) return
    setError(null); setPreparing(true)
    try {
      const fresh = await freshState(client, state, address)
      if (fresh.metadata.cashOutTaxRate >= 10_000 || count > fresh.creditBalance + fresh.erc20Balance) throw new Error('Your available cash-out balance or the project terms changed. Refresh and review again.')
      const prepared = await prepareHookAwareCashOut(client, { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, holder: address, beneficiary: address, tokenToReclaim: context.token, cashOutCount: count, slippageBps: 100n })
      if (prepared.route.minimumReturn <= 0n) throw new Error('No positive protected return is available for this amount.')
      const minimum = prepared.route.minimumReturn
      await tx.send({ ...prepared.transaction, label: `Cash out ${units(count)} FUND for at least ${units(minimum, context.decimals)} ${context.symbol}` }, {
        reviewNotice: minimum < quote.data.minimumReturn ? `The quote changed. You will receive at least ${units(minimum, context.decimals)} ${context.symbol}, down from ${units(quote.data.minimumReturn, context.decimals)} ${context.symbol}.` : undefined,
        reverify: async () => {
          const latest = await freshState(client, state, address)
          if (latest.metadata.cashOutTaxRate >= 10_000 || count > latest.creditBalance + latest.erc20Balance) throw new Error('Cash-out conditions changed during review. Refresh and try again.')
        },
      })
    } catch (reason) { setError(errorMessage(reason)) } finally { setPreparing(false) }
  }
  return <ActionSection title="Cash out FUND">
    <p className="mb-5 text-sm">Burn FUND for its share of available treasury funds. This is also how onchain refunds and asset-sale proceeds are claimed. A quote includes the current cash-out rules and protocol fees.</p>
    <Input label="FUND to cash out" value={amount} onChange={setAmount} />
    {address && <button className="mt-2 text-sm underline" type="button" onClick={() => setAmount(units(total))}>Use full balance</button>}
    {state.metadata.cashOutTaxRate >= 10_000 ? <p className="mt-4">Cash-outs are disabled by the current ruleset.</p> : quote.data ? <p className="mt-4 text-sm">At least {units(quote.data.minimumReturn, context.decimals)} {context.symbol} at 1% maximum slippage.</p> : <p className="mt-4 text-sm">{quote.isFetching ? 'Reading a protected cash-out quote…' : 'Enter an amount to see the available return.'}</p>}
    {count > total && <p className="mt-3 text-sm">This exceeds your FUND balance.</p>}
    {quote.isError && <p className="mt-3 text-sm" role="alert">A protected cash-out quote is unavailable. {errorMessage(quote.error)}</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || preparing || tx.busy || tx.phase === 'review' || count <= 0n || count > total || state.metadata.cashOutTaxRate >= 10_000 || !quote.data || quote.data.minimumReturn <= 0n} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review cash-out', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-4 text-sm text-red-800">{error}</p>}
    <TransactionStatus tx={tx} chainId={state.chainId} />
  </ActionSection>
}

export function HolderActions({ state, client }: { state: FundProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const tx = useProjectTransaction(state)
  const [action, setAction] = useState<'transferTokens' | 'burn'>('transferTokens')
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const count = positiveAmount(amount, 18)
  // A deployer-launched FUND has its ERC-20 from launch and never holds credits, so the token balance is the balance.
  const available = action === 'burn' ? state.creditBalance + state.erc20Balance : state.erc20Balance
  const destination = action === 'burn' ? address : isAddress(recipient) && !isAddressEqual(recipient, zeroAddress) ? getAddress(recipient) : undefined
  const unavailable = !state.tokenAddress
  async function submit() {
    if (!address || !destination || (count <= 0n || count > available)) return
    setError(null); setPreparing(true)
    try {
      let request: TxRequest
      if (action === 'burn') request = { ...buildBurnTokensTx({ chainId: state.chainId, holder: address, projectId: state.projectId, tokenCount: count, memo: 'Voluntary FUND burn' }), address: state.controller, label: `Permanently burn ${units(count)} FUND without receiving funds` }
      else {
        if (!state.tokenAddress) throw new Error('No FUND ERC-20 is deployed.')
        request = { chainId: state.chainId, address: state.tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [destination, count], label: `Transfer ${units(count)} FUND tokens to ${destination}` }
      }
      await tx.send(request, { reverify: async () => {
        const fresh = await freshState(client, state, address)
        if (count > (action === 'burn' ? fresh.creditBalance + fresh.erc20Balance : fresh.erc20Balance)) throw new Error('Your token balance changed. Review a new amount.')
        if (fresh.tokenAddress !== state.tokenAddress) throw new Error('The project token changed. Refresh and review again.')
      } })
    } catch (reason) { setError(errorMessage(reason)) } finally { setPreparing(false) }
  }
  return <div className="grid gap-4">
    <label className="grid gap-2 text-sm">Action<select value={action} onChange={event => setAction(event.target.value as typeof action)} className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 pr-9"><option value="transferTokens">Transfer FUND tokens</option><option value="burn">Burn without receiving funds</option></select></label>
    <div className="grid gap-4 sm:grid-cols-2"><Input label="FUND amount" value={amount} onChange={setAmount} />{action === 'transferTokens' && <Input label="Recipient wallet" value={recipient} onChange={setRecipient} inputMode="text" placeholder="0x…" />}</div>
    <p className="text-sm">Available: {units(available)} FUND. {action === 'burn' ? 'Burning permanently removes these FUND and their future claims. Use cash out to receive treasury funds.' : 'The recipient receives ownership of the transferred FUND.'}</p>
    {unavailable && <p className="text-sm">This project has no FUND ERC-20.</p>}
    <button type="button" className="btn-primary min-h-11 w-fit px-5" disabled={preparing || tx.busy || tx.phase === 'review' || unavailable || (count <= 0n || count > available) || !destination} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review token action', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}<TransactionStatus tx={tx} chainId={state.chainId} />
  </div>
}

/** The payment allowlist, managed by the owner or a granted operator. Gates beneficiaries; cash outs are never gated. */
function FundAllowlist({ state, client }: { state: FundProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const tx = useProjectTransaction(state)
  const [addresses, setAddresses] = useState('')
  const [error, setError] = useState<string | null>(null)
  const allowlist = state.allowlist!
  const canManage = !!address && !!state.account && isAddressEqual(address, state.account) && state.permissions.manageAllowlist
  const accounts = addresses.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean)
  async function send(request: TxRequest, label: string) {
    if (!address) return
    setError(null)
    try {
      await tx.send({ ...request, label }, { reverify: async () => {
        const fresh = await freshState(client, state, address)
        if (!fresh.permissions.manageAllowlist || !fresh.allowlist || !isAddressEqual(fresh.allowlist.hook, allowlist.hook)) throw new Error('Allowlist authority or wiring changed. Refresh and review again.')
      } })
      setAddresses('')
    } catch (reason) { setError(errorMessage(reason)) }
  }
  return <div className="grid gap-3 border-b border-[var(--line)] pb-6" aria-label="Payment allowlist">
    <h3 className="text-[15px] font-medium">Payment allowlist</h3>
    <p className="text-sm">{allowlist.open ? 'Open: anyone can contribute.' : 'Closed: only allowed wallets can receive FUND from a contribution.'} Cash outs are never restricted.</p>
    <fieldset disabled={!canManage || tx.busy || tx.phase === 'review'} className="grid min-w-0 gap-3 border-0 p-0">
      <button type="button" className="btn-secondary min-h-11 justify-self-start px-4" onClick={() => void send(buildFundAllowlistOpen({ chainId: state.chainId, projectId: state.projectId, open: !allowlist.open }), allowlist.open ? 'Close contributions to the allowlist' : 'Open contributions to everyone')}>{allowlist.open ? 'Close to allowlist' : 'Open to everyone'}</button>
      <label className="grid gap-2 text-sm">Wallet addresses, one per line<textarea className="min-h-24 w-full rounded border border-[#bfc9b5] bg-white p-3 font-mono text-sm" value={addresses} onChange={event => setAddresses(event.target.value)} placeholder="0x…" /></label>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn-secondary min-h-11 px-4" disabled={!accounts.length} onClick={() => void send(buildFundAllowlistChange({ chainId: state.chainId, projectId: state.projectId, accounts, allowed: true }), `Allow ${accounts.length} wallet${accounts.length === 1 ? '' : 's'}`)}>Allow</button>
        <button type="button" className="btn-secondary min-h-11 px-4" disabled={!accounts.length} onClick={() => void send(buildFundAllowlistChange({ chainId: state.chainId, projectId: state.projectId, accounts, allowed: false }), `Remove ${accounts.length} wallet${accounts.length === 1 ? '' : 's'}`)}>Remove</button>
      </div>
    </fieldset>
    {!canManage && <p className="text-sm">Only the FUND owner, or a wallet the owner granted allowlist permission, can change the allowlist.</p>}
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}<TransactionStatus tx={tx} chainId={state.chainId} />
  </div>
}

export function OperatorActions({ state, client, contextIndex }: { state: FundProjectState; client: PublicClient; contextIndex: number }) {
  return <div className="grid gap-5">
    {state.allowlist && <FundAllowlist state={state} client={client} />}
    <FundOperatorActions state={state} client={client} contextIndex={contextIndex} />
  </div>
}
