'use client'

import { NATIVE_TOKEN, type JBChainId } from '@bananapus/nana-sdk-core'
import { buildPayTx, decodePayFailure, type PayFailure } from '@bananapus/nana-sdk-core/v6'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { WritesChecking } from '@/components/writes-checking'
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { erc20Abi, formatUnits, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { displayChainName } from '@/lib/chainDisplay'
import { DisplayTokenAmount } from '@/components/DisplayTokenAmount'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { explorerTxUrl } from '@/lib/chainDisplay'
import { parseAmount } from '@/lib/fund-contracts'
import { approvalIntentKey, buildErc20ApproveRequest, canonicalDecimal, chosenOrAuto } from '@/lib/transaction-builders'
import { prepareProjectPayQuote, readProjectPayTokenOptions } from '@/lib/project-pay-quote'
// `intent` names this flow's own reviewed intent here.
import { intent as keyed, writeIntentKey } from '@bananapus/nana-sdk-core/review'
import { lazyComponent } from '@/components/lazy-component'
import { readableError } from '@/lib/readable-error'
import { refreshIndexedProject } from '@/lib/refresh-indexed'
import { HeldNotice } from '@/components/ui/HeldWriteExit'
import { AllowedDecreaseField } from '@/components/ui/AllowedDecreaseField'
import { PAY_DEFAULT_SLIPPAGE_BPS, PAY_SLIPPAGE_LIMIT_PERCENT, payRetrySlippageBps } from '@/lib/pay-minimum'

const CenterProjectPayment = lazyComponent(() => import('./CenterProjectPayment').then(m => m.default))
export function ProjectPayment(props: Parameters<typeof ExternalProjectPayment>[0]) {
  const { isCenterWallet } = useWallet()
  return isCenterWallet ? <CenterProjectPayment {...props} /> : <ExternalProjectPayment {...props} />
}

type PaymentTx = ReturnType<typeof useSafeTx>
type PaymentContext = { token: Address; terminal: Address; decimals: number; symbol: string }

function inputAmount(value: string, decimals: number) {
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || (value.trim().split('.')[1]?.length ?? 0) > decimals) return 0n
  try { return parseAmount(value.trim(), decimals) } catch { return 0n }
}
function message(error: unknown) { return readableError(error, 'The payment could not be prepared. Refresh and try again.') }
function Status({ tx, chainId }: { tx: PaymentTx; chainId: number }) {
  const url = tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null
  return <div role="status" aria-live="polite" className="mt-3 break-words text-sm">
    {tx.phase === 'submitted' ? <HeldNotice tx={tx} /> : tx.phase === 'pending' ? <p>Submitted. Waiting for onchain confirmation…</p> : tx.phase === 'success' ? <p>Confirmed onchain.</p> : null}
    {tx.error && <p className="text-red-800">{tx.error}</p>}{url && <a className="underline" href={url} target="_blank" rel="noreferrer">View transaction</a>}
  </div>
}

/** Same bounded receipt lookup used by JBM's payment sequence. The useSafeTx
 * watchers remain mounted if this waiter times out or a Safe needs execution. */
async function paymentReceipt(client: PublicClient, hash: Hex) {
  try { return await client.waitForTransactionReceipt({ hash, timeout: 120_000 }) }
  catch (firstError) {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try { return await client.getTransactionReceipt({ hash }) }
      catch { await new Promise(resolve => window.setTimeout(resolve, 2_000)) }
    }
    throw firstError
  }
}

