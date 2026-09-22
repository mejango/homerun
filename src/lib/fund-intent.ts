/**
 * Homerun's FUND project intent: the launch calls `buildFundLaunch` produces,
 * frozen into the envelope Juicebox Center signs, stores and later sends itself.
 * This module has no wallet, browser storage, RPC or lifecycle-state authority.
 */
import {
  JBCENTER_SPONSORED_CHAIN_IDS,
  createJBCenterDeploymentCall,
  decodeDeploymentCall,
  publishSignedIntent,
  type JBCenterClient,
  type JBCenterDeploymentCall,
  type JBCenterIntent,
  type JBCenterRequestOptions,
} from '@bananapus/nana-sdk-core/jbcenter'
import { getAddress, isAddressEqual, type Address, type Hex } from 'viem'
import { buildFundLaunch, type FundLaunchInput, type FundTransaction } from './fund-contracts'

export const FUND_INTENT_FORMAT = 'homerun.money/fund.v1'

export const UNSPONSORED_CHAINS_MESSAGE =
  'Juicebox Center creates projects without a transaction on Optimism, Base, Arbitrum and their test networks. Remove the other networks, or create with a transaction.'
export const MULTISIG_NEEDS_TRANSACTION_MESSAGE =
  'A new multisig is created by a transaction. Use existing Owner and Operator addresses to create without one.'

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
  if (input.multisigs?.length) throw new Error(MULTISIG_NEEDS_TRANSACTION_MESSAGE)
  const { requests, review } = buildFundLaunch(input)
  const chainIds = requests.map(request => request.chainId)
  if (!fundIntentEligibleChains(chainIds)) throw new Error(UNSPONSORED_CHAINS_MESSAGE)
  const projectName = name.trim()
  if (!projectName || projectName.length > 160) throw new Error('A project name of 160 characters or fewer is required.')
  return {
    format: FUND_INTENT_FORMAT,
    deploymentVersion: '6',
    chainIds,
    deploymentCalls: requests.map(deploymentCall),
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
}

/** The signed calls are the project. The `jb` form is a display hint, never the source. */
export function decodeFundIntent(intent: JBCenterIntent): DecodedFundIntent {
  const calls = intent.envelope.deploymentCalls
  if (!calls.length) throw new Error('This project has no deployment calls.')
  const launches = calls.map(call => {
    const launch = decodeDeploymentCall(call)
    if (launch.flavor !== 'homerun-fund') throw new Error('This project was not created by Homerun.')
    return launch
  })
  const [first] = launches
  const start = Number(first.mustStartAtOrAfter)
  if (launches.some(launch => !isAddressEqual(launch.owner, first.owner)
    || launch.projectUri !== first.projectUri
    || launch.tokenName !== first.tokenName
    || launch.ticker !== first.ticker
    || Number(launch.mustStartAtOrAfter) !== start)) {
    throw new Error('This project’s chains do not share the same FUND terms.')
  }
  return {
    owner: getAddress(first.owner),
    projectUri: first.projectUri,
    tokenName: first.tokenName,
    ticker: first.ticker,
    mustStartAtOrAfter: start,
    chainIds: calls.map(call => call.chainId),
  }
}

/**
 * `ensureDeployed` turns a sponsorship refusal into its own error, so keep the
 * refusal Center returned for `describeCenterRefusal` to word.
 */
export function watchDeployRefusal(client: JBCenterClient): { client: JBCenterClient; refusal: () => unknown } {
  let refusal: unknown
  const watched = Object.assign(Object.create(client) as JBCenterClient, {
    requestDeploy(intentId: string, options?: JBCenterRequestOptions) {
      return client.requestDeploy(intentId, options).catch((error: unknown) => {
        refusal = error
        throw error
      })
    },
  })
  return { client: watched, refusal: () => refusal }
}
