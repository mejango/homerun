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
import { requireTransactionReview } from '@/lib/transaction-review'
import { displayChainName } from '@/lib/chainDisplay'

const STEP_LABELS: Record<EnsureDeployedStep['status'], string> = {
  queued: 'queued at Juicebox Center',
  sent: 'sent onchain',
  confirmed: 'created',
  failed: 'could not be created',
  'self-paid': 'recorded',
  'relay-paid': 'recorded',
}

/** Neither a provider, a gateway nor Center's own request text reaches a reader. */
const DEPLOY_UNAVAILABLE = 'Center could not start this deploy right now. Try again shortly.'
const DEPLOY_FAILED = 'Juicebox Center could not deploy this project. Try again in a few minutes.'
const CONNECT_MESSAGE = 'Connect a wallet to deploy the networks you pay for.'
const WALLET_MESSAGE = 'The wallet did not send the transaction.'
const OVER_FEE_MESSAGE = 'Center asked for more than the creation fee.'
const NO_CLIENT_MESSAGE = 'No network connection is configured for this chain.'
const reverted = (chainId: number) => `The transaction reverted on ${displayChainName(chainId)}.`
const notRecorded = (chainId: number) =>
  `The project is created on ${displayChainName(chainId)}, but Center has not recorded it yet. Press Deploy selected again to record it.`
/** Center keeps a failed chain as a failed chain: this page cannot send it again. */
const deployStopped = (chainId: number) =>
  `Juicebox Center could not create this project on ${displayChainName(chainId)}. It cannot be deployed from here; create it again.`

/** Only this app's own sentences are shown; everything else reads as one fixed sentence. */
function fixedSentence(cause: unknown, chainIds: readonly number[]): string {
  if (cause instanceof EnsureDeployedError) return DEPLOY_FAILED
  if (cause instanceof JBCenterRequestError || !(cause instanceof Error)) return DEPLOY_UNAVAILABLE
  const own = new Set<string>([
    CONNECT_MESSAGE, WALLET_MESSAGE, OVER_FEE_MESSAGE, NO_CLIENT_MESSAGE,
    RELAY_UNREADABLE_MESSAGE, RELAY_EXPIRED_MESSAGE, SAFES_UNREADABLE_MESSAGE, NO_LAUNCH_MESSAGE,
    ...chainIds.map(reverted),
  ])
  return own.has(cause.message) ? cause.message : DEPLOY_UNAVAILABLE
}

/** A wallet's own refusal text is never shown, whichever step the wallet refused. */
async function fromWallet<T>(action: () => Promise<T>): Promise<T> {
  try { return await action() } catch { throw new Error(WALLET_MESSAGE) }
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
  return <span className="text-sm">{cost.data === undefined ? 'costs gas' : relayCostLabel(cost.data)}</span>
}

export function DeployChains({ intent, heading, chainIds, onDeployed, onRunningChange }: {
  intent: JBCenterIntent
  heading: 'Deploy' | 'Also deploy on'
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
  const [steps, setSteps] = useState<string[]>([])
  const [error, setError] = useState('')
  const run = useRef<AbortController | null>(null)
  /** A created project Center has not recorded: the next run records it alone. */
  const unrecorded = useRef(new Map<number, JBCenterDeploymentInput>())
  useEffect(() => () => run.current?.abort(), [])
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
      description: 'You send these transactions and pay their gas and creation fee. Juicebox Center’s sponsor stays the sender of the creation itself, so this project keeps the same token and bridge addresses on every network.',
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
    return deployment
  }

  async function deploy() {
    if (!selected.length) return
    if (!address && selected.some(chainId => paid.includes(chainId))) { openSignIn(); setError(CONNECT_MESSAGE); return }
    setDeploying(true); onRunningChange?.(true); setError(''); setSteps([])
    const watcher = watchDeployRefusal(jbCenterClient)
    const controller = new AbortController()
    run.current?.abort()
    run.current = controller
    try {
      await ensureDeployed({
        client: watcher.client,
        intent,
        chainIds: [...selected],
        relayPaid,
        timeoutMs: 600_000,
        signal: controller.signal,
        onStep: step => {
          if (step.status === 'relay-paid') unrecorded.current.delete(step.chainId)
          setSteps(current => [...current, `${displayChainName(step.chainId)}: ${STEP_LABELS[step.status]}`])
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

  return <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
    <h2 className="mb-5 text-3xl">{heading === 'Also deploy on' && remaining.length ? `${heading} ${remaining.map(displayChainName).join(', ')}` : heading}</h2>
    <p>Juicebox Center pays for the networks it sponsors. You pay the gas and the creation fee for the others. Anyone can deploy this project, and its terms cannot change.</p>
    <ul className="m-0 mt-5 grid list-none gap-2 p-0">
      {chainIds.map(chainId => {
        const projectId = deployed.get(chainId)
        if (projectId) return <li key={chainId} className="text-sm">
          <a className="underline" href={`/project/${chainId}/${projectId}`}>Deployed on {displayChainName(chainId)}</a>
        </li>
        return <li key={chainId} className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" value={chainId} checked={selected.includes(chainId)} disabled={deploying || stopped.includes(chainId)} onChange={() => toggle(chainId)} />
            {displayChainName(chainId)}
          </label>
          {free.includes(chainId) ? <span className="text-sm">free</span> : <RelayCost intentId={intent.id} chainId={chainId} />}
        </li>
      })}
    </ul>
    {remaining.length > 0 && <button type="button" className="btn-primary mt-5" disabled={deploying || !selected.length} onClick={() => void deploy()}>{deploying ? 'Deploying…' : 'Deploy selected'}</button>}
    {steps.length > 0 && <ul className="m-0 mt-5 grid list-none gap-2 p-0 text-sm" aria-label="Deployment progress">{steps.map((step, index) => <li key={`${step}:${index}`} role="status">{step}</li>)}</ul>}
    {error && <p role="alert" className="mt-5 text-sm">{error}</p>}
  </section>
}
