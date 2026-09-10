'use client'

import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  buildBurnTokensTx,
  buildClaimTokensTx,
  buildDeployErc20Tx,
  buildPayTx,
  buildTransferCreditsTx,
  getHookAwareCashOutQuote,
  prepareHookAwareCashOut,
  previewPay,
} from '@bananapus/nana-sdk-core/v6'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { erc20Abi, formatUnits, getAddress, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import Image from 'next/image'
import { usePublicClient } from 'wagmi'
import { Brand } from '@/components/Brand'
import { WalletButton } from '@/components/WalletButton'
import { FundOperatorActions } from '@/components/FundOperatorActions'
import { IncomeLaunch } from '@/components/IncomeLaunch'
import { FundBridgeActions } from '@/components/FundBridgeActions'
import { ProjectActivity } from '@/components/ProjectActivity'
import { useSafeTx, txPhaseLabel, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import { readFundProjectState, type FundProjectState } from '@/lib/fund-state'
import { parseAmount } from '@/lib/fund-contracts'
import { fetchFundProjectMetadata, type FundProjectMetadata } from '@/lib/fund-project-metadata'

/** Reject rounded, negative, exponent and over-precise financial inputs. */
function positiveAmount(value: string, decimals: number): bigint {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed) || (trimmed.split('.')[1]?.length ?? 0) > decimals) return 0n
  try { return parseAmount(trimmed, decimals) } catch { return 0n }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to prepare this transaction. Refresh the project and try again.'
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

function ActionSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
    <h2 className="mb-5 text-3xl">{title}</h2>{children}
  </section>
}

function Input({ label, value, onChange, placeholder, inputMode = 'decimal' }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; inputMode?: 'text' | 'decimal'
}) {
  return <label className="grid gap-2 text-sm">{label}
    <input className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 text-base" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} inputMode={inputMode} autoComplete="off" />
  </label>
}

/** Every displayed balance and every permission is resolved from this chain. */
export function FundProject({ chainId, projectId }: { chainId: JBChainId; projectId: string }) {
  const id = BigInt(projectId)
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useWallet()
  const [lastState, setLastState] = useState<FundProjectState | null>(null)
  const query = useQuery({
    queryKey: ['fund-project', chainId, projectId, address ?? null],
    enabled: !!client,
    queryFn: () => readFundProjectState(client!, { chainId, projectId: id, account: address }),
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: 1,
    placeholderData: keepPreviousData,
  })
  useEffect(() => { if (query.data) setLastState(query.data) }, [query.data])
  // Keep receipt tracking mounted through a failed refresh or wallet change.
  // Retained reads are display-only until the active account is freshly read.
  const displayState = query.data ?? lastState
  const accountMatches = query.data?.account
    ? !!address && isAddressEqual(query.data.account, address)
    : !address
  const writesUnavailable = query.isError || query.isPlaceholderData || !query.data || !accountMatches
  const details = useQuery({
    queryKey: ['fund-project-metadata', displayState?.projectUri],
    enabled: !!displayState?.projectUri,
    queryFn: () => fetchFundProjectMetadata(displayState!.projectUri),
    staleTime: 300_000,
    retry: 1,
  })
  return <div className="project-page live-contract-page">
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header flex items-center justify-between gap-5"><Brand /><WalletButton /></header>
    <main id="main" className="mx-auto max-w-[1220px] px-5 py-10 sm:py-14" tabIndex={-1}>
      <p className="mb-3 text-sm">{displayChainName(chainId)} / Project {projectId}</p>
      <h1 className="mb-6 text-5xl sm:text-6xl">{details.data?.name ?? 'FUND project'}</h1>
      {details.data?.location && <p className="mb-4">{details.data.location}</p>}
      <p className="mb-8 max-w-3xl whitespace-pre-line">{details.data?.description ?? 'Fund the asset, manage its treasury, and use your FUND tokens. This link reads the project directly from the blockchain.'}</p>
      {details.data?.coverUrl && <Image unoptimized src={details.data.coverUrl} width={1200} height={675} alt={details.data.name ? `${details.data.name} cover` : 'Project cover'} className="mb-8 max-h-[480px] w-full rounded-md object-cover" />}
      {details.isError && <p className="mb-5 text-sm">Project details could not be loaded. The contract balances and permissions below are still read independently.</p>}
      {query.isPending && <p role="status">Reading the project’s confirmed contract state…</p>}
      {query.isError && <div role="alert"><p>Project data could not be verified. Transactions are unavailable until the reads recover.</p><p className="mt-2 text-sm">{errorMessage(query.error)}</p><button type="button" className="btn-secondary mt-4" onClick={() => void query.refetch()}>Try again</button></div>}
      {displayState && client && <ProjectActions key={`${chainId}:${projectId}`} state={displayState} client={client} name={details.data?.name ?? undefined} plan={details.data?.plan} refreshing={query.isFetching} writesUnavailable={writesUnavailable} refresh={() => void query.refetch()} />}
      {details.data?.plan && <PlannedIncome plan={details.data.plan} />}
      <ProjectActivity chainId={chainId} projectId={projectId} />
    </main>
  </div>
}

