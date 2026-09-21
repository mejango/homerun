/** This chain's initial INCOME is a stock revnet auto-issuance to the helper; anyone mints it to the current FUND owner once the stage starts. */
import { jbControllerAbi, jbProjectsAbi, jbTokensAbi, revOwnerAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { erc20Abi, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { FundTransaction } from './fund-contracts'
import { homerunDeployerAbi, registeredHomerunDeployer } from './income-contracts'

export type InitialIncomeAllocationState = {
  chainId: JBChainId; incomeProjectId: bigint; fundProjectId: bigint; deployer: Address
  /** The current FUND owner, who receives the mint. */
  owner: Address
  blockNumber: bigint; blockHash: Hex; blockTimestamp: bigint
  /** INCOME's only ruleset; the revnet keys the helper's auto-issuance by it. */
  stageId: bigint; stageStart: bigint; started: boolean
  /** Still recorded with the revnet; a stranger's `REVOwner.autoIssueFor` moves it into `held`. */
  recorded: bigint
  /** INCOME the helper already holds; `mintInitialAllocation` forwards all of it. */
  held: bigint
  /** What `mintInitialAllocation` pays the owner: `recorded + held`, zero once minted. */
  pending: bigint
}

function positiveId(value: bigint, label: string) {
  if (value <= 0n || value >= 1n << 256n) throw new Error(`A positive ${label} is required.`)
}

/** Fails visibly on RPC errors or a FUND the verified launcher never bound to this INCOME. */
export async function readInitialIncomeAllocation(client: PublicClient, input: {
  chainId: number; incomeProjectId: bigint; fundProjectId: bigint; blockNumber?: bigint
}): Promise<InitialIncomeAllocationState> {
  positiveId(input.incomeProjectId, 'INCOME project ID')
  positiveId(input.fundProjectId, 'FUND project ID')
  if (input.incomeProjectId === input.fundProjectId) throw new Error('FUND and INCOME must be distinct projects.')
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error('A supported chain is required.')
  const chainId = input.chainId as JBChainId
  const deployer = registeredHomerunDeployer(chainId)
  if (!deployer) throw new Error('No verified INCOME launcher is registered on this chain.')
  if (await client.getChainId() !== chainId) throw new Error('The RPC endpoint returned a different chain.')
  const block = await client.getBlock(input.blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber: input.blockNumber })
  if (block.number === null || !block.hash) throw new Error('The RPC did not return a mined block.')
  const at = { blockNumber: block.number }
  const [bound, owner, [ruleset], token] = await Promise.all([
    client.readContract({ address: deployer, abi: homerunDeployerAbi, functionName: 'incomeProjectIdOf', args: [input.fundProjectId], ...at }),
    client.readContract({ address: v6Address('JBProjects', chainId), abi: jbProjectsAbi, functionName: 'ownerOf', args: [input.fundProjectId], ...at }),
    client.readContract({ address: v6Address('JBController', chainId), abi: jbControllerAbi, functionName: 'latestQueuedRulesetOf', args: [input.incomeProjectId], ...at }),
    client.readContract({ address: v6Address('JBTokens', chainId), abi: jbTokensAbi, functionName: 'tokenOf', args: [input.incomeProjectId], ...at }),
  ])
  if (bound !== input.incomeProjectId) throw new Error('The verified launcher has not bound this FUND to this INCOME project.')
  if (isAddressEqual(owner, zeroAddress)) throw new Error('The FUND has no owner to receive the initial allocation.')
  if (isAddressEqual(token, zeroAddress)) throw new Error('INCOME has no ERC-20 to hold the initial allocation.')
  const stageId = BigInt(ruleset.id), stageStart = BigInt(ruleset.start)
  if (stageId === 0n) throw new Error('INCOME has no recorded stage.')
  const [recorded, held] = await Promise.all([
    client.readContract({ address: v6Address('REVOwner', chainId), abi: revOwnerAbi, functionName: 'amountToAutoIssue', args: [input.incomeProjectId, stageId, deployer], ...at }),
    client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [deployer], ...at }),
  ])
  if (input.blockNumber === undefined) {
    const again = await client.getBlock({ blockNumber: block.number })
    if (again.hash !== block.hash) throw new Error('The chain changed during the initial INCOME read. Refresh and try again.')
  }
  return { chainId, incomeProjectId: input.incomeProjectId, fundProjectId: input.fundProjectId, deployer, owner, blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, stageId, stageStart, started: stageStart <= block.timestamp, recorded, held, pending: recorded + held }
}

/** The allocation is either still payable in full (recorded, held by the helper, or a mix) or was paid out after the stage started. */
export function assertInitialIncomeAllocation(state: InitialIncomeAllocationState, expected: bigint): void {
  if (state.pending === expected) return
  if (state.pending === 0n && state.started) return
  throw new Error('The recorded initial INCOME allocation does not match the published manifest for this chain.')
}

/** Permissionless; the helper mints what is still recorded and forwards everything it holds to whoever owns the FUND when it executes. */
export function buildInitialIncomeMint(state: InitialIncomeAllocationState): FundTransaction {
  if (state.pending <= 0n) throw new Error('Nothing is left to mint on this chain.')
  if (!state.started) throw new Error('The INCOME stage has not started yet.')
  return { chainId: state.chainId, address: state.deployer, abi: homerunDeployerAbi, functionName: 'mintInitialAllocation', args: [state.fundProjectId] }
}
