'use client'

import { buildBurnTokensTx, getHookAwareCashOutQuote, prepareHookAwareCashOut } from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { erc20Abi, formatUnits, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import { FundOperatorActions } from '@/components/FundOperatorActions'
import { ProjectPayment } from '@/components/ProjectPayment'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import { readFundWriteState, type FundProjectState } from '@/lib/fund-state'
import { buildFundAllowlistChange, buildFundAllowlistOpen, parseAmount } from '@/lib/fund-contracts'
import { readableError } from '@/lib/readable-error'
import { refreshIndexedProject } from '@/lib/refresh-indexed'

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
    {tx.phase === 'submitted' ? <p>{tx.notice}</p>
      : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p>
        : tx.phase === 'success' ? <p>Confirmed onchain.</p>
          : tx.phase === 'review' ? <p>Review the exact transaction before continuing.</p> : null}
    {tx.error && <p className="text-red-800">{tx.error}</p>}
    {explorer && <a href={explorer} target="_blank" rel="noreferrer" className="underline">View transaction</a>}
  </div>
}

/** What the confirm dialog says while a submitted transaction settles, as in Juicebox Money's flows. */
function confirmStatus(tx: Tx, chainId: number): ReactNode {
  if (tx.phase === 'submitted') return tx.notice
  if (tx.phase !== 'pending') return null
  const url = tx.hash ? explorerTxUrl(chainId, tx.hash) : null
  return <>Waiting for confirmation{url && <>{' '}(<a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">view transaction</a>)</>}</>
}

/** One reviewed write, Juicebox Money's way: a frozen plan, then one action, then Done. */
function useConfirmPlan<Plan>(tx: Tx) {
  const { address } = useWallet()
  // The plan names the account it was built for, as holder or beneficiary.
  const [reviewed, setReviewed] = useState<{ plan: Plan; account: Address } | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return {
    plan: reviewed?.plan ?? null, preparing, error, setError,
    /** Fresh reads first; the dialog shows them as "preparing" and opens on the plan. */
    async prepare(read: () => Promise<Plan>) {
      const account = address
      setError(null); setPreparing(true)
      try {
        const plan = await read()
        setReviewed(account ? { plan, account } : null)
      } catch (reason) { setReviewed(null); setError(errorMessage(reason)) } finally { setPreparing(false) }
    },
    /** Sends the plan as the account it was built for; the engine refuses any other connected account. */
    async run(write: (plan: Plan, account: Address) => Promise<unknown>) {
      if (!reviewed) return
      setError(null)
      try { await write(reviewed.plan, reviewed.account) } catch (reason) { setError(errorMessage(reason)) }
    },
    /** A Safe proposal keeps tracking after close; anything else starts over. */
    close(onDone?: () => void) {
      const done = tx.phase === 'success'
      setReviewed(null); setPreparing(false); setError(null)
      tx.dismiss()
      if (done) onDone?.()
    },
    /** The dialog cannot close mid-flight, except while a Safe proposal awaits its signers. */
    busy: tx.busy && !tx.safeProposalHash,
  }
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
    refreshIndexedProject(cache, state.chainId, state.projectId)
  }, [cache, state.chainId, state.projectId, tx.phase, tx.receipt])
}

function useProjectTransaction(state: FundProjectState) {
  const tx = useSafeTx(state.chainId)
  useConfirmedRefresh(tx, state)
  return tx
}

async function freshState(client: PublicClient, state: FundProjectState, account: Address, minimumBlock?: bigint) {
  const fresh = await readFundWriteState(client, state, account)
  if (!fresh.supportedController || !fresh.supportedTerminals || !fresh.knownOwnerWrapper) throw new Error('This project no longer matches the verified FUND integration. Refresh the project before continuing.')
  if (minimumBlock !== undefined && fresh.blockNumber < minimumBlock) throw new Error('The network has not caught up with your confirmed approval. Wait a moment and try again.')
  if (!isAddressEqual(fresh.controller, state.controller)) throw new Error('The project controller changed. Refresh and review the project again.')
  return fresh
}

export function PaymentPanel({ state, client, contextIndex, chainSelector, onBusyChange }: { state: FundProjectState; client: PublicClient; contextIndex: number; chainSelector?: ReactNode; onBusyChange?: (busy: boolean) => void }) {
  const context = state.accountingContexts[contextIndex] ?? state.accountingContexts[0]
  const { address } = useWallet()
  // The hook reverts for anyone not on the list; say so before a doomed review instead of after.
  const blocked = state.allowlist && !state.allowlist.open && address && state.account && isAddressEqual(state.account, address) && state.allowlist.accountAllowed === false ? 'This wallet is not on the allowlist.' : undefined
  return <ProjectPayment blocked={blocked} quoteNeedsWallet={!!state.allowlist && !state.allowlist.open} chainSelector={chainSelector} onBusyChange={onBusyChange} chainId={state.chainId} projectId={state.projectId} tokenLabel="FUND" title="Contribute" context={context} paused={state.metadata.pausePay} reservedPercent={state.metadata.reservedPercent} rulesetId={state.ruleset.id.toString()} verify={async (account, minimumBlock) => {
    const current = await freshState(client, state, account, minimumBlock)
    const active = current.accountingContexts.find(item => isAddressEqual(item.token, context.token) && isAddressEqual(item.terminal, context.terminal))
    if (!active || active.decimals !== context.decimals || active.currency !== context.currency || current.metadata.pausePay || current.ruleset.id !== state.ruleset.id) throw new Error('The payment terminal or project rules changed. Refresh and review the payment again.')
    if (current.allowlist && !current.allowlist.open && current.allowlist.accountAllowed === false) throw new Error('This wallet is not on the allowlist.')
    return current
  }} />
}

