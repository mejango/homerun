'use client'

import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildBurnTokensTx, buildClaimTokensTx, buildPayTx, buildSetPermissionsTx, buildTransferCreditsTx,
  getBorrowableAmount, getHookAwareCashOutQuote, hasPermissions, prepareHookAwareCashOut,
  previewPay, REVLOANS_BURN_PERMISSION_ID,
} from '@bananapus/nana-sdk-core/v6'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { erc20Abi, formatUnits, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import Image from 'next/image'
import { IncomeLoanTools } from '@/components/IncomeLoanTools'
import { IncomeBridgeActions } from '@/components/IncomeBridgeActions'
import { IncomeReservedTokens } from '@/components/IncomeReservedTokens'
import { ProjectActivity } from '@/components/ProjectActivity'
import { DisplayTokenAmount } from '@/components/DisplayTokenAmount'
import { InitialIncomeClaim } from '@/components/InitialIncomeClaim'
import { StickyHolder } from '@/components/StickyHolder'
import { useSafeTx, txPhaseLabel, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import { HomerunProjectLayout, OwnersTabs } from '@/components/HomerunProjectLayout'
import { ProjectParticipants } from '@/components/ProjectParticipants'
import { ProjectPayerAddresses } from '@/components/ProjectPayerAddresses'
import { ProjectShop } from '@/components/ProjectShop'
import { AvailableTransactions } from '@/components/AvailableTransactions'
import { fetchFundProjectMetadata } from '@/lib/fund-project-metadata'
import { parseAmount } from '@/lib/fund-contracts'
import { readFundProjectState } from '@/lib/fund-state'
import { readIncomeFundBinding } from '@/lib/income-fund-binding'
import { readIncomeStickyBinding } from '@/lib/sticky-state'
import {
  buildAutoIssueTx, buildIncomeRewardActivation, buildIncomeRewardClaim, buildProtectedIncomeBorrow,
  buildRepayLoanTx, protectedIncomeMinimum, v6Address,
} from '@/lib/income-contracts'
import {
  readIncomeAutoIssuance, readIncomeLoan, readIncomeProjectState,
  type IncomeAccountingContext, type IncomeProjectState,
} from '@/lib/income-state'

function message(reason: unknown) { return reason instanceof Error ? reason.message : 'The transaction could not be prepared. Refresh and try again.' }
function amount(value: string, decimals = 18) { try { return parseAmount(value.trim(), decimals) } catch { return 0n } }
function units(value: bigint, decimals = 18) { return formatUnits(value, decimals) }
type IncomeTx = ReturnType<typeof useSafeTx>

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7"><h3 className="mb-5 text-2xl">{title}</h3>{children}</section>
}
function Field({ label, value, onChange, text = false }: { label: string; value: string; onChange: (value: string) => void; text?: boolean }) {
  return <label className="grid gap-2 text-sm">{label}<input className="min-h-12 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base" value={value} onChange={event => onChange(event.target.value)} inputMode={text ? 'text' : 'decimal'} autoComplete="off" /></label>
}
function Status({ tx, chainId }: { tx: IncomeTx; chainId: number }) {
  const link = tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null
  return <div className="mt-4 break-words text-sm" role="status" aria-live="polite">
    {tx.safeProposalHash ? <p>Proposed to Safe. The action still needs execution and onchain confirmation.</p> : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p> : tx.phase === 'success' ? <p>Confirmed onchain.</p> : null}
    {tx.error && <p className="text-red-800">{tx.error}</p>}{link && <a className="underline" href={link} target="_blank" rel="noreferrer">View transaction</a>}
  </div>
}

function useIncomeTx(state: IncomeProjectState) {
  const tx = useSafeTx(state.chainId)
  const cache = useQueryClient()
  const confirmed = useRef<string | null>(null)
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.receipt || confirmed.current === tx.receipt.transactionHash) return
    confirmed.current = tx.receipt.transactionHash
    for (const prefix of ['income-project', 'income-reserved', 'income-pay', 'income-cash-out', 'income-borrow', 'income-loan', 'income-allowance', 'income-permission']) void cache.invalidateQueries({ queryKey: [prefix, state.chainId, state.projectId.toString()] })
    if (state.rewards) void cache.invalidateQueries({ queryKey: ['fund-project', state.chainId, state.rewards.fundProjectId.toString()] })
  }, [cache, state.chainId, state.projectId, state.rewards, tx.phase, tx.receipt])
  return tx
}

async function fresh(client: PublicClient, state: IncomeProjectState, account: Address, minimumBlock?: bigint) {
  const result = await readIncomeProjectState(client, { chainId: state.chainId, projectId: state.projectId, account, fundProjectId: state.rewards?.fundProjectId })
  if (minimumBlock !== undefined && result.blockNumber < minimumBlock) throw new Error('The RPC has not caught up with your confirmed prerequisite. Wait a moment and try again.')
  if (!isAddressEqual(result.controller, state.controller) || result.tokenAddress !== state.tokenAddress) throw new Error('The project contracts changed. Refresh before continuing.')
  return result
}
function matchingContext(state: IncomeProjectState, context: IncomeAccountingContext) {
  const current = state.accountingContexts.find(entry => isAddressEqual(entry.token, context.token) && isAddressEqual(entry.terminal, context.terminal))
  if (!current || !current.isPrimary || current.decimals !== context.decimals || current.currency !== context.currency) throw new Error('The payment terminal or accounting currency changed. Refresh the project.')
  return current
}

