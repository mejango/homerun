'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatUnits, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { useSavedAttempt } from '@bananapus/nana-sdk-core/review/react'
import { useReviewedAction, txPhaseLabel } from '@/hooks/useReviewedAction'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerAddressUrl, explorerTxUrl } from '@/lib/chainDisplay'
import { buildPayerTransaction, checkPayerFactory, decodePayerAttempt, getProjectPayerAddresses, payerAttemptKey, payerIntent, payerSavedAttempt, payerSettingsOfCall, verifyPayerReceipt, type PayerAttempt, type PayerSettings, type ProjectPayerRow } from '@/lib/project-payers'
import { attempts } from '@/lib/write-hold'
import { HeldNotice, retiringExit } from '@/components/ui/HeldWriteExit'
import { SavedAttemptNotice } from '@/components/ui/SavedAttemptNotice'

type Props = { chainId: JBChainId; projectId: bigint; tokenLabel?: string }
function message(error: unknown) { return error instanceof Error ? error.message : 'The payer address could not be verified.' }
function AddressLink({ chainId, address }: { chainId: number; address: Address }) {
  return <a className="break-all font-mono text-xs underline" href={explorerAddressUrl(chainId, address) ?? undefined} target="_blank" rel="noreferrer">{address}</a>
}
function facilitated(row: ProjectPayerRow) {
  try {
    const usd = BigInt(String(row.totalFacilitatedUsd).split('.')[0])
    if (usd === 0n && BigInt(row.totalFacilitated) > 0n) return 'Unpriced'
    if (usd > 0n && usd < 10n ** 16n) return '<$0.01'
    return Number(formatUnits(usd, 18)).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  } catch { return 'Unavailable' }
}

export function ProjectPayerAddresses(props: Props) {
  return <ProjectPayerAddressContext key={`${props.chainId}:${props.projectId}`} {...props} />
}