type CashOutPlan = { count: bigint; minimum: bigint; request: TxRequest; reviewNotice?: string }

export function CashOutPanel({ state, client, contextIndex }: { state: FundProjectState; client: PublicClient; contextIndex: number }) {
  const { address } = useWallet()
  const [amount, setAmount] = useState('')
  const tx = useProjectTransaction(state)
  const confirm = useConfirmPlan<CashOutPlan>(tx)
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
  const review = () => address && quote.data && confirm.prepare(async () => {
    const fresh = await freshState(client, state, address)
    if (fresh.metadata.cashOutTaxRate >= 10_000 || count > fresh.creditBalance + fresh.erc20Balance) throw new Error('Your available cash-out balance or the project terms changed. Refresh and review again.')
    const prepared = await prepareHookAwareCashOut(client, { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, holder: address, beneficiary: address, tokenToReclaim: context.token, cashOutCount: count, slippageBps: 100n })
    if (prepared.route.minimumReturn <= 0n) throw new Error('No positive protected return is available for this amount.')
    const minimum = prepared.route.minimumReturn
    return {
      count, minimum,
      request: { ...prepared.transaction, label: `Cash out ${units(count)} FUND for at least ${units(minimum, context.decimals)} ${context.symbol}` },
      reviewNotice: minimum < quote.data!.minimumReturn ? `The quote changed. You will receive at least ${units(minimum, context.decimals)} ${context.symbol}, down from ${units(quote.data!.minimumReturn, context.decimals)} ${context.symbol}.` : undefined,
    }
  })
  const send = () => confirm.run((plan, account) => tx.send(plan.request, {
    reviewedAccount: account,
    reviewNotice: plan.reviewNotice,
    reverify: async () => {
      const latest = await freshState(client, state, account)
      if (latest.metadata.cashOutTaxRate >= 10_000 || plan.count > latest.creditBalance + latest.erc20Balance) throw new Error('Cash-out conditions changed during review. Refresh and try again.')
    },
  }))
  const plan = confirm.plan
  const rows: TxConfirmRow[] = plan ? [
    { label: 'Cash out', value: `${units(plan.count)} FUND`, strong: true },
    { label: 'On', value: displayChainName(state.chainId) },
    { label: 'You get at least', value: `${units(plan.minimum, context.decimals)} ${context.symbol}`, strong: true },
    { label: 'Route', value: 'Project treasury' },
  ] : []
  return <ActionSection title="Cash out FUND">
    <p className="mb-5 text-sm">Burn FUND for its share of available treasury funds. This is also how onchain refunds and asset-sale proceeds are claimed. A quote includes the current cash-out rules and protocol fees.</p>
    <Input label="FUND to cash out" value={amount} onChange={setAmount} />
    {address && <button className="mt-2 text-sm underline" type="button" onClick={() => setAmount(units(total))}>Use full balance</button>}
    {state.metadata.cashOutTaxRate >= 10_000 ? <p className="mt-4">Cash-outs are disabled by the current ruleset.</p> : quote.data ? <p className="mt-4 text-sm">At least {units(quote.data.minimumReturn, context.decimals)} {context.symbol} at 1% maximum slippage.</p> : <p className="mt-4 text-sm">{quote.isFetching ? 'Reading a protected cash-out quote…' : 'Enter an amount to see the available return.'}</p>}
    {count > total && <p className="mt-3 text-sm">This exceeds your FUND balance.</p>}
    {quote.isError && <p className="mt-3 text-sm" role="alert">A protected cash-out quote is unavailable. {errorMessage(quote.error)}</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || confirm.preparing || tx.busy || tx.phase === 'review' || count <= 0n || count > total || state.metadata.cashOutTaxRate >= 10_000 || !quote.data || quote.data.minimumReturn <= 0n} onClick={() => void review()}>Review cash-out</button>
    {!plan && !confirm.preparing && confirm.error && <p role="alert" className="mt-4 text-sm text-red-800">{confirm.error}</p>}
    {!plan && <TransactionStatus tx={tx} chainId={state.chainId} />}
    <TxConfirmDialog
      open={!!plan || confirm.preparing}
      preparing={confirm.preparing}
      title={tx.phase === 'success' ? 'Cashed out' : 'Confirm cash out'}
      rows={rows}
      steps={[{ key: 'cash-out', title: 'Cash out FUND', detail: 'Burns your FUND and pays its share of the treasury to your wallet.' }]}
      activeIndex={0}
      action="Confirm & cash out"
      onConfirm={() => void send()}
      busy={confirm.busy}
      complete={tx.phase === 'success'}
      settled={tx.phase === 'submitted'}
      status={confirm.preparing ? 'Getting a fresh cash-out quote…' : confirmStatus(tx, state.chainId)}
      error={confirm.error ?? tx.error}
      onClose={() => confirm.close(() => setAmount(''))}
    />
  </ActionSection>
}

