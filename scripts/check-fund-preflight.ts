/** Defaults to read-only eth_call. FUND_LOCAL_FORKS also writes to guarded localhost Anvil only. */
import { randomBytes } from 'node:crypto'
import { createPublicClient, createWalletClient, http, encodeFunctionData, type Address, type Hex } from 'viem'
import { jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { jbCenterRpcTransport } from '../src/lib/jbcenter-rpc'
import { buildFundLaunch } from '../src/lib/fund-contracts'
import { checkLaunchDeployment, verifyFundLaunch } from '../src/lib/fund-launch-verification'
import { simulateStateChangingTransaction } from '../src/lib/transaction-simulation'
import { readFundProjectState, readLinkedFundProjects } from '../src/lib/fund-state'

async function main() {
const owner: Address = '0x000000000000000000000000000000000000dEaD'
const chainIds = [8453, 10] as const
const forkUrls = process.env.FUND_LOCAL_FORKS === 'true' ? { 8453: 'http://127.0.0.1:8567', 10: 'http://127.0.0.1:8568' } : null
const clients = Object.fromEntries(chainIds.map(chainId => [chainId, createPublicClient({ transport: forkUrls ? http(forkUrls[chainId], { timeout: 180_000 }) : jbCenterRpcTransport(chainId) })]))
if (forkUrls) {
  for (const id of chainIds) {
    const rpc = clients[id].request as (args: { method: string; params?: unknown[] }) => Promise<unknown>
    await rpc({ method: 'anvil_nodeInfo' })
    await rpc({ method: 'anvil_setBalance', params: [owner, '0x56bc75e2d63100000'] })
    await rpc({ method: 'anvil_impersonateAccount', params: [owner] })
  }
}
const fees = Object.fromEntries(await Promise.all(chainIds.map(async id => [id, await clients[id].readContract({
  address: v6Address('JBProjects', id as JBChainId), abi: jbProjectsAbi, functionName: 'creationFee',
})])))
const timestamp = Math.max(...await Promise.all(chainIds.map(async id => Number((await clients[id].getBlock()).timestamp))))
const mode = process.env.FUND_PREFLIGHT_MODE ?? 'all'
if (!['all', 'single', 'linked'].includes(mode)) throw new Error('FUND_PREFLIGHT_MODE must be all, single or linked.')
const selections = mode === 'single' ? [[8453]] : mode === 'linked' ? [[...chainIds]] : [[8453], [...chainIds]]
const created: { chainId: number; projectId: string; hash: Hex; linked: boolean; salt: Hex; start: number }[] = []
for (const selection of selections) {
  const input = {
    owner, sender: owner, chainIds: selection, projectUri: 'ipfs://QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH',
    salt: (process.env.FUND_PREFLIGHT_SALT ?? `0x${randomBytes(32).toString('hex')}`) as Hex,
    mustStartAtOrAfter: selection.length > 1 ? timestamp : 0, creationFees: fees,
  }
  const plan = buildFundLaunch({ ...input, salt: input.salt as Hex })
  // Preserve these values when recovering a partially executed linked proof.
  console.log(JSON.stringify({ localOnly: Boolean(forkUrls), chainIds: selection, salt: input.salt, start: input.mustStartAtOrAfter }))
  const selectionCreated: { chainId: number; projectId: bigint }[] = []
  for (const request of plan.requests) {
    const client = clients[request.chainId]
    await checkLaunchDeployment(client, request)
    if (!forkUrls && request.value !== 0n) throw new Error('Creation fee is nonzero. Fund an Anvil fork account to complete simulation; no live transaction was sent.')
    const data = encodeFunctionData(request)
    const result = await simulateStateChangingTransaction(client, { from: owner, to: request.address, data, value: request.value, gas: 30_000_000n })
    if (forkUrls) {
      // Reconfirm the hardcoded local endpoint immediately before each write.
      await (client.request as (args: { method: string }) => Promise<unknown>)({ method: 'anvil_nodeInfo' })
      const wallet = createWalletClient({ account: owner, transport: http(forkUrls[request.chainId as keyof typeof forkUrls], { timeout: 180_000 }) })
      const hash = await wallet.sendTransaction({ chain: null, to: request.address, data, value: request.value, gas: 30_000_000n })
      console.log(JSON.stringify({ localOnly: true, chainId: request.chainId, hash, status: 'submitted' }))
      const receipt = await client.waitForTransactionReceipt({ hash })
      const projectId = await verifyFundLaunch(client, request, { ...input, salt: input.salt as Hex }, receipt, false)
      selectionCreated.push({ chainId: request.chainId, projectId })
      const record = { chainId: request.chainId, projectId: projectId.toString(), hash, linked: selection.length > 1, salt: input.salt, start: input.mustStartAtOrAfter }
      created.push(record)
      console.log(JSON.stringify({ localOnly: true, status: 'verified', ...record }))
    }
    console.log(`${selection.length > 1 ? 'Linked' : 'Single-chain'} FUND launch on ${request.chainId}: deployment, price feed, fee and eth_call passed (${(result.length - 2) / 2} return bytes).`)
  }
  if (forkUrls && selection.length > 1) {
    const first = selectionCreated[0]
    const state = await readFundProjectState(clients[first.chainId], { ...first, account: owner })
    const peers = await readLinkedFundProjects(id => {
      if (!clients[id]) throw new Error('The local proof encountered an unexpected peer chain.')
      return clients[id]
    }, state)
    if (peers.length !== selectionCreated.length || peers.some(peer => !selectionCreated.some(item => item.chainId === peer.chainId && item.projectId === peer.projectId))) {
      throw new Error('The actual reciprocal bridges differ from the projects just created.')
    }
    console.log(JSON.stringify({ localOnly: true, status: 'reciprocal-peers-verified', projects: peers.map(peer => ({ chainId: peer.chainId, projectId: peer.projectId.toString() })) }))
  }
}
if (forkUrls) console.log(JSON.stringify({ localOnly: true, created }, null, 2))

}
void main().catch(error => { console.error(error.shortMessage || error.message); process.exitCode = 1 })