export type IncomeProjectSlots = {
  projectId?: bigint
  fundProjectId?: bigint
  state?: IncomeProjectState
  treasuryMetric: ReactNode
  supplyMetric: ReactNode
  title: string
  description: string | null
  logoUrl: string | null
  notice: ReactNode
  payment: ReactNode
  activity: ReactNode
  overview: ReactNode
  stages: ReactNode
  accountsYou: ReactNode
  accountsAll: ReactNode
  market: ReactNode
  settlement: ReactNode
  splits: ReactNode
  loans: ReactNode
  shop: ReactNode
  extras: ReactNode
}

/** A single retained read supplies every slot, including a linked FUND page. */
export function IncomeProjectRuntime({ chainId, projectId, fundProjectId, bindingUnavailable = false, children }: {
  chainId: JBChainId; projectId?: bigint; fundProjectId?: bigint; bindingUnavailable?: boolean
  children: (slots: IncomeProjectSlots) => ReactNode
}) {
  const { address } = useWallet()
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const [lastState, setLastState] = useState<IncomeProjectState | null>(null)
  const source = useQuery({
    queryKey: ['income-fund-binding', chainId, projectId?.toString()], enabled: !!client && projectId !== undefined && fundProjectId === undefined,
    queryFn: () => readIncomeFundBinding(client!, { chainId, incomeProjectId: projectId! }), staleTime: 300_000, retry: 1,
  })
  const resolvedFundId = fundProjectId ?? source.data ?? undefined
  const query = useQuery({
    queryKey: ['income-project', chainId, projectId?.toString(), address ?? null, fundProjectId?.toString()],
    enabled: !!client && projectId !== undefined,
    queryFn: () => readIncomeProjectState(client!, { chainId, projectId: projectId!, account: address, fundProjectId }),
    staleTime: 10_000, refetchInterval: 20_000, retry: 1, placeholderData: keepPreviousData,
  })
  useEffect(() => { if (query.data) setLastState(query.data) }, [query.data])
  const retained = query.data ?? lastState
  const displayState = retained?.chainId === chainId && retained.projectId === projectId ? retained : undefined
  const accountMatches = query.data?.account ? !!address && isAddressEqual(query.data.account, address) : !address
  const writesUnavailable = bindingUnavailable || query.isError || query.isPlaceholderData || !query.data || !accountMatches
  const details = useQuery({ queryKey: ['fund-project-metadata', displayState?.projectUri], enabled: !!displayState?.projectUri, queryFn: () => fetchFundProjectMetadata(displayState!.projectUri), staleTime: 300_000, retry: 1 })
  const notice = projectId === undefined ? null : <>
    {query.isPending && <p role="status">Reading the INCOME contracts…</p>}
    {query.isError && <div role="alert"><p>INCOME could not be verified. Its transactions are unavailable.</p><p className="mt-2 text-sm">{message(query.error)}</p><button type="button" className="btn-secondary mt-4" onClick={() => void query.refetch()}>Try again</button></div>}
    {bindingUnavailable && <p role="status">The FUND connection is being reverified. Pending INCOME transactions remain tracked; new actions wait for verification.</p>}
    {fundProjectId === undefined && source.isError && <p className="mb-4 text-sm" role="alert">The original FUND connection could not be discovered. INCOME transactions remain available. <button type="button" className="underline" onClick={() => void source.refetch()}>Retry connection</button></p>}
  </>
  // This component stays in the same tree position while a linked ID/read loads.
  return <IncomeActions state={displayState} client={client} fundProjectId={resolvedFundId} writesUnavailable={writesUnavailable} notice={notice} title={details.data?.name ?? `Revenue project ${projectId ?? ''}`} description={details.data?.description ?? null} logoUrl={details.data?.logoUrl ?? null} projectId={projectId} chainId={chainId}>{children}</IncomeActions>
}

export function IncomeProject({ chainId, projectId, fundProjectId }: { chainId: JBChainId; projectId: bigint; fundProjectId?: bigint }) {
  return <IncomeProjectRuntime chainId={chainId} projectId={projectId} fundProjectId={fundProjectId}>{slots => <HomerunProjectLayout
    title={slots.title}
    logo={slots.logoUrl && <Image unoptimized src={slots.logoUrl} width={112} height={112} alt={`${slots.title} logo`} />}
    metadata={[displayChainName(chainId), `INCOME #${projectId}`, slots.state?.metadata.pausePay ? 'Payments paused' : slots.state ? 'Revenue open' : 'Verifying contracts', slots.treasuryMetric, slots.supplyMetric]}
    notice={slots.notice}
    actions={<AvailableTransactions stage="earning" />}
    payment={slots.payment}
    activity={slots.activity}
    overview={<div className="grid gap-7"><Panel title="Description"><p className="whitespace-pre-line">{slots.description ?? 'Revenue funds this project’s treasury and issues INCOME according to its current onchain rules.'}</p></Panel>{slots.overview}</div>}
    stages={slots.stages}
    owners={<OwnersTabs accountsYou={slots.accountsYou} accountsAll={slots.accountsAll} market={slots.market} settlement={slots.settlement} splits={slots.splits} loans={slots.loans} />}
    shop={slots.shop}
    extras={slots.extras}
    operators={<Panel title="INCOME administration"><p>INCOME follows its deployed revnet schedule. Allocations and loan operations are available to their beneficiaries under Owners.</p>{slots.fundProjectId && <a className="mt-4 inline-block underline" href={`/project/${chainId}/${slots.fundProjectId}`}>Open FUND operator controls →</a>}</Panel>}
  />}</IncomeProjectRuntime>
}