/** FUND and INCOME share the reference clients' pay execution pipeline. The parent retains project-specific contract identity checks. */
function ExternalProjectPayment({ chainId, projectId, tokenLabel, title, context: accountingContext, currencyChosen = false, paused, blocked, quoteNeedsWallet, reservedPercent, rulesetId, verify, chainSelector, onBusyChange }: {
  chainSelector?: ReactNode; onBusyChange?: (busy: boolean) => void
  /** Why this wallet cannot pay; keeps the card but disables Pay. */
  blocked?: string
  /** A closed allowlist rejects every payer it does not name, so only a connected wallet can be quoted. */
  quoteNeedsWallet?: boolean
  chainId: JBChainId; projectId: bigint; tokenLabel: 'FUND' | 'INCOME'; title: string
  context: PaymentContext; paused: boolean; reservedPercent: number; rulesetId: string
  /** The user picked the currency `context` is in; otherwise the page's default is keyed as such. */
  currencyChosen?: boolean
  verify: (account: Address, minimumBlock?: bigint) => Promise<{ blockNumber: bigint }>
}) {
  const checking = useContext(WritesChecking)
  const { address, openSignIn } = useWallet()
  // The route query and all writes use the same chain-bound Wagmi client.
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [selectedToken, setSelectedToken] = useState<Address>()
  const tokenOptions = useQuery({
    queryKey: ['project-pay-tokens', chainId, projectId.toString(), accountingContext.terminal, rulesetId],
    enabled: !!client,
    queryFn: () => readProjectPayTokenOptions(client!, { chainId, projectId, terminal: accountingContext.terminal }),
    staleTime: 30_000, retry: false,
  })
  const context = tokenOptions.data?.find(option => isAddressEqual(option.token, selectedToken ?? accountingContext.token)) ?? accountingContext
  const [preparing, setPreparing] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Which wallet step the running sequence is on, for the step list.
  const [stage, setStage] = useState<'approve' | 'pay' | null>(null)
  /** Why the last payment reverted, when the chain or its simulation says. */
  const [failure, setFailure] = useState<PayFailure | null>(null)
  /** A tolerance the payer loosened after a shortfall, for the payment it was set on. */
  const [payerSlippage, setPayerSlippage] = useState<{ bps: number; payment: string } | null>(null)
  /** The tolerance offered after a shortfall, until the payer reviews again with it. */
  const [retrySlippageBps, setRetrySlippageBps] = useState<number | null>(null)
  const [retryWhenQuoted, setRetryWhenQuoted] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const tx = useSafeTx(chainId)
  const approval = useSafeTx(chainId)
  const cache = useQueryClient()
  const count = inputAmount(input, context.decimals)
  const paymentInputs = `${chainId}:${projectId}:${context.terminal}:${context.token}:${count}`
  const slippageBps = payerSlippage?.payment === paymentInputs ? payerSlippage.bps : undefined
  const slippage = slippageBps === undefined ? undefined : BigInt(slippageBps)
  const intent = `${chainId}:${projectId}:${context.token}:${context.terminal}:${count}:${address ?? ''}:${rulesetId}:${paused}:${reservedPercent}:${tx.isSafe}`
  const currentIntent = useRef(intent)
  currentIntent.current = intent
  const confirmed = useRef(new Set<string>())
  const prerequisite = approval.phase === 'success' ? approval.receipt?.blockNumber : undefined
  useEffect(() => {
    for (const item of [tx, approval]) {
      if (item.phase !== 'success' || !item.receipt || confirmed.current.has(item.receipt.transactionHash)) continue
      confirmed.current.add(item.receipt.transactionHash)
      for (const prefix of ['fund-project', 'income-project', 'project-pay', 'project-pay-tokens', 'income-reserved']) void cache.invalidateQueries({ queryKey: [prefix, chainId, projectId.toString()] })
      refreshIndexedProject(cache, chainId, projectId)
    }
  }, [cache, chainId, projectId, tx, approval])
  const quote = useQuery({
    queryKey: ['project-pay', chainId, projectId.toString(), context.terminal, context.token, count.toString(), address ?? zeroAddress, rulesetId, reservedPercent, slippageBps ?? null],
    enabled: !!client && count > 0n && !paused && (!quoteNeedsWallet || !!address),
    queryFn: () => prepareProjectPayQuote(client!, { chainId, projectId, terminal: context.terminal, token: context.token, amount: count, beneficiary: address ?? zeroAddress, slippageBps: slippage }),
    staleTime: 10_000, refetchInterval: 15_000, retry: false,
  })
  const minimum = quote.data?.minimumTokenCount ?? 0n
  const zeroAllocation = reservedPercent === 10_000 && !!quote.data && minimum === 0n && quote.data.reservedTokenCount > 0n
  const quoted = !!quote.data && !quote.isError && !quote.isPlaceholderData && (minimum > 0n || zeroAllocation)
  const quotedNow = useRef(quoted)
  quotedNow.current = quoted
  const busy = preparing || [tx, approval].some(item => item.busy || item.phase === 'review')
  const submitted = [tx, approval].find(item => item.phase === 'submitted')
  const tracking = busy || [tx, approval].some(item => !!item.safeProposalHash && item.phase !== 'success')
  // The wallet steps ahead, read before the first prompt as Juicebox Money's pay sequence does.
  // Unknown allowances count as needed; the sequence re-reads them before acting.
  const payingNative = isAddressEqual(context.token, NATIVE_TOKEN)
  const planSpender = quote.data?.terminal
  const planAllowance = useQuery({
    queryKey: ['project-pay-allowance', chainId, projectId.toString(), context.token, planSpender, address],
    enabled: open && !payingNative && !!client && !!address && !!planSpender,
    queryFn: () => client!.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address!, planSpender!] }),
    staleTime: 10_000, retry: false,
  })
  const payTitle = tokenLabel === 'FUND' ? 'Contribute' : 'Pay'
  const steps = [
    ...(!payingNative && (planAllowance.data === undefined || planAllowance.data < count) ? [{ key: 'approve', title: `Approve ${context.symbol}`, detail: 'Lets the payment terminal move exactly this amount.' }] : []),
    { key: 'pay', title: `${payTitle} ${input || '0'} ${context.symbol}` },
  ]
  const activeIndex = tx.phase === 'success' ? steps.length : stage ? Math.max(0, steps.findIndex(step => step.key === stage)) : -1
  // A wallet prompt or a running sequence keeps the dialog open; a submitted payment can close and keeps tracking.
  const prompting = preparing || [tx, approval].some(item => item.phase === 'review' || item.phase === 'simulating' || item.phase === 'signing')
  useEffect(() => { onBusyChange?.(tracking) }, [onBusyChange, tracking])
  async function submit() {
    if (!address || !client || !quoted || count <= 0n || busy) return
    const guard = () => { if (!mounted.current || currentIntent.current !== intent) throw new Error('The page, account, amount, currency, or project rules changed. Review the payment again.') }
    let latestBlock = prerequisite
    setPreparing(true); setError(null); setFailure(null); setRetrySlippageBps(null); setStage(null); setStatus('Getting the latest payment quote…')
    try {
      guard()
      const current = await verify(address, latestBlock)
      latestBlock = current.blockNumber
      guard()
      const latest = await prepareProjectPayQuote(client, { chainId, projectId, terminal: context.terminal, token: context.token, amount: count, beneficiary: address, slippageBps: slippage })
      guard()
      if (latest.blockNumber < latestBlock) throw new Error('The quote RPC has not caught up with the verified project state. Refresh the quote and try again.')
      latestBlock = latest.blockNumber
      const noTokens = reservedPercent === 10_000 && latest.minimumTokenCount === 0n && latest.reservedTokenCount > 0n
      if (latest.minimumTokenCount <= 0n && !noTokens) throw new Error('No protected token output is available for this payment.')
      const spender = latest.terminal
      const native = isAddressEqual(context.token, NATIVE_TOKEN)
      // Runs after review, simulation and the hold marker, right before the wallet prompt.
      const assertWriteState = () => { guard(); if (!quotedNow.current) throw new Error('The payment quote is no longer available. Review the payment again.') }
      const reverify = async () => { guard(); const checked = await verify(address, latestBlock); guard(); latestBlock = checked.blockNumber; return checked }
      const waitForApproval = async (action: PaymentTx, request: TxRequest, recoveryNamespace?: string) => {
        guard()
        const hash = await action.send(request, { reviewedAccount: address, simulationBlockNumber: latestBlock, reverify, assertWriteState: guard, ...(recoveryNamespace ? { recoveryNamespace } : {}) })
        if (!hash) throw new Error('Approval was cancelled. Nothing further was sent.')
        if (action.isSafe) { setStatus('Approval proposed to Safe. Execute it there, then continue the payment.'); return false }
        setStatus('Confirming approval onchain…')
        const receipt = await paymentReceipt(client, hash)
        if (receipt.status !== 'success') throw new Error('Approval reverted onchain.')
        if (latestBlock === undefined || receipt.blockNumber > latestBlock) latestBlock = receipt.blockNumber
        guard()
        return true
      }
      // One payment intent whichever terminal the quote picks; its approvals are that intent's steps.
      // A chosen currency's decimals are fixed, so its units key the amount. A default currency can
      // switch (ETH to USDC, say), and with it the units of the same typed amount: it keys as typed.
      const chosen = currencyChosen || !!selectedToken
      const payment = writeIntentKey('pay', { project: projectId, token: chosenOrAuto('token', keyed.address(context.token), chosen), amount: chosen ? count : canonicalDecimal(input) })
      if (!native) {
        const allowance = await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, spender], blockNumber: latestBlock })
        if (allowance < count) {
          setStatus(`Review ${context.symbol} access for the payment terminal.`); setStage('approve')
          if (!await waitForApproval(approval, { ...buildErc20ApproveRequest({ chainId, token: context.token, spender, amount: count }), label: `Approve exactly ${formatUnits(count, context.decimals)} ${context.symbol} for this payment` },
            approvalIntentKey(payment, { token: context.token, spender, step: 'token' }))) return
        }
      }
      const request = buildPayTx({ chainId, projectId, terminal: latest.terminal, token: context.token, amount: count, beneficiary: address, minReturnedTokens: latest.minimumTokenCount, memo: `Homerun ${tokenLabel} payment`, metadata: latest.metadata })
      const checked = await reverify()
      setStatus('Review and execute the payment.'); setStage('pay')
      let failed: unknown
      const paid = await tx.send({ ...request, label: `Pay ${formatUnits(count, context.decimals)} ${context.symbol} through the Juicebox payment terminal; minimum ${formatUnits(latest.minimumTokenCount, 18)} ${tokenLabel}` }, {
        reviewedAccount: address,
        assertWriteState,
        onFailure: reason => { failed = reason },
        // The terminal, minimum and metadata are fresh each attempt: a retry is held by the payment the user chose.
        recoveryNamespace: payment,
        simulationBlockNumber: latestBlock === undefined ? undefined : checked.blockNumber,
        reviewNotice: noTokens ? `You receive no ${tokenLabel} for this payment. This project allocates 100% of new tokens to its reserved recipients.` : latest.minimumTokenCount < minimum ? `The quote decreased. Your protected minimum is now ${formatUnits(latest.minimumTokenCount, 18)} ${tokenLabel}.` : undefined,
        reverify: async () => {
          const verified = await reverify()
          if (!native && await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'allowance', args: [address, spender], blockNumber: verified.blockNumber }) < count) throw new Error('Token approval changed. Review a new approval before paying.')
        },
      })
      if (failed !== undefined) explain(decodePayFailure(failed))
      // A receipt carries no reason: the same call at its block says why it reverts there.
      else if (paid && !tx.isSafe) void paymentReceipt(client, paid).then(async receipt => {
        if (receipt.status === 'success') return
        const reason = await client.simulateContract({ address: request.address, abi: request.abi, functionName: request.functionName, args: request.args, value: request.value, account: address, blockNumber: receipt.blockNumber }).then(() => undefined, (error: unknown) => error)
        if (mounted.current && currentIntent.current === intent) explain(decodePayFailure(reason))
      }).catch(() => {})
      setStatus(null)
    } catch (reason) { setError(message(reason)); setStatus(null) } finally { setPreparing(false) }
  }
  function explain(decoded: PayFailure | null) {
    setFailure(decoded)
    setRetrySlippageBps(payRetrySlippageBps(decoded, slippageBps ?? PAY_DEFAULT_SLIPPAGE_BPS))
  }
  /** Quote the payment again with the tolerance the payer chose, then run it from the start. */
  function reviewWithSlippage(bps: number) {
    setPayerSlippage({ bps, payment: paymentInputs })
    tx.reset(); setFailure(null); setRetrySlippageBps(null); setError(null); setRetryWhenQuoted(true)
  }
  const submitNow = useRef(submit)
  submitNow.current = submit
  // The retry runs once the quote with the chosen tolerance is in.
  useEffect(() => {
    if (!retryWhenQuoted || quote.isFetching) return
    setRetryWhenQuoted(false)
    if (quoted) void submitNow.current()
  }, [retryWhenQuoted, quote.isFetching, quoted])
  return <section id="pay-panel" className="pay-panel">
    <h3 className="sr-only">{title}</h3>
    {chainSelector ?? <p className="payment-chain-label mb-2">{tokenLabel === 'FUND' ? 'Fund' : 'Pay'} on {displayChainName(chainId)}</p>}
    <fieldset disabled={busy} className="m-0 mb-4 min-w-0 border-0 p-0">
      <div className="pay-amount-control">
        <input value={input} onChange={event => setInput(event.target.value)} inputMode="decimal" autoComplete="off" placeholder="0" maxLength={24} aria-label={`Amount in ${context.symbol}`} />
        <select className="pay-currency" aria-label="Payment currency" value={context.token} onChange={event => setSelectedToken(event.target.value as Address)}>{(tokenOptions.data?.length ? tokenOptions.data : [accountingContext]).map(option => <option key={option.token} value={option.token}>{option.symbol}</option>)}</select>
      </div>
    </fieldset>
    <button type="button" className="btn-primary min-h-12 w-full px-5" disabled={paused || !!blocked} onClick={() => setOpen(true)}>{paused ? 'Payments paused' : checking ? 'Checking…' : `Pay on ${displayChainName(chainId)}`}</button>
    {blocked && !paused && <p className="mt-2 text-sm text-[var(--muted)]">{blocked}</p>}
    {!open && <><Status tx={approval} chainId={chainId} /><Status tx={tx} chainId={chainId} /></>}
    <TxConfirmDialog
      open={open}
      eyebrow="Payment"
      title={tx.phase === 'success' ? `${tokenLabel === 'FUND' ? 'Contribution' : 'Payment'} confirmed` : `Confirm ${tokenLabel === 'FUND' ? 'contribution' : 'payment'}`}
      rows={[
        { label: 'Send', value: `${input || '0'} ${context.symbol}`, strong: true },
        { label: 'On', value: displayChainName(chainId) },
        { label: 'You get at least', value: quoted ? <><DisplayTokenAmount value={minimum} /> {tokenLabel}</> : zeroAllocation ? `No ${tokenLabel}` : quote.isFetching ? 'Quoting…' : '—', strong: true },
        ...(address ? [{ label: 'Beneficiary', value: address, mono: true }] : []),
      ]}
      steps={steps}
      activeIndex={activeIndex}
      action={!address ? 'Connect wallet' : retrySlippageBps !== null ? 'Review again' : `Confirm & ${payTitle.toLowerCase()}`}
      actionDisabled={!!address && (paused || count <= 0n || !quoted || retryWhenQuoted)}
      onConfirm={() => { if (!address) openSignIn(); else if (retrySlippageBps !== null) reviewWithSlippage(retrySlippageBps); else void submit() }}
      busy={prompting || retryWhenQuoted}
      complete={tx.phase === 'success'}
      settled={!!submitted}
      held={submitted?.held}
      status={submitted?.notice ?? status ?? (tx.phase === 'pending' ? <>Submitted. Waiting for onchain confirmation{tx.hash && explorerTxUrl(chainId, tx.hash) ? <> (<a className="underline" href={explorerTxUrl(chainId, tx.hash)!} target="_blank" rel="noreferrer">view transaction</a>)</> : null}</> : null)}
      error={error ?? failure?.message ?? tx.error ?? approval.error}
      onClose={() => { setOpen(false); for (const item of [tx, approval]) if (item.phase === 'submitted') item.dismiss(); setStatus(null); setFailure(null); setRetrySlippageBps(null) }}
    >
      <div className="text-sm text-smoke-600" aria-live="polite">
        {paused ? <p>This project has paused payments.</p> : zeroAllocation ? <p>This payment gives you no {tokenLabel}. All new tokens are allocated to the reserved recipients.</p> : quoted ? <p>Through the project payment terminal, using its current rules and buyback hook. {(slippageBps ?? PAY_DEFAULT_SLIPPAGE_BPS) / 100}% maximum slippage.</p>
          : quoteNeedsWallet && !address ? <p>Connect an allowed wallet to see your quote.</p>
          : count <= 0n ? <p>Enter an amount to see your {tokenLabel} quote.</p>
          : quote.isFetching ? <p>Getting your quote…</p> : null}
        {quote.isError && <p role="alert" className="mt-2">A protected payment quote is unavailable. {message(quote.error)}</p>}
      </div>
      {retrySlippageBps !== null ? <AllowedDecreaseField bps={retrySlippageBps} onChange={setRetrySlippageBps} limitPercent={PAY_SLIPPAGE_LIMIT_PERCENT} /> : null}
    </TxConfirmDialog>
  </section>
}
