'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getAccount, getPublicClient, signMessage } from '@wagmi/core'
import { jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { isAddressEqual, toHex, type PublicClient } from 'viem'
import { JBCenterRequestError, describeCenterRefusal, intentPath } from '@bananapus/nana-sdk-core/jbcenter'
import { useWallet } from '@/hooks/useWallet'
import { wagmiConfig } from '@/providers/Providers'
import { WalletButton } from '@/components/WalletButton'
import { IntentProjectView } from '@/components/IntentProjectView'
import { jbCenterClient } from '@/lib/jbcenter-client'
import { loadCreateValues } from '@/lib/create-preview'
import { displayChainName } from '@/lib/chainDisplay'
import { isSafeConnection } from '@/lib/safe-connector'
import { SAFE_CREATE_ABI, SAFE_SINGLETON, multisigCreationData, multisigInitializer, multisigReview, resolveCreateMultisigs } from '@/lib/create-multisig'
import { buildFundLaunch } from '@/lib/fund-contracts'
import { buildFundIntent, fundIntentEligibleChains, publishFundIntent, UNSUPPORTED_CHAINS_MESSAGE } from '@/lib/fund-intent'
import { FUND_LAUNCH_KEY, decodeLaunchSession, discardUnsignedLaunch, sameSender, saveLaunch } from '@/lib/fund-launch-session'
import { checkLaunchDeployment } from '@/lib/fund-launch-verification'
import { publishFundProjectMetadata } from '@/lib/publish-fund-project-metadata'
import { requireTransactionReview } from '@/lib/transaction-review'
import type { CreateValues } from '@/components/CreateFlow'
import { plannedNetworks } from '../../web/create-networks.mjs'

const NO_SETUP = 'This project’s setup could not be read in this browser.'
const BANNER = 'Preview. Nothing is created yet.'
const WALLET_NEEDS_TRANSACTION_MESSAGE = 'Juicebox Center accepts a signature from a wallet address only. Connect a different wallet, or create with a transaction.'

const message = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.'
/** Center's own wording for a refusal, then this app's, so no server text reaches the page. */
const failure = (error: unknown) => {
  const refusal = describeCenterRefusal(error)
  if (refusal) return refusal.message
  if (!(error instanceof JBCenterRequestError)) return message(error)
  return error.code === 'publish_limit' || error.status === 429
    ? 'Center’s publish limit is reached. Try again later.'
    : 'Center could not accept this project right now. Try again shortly.'
}
/** Center recovers the publisher from the signature, so a passkey or Safe connection cannot publish. */
function walletCanPublish(): boolean {
  return getAccount(wagmiConfig).connector?.id !== 'juicebox-center' && !isSafeConnection(wagmiConfig)
}
function publicClient(chainId: number): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId: chainId as JBChainId })
  if (!client) throw new Error('No RPC client is configured for this chain.')
  return client as PublicClient
}

