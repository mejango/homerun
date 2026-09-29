'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { getAccount, getPublicClient, sendTransaction, switchChain, waitForTransactionReceipt } from '@wagmi/core'
import { erc2771ForwarderAbi, jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import {
  EnsureDeployedError, JBCenterRequestError, describeCenterRefusal, ensureDeployed, sponsorableChains, unsponsoredChains,
  type EnsureDeployedStep, type JBCenterDeploymentInput, type JBCenterIntent,
} from '@bananapus/nana-sdk-core/jbcenter'
import { jbCenterClient } from '@/lib/jbcenter-client'
import { wagmiConfig } from '@/providers/Providers'
import { useWallet } from '@/hooks/useWallet'
import { SAFE_CREATE_ABI } from '@/lib/create-multisig'
import {
  NO_LAUNCH_MESSAGE, RELAY_EXPIRED_MESSAGE, RELAY_UNREADABLE_MESSAGE, SAFES_UNREADABLE_MESSAGE,
  checkRelayRequest, readLaunchedProjectId, relayCostLabel, relaySetupSafes, watchDeployRefusal, type FundRelayRequest,
} from '@/lib/fund-intent'
import { holdDeployment, loadHeldDeployments, releaseDeployment } from '@/lib/relay-held'
import { requireTransactionReview, TransactionReviewCancelledError } from '@/lib/transaction-review'
import { displayChainName } from '@/lib/chainDisplay'
import { ChainIcon } from '@/components/ChainIcon'
import { projectPath } from '@/lib/urn'

const STEP_LABELS: Record<EnsureDeployedStep['status'], string> = {
  queued: 'Queued',
  sent: 'Sending…',
  confirmed: 'Created',
  failed: 'Failed',
  'self-paid': 'Created',
  'relay-paid': 'Created',
}

/** Neither a provider, a gateway nor Center's own request text reaches a reader. */
const DEPLOY_UNAVAILABLE = 'This deploy could not start right now. Try again shortly.'
const DEPLOY_FAILED = 'This project could not be deployed. Try again in a few minutes.'
const CONNECT_MESSAGE = 'Connect a wallet to deploy the networks you pay for.'
const WALLET_MESSAGE = 'The wallet did not send the transaction.'
const OVER_FEE_MESSAGE = 'The deploy asked for more than the creation fee.'
const NO_CLIENT_MESSAGE = 'No network connection is configured for this chain.'
const reverted = (chainId: number) => `The transaction reverted on ${displayChainName(chainId)}.`
const notRecorded = (chainId: number) =>
  `Your ${displayChainName(chainId)} transaction went through, but the project page has not picked it up yet. Try again to finish.`
/** Center keeps a failed chain as a failed chain: this page cannot send it again. */
const deployStopped = (chainId: number) =>
  `This project could not be created on ${displayChainName(chainId)}. It cannot be deployed from here; create it again.`

/** Only this app's own sentences are shown; everything else reads as one fixed sentence. */
function fixedSentence(cause: unknown, chainIds: readonly number[]): string {
  if (cause instanceof EnsureDeployedError) return DEPLOY_FAILED
  if (cause instanceof TransactionReviewCancelledError) return cause.message
  if (cause instanceof JBCenterRequestError || !(cause instanceof Error)) return DEPLOY_UNAVAILABLE
  const own = new Set<string>([
    CONNECT_MESSAGE, WALLET_MESSAGE, OVER_FEE_MESSAGE, NO_CLIENT_MESSAGE,
    RELAY_UNREADABLE_MESSAGE, RELAY_EXPIRED_MESSAGE, SAFES_UNREADABLE_MESSAGE, NO_LAUNCH_MESSAGE,
    ...chainIds.map(reverted),
  ])
  return own.has(cause.message) ? cause.message : DEPLOY_UNAVAILABLE
}

/** A wallet's own refusal text is never shown, whichever step the wallet refused. A closed review sent nothing and says so. */
async function fromWallet<T>(action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (cause) {
    throw cause instanceof TransactionReviewCancelledError ? cause : new Error(WALLET_MESSAGE)
  }
}

function RelayCost({ intentId, chainId }: { intentId: string; chainId: number }) {
  const cost = useQuery({
    queryKey: ['intent-relay-cost', intentId, chainId],
    // The relay route shares the deploy route's hourly bucket, so a label a
    // reader never acts on must not spend it again on every render.
    staleTime: 300_000,
    retry: 1,
    queryFn: async () => {
      const request = await jbCenterClient.requestRelay(intentId, chainId) as FundRelayRequest
      const client = getPublicClient(wagmiConfig, { chainId: chainId as JBChainId })
      if (!client) throw new Error('No RPC client is configured for this chain.')
      return request.gas * await client.getGasPrice() + request.value
    },
  })
  return <>{cost.data === undefined ? 'Gas + fee' : relayCostLabel(cost.data)}</>
}

export function DeployChains({ intent, heading, chainIds, onDeployed, onRunningChange }: {
  intent: JBCenterIntent
  heading: 'Deploy' | 'Deploy on more networks'
  /** The intent's own chain order, as the signed calls give it. */
  chainIds: readonly number[]
  onDeployed?: () => void
  onRunningChange?: (running: boolean) => void
}) {
  const { address, openSignIn } = useWallet()
  const deployed = new Map(intent.deployments.map(item => [item.chainId, item.projectId]))
  const remaining = chainIds.filter(chainId => !deployed.has(chainId))
  const free = sponsorableChains(remaining)
  const paid = unsponsoredChains(remaining)
  const [selected, setSelected] = useState<number[]>(free)
  const [deploying, setDeploying] = useState(false)
  const [stopped, setStopped] = useState<number[]>([])
  const [steps, setSteps] = useState<Record<number, EnsureDeployedStep['status']>>({})
  const [error, setError] = useState('')
  const run = useRef<AbortController | null>(null)
  /** A created project Center has not recorded: the next run records it alone. */
  const unrecorded = useRef(new Map<number, JBCenterDeploymentInput>())
  const [held, setHeld] = useState<number[]>([])
  const syncHeld = () => setHeld([...unrecorded.current.keys()])
  useEffect(() => () => run.current?.abort(), [])
  // A project this browser created and Center did not record outlives the page
  // that created it, so a reload records it instead of creating a second one.
  useEffect(() => {
    unrecorded.current = loadHeldDeployments(intent.id)
    const created = [...unrecorded.current.keys()]
    setHeld(created)
    if (created.length) setSelected(current => [...new Set([...current, ...created])])
  }, [intent.id])
  // A refetch can create a chain this panel still offers; the selection follows.
  const offered = remaining.join(',')
  useEffect(() => {
    const open = offered ? offered.split(',').map(Number) : []
    setSelected(current => current.filter(chainId => open.includes(chainId)))
  }, [offered])

  const toggle = (chainId: number) => setSelected(current => current.includes(chainId)
    ? current.filter(item => item !== chainId)
    : [...current, chainId])

  /** The visitor pays gas and the creation fee; Center's sponsor stays the forwarded sender. */
  async function relayPaid(request: FundRelayRequest) {
    // A project this wallet already created is recorded, never created twice.
    const created = unrecorded.current.get(request.chainId)
    if (created) return created
    const forwarded = checkRelayRequest(intent, request)
    const account = getAccount(wagmiConfig).address
    if (!account) throw new Error(CONNECT_MESSAGE)
    const client = getPublicClient(wagmiConfig, { chainId: request.chainId as JBChainId })
    if (!client) throw new Error(NO_CLIENT_MESSAGE)
    const fee = await client.readContract({
      address: v6Address('JBProjects', request.chainId as JBChainId), abi: jbProjectsAbi, functionName: 'creationFee',
    })
    if (request.value > fee) throw new Error(OVER_FEE_MESSAGE)
    // A Safe's address is fixed by its plan, so one that exists is the one this
    // project owns: creating it again reverts and stops the whole deploy.
    const safes = relaySetupSafes(intent, request.chainId)
    const existing = await Promise.all(safes.map(address => client.getCode({ address })))
    const setup = request.setup.filter((entry, index) => !existing[index] || existing[index] === '0x')
    await fromWallet(() => switchChain(wagmiConfig, { chainId: request.chainId as JBChainId }))
    await fromWallet(() => requireTransactionReview({
      kind: 'transaction',
      title: `Create this project on ${displayChainName(request.chainId)}`,
      description: 'You send these transactions and pay their gas and creation fee. The project keeps the same token and bridge addresses on every network.',
      confirmLabel: 'Continue to wallet',
      calls: [
        ...setup.map(entry => ({
          chainId: request.chainId, to: entry.to, data: entry.data, value: entry.value, from: account,
          abi: SAFE_CREATE_ABI, functionName: 'createProxyWithNonce',
          contractName: 'SafeProxyFactory',
          label: `Create this project’s multisig on ${displayChainName(request.chainId)}`,
        })),
        {
          chainId: request.chainId, to: request.to, data: request.data, value: request.value, from: account,
          abi: erc2771ForwarderAbi, functionName: 'execute', args: [forwarded],
          contractName: 'ERC2771Forwarder',
          label: `Create the FUND on ${displayChainName(request.chainId)}`,
        },
      ],
    }))
    for (const entry of setup) {
      const setupHash = await fromWallet(() => sendTransaction(wagmiConfig, {
        account, chainId: request.chainId as JBChainId, to: entry.to, data: entry.data, value: entry.value,
      }))
      const setupReceipt = await waitForTransactionReceipt(wagmiConfig, { chainId: request.chainId as JBChainId, hash: setupHash })
      if (setupReceipt.status !== 'success') throw new Error(reverted(request.chainId))
    }
    // The forwarder's own overhead sits on top of the gas the forwarded call is
    // capped at, so the wallet estimates what this transaction costs.
    const transactionHash = await fromWallet(() => sendTransaction(wagmiConfig, {
      account, chainId: request.chainId as JBChainId,
      to: request.to, data: request.data, value: request.value,
    }))
    const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: request.chainId as JBChainId, hash: transactionHash })
    if (receipt.status !== 'success') throw new Error(reverted(request.chainId))
    const deployment: JBCenterDeploymentInput = {
      chainId: request.chainId,
      projectId: readLaunchedProjectId(intent, request.chainId, receipt),
      transactionHash,
    }
    unrecorded.current.set(request.chainId, deployment)
    holdDeployment(intent.id, deployment)
    syncHeld()
    return deployment
  }

  async function deploy() {
    if (!selected.length) return
    // A chain whose project is already created needs no wallet: it needs Center.
    if (!address && selected.some(chainId => paid.includes(chainId) && !unrecorded.current.has(chainId))) {
      openSignIn(); setError(CONNECT_MESSAGE); return
    }
    setDeploying(true); onRunningChange?.(true); setError(''); setSteps({})
    const watcher = watchDeployRefusal(jbCenterClient)
    const controller = new AbortController()
    run.current?.abort()
    run.current = controller
    try {
      // A project this wallet already created only needs recording. Asking for
      // its relay again is refused, because the creation now exists onchain.
      const created = [...unrecorded.current].filter(([chainId]) => selected.includes(chainId))
      for (const [chainId, deployment] of created) {
        await watcher.client.recordDeployment(intent.id, deployment, { signal: controller.signal })
        unrecorded.current.delete(chainId)
        releaseDeployment(intent.id, chainId)
        syncHeld()
        setSteps(current => ({ ...current, [chainId]: 'relay-paid' }))
        onDeployed?.()
      }
      const rest = selected.filter(chainId => !created.some(([id]) => id === chainId))
      if (rest.length) await ensureDeployed({
        client: watcher.client,
        intent,
        chainIds: rest,
        relayPaid,
        timeoutMs: 600_000,
        signal: controller.signal,
        onStep: step => {
          if (step.status === 'relay-paid' && unrecorded.current.delete(step.chainId)) {
            releaseDeployment(intent.id, step.chainId)
            syncHeld()
          }
          setSteps(current => ({ ...current, [step.chainId]: step.status }))
          onDeployed?.()
        },
      })
      onDeployed?.()
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof EnsureDeployedError && cause.chainId !== undefined) {
        const failed = cause.chainId
        setStopped(current => [...current, failed])
        setSelected(current => current.filter(chainId => chainId !== failed))
        setError(deployStopped(failed))
        return
      }
      const [held] = [...unrecorded.current.keys()]
      const refused = describeCenterRefusal(watcher.refusal())
      setError(refused?.message ?? (held !== undefined ? notRecorded(held) : fixedSentence(cause, chainIds)))
    } finally {
      if (run.current === controller) run.current = null
      setDeploying(false); onRunningChange?.(false)
    }
  }

  const heldOnly = selected.length > 0 && selected.every(chainId => held.includes(chainId))
  return <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
    <h2 className="text-3xl">{heading}</h2>
    <p className="mt-2 text-sm text-smoke-600">{remaining.length ? 'Anyone can deploy this project as you designed it.' : 'Deployed on every network.'}</p>
    <ul className="m-0 mt-5 list-none divide-y divide-[#d8dece] border-y border-[#d8dece] p-0" aria-label="Networks">
      {chainIds.map(chainId => {
        const projectId = deployed.get(chainId)
        const step = steps[chainId]
        const name = <span className="flex items-center gap-2.5"><ChainIcon chainId={chainId} size={20} />{displayChainName(chainId)}</span>
        if (projectId) return <li key={chainId} className="flex min-h-12 items-center justify-between gap-3 py-2">
          <span className="flex items-center gap-3"><span className="w-4" aria-hidden="true">✓</span>{name}</span>
          <a className="text-sm underline" href={projectPath(chainId, projectId)} aria-label={`Deployed on ${displayChainName(chainId)}`}>View</a>
        </li>
        return <li key={chainId} className="flex min-h-12 items-center justify-between gap-3 py-2">
          <label className="flex cursor-pointer items-center gap-3">
            <input type="checkbox" className="size-4" value={chainId} checked={selected.includes(chainId)} disabled={deploying || stopped.includes(chainId)} onChange={() => toggle(chainId)} />
            {name}
          </label>
          <span className="text-right text-sm text-smoke-600" role={step ? 'status' : undefined}>
            {step ? STEP_LABELS[step] : held.includes(chainId) ? 'Created, finishing' : free.includes(chainId) ? 'Free' : <RelayCost intentId={intent.id} chainId={chainId} />}
          </span>
        </li>
      })}
    </ul>
    {remaining.length > 0 && <button type="button" className="btn-primary mt-5 min-h-11 px-5" disabled={deploying || !selected.length} onClick={() => void deploy()}>{deploying ? 'Deploying…' : heldOnly ? 'Finish deploy' : 'Deploy selected'}</button>}
    {error && <p role="alert" className="mt-4 text-sm leading-relaxed text-smoke-700">{error}</p>}
  </section>
}
