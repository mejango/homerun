'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getPublicClient, getAccount } from '@wagmi/core'
import { jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { getAddress, toHex, type Hex, type PublicClient } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { useSafeTx } from '@/hooks/useSafeTx'
import { wagmiConfig } from '@/providers/Providers'
import { WalletButton } from './WalletButton'
import CreateFlow, { type CreateValues } from './CreateFlow'
import { buildFundLaunch, type FundTransaction } from '@/lib/fund-contracts'
import { FUND_LAUNCH_KEY, discardUnsignedLaunch, decodeLaunchSession, encodeLaunchSession, saveLaunch, updateLaunchStatus, refreshLaunchCreationFee, archiveLaunch, loadLaunchSession, sameSender, type FundLaunchSession, type LaunchStatus } from '@/lib/fund-launch-session'
import { checkLaunchDeployment, verifyFundLaunch, verifyFailedFundLaunch } from '@/lib/fund-launch-verification'
import { publishFundProjectMetadata } from '@/lib/publish-fund-project-metadata'
import { runRelayrLaunch } from '@/lib/fund-launch-relayr'
import { displayChainName } from '@/lib/chainDisplay'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { plannedNetworks } from '../../web/create-networks.mjs'
import { isSafeConnection, waitForSafeExecutionHash } from '@/lib/safe-connector'

const message = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.'
function publicClient(chainId: number): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId: chainId as JBChainId })
  if (!client) throw new Error('No RPC client is configured for this chain.')
  return client as PublicClient
}

