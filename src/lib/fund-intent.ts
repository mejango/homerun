/**
 * Homerun's FUND project intent: the launch calls `buildFundLaunch` produces,
 * frozen into the envelope Juicebox Center signs, stores and later sends itself.
 * This module has no wallet, browser storage, RPC or lifecycle-state authority.
 */
import {
  JBCENTER_SPONSORED_CHAIN_IDS,
  createJBCenterDeploymentCall,
  intentCalls,
  publishSignedIntent,
  type JBCenterChainCalls,
  type JBCenterClient,
  type JBCenterDecodedCall,
  type JBCenterDeploymentCall,
  type JBCenterDeploymentInput,
  type JBCenterIntent,
  type JBCenterRequestOptions,
} from '@bananapus/nana-sdk-core/jbcenter'
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from 'viem'
import { buildFundLaunch, type FundLaunchInput, type FundTransaction } from './fund-contracts'
import { SAFE_FACTORY, multisigCreationData, multisigDeploymentCalls } from './create-multisig'

export const FUND_INTENT_FORMAT = 'homerun.money/fund.v1'

export const UNSPONSORED_CHAINS_MESSAGE =
  'Juicebox Center creates projects without a transaction on Optimism, Base, Arbitrum and their test networks. Remove the other networks, or create with a transaction.'
export const SAFES_UNREADABLE_MESSAGE =
  'This project’s multisig creations do not match the project they create.'

export type FundIntentSafe = {
  role: 'owner' | 'operator'
  address: Address
  owners: Address[]
  threshold: number
  saltNonce: Hex
}

export type FundIntentJb = {
  app: 'homerun'
  kind: 'fund'
  name: string
  owner: Address
  chainIds: number[]
  tokenName: string
  ticker: string
  salt: Hex
  mustStartAtOrAfter: number
  projectUri: string
  safes?: FundIntentSafe[]
}

export type FundIntent = {
  format: typeof FUND_INTENT_FORMAT
  deploymentVersion: '6'
  chainIds: number[]
  deploymentCalls: JBCenterDeploymentCall[]
  jb: FundIntentJb
}

export function fundIntentEligibleChains(chainIds: readonly number[]): boolean {
  return chainIds.length > 0 && new Set(chainIds).size === chainIds.length
    && chainIds.every(chainId => JBCENTER_SPONSORED_CHAIN_IDS.includes(chainId))
}

/** The reviewed launch call without its creation fee: Center's sender pays that. */
function deploymentCall(request: FundTransaction): JBCenterDeploymentCall {
  const { chainId, address, abi, functionName, args } = request
  return createJBCenterDeploymentCall({ chainId, address, abi, functionName, args })
}

export function buildFundIntent(input: FundLaunchInput, name: string): FundIntent {
  const { requests, review } = buildFundLaunch(input)
  const chainIds = requests.map(request => request.chainId)
  if (!fundIntentEligibleChains(chainIds)) throw new Error(UNSPONSORED_CHAINS_MESSAGE)
  const projectName = name.trim()
  if (!projectName || projectName.length > 160) throw new Error('A project name of 160 characters or fewer is required.')
  const plans = input.multisigs ?? []
  // A Safe's address depends only on its plan, so the setup calls and the launch land in any order.
  const setup = multisigDeploymentCalls(plans)
  const safes: FundIntentSafe[] = plans.map(plan => ({
    role: plan.role, address: plan.address, owners: [...plan.owners],
    threshold: plan.threshold, saltNonce: plan.saltNonce,
  }))
  return {
    format: FUND_INTENT_FORMAT,
    deploymentVersion: '6',
    chainIds,
    deploymentCalls: requests.flatMap(request => [
      ...setup.map(call => ({ chainId: request.chainId, to: call.target, data: call.callData })),
      deploymentCall(request),
    ]),
    jb: {
      app: 'homerun',
      kind: 'fund',
      name: projectName,
      owner: review.owner,
      chainIds,
      tokenName: review.tokenName,
      ticker: review.ticker,
      salt: input.salt,
      mustStartAtOrAfter: input.mustStartAtOrAfter,
      projectUri: review.projectUri,
      ...(safes.length ? { safes } : {}),
    },
  }
}

export type PublishFundIntentInput = {
  client: JBCenterClient
  input: FundLaunchInput
  name: string
  publisher: Address
  sign: (message: string) => Promise<Hex>
}

/** Signs only the envelope Center prepared, and only when it equals this one. */
export async function publishFundIntent({ client, input, name, publisher, sign }: PublishFundIntentInput): Promise<JBCenterIntent> {
  if (!isAddressEqual(getAddress(publisher), getAddress(input.sender))) {
    throw new Error('Publish with the wallet that prepared this project.')
  }
  const intent = buildFundIntent(input, name)
  return publishSignedIntent(client, intent, sign, { publisher })
}

export type DecodedFundIntent = {
  owner: Address
  projectUri: string
  tokenName: string
  ticker: string
  mustStartAtOrAfter: number
  chainIds: number[]
  safes: FundIntentSafe[]
}

type UnnamedSafe = Omit<FundIntentSafe, 'role'>

