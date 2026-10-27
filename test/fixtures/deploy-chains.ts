/** A published intent and the Center relay request DeployChains sends for it, shared by its UI and one-confirmation tests. */
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, zeroHash, type Hex } from 'viem'
import { erc2771ForwarderAbi } from '@bananapus/nana-sdk-core'
import { SAFE_PROXY_CREATION_CODE } from '@bananapus/nana-sdk-core/safe'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { HOMERUN_DEPLOYER } from './homerun-deployer'
import { homerunDeployerAbi } from '../../src/lib/income-contracts'
import { SAFE_FACTORY, multisigCreationData, predictMultisig } from '../../src/lib/create-multisig'

export const wallet = '0x1111111111111111111111111111111111111111'
export const intentId = '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
export const hash = `0x${'ef'.repeat(32)}` as Hex
export const relayHash = `0x${'ab'.repeat(32)}` as Hex

export const launch = (chainId: number, owner: string = wallet) => ({
  chainId, to: HOMERUN_DEPLOYER,
  data: encodeFunctionData({
    abi: homerunDeployerAbi, functionName: 'launchFundFor',
    args: [owner, 'ipfs://bafkreimetadata', 'Neighborhood Workshop FUND', 'FUND', 0, zeroHash, []],
  }),
})
export const safeOwners = ['0x000000000000000000000000000000000000dEaD', '0x2222222222222222222222222222222222222222'] as const
export const safePolicy = { owners: [...safeOwners] as `0x${string}`[], threshold: 2, saltNonce: `0x${'ab'.repeat(32)}` as Hex, proxyCreationCode: SAFE_PROXY_CREATION_CODE }
export const safeAddress = predictMultisig(safePolicy)
export const setupCall = (chainId: number) => ({ chainId, to: SAFE_FACTORY, data: multisigCreationData(safePolicy) })
export const deployRow = (chainId: number, status: string) => ({
  chainId, status, transactionHash: status === 'confirmed' ? hash : null, bundleUuid: null, error: null,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
})
export const deployment = (chainId: number, projectId: string) => ({ chainId, projectId, transactionHash: hash, createdAt: new Date(0).toISOString() })
export function intent(chainIds: number[], overrides: Record<string, unknown> = {}) {
  return {
    id: intentId, status: 'undeployed', contentHash: `0x${'ab'.repeat(32)}`, publisher: wallet,
    signature: `0x${'cd'.repeat(65)}`, createdAt: new Date(0).toISOString(), deployments: [], deploys: [],
    name: 'Neighborhood Workshop', description: null, tagline: null, tags: [], logoUri: null, owner: wallet,
    envelope: {
      format: 'homerun.money/fund.v1', deploymentVersion: '6', chainIds,
      deploymentCalls: chainIds.map(chainId => launch(chainId)),
      jb: { app: 'homerun', kind: 'fund', name: 'Neighborhood Workshop', owner: wallet, chainIds, tokenName: 'Neighborhood Workshop FUND', ticker: 'FUND', salt: zeroHash, mustStartAtOrAfter: 0, projectUri: 'ipfs://bafkreimetadata' },
    },
    ...overrides,
  }
}
/** The same intent with one Safe of its own, created by a setup call before the launch. */
export function safeIntent(chainIds: number[]) {
  const value = intent(chainIds)
  return {
    ...value,
    envelope: {
      ...value.envelope,
      deploymentCalls: chainIds.flatMap(chainId => [setupCall(chainId), launch(chainId, safeAddress)]),
      jb: {
        ...value.envelope.jb, owner: safeAddress,
        safes: [{ role: 'owner', address: safeAddress, owners: [...safeOwners], threshold: 2, saltNonce: safePolicy.saltNonce }],
      },
    },
  }
}

/** The deployer's own FundLaunched event, as a receipt the wallet's transaction produced. */
export const launchReceipt = (chainId: number, projectId: bigint, owner: string = wallet) => ({
  status: 'success', transactionHash: relayHash, blockNumber: 1_000n,
  logs: [{
    address: launch(chainId).to,
    topics: encodeEventTopics({ abi: homerunDeployerAbi, eventName: 'FundLaunched', args: { projectId, owner } }),
    data: encodeAbiParameters([{ type: 'address' }], [`0x${'5e'.repeat(20)}`]),
  }],
})
export const relayRequest = (chainId: number, value = 0n) => ({
  chainId, to: v6Address('ERC2771Forwarder', chainId as never), value, gas: 900_000n,
  deadline: Math.floor(Date.now() / 1000) + 1_800, setup: [],
  data: encodeFunctionData({
    abi: erc2771ForwarderAbi, functionName: 'execute',
    args: [{ from: wallet, to: launch(chainId).to, value, gas: 900_000n, deadline: Math.floor(Date.now() / 1000) + 1_800, data: launch(chainId).data, signature: `0x${'ab'.repeat(65)}` }],
  }),
})
export const safeRelayRequest = (chainId: number) => ({
  ...relayRequest(chainId),
  setup: [{ to: SAFE_FACTORY, data: multisigCreationData(safePolicy), value: 0n }],
  data: encodeFunctionData({
    abi: erc2771ForwarderAbi, functionName: 'execute',
    args: [{ from: wallet, to: launch(chainId).to, value: 0n, gas: 900_000n, deadline: Math.floor(Date.now() / 1000) + 1_800, data: launch(chainId, safeAddress).data, signature: `0x${'ab'.repeat(65)}` }],
  }),
})
