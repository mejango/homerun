'use client'

import type { JBChainId } from '@bananapus/nana-sdk-core'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { decodeEventLog, decodeFunctionData, encodeFunctionData, formatUnits, isAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { useSafeTx, txPhaseLabel } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import { getFundGlobalClaim, type FundGlobalManifest, type GlobalIncomeAllocation } from '@/lib/fund-global-manifest'
import { homerunInitialIncomeVaultAbi, readInitialIncomeAllocation, type InitialIncomeAllocationState } from '@/lib/income-allocation-state'
import { JBCENTER_IPFS_GATEWAY } from '@/lib/jbcenter-ipfs'
import { waitForSafeExecutionHash } from '@/lib/safe-connector'
import { verifyStickyExecution } from '@/lib/sticky-session'

const DOWNLOAD_BYTES = 32 * 1024 * 1024
const LOCAL_BYTES = 128 * 1024 * 1024
const hashPattern = /^0x[\da-fA-F]{64}$/
const message = (error: unknown) => error instanceof Error ? error.message : 'The initial allocation could not be verified.'
type Claim = GlobalIncomeAllocation['holders'][number]
type PendingClaim = {
  version: 1; chainId: number; fundProjectId: string; incomeProjectId: string
  holder: Address; target: Address; data: Hex; safe: boolean; submittedAt: number; afterBlock: string; hash?: Hex
}
function sessionKey(chainId: number, fund: bigint | string, income: bigint | string, holder: Address) {
  return `homerun:initial-income-claim:v1:${chainId}:${fund}:${income}:${holder.toLowerCase()}`
}
function pendingKey(record: PendingClaim) { return sessionKey(record.chainId, record.fundProjectId, record.incomeProjectId, record.holder) }
function readPending(key: string): PendingClaim | null {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  let value: PendingClaim
  try {
    value = JSON.parse(raw)
    if (value.version !== 1 || !Number.isSafeInteger(value.chainId) || value.chainId <= 0 || !/^[1-9]\d*$/.test(value.fundProjectId) || !/^[1-9]\d*$/.test(value.incomeProjectId) || !isAddress(value.holder) || !isAddress(value.target) || typeof value.data !== 'string' || value.data.length > 25_000 || typeof value.safe !== 'boolean' || !/^(0|[1-9]\d*)$/.test(value.afterBlock) || !Number.isSafeInteger(value.submittedAt) || (value.hash !== undefined && !hashPattern.test(value.hash)) || pendingKey(value) !== key) throw new Error()
    const call = decodeFunctionData({ abi: homerunInitialIncomeVaultAbi, data: value.data })
    if (call.functionName !== 'claim' || !isAddressEqual(call.args[1], value.holder) || call.args[2] <= 0n || call.args[3] <= 0n) throw new Error()
  } catch { throw new Error('The saved initial claim is unreadable. Restore its recovery record before sending another claim.') }
  return value
}
function savePending(record: PendingClaim) {
  const key = pendingKey(record), json = JSON.stringify(record)
  localStorage.setItem(key, json)
  if (localStorage.getItem(key) !== json) throw new Error('The browser could not save claim recovery data. The claim was not sent.')
}
function clearPending(record: PendingClaim) {
  const current = readPending(pendingKey(record))
  if (current?.submittedAt === record.submittedAt && current.data === record.data && current.target === record.target) localStorage.removeItem(pendingKey(record))
}
function manifestUrl(uri: string): string {
  // The committed URI cannot redirect this browser to arbitrary metadata hosts.
  const match = /^ipfs:\/\/([a-zA-Z0-9]{32,128})(\/[a-zA-Z0-9._/-]*)?$/.exec(uri)
  if (!match || (match[2] ?? '').split('/').some(part => part === '.' || part === '..')) throw new Error('The published snapshot must have an IPFS URI. Import the committed manifest file to continue.')
  return `${JBCENTER_IPFS_GATEWAY}${match[1]}${match[2] ?? ''}`
}
async function downloadManifest(uri: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(manifestUrl(uri), { signal, redirect: 'error' })
  if (!response.ok) throw new Error('The snapshot download is unavailable. Try again or import the published manifest file.')
  if (Number(response.headers.get('content-length')) > DOWNLOAD_BYTES) throw new Error('This snapshot is too large for automatic loading. Download and import the manifest file.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('This browser cannot stream the snapshot. Import the published manifest file.')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0, body = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > DOWNLOAD_BYTES) throw new Error('This snapshot is too large for automatic loading. Download and import the manifest file.')
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    return JSON.parse(body)
  } finally { await reader.cancel().catch(() => undefined) }
}
function verifiedManifest(value: unknown, state: InitialIncomeAllocationState): FundGlobalManifest {
  return getFundGlobalClaim(value, state, zeroAddress).manifest
}
function manifestBindingKey(state: InitialIncomeAllocationState): string {
  return `${state.chainId}:${state.fundProjectId}:${state.incomeProjectId}:${state.vault.toLowerCase()}:${state.distributionId.toLowerCase()}:${state.manifestHash.toLowerCase()}`
}
function displayedFundPosition(claim: Claim): string {
  if (!claim.fundWeight) return formatUnits(BigInt(claim.fundBalance), 18)
  const numerator = BigInt(claim.fundWeight.numerator), denominator = BigInt(claim.fundWeight.denominator)
  const whole = numerator / denominator
  if (numerator % denominator === 0n) return formatUnits(whole, 18)
  return whole === 0n ? 'Less than 0.000000000000000001' : `≈ ${formatUnits(whole, 18)}`
}
function sameVault(left: InitialIncomeAllocationState, right: InitialIncomeAllocationState) {
  if (!isAddressEqual(left.vault, right.vault) || !isAddressEqual(left.incomeToken, right.incomeToken) || left.manifestHash.toLowerCase() !== right.manifestHash.toLowerCase() || left.distributionId.toLowerCase() !== right.distributionId.toLowerCase()) throw new Error('The verified initial allocation changed. Refresh before continuing.')
}

/** Initial allocations follow historical ownership. Sticky eligibility is a separate, later reward policy. */
export function InitialIncomeClaim({ chainId, fundProjectId, incomeProjectId }: { chainId: JBChainId; fundProjectId: bigint; incomeProjectId: bigint }) {
  const { address } = useWallet()
  const client = usePublicClient({ chainId }) as PublicClient | undefined
  const cache = useQueryClient(), tx = useSafeTx(chainId)
  const [lastState, setLastState] = useState<InitialIncomeAllocationState | null>(null)
  const [imported, setImported] = useState<{ binding: string; manifest: FundGlobalManifest } | null>(null)
  const [pending, setPending] = useState<PendingClaim | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null), [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [executionHash, setExecutionHash] = useState(''), [confirmed, setConfirmed] = useState<{ hash: Hex; holder: Address; vault: Address; chainId: number } | null>(null)
  const [preparing, setPreparing] = useState(false), [checking, setChecking] = useState(false)
  const submitting = useRef(false)
  const key = address ? sessionKey(chainId, fundProjectId, incomeProjectId, address) : null
  const query = useQuery({
    queryKey: ['initial-income-allocation', chainId, fundProjectId.toString(), incomeProjectId.toString()],
    enabled: !!client, queryFn: () => readInitialIncomeAllocation(client!, { chainId, fundProjectId, incomeProjectId }),
    staleTime: 10_000, refetchInterval: 20_000, retry: 1, placeholderData: keepPreviousData,
  })
  useEffect(() => { if (query.data) setLastState(query.data) }, [query.data])
  const retained = query.data ?? lastState
  const state = retained?.chainId === chainId && retained.fundProjectId === fundProjectId && retained.incomeProjectId === incomeProjectId ? retained : null
  const binding = state ? manifestBindingKey(state) : null
  const manifestQuery = useQuery({
    queryKey: ['initial-income-manifest', binding], enabled: !!state && imported?.binding !== binding,
    queryFn: async ({ signal }) => verifiedManifest(await downloadManifest(state!.manifestUri, signal), state!), staleTime: Infinity, retry: 1,
  })
  const manifest = binding && imported?.binding === binding ? imported.manifest : manifestQuery.data
  const localAllocation = manifest?.allocations.find(allocation => allocation.chainId === chainId && BigInt(allocation.fundProjectId) === fundProjectId)
  const claim: Claim | undefined = address ? localAllocation?.holders.find(holder => isAddressEqual(holder.beneficiary, address)) : undefined
  const claimed = useQuery({
    queryKey: ['initial-income-claimed', chainId, state?.vault, claim?.index], enabled: !!client && !!state && !!claim,
    queryFn: () => client!.readContract({ address: state!.vault, abi: homerunInitialIncomeVaultAbi, functionName: 'isClaimed', args: [BigInt(claim!.index)] }),
    staleTime: 5_000, refetchInterval: 12_000, retry: 1,
  })
  useEffect(() => {
    if (!key || pending) return
    try { setPending(readPending(key)); setLoadedKey(key); setRecoveryError(null) }
    catch (failure) { setLoadedKey(null); setRecoveryError(message(failure)) }
    const listener = (event: StorageEvent) => {
      if (event.key !== key) return
      try { setPending(readPending(key)); setLoadedKey(key) } catch (failure) { setLoadedKey(null); setRecoveryError(message(failure)) }
    }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  }, [key, pending])

  const verifyExecution = useCallback(async (record: PendingClaim, hash: Hex) => {
    if (!client) throw new Error('The chain connection is unavailable.')
    const current = await readInitialIncomeAllocation(client, { chainId: record.chainId, fundProjectId: BigInt(record.fundProjectId), incomeProjectId: BigInt(record.incomeProjectId) })
    if (!current || !isAddressEqual(current.vault, record.target)) throw new Error('The pending claim does not target the verified initial allocation vault.')
    // Reuse the existing exact EOA/Safe call verifier; a proposal alone is never execution.
    const result = await verifyStickyExecution(client, { ...record, projectId: record.incomeProjectId, value: '0', label: 'Initial INCOME claim' }, hash)
    if (result === 'confirmed') {
      const receipt = await client.getTransactionReceipt({ hash })
      const call = decodeFunctionData({ abi: homerunInitialIncomeVaultAbi, data: record.data })
      if (call.functionName !== 'claim') throw new Error('The saved request is not an initial INCOME claim.')
      const [index, beneficiary, fundBalance, incomeAmount] = call.args
      const matching = receipt.logs.filter(log => {
        if (!isAddressEqual(log.address, current.vault)) return false
        try {
          const { args } = decodeEventLog({ abi: homerunInitialIncomeVaultAbi, eventName: 'Claimed', data: log.data, topics: log.topics })
          return args.index === index && isAddressEqual(args.beneficiary, beneficiary) && args.fundBalance === fundBalance && args.incomeAmount === incomeAmount && isAddressEqual(args.caller, record.holder)
        } catch { return false }
      })
      if (matching.length !== 1 || !await client.readContract({ address: current.vault, abi: homerunInitialIncomeVaultAbi, functionName: 'isClaimed', args: [index], blockNumber: receipt.blockNumber })) throw new Error('The receipt does not prove this exact allocation was claimed.')
      setConfirmed({ hash, holder: record.holder, vault: current.vault, chainId: record.chainId })
    } else setError('The claim reverted onchain. Refresh the allocation to check whether it was claimed by another transaction before trying again.')
    clearPending(record); setPending(null); setRecoveryError(null)
    await cache.invalidateQueries({ queryKey: ['initial-income-allocation'] })
    await cache.invalidateQueries({ queryKey: ['initial-income-claimed'] })
    await cache.invalidateQueries({ queryKey: ['income-project'] })
  }, [client, cache])
  useEffect(() => {
    if (!pending?.hash || !client) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const hash = pending!.safe ? await waitForSafeExecutionHash(pending!.chainId, pending!.hash!, { signal: abort.signal }) : pending!.hash!
        if (abort.signal.aborted) return
        await verifyExecution(pending!, hash)
      } catch (failure) {
        if (abort.signal.aborted) return
        setRecoveryError(`Confirmation is unavailable. ${message(failure)}`)
        timer = setTimeout(() => void poll(), 12_000)
      }
    }
    void poll()
    return () => { abort.abort(); if (timer) clearTimeout(timer) }
  }, [pending, client, verifyExecution])

  async function importManifest(file?: File) {
    if (!file || !state) return
    setError(null)
    try {
      if (file.size > LOCAL_BYTES) throw new Error('This file exceeds this browser’s 128 MB import limit. The allocation has no holder limit; use the published proof with the vault directly.')
      const parsed = verifiedManifest(JSON.parse(await file.text()), state)
      setImported({ binding: manifestBindingKey(state), manifest: parsed })
    } catch (failure) { setError(message(failure)) }
  }
  const confirmedForAccount = !!confirmed && !!address && !!state && isAddressEqual(confirmed.holder, address) && isAddressEqual(confirmed.vault, state.vault) && confirmed.chainId === chainId
  const blocked = confirmedForAccount || !client || !address || !state || !query.data || query.isError || query.isPlaceholderData || loadedKey !== key || !!pending || preparing || tx.busy || tx.phase === 'review' || !claim?.claimable || claimed.data !== false || claimed.isError
  async function submit() {
    if (blocked || !client || !address || !state || !manifest || !claim || !key || submitting.current) return
    submitting.current = true; setPreparing(true); setError(null); setConfirmed(null)
    try {
      if (!navigator.locks) throw new Error('This browser cannot safely coordinate claims between tabs. Use a current browser over HTTPS.')
      await navigator.locks.request(key, { ifAvailable: true }, async lock => {
        if (!lock || readPending(key)) throw new Error('An initial claim may already be pending. Check its execution before trying again.')
        const fresh = async () => {
          const current = await readInitialIncomeAllocation(client, { chainId, fundProjectId, incomeProjectId })
          if (!current) throw new Error('The initial allocation is unavailable.')
          sameVault(state, current); verifiedManifest(manifest, current)
          if (await client.readContract({ address: current.vault, abi: homerunInitialIncomeVaultAbi, functionName: 'isClaimed', args: [BigInt(claim.index)], blockNumber: current.blockNumber })) throw new Error('This allocation has already been claimed.')
          if (current.vaultBalance < BigInt(claim.incomeAmount)) throw new Error('The vault cannot cover this allocation.')
          return current
        }
        const current = await fresh()
        const request = { chainId, address: current.vault, abi: homerunInitialIncomeVaultAbi, functionName: 'claim' as const, args: [BigInt(claim.index), claim.beneficiary, BigInt(claim.fundBalance), BigInt(claim.incomeAmount), claim.proof] as const, label: `Claim ${formatUnits(BigInt(claim.incomeAmount), 18)} initial INCOME to ${claim.beneficiary}` }
        let attempt: PendingClaim | null = null
        const hash = await tx.send(request, {
          reviewNotice: `This transfers your fixed initial allocation immediately to ${claim.beneficiary}. It does not require FUND approval, staking, delegation, burning, or vesting.`,
          reverify: fresh,
          beforeWrite: async () => {
            const afterBlock = await client.getBlockNumber()
            if (readPending(key)) throw new Error('Another tab already recorded an initial claim submission.')
            attempt = { version: 1, chainId, fundProjectId: fundProjectId.toString(), incomeProjectId: incomeProjectId.toString(), holder: address, target: current.vault, data: encodeFunctionData(request), safe: tx.isSafe, submittedAt: Date.now(), afterBlock: afterBlock.toString() }
            savePending(attempt); setPending(attempt)
          },
          onWriteRejected: () => { if (attempt) clearPending(attempt); setPending(null); attempt = null },
        })
        if (hash && attempt) {
          const saved = { ...(attempt as PendingClaim), hash }
          setPending(saved); savePending(saved)
        }
      })
    } catch (failure) { setError(message(failure)) } finally { submitting.current = false; setPreparing(false) }
  }
  async function recover() {
    if (!pending || !hashPattern.test(executionHash) || checking) return
    setChecking(true); setRecoveryError(null)
    try { await verifyExecution(pending, executionHash as Hex) } catch (failure) { setRecoveryError(message(failure)) } finally { setChecking(false) }
  }
  const link = confirmed ? explorerTxUrl(confirmed.chainId, confirmed.hash) : pending?.hash && !pending.safe ? explorerTxUrl(pending.chainId, pending.hash) : null
  let publishedLink: string | null = null
  if (state) { try { publishedLink = manifestUrl(state.manifestUri) } catch { /* A local committed manifest can still be verified. */ } }
  return <section className="mt-8 rounded border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7" aria-label="Initial INCOME allocation">
    <h3 className="text-2xl">Your initial INCOME</h3>
    <p className="mt-3 text-sm">The initial 500,000 INCOME is divided across all FUND holders and linked chains at the snapshot, including inactive balances, unclaimed credits, and pending bridge transfers. No staking or reward activation is required. Claims have no deadline or vesting period.</p>
    {query.isPending && <p role="status" className="mt-4">Verifying the initial allocation vault…</p>}
    {query.isError && <p role="alert" className="mt-4">{message(query.error)} Claims are unavailable until the vault is verified.</p>}
    {query.data === null && !query.isError && <p className="mt-4">No verified initial allocation vault is registered for this project.</p>}
    {state && <>
      <p className="mt-4 text-sm">{formatUnits(state.localInitialIncomeSupply, 18)} initial INCOME allocated on {displayChainName(chainId)}.</p>
      <p className="mt-4 text-sm">Snapshot block {state.snapshotBlockNumber.toString()}. {publishedLink && <a href={publishedLink} target="_blank" rel="noreferrer" className="underline">View the published allocation</a>}</p>
      <p className="mt-3 text-sm">The operator committed this public snapshot. Its immutable proof verifies your allocation; historical holder completeness requires independent verification of the published snapshot.</p>
      {manifestQuery.isPending && !manifest && <p role="status" className="mt-4">Loading and checking the published snapshot…</p>}
      {manifestQuery.isError && !manifest && <p role="alert" className="mt-4 text-sm">{message(manifestQuery.error)}</p>}
      <details className="mt-4 text-sm"><summary className="cursor-pointer">Import a published snapshot file</summary><p className="mt-3">Use this if the gateway is unavailable or the download is large. The file must match the vault’s committed hash and complete allocation.</p><label className="mt-3 grid gap-2">Snapshot JSON<input type="file" accept="application/json,.json" onChange={event => void importManifest(event.target.files?.[0])} /></label></details>
      {!address ? <p className="mt-5">Connect your wallet to find your allocation.</p> : manifest && !claim ? <p className="mt-5">This wallet has no allocation on this chain in the published snapshot. Initial claims stay on their recorded chain; later FUND transfers do not move them.</p> : claim ? <>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2"><div><dt className="text-sm">Your initial allocation</dt><dd className="mt-2 break-all text-2xl">{formatUnits(BigInt(claim.incomeAmount), 18)} INCOME</dd></div><div><dt className="text-sm">Your FUND at the snapshot</dt><dd className="mt-2 break-all text-xl">{displayedFundPosition(claim)}</dd></div></dl>
        {claim.fundWeight && <p className="mt-3 text-sm">Your allocation includes your exact share of FUND held in Sticky. The reward calculation preserves fractions smaller than one FUND token unit.</p>}
        <p className="mt-3 text-sm">{claimed.data === true || confirmedForAccount ? 'This allocation has already been claimed.' : !claim.claimable ? 'This balance rounds to zero INCOME and cannot be claimed.' : claimed.data === false ? 'Your allocation is unclaimed and available immediately.' : 'Checking whether this allocation has been claimed…'}</p>
        {claimed.isError && <p role="alert" className="mt-3 text-sm">{message(claimed.error)}</p>}
        <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={blocked} onClick={() => void submit()}>{preparing ? 'Preparing…' : txPhaseLabel(tx.phase, { idle: 'Review initial INCOME claim', pending: 'Confirming claim…' })}</button>
      </> : null}
      <button type="button" className="mt-4 block text-sm underline" onClick={() => { void query.refetch(); void manifestQuery.refetch(); if (claim) void claimed.refetch() }}>Refresh allocation</button>
    </>}
    <div className="mt-4 break-words text-sm" role="status" aria-live="polite">
      {confirmed ? <p>Initial INCOME claim confirmed onchain.</p> : pending ? <p>{pending.safe && pending.hash ? 'Proposed to Safe. The allocation is not claimed until the proposal executes and its receipt is verified.' : pending.hash ? 'Submitted. Waiting for the exact claim to be confirmed onchain.' : 'The wallet may have submitted this claim. Check your wallet history before taking another action.'}</p> : null}
      {link && <a href={link} target="_blank" rel="noreferrer" className="underline">View transaction</a>}
    </div>
    {pending && <div className="mt-4 text-sm"><p>Recovery for {pending.holder}</p><label className="mt-3 grid gap-2">Executed transaction hash<input value={executionHash} onChange={event => setExecutionHash(event.target.value.trim())} className="min-h-11 w-full rounded border border-[#bfc9b5] bg-white px-3" placeholder="0x…" autoComplete="off" /></label><button type="button" className="btn-secondary mt-3 min-h-11 px-4" disabled={checking || !hashPattern.test(executionHash)} onClick={() => void recover()}>{checking ? 'Verifying execution…' : 'Verify execution'}</button></div>}
    {(error || tx.error) && <p role="alert" className="mt-3 text-sm text-red-800">{error ?? tx.error}</p>}
    {recoveryError && <p role="alert" className="mt-3 text-sm text-red-800">{recoveryError}</p>}
  </section>
}