/**
 * A setup call is readable only when re-encoding the plan the SDK decoded out of
 * it reproduces the signed bytes. The SDK derives the Safe address from those
 * same owners, threshold and salt, so equal bytes mean the call creates exactly
 * the address it reports.
 */
function readSafes(setup: readonly JBCenterDecodedCall[]): UnnamedSafe[] {
  return setup.map(call => {
    const plan = call.decoded
    if (plan.flavor !== 'safe-create') throw new Error('This project was not created by Homerun.')
    const safe: UnnamedSafe = {
      address: getAddress(plan.address),
      owners: plan.owners.map(owner => getAddress(owner)),
      threshold: plan.threshold,
      saltNonce: plan.saltNonce,
    }
    if (!isAddressEqual(call.to, SAFE_FACTORY) || call.data !== multisigCreationData(safe)) {
      throw new Error(SAFES_UNREADABLE_MESSAGE)
    }
    return safe
  })
}

/** The calls say which Safes are created; `jb.safes` only says which one owns the project. */
function namedSafes(safes: readonly UnnamedSafe[], jb: Partial<FundIntentJb>, owner: Address): FundIntentSafe[] {
  const claimed = jb.safes
  if (safes.length === 0) {
    if (claimed !== undefined && (!Array.isArray(claimed) || claimed.length > 0)) throw new Error(SAFES_UNREADABLE_MESSAGE)
    return []
  }
  if (!Array.isArray(claimed) || claimed.length !== safes.length
    || new Set(claimed.map(safe => safe?.role)).size !== claimed.length) throw new Error(SAFES_UNREADABLE_MESSAGE)
  return safes.map(safe => {
    const match = claimed.find(entry => typeof entry?.address === 'string' && isAddress(entry.address)
      && isAddressEqual(entry.address, safe.address))
    if (!match
      || (match.role !== 'owner' && match.role !== 'operator')
      || match.threshold !== safe.threshold
      || match.saltNonce !== safe.saltNonce
      || !Array.isArray(match.owners) || match.owners.length !== safe.owners.length
      || match.owners.some((entry, index) => typeof entry !== 'string' || !isAddress(entry) || !isAddressEqual(entry, safe.owners[index]))
      || (match.role === 'owner' && !isAddressEqual(safe.address, owner))) throw new Error(SAFES_UNREADABLE_MESSAGE)
    return { role: match.role, ...safe }
  })
}

/** The signed calls are the project. The `jb` form is a display hint, never the source. */
export function decodeFundIntent(intent: JBCenterIntent): DecodedFundIntent {
  const calls = intent.envelope.deploymentCalls
  if (!calls.length) throw new Error('This project has no deployment calls.')
  let grouped: Map<number, JBCenterChainCalls>
  try { grouped = intentCalls(intent) } catch { throw new Error('This project’s deployment calls could not be read.') }
  const chainIds = [...grouped.keys()]
  const chains = chainIds.map(chainId => {
    const { setup, launch } = grouped.get(chainId)!
    if (launch.decoded.flavor !== 'homerun-fund') throw new Error('This project was not created by Homerun.')
    return { launch: launch.decoded, safes: readSafes(setup) }
  })
  const [first] = chains
  const start = Number(first.launch.mustStartAtOrAfter)
  if (chains.some(chain => !isAddressEqual(chain.launch.owner, first.launch.owner)
    || chain.launch.projectUri !== first.launch.projectUri
    || chain.launch.tokenName !== first.launch.tokenName
    || chain.launch.ticker !== first.launch.ticker
    || Number(chain.launch.mustStartAtOrAfter) !== start
    || JSON.stringify(chain.safes) !== JSON.stringify(first.safes))) {
    throw new Error('This project’s chains do not share the same FUND terms.')
  }
  const owner = getAddress(first.launch.owner)
  return {
    owner,
    projectUri: first.launch.projectUri,
    tokenName: first.launch.tokenName,
    ticker: first.launch.ticker,
    mustStartAtOrAfter: start,
    chainIds,
    safes: namedSafes(first.safes, intent.envelope.jb as Partial<FundIntentJb>, owner),
  }
}

/**
 * `ensureDeployed` turns a sponsorship refusal into its own error, so keep the
 * refusal Center returned for `describeCenterRefusal` to word.
 *
 * Only the three methods a deploy reaches are forwarded, each onto the client
 * itself: nothing here copies or inherits the client's own fields.
 */
export function watchDeployRefusal(client: JBCenterClient): { client: JBCenterClient; refusal: () => unknown } {
  let refusal: unknown
  const watched = {
    getIntent: (intentId: string, options?: JBCenterRequestOptions) => client.getIntent(intentId, options),
    recordDeployment: (intentId: string, deployment: JBCenterDeploymentInput, options?: JBCenterRequestOptions) =>
      client.recordDeployment(intentId, deployment, options),
    requestDeploy: (intentId: string, options?: JBCenterRequestOptions) =>
      client.requestDeploy(intentId, options).catch((error: unknown) => {
        refusal = error
        throw error
      }),
  }
  return { client: watched as unknown as JBCenterClient, refusal: () => refusal }
}
