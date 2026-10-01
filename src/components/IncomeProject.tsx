'use client'

import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildBurnTokensTx, buildSetPermissionsTx,
  getBorrowableAmount, getHookAwareCashOutQuote, hasPermissions, prepareHookAwareCashOut,
  REVLOANS_BURN_PERMISSION_ID,
} from '@bananapus/nana-sdk-core/v6'
import { netLoanProceeds } from '@bananapus/nana-sdk-core/v6/loan-math'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { erc20Abi, formatUnits, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import Image from 'next/image'
import { IncomeLoanTools } from '@/components/IncomeLoanTools'
import { IncomeBridgeActions } from '@/components/IncomeBridgeActions'
import { IncomeReservedTokens } from '@/components/IncomeReservedTokens'
import { IncomeOperatorActions } from '@/components/IncomeOperatorActions'
import { ProjectActivity } from '@/components/ProjectActivity'
import { DisplayTokenAmount } from '@/components/DisplayTokenAmount'
import { InitialIncomeMint } from '@/components/InitialIncomeMint'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { getLoans } from '@/lib/loans-queries'
import { useSafeTx, txPhaseLabel, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import { HomerunProjectLayout, OwnersTabs } from '@/components/HomerunProjectLayout'
import { ProjectPageShell } from '@/components/ProjectPage'
import { ProjectParticipants } from '@/components/ProjectParticipants'
import { ProjectPayerAddresses } from '@/components/ProjectPayerAddresses'
import { ProjectShop } from '@/components/ProjectShop'
import { LiveProjectActions } from '@/components/LiveProjectActions'
import { ProjectPayment } from '@/components/ProjectPayment'
import { CurrentOperatorProfile, CurrentOwnerProfile } from '@/components/CurrentOperatorProfile'
import { ProjectMetadataEditor } from '@/components/ProjectMetadataEditor'
import { ProjectOwnershipEditor } from '@/components/ProjectOwnershipEditor'
import { ProjectPermissionsEditor } from '@/components/ProjectPermissionsEditor'
import { ProjectSplitsEditor } from '@/components/ProjectSplitsEditor'
import { fetchFundProjectMetadata, type FundProjectMetadata } from '@/lib/fund-project-metadata'
import { parseAmount } from '@/lib/fund-contracts'
import { buildErc20ApproveRequest } from '@/lib/transaction-builders'
import { readFundProjectState } from '@/lib/fund-state'
import { readIncomeFundBinding } from '@/lib/income-fund-binding'
import {
  buildAutoIssueTx, buildIncomeRewardActivation, buildIncomeRewardClaim, buildProtectedIncomeBorrow,
  buildRepayLoanTx, protectedIncomeMinimum, v6Address,
} from '@/lib/income-contracts'
import {
  readIncomeAutoIssuance, readIncomeLoan, readIncomeProjectState,
  type IncomeAccountingContext, type IncomeProjectState,
} from '@/lib/income-state'
import { readableError } from '@/lib/readable-error'

function message(reason: unknown) { return readableError(reason, 'The transaction could not be prepared. Refresh and try again.') }
function amount(value: string, decimals = 18) { try { return parseAmount(value.trim(), decimals) } catch { return 0n } }
function units(value: bigint, decimals = 18) { return formatUnits(value, decimals) }
type IncomeTx = ReturnType<typeof useSafeTx>

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="demo-section"><h2>{title}</h2>{children}</section>
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
    void cache.invalidateQueries({ queryKey: ['loans', state.chainId, Number(state.projectId)] })
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
  writesUnavailable?: boolean
  bindingUnavailable?: boolean
  control?: ReactNode
  permissions?: ReactNode
  treasuryMetric: ReactNode
  supplyMetric: ReactNode
  title: string
  description: string | null
  details?: FundProjectMetadata
  logoUrl: string | null
  location?: string | null
  notice: ReactNode
  payment: ReactNode
  activity: ReactNode
  overview: ReactNode
  stages: ReactNode
  accountsYou: ReactNode
  accountsAll: ReactNode
  settlement: ReactNode
  splits: ReactNode
  loans: ReactNode
  shop: ReactNode
  extras: ReactNode
  operators: ReactNode
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
  const confirmed = useQuery<bigint>({ queryKey: ['project-admin-confirmed-block', chainId, projectId?.toString()], queryFn: async () => 0n, enabled: false, initialData: 0n })
  const query = useQuery({
    queryKey: ['income-project', chainId, projectId?.toString(), address ?? null, fundProjectId?.toString()],
    enabled: !!client && projectId !== undefined,
    queryFn: () => readIncomeProjectState(client!, { chainId, projectId: projectId!, account: address, fundProjectId }),
    retry: 1, placeholderData: keepPreviousData,
  })
  useEffect(() => { if (query.data) setLastState(query.data) }, [query.data])
  const retained = query.data ?? lastState
  const displayState = retained?.chainId === chainId && retained.projectId === projectId ? retained : undefined
  const accountMatches = query.data?.account ? !!address && isAddressEqual(query.data.account, address) : !address
  const writesUnavailable = bindingUnavailable || query.isError || query.isPlaceholderData || !query.data || !accountMatches || query.data.blockNumber < (confirmed.data ?? 0n)
  const details = useQuery({ queryKey: ['fund-project-metadata', displayState?.projectUri], enabled: !!displayState?.projectUri, queryFn: () => fetchFundProjectMetadata(displayState!.projectUri), staleTime: 300_000, retry: 1 })
  const notice = projectId === undefined ? null : <>
    {query.isPending && <p role="status">Reading the INCOME contracts…</p>}
    {query.isError && <div role="alert"><p>INCOME could not be verified. Its transactions are unavailable.</p><p className="mt-2 text-xs text-[var(--muted)]">{message(query.error)}</p><button type="button" className="btn-secondary mt-4" onClick={() => void query.refetch()}>Try again</button></div>}
    {bindingUnavailable && <p role="status">The FUND connection is being reverified. Pending INCOME transactions remain tracked; new actions wait for verification.</p>}
    {fundProjectId === undefined && source.isError && <p className="mb-4 text-sm" role="alert">The original FUND connection could not be discovered. INCOME transactions remain available. <button type="button" className="underline" onClick={() => void source.refetch()}>Retry connection</button></p>}
  </>
  // This component stays in the same tree position while a linked ID/read loads.
  return <IncomeActions state={displayState} client={client} fundProjectId={resolvedFundId} writesUnavailable={writesUnavailable} bindingUnavailable={bindingUnavailable} notice={notice} title={details.data?.name ?? `Revenue project ${projectId ?? ''}`} description={details.data?.description ?? null} details={details.data} logoUrl={details.data?.logoUrl ?? details.data?.coverUrl ?? null} location={details.data?.location ?? null} projectId={projectId} chainId={chainId}>{children}</IncomeActions>
}

export function IncomeProject({ chainId, projectId, fundProjectId }: { chainId: JBChainId; projectId: bigint; fundProjectId?: bigint }) {
  return <IncomeProjectRuntime chainId={chainId} projectId={projectId} fundProjectId={fundProjectId}>{slots => <ProjectPageShell><HomerunProjectLayout
    title={slots.title}
    location={slots.location}
    logo={slots.logoUrl && <Image unoptimized src={slots.logoUrl} width={112} height={112} alt={`${slots.title} logo`} />}
    metadata={[<span key="status" id="project-status" className="project-status" role="status">Status: {slots.state?.metadata.pausePay ? 'Payments paused' : slots.state ? 'Revenue open' : 'Verifying contracts'}</span>, slots.treasuryMetric, slots.supplyMetric]}
    notice={slots.notice}
    payment={slots.payment}
    activity={slots.activity}
    overview={<StandaloneIncomeOverview chainId={chainId} slots={slots} />}
    stages={slots.stages}
    owners={<OwnersTabs accountsYou={slots.accountsYou} accountsAll={slots.accountsAll} settlement={slots.settlement} splits={slots.splits} loans={slots.loans} />}
    shop={slots.shop}
    extras={<div className="demo-owner-sections">{slots.extras}<Panel title="Contracts"><dl className="demo-live-rows"><div><dt>Network</dt><dd>{displayChainName(chainId)}</dd></div><div><dt>INCOME project</dt><dd>#{projectId.toString()}</dd></div>{slots.fundProjectId && <div><dt>FUND project</dt><dd>#{slots.fundProjectId.toString()}</dd></div>}{slots.state && <div><dt>Project owner</dt><dd>{slots.state.owner}</dd></div>}{slots.state && <div><dt>Controller</dt><dd>{slots.state.controller}</dd></div>}{slots.state?.tokenAddress && <div><dt>INCOME ERC-20</dt><dd>{slots.state.tokenAddress}</dd></div>}</dl></Panel></div>}
    operators={<div className="demo-owner-sections">{slots.operators}{slots.control}{slots.permissions}<Panel title="INCOME administration"><p>INCOME follows its deployed revnet schedule. Beneficiaries manage allocations and loans under Owners.</p>{slots.fundProjectId && <a className="quiet-button mt-4 inline-block" href={`/project/${chainId}/${slots.fundProjectId}`}>Open FUND Owner controls →</a>}</Panel></div>}
  /></ProjectPageShell>}</IncomeProjectRuntime>
}

/** Public asset roles belong to FUND; INCOME governance and wallet permissions are separate. */
function StandaloneIncomeOverview({ chainId, slots }: { chainId: JBChainId; slots: IncomeProjectSlots }) {
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const binding = useQuery({
    queryKey: ['income-fund-binding', chainId, slots.projectId?.toString()],
    enabled: !!client && slots.projectId !== undefined,
    queryFn: () => readIncomeFundBinding(client!, { chainId, incomeProjectId: slots.projectId! }),
    staleTime: 300_000, retry: 1,
  })
  // A URL's FUND hint cannot identify the asset's public Owner or Operator.
  const fundProjectId = binding.isError ? undefined : binding.data ?? undefined
  const fund = useQuery({
    queryKey: ['fund-project', chainId, fundProjectId?.toString()],
    enabled: !!client && fundProjectId !== undefined,
    queryFn: () => readFundProjectState(client!, { chainId, projectId: fundProjectId! }),
    retry: 1,
  })
  const currentFund = fund.data?.chainId === chainId && fund.data.projectId === fundProjectId ? fund.data : undefined
  const confirmedFund = useQuery<bigint>({ queryKey: ['project-admin-confirmed-block', chainId, fundProjectId?.toString()], queryFn: async () => 0n, enabled: false, initialData: 0n })
  const fundDetails = useQuery({
    queryKey: ['fund-project-metadata', currentFund?.projectUri],
    enabled: !!currentFund?.projectUri,
    queryFn: () => fetchFundProjectMetadata(currentFund!.projectUri),
    staleTime: 300_000, retry: 1,
  })
  const details = slots.details?.plan ? slots.details : fundDetails.data ?? slots.details
  const owner = currentFund?.knownOwnerWrapper ? currentFund.owner : null
  return <div className="demo-owner-sections">
    <Panel title="About"><p className="whitespace-pre-line">{slots.description ?? details?.description ?? 'Revenue funds this project’s treasury and issues INCOME according to its current onchain rules.'}</p>{client && slots.projectId && <div className="mt-5"><ProjectMetadataEditor chainId={chainId} projectId={slots.projectId} client={client} unavailable={slots.writesUnavailable} inheritedMetadataUri={currentFund?.projectUri} label="Edit INCOME details" /></div>}</Panel>
    {slots.overview}
    <CurrentOwnerProfile chainId={chainId} owner={owner ?? undefined} details={details} unavailable={binding.isError || fund.isError || !!currentFund && (!currentFund.knownOwnerWrapper || currentFund.blockNumber < (confirmedFund.data ?? 0n))} />
    <CurrentOperatorProfile chainId={chainId} incomeProjectId={slots.projectId} fundDetails={details} bindingUnavailable={slots.bindingUnavailable} />
    {(binding.isError || fund.isError || fundDetails.isError) && <p role="status" className="text-xs text-[var(--muted)]">The FUND Owner and Operator details could not be refreshed.</p>}
  </div>
}

function IncomeActions({ state, client, fundProjectId, writesUnavailable, bindingUnavailable, notice, title, description, details, logoUrl, location, projectId, chainId, children }: {
  state?: IncomeProjectState; client?: PublicClient; fundProjectId?: bigint; writesUnavailable: boolean; bindingUnavailable: boolean; notice: ReactNode
  title: string; description: string | null; details?: FundProjectMetadata; logoUrl: string | null; location: string | null; projectId?: bigint; chainId: JBChainId
  children: (slots: IncomeProjectSlots) => ReactNode
}) {
  const [selectedToken, setSelectedToken] = useState<Address | undefined>()
  const primary = state?.accountingContexts.filter(item => item.isPrimary) ?? []
  const context = primary.find(item => item.token === selectedToken) ?? primary[0]
  const ready = !!state && !!client
  const gate = (content: ReactNode) => <fieldset aria-label="INCOME transactions" disabled={writesUnavailable} className="m-0 grid min-w-0 gap-7 border-0 p-0">{content}</fieldset>
  const currency = ready && primary.length > 0 && <label className="grid gap-2 text-sm">INCOME treasury currency<select className="min-h-11 rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={context?.token} onChange={event => setSelectedToken(event.target.value as Address)}>{primary.map(item => <option key={item.token} value={item.token}>{item.symbol}</option>)}</select></label>
  return children({
    projectId, fundProjectId, state, title, description, details, logoUrl, location, notice, writesUnavailable, bindingUnavailable,
    control: ready ? <ProjectOwnershipEditor chainId={chainId} projectId={state.projectId} client={client} unavailable={writesUnavailable} /> : <Panel title="INCOME control"><p>Reading project ownership…</p></Panel>,
    permissions: ready ? <ProjectPermissionsEditor chainId={chainId} projectId={state.projectId} client={client} unavailable={writesUnavailable} /> : <Panel title="INCOME permissions"><p>Reading project permissions…</p></Panel>,
    treasuryMetric: context && <span>INCOME treasury: <DisplayTokenAmount value={context.balance} decimals={context.decimals} /> {context.symbol}</span>,
    supplyMetric: state && <span>INCOME supply: <DisplayTokenAmount value={state.totalSupply} /></span>,
    payment: gate(<>{ready && context ? <IncomePayment state={state} client={client} context={context} /> : <p>{projectId ? 'Loading INCOME payment options…' : 'INCOME has not been launched.'}</p>}</>),
    activity: projectId && <ProjectActivity chainId={chainId} projectId={projectId} />,
    overview: state && <Panel title="Revenue"><dl className="demo-live-rows"><div><dt>INCOME supply</dt><dd><DisplayTokenAmount value={state.totalSupply} /> INCOME</dd></div><div><dt>Payments</dt><dd>{state.metadata.pausePay ? 'Paused' : 'Open'}</dd></div>{state.accountingContexts.map(item => <div key={`${item.terminal}:${item.token}`}><dt>Treasury</dt><dd><DisplayTokenAmount value={item.balance} decimals={item.decimals} /> {item.symbol}</dd></div>)}</dl><p>Verified at block {state.blockNumber.toString()}. INCOME carries no claim on asset-sale proceeds.</p></Panel>,
    stages: state && <div className="demo-owner-sections"><LiveProjectActions token="INCOME" state={{cashOutsEnabled: state.cashOutsAvailable, hasInitialAllocation: !!fundProjectId}} /><Panel title="INCOME schedule"><dl className="demo-live-rows"><div><dt>Current ruleset</dt><dd>{state.ruleset.id.toString()}</dd></div><div><dt>Started</dt><dd>{new Date(Number(state.ruleset.start) * 1_000).toLocaleString()}</dd></div><div><dt>Cash-outs and loans</dt><dd>{state.cashOutsAvailable ? 'Available' : `Unlock ${new Date(Number(state.cashOutDelay) * 1_000).toLocaleString()}`}</dd></div></dl><p>Sticky rewards are separate from initial allocations and vest over four weekly rounds after a claim.</p></Panel></div>,
    accountsYou: gate(ready && <><Panel title="Your INCOME"><dl className="demo-live-rows"><div><dt>INCOME</dt><dd><DisplayTokenAmount value={state.totalBalance} /></dd></div><div><dt>Credits</dt><dd><DisplayTokenAmount value={state.creditBalance} /></dd></div><div><dt>ERC-20 tokens</dt><dd><DisplayTokenAmount value={state.erc20Balance} /></dd></div></dl></Panel><IncomeTokenActions state={state} client={client} />{fundProjectId && <InitialIncomeMint chainId={state.chainId} fundProjectId={fundProjectId} incomeProjectId={state.projectId} manifestUri={details?.incomeManifestUri ?? null} />}<IncomeHolderRewards state={state} client={client} fundProjectId={fundProjectId} />{context && <>{currency}<IncomeCashOut state={state} client={client} context={context} /></>}</>),
    accountsAll: projectId && <ProjectParticipants chainId={chainId} projectId={projectId} tokenLabel="INCOME" />,
    settlement: gate(ready && <IncomeBridgeActions state={state} />),
    splits: <div className="demo-owner-sections">{ready && <ProjectSplitsEditor chainId={chainId} projectId={state.projectId} phase="income" client={client} unavailable={writesUnavailable} />}{gate(ready && <><IncomeReservedTokens state={state} client={client} /><IncomeAutoIssue state={state} client={client} /></>)}</div>,
    loans: gate(ready && <>{currency}{context && <IncomeBorrow state={state} client={client} context={context} />}<IncomeLoansList state={state} client={client} /><IncomeLoanTools state={state} client={client} /></>),
    shop: projectId && <ProjectShop chainId={chainId} projectId={projectId} tokenLabel="INCOME" />,
    extras: projectId && <ProjectPayerAddresses chainId={chainId} projectId={projectId} tokenLabel="INCOME" />,
    operators: gate(ready && <IncomeOperatorActions state={state} client={client} />),
  })
}

function IncomeHolderRewards({ state, client, fundProjectId }: { state: IncomeProjectState; client: PublicClient; fundProjectId?: bigint }) {
  const fundId = fundProjectId ?? state.rewards?.fundProjectId
  // Preserve access to an existing direct-FUND distributor only when its actual
  // split and canonical FUND token have been independently verified.
  if (state.rewards) return <IncomeRewards state={state} client={client} />
  if (!fundId) return null
  return <Panel title="Ongoing FUND rewards">
    <p>The owner holds the reserved share of new INCOME until it is split further. The initial INCOME allocation needs no staking.</p>
  </Panel>
}

function IncomePayment({ state, client, context }: { state: IncomeProjectState; client: PublicClient; context: IncomeAccountingContext }) {
  return <ProjectPayment chainId={state.chainId} projectId={state.projectId} tokenLabel="INCOME" title="Pay the project" context={context} paused={state.metadata.pausePay} reservedPercent={state.metadata.reservedPercent} rulesetId={state.ruleset.id.toString()} verify={async (account, minimumBlock) => {
    const current = await fresh(client, state, account, minimumBlock)
    matchingContext(current, context)
    if (current.metadata.pausePay || current.ruleset.id !== state.ruleset.id) throw new Error('The payment rules changed. Refresh and review the payment again.')
    return current
  }} />
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
    <p className="mb-5">Burn INCOME for revenue reserves. The quote includes hooks and fees.</p>
    <Field label="INCOME to cash out" value={input} onChange={setInput} />
    <button type="button" className="quiet-button mt-2" onClick={() => setInput(units(state.totalBalance))}>Use full balance</button>
    {quote.data && <p className="mt-4 text-xs text-[var(--muted)]">At least {units(quote.data.minimumReturn, context.decimals)} {context.symbol} with 1% maximum slippage.</p>}
    {quote.isError && <p role="alert" className="mt-3 text-sm">{message(quote.error)}</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || preparing || tx.busy || tx.phase === 'review' || !state.cashOutsAvailable || count <= 0n || count > state.totalBalance || !quote.data || quote.data.minimumReturn <= 0n} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review cash-out', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={tx} chainId={state.chainId} />
  </Panel>
}

function IncomeTokenActions({ state, client }: { state: IncomeProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const tx = useIncomeTx(state)
  const [action, setAction] = useState('transferTokens')
  const [input, setInput] = useState('')
  const [recipient, setRecipient] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const count = amount(input)
  const transfer = action === 'transferTokens'
  const destination = transfer ? isAddress(recipient) && !isAddressEqual(recipient, zeroAddress) ? getAddress(recipient) : null : address
  // A revnet has its ERC-20 from launch and never holds credits, so the token balance is the balance.
  const balance = action === 'burn' ? state.totalBalance : state.erc20Balance
  async function submit() {
    if (!address || !destination || count <= 0n) return
    setPreparing(true); setError(null)
    try {
      let request: TxRequest
      const base = { chainId: state.chainId, projectId: state.projectId, holder: address }
      if (action === 'burn') request = { ...buildBurnTokensTx({ ...base, tokenCount: count, memo: 'Voluntary INCOME burn' }), label: `Permanently burn ${units(count)} INCOME without receiving funds` }
      else { if (!state.tokenAddress) throw new Error('No INCOME ERC-20 is deployed.'); request = { chainId: state.chainId, address: state.tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [destination, count], label: `Transfer ${units(count)} INCOME tokens to ${destination}` } }
      await tx.send(request, { reverify: async () => {
        const latest = await fresh(client, state, address)
        const available = action === 'burn' ? latest.totalBalance : latest.erc20Balance
        if (count > available) throw new Error('Your INCOME balance changed.')
      } })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  return <Panel title="Manage INCOME tokens">
    <label className="mb-4 grid gap-2 text-sm sm:max-w-xs">Action<select className="min-h-11 rounded border border-[#bfc9b5] bg-white px-3 pr-9" value={action} onChange={event => setAction(event.target.value)}><option value="transferTokens">Transfer INCOME tokens</option><option value="burn">Burn without receiving funds</option></select></label>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="INCOME amount" value={input} onChange={setInput} />{transfer && <Field label="Recipient address" value={recipient} onChange={setRecipient} text />}</div>
    <p className="mt-3 text-xs text-[var(--muted)]">Available: {units(balance)} INCOME</p>
    {action === 'burn' && <p className="mt-3 text-xs text-[var(--muted)]">Burning is permanent and pays nothing. Cash out to receive treasury funds.</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || !destination || count <= 0n || count > balance || preparing || tx.busy || tx.phase === 'review'} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review transaction', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={tx} chainId={state.chainId} />
  </Panel>
}

/** Prepaid-fee choices, out of 1000, as in Juicebox Money's loan flow. 2.5% is the onchain minimum. */
const PREPAID_OPTIONS = [{ value: 25n, label: '2.5%' }, { value: 50n, label: '5%' }, { value: 100n, label: '10%' }] as const

/** A confirmed prerequisite's block, so the next step can pin to it. A Safe proposal is not awaited here. */
async function prerequisiteBlock(client: PublicClient, hash: `0x${string}` | null, safe: boolean): Promise<bigint | null> {
  if (!hash || safe) return null
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success') throw new Error('The prerequisite transaction reverted onchain.')
  return receipt.blockNumber
}

export function IncomeBorrow({ state, client, context }: { state: IncomeProjectState; client: PublicClient; context: IncomeAccountingContext }) {
  const { address } = useWallet()
  const [input, setInput] = useState('')
  const [prepaid, setPrepaid] = useState<bigint>(25n)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  // Juicebox Money's loan flow: review the loan and its wallet steps, then one action runs them in order.
  const [reviewing, setReviewing] = useState(false)
  const [stage, setStage] = useState<'permission' | 'borrow' | null>(null)
  const tx = useIncomeTx(state)
  const grant = useIncomeTx(state)
  const count = amount(input)
  const loans = v6Address('REVLoans', state.chainId)
  const confirmedGrant = grant.phase === 'success' ? grant.receipt?.blockNumber : undefined
  const quote = useQuery({
    queryKey: ['income-borrow', state.chainId, state.projectId.toString(), context.token, count.toString(), address],
    enabled: !!address && count > 0n && count <= state.totalBalance && state.cashOutsAvailable,
    queryFn: () => getBorrowableAmount(client, { chainId: state.chainId, revnetId: state.projectId, collateralCount: count, decimals: BigInt(context.decimals), currency: BigInt(context.currency) }),
    staleTime: 10_000, retry: false,
  })
  const permission = useQuery({
    queryKey: ['income-permission', state.chainId, state.projectId.toString(), 'revloans-burn', address],
    enabled: !!address && reviewing,
    queryFn: () => hasPermissions(client, { chainId: state.chainId, account: address!, operator: loans, projectId: state.projectId, permissionIds: [REVLOANS_BURN_PERMISSION_ID], includeRoot: true, includeWildcardProjectId: true }),
    staleTime: 10_000, retry: false,
  })
  const needsPermission = permission.data !== true && confirmedGrant === undefined
  const borrowable = quote.data && quote.data.borrowableNow > 0n ? quote.data.borrowableNow : undefined
  const optionLabel = PREPAID_OPTIONS.find(option => option.value === prepaid)?.label ?? `${Number(prepaid) / 10}%`
  async function run() {
    if (!address || count <= 0n) return
    setPreparing(true); setError(null)
    try {
      let minimumBlock = confirmedGrant
      const current = await fresh(client, state, address, minimumBlock)
      matchingContext(current, context)
      if (!current.cashOutsAvailable || count > current.totalBalance) throw new Error('The collateral or borrowing unlock time changed.')
      const permitted = await hasPermissions(client, { chainId: state.chainId, account: address, operator: loans, projectId: state.projectId, permissionIds: [REVLOANS_BURN_PERMISSION_ID], includeRoot: true, includeWildcardProjectId: true })
      if (!permitted) {
        setStage('permission')
        const hash = await grant.send({ ...buildSetPermissionsTx({ chainId: state.chainId, account: address, operator: loans, projectId: state.projectId, permissionIds: [REVLOANS_BURN_PERMISSION_ID] }), label: 'Allow REVLoans to burn this project’s INCOME as loan collateral' }, { reverify: async () => { await fresh(client, state, address) } })
        const block = await prerequisiteBlock(client, hash, grant.isSafe)
        if (block === null) return
        minimumBlock = block
      }
      setStage('borrow')
      const latest = await fresh(client, state, address, minimumBlock)
      matchingContext(latest, context)
      const latestQuote = await getBorrowableAmount(client, { chainId: state.chainId, revnetId: state.projectId, collateralCount: count, decimals: BigInt(context.decimals), currency: BigInt(context.currency) })
      const minimum = protectedIncomeMinimum(latestQuote.borrowableNow)
      await tx.send({ ...buildProtectedIncomeBorrow({ chainId: state.chainId, revnetId: state.projectId, token: context.token, quotedBorrowAmount: latestQuote.borrowableNow, collateralCount: count, holder: address, beneficiary: address, prepaidFeePercent: prepaid }), label: `Borrow against ${units(count)} INCOME; minimum ${units(minimum, context.decimals)} ${context.symbol} before loan fees` }, {
        simulationBlockNumber: minimumBlock === undefined ? undefined : latest.blockNumber,
        reviewNotice: `The prepaid source fee is ${optionLabel}. Protocol and REV fees also reduce wallet proceeds. Your INCOME becomes loan collateral; repayment is required to recover it. Unpaid loans can be liquidated after the contract’s ten-year term.`,
        reverify: async () => { const again = await fresh(client, state, address, minimumBlock); matchingContext(again, context); if (!again.cashOutsAvailable || count > again.totalBalance) throw new Error('The borrowing conditions changed during review.') },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  const running = preparing || tx.busy || grant.busy || tx.phase === 'review' || grant.phase === 'review'
  const steps = [
    ...(needsPermission ? [{ key: 'permission', title: 'Allow REVLoans to use your INCOME as collateral', detail: 'A one-time permission for this project.' }] : []),
    { key: 'borrow', title: `Borrow against ${units(count)} INCOME`, detail: 'The minimum is re-quoted just before your wallet opens.' },
  ]
  return <Panel title="Borrow against INCOME">
    <Field label="INCOME collateral" value={input} onChange={setInput} />
    <fieldset className="mt-4 flex flex-wrap items-center gap-2 border-0 p-0"><legend className="mb-2 text-sm">Prepaid fee</legend>{PREPAID_OPTIONS.map(option => <button key={option.label} type="button" className={prepaid === option.value ? 'btn-primary min-h-10 px-4' : 'btn-secondary min-h-10 px-4'} aria-pressed={prepaid === option.value} onClick={() => setPrepaid(option.value)}>{option.label}</button>)}</fieldset>
    <p className="mt-2 text-xs text-[var(--muted)]">Prepaying more buys more fee-free time before the repayment cost starts to grow.</p>
    {borrowable !== undefined && <p className="mt-3 text-sm">Borrowable: {units(borrowable, context.decimals)} {context.symbol}. You receive about {units(netLoanProceeds(borrowable, prepaid), context.decimals)} {context.symbol} after fees.</p>}
    {quote.isError && <p role="alert" className="mt-3 text-sm">{message(quote.error)}</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || running || count <= 0n || count > state.totalBalance || !state.cashOutsAvailable || !borrowable} onClick={() => { setError(null); setStage(null); if (tx.phase === 'success' || tx.phase === 'error') tx.reset(); setReviewing(true) }}>Review loan</button>
    {!reviewing && error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}
    {!reviewing && <><Status tx={grant} chainId={state.chainId} /><Status tx={tx} chainId={state.chainId} /></>}
    <TxConfirmDialog
      open={reviewing}
      eyebrow="Loan"
      title={tx.phase === 'success' ? 'Loan opened' : 'Confirm loan'}
      rows={[
        { label: 'Collateral', value: `${units(count)} INCOME`, strong: true },
        ...(borrowable !== undefined ? [
          { label: 'Borrow at least', value: `${units(protectedIncomeMinimum(borrowable), context.decimals)} ${context.symbol}` },
          { label: 'Prepaid fee', value: optionLabel },
          { label: 'You receive about', value: `${units(netLoanProceeds(borrowable, prepaid), context.decimals)} ${context.symbol}`, strong: true },
        ] : []),
        { label: 'On', value: displayChainName(state.chainId) },
      ]}
      steps={steps}
      activeIndex={stage === 'permission' ? 0 : stage === 'borrow' ? steps.length - 1 : -1}
      action="Confirm & borrow"
      actionDisabled={!borrowable}
      onConfirm={() => void run()}
      busy={running && !tx.safeProposalHash && !grant.safeProposalHash}
      complete={tx.phase === 'success'}
      status={grant.safeProposalHash && !confirmedGrant ? 'Permission proposed to Safe. Execute it there, then confirm again to borrow.' : tx.safeProposalHash ? 'Loan proposed to Safe. It still needs execution and onchain confirmation.' : tx.phase === 'pending' || grant.phase === 'pending' ? 'Submitted. Waiting for onchain confirmation…' : null}
      error={error ?? tx.error ?? grant.error}
      onClose={() => setReviewing(false)}
    >
      <p className="text-sm text-smoke-600">Your INCOME stays in a loan NFT until repaid. Unpaid loans can be liquidated after ten years.</p>
    </TxConfirmDialog>
  </Panel>
}

/** A full repayment in Juicebox Money's confirm dialog, approving first when the loan's token needs it. */
function IncomeRepayDialog({ state, client, loanId, tx, approval, onClose }: { state: IncomeProjectState; client: PublicClient; loanId: bigint | null; tx: IncomeTx; approval: IncomeTx; onClose: () => void }) {
  const { address } = useWallet()
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [stage, setStage] = useState<'approve' | 'repay' | null>(null)
  const loan = useQuery({ queryKey: ['income-loan', state.chainId, state.projectId.toString(), loanId?.toString(), address], enabled: !!address && !!loanId, queryFn: () => readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId: loanId!, account: address! }), staleTime: 10_000, retry: false })
  const loansContract = v6Address('REVLoans', state.chainId)
  const native = loan.data ? isAddressEqual(loan.data.sourceContext.token, NATIVE_TOKEN) : true
  const allowance = useQuery({ queryKey: ['income-allowance', state.chainId, state.projectId.toString(), loan.data?.sourceContext.token, address], enabled: !!address && !!loan.data && !native, queryFn: () => client.readContract({ address: loan.data!.sourceContext.token, abi: erc20Abi, functionName: 'allowance', args: [address!, loansContract] }), staleTime: 10_000, retry: false })
  const confirmedApproval = approval.phase === 'success' ? approval.receipt?.blockNumber : undefined
  const needsApproval = !native && !!loan.data && confirmedApproval === undefined && (allowance.data === undefined || allowance.data < loan.data.loan.amount + loan.data.accruedFee)
  async function run() {
    if (!address || !loanId) return
    setPreparing(true); setError(null)
    try {
      let prerequisite = confirmedApproval
      await fresh(client, state, address, prerequisite)
      let current = await readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId, account: address })
      if (prerequisite !== undefined && current.blockNumber < prerequisite) throw new Error('The network has not caught up with the confirmed token approval.')
      const tokenNative = isAddressEqual(current.sourceContext.token, NATIVE_TOKEN)
      let maximum = current.repayCeiling
      if (!tokenNative) {
        let approved = await client.readContract({ address: current.sourceContext.token, abi: erc20Abi, functionName: 'allowance', args: [address, loansContract], blockNumber: current.blockNumber })
        if (approved < current.loan.amount + current.accruedFee) {
          setStage('approve')
          const hash = await approval.send({ ...buildErc20ApproveRequest({ chainId: state.chainId, token: current.sourceContext.token, spender: loansContract, amount: current.repayCeiling }), label: `Approve up to ${units(current.repayCeiling, current.sourceContext.decimals)} ${current.sourceContext.symbol} to repay loan ${loanId}` }, { reverify: async () => { await readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId, account: address }) } })
          const block = await prerequisiteBlock(client, hash, approval.isSafe)
          if (block === null) return
          prerequisite = block
          current = await readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId, account: address })
          if (current.blockNumber < prerequisite) throw new Error('The network has not caught up with the confirmed token approval.')
          approved = await client.readContract({ address: current.sourceContext.token, abi: erc20Abi, functionName: 'allowance', args: [address, loansContract], blockNumber: current.blockNumber })
        }
        // Fees keep accruing after approval. Reuse its remaining buffer instead
        // of repeatedly asking to approve a newly calculated, slightly higher ceiling.
        if (approved < maximum) maximum = approved
      }
      setStage('repay')
      const reviewed = current
      await tx.send({ ...buildRepayLoanTx({ chainId: state.chainId, loanId, maxRepayBorrowAmount: maximum, collateralCountToReturn: reviewed.loan.collateral, beneficiary: address, value: tokenNative ? maximum : 0n }), label: `Repay loan ${loanId}; spend at most ${units(maximum, reviewed.sourceContext.decimals)} ${reviewed.sourceContext.symbol}` }, {
        simulationBlockNumber: prerequisite === undefined ? undefined : reviewed.blockNumber,
        reviewNotice: `Recover ${units(reviewed.loan.collateral)} INCOME. The maximum includes outstanding principal, accrued fees, and a 0.1% principal buffer. Unused funds are refunded.`,
        reverify: async () => { const latest = await readIncomeLoan(client, { chainId: state.chainId, projectId: state.projectId, loanId, account: address }); if (latest.loan.collateral !== reviewed.loan.collateral || latest.loan.amount !== reviewed.loan.amount || latest.loan.amount + latest.accruedFee > maximum) throw new Error('The loan changed or its fees exceeded the reviewed maximum. Review a fresh repayment.'); if (prerequisite !== undefined && latest.blockNumber < prerequisite) throw new Error('The RPC is behind the confirmed approval.') },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  const running = preparing || tx.busy || approval.busy || tx.phase === 'review' || approval.phase === 'review'
  const steps = [
    ...(needsApproval ? [{ key: 'approve', title: `Approve ${loan.data?.sourceContext.symbol ?? 'the token'}`, detail: 'Lets REVLoans take up to the repayment maximum.' }] : []),
    { key: 'repay', title: `Repay loan ${loanId?.toString() ?? ''}`, detail: 'Returns all of its INCOME collateral to you.' },
  ]
  return <TxConfirmDialog
    open={!!loanId}
    eyebrow="Loan"
    title={tx.phase === 'success' ? 'Loan repaid' : `Repay loan ${loanId?.toString() ?? ''}`}
    preparing={loan.isPending && !!loanId}
    rows={loan.data ? [
      { label: 'Pay at most', value: `${units(loan.data.repayCeiling, loan.data.sourceContext.decimals)} ${loan.data.sourceContext.symbol}`, strong: true },
      { label: 'You get back', value: `${units(loan.data.loan.collateral)} INCOME`, strong: true },
      { label: 'On', value: displayChainName(state.chainId) },
    ] : []}
    steps={steps}
    activeIndex={stage === 'approve' ? 0 : stage === 'repay' ? steps.length - 1 : -1}
    action="Confirm & repay"
    actionDisabled={!loan.data || loan.isError}
    onConfirm={() => void run()}
    busy={running && !tx.safeProposalHash && !approval.safeProposalHash}
    complete={tx.phase === 'success'}
    status={loan.isPending ? 'Reading the loan…' : approval.safeProposalHash && !confirmedApproval ? 'Approval proposed to Safe. Execute it there, then confirm again to repay.' : tx.safeProposalHash ? 'Repayment proposed to Safe. It still needs execution and onchain confirmation.' : tx.phase === 'pending' || approval.phase === 'pending' ? 'Submitted. Waiting for onchain confirmation…' : null}
    error={error ?? (loan.isError ? message(loan.error) : null) ?? tx.error ?? approval.error}
    onClose={onClose}
  >
    <p className="text-sm text-smoke-600">The maximum includes principal, accrued fees and a small refundable buffer.</p>
  </TxConfirmDialog>
}

/** The connected wallet's open loans on this chain, from the index; each repays through a fresh onchain read. */
export function IncomeLoansList({ state, client }: { state: IncomeProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const [repaying, setRepaying] = useState<bigint | null>(null)
  const [byId, setById] = useState('')
  // The list owns the repayment's transactions, so closing the dialog never stops their receipt tracking.
  const repayTx = useIncomeTx(state)
  const repayApproval = useIncomeTx(state)
  const inFlight = repayTx.busy || repayApproval.busy || repayTx.phase === 'review' || repayApproval.phase === 'review'
  function openRepay(loanId: bigint) {
    if (inFlight) return
    if (repayTx.phase === 'success' || repayTx.phase === 'error') repayTx.reset()
    if (repayApproval.phase === 'error') repayApproval.reset()
    setRepaying(loanId)
  }
  const loans = useQuery({ queryKey: ['loans', state.chainId, Number(state.projectId)], enabled: !!address, queryFn: () => getLoans(Number(state.projectId), state.chainId), staleTime: 30_000, retry: 1 })
  const mine = (loans.data?.items ?? []).filter(loan => !!address && loan.owner.toLowerCase() === address.toLowerCase() && loan.collateral !== '0')
  const tokenOf = (token: string) => state.accountingContexts.find(context => isAddressEqual(context.token, (token === zeroAddress ? NATIVE_TOKEN : token) as Address))
  const typedId = /^\d+$/.test(byId.trim()) ? BigInt(byId.trim()) : 0n
  return <Panel title="Your loans">
    {!address ? <p className="text-sm">Connect a wallet to see its loans.</p>
      : loans.isPending ? <p className="text-sm" role="status">Loading your loans…</p>
      : loans.isError ? <p className="text-sm" role="status">Your loans are temporarily unavailable. You can still repay one by its ID below.</p>
      : mine.length === 0 ? <p className="text-sm">No open loans on {displayChainName(state.chainId)}.</p>
      : <ul className="m-0 list-none p-0">{mine.map(loan => {
        const context = tokenOf(loan.token)
        return <li key={loan.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] py-3 last:border-0">
          <span className="text-sm">Loan {loan.id}: {context ? `${units(BigInt(loan.borrowAmount), context.decimals)} ${context.symbol}` : loan.borrowAmount} borrowed against {units(BigInt(loan.collateral))} INCOME<span className="block text-xs text-[var(--muted)]">Opened {new Date(loan.createdAt * 1000).toLocaleDateString()}</span></span>
          <button type="button" className="btn-secondary min-h-10 px-4" disabled={inFlight} onClick={() => openRepay(BigInt(loan.id))}>Repay</button>
        </li>
      })}</ul>}
    <details className="mt-4"><summary className="cursor-pointer text-sm">Repay another loan by ID</summary><div className="mt-3 flex flex-wrap items-end gap-3"><Field label="Loan NFT ID" value={byId} onChange={setById} /><button type="button" className="btn-secondary min-h-11 px-4" disabled={!address || typedId <= 0n || inFlight} onClick={() => openRepay(typedId)}>Review repayment</button></div></details>
    {!repaying && <><Status tx={repayApproval} chainId={state.chainId} /><Status tx={repayTx} chainId={state.chainId} /></>}
    <IncomeRepayDialog key={repaying?.toString() ?? 'none'} state={state} client={client} loanId={repaying} tx={repayTx} approval={repayApproval} onClose={() => setRepaying(null)} />
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
    <p className="mb-5">Anyone can trigger an unlocked stage allocation. Tokens always go to its recorded beneficiary.</p>
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
    <p className="mb-4">FUND stays in your wallet. Claim any FUND credits, then self-delegate once to earn future rewards.</p>
    <p className="mb-4 text-xs text-[var(--muted)]">Rounds use past voting power: activating late does not earn earlier rounds, and delegating to someone else gives them the reward weight.</p>
    <dl className="demo-live-rows"><div><dt>Reward activation</dt><dd>{activated ? 'Self-delegated' : 'Not self-delegated'}</dd></div><div><dt>Current voting power</dt><dd>{units(rewards.votes)} FUND</dd></div><div><dt>Currently collectible</dt><dd>{units(rewards.collectable)} INCOME</dd></div><div><dt>Vesting duration after claim</dt><dd>{units(rewards.vestingRounds * rewards.roundDuration / 86_400n, 0)} days</dd></div></dl>
    <p className="mt-4 text-xs text-[var(--muted)]">Current funding becomes claimable after {new Date(Number(rewards.nextRoundStart) * 1_000).toLocaleString()}.{rewards.claimDuration > 0n ? ` Unclaimed rounds expire after ${units(rewards.claimDuration / 86_400n, 0)} days.` : ' Unclaimed rounds do not expire.'}</p>
    {rewards.fundCreditBalance > 0n && <p className="mt-3 text-sm">{units(rewards.fundCreditBalance)} FUND credits must be claimed as ERC-20 tokens before they can earn future rewards.</p>}
    <div className="mt-5 flex flex-wrap gap-3"><button type="button" className="btn-primary min-h-11 px-5" disabled={!address || busy || (activated && rewards.fundCreditBalance === 0n)} onClick={() => void submit('activate')}>{rewards.fundCreditBalance > 0n ? 'Claim FUND credits' : 'Activate rewards'}</button><button type="button" className="btn-secondary min-h-10 px-4" disabled={!address || busy} onClick={() => void submit('vest')}>Begin vesting</button><button type="button" className="btn-secondary min-h-10 px-4" disabled={!address || busy || rewards.collectable <= 0n} onClick={() => void submit('collect')}>Collect vested INCOME</button></div>
    {error && <p role="alert" className="mt-3 text-sm text-red-800">{error}</p>}<Status tx={tx} chainId={state.chainId} />
  </Panel>
}
