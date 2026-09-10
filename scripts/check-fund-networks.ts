/** Read-only deployment, pricing and bridge-registry proof on every supported chain. */
import { randomBytes } from 'node:crypto'
import { createPublicClient, parseAbi, type Address, type Hex } from 'viem'
import { jbProjectsAbi, jbSuckerRegistryAbi, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { buildFundLaunch } from '../src/lib/fund-contracts'
import { checkLaunchDeployment } from '../src/lib/fund-launch-verification'
import { jbCenterRpcTransport } from '../src/lib/jbcenter-rpc'
import { jbCenterAppOrigin, jbCenterBaseUrl } from '../src/lib/jbcenter-config'

const deployerAbi = parseAbi(['function ccipRemoteChainId() view returns (uint256)'])
const groups = [[1, 10, 8453, 42161], [11155111, 11155420, 84532, 421614]] as const
const owner: Address = '0x000000000000000000000000000000000000dEaD'

async function main() {
  console.log(`Read-only RPC proof via ${jbCenterBaseUrl()}, Origin ${jbCenterAppOrigin()}.`)
  const results = await Promise.allSettled(groups.flatMap(chainIds => {
    const plan = buildFundLaunch({
      owner, sender: owner, chainIds, projectUri: 'ipfs://network-preflight',
      salt: `0x${randomBytes(32).toString('hex')}`, mustStartAtOrAfter: Math.floor(Date.now() / 1000),
      creationFees: Object.fromEntries(chainIds.map(id => [id, 0n])),
    })
    return plan.requests.map(async request => {
      const id = request.chainId as JBChainId
      try {
        const client = createPublicClient({ transport: jbCenterRpcTransport(id, 60_000) })
        const fee = await client.readContract({ address: v6Address('JBProjects', id), abi: jbProjectsAbi, functionName: 'creationFee' })
        await checkLaunchDeployment(client, { ...request, value: fee })
        const registry = v6Address('JBSuckerRegistry', id)
        const registryCode = await client.getCode({ address: registry })
        if (!registryCode || registryCode === '0x') throw new Error('JBSuckerRegistry is not deployed.')
        const config = request.args.at(-1) as { deployerConfigurations: { deployer: Address; mappings: { localToken: Address; remoteToken: Hex }[] }[] }
        if (config.deployerConfigurations.length !== chainIds.length - 1) throw new Error('The SDK omitted one or more selected peer routes.')
        const peers = await Promise.all(config.deployerConfigurations.map(async deployment => {
          const [code, allowed, remoteId] = await Promise.all([
            client.getCode({ address: deployment.deployer }),
            client.readContract({ address: registry, abi: jbSuckerRegistryAbi, functionName: 'suckerDeployerIsAllowed', args: [deployment.deployer] }),
            client.readContract({ address: deployment.deployer, abi: deployerAbi, functionName: 'ccipRemoteChainId' }),
          ])
          if (!code || code === '0x' || !allowed) throw new Error('A configured CCIP deployer is absent or disallowed.')
          const remote = Number(remoteId) as JBChainId
          if (remote === id || !(chainIds as readonly number[]).includes(remote)) throw new Error('A CCIP deployer names an unexpected peer chain.')
          if (deployment.mappings.length !== 1) throw new Error('A CCIP route does not contain exactly the reviewed USDC mapping.')
          const mapping = deployment.mappings[0]
          if (mapping.localToken.toLowerCase() !== USDC_ADDRESSES[id].toLowerCase() || mapping.remoteToken.toLowerCase() !== `0x${USDC_ADDRESSES[remote].slice(2).padStart(64, '0')}`.toLowerCase()) throw new Error('A CCIP USDC mapping differs from the canonical tokens.')
          const mappingAllowed = await client.readContract({ address: registry, abi: jbSuckerRegistryAbi, functionName: 'tokenMappingIsAllowed', args: [mapping.localToken, remoteId, mapping.remoteToken] })
          if (!mappingAllowed) throw new Error('The USDC mapping is not allowed by the deployed registry.')
          return remote
        }))
        if (new Set(peers).size !== chainIds.length - 1) throw new Error('Selected CCIP routes repeat a peer chain.')
        console.log(`PASS ${id}: deployed registry/core, creation fee ${fee} wei, positive USDC/USD feed, ${peers.length} allowed CCIP USDC peers.`)
      } catch (error) {
        const reason = error instanceof Error ? error.message.split('\n')[0] : 'RPC proof failed.'
        console.log(`FAIL ${id}: ${reason}`)
        throw error
      }
    })
  }))
  if (results.some(result => result.status === 'rejected')) process.exitCode = 1
}

void main().catch(error => { console.error(error instanceof Error ? error.message.split('\n')[0] : 'Network proof failed.'); process.exitCode = 1 })
