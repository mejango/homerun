import type { JBChainId } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, isAddressEqual, type Address, type Hex } from 'viem'
import { HOMERUN_DEPLOYER } from './homerun-addresses'
import { homerunDeployerAbi } from './income-contracts'

export type HomerunFundLaunch = {
  owner: Address
  projectUri: string
  tokenName: string
  ticker: string
  to: Address
  mustStartAtOrAfter: number
  salt: Hex
  peerSuckerDeployers: readonly Address[]
}

/** A `launchFundFor` call to this chain's HomerunDeployer, or null for anything else. */
export function decodeHomerunFundLaunch(call: { chainId: number; to: Address; data: Hex }): HomerunFundLaunch | null {
  const deployer = HOMERUN_DEPLOYER[call.chainId as JBChainId]
  if (!deployer || !isAddressEqual(deployer, call.to)) return null
  try {
    const decoded = decodeFunctionData({ abi: homerunDeployerAbi, data: call.data })
    if (decoded.functionName !== 'launchFundFor') return null
    const [owner, projectUri, tokenName, ticker, mustStartAtOrAfter, salt, peerSuckerDeployers] = decoded.args
    return { owner, projectUri, tokenName, ticker, to: call.to, mustStartAtOrAfter, salt, peerSuckerDeployers }
  } catch {
    return null
  }
}
