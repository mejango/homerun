'use client'

import { useEffect, useRef, useState } from 'react'
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
import { FUND_LAUNCH_KEY, decodeLaunchSession, encodeLaunchSession, saveLaunch, updateLaunchStatus, refreshLaunchCreationFee, archiveLaunch, sameSender, type FundLaunchSession, type LaunchStatus } from '@/lib/fund-launch-session'
import { checkLaunchDeployment, verifyFundLaunch, verifyFailedFundLaunch } from '@/lib/fund-launch-verification'
import { publishFundProjectMetadata } from '@/lib/publish-fund-project-metadata'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { plannedNetworks } from '../../web/create-networks.mjs'
import { isSafeConnection, waitForSafeExecutionHash } from '@/lib/safe-connector'

const message = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.'
function publicClient(chainId: number): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId: chainId as JBChainId })
  if (!client) throw new Error('No RPC client is configured for this chain.')
  return client as PublicClient
}

function LaunchChain({ session, request, status, update, refreshFee }: {
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
  useEffect(() => {
    if (tx.phase === 'success' && tx.receipt && status.phase !== 'confirmed') void verify(status.hash ?? tx.receipt.transactionHash, status.safe ?? false, tx.receipt.transactionHash)
  // Verification is triggered only for a newly confirmed hash; persisted progress is explicit below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase, tx.receipt?.transactionHash])

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
        reviewNotice: 'Creates only the FUND fundraising Juicebox. The owner can change future rules. INCOME, operator success tokens, and asset withdrawals are not created by this transaction.',
      })
      if (hash) update({ phase: 'pending', hash, safe })
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

export function FundDeploy({ values }: { values?: CreateValues }) {
  const { address } = useWallet()
  const [session, setSession] = useState<FundLaunchSession | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  useEffect(() => {
    try { const saved = localStorage.getItem(FUND_LAUNCH_KEY); if (saved) setSession(decodeLaunchSession(saved)) }
    catch (cause) { setError(message(cause)) }
    setLoaded(true)
  }, [])

  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key !== FUND_LAUNCH_KEY) return; try { setSession(event.newValue ? decodeLaunchSession(event.newValue) : null) } catch (cause) { setError(message(cause)) } };
    window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync)
  }, [])

  const persist = (next: FundLaunchSession) => { setSession(saveLaunch(next)) }
  async function prepare() {
    if (!address || !values) return
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
      persist({ version: 1, name: values.name, input, statuses: Object.fromEntries(chainIds.map((id: number) => [id, { phase: 'ready' as const }])) })
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
  return <div className="contract-panel">
    <h2>Launch the FUND raise</h2>
    <p>Create the initial fundraising Juicebox. Contributions issue 10,000 FUND per US dollar. The initial cash-out tax is 10%; the owner can change future rules. Asset price and cash reserve remain modeling estimates, with no withdrawal allowance created here.</p>
    <p>INCOME and the operator’s success allocation are separate later actions. Selecting several networks links their FUND projects using the standard Juicebox bridges; each network requires its own confirmed deployment.</p>
    <WalletButton />
    {!session && <><div className="contract-actions">{values && <button type="button" disabled={!address || preparing || !loaded || !!error} onClick={() => void prepare()}>{preparing ? 'Preparing the deployment…' : 'Save metadata and prepare deployment'}</button>}{error && <button type="button" onClick={() => setError('')}>Try again</button>}</div><label>Restore a deployment record<input type="file" accept="application/json,.json" disabled={!loaded || preparing} onChange={event => { const file = event.target.files?.[0]; if (file) void restore(file); event.target.value = '' }} /></label></>}
    {session && <><p><strong>{session.name}</strong>. Owner <code>{session.input.owner}</code></p><p>The saved deployment uses the settings prepared here. Editing the form does not change an in-progress launch.</p><button type="button" onClick={download}>Download deployment record</button>
      {requests.map(request => <LaunchChain key={`${session.input.salt}:${request.chainId}`} session={session} request={request} status={session.statuses[request.chainId]} update={(status, expectedPhase) => setSession(updateLaunchStatus(session.input.salt, request.chainId, status, expectedPhase))} refreshFee={fee => setSession(refreshLaunchCreationFee(session.input.salt, request.chainId, fee))} />)}
      {Object.values(session.statuses).every(status => status.phase === 'confirmed') && <button type="button" onClick={() => { try { archiveLaunch(session.input.salt); setSession(null) } catch (cause) { setError(message(cause)) } }}>Finish this launch and start another</button>}
    </>}
    {(error || invalid) && <p role="alert">{error || invalid}</p>}
  </div>
}

export default function LiveCreate() { return <CreateFlow renderDeploy={values => <FundDeploy values={values} />} /> }
