import type { JBChainId } from '@bananapus/nana-sdk-core'
import { jbSuckerV6ViewAbi } from '@bananapus/nana-sdk-core/v6'
import { isAddressEqual, type Address, type PublicClient } from 'viem'
import { SUPPORTED_CHAINS } from './chains'
import { assertFundStateForWrite, readFundProjectState, type FundProjectState } from './fund-state'

/** Payment discovery tolerates unfinished peer launches. Only reciprocal,
 * registered bridges prove a remote project's identity; draft IDs never do. */
export async function readFundPayNetworks(
  clientFor: (chainId: JBChainId) => PublicClient,
  source: FundProjectState,
) {
  const results = await Promise.allSettled(source.linkedPeers.map(async peer => {
    const chain = SUPPORTED_CHAINS.find(chain => chain.id === peer.chainId)
    if (!chain) throw new Error('Unsupported payment chain.')
    const client = clientFor(chain.id)
    if (await client.getChainId() !== peer.chainId) throw new Error('Wrong RPC chain.')
    const projectId = await client.readContract({ address: peer.suckerAddress, abi: jbSuckerV6ViewAbi, functionName: 'projectId' })
    if (projectId <= 0n) throw new Error('Peer launch is incomplete.')
    const state = await readFundProjectState(client, { chainId: peer.chainId, projectId, ...(source.account ? { account: source.account } : {}) })
    assertFundStateForWrite(state)
    const [remotePeer, remoteChain, remoteId, block] = await Promise.all([
      client.readContract({ address: peer.suckerAddress, abi: jbSuckerV6ViewAbi, functionName: 'peer', blockNumber: state.blockNumber }),
      client.readContract({ address: peer.suckerAddress, abi: jbSuckerV6ViewAbi, functionName: 'peerChainId', blockNumber: state.blockNumber }),
      client.readContract({ address: peer.suckerAddress, abi: jbSuckerV6ViewAbi, functionName: 'projectId', blockNumber: state.blockNumber }),
      client.getBlock({ blockNumber: state.blockNumber }),
    ])
    if (!/^0x0{24}[\da-f]{40}$/i.test(remotePeer) || remoteId !== projectId || remoteChain !== BigInt(source.chainId) ||
      !isAddressEqual(`0x${remotePeer.slice(-40)}` as Address, peer.localSuckerAddress) ||
      !state.linkedPeers.some(candidate => candidate.chainId === source.chainId &&
        isAddressEqual(candidate.localSuckerAddress, peer.suckerAddress) && isAddressEqual(candidate.suckerAddress, peer.localSuckerAddress)) ||
      block.hash !== state.blockHash) throw new Error('Unverified peer project.')
    if (!state.accountingContexts.length) throw new Error('No payment terminal.')
    return state
  }))
  const projects = new Map<number, FundProjectState>([[source.chainId, source]])
  for (const result of results) if (result.status === 'fulfilled') projects.set(result.value.chainId, result.value)
  return { projects: [...projects.values()], unavailable: results.filter(result => result.status === 'rejected').length }
}
