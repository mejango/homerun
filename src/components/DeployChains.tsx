'use client'

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { getAccount, getPublicClient, sendTransaction, switchChain, waitForTransactionReceipt } from '@wagmi/core'
import { erc2771ForwarderAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  EnsureDeployedError, JBCenterRequestError, describeCenterRefusal, ensureDeployed, sponsorableChains, unsponsoredChains,
  type EnsureDeployedStep, type JBCenterDeploymentInput, type JBCenterIntent,
} from '@bananapus/nana-sdk-core/jbcenter'
import { jbCenterClient } from '@/lib/jbcenter-client'
import { wagmiConfig } from '@/providers/Providers'
import { useWallet } from '@/hooks/useWallet'
import { SAFE_CREATE_ABI } from '@/lib/create-multisig'
import { checkRelayRequest, readLaunchedProjectId, relayCostLabel, watchDeployRefusal, type FundRelayRequest } from '@/lib/fund-intent'
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
/** Center keeps a failed chain as a failed chain: this page cannot send it again. */
const deployStopped = (chainId: number) =>
  `Juicebox Center could not create this project on ${displayChainName(chainId)}. It cannot be deployed from here; create it again.`

function RelayCost({ intentId, chainId }: { intentId: string; chainId: number }) {
  const cost = useQuery({
    queryKey: ['intent-relay-cost', intentId, chainId],
    staleTime: 60_000,
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
  const [stopped, setStopped] = useState(false)
  const [steps, setSteps] = useState<string[]>([])
  const [error, setError] = useState('')
  const run = useRef<AbortController | null>(null)
  useEffect(() => () => run.current?.abort(), [])

  const toggle = (chainId: number) => setSelected(current => current.includes(chainId)
    ? current.filter(item => item !== chainId)
    : [...current, chainId])

  /** The visitor pays gas and the creation fee; Center's sponsor stays the forwarded sender. */
  async function relayPaid(request: FundRelayRequest) {
    const forwarded = checkRelayRequest(intent, request)
    const account = getAccount(wagmiConfig).address
    if (!account) throw new Error(CONNECT_MESSAGE)
    await switchChain(wagmiConfig, { chainId: request.chainId as JBChainId })
    await requireTransactionReview({
      kind: 'transaction',
      title: `Create this project on ${displayChainName(request.chainId)}`,
      description: 'You send these transactions and pay their gas and creation fee. Juicebox Center’s sponsor stays the sender of the creation itself, so this project keeps the same token and bridge addresses on every network.',
      confirmLabel: 'Continue to wallet',
      calls: [
        ...request.setup.map(entry => ({
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
    })
    for (const entry of request.setup) {
      const setupHash = await sendTransaction(wagmiConfig, {
        account, chainId: request.chainId as JBChainId, to: entry.to, data: entry.data, value: entry.value,
      })
      const setupReceipt = await waitForTransactionReceipt(wagmiConfig, { chainId: request.chainId as JBChainId, hash: setupHash })
      if (setupReceipt.status !== 'success') throw new Error('The multisig creation reverted. Nothing else was sent.')
    }
    const transactionHash = await sendTransaction(wagmiConfig, {
      account, chainId: request.chainId as JBChainId,
      to: request.to, data: request.data, value: request.value, gas: request.gas,
    })
    const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: request.chainId as JBChainId, hash: transactionHash })
    const deployment: JBCenterDeploymentInput = {
      chainId: request.chainId,
      projectId: readLaunchedProjectId(intent, request.chainId, receipt),
      transactionHash,
    }
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
          setSteps(current => [...current, `${displayChainName(step.chainId)}: ${STEP_LABELS[step.status]}`])
          onDeployed?.()
        },
      })
      onDeployed?.()
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof EnsureDeployedError && cause.chainId !== undefined) {
        setStopped(true); setError(deployStopped(cause.chainId)); return
      }
      const refused = describeCenterRefusal(watcher.refusal())
      const own = cause instanceof EnsureDeployedError ? DEPLOY_FAILED
        : cause instanceof JBCenterRequestError ? DEPLOY_UNAVAILABLE
        : cause instanceof Error && cause.message ? cause.message : DEPLOY_UNAVAILABLE
      setError(refused?.message ?? own)
    } finally {
      if (run.current === controller) run.current = null
      setDeploying(false); onRunningChange?.(false)
    }
  }

  return <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
    <h2 className="mb-5 text-3xl">{heading}</h2>
    <p>Juicebox Center pays for the networks it sponsors. You pay the gas and the creation fee for the others. Anyone can deploy this project, and its terms cannot change.</p>
    <ul className="m-0 mt-5 grid list-none gap-2 p-0">
      {chainIds.map(chainId => {
        const projectId = deployed.get(chainId)
        if (projectId) return <li key={chainId} className="text-sm">
          <a className="underline" href={`/project/${chainId}/${projectId}`}>Deployed on {displayChainName(chainId)}</a>
        </li>
        return <li key={chainId} className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" value={chainId} checked={selected.includes(chainId)} disabled={deploying || stopped} onChange={() => toggle(chainId)} />
            {displayChainName(chainId)}
          </label>
          {free.includes(chainId) ? <span className="text-sm">free</span> : <RelayCost intentId={intent.id} chainId={chainId} />}
        </li>
      })}
    </ul>
    {remaining.length > 0 && <button type="button" className="btn-primary mt-5" disabled={deploying || stopped || !selected.length} onClick={() => void deploy()}>{deploying ? 'Deploying…' : 'Deploy selected'}</button>}
    {steps.length > 0 && <ul className="m-0 mt-5 grid list-none gap-2 p-0 text-sm" aria-label="Deployment progress">{steps.map((step, index) => <li key={`${step}:${index}`} role="status">{step}</li>)}</ul>}
    {error && <p role="alert" className="mt-5 text-sm">{error}</p>}
  </section>
}
