'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { formatUnits, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem'
import { usePublicClient } from 'wagmi'
import { useSafeTx, txPhaseLabel } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerAddressUrl, explorerTxUrl } from '@/lib/chainDisplay'
import { buildPayerTransaction, checkPayerFactory, decodePayerAttempt, getProjectPayerAddresses, payerAttemptHold, payerAttemptKey, payerIntent, verifyPayerReceipt, type PayerSettings, type ProjectPayerRow } from '@/lib/project-payers'
import { adoptLegacyWrite } from '@/lib/write-hold'
import { HeldNotice } from '@/components/ui/HeldWriteExit'

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
  const tx = useSafeTx(chainId)
  const prefix = useId()
  const [storageError, setStorageError] = useState<string | null>(null)
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
  const busy = preparing || tx.busy || tx.phase === 'review'
  const rows = useQuery({ queryKey: ['project-payers', chainId, String(projectId)], queryFn: ({ signal }) => getProjectPayerAddresses(chainId, projectId, { signal }), staleTime: 30_000, refetchInterval: 30_000, retry: 1 })
  const factory = useQuery({ queryKey: ['project-payer-factory', chainId, String(projectId)], enabled: !!client, queryFn: () => checkPayerFactory(client!, chainId, projectId), staleTime: 30_000, retry: 1 })
  const track = tx.track

  // An attempt the payer journal saved before SDK holds is adopted into its hold, then the journal goes.
  useEffect(() => {
    if (!client) return
    let cancelled = false
    void (async () => {
      const key = payerAttemptKey(chainId, projectId)
      const raw = localStorage.getItem(key)
      if (!raw) return
      const saved = decodePayerAttempt(raw, chainId, projectId)
      if (saved.phase === 'signing' || saved.phase === 'submitted') {
        const { input, evidence } = payerAttemptHold(saved)
        await adoptLegacyWrite(input, evidence, client)
        if (localStorage.getItem(key) === raw) localStorage.removeItem(key)
        if (cancelled) return
        following.current = { settings: saved.settings, account: saved.account, safe: saved.safe }
        await track({ ...buildPayerTransaction(saved.settings), label: `Create ${tokenLabel} payer address` }, { reviewedAccount: saved.account, recoveryNamespace: input.namespace, safe: saved.safe })
      } else if (localStorage.getItem(key) === raw) localStorage.removeItem(key)
    })().catch(reason => { if (!cancelled) setStorageError(message(reason)) })
    return () => { cancelled = true }
  }, [chainId, client, projectId, tokenLabel, track])

  // A deployment the hold settled is verified against its settings before its payer is shown.
  const receipt = tx.phase === 'success' ? tx.receipt : null
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
        recoveryNamespace: payerIntent(settings),
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
    {(tx.phase === 'submitted' || tx.phase === 'pending' || tx.phase === 'success' || storageError) && <div className="border-t border-[var(--line)] pt-6 text-sm" role="status">
      {storageError ? <p role="alert">{storageError}</p>
        : tx.phase === 'submitted' ? <HeldNotice tx={tx} />
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