function ProjectPayerAddressContext({ chainId, projectId, tokenLabel = 'Project token' }: Props) {
  const client = usePublicClient({ chainId })
  const wallet = useWallet()
  const tx = useReviewedAction(chainId)
  const prefix = useId()
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [beneficiary, setBeneficiary] = useState('')
  const [addToBalance, setAddToBalance] = useState(false)
  const [memo, setMemo] = useState('')
  const [editable, setEditable] = useState(false)
  const [admin, setAdmin] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  /** The deployment this screen follows: what its receipt is verified against. */
  const following = useRef<{ settings: PayerSettings; account: Address; safe: boolean } | null>(null)
  /** A deployment its hold settled while the page was away, authenticated by its saved-attempt recovery. */
  const [recovered, setRecovered] = useState<string | null>(null)
  const rows = useQuery({ queryKey: ['project-payers', chainId, String(projectId)], queryFn: ({ signal }) => getProjectPayerAddresses(chainId, projectId, { signal }), staleTime: 30_000, refetchInterval: 30_000, retry: 1 })
  const factory = useQuery({ queryKey: ['project-payer-factory', chainId, String(projectId)], enabled: !!client, queryFn: () => checkPayerFactory(client!, chainId, projectId), staleTime: 30_000, retry: 1 })
  const track = tx.track

  // The payer journal from before SDK holds: an attempt it saved is only evidence for the recovery below.
  const key = payerAttemptKey(chainId, projectId)
  const [journalVersion, setJournalVersion] = useState(0)
  const journal = useMemo((): { saved: PayerAttempt | null; error?: string } => {
    void journalVersion
    try {
      const raw = localStorage.getItem(key)
      const saved = raw ? decodePayerAttempt(raw, chainId, projectId) : null
      return { saved: saved?.phase === 'signing' || saved?.phase === 'submitted' ? saved : null }
    } catch (reason) { return { saved: null, error: message(reason) } }
  }, [chainId, key, projectId, journalVersion])
  const storageError = journal.error ?? null
  const dropJournal = () => { localStorage.removeItem(key); setJournalVersion(value => value + 1) }
  // A finished journal attempt is only history.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw && !journal.saved && !journal.error) localStorage.removeItem(key)
    } catch { /* Read again on the next load. */ }
  }, [journal, key])

  // The project's payer deployment recovers through the SDK before anything is sent: a held one shows
  // with its exit, one that settled while away is authenticated and shown, one that can't be shown asks.
  const account = journal.saved?.account ?? wallet.address
  const attempt = useMemo(() => client && account && !journal.error
    ? payerSavedAttempt(client as PublicClient, chainId, projectId, account, tx.isSafe, journal.saved) : null,
  [account, chainId, client, journal, projectId, tx.isSafe])
  const saved = useSavedAttempt({ recovery: attempts, attempt, client, checkNext: 'Review payer creation' })
  const { outcome, retire } = saved
  useEffect(() => {
    if (!outcome || !attempt) return
    if (outcome.status === 'held') {
      const call = outcome.state.record.call
      const settings = journal.saved?.settings ?? payerSettingsOfCall(chainId, projectId, call.data)
      following.current = settings ? { settings, account: outcome.state.record.account, safe: outcome.state.record.safe } : null
      // The hold has the journal's attempt now: the journal goes.
      if (journal.saved) dropJournal()
      track({ chainId, call: { to: call.to, data: call.data, value: BigInt(call.value) } }, { reviewedAccount: outcome.state.record.account, recoveryNamespace: payerIntent(projectId), safe: outcome.state.record.safe, reservation: outcome.state.record.id })
    } else if (outcome.status === 'done' && outcome.result === 'success' && outcome.authenticated) {
      // Proven and shown here: followed, and the journal's record goes. One that can't be shown keeps its "Check again".
      setRecovered(`Payer deployment confirmed: ${outcome.value.payer}.`)
      void rows.refetch()
      if (journal.saved) dropJournal()
      else void retire({ by: 'settled', ...(outcome.hash ? { hash: outcome.hash } : {}) })
    } else if (outcome.status === 'none' && outcome.retired && journal.saved) dropJournal()
  // Each outcome is handled once; the journal and hold are read as they are now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome])
  // Nothing to recover without a wallet; with one, every send waits for its recovery's outcome.
  const ready = !attempt || !!outcome && (outcome.status === 'none' || (outcome.status === 'done' && (outcome.result === 'failed' || !!recovered)))
  const busy = preparing || tx.busy || tx.phase === 'review' || !ready

  // A deployment the hold settled is verified against its settings before its payer is shown, and the attempt is followed.
  const receipt = tx.phase === 'success' ? tx.receipt : null
  useEffect(() => { if (receipt) void retire({ by: 'settled', hash: receipt.transactionHash }) }, [receipt, retire])
  const deployed = useQuery({
    queryKey: ['project-payer-deployed', chainId, String(projectId), receipt?.transactionHash],
    enabled: !!client && !!receipt && !!following.current,
    queryFn: async () => {
      const { settings, account, safe } = following.current!
      const result = await verifyPayerReceipt(client!, { version: 1, settings, account, safe, phase: 'submitted', afterBlock: '0', hash: tx.submissionHash ?? receipt!.transactionHash }, receipt!)
      void rows.refetch()
      return result
    },
    staleTime: Infinity, retry: false,
  })

  async function create() {
    if (!wallet.address) { wallet.openSignIn(); return }
    if (!client || busy || storageError) return
    setPreparing(true); setError(null)
    try {
      const selectedBeneficiary = beneficiary.trim() || zeroAddress
      const selectedOwner = editable ? admin.trim() || wallet.address : zeroAddress
      if (!isAddress(selectedBeneficiary)) throw new Error('Enter a valid beneficiary address, or leave it empty for the original payer.')
      if (!isAddress(selectedOwner) || (editable && isAddressEqual(selectedOwner, zeroAddress))) throw new Error('Editable payer settings require a nonzero admin address.')
      const settings: PayerSettings = { chainId, projectId: String(projectId), beneficiary: selectedBeneficiary, owner: selectedOwner, memo: memo.trim(), addToBalance }
      const request = buildPayerTransaction(settings)
      await checkPayerFactory(client, chainId, projectId)
      following.current = { settings, account: wallet.address, safe: tx.isSafe }
      await tx.send({ ...request, label: `Create ${tokenLabel} payer address` }, {
        reviewedAccount: wallet.address,
        recoveryNamespace: payerIntent(projectId),
        reviewNotice: `Create a dedicated payer address for project #${projectId} on ${displayChainName(chainId)}. ${addToBalance ? 'ETH received adds to the project balance without minting tokens.' : `ETH received pays the project; ${tokenLabel} goes to ${isAddressEqual(selectedBeneficiary, zeroAddress) ? 'the original payer' : selectedBeneficiary}. Direct ETH transfers accept the current minting rate with no minimum token amount.`} ${editable ? `Admin ${selectedOwner} may change the routing and beneficiary later.` : 'Routing is immutable because the admin is the zero address.'} Sending other tokens directly does not forward them. This creates a payer contract and spends only gas; it does not deploy a FUND or INCOME project.`,
        reverify: async () => { await checkPayerFactory(client, chainId, projectId) },
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  async function copy(address: Address) {
    try { await navigator.clipboard.writeText(address); setCopied(address) }
    catch { setError('Copy is unavailable in this browser. Select and copy the full address above.') }
  }
  const duplicates = (rows.data ?? []).filter(row => row.defaultAddToBalance === addToBalance && isAddressEqual(row.defaultBeneficiary, (isAddress(beneficiary.trim()) ? beneficiary.trim() : zeroAddress) as Address))
  return <section className="demo-section space-y-6" aria-label={`${tokenLabel} payer addresses`}>
    <div>
      <h2>Payer addresses</h2>
      <p>Send ETH to a dedicated address to pay this project on {displayChainName(chainId)}. Anyone can create one. Other tokens must use the payment module.</p>
      {factory.data && !factory.data.acceptsNative && <p className="mt-3 text-xs text-[var(--muted)]">This project has no ETH terminal yet. Direct ETH transfers will revert until it adds one.</p>}
    </div>
    <div>
      <h3 className="text-[15px] font-medium">Deployed payer addresses</h3>
      {rows.isPending && <p className="mt-3 text-sm" role="status">Loading payer addresses…</p>}
      {rows.isError && <p className="mt-3 text-sm" role="alert">Could not load payer addresses from Bendystraw. <button type="button" className="quiet-button" onClick={() => void rows.refetch()}>Retry</button></p>}
      {rows.data?.length === 0 && <p className="mt-3 text-sm text-[var(--muted)]">No deployed payer addresses indexed yet.</p>}
      {!!rows.data?.length && <div className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">{rows.data.map(row => <article key={row.address} className="grid gap-3 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div><AddressLink chainId={chainId} address={row.address} /><button type="button" className="quiet-button mt-1 block" onClick={() => void copy(row.address)}>{copied === row.address ? 'Copied' : 'Copy address'}</button></div>
        <div><p>{row.defaultAddToBalance ? 'Add to balance, no tokens minted' : isAddressEqual(row.defaultBeneficiary, zeroAddress) ? `${tokenLabel} goes to the original payer` : <>{tokenLabel} beneficiary: <AddressLink chainId={chainId} address={row.defaultBeneficiary} /></>}</p>
          <p className="mt-1">{facilitated(row)} facilitated | {row.paymentsCount} payments | {row.addToBalanceCount} balance additions</p>
          <p className="mt-1 text-xs text-[var(--muted)]">{isAddressEqual(row.owner, zeroAddress) ? 'Immutable routing' : <>Editable routing. Admin: <AddressLink chainId={chainId} address={row.owner} /></>}</p>
        </div>
      </article>)}</div>}
    </div>
    <SavedAttemptNotice attempt={saved} title={`Create ${tokenLabel} payer address`} />
    {recovered && tx.phase === 'idle' && <p role="status" className="border-t border-[var(--line)] pt-6 text-sm">{recovered}</p>}
    {/* A deployment held for this project shows with its exit, whatever is entered or the factory allows now. */}
    {(tx.phase === 'submitted' || tx.phase === 'pending' || tx.phase === 'success' || storageError) && <div className="border-t border-[var(--line)] pt-6 text-sm" role="status">
      {storageError ? <p role="alert">{storageError}</p>
        : tx.phase === 'submitted' ? <HeldNotice tx={{ notice: tx.notice, held: retiringExit(tx.held, retire) }} />
        : tx.phase === 'pending' ? <p>Submitted. Verifying the payer deployment onchain…</p>
        : deployed.data?.status === 'confirmed' ? <><p>Payer deployment confirmed.</p><p className="mt-2 text-xs text-[var(--muted)]">This confirms the original deployment. Use the list above for current routing; an admin may have changed it. New addresses appear once indexed.</p></>
        : deployed.data?.status === 'reverted' ? <p>The payer deployment reverted. No payer was created by this call. Review the settings before trying again.</p>
        : deployed.isError ? <p>The transaction confirmed, but the payer deployment could not be verified. {message(deployed.error)}</p>
        : <p>Confirmed. Verifying the payer deployment…</p>}
      {tx.hash && <a className="mt-2 block underline" href={explorerTxUrl(chainId, tx.hash) ?? undefined} target="_blank" rel="noreferrer">View transaction</a>}
    </div>}
    <details className="border-t border-[var(--line)] pt-6">
      <summary className="cursor-pointer text-[15px] font-medium">Create payer address</summary>
      <fieldset disabled={busy || !!storageError} className="mt-5 space-y-4">
        <div><label className="block text-sm" htmlFor={`${prefix}-behavior`}>Payment behavior</label><select id={`${prefix}-behavior`} className="mt-2 min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" value={addToBalance ? 'balance' : 'pay'} onChange={event => setAddToBalance(event.target.value === 'balance')}><option value="pay">Pay and mint {tokenLabel}</option><option value="balance">Add to balance without minting</option></select></div>
        {!addToBalance && <div><label className="block text-sm" htmlFor={`${prefix}-beneficiary`}>{tokenLabel} beneficiary</label><input id={`${prefix}-beneficiary`} className="mt-2 min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" value={beneficiary} onChange={event => setBeneficiary(event.target.value)} placeholder="Original payer (default)" /><p className="mt-2 text-xs text-[var(--muted)]">Leave empty for the original payer, or enter a fixed wallet.</p></div>}
        <div><label className="block text-sm" htmlFor={`${prefix}-memo`}>Memo (optional)</label><input id={`${prefix}-memo`} className="mt-2 min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" maxLength={500} value={memo} onChange={event => setMemo(event.target.value)} /></div>
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={editable} onChange={event => setEditable(event.target.checked)} />Allow an admin to edit this payer’s routing</label>
        {editable && <div><label className="block text-sm" htmlFor={`${prefix}-admin`}>Address admin</label><input id={`${prefix}-admin`} className="mt-2 min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" value={admin} onChange={event => setAdmin(event.target.value)} placeholder={wallet.address ?? '0x…'} /><p className="mt-2 text-xs text-[var(--muted)]">Defaults to your wallet. The admin can redirect future payments to another project or beneficiary.</p></div>}
        {duplicates.length > 0 && <p className="text-xs text-[var(--muted)]">{duplicates.length} indexed address{duplicates.length === 1 ? ' already uses' : 'es already use'} this payment behavior and beneficiary. You can reuse an address above.</p>}
        {factory.isPending && <p className="text-xs text-[var(--muted)]" role="status">Verifying the payer factory…</p>}
        {factory.isError && <p className="text-sm" role="alert">Payer creation is unavailable: {message(factory.error)} <button type="button" className="quiet-button" onClick={() => void factory.refetch()}>Retry verification</button></p>}
        <button type="button" className="btn-primary min-h-11 px-5" disabled={!factory.data || factory.isError} onClick={() => void create()}>{!wallet.address ? 'Connect wallet' : preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review payer creation', pending: 'Confirming onchain…' })}</button>
      </fieldset>
    </details>
    {(error || storageError || tx.error) && <p className="text-sm text-red-800" role="alert">{error || storageError || tx.error}</p>}
  </section>
}

