'use client'

import { getAccount, getPublicClient } from '@wagmi/core'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bytesToHex, decodeEventLog, decodeFunctionData, encodeFunctionData, formatUnits, isAddressEqual, zeroAddress, type Hex, type PublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { IncomeProject } from '@/components/IncomeProject'
import { StickyCreate } from '@/components/StickyCreate'
import { useSafeTx, txPhaseLabel } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import { FUND_CHAIN_IDS, parsePercent } from '@/lib/fund-contracts'
import { readFundProjectState, type FundProjectState } from '@/lib/fund-state'
import { fundIpfsUrl } from '@/lib/fund-project-metadata'
import { readFundGlobalSnapshot, type FundGlobalSnapshotInput } from '@/lib/fund-global-snapshot'
import { buildFundGlobalManifest, canonicalSnapshotJson, fundGlobalManifestHash, getFundGlobalClaim, globalIncomeSnapshotParameters, parseFundGlobalManifest, serializeFundGlobalManifest, verifyFundGlobalManifestHistory, type FundGlobalManifest } from '@/lib/fund-global-manifest'
import { homerunIncomeDeployerAbi, registeredIncomeDeployer } from '@/lib/income-contracts'
import { readInitialIncomeAllocation } from '@/lib/income-allocation-state'
import { incomeLaunchBlockers, prepareIncomeLaunch, readIncomeLaunchBinding, type PreparedIncomeLaunch } from '@/lib/income-launch'
import { beginIncomeLaunchSubmission, clearIncomeLaunchPending, importIncomeLaunchPending, incomeLaunchSessionKey, readIncomeLaunchPending, recordIncomeLaunchHash, verifyIncomeLaunchExecution, withIncomeLaunchLock, type IncomeLaunchPending } from '@/lib/income-launch-session'
import { parseIncomeGlobalDraft, readIncomeGlobalDraft, saveIncomeGlobalDraft, serializeIncomeGlobalDraft, verifyIncomeGlobalDraftManifest, withIncomeGlobalDraftLock, type IncomeGlobalChainDraft, type IncomeGlobalLaunchDraft } from '@/lib/income-global-launch-draft'
import { jbCenterIpfs } from '@/lib/jbcenter-ipfs'
import { isSafeConnection, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { wagmiConfig } from '@/providers/Providers'

const JOURNAL_EVENT = 'homerun-income-launch-recovery'
const inputClass = 'min-h-12 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base'
const HASH = /^0x[\da-fA-F]{64}$/
type LaunchInput = Parameters<typeof prepareIncomeLaunch>[1]
type Review = { plan: PreparedIncomeLaunch; input: LaunchInput }
type SnapshotProgress = Parameters<NonNullable<FundGlobalSnapshotInput['onProgress']>>[0]
export type PlannedIncomeAllocation = { operatorPercent: number | null; fundStakerPercent: number | null }
type IncomeLaunchProps = { state: FundProjectState; client: PublicClient; name?: string; launchUnavailable?: boolean; plannedAllocation?: PlannedIncomeAllocation }
function message(reason: unknown) { return reason instanceof Error ? reason.message : 'INCOME could not be prepared. Try again.' }
function changed() { window.dispatchEvent(new Event(JOURNAL_EVENT)) }
function download(text: string, filename: string) { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0) }
function sameRequest(left: PreparedIncomeLaunch['request'], right: PreparedIncomeLaunch['request']) { return left.chainId === right.chainId && isAddressEqual(left.address, right.address) && (left.value ?? 0n) === (right.value ?? 0n) && encodeFunctionData({ abi: left.abi, functionName: left.functionName, args: left.args }) === encodeFunctionData({ abi: right.abi, functionName: right.functionName, args: right.args }) }
function planTerms(draft: IncomeGlobalLaunchDraft) { return JSON.stringify({ ...draft, chains: draft.chains.map(({ chainId, fundProjectId, initialIncomeAmount }) => ({ chainId, fundProjectId, initialIncomeAmount })) }) }
function sameFrozenPlan(draft: IncomeGlobalLaunchDraft) { const stored = readIncomeGlobalDraft(localStorage, draft.root.chainId, BigInt(draft.root.projectId)); if (!stored || planTerms(stored) !== planTerms(draft)) throw new Error('The saved launch plan changed. Restore its original shared terms before signing.'); return stored }
async function fetchManifest(uri: string, signal: AbortSignal): Promise<unknown> { const url = fundIpfsUrl(uri); if (!url) throw new Error('Use the published IPFS manifest.'); const response = await fetch(url, { signal, redirect: 'error' }); if (!response.ok) throw new Error('The published snapshot could not be loaded. Restore its downloaded file instead.'); return response.json() }