export default function CreatePreview() {
  const router = useRouter()
  const { address, openSignIn } = useWallet()
  const [values, setValues] = useState<CreateValues | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { setValues(loadCreateValues()); setLoaded(true) }, [])

  async function create(values: CreateValues) {
    if (publishing) return
    if (!address) { openSignIn(); return }
    setPublishing(true); setError(''); setProgress('')
    try {
      // Re-read the wallet here: the connection can change between the render
      // that offered this path and the click that takes it. Everything this
      // publication needs is checked before a prepared plan is let go, so a
      // refused click leaves that plan where it was.
      if (!walletCanPublish()) throw new Error(WALLET_NEEDS_TRANSACTION_MESSAGE)
      const chainIds = plannedNetworks(values).map((chain: { chainId: number }) => chain.chainId)
      if (!fundIntentEligibleChains(chainIds)) throw new Error(UNSUPPORTED_CHAINS_MESSAGE)
      // A saved plan keeps the transport it was saved with. Publish from a record
      // of its own, and only once an unauthorized plan has been let go.
      const saved = localStorage.getItem(FUND_LAUNCH_KEY)
      if (saved && !discardUnsignedLaunch(decodeLaunchSession(saved).input.salt)) throw new Error('A saved launch already exists. Reload to resume it.')
      const sender = address
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)))
      const resolved = await resolveCreateMultisigs(values, chainIds.map(publicClient), salt)
      setProgress('Saving your project details…')
      const pin = await publishFundProjectMetadata(resolved.values)
      const fees = await Promise.all(chainIds.map(async (id: number) => {
        const client = publicClient(id)
        const fee = await client.readContract({ address: v6Address('JBProjects', id as JBChainId), abi: jbProjectsAbi, functionName: 'creationFee' })
        const block = await client.getBlock()
        return { id, fee, timestamp: Number(block.timestamp) }
      }))
      sameSender(getAccount(wagmiConfig).address, sender)
      const input = {
        owner: resolved.owner, sender, chainIds, projectUri: `ipfs://${pin.cid}`,
        tokenName: resolved.values.fundTokenName, ticker: resolved.values.fundTicker,
        salt, multisigs: resolved.plans, operator: resolved.operator,
        mustStartAtOrAfter: chainIds.length > 1 ? Math.max(...fees.map(row => row.timestamp)) : 0,
        creationFees: Object.fromEntries(fees.map(row => [row.id, row.fee])),
      }
      const built = buildFundLaunch(input)
      await Promise.all(built.requests.map(request => checkLaunchDeployment(publicClient(request.chainId), request)))
      const intent = buildFundIntent(input, values.name)
      setProgress('')
      const plans = resolved.plans
      await requireTransactionReview({
        kind: 'authorization',
        title: 'Create your project',
        description: plans.length
          ? `Your signature publishes these exact creations to Juicebox Center. Center’s sponsor creates your multisigs and the project on every selected chain the first time it is used. You send no transaction and pay no creation fee here.\n${multisigReview(plans)}`
          : 'Your signature publishes these exact project creations to Juicebox Center. Center’s sponsor sends them on every selected chain the first time the project is used. You send no transaction and pay no creation fee here.',
        confirmLabel: 'Continue to wallet',
        calls: intent.deploymentCalls.map(call => {
          // Center's sponsor is the sender of every one of these calls, and
          // HomerunDeployer scopes its salt to that sender, so no `from` is shown.
          const plan = plans.find(item => call.data === multisigCreationData(item))
          if (plan) return {
            chainId: call.chainId, to: call.to, data: call.data,
            abi: SAFE_CREATE_ABI, functionName: 'createProxyWithNonce',
            args: [SAFE_SINGLETON, multisigInitializer(plan), BigInt(plan.saltNonce)],
            label: `Center’s sponsor creates the ${plan.role === 'owner' ? 'Owner' : 'Operator'} multisig on ${displayChainName(call.chainId)}`,
            contractName: 'SafeProxyFactory',
          }
          const request = built.requests.find(item => item.chainId === call.chainId)
          if (!request || !isAddressEqual(call.to, request.address)) throw new Error('The reviewed calls do not match the launch plan.')
          return {
            chainId: call.chainId, to: call.to, data: call.data,
            abi: request.abi, functionName: request.functionName, args: request.args,
            label: `Center’s sponsor creates the FUND on ${displayChainName(call.chainId)}`, contractName: 'HomerunDeployer',
          }
        }),
        // Center takes a plain signed message, not typed data, so the review
        // reads the envelope that message commits to.
        authorization: { kind: 'message', type: 'Juicebox Center project intent', format: intent.format, deploymentVersion: intent.deploymentVersion, chainIds: intent.chainIds, jb: intent.jb },
      })
      setProgress('Sign the publication message in your wallet.')
      sameSender(getAccount(wagmiConfig).address, sender)
      const published = await publishFundIntent({
        client: jbCenterClient, input, name: values.name, publisher: sender,
        sign: publicationMessage => signMessage(wagmiConfig, { account: sender, message: publicationMessage }),
      })
      try {
        saveLaunch({ version: 1, name: values.name, input, transport: 'intent', intentId: published.id, statuses: Object.fromEntries(chainIds.map((id: number) => [id, { phase: 'ready' as const }])) })
      } catch (cause) {
        throw new Error(`${message(cause)} Your project is published at ${intentPath(published.id)}.`)
      }
      setProgress('')
      router.push(intentPath(published.id))
    } catch (cause) { setError(failure(cause)) }
    finally { setPublishing(false) }
  }

  if (!loaded) return <p role="status">Reading your setup…</p>
  if (!values) return <div className="grid justify-items-start gap-4" role="alert">
    <p>{NO_SETUP}</p>
    <a className="btn-secondary" href="/create">Back to the form</a>
  </div>

  const chainIds = plannedNetworks(values).map((chain: { chainId: number }) => chain.chainId)
  const planned = (['owner', 'operator'] as const)
    .filter(role => (role === 'owner' || !values.ownerIsOperator) && values[`${role}Mode`] === 'create')
    .map(role => `${role === 'owner' ? 'Owner' : 'Operator'}: create Safe, ${values[`${role}Threshold`]}/${(values[`${role}Signers`] ?? []).length} approvals. Owners: ${(values[`${role}Signers`] ?? []).join(', ')}.`)
    .join('\n')

  return <IntentProjectView
    banner={<p role="status" className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">{BANNER}</p>}
    display={{
      name: values.name, location: values.location, logoUrl: values.ownerPhoto || undefined,
      coverUrl: values.photo || undefined, description: values.description,
      owner: values.ownerMode === 'create' ? 'A multisig this project creates' : values.ownerWallet,
      ownerProfile: values.ownerName || values.ownerIntroduction || values.ownerPhoto
        ? { name: values.ownerName, introduction: values.ownerIntroduction, photoUrl: values.ownerPhoto } : undefined,
      chainIds, tokenName: values.fundTokenName, ticker: values.fundTicker,
      mustStartAtOrAfter: 0, status: 'Not created yet',
      multisigs: planned || undefined,
    }}
    actions={<section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
      <p>Creating publishes these exact project creations to Juicebox Center and gives you a link anyone can open. You send no transaction and pay no creation fee here.</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className="quiet-button" disabled={publishing} onClick={() => router.push('/create')}>Edit</button>
        <button type="button" className="create-primary" disabled={publishing} onClick={() => void create(values)}>{publishing ? 'Publishing your project…' : 'Create'}</button>
        {!address && <WalletButton />}
      </div>
      {progress && <p role="status" className="mt-5 text-sm">{progress}</p>}
      {error && <p role="alert" className="mt-5 text-sm">{error}</p>}
    </section>}
  />
}