function PlannedIncome({ plan }: { plan: NonNullable<FundProjectMetadata['plan']> }) {
  const money = (amount: number | null) => amount === null ? 'Not specified' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(amount)
  return <section className="mt-7 rounded-md border border-[#cbd7db] bg-[#edf2f4] p-5 text-[#3f5b66] sm:p-7">
    <h2 className="mb-4 text-3xl">The project plan</h2>
    <p className="mb-5 text-sm">Published estimates from the project metadata. These values do not set withdrawal rights, mint permissions, or confirm an asset purchase.</p>
    <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4"><div><dt className="text-sm">Asset price</dt><dd className="mt-2 text-xl">{money(plan.purchaseBudget)}</dd></div><div><dt className="text-sm">Cash reserve</dt><dd className="mt-2 text-xl">{money(plan.opsReserve)}</dd></div><div><dt className="text-sm">Monthly revenue estimate</dt><dd className="mt-2 text-xl">{money(plan.monthlyRent)}</dd></div><div><dt className="text-sm">Monthly expense estimate</dt><dd className="mt-2 text-xl">{money(plan.monthlyCosts)}</dd></div></dl>
    <p className="mt-5 text-sm">Planned operator FUND share: {plan.operatorFundPercent === null ? 'not specified' : `${plan.operatorFundPercent}%`}. The current FUND balance and supply determine actual ownership.</p>
    <h3 className="mb-3 mt-7 text-2xl">Planned INCOME allocation</h3>
    <p className="text-sm">The initial 500,000 INCOME is allocated to all FUND holders at the published snapshot, including wallet tokens and unclaimed credits. Claiming that allocation does not require staking.</p>
    {plan.operatorSplitPercent !== null && plan.fundHolderSplitPercent !== null && plan.operatorSplitPercent + plan.fundHolderSplitPercent <= 100 && <p className="mt-3 text-sm">Planned new INCOME allocation: {plan.operatorSplitPercent}% operators / {plan.fundHolderSplitPercent}% eligible FUND stakers / {100 - plan.operatorSplitPercent - plan.fundHolderSplitPercent}% customers.</p>}
  </section>
}