function IncomeActions({ state, client, fundProjectId, writesUnavailable, notice, title, description, logoUrl, projectId, chainId, children }: {
  state?: IncomeProjectState; client?: PublicClient; fundProjectId?: bigint; writesUnavailable: boolean; notice: ReactNode
  title: string; description: string | null; logoUrl: string | null; projectId?: bigint; chainId: JBChainId
  children: (slots: IncomeProjectSlots) => ReactNode
}) {
  const [selectedToken, setSelectedToken] = useState<Address | undefined>()
  const primary = state?.accountingContexts.filter(item => item.isPrimary) ?? []
  const context = primary.find(item => item.token === selectedToken) ?? primary[0]
  const ready = !!state && !!client
  const gate = (content: ReactNode) => <fieldset aria-label="INCOME transactions" disabled={writesUnavailable} className="m-0 grid min-w-0 gap-7 border-0 p-0">{content}</fieldset>
  const currency = ready && primary.length > 0 && <label className="mb-5 grid gap-2 text-sm">INCOME treasury currency<select className="min-h-11 rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={context?.token} onChange={event => setSelectedToken(event.target.value as Address)}>{primary.map(item => <option key={item.token} value={item.token}>{item.symbol}</option>)}</select></label>
  return children({
    projectId, fundProjectId, state, title, description, logoUrl, notice,
    treasuryMetric: context && <span>INCOME treasury: <DisplayTokenAmount value={context.balance} decimals={context.decimals} /> {context.symbol}</span>,
    supplyMetric: state && <span>INCOME supply: <DisplayTokenAmount value={state.totalSupply} /></span>,
    payment: gate(<>{ready && context ? <IncomePayment state={state} client={client} context={context} currency={currency} /> : <p>{projectId ? 'Loading INCOME payment options…' : 'INCOME has not been launched.'}</p>}</>),
    activity: projectId && <ProjectActivity chainId={chainId} projectId={projectId} />,
    overview: state && <Panel title="Revenue"><dl className="grid gap-5 sm:grid-cols-2"><div><dt>INCOME supply</dt><dd><DisplayTokenAmount value={state.totalSupply} /> INCOME</dd></div><div><dt>Payments</dt><dd>{state.metadata.pausePay ? 'Paused' : 'Open'}</dd></div>{state.accountingContexts.map(item => <div key={`${item.terminal}:${item.token}`}><dt>Treasury</dt><dd><DisplayTokenAmount value={item.balance} decimals={item.decimals} /> {item.symbol}</dd></div>)}</dl><p className="mt-4 text-sm">Verified at block {state.blockNumber.toString()}. INCOME is separate from FUND and does not grant an asset-sale claim.</p></Panel>,
    stages: state && <Panel title="INCOME schedule"><dl className="grid gap-4"><div><dt>Current ruleset</dt><dd>{state.ruleset.id.toString()}</dd></div><div><dt>Started</dt><dd>{new Date(Number(state.ruleset.start) * 1_000).toLocaleString()}</dd></div><div><dt>Cash-outs and loans</dt><dd>{state.cashOutsAvailable ? 'Available under the current contract terms' : `Unlock ${new Date(Number(state.cashOutDelay) * 1_000).toLocaleString()}`}</dd></div></dl><p className="mt-4">Initial INCOME allocations and ongoing Sticky rewards are separate. Sticky rewards vest in four weekly rounds after a claim is materialized.</p></Panel>,
    accountsYou: gate(ready && <><Panel title="Your INCOME"><p className="break-words text-2xl"><DisplayTokenAmount value={state.totalBalance} /> INCOME</p><p className="mt-2 text-sm"><DisplayTokenAmount value={state.creditBalance} /> credits / <DisplayTokenAmount value={state.erc20Balance} /> ERC-20 tokens</p></Panel><IncomeTokenActions state={state} client={client} />{fundProjectId && <InitialIncomeClaim chainId={state.chainId} fundProjectId={fundProjectId} incomeProjectId={state.projectId} />}<IncomeHolderRewards state={state} client={client} fundProjectId={fundProjectId} /></>),
    accountsAll: projectId && <ProjectParticipants chainId={chainId} projectId={projectId} tokenLabel="INCOME" />,
    market: gate(ready && context && <>{currency}<IncomeCashOut state={state} client={client} context={context} /></>),
    settlement: gate(ready && <IncomeBridgeActions state={state} />),
    splits: gate(ready && <><IncomeReservedTokens state={state} client={client} /><IncomeAutoIssue state={state} client={client} /></>),
    loans: gate(ready && <>{currency}{context && <IncomeBorrow state={state} client={client} context={context} />}<IncomeRepay state={state} client={client} /><IncomeLoanTools state={state} client={client} /></>),
    shop: projectId && <ProjectShop chainId={chainId} projectId={projectId} tokenLabel="INCOME" />,
    extras: projectId && <ProjectPayerAddresses chainId={chainId} projectId={projectId} tokenLabel="INCOME" />,
  })
}