/** One shared immutable plan, followed by independently confirmed chain transactions. */
export function IncomeLaunch(props: IncomeLaunchProps) { return <GlobalIncomeLaunch key={`${props.state.chainId}:${props.state.projectId}`} {...props} /> }
function GlobalIncomeLaunch({ state, client, name = 'Homerun INCOME', launchUnavailable = false, plannedAllocation }: IncomeLaunchProps) {
  const { address } = useWallet()
  const clients = useMemo(() => { const available = new Map<number, PublicClient>(); for (const chainId of FUND_CHAIN_IDS) { const configured = getPublicClient(wagmiConfig, { chainId }); if (configured) available.set(chainId, configured as PublicClient) } available.set(state.chainId, client); return available }, [client, state.chainId])
  const [draft, setDraft] = useState<IncomeGlobalLaunchDraft | null>(null), [ready, setReady] = useState(false), [storageError, setStorageError] = useState<string | null>(null)
  const [manifest, setManifest] = useState<FundGlobalManifest | null>(null), [manifestUri, setManifestUri] = useState('')
  const [operator, setOperator] = useState('70'), [stakers, setStakers] = useState('10'), [working, setWorking] = useState<string | null>(null), [progress, setProgress] = useState<SnapshotProgress | null>(null), [error, setError] = useState<string | null>(null)
  const [verified, setVerified] = useState<Record<number, string>>({}), [existingIncomeId, setExistingIncomeId] = useState<bigint | null>(null)
  const action = useRef(false), abort = useRef<AbortController | null>(null), allocationTouched = useRef(false)
  const binding = useQuery({ queryKey: ['income-binding', state.chainId, state.projectId.toString()], queryFn: () => readIncomeLaunchBinding(client, state.chainId, state.projectId), staleTime: 10_000, refetchInterval: 15_000, retry: false })
  useEffect(() => { if (binding.data) setExistingIncomeId(binding.data) }, [binding.data])
  useEffect(() => { function read() { try { setDraft(readIncomeGlobalDraft(localStorage, state.chainId, state.projectId)); setStorageError(null) } catch (reason) { setStorageError(message(reason)) } finally { setReady(true) } } read(); window.addEventListener('storage', read); window.addEventListener(JOURNAL_EVENT, read); return () => { window.removeEventListener('storage', read); window.removeEventListener(JOURNAL_EVENT, read) } }, [state.chainId, state.projectId])
  const plannedOperator = plannedAllocation?.operatorPercent, plannedStakers = plannedAllocation?.fundStakerPercent
  useEffect(() => {
    // Metadata proposes editable terms. A saved plan and the operator's own
    // edits always take precedence, including while a freeze is being prepared.
    if (!ready || draft || storageError || allocationTouched.current || (plannedOperator === undefined && plannedStakers === undefined)) return
    const proposedOperator = plannedOperator ?? 70, proposedStakers = plannedStakers ?? 10
    if (!Number.isFinite(proposedOperator) || !Number.isFinite(proposedStakers)) return
    try {
      if (parsePercent(String(proposedOperator)) + parsePercent(String(proposedStakers)) > 10_000) return
      setOperator(String(proposedOperator)); setStakers(String(proposedStakers))
    } catch { /* Ignore malformed metadata; the explicit form defaults remain editable. */ }
  }, [ready, draft, storageError, plannedOperator, plannedStakers])
  const manifestMatches = !!draft && !!manifest && fundGlobalManifestHash(manifest) === draft.manifestHash
  useEffect(() => {
    if (!draft || manifestMatches) return
    const controller = new AbortController()
    void fetchManifest(draft.manifestUri, controller.signal).then(value => { const parsed = verifyIncomeGlobalDraftManifest(draft, value); if (!controller.signal.aborted) { setManifest(parsed); setManifestUri(draft.manifestUri); setError(null) } }).catch(reason => { if (!controller.signal.aborted) setError(message(reason)) })
    return () => controller.abort()
  }, [draft, manifestMatches])
  useEffect(() => () => abort.current?.abort(), [])
  const owner = !!address && isAddressEqual(address, state.owner)
  const unavailable = launchUnavailable || !!existingIncomeId || !owner || !ready || !!storageError || !!draft || !!binding.data || binding.isError || binding.isPending || !registeredIncomeDeployer(state.chainId)
  async function run(label: string, task: () => Promise<void>) { if (action.current) return; action.current = true; setWorking(label); setError(null); try { await task() } catch (reason) { setError(message(reason)) } finally { action.current = false; setWorking(null) } }
  function requireOwner() { if (unavailable || !address) throw new Error('Connect the FUND owner and restore any saved global launch before preparing another.'); const account = getAccount(wagmiConfig).address; if (!account || !isAddressEqual(account, address)) throw new Error('The connected wallet changed. Refresh before continuing.'); return account }
  async function makeSnapshot() { await run('Reading all linked FUND balances and bridge claims…', async () => {
    requireOwner(); const helper = registeredIncomeDeployer(state.chainId); if (!helper) throw new Error('A verified INCOME launcher is required on every linked network.')
    abort.current?.abort(); abort.current = new AbortController()
    const snapshot = await readFundGlobalSnapshot({ root: { chainId: state.chainId, projectId: state.projectId }, clients, signal: abort.current.signal, onProgress: setProgress })
    const next = buildFundGlobalManifest(snapshot, { helper, launchSalt: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) })
    for (const allocation of next.allocations) { const remote = registeredIncomeDeployer(allocation.chainId); if (!remote || !isAddressEqual(remote, helper)) throw new Error('Every linked chain must use the same verified INCOME launcher deployment.') }
    setManifest(next); setManifestUri('')
  }) }
  async function importSnapshot(file?: File) { if (!file) return; await run('Checking the saved ownership snapshot…', async () => {
    const parsed = parseFundGlobalManifest(JSON.parse(await file.text()))
    if (draft) { setManifest(verifyIncomeGlobalDraftManifest(draft, parsed)); setManifestUri(draft.manifestUri); return }
    requireOwner(); if (!parsed.allocations.some(local => local.chainId === state.chainId && BigInt(local.fundProjectId) === state.projectId)) throw new Error('This ownership snapshot belongs to another FUND.')
    const helper = registeredIncomeDeployer(state.chainId); if (!helper || !isAddressEqual(helper, parsed.helper)) throw new Error('The snapshot uses another deployment contract.')
    abort.current?.abort(); abort.current = new AbortController()
    const checked = await verifyFundGlobalManifestHistory(clients, parsed, { signal: abort.current.signal, onProgress: setProgress }); setManifest(checked); setManifestUri('')
  }) }
  async function publish() { await run('Publishing the complete global snapshot…', async () => { requireOwner(); if (!manifest) throw new Error('Create the ownership snapshot first.'); const pin = await jbCenterIpfs.pinMedia(new File([serializeFundGlobalManifest(manifest)], 'fund-global-initial-income.json', { type: 'application/json' })); setManifestUri(`ipfs://${pin.cid}`) }) }
  async function freeze() { await run('Verifying and saving the shared launch terms…', async () => {
    requireOwner(); if (!manifest || !manifestUri) throw new Error('Publish the complete snapshot first.')
    allocationTouched.current = true
    const operatorBps = parsePercent(operator), fundHolderBps = parsePercent(stakers); if (!fundHolderBps || operatorBps + fundHolderBps > 10_000) throw new Error('Include a positive staker share and allocate no more than 100%.')
    const checked = await verifyFundGlobalManifestHistory(clients, manifest)
    const blocks = await Promise.all(checked.allocations.map(async local => { const rpc = clients.get(local.chainId); if (!rpc) throw new Error(`A client for ${displayChainName(local.chainId)} is required.`); const block = await rpc.getBlock({ blockTag: 'latest' }); if (block.number === null || !block.hash || block.timestamp <= 0n) throw new Error('Every linked chain must provide a mined block.'); return Number(block.timestamp) }))
    const startsAtOrAfter = Math.min(...blocks)
    const metadata = await jbCenterIpfs.pinJson({ name: name.trim(), description: 'Initial INCOME belongs to all FUND snapshot holders across the linked chains, including unclaimed credits and pending bridge transfers. Ongoing staker rewards use Sticky.', tokens: { name: name.trim(), symbol: 'INCOME' }, homerun: { version: 1, type: 'income', manifestUri, manifestHash: fundGlobalManifestHash(checked), holderRewards: { mode: 'sticky' }, startsAtOrAfter, operatorBps, fundHolderBps } })
    const next: IncomeGlobalLaunchDraft = { version: 1, root: { chainId: state.chainId, projectId: state.projectId.toString() }, helper: checked.helper, manifestUri, manifestHash: fundGlobalManifestHash(checked), sourceSetHash: checked.sourceSetHash, launchSalt: checked.launchSalt, name: name.trim(), metadataUri: `ipfs://${metadata.cid}`, startsAtOrAfter, operatorBps, fundHolderBps, chains: checked.allocations.map(local => ({ chainId: local.chainId, fundProjectId: local.fundProjectId, initialIncomeAmount: local.incomeAmount })) }
    await withIncomeGlobalDraftLock(() => saveIncomeGlobalDraft(localStorage, next)); changed()
  }) }
  async function restoreDraft(file?: File) { if (!file) return; await run('Restoring the frozen launch plan…', async () => { if (file.size > 1_000_000) throw new Error('The launch plan file is too large. Use the small launch-plan file rather than the ownership snapshot.'); const parsed = parseIncomeGlobalDraft(JSON.parse(await file.text())); if (!parsed.chains.some(local => local.chainId === state.chainId && BigInt(local.fundProjectId) === state.projectId)) throw new Error('This plan belongs to another FUND.'); await withIncomeGlobalDraftLock(() => saveIncomeGlobalDraft(localStorage, parsed)); changed() }) }
  const onVerified = useCallback((chainId: number, hash: string) => setVerified(current => current[chainId] === hash ? current : { ...current, [chainId]: hash }), [])
  const completed = draft?.chains.filter(local => !!local.execution && verified[local.chainId] === local.execution.hash).length ?? 0
  return <section className="mt-7 rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
    <h2 className="mb-4 text-3xl">Launch INCOME after the purchase</h2>
    <p className="mb-3 text-sm">The initial 500,000 INCOME is shared across every FUND holder and linked network, including inactive balances, unclaimed credits, and pending bridge transfers. Each holder’s allocation stays on its source or intended destination chain.</p>
    <p className="mb-4 text-sm">Initial claims need no staking or vesting. Ongoing Sticky rewards use weekly snapshots and four vesting rounds, without a minimum staking age or age multiplier.</p>
    {!draft && !registeredIncomeDeployer(state.chainId) && <p className="mb-4 text-sm">The INCOME launcher must be verified and registered on every linked network before launch.</p>}
    {!draft && !owner && <p className="mb-4 text-sm">Connect the FUND owner to prepare the global launch.</p>}
    {binding.isError && <p role="alert" className="text-sm">The existing INCOME connection could not be verified. Refresh before starting a launch.</p>}
    {draft ? <div className="grid gap-4">
      <h3 className="text-xl">Shared launch plan</h3><p>{completed} of {draft.chains.length} networks confirmed.</p>
      <p className="text-sm">{completed === draft.chains.length ? 'Every network’s deployment and local initial allocation is confirmed.' : 'Each network deploys separately. Payments can begin locally before the other networks are ready; the overall launch remains incomplete until every deployment is confirmed.'}</p>
      <p className="text-sm">Shared issuance starts {new Date(draft.startsAtOrAfter * 1000).toISOString()}. New INCOME: {draft.operatorBps / 100}% operators, {draft.fundHolderBps / 100}% stakers, {(10_000 - draft.operatorBps - draft.fundHolderBps) / 100}% customers. These terms, the published snapshot, and metadata are frozen for every network.</p>
      <button type="button" className="btn-secondary min-h-11 justify-self-start px-4" onClick={() => download(serializeIncomeGlobalDraft(draft), 'homerun-global-income-launch.json')}>Download launch plan</button>
      {!manifestMatches && <p className="text-sm">Loading the published ownership snapshot. You can restore its downloaded file below if IPFS is unavailable.</p>}
      {manifestMatches && manifest && draft.chains.map(local => <IncomeChainLaunch key={`${local.chainId}:${local.fundProjectId}`} local={local} draft={draft} manifest={manifest} clients={clients} rootState={state} onVerified={onVerified} launchUnavailable={launchUnavailable} rootIncomeId={existingIncomeId} />)}
    </div> : <fieldset disabled={!!working || unavailable} className="grid min-w-0 gap-4">
      <h3 className="text-xl">1. Include every FUND holder</h3>
      <p className="text-sm">Snapshot all linked networks before setting up Sticky. The scan checks finalized balances and unsettled bridge entitlements together.</p>
      <button type="button" className="btn-secondary min-h-11 justify-self-start px-4" disabled={!!manifestUri} onClick={() => void makeSnapshot()}>Create global ownership snapshot</button>
      {manifest && <div className="grid gap-3 rounded border border-[#c4cdbb] p-4"><p>500,000 INCOME across {manifest.allocations.length} networks.</p><ul className="space-y-1 text-sm">{manifest.allocations.map(local => <li key={local.chainId}>{displayChainName(local.chainId)}: {formatUnits(BigInt(local.incomeAmount), 18)} INCOME for {local.leafCount} holders</li>)}</ul><p className="text-sm">Every linked network remains in the launch plan, including networks whose initial allocation is zero.</p><div className="flex flex-wrap gap-3"><button type="button" className="btn-secondary min-h-11 px-4" onClick={() => download(serializeFundGlobalManifest(manifest), 'fund-global-initial-income.json')}>Download snapshot</button><button type="button" className="btn-secondary min-h-11 px-4" disabled={!!manifestUri} onClick={() => void publish()}>{manifestUri ? 'Snapshot published' : 'Publish snapshot'}</button></div></div>}
      {manifestUri && <><h3 className="text-xl">2. Freeze the shared terms</h3><p className="text-sm">Save one plan before any network creates Sticky or INCOME. Initial issuance is 10 INCOME per dollar, decreasing 5% each quarter for eight quarters, then staying fixed.</p><div className="grid gap-4 sm:grid-cols-2"><label className="grid gap-2 text-sm">Operator share of new INCOME (%)<input className={inputClass} value={operator} inputMode="decimal" onChange={event => { allocationTouched.current = true; setOperator(event.target.value) }} /></label><label className="grid gap-2 text-sm">Staker share of new INCOME (%)<input className={inputClass} value={stakers} inputMode="decimal" onChange={event => { allocationTouched.current = true; setStakers(event.target.value) }} /></label></div><button type="button" className="btn-secondary min-h-11 justify-self-start px-4" onClick={() => void freeze()}>Save shared launch plan</button></>}
    </fieldset>}
    {existingIncomeId && <><p className="my-4 text-sm">INCOME already exists on this network.{!draft && ' Restore the shared launch plan to finish or verify its other networks.'}</p><IncomeProject chainId={state.chainId} projectId={existingIncomeId} fundProjectId={state.projectId} /></>}
    {manifestMatches && manifest && <button type="button" className="btn-secondary mt-4 min-h-11 px-4" onClick={() => download(serializeFundGlobalManifest(manifest), 'fund-global-initial-income.json')}>Download ownership snapshot</button>}
    <details className="mt-5 text-sm"><summary className="cursor-pointer">Restore saved launch files</summary><div className="mt-3 grid gap-4"><label className="grid gap-2">Ownership snapshot<input type="file" accept="application/json,.json" disabled={!!working} onChange={event => { void importSnapshot(event.target.files?.[0]); event.target.value = '' }} /></label><label className="grid gap-2">Shared launch plan<input type="file" accept="application/json,.json" disabled={!!working} onChange={event => { void restoreDraft(event.target.files?.[0]); event.target.value = '' }} /></label></div></details>
    {working && <p role="status" className="mt-3 text-sm">{working}{progress && ` ${progress.stage}: ${progress.completed} / ${progress.total}.`}</p>}
    {(error || storageError) && <p role="alert" className="mt-3 text-sm text-red-800">{error ?? storageError}</p>}
  </section>
}