function ProjectActions({ state, client, name, plan, refreshing, writesUnavailable, refresh }: { state: FundProjectState; client: PublicClient; name?: string; plan?: FundProjectMetadata['plan']; refreshing: boolean; writesUnavailable: boolean; refresh: () => void }) {
  const { address, isConnected } = useWallet()
  const [contextIndex, setContextIndex] = useState(0)
  const context = state.accountingContexts[contextIndex] ?? state.accountingContexts[0]
  const totalBalance = state.creditBalance + state.erc20Balance
  const isOperator = !!address && Object.values(state.permissions).some(Boolean)
  const supported = state.supportedController && state.supportedTerminals && state.knownOwnerWrapper
  return <div className="grid gap-7">
    <section aria-label="Verified project state" className="rounded-md border border-[#c4cdbb] p-5 sm:p-7">
      <div className="flex flex-wrap justify-between gap-3"><p className="text-sm">Verified at block {state.blockNumber.toString()}</p><button className="text-sm underline" type="button" disabled={refreshing} onClick={refresh}>{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
      <dl className="mt-5 grid gap-5 sm:grid-cols-3">
        <div><dt className="text-sm">Payments</dt><dd className="mt-2 text-xl">{state.metadata.pausePay ? 'Paused' : 'Open'}</dd></div>
        <div><dt className="text-sm">Cash-out tax</dt><dd className="mt-2 text-xl">{state.metadata.cashOutTaxRate === 10_000 ? 'Cash-outs disabled' : `${state.metadata.cashOutTaxRate / 100}%`}</dd></div>
        <div><dt className="text-sm">FUND supply</dt><dd className="mt-2 break-words text-xl">{units(state.totalSupply)}</dd></div>
      </dl>
      {context && <div className="mt-6 flex flex-wrap items-end gap-5">
        <label className="grid gap-2 text-sm">Treasury currency<select value={contextIndex} onChange={event => setContextIndex(Number(event.target.value))} className="min-h-11 rounded border border-[#bfc9b5] bg-white px-3 pr-9">{state.accountingContexts.map((item, index) => <option key={`${item.terminal}:${item.token}`} value={index}>{item.symbol}</option>)}</select></label>
        <p className="text-xl">{units(context.balance, context.decimals)} {context.symbol} in the treasury</p>
      </div>}
      {state.upcoming && state.upcoming.ruleset.id !== state.ruleset.id && <p className="mt-5">A different ruleset is scheduled. Its terms take effect at {new Date(Number(state.upcoming.ruleset.start) * 1000).toLocaleString()}.</p>}
      <details className="mt-6 text-sm"><summary className="cursor-pointer">Contract addresses</summary><dl className="mt-3 grid gap-2 break-all"><div><dt>Project owner</dt><dd>{state.owner}</dd></div><div><dt>Operator</dt><dd>{state.operator ?? 'Not verified'}</dd></div><div><dt>Controller</dt><dd>{state.controller}</dd></div>{state.tokenAddress && <div><dt>FUND ERC-20</dt><dd>{state.tokenAddress}</dd></div>}</dl></details>
    </section>
    {!supported && <p role="alert">This project uses contract settings outside Homerun’s verified FUND integration. Transactions are unavailable here. {state.issues.join(' ')}</p>}
    {!isConnected && <p>Connect your wallet to contribute, use your tokens, or access operator actions.</p>}
    {writesUnavailable && <p role="status">New transactions are paused while current project permissions and balances are being verified. Submitted transactions continue to be tracked below.</p>}
    <fieldset disabled={writesUnavailable || !supported} className="grid min-w-0 gap-7 border-0 p-0" aria-label="Project transactions">
    {context ? <div className="grid items-start gap-7 lg:grid-cols-2">
      <PaymentPanel state={state} client={client} contextIndex={contextIndex} />
      <CashOutPanel state={state} client={client} contextIndex={contextIndex} />
    </div> : <p>No supported payment terminal was verified for this project. Payment and cash-out actions are unavailable.</p>}
    <ActionSection title="Your FUND">
      {address ? <><p className="mb-3 break-words text-2xl">{units(totalBalance)} FUND</p><p className="mb-6 text-sm">{units(state.creditBalance)} internal credits / {units(state.erc20Balance)} ERC-20 tokens. Both count as FUND without staking.</p></> : <p className="mb-5">Connect a wallet to read your holdings.</p>}
      <fieldset disabled={!address} className="min-w-0 border-0 p-0"><HolderActions state={state} client={client} /></fieldset>
    </ActionSection>
    <FundBridgeActions state={state} />
    <details className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7" open={isOperator || undefined}>
      <summary className="cursor-pointer text-3xl">Operator actions</summary>
      <div className="mt-5">
      {!isOperator && <p className="mb-5">Connect a wallet with verified project permissions to manage this project. Contract permissions are checked again before every transaction.</p>}
      <fieldset disabled={!isOperator} className="min-w-0 border-0 p-0"><OperatorActions state={state} client={client} contextIndex={contextIndex} name={name} /></fieldset>
      </div>
    </details>
    </fieldset>
    <IncomeLaunch state={state} client={client} name={name} plannedAllocation={plan ? { operatorPercent: plan.operatorSplitPercent, fundStakerPercent: plan.fundHolderSplitPercent } : undefined} launchUnavailable={writesUnavailable || !supported} />
  </div>
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

function PaymentPanel({ state, client, contextIndex }: { state: FundProjectState; client: PublicClient; contextIndex: number }) {
  const { address } = useWallet()
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const tx = useProjectTransaction(state)
  const approval = useProjectTransaction(state)
  const context = state.accountingContexts[contextIndex] ?? state.accountingContexts[0]
  const amountRaw = positiveAmount(amount, context.decimals)
  const native = isAddressEqual(context.token, NATIVE_TOKEN)
  const approvalBlock = approval.phase === 'success' ? approval.receipt?.blockNumber : undefined
  const allowanceBlock = approvalBlock !== undefined && approvalBlock > state.blockNumber ? approvalBlock : state.blockNumber
  const quote = useQuery({
    queryKey: ['fund-pay-quote', state.chainId, state.projectId.toString(), context.terminal, context.token, amountRaw.toString(), address],
    enabled: !!address && amountRaw > 0n && !state.metadata.pausePay,
    retry: false,
    queryFn: () => previewPay(client, { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, token: context.token, amount: amountRaw, beneficiary: address! }),
    staleTime: 10_000,
  })
  const allowance = useQuery({
    queryKey: ['fund-allowance', state.chainId, state.projectId.toString(), context.token, context.terminal, address, allowanceBlock.toString()],
    enabled: !!address && !native,
    queryFn: () => client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address!, context.terminal], blockNumber: allowanceBlock }),
    staleTime: 10_000,
    retry: false,
  })
  const needsApproval = !native && allowance.data !== undefined && allowance.data < amountRaw
  const minimum = quote.data ? quote.data.beneficiaryTokenCount * 99n / 100n : 0n
  const busy = preparing || tx.busy || approval.busy || tx.phase === 'review' || approval.phase === 'review'
  async function submit() {
    if (!address || amountRaw <= 0n || minimum <= 0n) return
    setError(null); setPreparing(true)
    try {
      const current = await freshState(client, state, address, approvalBlock)
      const activeContext = current.accountingContexts.find(item => isAddressEqual(item.token, context.token) && isAddressEqual(item.terminal, context.terminal))
      if (!activeContext || current.metadata.pausePay) throw new Error('Payments changed. Refresh the project and review the new terms.')
      if (!native) {
        const available = await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, context.terminal], blockNumber: current.blockNumber })
        if (available < amountRaw) {
          await approval.send({ chainId: state.chainId, address: context.token, abi: erc20Abi, functionName: 'approve', args: [context.terminal, amountRaw], label: `Approve exactly ${units(amountRaw, context.decimals)} ${context.symbol} for the FUND payment` }, { reverify: async () => {
            const latest = await freshState(client, state, address)
            if (latest.metadata.pausePay || !latest.accountingContexts.some(item => isAddressEqual(item.token, context.token) && isAddressEqual(item.terminal, context.terminal))) throw new Error('The payment terminal or terms changed during review. Refresh before approving.')
          } })
          return
        }
      }
      const freshQuote = await previewPay(client, { chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, token: context.token, amount: amountRaw, beneficiary: address })
      const freshMinimum = freshQuote.beneficiaryTokenCount * 99n / 100n
      if (freshMinimum <= 0n) throw new Error('This amount has no positive FUND quote. Increase it or refresh the project.')
      const request = buildPayTx({ chainId: state.chainId, projectId: state.projectId, terminal: context.terminal, token: context.token, amount: amountRaw, beneficiary: address, minReturnedTokens: freshMinimum, memo: 'Homerun FUND contribution' })
      await tx.send({ ...request, label: `Contribute ${units(amountRaw, context.decimals)} ${context.symbol}; receive at least ${units(freshMinimum)} FUND` }, {
        simulationBlockNumber: approvalBlock !== undefined ? current.blockNumber : undefined,
        reviewNotice: freshMinimum < minimum ? `The quote changed. You will receive at least ${units(freshMinimum)} FUND, down from ${units(minimum)} FUND.` : undefined,
        reverify: async () => {
          const latest = await freshState(client, state, address, approvalBlock)
          if (latest.metadata.pausePay || !latest.accountingContexts.some(item => isAddressEqual(item.token, context.token) && isAddressEqual(item.terminal, context.terminal))) throw new Error('Payment terms changed during review. Refresh and start again.')
          if (!native) {
            const currentAllowance = await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, context.terminal], blockNumber: latest.blockNumber })
            if (currentAllowance < amountRaw) throw new Error('The token approval changed during review. Review a new approval first.')
          }
        },
      })
    } catch (reason) { setError(errorMessage(reason)) } finally { setPreparing(false) }
  }
  return <ActionSection title="Contribute">
    <Input label={`Amount in ${context.symbol}`} value={amount} onChange={setAmount} />
    {state.metadata.pausePay ? <p className="mt-4">This project has paused contributions.</p> : <p className="mt-4 text-sm">{minimum > 0n ? `At least ${units(minimum)} FUND at 1% maximum slippage.` : quote.isFetching ? 'Reading the payment quote…' : 'Enter an amount to see your FUND quote.'}</p>}
    {quote.isError && <p role="alert" className="mt-3 text-sm">A protected payment quote is unavailable. {errorMessage(quote.error)}</p>}
    {!native && allowance.isError && <p role="alert" className="mt-3 text-sm">Token approval could not be verified. Refresh before continuing.</p>}
    {approval.phase === 'success' && <p className="mt-4 text-sm">Approval confirmed. Review the contribution to continue.</p>}
    <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={!address || busy || state.metadata.pausePay || minimum <= 0n || (!native && allowance.data === undefined)} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(approval.busy ? approval.phase : tx.phase, { idle: needsApproval ? 'Review token approval' : 'Review contribution', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="mt-4 text-sm text-red-800">{error}</p>}
    <TransactionStatus tx={approval} chainId={state.chainId} /><TransactionStatus tx={tx} chainId={state.chainId} />
  </ActionSection>
}