type HolderPlan = { action: 'transferTokens' | 'burn'; count: bigint; destination: Address; request: TxRequest }

export function HolderActions({ state, client }: { state: FundProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const tx = useProjectTransaction(state)
  const confirm = useConfirmPlan<HolderPlan>(tx)
  const [action, setAction] = useState<'transferTokens' | 'burn'>('transferTokens')
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const count = positiveAmount(amount, 18)
  // A deployer-launched FUND has its ERC-20 from launch and never holds credits, so the token balance is the balance.
  const available = action === 'burn' ? state.creditBalance + state.erc20Balance : state.erc20Balance
  const destination = action === 'burn' ? address : isAddress(recipient) && !isAddressEqual(recipient, zeroAddress) ? getAddress(recipient) : undefined
  const unavailable = !state.tokenAddress
  const review = () => address && destination && confirm.prepare(async () => {
    if (action === 'burn') return { action, count, destination, request: { ...buildBurnTokensTx({ chainId: state.chainId, holder: address, projectId: state.projectId, tokenCount: count, memo: 'Voluntary FUND burn' }), address: state.controller, label: `Permanently burn ${units(count)} FUND without receiving funds` } }
    if (!state.tokenAddress) throw new Error('No FUND ERC-20 is deployed.')
    return { action, count, destination, request: { chainId: state.chainId, address: state.tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [destination, count], label: `Transfer ${units(count)} FUND tokens to ${destination}` } }
  })
  const send = () => confirm.run((plan, account) => tx.send(plan.request, { reviewedAccount: account, reverify: async () => {
    const fresh = await freshState(client, state, account)
    if (plan.count > (plan.action === 'burn' ? fresh.creditBalance + fresh.erc20Balance : fresh.erc20Balance)) throw new Error('Your token balance changed. Review a new amount.')
    if (fresh.tokenAddress !== state.tokenAddress) throw new Error('The project token changed. Refresh and review again.')
  } }))
  const plan = confirm.plan
  const burning = plan?.action === 'burn'
  const rows: TxConfirmRow[] = plan ? [
    { label: burning ? 'Burn' : 'Transfer', value: `${units(plan.count)} FUND`, strong: true },
    ...(burning ? [] : [{ label: 'To', value: plan.destination, mono: true }]),
    { label: 'On', value: displayChainName(state.chainId) },
    ...(burning ? [{ label: 'You get', value: 'Nothing. Use cash out to receive treasury funds.' }] : []),
  ] : []
  return <div className="grid gap-4">
    <label className="grid gap-2 text-sm">Action<select value={action} onChange={event => setAction(event.target.value as typeof action)} className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 pr-9"><option value="transferTokens">Transfer FUND tokens</option><option value="burn">Burn without receiving funds</option></select></label>
    <div className="grid gap-4 sm:grid-cols-2"><Input label="FUND amount" value={amount} onChange={setAmount} />{action === 'transferTokens' && <Input label="Recipient wallet" value={recipient} onChange={setRecipient} inputMode="text" placeholder="0x…" />}</div>
    <p className="text-sm">Available: {units(available)} FUND. {action === 'burn' ? 'Burning permanently removes these FUND and their future claims. Use cash out to receive treasury funds.' : 'The recipient receives ownership of the transferred FUND.'}</p>
    {unavailable && <p className="text-sm">This project has no FUND ERC-20.</p>}
    <button type="button" className="btn-primary min-h-11 w-fit px-5" disabled={confirm.preparing || tx.busy || tx.phase === 'review' || unavailable || (count <= 0n || count > available) || !destination} onClick={() => void review()}>{action === 'burn' ? 'Review burn' : 'Review transfer'}</button>
    {!plan && confirm.error && <p role="alert" className="text-sm text-red-800">{confirm.error}</p>}
    {!plan && <TransactionStatus tx={tx} chainId={state.chainId} />}
    <TxConfirmDialog
      open={!!plan}
      title={tx.phase === 'success' ? (burning ? 'Burned' : 'Transferred') : burning ? 'Confirm burn' : 'Confirm transfer'}
      rows={rows}
      steps={[{ key: plan?.action ?? 'action', title: burning ? 'Burn FUND' : 'Transfer FUND' }]}
      activeIndex={0}
      action={burning ? 'Confirm & burn' : 'Confirm & transfer'}
      onConfirm={() => void send()}
      busy={confirm.busy}
      complete={tx.phase === 'success'}
      settled={tx.phase === 'submitted'}
      status={confirmStatus(tx, state.chainId)}
      error={confirm.error ?? tx.error}
      onClose={() => confirm.close(() => { setAmount(''); setRecipient('') })}
    />
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
      await tx.send({ ...request, label }, { reviewedAccount: address, reverify: async () => {
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
