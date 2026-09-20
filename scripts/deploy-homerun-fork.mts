/**
 * Deploys HomerunAllowlistHook, the HomerunDeployerLib external library and
 * HomerunDeployer from the local `out/` artifacts onto an Anvil fork and
 * registers them in the installed SDK registry so the application's builders
 * target them. Fork scripts only: the live SDK registry gains these entries
 * through the release process instead.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createWalletClient, getAddress, http, parseAbi, type Address, type Chain, type Hex, type PublicClient } from 'viem'
import { USDC_ADDRESSES, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'

function artifact(name: string, libraries: Record<string, Address> = {}): { abi: readonly unknown[]; bytecode: Hex } {
  const parsed = JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: readonly unknown[]; bytecode: { object: Hex; linkReferences?: Record<string, Record<string, unknown>> } }
  // Foundry leaves `__$<hash>$__` placeholders where a linked library address belongs.
  const bytecode = Object.values(parsed.bytecode.linkReferences ?? {}).flatMap(file => Object.keys(file)).reduce((code, library) => {
    const address = libraries[library]
    assert(address, `${name} links ${library}, which has not been deployed.`)
    return code.replace(/__\$[0-9a-f]{34}\$__/gu, address.slice(2).toLowerCase()) as Hex
  }, parsed.bytecode.object)
  assert(!bytecode.includes('$'), `${name} still has unlinked library references.`)
  return { abi: parsed.abi, bytecode }
}

export async function deployHomerunOnFork(client: PublicClient, input: { chain: Chain; chainId: number; url: string; deployer: Address }): Promise<{ deployer: Address; allowlistHook: Address }> {
  const chainId = input.chainId as JBChainId
  const wallet = createWalletClient({ account: input.deployer, chain: input.chain, transport: http(input.url, { timeout: 180_000 }) })
  assert.equal(wallet.transport.url, input.url)
  const registry = jbContractAddress['6'] as Record<string, Partial<Record<number, string>>>
  const omnichainDeployer = v6Address('JBOmnichainDeployer', chainId)
  const forwarder = await client.readContract({ address: omnichainDeployer, abi: parseAbi(['function trustedForwarder() view returns (address)']), functionName: 'trustedForwarder' })
  const registered = (name: string) => {
    const address = registry[name]?.[chainId]
    assert(address, `The SDK registry has no ${name} on chain ${chainId}.`)
    return getAddress(address)
  }
  const deploy = async (name: string, args: readonly unknown[], libraries?: Record<string, Address>) => {
    const { abi, bytecode } = artifact(name, libraries)
    const hash = await wallet.deployContract({ abi: abi as never, bytecode, args: args as never, gas: 30_000_000n })
    const receipt = await client.waitForTransactionReceipt({ hash })
    assert.equal(receipt.status, 'success', `${name} deployment reverted.`)
    const address = receipt.contractAddress
    assert(address, `${name} deployment produced no address.`)
    console.log(`PASS Deploy ${name} on the local fork: ${address}`)
    return getAddress(address)
  }
  const allowlistHook = await deploy('HomerunAllowlistHook', [v6Address('JBProjects', chainId), forwarder])
  const HomerunDeployerLib = await deploy('HomerunDeployerLib', [])
  const deployer = await deploy('HomerunDeployer', [[{
    chainId, controller: v6Address('JBController', chainId), revDeployer: registered('REVDeployer'), usdc: USDC_ADDRESSES[chainId],
    omnichainDeployer, routerTerminalRegistry: registered('JBRouterTerminalRegistry'), allowlistHook,
  }]], { HomerunDeployerLib })
  registry.HomerunAllowlistHook = { ...registry.HomerunAllowlistHook, [chainId]: allowlistHook }
  registry.HomerunDeployer = { ...registry.HomerunDeployer, [chainId]: deployer }
  return { deployer, allowlistHook }
}
