'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { usePublicClient } from 'wagmi'
import { formatUnits, parseUnits, type Address, type PublicClient } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { DisplayTokenAmount } from './DisplayTokenAmount'
import { CENTER_WALLET_CONFIG } from '@/providers/wallet-config'
import { centerWalletClient } from '@/providers/center-runtime'
import { createHomerunPayment } from '@/lib/center-payment'
import { prepareProjectPayQuote } from '@/lib/project-pay-quote'

type Controller = ReturnType<typeof createHomerunPayment>
type Pending = ReturnType<Controller['pending']>
const statuses = {
  reviewing: 'Review this payment in Juicebox wallet and approve with your passkey.',
  approved: 'Approved. Submit this exact payment when you are ready.',
  submitting: 'Checking the original submission…', pending: 'Submitted. Waiting for confirmation…',
  confirming: 'Confirming the payment onchain…', paid: 'Payment confirmed onchain.', reverted: 'The payment reverted onchain.',
  cancelled: 'The payment review was cancelled.', unknown: 'The payment outcome is not confirmed. Check its status before making another payment.',
}
export default function CenterProjectPayment({ chainId, projectId, tokenLabel, title, paused, verify, chainSelector, onBusyChange }: {
  chainId: JBChainId; projectId: bigint; tokenLabel: 'FUND' | 'INCOME'; title: string; paused: boolean;
  verify: (account: Address, minimumBlock?: bigint) => Promise<{ blockNumber: bigint }>;
  chainSelector?: ReactNode; onBusyChange?: (busy: boolean) => void
}) {
  const { address } = useWallet(), client = usePublicClient({ chainId }) as PublicClient | undefined
  const [controller, setController] = useState<Controller | null>(null), [pending, setPending] = useState<Pending>(null)
  const [input, setInput] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const generation = useRef(''), working = useRef(false), live = useRef(true)
  const identity = `${chainId}:${projectId}:${address ?? ''}:${paused}`
  generation.current = identity
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    try {
      if (!CENTER_WALLET_CONFIG) throw new Error('Juicebox wallet is unavailable on this site.')
      const value = createHomerunPayment({ config: CENTER_WALLET_CONFIG, wallet: centerWalletClient(), storage: window.sessionStorage })
      setController(value); setPending(value.pending())
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your saved payment could not be restored.') }
  }, [])
  const matching = pending?.intent.projectId === projectId.toString() && chainId === 8453
  const status = pending?.status?.status
  const terminal = !!status && ['paid', 'cancelled', 'reverted'].includes(status)
  useEffect(() => { onBusyChange?.(busy || !!pending && !terminal); return () => onBusyChange?.(false) }, [busy, pending, terminal, onBusyChange])
  async function run(action: () => Promise<unknown>) {
    if (working.current) return
    working.current = true; setBusy(true); setError(null)
    try { await action() }
    catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : 'This payment could not be checked. Keep its original record.') }
    finally { working.current = false; if (live.current) { setBusy(false); try { setPending(controller?.pending() ?? null) } catch { setError('The saved payment is unavailable. Return to its original tab.') } } }
  }
  const guard = () => { if (!live.current || generation.current !== identity) throw new Error('The project or wallet changed. Return to the original payment.') }
  async function review() {
    if (!controller || !address || !client || chainId !== 8453 || paused) return
    await run(async () => {
      if (pending) {
        const restored = await controller.prepare(pending.intent)
        guard(); if (!restored.approvalUrl) throw new Error('The original review is unavailable. Check payment status.')
        window.location.assign(restored.approvalUrl); return
      }
      if (!/^[0-9]+(?:\.[0-9]{1,6})?$/.test(input.trim())) throw new Error('Enter a USDC amount with at most six decimal places.')
      const amount = parseUnits(input.trim(), 6); if (amount <= 0n) throw new Error('Enter an amount greater than zero.')
      await verify(address); guard()
      const token = USDC_ADDRESSES[8453]!, terminal = v6Address('JBMultiTerminal', 8453)
      const quote = await prepareProjectPayQuote(client, { chainId: 8453, projectId, token, terminal, amount, beneficiary: address, directTerminalOnly: true })
      guard()
      const reviewed = await controller.prepare({ projectId: projectId.toString(), token, terminal, amount: amount.toString(),
        minimumReturnedTokens: quote.minimumTokenCount.toString(), returnPath: window.location.pathname })
      guard(); if (!reviewed.approvalUrl) throw new Error('The payment review is unavailable. Check its saved status.')
      window.location.assign(reviewed.approvalUrl)
    })
  }
  async function submit() {
    if (!controller || !address || !matching || paused) return
    await run(async () => { await verify(address); guard(); await controller.submit() })
  }
  // Bounded observation only. Visibility/offline changes pause requests; no interval submits.
  useEffect(() => {
    if (!controller || !matching || !status || !['pending', 'confirming', 'submitting'].includes(status)) return
    let cancelled = false, attempts = 0, checking = false
    const timer = window.setInterval(() => {
      if (document.hidden || !navigator.onLine || checking || working.current) return
      if (++attempts > 30) { window.clearInterval(timer); return }
      checking = true
      void controller.refresh().then(() => { if (!cancelled) setPending(controller.pending()) }, () => {
        if (!cancelled) setError('Confirmation is temporarily unavailable. Keep the original payment and check again.')
      }).finally(() => { checking = false })
    }, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [controller, matching, status])
  return <section aria-label={title} className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
    {chainSelector}
    <h3 className="text-lg">Pay with Juicebox wallet</h3>
    {chainId !== 8453 ? <p className="mt-3 text-sm">Choose Base to pay with your Juicebox wallet, or connect an external wallet for this network.</p>
      : pending && !matching ? <p className="mt-3 text-sm"><Link className="underline" href={pending.intent.returnPath}>Resume your original payment</Link> before preparing another.</p>
      : <>
        <p className="mt-3 text-sm">USDC on Base, through the project payment terminal. Review the amount, token return and network fee in Juicebox wallet.</p>
        {address ? <details className="mt-3 text-sm"><summary className="cursor-pointer underline">Add funds to this wallet</summary>
          <p className="mt-2">Send Base USDC to pay, and Base ETH for network fees. Your wallet address:</p>
          <p className="mt-2 break-all">{address}</p></details> : null}
        {!pending ? <label className="mt-4 grid gap-2 text-sm">Amount in USDC<input inputMode="decimal" autoComplete="off" value={input}
          disabled={busy || paused} onChange={event => setInput(event.target.value)} className="min-h-12 border border-[#bfc9b5] bg-white px-3" /></label> : null}
        {matching ? <dl className="mt-4 text-sm"><dt>Payment</dt><dd>{formatUnits(BigInt(pending!.intent.amount), 6)} USDC</dd>
          {pending?.status?.expectedPayment ? <><dt className="mt-2">Minimum returned</dt><dd><DisplayTokenAmount value={BigInt(pending.status.expectedPayment.minimumReturnedTokens)} /> {tokenLabel}</dd></> : null}</dl> : null}
        <p role="status" aria-live="polite" className="mt-4 break-words text-sm">{paused ? 'This project has paused payments.' : status ? statuses[status] : 'Each payment needs your passkey approval.'}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          {!pending || (!pending.submitted && (!status || status === 'reviewing')) ? <button type="button" className="btn-primary min-h-11 px-4" disabled={busy || paused || !controller} onClick={() => void review()}>{busy ? 'Preparing…' : pending ? status ? 'Return to passkey review' : 'Resume payment preparation' : 'Review with a passkey'}</button> : null}
          {status === 'approved' && !pending?.submitted ? <button type="button" className="btn-primary min-h-11 px-4" disabled={busy || paused} onClick={() => void submit()}>Submit payment</button> : null}
          {pending && !terminal ? <button type="button" className="btn-secondary min-h-11 px-4" disabled={busy} onClick={() => void run(() => controller!.refresh())}>Check payment status</button> : null}
          {terminal ? <button type="button" className="btn-secondary min-h-11 px-4" disabled={busy} onClick={() => void run(async () => { controller!.clear(); setInput('') })}>Close payment</button> : null}
        </div>
        {pending?.status?.transactionHash ? <a className="mt-4 block break-words text-sm underline" href={`https://basescan.org/tx/${pending.status.transactionHash}`} target="_blank" rel="noreferrer">View transaction</a> : null}
      </>}
    {error ? <p role="alert" className="mt-4 break-words text-sm text-red-800">{error}</p> : null}
  </section>
}