function LaunchChain({ session, request, status, update, refreshFee, runId = 0, onStopped }: {
  runId?: number; onStopped?: () => void
  session: FundLaunchSession; request: FundTransaction; status: LaunchStatus; update: (status: LaunchStatus, expectedPhase?: LaunchStatus['phase']) => void; refreshFee: (fee: bigint) => void
}) {
  const tx = useSafeTx(request.chainId)
  const [error, setError] = useState('')
  const [recoveryHash, setRecoveryHash] = useState('')
  const [recoverySafe, setRecoverySafe] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const verifyLock = useRef(false)
  const chain = SUPPORTED_CHAINS.find(value => value.id === request.chainId)!
  const verify = async (hash: Hex, safe: boolean, knownExecutionHash?: Hex) => {
    if (verifyLock.current) return
    verifyLock.current = true; setVerifying(true); setError('')
    try {
      const client = publicClient(request.chainId)
      const executionHash = knownExecutionHash ?? (safe ? await waitForSafeExecutionHash(request.chainId, hash, { pollingIntervalMs: 5000, signal: AbortSignal.timeout(60_000) }) : hash)
      const receipt = await client.getTransactionReceipt({ hash: executionHash })
      if (receipt.status === 'reverted') { await verifyFailedFundLaunch(client, request, session.input, receipt, safe); update({ phase: 'reverted', hash, executionHash, safe }); return }
      const projectId = await verifyFundLaunch(client, request, session.input, receipt, safe)
      update({ phase: 'confirmed', hash, executionHash, safe, projectId: projectId.toString() })
    } catch (cause) { setError(`Confirmation is unresolved. Keep this launch saved and check again. ${message(cause)}`) }
    finally { verifyLock.current = false; setVerifying(false) }
  }

  async function submitLaunch() {
    setError('')
    let submissionAttempted = false
    try {
      sameSender(getAccount(wagmiConfig).address, session.input.sender)
      const safe = isSafeConnection(wagmiConfig)
      const hash = await tx.send({ ...request, label: `Launch ${session.name} FUND on ${chain.name}` }, {
        reverify: async () => {
          sameSender(getAccount(wagmiConfig).address, session.input.sender)
          await checkLaunchDeployment(publicClient(request.chainId), request)
        },
        beforeWrite: () => {
          update({ phase: 'signing', safe }, status.phase)
          submissionAttempted = true
        },
        onWriteRejected: () => {
          update(status, 'signing')
          submissionAttempted = false
        },
        reviewNotice: 'Creates only the FUND fundraising Juicebox. The owner can change future rules. INCOME, Owner success tokens, and asset withdrawals are not created by this transaction.',
      })
      if (hash) { update({ phase: 'pending', hash, safe }); await verify(hash, safe) }
      else if (submissionAttempted) setError('The wallet did not return a transaction hash. Check your wallet history before trying another deployment.')
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
      if (status.phase === 'pending' && status.hash) await verify(status.hash, status.safe ?? false, status.executionHash)
      else if (status.phase === 'ready' || status.phase === 'reverted') await launch()
      if (loadLaunchSession()?.statuses[request.chainId]?.phase !== 'confirmed') onStopped?.()
    })().catch(() => onStopped?.())
  // One explicit Create/Continue gesture starts each destination once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])
  return <section className="contract-panel">
    <h3>{chain.name}</h3>
    <p role="status">{status.phase === 'confirmed' ? 'FUND deployment verified onchain.' : status.phase === 'pending' ? status.safe ? 'Safe proposal awaiting execution.' : 'Transaction submitted; confirmation pending.' : status.phase === 'signing' ? 'Deployment review or wallet confirmation in progress.' : status.phase === 'reverted' ? 'The deployment reverted. No project was created by this transaction.' : 'Ready for transaction review.'}</p>
    {status.hash && <p><a target="_blank" rel="noreferrer" href={status.executionHash || !status.safe ? `${chain.blockExplorers.default.url}/tx/${status.executionHash ?? status.hash}` : 'https://app.safe.global/transactions/queue'}>{status.safe && !status.executionHash ? 'View Safe queue' : 'View transaction'}: {status.hash.slice(0, 12)}…</a></p>}
    {status.phase === 'confirmed' && <a className="create-primary" href={`/project/${request.chainId}/${status.projectId}`}>Open FUND project ↗</a>}
    {(status.phase === 'ready' || status.phase === 'reverted') && <button type="button" disabled={tx.busy || tx.phase === 'review' || verifying || Object.values(session.statuses).some(row => row.phase === 'signing')} onClick={() => void launch()}>Review and deploy FUND</button>}
    {status.phase === 'pending' && status.hash && <button type="button" disabled={verifying} onClick={() => void verify(status.hash!, status.safe ?? false, status.executionHash)}>{verifying ? 'Checking execution…' : 'Check confirmation'}</button>}
    {status.phase === 'signing' && !tx.busy && <><p>This launch stopped before a transaction hash was saved. Check your wallet history before continuing.</p><label htmlFor={`recover-${request.chainId}`}>Submitted transaction hash (executed transaction)</label><input id={`recover-${request.chainId}`} value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} /><button type="button" disabled={!/^0x[\da-f]{64}$/i.test(recoveryHash) || verifying} onClick={() => { update({ phase: 'pending', hash: recoveryHash as Hex, executionHash: recoveryHash as Hex, safe: recoverySafe }); void verify(recoveryHash as Hex, recoverySafe, recoveryHash as Hex) }}>Verify this transaction</button><label><input type="checkbox" checked={recoverySafe} onChange={event => setRecoverySafe(event.target.checked)} /> This was executed by my Safe</label><button type="button" onClick={() => { tx.reset(); update({ phase: 'ready' }, 'signing') }}>I cancelled without submitting</button></>}
    {['ready', 'reverted'].includes(status.phase) && <button type="button" disabled={tx.busy || tx.phase === 'review'} onClick={() => void publicClient(request.chainId).readContract({ address: v6Address('JBProjects', request.chainId as JBChainId), abi: jbProjectsAbi, functionName: 'creationFee' }).then(refreshFee).catch(cause => setError(message(cause)))}>Refresh deployment fee</button>}
    {(error || tx.error) && <p role="alert">{error || tx.error}</p>}
  </section>
}

