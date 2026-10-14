'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getPublicClient, getAccount } from '@wagmi/core'
import { jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { encodeFunctionData, toHex, type Hex, type PublicClient } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { useSafeTx } from '@/hooks/useSafeTx'
import { wagmiConfig } from '@/providers/Providers'
import CreateFlow, { type CreateValues } from './CreateFlow'
import { buildFundLaunch, type FundTransaction } from '@/lib/fund-contracts'
import { FUND_LAUNCH_KEY, canCancelLaunch, launchHeldWrite, launchHold, launchIntent, multisigSetupIntent, cancelUnsubmittedLaunch, discardUnsignedLaunch, decodeLaunchSession, encodeLaunchSession, saveLaunch, updateLaunchStatus, refreshLaunchCreationFee, archiveLaunch, loadLaunchSession, sameSender, type FundLaunchSession, type LaunchStatus } from '@/lib/fund-launch-session'
import { checkLaunchDeployment, fundLaunchFailed, verifyFundLaunch, verifyFailedFundLaunch, verifyReturnedFundWriteFailure } from '@/lib/fund-launch-verification'
import { publishFundProjectMetadata } from '@/lib/publish-fund-project-metadata'
import { resolveCreateMultisigs, checkCreateMultisigs, verifyCreatedMultisigs, multisigDeploymentRequest, multisigReview } from '@/lib/create-multisig'
import { readableError } from '@/lib/readable-error'
import { transactionMessage, type WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import { adoptLegacyWrite } from '@/lib/write-hold'
import { HeldNotice } from '@/components/ui/HeldWriteExit'
import { useLegacyAdoption } from '@/hooks/useLegacyAdoption'
import { launchRequestsDead, runRelayrLaunch } from '@/lib/fund-launch-relayr'
import { displayChainName } from '@/lib/chainDisplay'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { plannedNetworks } from '../../web/create-networks.mjs'
import { isSafeConnection, useSafeConnection, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { readSafeAppExecution } from '@bananapus/nana-sdk-core/safe-service'
import { intentPath } from '@bananapus/nana-sdk-core/jbcenter'
import { projectPath } from '@/lib/urn'

const message = (error: unknown) => readableError(error, 'The request could not be completed.')
function publicClient(chainId: number): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId: chainId as JBChainId })
  if (!client) throw new Error('No RPC client is configured for this chain.')
  return client as PublicClient
}
function LaunchChain({ session, request, status, update, refreshFee, runId = 0, onStopped, onFeedback }: {
  runId?: number
  /** The run ended here: `awaiting` when this chain's hold still follows its send, so its success may continue the run. */
  onStopped?: (awaiting?: boolean) => void
  onFeedback?: (phase: string, error: string) => void
  session: FundLaunchSession; request: FundTransaction; status: LaunchStatus; update: (status: LaunchStatus, expectedPhase?: LaunchStatus['phase'], expectedStatus?: LaunchStatus) => void; refreshFee: (fee: bigint) => void
}) {
  const tx = useSafeTx(request.chainId)
  const setupTx = useSafeTx(request.chainId)
  const [error, setError] = useState('')
  const [verifying, setVerifying] = useState(false)
  useEffect(() => { onFeedback?.(setupTx.busy || setupTx.phase === 'review' ? setupTx.phase : tx.phase, error || tx.error || setupTx.error || '') }, [tx.phase, tx.error, setupTx.phase, setupTx.busy, setupTx.error, error, onFeedback])
  const verifyLock = useRef(false)
  const chain = SUPPORTED_CHAINS.find(value => value.id === request.chainId)!
  const sender = session.input.sender, plans = session.input.multisigs ?? []
  const launchKey = launchIntent(session.input.salt), setupKey = multisigSetupIntent(session.input.salt)
  const verify = async (hash: Hex, safe: boolean, knownExecutionHash?: Hex) => {
    if (verifyLock.current) return
    verifyLock.current = true; setVerifying(true); setError('')
    try {
      const client = publicClient(request.chainId)
      const saved = loadLaunchSession()
      let previous = saved?.statuses[request.chainId]
      if (saved?.input.salt !== session.input.salt || !previous || previous.phase === 'confirmed') throw new Error('The saved launch changed. Reload its progress before checking this transaction.')
      const executionHash = knownExecutionHash ?? (safe ? await waitForSafeExecutionHash(request.chainId, hash, { pollingIntervalMs: 5000, signal: AbortSignal.timeout(60_000) }) : hash)
      const receipt = await client.getTransactionReceipt({ hash: executionHash })
      // A chain still ready or reopened (a recovered hashless attempt the hold settled) records its attempt as pending first.
      if (previous.phase !== 'pending') {
        const attempt: LaunchStatus = { phase: 'pending', hash, safe, walletReturned: true }
        update(attempt, undefined, previous)
        previous = attempt
      }
      if (fundLaunchFailed(receipt, session.input, safe, hash)) {
        // A hash the hold settled came from the wallet; a saved one counts only if the wallet returned it.
        await verifyReturnedFundWriteFailure(client, request, session.input, receipt, { hash, safe, walletReturned: previous.hash === hash ? previous.walletReturned : true })
        await verifyFailedFundLaunch(client, request, session.input, receipt, safe, hash)
        update({ phase: 'reverted', hash, executionHash, safe, walletReturned: true }, undefined, previous)
        return
      }
      const projectId = await verifyFundLaunch(client, request, session.input, receipt, safe)
      update({ phase: 'confirmed', hash, executionHash, safe, walletReturned: true, projectId: projectId.toString() }, undefined, previous)
    } catch (cause) { setError(`Confirmation is unresolved. Keep this launch saved and check again. ${message(cause)}`) }
    finally { verifyLock.current = false; setVerifying(false) }
  }

  // An attempt the launch record saved before SDK holds is adopted into its hold, and the record drops it.
  const { track } = tx, trackSetup = setupTx.track
  const unproven = status.phase === 'reverted' && status.walletReturned !== true
  const legacy = status.phase === 'signing' || unproven || (status.phase === 'pending' && !!status.hash && !status.executionHash) || !!status.multisigSetup
  const adoption = useLegacyAdoption(), adopt = adoption.run
  useEffect(() => {
    let stopped = false
    void adopt(async () => {
      const client = publicClient(request.chainId) as WriteHoldClient
      const current = loadLaunchSession()?.statuses[request.chainId]
      if (!current || current.phase === 'confirmed') return
      const setupRequest = multisigDeploymentRequest(request.chainId, plans)
      if (!legacy) {
        // Nothing saved from before SDK holds: whatever the launch's holds hold is shown, whatever the launch's state now.
        if (plans.length) await trackSetup({ ...setupRequest, label: 'Create project multisigs' }, { reviewedAccount: sender, recoveryNamespace: setupKey, heldOnly: true })
        await track({ ...request, label: `Launch ${session.name} FUND on ${chain.name}` }, { reviewedAccount: sender, recoveryNamespace: launchKey, heldOnly: true })
        return
      }
      let next: LaunchStatus = current
      if (current.multisigSetup) {
        const held = launchHold(setupKey, sender, setupRequest, current.multisigSetup)
        const { adopted } = await adoptLegacyWrite(held.input, held.evidence, client)
        if (!stopped) await trackSetup({ ...setupRequest, label: 'Create project multisigs' }, { reviewedAccount: sender, recoveryNamespace: setupKey, safe: held.input.safe })
        // The record keeps the setup until its attempt is the hold's.
        if (adopted) next = { ...next, multisigSetup: undefined }
      }
      const reopened = current.phase === 'signing' || (current.phase === 'reverted' && current.walletReturned !== true)
      if (reopened || current.phase === 'pending') {
        // A failure without the wallet's hash says nothing of the attempt itself: it is held without one.
        const held = launchHold(launchKey, sender, request, current.phase === 'reverted' ? { safe: current.safe } : current)
        const { adopted } = await adoptLegacyWrite(held.input, held.evidence, client)
        if (!stopped) await track({ ...request, label: `Launch ${session.name} FUND on ${chain.name}` }, { reviewedAccount: sender, recoveryNamespace: launchKey, safe: held.input.safe })
        // An attempt without the wallet's hash is the hold's alone once adopted; a saved hash stays this chain's pending launch.
        if (reopened && adopted) next = { phase: 'ready', ...(next.multisigSetup ? { multisigSetup: next.multisigSetup } : {}) }
      }
      if (next !== current) update(next, current.phase === 'signing' ? 'signing' : undefined, current)
    }).catch(cause => { if (!stopped) setError(message(cause)) })
    return () => { stopped = true }
  // The saved record decides when there is something to adopt; the adoption reads what is saved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacy])

  // Only the SDK's hold settling this chain's launch (or its final revert) lets its execution be verified and recorded.
  const settled = tx.phase === 'success' || tx.phase === 'error' ? tx.receipt : null
  useEffect(() => {
    if (!settled || status.phase === 'confirmed') return
    void verify(tx.submissionHash ?? settled.transactionHash, status.safe ?? tx.isSafe, settled.transactionHash)
  // A settled receipt is verified once; the verification reads what is saved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  /** The SDK's exit, which also reopens a pending launch the chain never placed, and ends the run. */
  const launchHeld = {
    notice: tx.notice,
    held: tx.held && { ...tx.held, release: () => {
      tx.held!.release()
      onStopped?.(false)
      const current = loadLaunchSession()?.statuses[request.chainId]
      if (current?.phase === 'pending') { try { update({ phase: 'ready' }, 'pending', current) } catch (cause) { setError(message(cause)) } }
    } },
  }

  async function ensureMultisigs() {
    if (!plans.length) return
    const client = publicClient(request.chainId)
    await checkCreateMultisigs(client, plans)
    if (await verifyCreatedMultisigs(client, plans, true)) return
    const setupRequest = multisigDeploymentRequest(request.chainId, plans)
    const safe = isSafeConnection(wagmiConfig)
    const hash = await setupTx.send({ ...setupRequest, label: 'Create project multisigs' }, {
      reviewedAccount: sender,
      recoveryNamespace: setupKey,
      beforeWrite: adoption.wait,
      reviewNotice: multisigReview(plans),
      reverify: async () => { sameSender(getAccount(wagmiConfig).address, sender); await checkCreateMultisigs(client, plans) },
    })
    if (!hash) throw new Error('Multisig creation has not completed. Continue when ready.')
    const executionHash = safe ? await waitForSafeExecutionHash(request.chainId, hash, { pollingIntervalMs: 5000, signal: AbortSignal.timeout(60_000) }) : hash
    const receipt = await client.waitForTransactionReceipt({ hash: executionHash, timeout: 60_000 })
    const result = safe
      ? await readSafeAppExecution({ client, receipt, safe: sender, proposalHash: hash, calls: [{ to: setupRequest.address, data: encodeFunctionData(setupRequest), value: setupRequest.value ?? 0n }] })
      : { status: receipt.status === 'success' ? 'success' : 'failed' }
    if (result.status !== 'success' && result.status !== 'failed')
      throw new Error('The multisig setup is unresolved. Its Safe proposal is still followed; continue once it executes.')
    if (result.status === 'failed') {
      setupTx.reset()
      throw new Error('Multisig creation reverted. Continue to retry the setup.')
    }
    await verifyCreatedMultisigs(client, plans)
    setupTx.reset()
  }

  async function submitLaunch() {
    setError('')
    try {
      sameSender(getAccount(wagmiConfig).address, sender)
      await ensureMultisigs()
      const safe = isSafeConnection(wagmiConfig)
      const hash = await tx.send({ ...request, label: `Launch ${session.name} FUND on ${chain.name}` }, {
        reviewedAccount: sender,
        recoveryNamespace: launchKey,
        beforeWrite: adoption.wait,
        reverify: async () => {
          sameSender(getAccount(wagmiConfig).address, sender)
          await checkLaunchDeployment(publicClient(request.chainId), request)
          await verifyCreatedMultisigs(publicClient(request.chainId), plans)
        },
        reviewNotice: 'Creates only the FUND fundraising Juicebox. The owner can change future rules. INCOME, Owner success tokens, and asset withdrawals are not created by this transaction.',
      })
      if (!hash) return
      // The hold follows it from here; its settlement, not a receipt read now, confirms the launch.
      const previous = loadLaunchSession()?.statuses[request.chainId]
      if (previous && previous.phase !== 'pending') update({ phase: 'pending', hash, safe, walletReturned: true }, undefined, previous)
    } catch (cause) { setError(message(cause)) }
  }
  /** Ask this chain's hold about its saved pending launch: what it settles is what the launch records. */
  async function checkHold() {
    setError('')
    try {
      const current = loadLaunchSession()?.statuses[request.chainId]
      if (current?.phase === 'pending' && current.hash) {
        const held = launchHold(launchKey, sender, request, current)
        await adoptLegacyWrite(held.input, held.evidence, publicClient(request.chainId) as WriteHoldClient)
      }
      await track({ ...request, label: `Launch ${session.name} FUND on ${chain.name}` }, { reviewedAccount: sender, recoveryNamespace: launchKey, safe: current?.safe })
    } catch (cause) { setError(message(cause)) }
  }
  async function launch() {
    if (!navigator.locks) { setError('This browser cannot coordinate a resumable deployment. Open this launch in a browser with Web Locks support.'); return }
    await navigator.locks.request(`homerun:fund-launch:${session.input.salt}`, { ifAvailable: true }, async lock => {
      if (!lock) { setError('Another tab is reviewing this launch. Finish that review first.'); return }
      await submitLaunch()
    })
  }
  const lastRun = useRef(0)
  useEffect(() => {
    if (!runId || lastRun.current === runId) return
    lastRun.current = runId
    void (async () => {
      if (status.phase === 'pending' && status.hash) await checkHold()
      else if (status.phase === 'ready' || status.phase === 'reverted') await launch()
      const phase = loadLaunchSession()?.statuses[request.chainId]?.phase
      if (phase !== 'confirmed') onStopped?.(phase === 'pending')
    })().catch(() => onStopped?.(false))
  // One explicit Create/Continue gesture starts each destination once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])
  /** The launch or its setup is with the wallet, the chain or a Safe: no other is sent meanwhile. */
  const sending = [tx.phase, setupTx.phase].some(phase => phase === 'submitted' || phase === 'pending')
  return <section className="contract-panel">
    <h3>{chain.name}</h3>
    <p role="status">{status.phase === 'confirmed' ? 'FUND deployment verified onchain.' : status.phase === 'pending' ? status.safe ? 'Safe proposal awaiting execution.' : 'Transaction submitted; confirmation pending.' : status.phase === 'reverted' ? 'The deployment reverted. No project was created by this transaction.' : 'Ready for transaction review.'}</p>
    {status.hash && <p><a target="_blank" rel="noreferrer" href={status.executionHash || !status.safe ? `${chain.blockExplorers.default.url}/tx/${status.executionHash ?? status.hash}` : 'https://app.safe.global/transactions/queue'}>{status.safe && !status.executionHash ? 'View Safe queue' : 'View transaction'}: {status.hash.slice(0, 12)}…</a></p>}
    {status.phase === 'confirmed' && <a className="create-primary" href={projectPath(request.chainId, status.projectId!)}>Open FUND project ↗</a>}
    {(status.phase === 'ready' || status.phase === 'reverted') && <button type="button" disabled={tx.busy || setupTx.busy || tx.phase === 'review' || setupTx.phase === 'review' || verifying || sending || !adoption.ready} onClick={() => void launch()}>Review and deploy FUND</button>}
    {status.phase === 'pending' && status.hash && <button type="button" disabled={verifying} onClick={() => void checkHold()}>{verifying ? 'Checking execution…' : 'Check confirmation'}</button>}
    {setupTx.phase === 'submitted' && <div role="status"><HeldNotice tx={{ notice: setupTx.notice, held: setupTx.held && { ...setupTx.held, release: () => { setupTx.held!.release(); onStopped?.(false) } } }} /></div>}
    {tx.phase === 'submitted' && <div role="status"><HeldNotice tx={launchHeld} /></div>}
    {['ready', 'reverted'].includes(status.phase) && <button type="button" disabled={tx.busy || tx.phase === 'review'} onClick={() => void publicClient(request.chainId).readContract({ address: v6Address('JBProjects', request.chainId as JBChainId), abi: jbProjectsAbi, functionName: 'creationFee' }).then(refreshFee).catch(cause => setError(message(cause)))}>Refresh deployment fee</button>}
    {(error || tx.error || setupTx.error) && <p role="alert">{transactionMessage(error || tx.error || setupTx.error || '')}</p>}
  </section>
}

export function FundDeploy({ values, onLockChange, importedRecord, onRecordUsed }: { values?: CreateValues; onLockChange?: (chains: readonly number[] | null) => void; importedRecord?: string | null; onRecordUsed?: () => void }) {
  const router = useRouter()
  const { address, isCenterWallet } = useWallet()
  const safeConnection = useSafeConnection(wagmiConfig)
  const [session, setSession] = useState<FundLaunchSession | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [runId, setRunId] = useState(0)
  const busyRef = useRef(false)
  /** A direct launch started on this page continues chain by chain as each hold settles with success. */
  const autoContinue = useRef(false)
  useEffect(() => {
    try { const saved = localStorage.getItem(FUND_LAUNCH_KEY); if (saved) setSession(decodeLaunchSession(saved)) }
    catch (cause) { setError(message(cause)) }
    setLoaded(true)
  }, [])

  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key !== FUND_LAUNCH_KEY) return; try { setSession(event.newValue ? decodeLaunchSession(event.newValue) : null) } catch (cause) { setError(message(cause)) } };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync)
  }, [])

  const selectionKey = values?.networkEnvironment && values?.networks?.length
    ? plannedNetworks(values).map((chain: { chainId: number }) => chain.chainId).join(',') : ''
  // Juicebox Center recovers the publisher from a signature, so a passkey or Safe
  // connection cannot publish and keeps the transaction path. `loaded` keeps this
  // first client render equal to the server's.
  const needsTransaction = loaded && (isCenterWallet || safeConnection)
  useEffect(() => {
    onLockChange?.(session?.input.chainIds ?? (preparing && selectionKey ? selectionKey.split(',').map(Number) : null))
  }, [session, preparing, selectionKey, onLockChange])
  const selectionChanged = !!session && !!selectionKey && session.input.chainIds.join(',') !== selectionKey
  useEffect(() => {
    if (!session || !selectionChanged || running || preparing) return
    try {
      if (discardUnsignedLaunch(session.input.salt)) {
        setSession(null); setError(''); setProgress('')
      }
    } catch (cause) { setError(message(cause)) }
  }, [session, selectionChanged, running, preparing])

  const persist = (next: FundLaunchSession) => { const saved = saveLaunch(next); setSession(saved); return saved }
  async function run(next: FundLaunchSession) {
    if (next.transport === 'intent') return
    if (busyRef.current) return
    busyRef.current = true; setRunning(true); setError('')
    let directStarted = false
    try {
      sameSender(getAccount(wagmiConfig).address, next.input.sender)
      if (!next.transport && next.input.chainIds.length > 1 && !isSafeConnection(wagmiConfig) && Object.values(next.statuses).every(status => status.phase === 'ready' && !status.multisigSetup)) {
        next = persist({ ...next, transport: 'relayr' })
      }
      if (next.transport === 'relayr') {
        await runRelayrLaunch({ session: next, account: next.input.sender, onStatus: () => setSession(loadLaunchSession()), onProgress: setProgress })
        setProgress('Your project is created on every selected chain.')
      } else {
        setProgress('Confirm the deployment in your wallet.')
        // While this page stays open, each chain's settled success starts the next.
        autoContinue.current = true
        directStarted = true
        setRunId(value => value + 1)
        return
      }
    } catch (cause) { setError(message(cause)) }
    finally { if (!directStarted) { busyRef.current = false; setRunning(false); setSession(loadLaunchSession()) } }
  }
  const directFeedback = useCallback((phase: string, detail: string) => {
    if (detail) setError(detail)
    const text: Record<string, string> = { review: 'Review the transaction to continue.', simulating: 'Checking the transaction before opening your wallet…', signing: 'Open MetaMask or your connected wallet to confirm the transaction.', pending: 'Transaction submitted. Waiting for confirmation…' }
    if (detail) setProgress('')
    else if (text[phase]) setProgress(text[phase])
  }, [])
  /** A run that stopped without a send its hold still follows (an exit, a rejection, an unknown result) no longer continues on its own. */
  function stopDirect(awaiting = false) { if (!awaiting) autoContinue.current = false; busyRef.current = false; setRunning(false) }
  async function prepare() {
    if (!address || !values || preparing || busyRef.current) return
    setPreparing(true); setError('')
    try {
      if (localStorage.getItem(FUND_LAUNCH_KEY)) throw new Error('A saved launch already exists. Reload to resume it.')
      const chainIds = plannedNetworks(values).map((chain: { chainId: number }) => chain.chainId)
      const sender = address
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
      const resolved = await resolveCreateMultisigs(values, chainIds.map(publicClient), salt)
      const owner = resolved.owner
      const pin = await publishFundProjectMetadata(resolved.values)
      const fees = await Promise.all(chainIds.map(async (id: number) => {
        const client = publicClient(id)
        const fee = await client.readContract({ address: v6Address('JBProjects', id as JBChainId), abi: jbProjectsAbi, functionName: 'creationFee' })
        const block = await client.getBlock()
        return { id, fee, timestamp: Number(block.timestamp) }
      }))
      sameSender(getAccount(wagmiConfig).address, sender)
      const input = {
        owner, sender, chainIds, projectUri: `ipfs://${pin.cid}`,
        tokenName: resolved.values.fundTokenName, ticker: resolved.values.fundTicker,
        salt, multisigs: resolved.plans, operator: resolved.operator,
        mustStartAtOrAfter: chainIds.length > 1 ? Math.max(...fees.map(row => row.timestamp)) : 0,
        creationFees: Object.fromEntries(fees.map(row => [row.id, row.fee])),
      }
      const built = buildFundLaunch(input)
      await Promise.all(built.requests.map(request => checkLaunchDeployment(publicClient(request.chainId), request)))
      const next = persist({ version: 1, name: values.name, input, transport: (chainIds.length > 1 || resolved.plans.length > 0) && !isSafeConnection(wagmiConfig) ? 'relayr' : 'direct', statuses: Object.fromEntries(chainIds.map((id: number) => [id, { phase: 'ready' as const }])) })
      setPreparing(false)
      await run(next)
    } catch (cause) { setError(message(cause)) }
    finally { setPreparing(false) }
  }
  let requests: FundTransaction[] = []
  let invalid = ''
  if (session) { try { requests = buildFundLaunch(session.input).requests } catch (cause) { invalid = message(cause) } }
  const download = () => {
    if (!session) return
    const url = URL.createObjectURL(new Blob([encodeLaunchSession(session)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'homerun-fund-launch.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  function restore(text: string) {
    setError('')
    try {
      if (text.length > 1_000_000) throw new Error('The deployment record is too large.')
      if (localStorage.getItem(FUND_LAUNCH_KEY)) throw new Error('A saved launch already exists. Reload to resume it.')
      const imported = decodeLaunchSession(text)
      // Imported progress is a recovery hint. Re-verify claimed confirmations
      // against their exact onchain transaction before showing a created project.
      const statuses = Object.fromEntries(Object.entries(imported.statuses).map(([chainId, status]) => [chainId, {
        ...status, walletReturned: undefined,
        ...(status.multisigSetup ? { multisigSetup: { ...status.multisigSetup, walletReturned: undefined } } : {}),
        ...(['confirmed', 'reverted'].includes(status.phase) ? { phase: 'pending' as const, projectId: undefined } : {}),
      }]))
      persist({ ...imported, statuses })
    } catch (cause) { setError(message(cause)) }
  }
  useEffect(() => {
    if (!loaded || !importedRecord) return
    onRecordUsed?.()
    restore(importedRecord)
  })
  const complete = !!session && Object.values(session.statuses).every(status => status.phase === 'confirmed')
  const signingChain = running ? session?.input.chainIds.find(id => session.statuses[id].phase === 'signing') : undefined
  const activeChain = session?.input.chainIds.find(id => session.statuses[id].phase !== 'confirmed')
  useEffect(() => { if (complete) { busyRef.current = false; setRunning(false); router.replace('/create/success') } }, [complete, router])
  // A chain confirmed by its hold's settlement starts the next chain, as Continue would; anything else stops the run.
  const confirmedChains = session ? session.input.chainIds.filter(id => session.statuses[id].phase === 'confirmed').length : 0
  const revertedChain = !!session && session.input.chainIds.some(id => session.statuses[id].phase === 'reverted')
  const lastConfirmed = useRef(confirmedChains)
  useEffect(() => {
    const before = lastConfirmed.current
    lastConfirmed.current = confirmedChains
    if (revertedChain) { autoContinue.current = false; return }
    if (!session || complete || !autoContinue.current || confirmedChains <= before || session.transport === 'relayr' || session.transport === 'intent') return
    void run(session)
  // The confirmed count decides; the run reads the saved launch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmedChains, revertedChain])
  return <div className="fund-launch">
    <h2 className="text-xl">Create your project</h2>
    <p>Create your multisigs and the FUND raise on your selected chains. INCOME and the Owner’s success allocation are separate later actions.</p>
    {selectionChanged && (session!.transport === 'intent'
      ? <p role="alert">This project is already published on {session!.input.chainIds.map(displayChainName).join(', ')}. Finish it before changing networks.</p>
      : <p role="alert">This launch already has wallet authorizations for {session!.input.chainIds.map(displayChainName).join(', ')}. Continue completes that saved launch; changing the selection above cannot replace signed requests.</p>)}
    {!session ? <>
      <button type="button" className="create-primary" disabled={preparing || !loaded} onClick={() => router.push('/create/preview')}>Preview your project</button>
      <p className="text-sm">The preview is the project page this creates. Nothing is created until you press Make it real there.</p>
      {needsTransaction && <button type="button" className="quiet-button" disabled={preparing || !loaded || !address} onClick={() => void prepare()}>Create with a transaction</button>}
    </>
      : session.transport === 'intent' ? typeof session.intentId === 'string' ? <>
        <p role="status">This project is published. Center’s sponsor deploys it on {session.input.chainIds.map(displayChainName).join(', ')} the first time it is used, and its page offers Deploy.</p>
        <a className="create-primary" href={intentPath(session.intentId)}>Open project ↗</a>
        <button type="button" className="quiet-button" onClick={() => { try { archiveLaunch(session.input.salt); setSession(null); setProgress('') } catch (cause) { setError(message(cause)) } }}>Finish this project and start another</button>
      </>
      : <>
        <p role="alert">This saved record has no published project to open. Cancel it and create the project again.</p>
        <button type="button" className="quiet-button" disabled={running || preparing} onClick={() => {
          void cancelUnsubmittedLaunch(session.input.salt).then(() => { setSession(null); setError(''); setProgress(''); onLockChange?.(null) }).catch(cause => setError(message(cause)))
        }}>Discard and edit details</button>
      </>
      : <>
        {signingChain !== undefined && <div className="fund-launch-action" role="status"><span>Confirm the {displayChainName(signingChain)} request in your wallet.</span></div>}
        <ul className="fund-launch-progress" aria-label="Deployment progress">{session.input.chainIds.map(id => {
          const phase = session.statuses[id].phase
          const needsWallet = signingChain === id
          const label = ({ ready: running ? 'Queued' : 'Not started', signing: needsWallet ? 'Awaiting confirmation' : 'Resume to check', authorized: '✓ Signed', pending: session.statuses[id].safe ? 'Awaiting Safe execution' : 'Deploying…', confirmed: '✓ Created', reverted: 'Retry needed', unresolved: session.relayr?.abandonable === true ? 'May have run' : 'Checking…', expired: 'New signature needed' })[phase]
          return <li key={id} data-action={needsWallet || undefined}><span>{displayChainName(id)}</span><span className="fund-launch-badge" data-state={needsWallet ? 'action' : phase}>{label}</span>{session.statuses[id].error && <p role="status">{transactionMessage(session.statuses[id].error!)}</p>}</li>
        })}</ul>
        {progress && signingChain === undefined && <p role="status">{transactionMessage(progress)}</p>}
        {!complete && <button type="button" className="create-primary" disabled={running || preparing || !address} onClick={() => void run(session)}>{running ? 'Creating your project…' : 'Continue creation'}</button>}
        {!complete && canCancelLaunch(session) && <button type="button" className="quiet-button" disabled={running || preparing} onClick={() => {
          void cancelUnsubmittedLaunch(session.input.salt, launchRequestsDead).then(() => { setSession(null); setError(''); setProgress(''); onLockChange?.(null) }).catch(cause => setError(message(cause)))
        }}>Discard and edit details</button>}
        {complete && <a className="create-primary" href={projectPath(session.input.chainIds[0], session.statuses[session.input.chainIds[0]].projectId!)}>Open project ↗</a>}
      </>}
    {(error || invalid) && <p role="alert">{transactionMessage(error || invalid)}</p>}
    {!session && error && <button type="button" onClick={() => setError('')}>Try again</button>}
    {session && <details className="fund-launch-recovery" open={launchHeldWrite(session) || undefined}><summary>Deployment recovery</summary>
        <><p>{session.name}. Owner <code>{session.input.owner}</code>. This saved launch retains its original settings.</p><button type="button" onClick={download}>Download deployment record</button>
          {session.transport !== 'relayr' && session.transport !== 'intent' && requests.map(request => <LaunchChain key={`${session.input.salt}:${request.chainId}`} session={session} request={request} status={session.statuses[request.chainId]} runId={running && activeChain === request.chainId ? runId : 0} onStopped={stopDirect} onFeedback={directFeedback} update={(status, expectedPhase, expectedStatus) => setSession(updateLaunchStatus(session.input.salt, request.chainId, status, expectedPhase, expectedStatus))} refreshFee={fee => setSession(refreshLaunchCreationFee(session.input.salt, request.chainId, fee))} />)}
          {complete && <button type="button" onClick={() => { try { archiveLaunch(session.input.salt); setSession(null); setProgress('') } catch (cause) { setError(message(cause)) } }}>Finish this launch and start another</button>}
        </>
    </details>}
  </div>
}

export default function LiveCreate() {
  const [lockedChains, setLockedChains] = useState<readonly number[] | null>(null)
  const [record, setRecord] = useState<string | null>(null)
  return <CreateFlow lockedChains={lockedChains} onImportRecord={setRecord}
    renderDeploy={values => <FundDeploy values={values} onLockChange={setLockedChains} importedRecord={record} onRecordUsed={() => setRecord(null)} />} />
}