function IncomeHolderRewards({ state, client, fundProjectId }: { state: IncomeProjectState; client: PublicClient; fundProjectId?: bigint }) {
  const fundId = fundProjectId ?? state.rewards?.fundProjectId
  const identity = `${state.chainId}:${state.projectId}:${fundId ?? ''}`
  const [lastBinding, setLastBinding] = useState<{ identity: string; stickyProjectId: bigint } | null>(null)
  const binding = useQuery({
    queryKey: ['income-sticky-binding', state.chainId, state.projectId.toString(), fundId?.toString()],
    enabled: fundId !== undefined,
    queryFn: () => readIncomeStickyBinding(client, { chainId: state.chainId, incomeProjectId: state.projectId, fundProjectId: fundId! }),
    staleTime: 10_000, refetchInterval: 20_000, retry: 1,
  })
  useEffect(() => { if (binding.data) setLastBinding({ identity, stickyProjectId: binding.data.stickyProjectId }) }, [binding.data, identity])
  const stickyProjectId = binding.data?.stickyProjectId ?? (lastBinding?.identity === identity ? lastBinding.stickyProjectId : undefined)
  if (fundId && stickyProjectId) return <fieldset aria-label="Verified Sticky connection" disabled={binding.isError || !binding.data} className="m-0 min-w-0 border-0 p-0">
    {(binding.isError || !binding.data) && <p className="mb-3 text-sm" role="alert">The Sticky connection could not be refreshed. Pending transactions remain visible; new actions wait for verification.</p>}
    <StickyHolder key={`${identity}:${stickyProjectId}`} chainId={state.chainId} fundProjectId={fundId} incomeProjectId={state.projectId} stickyProjectId={stickyProjectId} />
  </fieldset>
  // Preserve access to an existing direct-FUND distributor only when its actual
  // split and canonical FUND token have been independently verified.
  if (state.rewards) return <IncomeRewards state={state} client={client} />
  if (!fundId) return null
  return <Panel title="Ongoing FUND rewards">
    <p>Homerun uses Sticky shares for ongoing reward snapshots. Initial INCOME claims remain separate and require no staking.</p>
    {binding.isPending ? <p className="mt-3 text-sm" role="status">Verifying the Sticky connection…</p> : binding.isError ? <p className="mt-3 text-sm" role="alert">The Sticky connection could not be verified. {message(binding.error)}</p> : <p className="mt-3 text-sm">No verified Sticky reward connection is available for this project.</p>}
  </Panel>
}

