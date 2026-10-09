'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { formatUnits, isAddress, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { useSafeTx, txPhaseLabel } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerAddressUrl, explorerTxUrl } from '@/lib/chainDisplay'
import { adoptPayerProposal, buildPayerTransaction, checkPayerFactory, decodePayerAttempt, getProjectPayerAddresses, payerAttemptIdentity, payerAttemptKey, persistPayerAttempt, verifyPayerReceipt, withPayerAttemptLock, type PayerAttempt, type ProjectPayerRow } from '@/lib/project-payers'
import { waitForSafeExecutionHash } from '@/lib/safe-connector'

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
  const storageKey = payerAttemptKey(chainId, projectId)
  const [attempt, setAttempt] = useState<PayerAttempt | null>(null)
  const storedRaw = useRef<string | null>(null)
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [beneficiary, setBeneficiary] = useState('')
  const [addToBalance, setAddToBalance] = useState(false)
  const [memo, setMemo] = useState('')
  const [editable, setEditable] = useState(false)
  const [admin, setAdmin] = useState('')
  const [recoveryHash, setRecoveryHash] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const unresolved = !!attempt && (attempt.phase === 'signing' || attempt.phase === 'submitted')
  const proofIdentity = attempt ? payerAttemptIdentity(attempt) : null
  const busy = preparing || tx.busy || tx.phase === 'review'
  const rows = useQuery({ queryKey: ['project-payers', chainId, String(projectId)], queryFn: ({ signal }) => getProjectPayerAddresses(chainId, projectId, { signal }), staleTime: 30_000, refetchInterval: 30_000, retry: 1 })
  const factory = useQuery({ queryKey: ['project-payer-factory', chainId, String(projectId)], enabled: !!client, queryFn: () => checkPayerFactory(client!, chainId, projectId), staleTime: 30_000, retry: 1 })

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      storedRaw.current = raw
      if (raw) {
        const saved = decodePayerAttempt(raw, chainId, projectId)
        // Persisted success is a recovery hint. Re-prove its receipt before
        // treating the old deployment as confirmed or releasing its lock.
        setAttempt(saved.phase === 'confirmed' || saved.phase === 'reverted' ? { ...saved, phase: 'submitted' } : saved)
      }
    } catch (reason) { setStorageError(message(reason)) }
    setReady(true)
  }, [chainId, projectId, storageKey])

  const save = useCallback((next: PayerAttempt | null, expected: string | null, prewallet = false) => {
    storedRaw.current = persistPayerAttempt(localStorage, chainId, projectId, next, expected, prewallet)
    setAttempt(next)
  }, [chainId, projectId])
  const confirmation = useQuery({
    queryKey: ['project-payer-confirmation', chainId, String(projectId), proofIdentity],
    enabled: !!client && unresolved && !!(attempt?.hash || attempt?.executionHash),
    queryFn: async ({ signal }) => {
      const saved = attempt!
      const savedRaw = storedRaw.current
      const executionHash = saved.executionHash ?? (saved.safe ? await waitForSafeExecutionHash(chainId, saved.hash!, { signal }) : saved.hash!)
      const receipt = await client!.getTransactionReceipt({ hash: executionHash })
      return { ...await verifyPayerReceipt(client!, saved, receipt), executionHash, proofFor: payerAttemptIdentity(saved), savedRaw }
    },
    staleTime: 0, refetchOnMount: 'always', retry: false, refetchInterval: unresolved ? 5_000 : false,
  })
  useEffect(() => {
    if (!confirmation.data || !confirmation.isFetchedAfterMount || confirmation.isFetching || confirmation.isError || confirmation.data.proofFor !== proofIdentity || !attempt || !unresolved) return
    const result = confirmation.data
    const next: PayerAttempt = { ...attempt, phase: result.status, executionHash: result.executionHash, ...(result.status === 'confirmed' ? { payer: result.payer } : {}) }
    void withPayerAttemptLock(storageKey, async () => { save(next, result.savedRaw); tx.reset(); void rows.refetch() })
      .catch(reason => setStorageError(message(reason)))
  }, [attempt, confirmation.data, confirmation.isFetchedAfterMount, confirmation.isFetching, confirmation.isError, proofIdentity, rows, save, storageKey, tx, unresolved])

  async function create() {
    if (!wallet.address) { wallet.openSignIn(); return }
    if (!client || busy || unresolved || !ready || storageError) return
    setPreparing(true); setError(null)
    try {
      const selectedBeneficiary = beneficiary.trim() || zeroAddress
      const selectedOwner = editable ? admin.trim() || wallet.address : zeroAddress
      if (!isAddress(selectedBeneficiary)) throw new Error('Enter a valid beneficiary address, or leave it empty for the original payer.')
      if (!isAddress(selectedOwner) || (editable && isAddressEqual(selectedOwner, zeroAddress))) throw new Error('Editable payer settings require a nonzero admin address.')
      const settings = { chainId, projectId: String(projectId), beneficiary: selectedBeneficiary, owner: selectedOwner, memo: memo.trim(), addToBalance }
      const request = buildPayerTransaction(settings)
      await checkPayerFactory(client, chainId, projectId)
      let saved: PayerAttempt = { version: 1, id: crypto.randomUUID(), settings, account: wallet.address, safe: tx.isSafe, phase: 'signing', afterBlock: '0' }
      const assertNoPending = () => {
        const existing = localStorage.getItem(storageKey)
        if (existing) {
          const current = decodePayerAttempt(existing, chainId, projectId)
          if (current.phase === 'signing' || current.phase === 'submitted') throw new Error('Another payer deployment is unresolved. Check its confirmation before creating another.')
        }
      }
      await withPayerAttemptLock(storageKey, async () => {
        let attemptedRaw: string | null = null
        const persistSubmitted = (hash: Hex, safe?: boolean) => {
          if (!attemptedRaw || (safe !== undefined && saved.safe !== safe)) throw new Error('The saved payer deployment does not match the submitted wallet write.')
          if (saved.hash === hash) return
          const next: PayerAttempt = { ...saved, phase: 'submitted', hash }
          save(next, attemptedRaw)
          saved = next
          attemptedRaw = storedRaw.current
        }
        const hash = await tx.send({ ...request, label: `Create ${tokenLabel} payer address` }, {
          reviewedAccount: saved.account,
          reviewNotice: `Create a dedicated payer address for project #${projectId} on ${displayChainName(chainId)}. ${addToBalance ? 'ETH received adds to the project balance without minting tokens.' : `ETH received pays the project; ${tokenLabel} goes to ${isAddressEqual(selectedBeneficiary, zeroAddress) ? 'the original payer' : selectedBeneficiary}. Direct ETH transfers accept the current minting rate with no minimum token amount.`} ${editable ? `Admin ${selectedOwner} may change the routing and beneficiary later.` : 'Routing is immutable because the admin is the zero address.'} Sending other tokens directly does not forward them. This creates a payer contract and spends only gas; it does not deploy a FUND or INCOME project.`,
          reverify: async () => { await checkPayerFactory(client, chainId, projectId) },
          onExistingProposal: proposal => { assertNoPending(); const previous = localStorage.getItem(storageKey); saved = adoptPayerProposal(saved, proposal); save(saved, previous); attemptedRaw = storedRaw.current },
          durableRecovery: {
            reserve: async () => {
              saved.afterBlock = String(await client.getBlockNumber({ cacheTime: 0 }))
              assertNoPending()
              save(saved, localStorage.getItem(storageKey), true)
              attemptedRaw = storedRaw.current
            },
            releaseUnsubmitted: () => {
              if (!attemptedRaw) return
              if (saved.hash || saved.executionHash) throw new Error('A submitted payer deployment must remain saved until its execution is verified.')
              save(null, attemptedRaw)
              attemptedRaw = null
            },
            submitted: persistSubmitted,
          },
        })
        if (hash) persistSubmitted(hash)
      })
    } catch (reason) { setError(message(reason)) } finally { setPreparing(false) }
  }
  async function copy(address: Address) {
    try { await navigator.clipboard.writeText(address); setCopied(address) }
    catch { setError('Copy is unavailable in this browser. Select and copy the full address above.') }
  }
  async function recover() {
    if (!attempt || !/^0x[0-9a-fA-F]{64}$/.test(recoveryHash.trim())) { setError('Enter the onchain transaction hash from your wallet or Safe execution.'); return }
    const expected = storedRaw.current
    try { setError(null); await withPayerAttemptLock(storageKey, async () => save({ ...attempt, executionHash: recoveryHash.trim() as Hex, phase: 'submitted' }, expected)) }
    catch (reason) { setStorageError(message(reason)) }
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
    {attempt && <div className="border-t border-[var(--line)] pt-6 text-sm" role="status">
      {attempt.phase === 'confirmed' && attempt.payer ? <><p>Payer deployment confirmed.</p><p className="mt-2 text-xs text-[var(--muted)]">This confirms the original deployment. Use the list above for current routing; an admin may have changed it. New addresses appear once indexed.</p></> : attempt.phase === 'reverted' ? <p>The payer deployment reverted. No payer was created by this call. Review the settings before trying again.</p> : <>
        <p>{attempt.safe && attempt.hash && !attempt.executionHash ? 'Proposed to Safe. Execution and onchain confirmation are still required.' : attempt.hash || attempt.executionHash ? 'Submitted. Verifying the payer deployment onchain…' : 'The wallet was asked to submit this deployment. Check your wallet before creating another payer address.'}</p>
        {!attempt.hash && tx.submissionHash && <p className="mt-2 break-all">{attempt.safe ? 'Safe proposal' : 'Submitted transaction'}: <code>{tx.submissionHash}</code></p>}
        {confirmation.isError && <p className="mt-2">Confirmation is unavailable. {message(confirmation.error)}</p>}
        <details className="mt-3"><summary className="quiet-button cursor-pointer">Recover confirmation</summary><p className="mt-2 text-xs text-[var(--muted)]">Paste the executed transaction hash from your wallet or Safe. The call and settings are verified before another deployment is enabled.</p><label className="mt-3 block text-sm" htmlFor={`${prefix}-recovery`}>Onchain transaction hash</label><input id={`${prefix}-recovery`} className="mt-2 min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder="0x…" /><button type="button" className="btn-secondary mt-3 min-h-10 px-4" onClick={recover}>Verify execution</button></details>
      </>}
      {(attempt.executionHash || (!attempt.safe && attempt.hash)) && <a className="mt-2 block underline" href={explorerTxUrl(chainId, attempt.executionHash ?? attempt.hash!) ?? undefined} target="_blank" rel="noreferrer">View transaction</a>}
    </div>}
    <details className="border-t border-[var(--line)] pt-6">
      <summary className="cursor-pointer text-[15px] font-medium">Create payer address</summary>
      <fieldset disabled={busy || unresolved || !!storageError} className="mt-5 space-y-4">
        <div><label className="block text-sm" htmlFor={`${prefix}-behavior`}>Payment behavior</label><select id={`${prefix}-behavior`} className="mt-2 min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" value={addToBalance ? 'balance' : 'pay'} onChange={event => setAddToBalance(event.target.value === 'balance')}><option value="pay">Pay and mint {tokenLabel}</option><option value="balance">Add to balance without minting</option></select></div>
        {!addToBalance && <div><label className="block text-sm" htmlFor={`${prefix}-beneficiary`}>{tokenLabel} beneficiary</label><input id={`${prefix}-beneficiary`} className="mt-2 min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" value={beneficiary} onChange={event => setBeneficiary(event.target.value)} placeholder="Original payer (default)" /><p className="mt-2 text-xs text-[var(--muted)]">Leave empty for the original payer, or enter a fixed wallet.</p></div>}
        <div><label className="block text-sm" htmlFor={`${prefix}-memo`}>Memo (optional)</label><input id={`${prefix}-memo`} className="mt-2 min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" maxLength={500} value={memo} onChange={event => setMemo(event.target.value)} /></div>
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={editable} onChange={event => setEditable(event.target.checked)} />Allow an admin to edit this payer’s routing</label>
        {editable && <div><label className="block text-sm" htmlFor={`${prefix}-admin`}>Address admin</label><input id={`${prefix}-admin`} className="mt-2 min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" value={admin} onChange={event => setAdmin(event.target.value)} placeholder={wallet.address ?? '0x…'} /><p className="mt-2 text-xs text-[var(--muted)]">Defaults to your wallet. The admin can redirect future payments to another project or beneficiary.</p></div>}
        {duplicates.length > 0 && <p className="text-xs text-[var(--muted)]">{duplicates.length} indexed address{duplicates.length === 1 ? ' already uses' : 'es already use'} this payment behavior and beneficiary. You can reuse an address above.</p>}
        {factory.isPending && <p className="text-xs text-[var(--muted)]" role="status">Verifying the payer factory…</p>}
        {factory.isError && <p className="text-sm" role="alert">Payer creation is unavailable: {message(factory.error)} <button type="button" className="quiet-button" onClick={() => void factory.refetch()}>Retry verification</button></p>}
        <button type="button" className="btn-primary min-h-11 px-5" disabled={!ready || !factory.data || factory.isError} onClick={() => void create()}>{!wallet.address ? 'Connect wallet' : preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review payer creation', pending: 'Confirming onchain…' })}</button>
      </fieldset>
    </details>
    {(error || storageError || tx.error) && <p className="text-sm text-red-800" role="alert">{error || storageError || tx.error}</p>}
  </section>
}
