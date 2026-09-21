/** Read-only proof that the deployed Homerun contracts on every supported chain are the reviewed ones. */
import { createPublicClient } from 'viem'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { verifyIncomeLaunchWiring } from '../src/lib/income-launch'
import { registeredAllowlistHook } from '../src/lib/income-contracts'
import { jbCenterRpcTransport } from '../src/lib/jbcenter-rpc'
import { jbCenterBaseUrl } from '../src/lib/jbcenter-config'

const chainIds = [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614] as const

async function main() {
  console.log(`Read-only RPC proof via ${jbCenterBaseUrl()}.`)
  const results = await Promise.allSettled(chainIds.map(async id => {
    try {
      const client = createPublicClient({ transport: jbCenterRpcTransport(id as JBChainId, 60_000) })
      const block = await client.getBlockNumber()
      const deployer = await verifyIncomeLaunchWiring(client, id as JBChainId, block)
      console.log(`PASS ${id}: deployer ${deployer}, hook ${registeredAllowlistHook(id as JBChainId)}, every immutable matches the protocol at block ${block}.`)
    } catch (error) {
      console.log(`FAIL ${id}: ${error instanceof Error ? error.message.split('\n')[0] : 'RPC proof failed.'}`)
      throw error
    }
  }))
  if (results.some(result => result.status === 'rejected')) process.exitCode = 1
}

void main().catch(error => { console.error(error instanceof Error ? error.message.split('\n')[0] : 'Network proof failed.'); process.exitCode = 1 })