export function FundDeploy({ values, onLockChange }: { values?: CreateValues; onLockChange?: (chains: readonly number[] | null) => void }) {
  const router = useRouter()
  const { address } = useWallet()
  const [session, setSession] = useState<FundLaunchSession | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [runId, setRunId] = useState(0)
  const busyRef = useRef(false)
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
    if (busyRef.current) return
    busyRef.current = true; setRunning(true); setError('')
    let directStarted = false
    try {
      sameSender(getAccount(wagmiConfig).address, next.input.sender)
      if (!next.transport && next.input.chainIds.length > 1 && !isSafeConnection(wagmiConfig) && Object.values(next.statuses).every(status => status.phase === 'ready')) {
        next = persist({ ...next, transport: 'relayr' })
      }
      if (next.transport === 'relayr') {
        await runRelayrLaunch({ session: next, account: next.input.sender, onStatus: () => setSession(loadLaunchSession()), onProgress: setProgress })
        setProgress('Your project is created on every selected chain.')
      } else {
        setProgress('Confirm the deployment in your wallet.')
        directStarted = true
        setRunId(value => value + 1)
        return
      }
    } catch (cause) { setError(message(cause)) }
    finally { if (!directStarted) { busyRef.current = false; setRunning(false); setSession(loadLaunchSession()) } }
  }
  function stopDirect() { busyRef.current = false; setRunning(false) }
  async function prepare() {
    if (!address || !values || preparing || busyRef.current) return
    setPreparing(true); setError('')
    try {
      if (localStorage.getItem(FUND_LAUNCH_KEY)) throw new Error('A saved launch already exists. Reload to resume it.')
      const chainIds = plannedNetworks(values).map((chain: { chainId: number }) => chain.chainId)
      const owner = getAddress(values.ownerWallet)
      const sender = address
      const pin = await publishFundProjectMetadata(values)
      const fees = await Promise.all(chainIds.map(async (id: number) => {
        const client = publicClient(id)
        const fee = await client.readContract({ address: v6Address('JBProjects', id as JBChainId), abi: jbProjectsAbi, functionName: 'creationFee' })
        const block = await client.getBlock()
        return { id, fee, timestamp: Number(block.timestamp) }
      }))
      sameSender(getAccount(wagmiConfig).address, sender)
      const input = {
        owner, sender, chainIds, projectUri: `ipfs://${pin.cid}`,
        salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
        mustStartAtOrAfter: chainIds.length > 1 ? Math.max(...fees.map(row => row.timestamp)) : 0,
        creationFees: Object.fromEntries(fees.map(row => [row.id, row.fee])),
      }
      const built = buildFundLaunch(input)
      await Promise.all(built.requests.map(request => checkLaunchDeployment(publicClient(request.chainId), request)))
      const next = persist({ version: 1, name: values.name, input, transport: chainIds.length > 1 && !isSafeConnection(wagmiConfig) ? 'relayr' : 'direct', statuses: Object.fromEntries(chainIds.map((id: number) => [id, { phase: 'ready' as const }])) })
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
  async function restore(file: File) {
    setError('')
    try {
      if (file.size > 1_000_000) throw new Error('The deployment record is too large.')
      if (localStorage.getItem(FUND_LAUNCH_KEY)) throw new Error('A saved launch already exists. Reload to resume it.')
      const imported = decodeLaunchSession(await file.text())
      // Imported progress is a recovery hint. Re-verify claimed confirmations
      // against their exact onchain transaction before showing a created project.
      const statuses = Object.fromEntries(Object.entries(imported.statuses).map(([chainId, status]) => [chainId, status.phase === 'confirmed'
        ? { phase: 'pending' as const, hash: status.hash, safe: status.safe, executionHash: status.executionHash }
        : status]))
      persist({ ...imported, statuses })
    } catch (cause) { setError(message(cause)) }
  }
  const complete = !!session && Object.values(session.statuses).every(status => status.phase === 'confirmed')
  const signingChain = running ? session?.input.chainIds.find(id => session.statuses[id].phase === 'signing') : undefined
  const activeChain = session?.input.chainIds.find(id => session.statuses[id].phase !== 'confirmed')
  useEffect(() => { if (complete) { busyRef.current = false; setRunning(false); router.replace('/create/success') } }, [complete, router])
  return <div className="fund-launch">
    <h2 className="text-xl">Create your project</h2>
    <p>Create the FUND raise on your selected chains. INCOME and the Owner’s success allocation are separate later actions.</p>
    {!address && <WalletButton />}
    {selectionChanged && <p role="alert">This launch already has wallet authorizations for {session!.input.chainIds.map(displayChainName).join(', ')}. Continue completes that saved launch; changing the selection above cannot replace signed requests.</p>}
    {!session ? <button type="button" className="create-primary" disabled={!address || preparing || !loaded || !!error} onClick={() => void prepare()}>{preparing ? 'Preparing your project…' : 'Create project'}</button>
      : <>
        {signingChain !== undefined && <div className="fund-launch-action" role="status"><strong>Action needed in your wallet</strong><span>Open your wallet and confirm the request for {displayChainName(signingChain)}.</span></div>}
        <ul className="fund-launch-progress" aria-label="Deployment progress">{session.input.chainIds.map(id => {
          const phase = session.statuses[id].phase
          const needsWallet = signingChain === id
          const label = ({ ready: running ? 'Queued' : 'Not started', signing: needsWallet ? 'Your turn · Wallet' : 'Resume to check', authorized: '✓ Signed', pending: session.statuses[id].safe ? 'Awaiting Safe execution' : 'Deploying…', confirmed: '✓ Created', reverted: 'Retry needed', unresolved: 'Checking…', expired: 'New signature needed' })[phase]
          return <li key={id} data-action={needsWallet || undefined}><span>{displayChainName(id)}</span><span className="fund-launch-badge" data-state={needsWallet ? 'action' : phase}>{label}</span></li>
        })}</ul>
        {progress && <p role="status">{progress}</p>}
        {!complete && <button type="button" className="create-primary" disabled={running || preparing || !address} onClick={() => void run(session)}>{running ? 'Creating your project…' : 'Continue creation'}</button>}
        {complete && <a className="create-primary" href={`/project/${session.input.chainIds[0]}/${session.statuses[session.input.chainIds[0]].projectId}`}>Open project ↗</a>}
      </>}
    {(error || invalid) && <p role="alert">{error || invalid}</p>}
    {!session && error && <button type="button" onClick={() => setError('')}>Try again</button>}
    <details className="fund-launch-recovery"><summary>Deployment recovery</summary>
      {!session ? <label>Restore a deployment record<input type="file" accept="application/json,.json" disabled={!loaded || preparing} onChange={event => { const file = event.target.files?.[0]; if (file) void restore(file); event.target.value = '' }} /></label>
        : <><p>{session.name}. Owner <code>{session.input.owner}</code>. This saved launch retains its original settings.</p><button type="button" onClick={download}>Download deployment record</button>
          {session.transport !== 'relayr' && requests.map(request => <LaunchChain key={`${session.input.salt}:${request.chainId}`} session={session} request={request} status={session.statuses[request.chainId]} runId={running && activeChain === request.chainId ? runId : 0} onStopped={stopDirect} update={(status, expectedPhase) => setSession(updateLaunchStatus(session.input.salt, request.chainId, status, expectedPhase))} refreshFee={fee => setSession(refreshLaunchCreationFee(session.input.salt, request.chainId, fee))} />)}
          {complete && <button type="button" onClick={() => { try { archiveLaunch(session.input.salt); setSession(null); setProgress('') } catch (cause) { setError(message(cause)) } }}>Finish this launch and start another</button>}
        </>}
    </details>
  </div>
}

export default function LiveCreate() {
  const [lockedChains, setLockedChains] = useState<readonly number[] | null>(null)
  return <CreateFlow lockedChains={lockedChains} renderDeploy={values => <FundDeploy values={values} onLockChange={setLockedChains} />} />
}