function IncomeChainLaunch({ local, draft, manifest, clients, rootState, onVerified, launchUnavailable, rootIncomeId }: { local: IncomeGlobalChainDraft; draft: IncomeGlobalLaunchDraft; manifest: FundGlobalManifest; clients: ReadonlyMap<number, PublicClient>; rootState: FundProjectState; onVerified: (chainId: number, hash: string) => void; launchUnavailable: boolean; rootIncomeId: bigint | null }) {
  const client = clients.get(local.chainId)
  if (!client) return <p role="alert">{displayChainName(local.chainId)} is required, but its RPC client is unavailable.</p>
  return <IncomeChainActions local={local} draft={draft} manifest={manifest} clients={clients} client={client} rootState={rootState} onVerified={onVerified} launchUnavailable={launchUnavailable} rootIncomeId={rootIncomeId} />
}

function IncomeChainActions({ local, draft, manifest, clients, client, rootState, onVerified, launchUnavailable, rootIncomeId }: { local: IncomeGlobalChainDraft; draft: IncomeGlobalLaunchDraft; manifest: FundGlobalManifest; clients: ReadonlyMap<number, PublicClient>; client: PublicClient; rootState: FundProjectState; onVerified: (chainId: number, hash: string) => void; launchUnavailable: boolean; rootIncomeId: bigint | null }) {
  const chainId = local.chainId as JBChainId, projectId = BigInt(local.fundProjectId), { address } = useWallet(), tx = useSafeTx(chainId), cache = useQueryClient()
  const key = incomeLaunchSessionKey(chainId, projectId)
  const [pending, setPending] = useState<IncomeLaunchPending | null>(null), [journalReady, setJournalReady] = useState(false), [journalError, setJournalError] = useState<string | null>(null)
  const [review, setReview] = useState<Review | null>(null), [attested, setAttested] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [executionHash, setExecutionHash] = useState(''), [verifiedId, setVerifiedId] = useState<bigint | null>(null)
  const action = useRef(false), unavailableRef = useRef(launchUnavailable)
  useEffect(() => { unavailableRef.current = launchUnavailable }, [launchUnavailable])
  const fund = useQuery({ queryKey: ['income-launch-fund', chainId, local.fundProjectId], queryFn: () => readFundProjectState(client, { chainId, projectId, account: address }), initialData: rootState.chainId === chainId && rootState.projectId === projectId ? rootState : undefined, placeholderData: keepPreviousData, staleTime: 5_000, refetchInterval: 15_000, retry: false })
  const binding = useQuery({ queryKey: ['income-binding', chainId, local.fundProjectId], queryFn: () => readIncomeLaunchBinding(client, chainId, projectId), staleTime: 10_000, refetchInterval: 15_000, retry: false })
  useEffect(() => { function read() { try { setPending(readIncomeLaunchPending(localStorage, key)); setJournalError(null) } catch (reason) { setJournalError(message(reason)) } finally { setJournalReady(true) } } read(); window.addEventListener('storage', read); window.addEventListener(JOURNAL_EVENT, read); return () => { window.removeEventListener('storage', read); window.removeEventListener(JOURNAL_EVENT, read) } }, [key])
  const confirm = useCallback(async (record: IncomeLaunchPending, hash: Hex) => {
    const decoded = decodeFunctionData({ abi: homerunIncomeDeployerAbi, data: record.data })
    if (decoded.functionName !== 'deployIncome' || JSON.stringify(canonicalSnapshotJson(decoded.args[1])) !== JSON.stringify(canonicalSnapshotJson(globalIncomeSnapshotParameters(manifest, draft.manifestUri)))) throw new Error('The recovered transaction uses a different global allocation.')
    const status = await verifyIncomeLaunchExecution(client, record, hash)
    if (status === 'confirmed') {
      const receipt = await client.getTransactionReceipt({ hash })
      const events = receipt.logs.filter(log => isAddressEqual(log.address, record.target)).flatMap(log => { try { const event = decodeEventLog({ abi: homerunIncomeDeployerAbi, data: log.data, topics: log.topics }); return event.eventName === 'IncomeDeployed' ? [event] : [] } catch { return [] } })
      if (events.length !== 1 || events[0].args.fundProjectId !== projectId) throw new Error('The receipt does not identify this FUND’s INCOME allocation.')
      const id = await readIncomeLaunchBinding(client, chainId, projectId)
      if (id !== events[0].args.incomeProjectId) throw new Error('The INCOME binding has not caught up with this deployment. Check again shortly.')
      const allocation = await readInitialIncomeAllocation(client, { chainId, incomeProjectId: id, fundProjectId: projectId })
      if (!allocation || allocation.blockNumber < receipt.blockNumber || !isAddressEqual(allocation.vault, events[0].args.initialAllocationVault)) throw new Error('The funded local allocation vault could not be verified yet.')
      getFundGlobalClaim(manifest, allocation, zeroAddress)
      await withIncomeGlobalDraftLock(() => { const current = sameFrozenPlan(draft); const next = { ...current, chains: current.chains.map(row => row.chainId === chainId ? { ...row, execution: { hash, record } } : row) }; saveIncomeGlobalDraft(localStorage, next) })
      setVerifiedId(id); onVerified(chainId, hash); setNotice('This network’s deployment and initial allocation are confirmed.')
    } else { if (local.execution) throw new Error('The saved completed deployment has no successful execution.'); setReview(null); setAttested(false); setNotice('The exact execution reverted. Prepare a fresh review for this network.') }
    if (readIncomeLaunchPending(localStorage, key)) clearIncomeLaunchPending(localStorage, key, record)
    changed(); await cache.invalidateQueries({ queryKey: ['income-binding', chainId, local.fundProjectId] })
  }, [cache, chainId, client, draft, key, local.execution, local.fundProjectId, manifest, onVerified, projectId])
  useEffect(() => {
    const record = local.execution?.record ?? pending, knownHash = local.execution?.hash ?? pending?.hash
    if (!record || !knownHash || verifiedId) return
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
    async function check() { try { const hash = local.execution ? knownHash! : record!.safe ? await waitForSafeExecutionHash(chainId, knownHash!, { pollingIntervalMs: 5_000, signal: controller.signal }) : knownHash!; if (!controller.signal.aborted) await confirm(record!, hash) } catch (reason) { if (controller.signal.aborted) return; setNotice(`Not confirmed yet. ${message(reason)}`); timer = setTimeout(() => void check(), 10_000) } }
    void check(); return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [chainId, confirm, local.execution, pending, verifiedId])
  const state = fund.data, owner = !!state && !!address && isAddressEqual(address, state.owner), blockers = state ? incomeLaunchBlockers(state) : []
  const unavailable = launchUnavailable || !owner || !state || fund.isError || binding.isError || binding.isPending || !!binding.data || !journalReady || !!journalError || !!pending || !!local.execution || blockers.length > 0
  async function run(task: () => Promise<void>) { if (action.current) return; action.current = true; setWorking(true); setError(null); try { await task() } catch (reason) { setError(message(reason)) } finally { action.current = false; setWorking(false) } }
  async function stickyCreated(id: bigint) { try { await withIncomeGlobalDraftLock(() => { const current = sameFrozenPlan(draft); saveIncomeGlobalDraft(localStorage, { ...current, chains: current.chains.map(row => row.chainId === chainId ? { ...row, stickyProjectId: id.toString() } : row) }) }); changed() } catch (reason) { setError(message(reason)) } }
  async function prepare() { await run(async () => { if (unavailable || !address || !local.stickyProjectId) throw new Error('Confirm Sticky and connect this network’s FUND owner first.'); sameFrozenPlan(draft); setReview(null); setAttested(false); const input: LaunchInput = { chainId, fundProjectId: projectId, account: address, manifest, manifestUri: draft.manifestUri, stickyProjectId: BigInt(local.stickyProjectId), name: draft.name, projectUri: draft.metadataUri, salt: draft.launchSalt, operatorBps: draft.operatorBps, fundHolderBps: draft.fundHolderBps, startsAtOrAfter: draft.startsAtOrAfter, clients }; setReview({ input, plan: await prepareIncomeLaunch(client, input) }) }) }
  async function submit() { await run(async () => {
    if (unavailable || !address || !review || !attested || !isAddressEqual(address, review.input.account)) throw new Error('Review and attest to the global allocation with this FUND’s owner.'); const captured = review, account = address
    await withIncomeLaunchLock(key, async () => {
      sameFrozenPlan(draft); if (readIncomeLaunchPending(localStorage, key)) throw new Error('A deployment may already be pending on this network.')
      let record: IncomeLaunchPending | null = null
      const hash = await tx.send({ ...captured.plan.request, label: `Deploy INCOME on ${displayChainName(chainId)}` }, {
        reviewNotice: 'You attest that the published global snapshot includes every FUND holder, unclaimed credit, and unsettled bridge entitlement. The contract records the root; it does not prove historical completeness. This transaction mints only this network’s share of the global 500,000 allocation into its permanent claim vault before local activity. Other networks deploy separately; there is no all-networks-ready barrier. Local payments may start before the full launch is finished. The shared issuance schedule, metadata, and reserved percentages are frozen. Ongoing Sticky rewards use weekly snapshots and four vesting rounds.',
        reverify: async () => { if (unavailableRef.current) throw new Error('Refresh the FUND state before launching INCOME.'); sameFrozenPlan(draft); const current = await prepareIncomeLaunch(client, captured.input); if (!sameRequest(current.request, captured.plan.request) || current.manifestHash !== captured.plan.manifestHash) throw new Error('The deployment changed. Prepare and review this network again.') },
        beforeWrite: async () => { if (unavailableRef.current) throw new Error('Refresh the FUND state before launching INCOME.'); sameFrozenPlan(draft); const block = await client.getBlock({ blockTag: 'latest' }); if (block.number === null || await client.getChainId() !== chainId) throw new Error('The submission network could not be verified.'); record = beginIncomeLaunchSubmission(localStorage, key, captured.plan.request, projectId, account, isSafeConnection(wagmiConfig), block.number); changed() },
        onWriteRejected: () => { if (record) { clearIncomeLaunchPending(localStorage, key, record); changed() } },
      }); if (hash && record) { recordIncomeLaunchHash(localStorage, key, record, hash); changed() }
    })
  }) }
  async function recover() { const record = local.execution?.record ?? pending; if (!record || !HASH.test(executionHash)) return; await run(() => confirm(record, executionHash as Hex)) }
  async function restore(file?: File) { if (!file) return; try { if (file.size > 1_000_000) throw new Error('The recovery record is too large.'); importIncomeLaunchPending(localStorage, key, await file.text()); changed() } catch (reason) { setError(message(reason)) } }
  const receiptHash = local.execution?.hash ?? (!pending?.safe ? pending?.hash : undefined), link = receiptHash && explorerTxUrl(chainId, receiptHash)
  return <section className="rounded border border-[#c4cdbb] p-4 sm:p-5" aria-label={`${displayChainName(chainId)} INCOME launch`}>
    <h3 className="text-2xl">{displayChainName(chainId)}</h3><p className="mt-2">{formatUnits(BigInt(local.initialIncomeAmount), 18)} initial INCOME allocated here.</p>
    {BigInt(local.initialIncomeAmount) === 0n && <p className="mt-2 text-sm">This network still needs Sticky and INCOME even though its initial allocation is zero.</p>}
    {state && !state.tokenAddress && <p className="mt-3 text-sm">Create this network’s FUND token before Sticky setup. <a className="underline" href={`/project/${chainId}/${projectId}`}>Open FUND project</a></p>}
    {fund.isError && <p role="alert" className="mt-3 text-sm">Live FUND state could not be refreshed. Pending confirmations remain saved.</p>}
    {state && <StickyCreate state={state} client={client} clients={clients} manifest={manifest} launchUnavailable={launchUnavailable} onCreated={id => void stickyCreated(id)} />}
    {local.stickyProjectId && !binding.data && !local.execution && <fieldset disabled={working || tx.busy || tx.phase === 'review' || unavailable} className="mt-4 grid min-w-0 gap-3">
      {blockers.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm">{blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul>}
      <button type="button" className="btn-secondary min-h-11 justify-self-start px-4" onClick={() => void prepare()}>Prepare {displayChainName(chainId)} INCOME</button>
      {review && <><p className="text-sm">This transaction mints {formatUnits(BigInt(local.initialIncomeAmount), 18)} INCOME into the local claim vault. Creation fee: {formatUnits(review.plan.creationFee, 18)} ETH.</p><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={attested} onChange={event => setAttested(event.target.checked)} /><span>I have reviewed the published global snapshot and attest that it includes all FUND holders, credits, bridge entitlements, and completed operator allocations. The contract does not prove historical completeness.</span></label><button type="button" className="btn-primary min-h-11 justify-self-start px-5" disabled={!attested} onClick={() => void submit()}>{txPhaseLabel(tx.phase, { idle: `Review ${displayChainName(chainId)} deployment`, pending: 'Confirming onchain…' })}</button></>}
    </fieldset>}
    {(pending || local.execution || journalError || binding.data && !verifiedId) && <div className="mt-4 grid gap-3 text-sm"><p>{verifiedId ? 'Deployment confirmed on this network.' : pending?.safe ? 'Safe proposal saved. It still needs execution and confirmation.' : 'Saved or existing deployment requires verified execution before this network counts as complete.'}</p>{(pending || local.execution) && <><button type="button" className="btn-secondary min-h-11 justify-self-start px-4" onClick={() => download(JSON.stringify(local.execution?.record ?? pending, null, 2), `income-${chainId}-recovery.json`)}>Download recovery record</button><label className="grid gap-2">Onchain execution hash<input className={inputClass} value={executionHash} onChange={event => setExecutionHash(event.target.value.trim())} placeholder="0x…" /></label><button type="button" className="btn-secondary min-h-11 justify-self-start px-4" disabled={working || !HASH.test(executionHash)} onClick={() => void recover()}>Check execution</button></>}</div>}
    <details className="mt-4 text-sm"><summary className="cursor-pointer">Restore this network’s transaction</summary><label className="mt-3 grid gap-2">Recovery record<input type="file" accept="application/json,.json" disabled={working} onChange={event => { void restore(event.target.files?.[0]); event.target.value = '' }} /></label></details>
    <div role="status" className="mt-3 text-sm" aria-live="polite">{notice && <p>{notice}</p>}{tx.safeProposalHash && <p>Proposed to Safe; execution is still required.</p>}{link && <a className="underline" href={link} target="_blank" rel="noreferrer">View deployment transaction</a>}</div>
    {(error || journalError || tx.error) && <p role="alert" className="mt-3 text-sm text-red-800">{error ?? journalError ?? tx.error}</p>}
    {verifiedId && !(rootState.chainId === chainId && rootIncomeId === verifiedId) && <IncomeProject chainId={chainId} projectId={verifiedId} fundProjectId={projectId} />}
  </section>
}