function CashOutPanel({ state, client, contextIndex }: { state: FundProjectState; client: PublicClient; contextIndex: number }) {
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

function HolderActions({ state, client }: { state: FundProjectState; client: PublicClient }) {
  const { address } = useWallet()
  const tx = useProjectTransaction(state)
  const [action, setAction] = useState<'claim' | 'transferCredits' | 'transferTokens' | 'burn'>('claim')
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const count = positiveAmount(amount, 18)
  const available = action === 'transferTokens' ? state.erc20Balance : action === 'burn' ? state.creditBalance + state.erc20Balance : state.creditBalance
  const destination = action === 'claim' || action === 'burn' ? address : isAddress(recipient) && !isAddressEqual(recipient, zeroAddress) ? getAddress(recipient) : undefined
  const unavailable = action === 'claim' || action === 'transferTokens' ? !state.tokenAddress : action === 'transferCredits' && state.metadata.pauseCreditTransfers
  async function submit() {
    if (!address || !destination || (count <= 0n || count > available)) return
    setError(null); setPreparing(true)
    try {
      let request: TxRequest
      if (action === 'claim') request = { ...buildClaimTokensTx({ chainId: state.chainId, holder: address, projectId: state.projectId, tokenCount: count, beneficiary: destination }), address: state.controller, label: `Claim ${units(count)} FUND credits as ERC-20 tokens` }
      else if (action === 'transferCredits') request = { ...buildTransferCreditsTx({ chainId: state.chainId, holder: address, projectId: state.projectId, recipient: destination, creditCount: count }), address: state.controller, label: `Transfer ${units(count)} FUND credits to ${destination}` }
      else if (action === 'burn') request = { ...buildBurnTokensTx({ chainId: state.chainId, holder: address, projectId: state.projectId, tokenCount: count, memo: 'Voluntary FUND burn' }), address: state.controller, label: `Permanently burn ${units(count)} FUND without receiving funds` }
      else {
        if (!state.tokenAddress) throw new Error('No FUND ERC-20 is deployed.')
        request = { chainId: state.chainId, address: state.tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [destination, count], label: `Transfer ${units(count)} FUND tokens to ${destination}` }
      }
      await tx.send(request, { reverify: async () => {
        const fresh = await freshState(client, state, address)
        if (count > (action === 'transferTokens' ? fresh.erc20Balance : action === 'burn' ? fresh.creditBalance + fresh.erc20Balance : fresh.creditBalance)) throw new Error('Your token balance changed. Review a new amount.')
        if (action === 'transferCredits' && fresh.metadata.pauseCreditTransfers) throw new Error('Credit transfers are now paused.')
        if (action !== 'transferCredits' && fresh.tokenAddress !== state.tokenAddress) throw new Error('The project token changed. Refresh and review again.')

      } })
    } catch (reason) { setError(errorMessage(reason)) } finally { setPreparing(false) }
  }
  return <div className="grid gap-4">
    <label className="grid gap-2 text-sm">Action<select value={action} onChange={event => setAction(event.target.value as typeof action)} className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 pr-9"><option value="claim">Claim credits as wallet tokens</option><option value="transferCredits">Transfer internal credits</option><option value="transferTokens">Transfer ERC-20 tokens</option><option value="burn">Burn without receiving funds</option></select></label>
    <div className="grid gap-4 sm:grid-cols-2"><Input label="FUND amount" value={amount} onChange={setAmount} />{action.startsWith('transfer') && <Input label="Recipient wallet" value={recipient} onChange={setRecipient} inputMode="text" placeholder="0x…" />}</div>
    <p className="text-sm">Available: {units(available)} FUND. {action === 'claim' ? 'Claiming changes the representation of your holdings; it does not stake them.' : action === 'burn' ? 'Burning permanently removes these FUND and their future claims. Use cash out to receive treasury funds.' : 'The recipient receives ownership of the transferred FUND.'}</p>

    {unavailable && <p className="text-sm">{action === 'transferCredits' ? 'Credit transfers are paused by the current ruleset.' : 'The operator must deploy a FUND ERC-20 before this action is available.'}</p>}
    <button type="button" className="btn-primary min-h-11 w-fit px-5" disabled={preparing || tx.busy || tx.phase === 'review' || unavailable || (count <= 0n || count > available) || !destination} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review token action', pending: 'Confirming onchain…' })}</button>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}<TransactionStatus tx={tx} chainId={state.chainId} />
  </div>
}

function OperatorActions({ state, client, contextIndex, name }: { state: FundProjectState; client: PublicClient; contextIndex: number; name?: string }) {
  const { address } = useWallet()
  const tx = useProjectTransaction(state)
  const [error, setError] = useState<string | null>(null)
  async function deployToken() {
    if (!address) return
    setError(null)
    try {
      await tx.send({ ...buildDeployErc20Tx({ chainId: state.chainId, projectId: state.projectId, name: name ? `${name} FUND` : `Homerun FUND ${state.projectId}`, symbol: 'FUND' }), address: state.controller, label: 'Deploy the transferable FUND token' }, { reverify: async () => {
        const fresh = await freshState(client, state, address)
        if (!fresh.permissions.deployErc20 || fresh.tokenAddress) throw new Error('Token deployment authority or state changed. Refresh and review again.')
      } })
    } catch (reason) { setError(errorMessage(reason)) }
  }
  return <div className="grid gap-5">
    {!state.tokenAddress && <div><p className="mb-3 text-sm">Deploy the ERC-20 representation so FUND holders can claim their credits into their wallets.</p><button type="button" className="btn-secondary min-h-11 px-5" disabled={!state.permissions.deployErc20 || tx.busy || tx.phase === 'review'} onClick={() => void deployToken()}>Review FUND token deployment</button></div>}
    <FundOperatorActions state={state} client={client} contextIndex={contextIndex} />
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}<TransactionStatus tx={tx} chainId={state.chainId} />
  </div>
}
