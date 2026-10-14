'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSavedAttempt } from '@bananapus/nana-sdk-core/review/react'
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
import { FUND_LAUNCH_KEY, canCancelLaunch, launchHeldWrite, launchIntent, launchScope, multisigSetupIntent, setupScope, cancelUnsubmittedLaunch, discardUnsignedLaunch, decodeLaunchSession, encodeLaunchSession, saveLaunch, updateLaunchStatus, refreshLaunchCreationFee, archiveLaunch, loadLaunchSession, sameSender, type FundLaunchSession, type LaunchStatus } from '@/lib/fund-launch-session'
import { checkLaunchDeployment, fundLaunchFailed, verifyFundLaunch, verifyFailedFundLaunch, verifyReturnedFundWriteFailure } from '@/lib/fund-launch-verification'
import { publishFundProjectMetadata } from '@/lib/publish-fund-project-metadata'
import { resolveCreateMultisigs, checkCreateMultisigs, verifyCreatedMultisigs, multisigDeploymentRequest, multisigReview } from '@/lib/create-multisig'
import { readableError } from '@/lib/readable-error'
import { transactionMessage, type SavedAttempt, type WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import { adoptSavedNonce, attempts, callOf } from '@/lib/write-hold'
import { HeldNotice, retiringExit } from '@/components/ui/HeldWriteExit'
import { SavedAttemptNotice } from '@/components/ui/SavedAttemptNotice'
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
function LaunchChain({ session, chainId, request, status, update, refreshFee, runId = 0, onStopped, onFeedback }: {
  runId?: number
  /** The run ended here: `awaiting` when this chain's hold still follows its send, so its success may continue the run. */
  onStopped?: (awaiting?: boolean) => void
  onFeedback?: (phase: string, error: string) => void
  session: FundLaunchSession; chainId: number
  /** This chain's deployment request; none while the saved launch can't be built (its recovery still runs). */
  request?: FundTransaction
  status: LaunchStatus; update: (status: LaunchStatus, expectedPhase?: LaunchStatus['phase'], expectedStatus?: LaunchStatus) => void; refreshFee: (fee: bigint) => void
}) {
  const tx = useSafeTx(chainId)
  const setupTx = useSafeTx(chainId)
  const [error, setError] = useState('')
  const [verifying, setVerifying] = useState(false)
  useEffect(() => { onFeedback?.(setupTx.busy || setupTx.phase === 'review' ? setupTx.phase : tx.phase, error || tx.error || setupTx.error || '') }, [tx.phase, tx.error, setupTx.phase, setupTx.busy, setupTx.error, error, onFeedback])
  const chain = SUPPORTED_CHAINS.find(value => value.id === chainId)!
  const sender = session.input.sender
  const plans = useMemo(() => session.input.multisigs ?? [], [session.input.multisigs])
  const savedLaunch = encodeLaunchSession(session)
  const launchKey = launchIntent(session.input.salt), setupKey = multisigSetupIntent(session.input.salt)
  const label = `Launch ${session.name} FUND on ${chain.name}`
  const setupRequest = useMemo(() => { try { return plans.length ? multisigDeploymentRequest(chainId, plans) : undefined } catch { return undefined } }, [chainId, plans])
  const client = useMemo(() => publicClient(chainId) as WriteHoldClient, [chainId])

  // This chain's deployment and multisig setup recover through the SDK before anything is sent: a held
  // write shows with its exit, one that settled while away is verified and recorded, one nothing can
  // show asks the user. Recovery reads only the saved launch, never a rebuilt request.
  const launchAttempt = useMemo((): SavedAttempt<{ projectId: bigint; hash: Hex; safe: boolean }> | null => {
    const scope = launchScope(session, chainId, request, isSafeConnection(wagmiConfig))
    return scope && { ...scope, authenticate: async hash => {
      if (!hash) return { result: 'unknown', reason: 'No saved deployment transaction to check.' }
      if (!request) return { result: 'unknown', reason: 'This launch can no longer be built here.' }
      const receipt = await publicClient(chainId).getTransactionReceipt({ hash })
      if (receipt.status !== 'success') return { result: 'not-this', reason: 'The deployment reverted.' }
      // An account's own deployment, else a Safe's execution of it.
      let reason: unknown
      for (const safe of status.safe === undefined ? [false, true] : [status.safe]) {
        try { return { result: 'proven', value: { projectId: await verifyFundLaunch(publicClient(chainId), request, session.input, receipt, safe), hash, safe } } }
        catch (cause) { reason = cause }
      }
      return { result: 'unknown', reason: message(reason) }
    } }
  // The saved launch record is the attempt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, request, savedLaunch, status])
  const setupAttempt = useMemo((): SavedAttempt<true> | null => {
    const scope = setupScope(session, chainId, setupRequest, isSafeConnection(wagmiConfig))
    return scope && { ...scope, authenticate: async () => (await verifyCreatedMultisigs(publicClient(chainId), plans, true))
      ? { result: 'proven', value: true } : { result: 'unknown', reason: 'The planned Safes are not all deployed.' } }
  // The saved launch record is the attempt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, setupRequest, savedLaunch, status])
  // A write saved before SDK holds with only its nonce goes into its hold first, so the hold can find it on chain.
  const nonceOnly = (saved?: { hash?: Hex; nonce?: string; fromBlock?: string }) => !!saved && !saved.hash && saved.nonce !== undefined
  const legacyNonces = [nonceOnly(status.phase === 'signing' ? status : undefined) ? 'launch' : '', nonceOnly(status.multisigSetup) ? 'setup' : ''].join()
  const [adopted, setAdopted] = useState<string | null>(null)
  useEffect(() => {
    let stopped = false
    const evidence = (saved: { nonce?: string; fromBlock?: string }) => ({ nonce: BigInt(saved.nonce!), ...(saved.fromBlock !== undefined ? { fromBlock: BigInt(saved.fromBlock) } : {}) })
    void (async () => {
      if (status.phase === 'signing' && nonceOnly(status) && request) await adoptSavedNonce({ chainId, account: sender, safe: status.safe ?? false, namespace: launchKey, call: callOf(request) }, evidence(status), client)
      if (nonceOnly(status.multisigSetup) && setupRequest) await adoptSavedNonce({ chainId, account: sender, safe: status.multisigSetup!.safe, namespace: setupKey, call: callOf(setupRequest) }, evidence(status.multisigSetup!), client)
    })().finally(() => { if (!stopped) setAdopted(legacyNonces) })
    return () => { stopped = true }
  // The saved nonces decide; the adoption reads what is saved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyNonces])
  const ready = adopted === legacyNonces
  const launch = useSavedAttempt({ recovery: attempts, attempt: ready ? launchAttempt : null, client, checkNext: 'Deploy again' })
  const setup = useSavedAttempt({ recovery: attempts, attempt: ready ? setupAttempt : null, client, checkNext: 'Create multisigs again' })
  const { track } = tx, trackSetup = setupTx.track
  /** Record this chain's verified result; a chain still ready records its attempt as pending first. */
  const record = (next: LaunchStatus) => {
    const current = loadLaunchSession()?.statuses[chainId]
    if (!current || current.phase === 'confirmed') return
    let previous = current
    if (previous.phase !== 'pending' && next.phase !== 'ready' && next.phase !== 'pending') {
      const attempt: LaunchStatus = { phase: 'pending', hash: next.hash!, safe: next.safe, walletReturned: true }
      update(attempt, undefined, previous)
      previous = attempt
    }
    update(next, previous.phase === 'signing' ? 'signing' : undefined, previous)
  }
  useEffect(() => {
    const outcome = launch.outcome
    if (!outcome) return
    try {
      const current = loadLaunchSession()?.statuses[chainId]
      if (!current || current.phase === 'confirmed') return
      if (outcome.status === 'held') {
        track(request ? { ...request, label } : { chainId, call: { ...outcome.state.record.call, value: BigInt(outcome.state.record.call.value) } }, { reviewedAccount: sender, recoveryNamespace: launchKey, safe: outcome.state.record.safe, reservation: outcome.state.record.id })
        // The hold has a legacy hashless attempt, or an unproven failure, now: the record follows it.
        if (current.phase === 'signing') record({ phase: 'ready' })
        else if (current.phase === 'reverted' && current.walletReturned !== true) record({ phase: 'pending', hash: current.hash!, safe: current.safe })
      } else if (outcome.status === 'done' && outcome.result === 'success' && outcome.authenticated) {
        const { projectId, hash, safe } = outcome.value
        record({ phase: 'confirmed', hash: current.hash ?? hash, executionHash: hash, safe, walletReturned: true, projectId: projectId.toString() })
      } else if (outcome.status === 'done' && outcome.result === 'failed' && current.phase !== 'reverted') {
        record({ phase: 'reverted', hash: current.hash ?? outcome.hash, executionHash: outcome.hash, safe: current.safe ?? false, walletReturned: true })
      } else if (outcome.status === 'none' && outcome.retired && current.phase !== 'ready') {
        // The user's exit or check (or the wallet's rejection) retired it: the chain reopens, keeping that attempt's evidence.
        record({ phase: 'ready', ...(current.hash ? { releasedHash: current.hash } : {}), ...(current.multisigSetup ? { multisigSetup: current.multisigSetup } : {}) })
      }
    } catch (cause) { setError(message(cause)) }
  // Each outcome is handled once, against the record as it is now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.outcome])
  useEffect(() => {
    const outcome = setup.outcome
    if (!outcome) return
    try {
      const current = loadLaunchSession()?.statuses[chainId]
      if (outcome.status === 'held') {
        trackSetup(setupRequest ? { ...setupRequest, label: 'Create project multisigs' } : { chainId, call: { ...outcome.state.record.call, value: BigInt(outcome.state.record.call.value) } }, { reviewedAccount: sender, recoveryNamespace: setupKey, safe: outcome.state.record.safe, reservation: outcome.state.record.id })
      } else if (outcome.status === 'done' && outcome.result === 'success' && outcome.authenticated && !current?.multisigSetup) {
        void setup.retire({ by: 'settled', ...(outcome.hash ? { hash: outcome.hash } : {}) })
      }
      // The record keeps a setup from before SDK holds only until the hold has it, it settled, or it was retired.
      if (current?.multisigSetup && current.phase !== 'confirmed' && (outcome.status === 'held' || outcome.status === 'done' || (outcome.status === 'none' && outcome.retired))) {
        const { multisigSetup: _setup, ...rest } = current
        void _setup
        update(rest as LaunchStatus, current.phase === 'signing' ? 'signing' : undefined, current)
      }
    } catch (cause) { setError(message(cause)) }
  // Each outcome is handled once, against the record as it is now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup.outcome])
  /** Sends wait until both recoveries say nothing is in flight or unexplained: none ran, or it ran and is recorded. */
  const launchClear = ready && (!launchAttempt || !!launch.outcome && (launch.outcome.status === 'none' || (launch.outcome.status === 'done' && launch.outcome.result === 'failed')))
  const setupClear = ready && (!setupAttempt || !!setup.outcome && (setup.outcome.status === 'none' || (setup.outcome.status === 'done' && (setup.outcome.result === 'failed' || setup.outcome.authenticated))))
  const clearRef = useRef(false)
  clearRef.current = launchClear && setupClear

  /** Verify a settled execution of this chain's launch and record its project or proven failure. */
  const verify = async (hash: Hex, safe: boolean, executionHash: Hex) => {
    if (!request) return
    setVerifying(true); setError('')
    try {
      const client = publicClient(chainId)
      const receipt = await client.getTransactionReceipt({ hash: executionHash })
      if (fundLaunchFailed(receipt, session.input, safe, hash)) {
        // A hash the hold settled came from the wallet; a saved one counts only if the wallet returned it.
        const previous = loadLaunchSession()?.statuses[chainId]
        await verifyReturnedFundWriteFailure(client, request, session.input, receipt, { hash, safe, walletReturned: previous?.hash === hash ? previous.walletReturned : true })
        await verifyFailedFundLaunch(client, request, session.input, receipt, safe, hash)
        record({ phase: 'reverted', hash, executionHash, safe, walletReturned: true })
      } else {
        const projectId = await verifyFundLaunch(client, request, session.input, receipt, safe)
        record({ phase: 'confirmed', hash, executionHash, safe, walletReturned: true, projectId: projectId.toString() })
      }
    } catch (cause) { setError(`Confirmation is unresolved. Keep this launch saved and check again. ${message(cause)}`) }
    finally { setVerifying(false) }
  }
  // Only the SDK's hold settling this chain's launch (or its final revert) lets its execution be verified and recorded.
  const settled = tx.phase === 'success' || tx.phase === 'error' ? tx.receipt : null
  useEffect(() => {
    if (!settled || status.phase === 'confirmed') return
    void verify(tx.submissionHash ?? settled.transactionHash, status.safe ?? tx.isSafe, settled.transactionHash)
  // A settled receipt is verified once; the verification reads what is saved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  /** The SDK's exit; once it releases, the saved attempt is retired, the run ends, and the recovery reopens the chain. */
  const launchHeld = { notice: tx.notice, held: retiringExit(tx.held, launch.retire, () => onStopped?.(false)) }
  const setupHeld = { notice: setupTx.notice, held: retiringExit(setupTx.held, setup.retire, () => onStopped?.(false)) }

  async function ensureMultisigs() {
    if (!plans.length) return
    if (!setupRequest) throw new Error('This launch’s multisigs can no longer be built here.')
    const client = publicClient(chainId)
    await checkCreateMultisigs(client, plans)
    if (await verifyCreatedMultisigs(client, plans, true)) return
    const safe = isSafeConnection(wagmiConfig)
    const hash = await setupTx.send({ ...setupRequest, label: 'Create project multisigs' }, {
      reviewedAccount: sender,
      recoveryNamespace: setupKey,
      reviewNotice: multisigReview(plans),
      reverify: async () => { sameSender(getAccount(wagmiConfig).address, sender); await checkCreateMultisigs(client, plans) },
    })
    if (!hash) throw new Error('Multisig creation has not completed. Continue when ready.')
    const executionHash = safe ? await waitForSafeExecutionHash(chainId, hash, { pollingIntervalMs: 5000, signal: AbortSignal.timeout(60_000) }) : hash
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
      if (!request) throw new Error('This launch can no longer be built here. Its saved transactions are still checked above.')
      const opened = loadLaunchSession()?.statuses[chainId]
      const sendable = () => {
        const current = loadLaunchSession()?.statuses[chainId]
        if (!clearRef.current) throw new Error('Check this network’s FUND deployment before deploying again.')
        if (!current || !['ready', 'reverted'].includes(current.phase) || JSON.stringify(current) !== JSON.stringify(opened)) throw new Error('This network’s launch changed. Review its progress before deploying.')
      }
      sendable()
      sameSender(getAccount(wagmiConfig).address, sender)
      await ensureMultisigs()
      const safe = isSafeConnection(wagmiConfig)
      const hash = await tx.send({ ...request, label }, {
        reviewedAccount: sender,
        recoveryNamespace: launchKey,
        // At the final boundary: recovery clear, and the saved launch exactly as it was when this send began.
        beforeWrite: async () => { sendable() },
        reverify: async () => {
          sameSender(getAccount(wagmiConfig).address, sender)
          await checkLaunchDeployment(publicClient(chainId), request)
          await verifyCreatedMultisigs(publicClient(chainId), plans)
        },
        reviewNotice: 'Creates only the FUND fundraising Juicebox. The owner can change future rules. INCOME, Owner success tokens, and asset withdrawals are not created by this transaction.',
      })
      if (!hash) return
      // The hold follows it from here; its settlement, not a receipt read now, confirms the launch.
      const previous = loadLaunchSession()?.statuses[chainId]
      if (previous && previous.phase !== 'pending') update({ phase: 'pending', hash, safe, walletReturned: true }, undefined, previous)
    } catch (cause) { setError(message(cause)) }
  }
  async function launchNow() {
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
      if (status.phase === 'pending' && status.hash) await launch.recover()
      else if (status.phase === 'ready' || status.phase === 'reverted') await launchNow()
      const phase = loadLaunchSession()?.statuses[chainId]?.phase
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
    {status.phase === 'confirmed' && <a className="create-primary" href={projectPath(chainId, status.projectId!)}>Open FUND project ↗</a>}
    {(status.phase === 'ready' || status.phase === 'reverted') && <button type="button" disabled={!request || tx.busy || setupTx.busy || tx.phase === 'review' || setupTx.phase === 'review' || verifying || sending || !launchClear || !setupClear} onClick={() => void launchNow()}>Review and deploy FUND</button>}
    {status.phase === 'pending' && status.hash && <button type="button" disabled={verifying || launch.recovering} onClick={() => void launch.recover()}>{verifying || launch.recovering ? 'Checking execution…' : 'Check confirmation'}</button>}
    <SavedAttemptNotice attempt={launch} />
    <SavedAttemptNotice attempt={setup} title="Create project multisigs" />
    {setupTx.phase === 'submitted' && <div role="status"><HeldNotice tx={setupHeld} /></div>}
    {tx.phase === 'submitted' && <div role="status"><HeldNotice tx={launchHeld} /></div>}
    {request && ['ready', 'reverted'].includes(status.phase) && <button type="button" disabled={tx.busy || tx.phase === 'review'} onClick={() => void publicClient(chainId).readContract({ address: v6Address('JBProjects', chainId as JBChainId), abi: jbProjectsAbi, functionName: 'creationFee' }).then(refreshFee).catch(cause => setError(message(cause)))}>Refresh deployment fee</button>}
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
  // A launch whose requests can't be built (its chain support changed, say) still mounts each chain, so its saved writes recover.
  let requests: FundTransaction[] = []
  let invalid = ''
  if (session) { try { requests = buildFundLaunch(session.input).requests } catch (cause) { invalid = message(cause) } }
  const requestOf = (chainId: number) => requests.find(request => request.chainId === chainId)
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
          {session.transport !== 'relayr' && session.transport !== 'intent' && session.input.chainIds.map(chainId => <LaunchChain key={`${session.input.salt}:${chainId}`} session={session} chainId={chainId} request={requestOf(chainId)} status={session.statuses[chainId]} runId={running && activeChain === chainId ? runId : 0} onStopped={stopDirect} onFeedback={directFeedback} update={(status, expectedPhase, expectedStatus) => setSession(updateLaunchStatus(session.input.salt, chainId, status, expectedPhase, expectedStatus))} refreshFee={fee => setSession(refreshLaunchCreationFee(session.input.salt, chainId, fee))} />)}
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