function IncomePayment({ state, client, context, currency }: { state: IncomeProjectState; client: PublicClient; context: IncomeAccountingContext; currency?: ReactNode }) {
  const { address } = useWallet()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const tx = useIncomeTx(state)
  const approval = useIncomeTx(state)
  const count = amount(input, context.decimals)
  const native = isAddressEqual(context.token, NATIVE_TOKEN)
  const prerequisite = approval.phase === 'success' ? approval.receipt?.blockNumber : undefined
  const quote = useQuery({
    queryKey: ['income-pay', state.chainId, state.projectId.toString(), context.token, count.toString(), address],
    enabled: !!address && count > 0n && !state.metadata.pausePay,
    queryFn: () => previewPay(client, { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, token: context.token, amount: count, beneficiary: address! }),
    retry: false, staleTime: 10_000,
  })
  const minimum = quote.data?.beneficiaryTokenCount && quote.data.beneficiaryTokenCount > 0n ? protectedIncomeMinimum(quote.data.beneficiaryTokenCount) : 0n
  const zeroCustomerIssuance = state.metadata.reservedPercent === 10_000 && quote.data?.beneficiaryTokenCount === 0n && quote.data.reservedTokenCount > 0n
  const hasQuote = minimum > 0n || zeroCustomerIssuance
  const busy = preparing || tx.busy || approval.busy || tx.phase === 'review' || approval.phase === 'review'
  async function submit() {
    if (!address || count <= 0n || !hasQuote) return
    setPreparing(true); setError(null)
    try {
      const current = await fresh(client, state, address, prerequisite)
      matchingContext(current, context)
      if (current.metadata.pausePay) throw new Error('Payments are paused.')
      if (!native) {
        const allowance = await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, context.terminal], blockNumber: current.blockNumber })
        if (allowance < count) {
          await approval.send({ chainId: state.chainId, address: context.token, abi: erc20Abi, functionName: 'approve', args: [context.terminal, count], label: `Approve exactly ${units(count, context.decimals)} ${context.symbol} for this INCOME payment` }, { reverify: async () => { matchingContext(await fresh(client, state, address), context) } })
          return
        }
      }
      const latest = await previewPay(client, { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, token: context.token, amount: count, beneficiary: address })
      const zeroOutput = current.metadata.reservedPercent === 10_000 && latest.beneficiaryTokenCount === 0n && latest.reservedTokenCount > 0n
      const protectedMinimum = zeroOutput ? 0n : protectedIncomeMinimum(latest.beneficiaryTokenCount)
      await tx.send({ ...buildPayTx({ chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, token: context.token, amount: count, beneficiary: address, minReturnedTokens: protectedMinimum, memo: 'Homerun INCOME payment' }), label: `Pay ${units(count, context.decimals)} ${context.symbol}; receive at least ${units(protectedMinimum)} INCOME` }, {
        simulationBlockNumber: prerequisite === undefined ? undefined : current.blockNumber,
        reviewNotice: zeroOutput ? 'You receive no INCOME for this payment. This revnet allocates 100% of new INCOME to its reserved recipients.' : protectedMinimum < minimum ? `The quote decreased. Your protected minimum is now ${units(protectedMinimum)} INCOME.` : undefined,
        reverify: async () => {
          const latestState = await fresh(client, state, address, prerequisite)
          matchingContext(latestState, context)
          if (latestState.metadata.pausePay) throw new Error('Payments were paused during review.')
        },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  return <Panel title="Pay the project">
    {currency}
    <Field label={`Amount in ${context.symbol}`} value={input} onChange={setInput} />
    <p className="mt-4 text-sm">{zeroCustomerIssuance ? 'This payment gives you no INCOME. All new INCOME is allocated to the reserved recipients.' : minimum > 0n ? `Receive at least ${units(minimum)} INCOME with 1% maximum slippage. Reserved INCOME goes to the configured recipients.` : 'Enter an amount to get a live INCOME quote.'}</p>
    {quote.isError && <p role="alert" className="mt-3 text-sm">The payment quote is unavailable. {message(quote.error)}</p>}
    {approval.phase === 'success' && <p className="mt-3 text-sm">Approval confirmed. Continue to review the payment.</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || busy || count <= 0n || !hasQuote || state.metadata.pausePay} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(approval.busy ? approval.phase : tx.phase, { idle: 'Review payment', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={approval} chainId={state.chainId} /><Status tx={tx} chainId={state.chainId} />
  </Panel>
}

function IncomeCashOut({ state, client, context }: { state: IncomeProjectState; client: PublicClient; context: IncomeAccountingContext }) {
  const { address } = useWallet()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const tx = useIncomeTx(state)
  const count = amount(input)
  const quote = useQuery({
    queryKey: ['income-cash-out', state.chainId, state.projectId.toString(), context.token, count.toString(), address],
    enabled: !!address && count > 0n && count <= state.totalBalance && state.cashOutsAvailable,
    queryFn: () => getHookAwareCashOutQuote(client, { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, tokenToReclaim: context.token, cashOutCount: count, holder: address!, beneficiary: address!, slippageBps: 100n }),
    staleTime: 10_000, retry: false,
  })
  async function submit() {
    if (!address || count <= 0n || !quote.data) return
    setPreparing(true); setError(null)
    try {
      const current = await fresh(client, state, address)
      matchingContext(current, context)
      if (!current.cashOutsAvailable || count > current.totalBalance) throw new Error('Your cash-out balance or unlock time changed.')
      const prepared = await prepareHookAwareCashOut(client, { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, tokenToReclaim: context.token, cashOutCount: count, holder: address, beneficiary: address, slippageBps: 100n })
      if (prepared.route.minimumReturn <= 0n) throw new Error('No positive protected cash-out return is available.')
      await tx.send({ ...prepared.transaction, label: `Cash out ${units(count)} INCOME for at least ${units(prepared.route.minimumReturn, context.decimals)} ${context.symbol}` }, {
        reviewNotice: prepared.route.minimumReturn < quote.data.minimumReturn ? `The quote decreased. Your new protected minimum is ${units(prepared.route.minimumReturn, context.decimals)} ${context.symbol}.` : undefined,
        reverify: async () => { const latest = await fresh(client, state, address); matchingContext(latest, context); if (!latest.cashOutsAvailable || count > latest.totalBalance) throw new Error('Cash-out conditions changed during review.') },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  return <Panel title="Cash out INCOME">
    <p className="mb-5 text-sm">Burn INCOME for available revenue reserves. The live quote includes the revnet’s hooks and applicable fees.</p>
    <Field label="INCOME to cash out" value={input} onChange={setInput} />
    <button type="button" className="mt-2 text-sm underline" onClick={() => setInput(units(state.totalBalance))}>Use full balance</button>
    {quote.data && <p className="mt-4 text-sm">At least {units(quote.data.minimumReturn, context.decimals)} {context.symbol} with 1% maximum slippage.</p>}
    {quote.isError && <p role="alert" className="mt-3 text-sm">{message(quote.error)}</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || preparing || tx.busy || tx.phase === 'review' || !state.cashOutsAvailable || count <= 0n || count > state.totalBalance || !quote.data || quote.data.minimumReturn <= 0n} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review cash-out', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={tx} chainId={state.chainId} />
  </Panel>
}

function IncomeTokenActions({ state, client }: { state: IncomeProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const tx = useIncomeTx(state)
  const [action, setAction] = useState('claim')
  const [input, setInput] = useState('')
  const [recipient, setRecipient] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const count = amount(input)
  const transfer = action === 'transferTokens' || action === 'transferCredits'
  const destination = transfer ? isAddress(recipient) && !isAddressEqual(recipient, zeroAddress) ? getAddress(recipient) : null : address
  const balance = action === 'transferTokens' ? state.erc20Balance : action === 'burn' ? state.totalBalance : state.creditBalance
  async function submit() {
    if (!address || !destination || count <= 0n) return
    setPreparing(true); setError(null)
    try {
      let request: TxRequest
      const base = { chainId: state.chainId, projectId: state.projectId, holder: address }
      if (action === 'claim') request = { ...buildClaimTokensTx({ ...base, tokenCount: count, beneficiary: address }), label: `Claim ${units(count)} INCOME credits as ERC-20 tokens` }
      else if (action === 'transferCredits') request = { ...buildTransferCreditsTx({ ...base, creditCount: count, recipient: destination }), label: `Transfer ${units(count)} INCOME credits to ${destination}` }
      else if (action === 'burn') request = { ...buildBurnTokensTx({ ...base, tokenCount: count, memo: 'Voluntary INCOME burn' }), label: `Permanently burn ${units(count)} INCOME without receiving funds` }
      else { if (!state.tokenAddress) throw new Error('No INCOME ERC-20 is deployed.'); request = { chainId: state.chainId, address: state.tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [destination, count], label: `Transfer ${units(count)} INCOME tokens to ${destination}` } }
      await tx.send(request, { reverify: async () => {
        const latest = await fresh(client, state, address)
        const available = action === 'transferTokens' ? latest.erc20Balance : action === 'burn' ? latest.totalBalance : latest.creditBalance
        if (count > available) throw new Error('Your INCOME balance changed.')
        if (action === 'transferCredits' && latest.metadata.pauseCreditTransfers) throw new Error('Credit transfers are paused.')
      } })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  return <Panel title="Manage INCOME tokens">
    <label className="mb-4 grid gap-2 text-sm">Action<select className="min-h-11 rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={action} onChange={event => setAction(event.target.value)}><option value="claim">Claim credits as ERC-20</option><option value="transferTokens">Transfer ERC-20 tokens</option><option value="transferCredits">Transfer credits</option><option value="burn">Burn without receiving funds</option></select></label>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="INCOME amount" value={input} onChange={setInput} />{transfer && <Field label="Recipient address" value={recipient} onChange={setRecipient} text />}</div>
    <p className="mt-3 text-sm">Available: {units(balance)} INCOME</p>
    {action === 'burn' && <p className="mt-3 text-sm">Burning permanently reduces your balance. Use cash out to receive treasury funds.</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || !destination || count <= 0n || count > balance || preparing || tx.busy || tx.phase === 'review'} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review transaction', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={tx} chainId={state.chainId} />
  </Panel>
}

function IncomeBorrow({ state, client, context }: { state: IncomeProjectState; client: PublicClient; context: IncomeAccountingContext }) {
  const { address } = useWallet()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const tx = useIncomeTx(state)
  const grant = useIncomeTx(state)
  const count = amount(input)
  const loans = v6Address('REVLoans', state.chainId)
  const prerequisite = grant.phase === 'success' ? grant.receipt?.blockNumber : undefined
  const quote = useQuery({
    queryKey: ['income-borrow', state.chainId, state.projectId.toString(), context.token, count.toString(), address],
    enabled: !!address && count > 0n && count <= state.totalBalance && state.cashOutsAvailable,
    queryFn: () => getBorrowableAmount(client, { chainId: state.chainId, revnetId: state.projectId, collateralCount: count, decimals: BigInt(context.decimals), currency: BigInt(context.currency) }),
    staleTime: 10_000, retry: false,
  })
  async function submit() {
    if (!address || count <= 0n) return
    setPreparing(true); setError(null)
    try {
      const current = await fresh(client, state, address, prerequisite)
      matchingContext(current, context)
      if (!current.cashOutsAvailable || count > current.totalBalance) throw new Error('The collateral or borrowing unlock time changed.')
      const permitted = await hasPermissions(client, { chainId: state.chainId, account: address, operator: loans, projectId: state.projectId, permissionIds: [REVLOANS_BURN_PERMISSION_ID], includeRoot: true, includeWildcardProjectId: true })
      if (!permitted) {
        await grant.send({ ...buildSetPermissionsTx({ chainId: state.chainId, account: address, operator: loans, projectId: state.projectId, permissionIds: [REVLOANS_BURN_PERMISSION_ID] }), label: 'Allow REVLoans to burn this project’s INCOME as loan collateral' }, { reverify: async () => { await fresh(client, state, address) } })
        return
      }
      const latestQuote = await getBorrowableAmount(client, { chainId: state.chainId, revnetId: state.projectId, collateralCount: count, decimals: BigInt(context.decimals), currency: BigInt(context.currency) })
      const minimum = protectedIncomeMinimum(latestQuote.borrowableNow)
      await tx.send({ ...buildProtectedIncomeBorrow({ chainId: state.chainId, revnetId: state.projectId, token: context.token, quotedBorrowAmount: latestQuote.borrowableNow, collateralCount: count, holder: address, beneficiary: address }), label: `Borrow against ${units(count)} INCOME; minimum ${units(minimum, context.decimals)} ${context.symbol} before loan fees` }, {
        simulationBlockNumber: prerequisite === undefined ? undefined : current.blockNumber,
        reviewNotice: 'The source prepaid fee is 2.5%. Protocol and REV fees also reduce wallet proceeds. Your INCOME becomes loan collateral; repayment is required to recover it. Unpaid loans can be liquidated after the contract’s ten-year term.',
        reverify: async () => { const latest = await fresh(client, state, address, prerequisite); matchingContext(latest, context); if (!latest.cashOutsAvailable || count > latest.totalBalance) throw new Error('The borrowing conditions changed during review.') },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  return <Panel title="Borrow against INCOME">
    <Field label="INCOME collateral" value={input} onChange={setInput} />
    <p className="mt-4 text-sm">Borrowing locks your INCOME claim in a loan NFT. Repaying restores the collateral. The minimum prepaid source fee is 2.5%; protocol and REV fees also apply.</p>
    {quote.data && <p className="mt-3 text-sm">Currently borrowable before fees: {units(quote.data.borrowableNow, context.decimals)} {context.symbol}. The transaction protects this quote with 1% slippage.</p>}
    {quote.isError && <p role="alert" className="mt-3 text-sm">{message(quote.error)}</p>}
    {grant.phase === 'success' && <p className="mt-3 text-sm">Collateral permission confirmed. Continue to review the loan.</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || preparing || tx.busy || grant.busy || tx.phase === 'review' || grant.phase === 'review' || count <= 0n || count > state.totalBalance || !state.cashOutsAvailable || !quote.data || quote.data.borrowableNow <= 0n} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(grant.busy ? grant.phase : tx.phase, { idle: 'Review borrowing', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={grant} chainId={state.chainId} /><Status tx={tx} chainId={state.chainId} />
  </Panel>
}

function IncomeRepay({ state, client }: { state: IncomeProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const tx = useIncomeTx(state)
  const approval = useIncomeTx(state)
  const loanId = /^\d+$/.test(input.trim()) ? BigInt(input.trim()) : 0n
  const prerequisite = approval.phase === 'success' ? approval.receipt?.blockNumber : undefined
  const loan = useQuery({ queryKey: ['income-loan', state.chainId, state.projectId.toString(), loanId.toString(), address], enabled: !!address && loanId > 0n, queryFn: () => readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId, account: address! }), staleTime: 10_000, retry: false })
  async function submit() {
    if (!address || loanId <= 0n) return
    setPreparing(true); setError(null)
    try {
      await fresh(client, state, address, prerequisite)
      const current = await readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId, account: address })
      if (prerequisite !== undefined && current.blockNumber < prerequisite) throw new Error('The network has not caught up with the confirmed token approval.')
      const loans = v6Address('REVLoans', state.chainId)
      const native = isAddressEqual(current.sourceContext.token, NATIVE_TOKEN)
      let maximum = current.repayCeiling
      if (!native) {
        const approved = await client.readContract({ address: current.sourceContext.token, abi: erc20Abi, functionName: 'allowance', args: [address, loans], blockNumber: current.blockNumber })
        if (approved < current.loan.amount + current.accruedFee) {
          await approval.send({ chainId: state.chainId, address: current.sourceContext.token, abi: erc20Abi, functionName: 'approve', args: [loans, current.repayCeiling], label: `Approve up to ${units(current.repayCeiling, current.sourceContext.decimals)} ${current.sourceContext.symbol} to repay loan ${loanId}` }, { reverify: async () => { await readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId, account: address }) } })
          return
        }
        // Fees keep accruing after approval. Reuse its remaining buffer instead
        // of repeatedly asking to approve a newly calculated, slightly higher ceiling.
        if (approved < maximum) maximum = approved
      }
      await tx.send({ ...buildRepayLoanTx({ chainId: state.chainId, loanId, maxRepayBorrowAmount: maximum, collateralCountToReturn: current.loan.collateral, beneficiary: address, value: native ? maximum : 0n }), label: `Repay loan ${loanId}; spend at most ${units(maximum, current.sourceContext.decimals)} ${current.sourceContext.symbol}` }, {
        simulationBlockNumber: prerequisite === undefined ? undefined : current.blockNumber,
        reviewNotice: `Recover ${units(current.loan.collateral)} INCOME. The maximum includes outstanding principal, accrued fees, and a 0.1% principal buffer. Unused funds are refunded.`,
        reverify: async () => { const latest = await readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId, account: address }); if (latest.loan.collateral !== current.loan.collateral || latest.loan.amount !== current.loan.amount || latest.loan.amount + latest.accruedFee > maximum) throw new Error('The loan changed or its fees exceeded the reviewed maximum. Review a fresh repayment.'); if (prerequisite !== undefined && latest.blockNumber < prerequisite) throw new Error('The RPC is behind the confirmed approval.') },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  return <Panel title="Repay an INCOME loan">
    <Field label="Loan NFT ID" value={input} onChange={setInput} />
    {loan.data && <p className="mt-4 text-sm">Return {units(loan.data.loan.collateral)} INCOME by spending at most {units(loan.data.repayCeiling, loan.data.sourceContext.decimals)} {loan.data.sourceContext.symbol}, including accrued fees and a small refundable buffer.</p>}
    {loan.isError && <p role="alert" className="mt-3 text-sm">{message(loan.error)}</p>}
    {approval.phase === 'success' && <p className="mt-3 text-sm">Approval confirmed. Continue to review repayment.</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || !loan.data || loan.isError || preparing || tx.busy || approval.busy || tx.phase === 'review' || approval.phase === 'review'} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(approval.busy ? approval.phase : tx.phase, { idle: 'Review full repayment', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={approval} chainId={state.chainId} /><Status tx={tx} chainId={state.chainId} />
  </Panel>
}

function IncomeAutoIssue({ state, client }: { state: IncomeProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const [stage, setStage] = useState('')
  const [beneficiary, setBeneficiary] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const tx = useIncomeTx(state)
  const stageId = /^\d+$/.test(stage.trim()) ? BigInt(stage.trim()) : 0n
  const target = beneficiary.trim() === '' ? address : isAddress(beneficiary.trim()) && !isAddressEqual(beneficiary.trim() as Address, zeroAddress) ? getAddress(beneficiary.trim()) : null
  async function submit() {
    if (!address || !target || stageId <= 0n) return
    setPreparing(true); setError(null)
    try {
      const current = await readIncomeAutoIssuance(client, { chainId: state.chainId, projectId: state.projectId, stageId, beneficiary: target })
      await tx.send({ ...buildAutoIssueTx({ chainId: state.chainId, revnetId: state.projectId, stageId, beneficiary: target }), label: `Materialize ${units(current.amount)} scheduled INCOME for ${target}` }, { reverify: async () => { const latest = await readIncomeAutoIssuance(client, { chainId: state.chainId, projectId: state.projectId, stageId, beneficiary: target }); if (latest.amount !== current.amount) throw new Error('This allocation changed or was already issued.') } })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  return <Panel title="Collect a scheduled allocation">
    <p className="mb-5 text-sm">Anyone can trigger an existing stage allocation after it unlocks. Tokens always go to the beneficiary recorded by the revnet.</p>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Stage ruleset ID" value={stage} onChange={setStage} /><Field label="Beneficiary address (defaults to your wallet)" value={beneficiary} onChange={setBeneficiary} text /></div>
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || !target || stageId <= 0n || preparing || tx.busy || tx.phase === 'review'} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review allocation', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={tx} chainId={state.chainId} />
  </Panel>
}

function IncomeRewards({ state, client }: { state: IncomeProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const tx = useIncomeTx(state)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const rewards = state.rewards!
  const activated = !!address && rewards.delegate !== null && isAddressEqual(rewards.delegate, address)
  async function submit(action: 'activate' | 'vest' | 'collect') {
    if (!address || !state.tokenAddress) return
    setPreparing(true); setError(null)
    try {
      let request: TxRequest
      if (action === 'activate') {
        const fund = await readFundProjectState(client, { chainId: state.chainId, projectId: rewards.fundProjectId, account: address })
        if (!fund.tokenAddress || !isAddressEqual(fund.tokenAddress, rewards.fundToken)) throw new Error('The FUND token identity changed.')
        if (fund.creditBalance > 0n) {
          request = { ...buildClaimTokensTx({ chainId: state.chainId, projectId: rewards.fundProjectId, holder: address, tokenCount: fund.creditBalance, beneficiary: address }), label: `Claim ${units(fund.creditBalance)} FUND credits before activating future rewards` }
          await tx.send(request, { reverify: async () => { const latest = await readFundProjectState(client, { chainId: state.chainId, projectId: rewards.fundProjectId, account: address }); if (latest.creditBalance < fund.creditBalance || latest.tokenAddress !== fund.tokenAddress) throw new Error('Your FUND credits changed. Refresh and try again.') } })
          return
        }
        if (fund.erc20Balance <= 0n) throw new Error('This wallet has no FUND ERC-20 tokens to activate.')
        request = { ...buildIncomeRewardActivation(state.chainId, rewards.fundToken, address), label: 'Activate future FUND-holder rewards by self-delegating FUND voting power' }
      } else request = { ...buildIncomeRewardClaim({ chainId: state.chainId, fundToken: rewards.fundToken, incomeToken: state.tokenAddress, holder: address, collect: action === 'collect' }), label: action === 'collect' ? 'Collect vested INCOME rewards to your wallet' : 'Begin vesting eligible historical INCOME rewards' }
      await tx.send(request, {
        reviewNotice: action === 'activate' ? 'FUND stays transferable in your wallet. Only ERC-20 voting power at future reward snapshots participates. Existing delegation to someone else is replaced; rewards already snapshotted are unchanged.' : undefined,
        reverify: async () => { const latest = await fresh(client, state, address); if (!latest.rewards || !isAddressEqual(latest.rewards.distributor, rewards.distributor) || !isAddressEqual(latest.rewards.fundToken, rewards.fundToken)) throw new Error('The reward configuration changed during review.') },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  const busy = preparing || tx.busy || tx.phase === 'review'
  return <Panel title="FUND-holder INCOME rewards">
    <p className="mb-4 text-sm">FUND remains in your wallet. Claim any FUND credits, then self-delegate once to activate future rewards. Receiving more FUND after activation automatically increases your voting power for later snapshots.</p>
    <p className="mb-4 text-sm">Each round uses historical delegated voting power. Activating after its snapshot does not earn that round retroactively; delegating to someone else gives them the reward weight. Historical rewards begin vesting when claimed.</p>
    <dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt>Reward activation</dt><dd>{activated ? 'Self-delegated' : 'Not self-delegated'}</dd></div><div><dt>Current voting power</dt><dd>{units(rewards.votes)} FUND</dd></div><div><dt>Currently collectible</dt><dd>{units(rewards.collectable)} INCOME</dd></div><div><dt>Vesting duration after claim</dt><dd>{units(rewards.vestingRounds * rewards.roundDuration / 86_400n, 0)} days</dd></div></dl>
    <p className="mt-4 text-sm">Current funding becomes claimable after {new Date(Number(rewards.nextRoundStart) * 1_000).toLocaleString()}.{rewards.claimDuration > 0n ? ` Unclaimed rounds expire after ${units(rewards.claimDuration / 86_400n, 0)} days.` : ' Unclaimed rounds do not expire.'}</p>
    {rewards.fundCreditBalance > 0n && <p className="mt-3 text-sm">{units(rewards.fundCreditBalance)} FUND credits must be claimed as ERC-20 tokens before they can earn future rewards.</p>}
    <div className="mt-5 flex flex-wrap gap-3"><button type="button" className="btn-primary min-h-11 px-5" disabled={!address || busy || (activated && rewards.fundCreditBalance === 0n)} onClick={() => void submit('activate')}>{rewards.fundCreditBalance > 0n ? 'Claim FUND credits' : 'Activate rewards'}</button><button type="button" className="btn-secondary min-h-11 px-5" disabled={!address || busy} onClick={() => void submit('vest')}>Begin vesting</button><button type="button" className="btn-secondary min-h-11 px-5" disabled={!address || busy || rewards.collectable <= 0n} onClick={() => void submit('collect')}>Collect vested INCOME</button></div>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={tx} chainId={state.chainId} />
  </Panel>
}
