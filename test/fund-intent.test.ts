import assert from 'node:assert/strict'
import { expect, test, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, zeroHash, type Address, type Hex, type TransactionReceipt } from 'viem'
import { erc2771ForwarderAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { SAFE_PROXY_CREATION_CODE } from '@bananapus/nana-sdk-core/safe'
import { SAFE_FACTORY, multisigCreationData, predictMultisig } from '../src/lib/create-multisig'
import type { CreateMultisig } from '../src/lib/create-multisig'
import { JBCenterRequestError, type JBCenterClient, type JBCenterIntent } from '@bananapus/nana-sdk-core/jbcenter'
import { HOMERUN_DEPLOYER } from './fixtures/homerun-deployer'
import { homerunDeployerAbi } from '../src/lib/income-contracts'
import type { FundLaunchInput } from '../src/lib/fund-contracts'
import {
  FUND_INTENT_FORMAT, RELAY_UNREADABLE_MESSAGE, SAFES_UNREADABLE_MESSAGE, buildFundIntent, checkRelayRequest,
  decodeFundIntent, fundIntentEligibleChains, intentLaunchCalls, publishFundIntent, readLaunchedProjectId,
  relayCostLabel, watchDeployRefusal, type FundRelayRequest,
} from '../src/lib/fund-intent'

const owner = '0x1111111111111111111111111111111111111111' as const
const salt = `0x${'12'.repeat(32)}` as Hex
const projectUri = 'ipfs://bafkreihomerunmetadata'
const input: FundLaunchInput = {
  owner, sender: owner, chainIds: [8453], projectUri, tokenName: 'House FUND', ticker: 'HOUSE',
  salt, mustStartAtOrAfter: 0, creationFees: { 8453: 1_234n, 10: 2_345n },
}
const launchData = (args: readonly unknown[]) =>
  encodeFunctionData({ abi: homerunDeployerAbi, functionName: 'launchFundFor', args })

const signers = ['0x000000000000000000000000000000000000dEaD', '0x2222222222222222222222222222222222222222'] as const
const ownerPlan: CreateMultisig = {
  role: 'owner',
  owners: [...signers] as Address[],
  threshold: 2,
  saltNonce: `0x${'ab'.repeat(32)}` as Hex,
  proxyCreationCode: SAFE_PROXY_CREATION_CODE,
  address: '0x0000000000000000000000000000000000000000' as Address,
}
const operatorPlan: CreateMultisig = { ...ownerPlan, role: 'operator', saltNonce: `0x${'cd'.repeat(32)}` as Hex }
const planned = (plan: CreateMultisig) => ({ ...plan, address: predictMultisig(plan) })
const withSafes = (plans: CreateMultisig[]): FundLaunchInput => {
  const resolved = plans.map(planned)
  const owner = resolved.find(plan => plan.role === 'owner')?.address ?? input.owner
  return { ...input, owner, operator: resolved.find(plan => plan.role === 'operator')?.address ?? owner, multisigs: resolved }
}

test('the envelope carries the exact launch calldata, no creation fee, and the jb form clients read', () => {
  const intent = buildFundIntent(input, '  Neighborhood Workshop  ')
  assert.equal(intent.format, FUND_INTENT_FORMAT)
  assert.equal(intent.format, 'homerun.money/fund.v1')
  assert.equal(intent.deploymentVersion, '6')
  assert.deepEqual(intent.chainIds, [8453])
  assert.deepEqual(intent.deploymentCalls, [{
    chainId: 8453, to: HOMERUN_DEPLOYER,
    data: launchData([owner, projectUri, 'House FUND', 'HOUSE', 0, zeroHash, []]),
  }])
  assert.equal(Object.hasOwn(intent.deploymentCalls[0], 'value'), false)
  assert.deepEqual(intent.jb, {
    app: 'homerun', kind: 'fund', name: 'Neighborhood Workshop', owner, chainIds: [8453],
    tokenName: 'House FUND', ticker: 'HOUSE', salt, mustStartAtOrAfter: 0, projectUri,
  })
})

test('the same inputs always produce byte-identical envelopes', () => {
  assert.equal(
    JSON.stringify(buildFundIntent(input, 'Neighborhood Workshop')),
    JSON.stringify(buildFundIntent(input, 'Neighborhood Workshop')),
  )
})

test('linked chains keep one salt, one start and each chain its own peer deployers', () => {
  // Three chains, not two: the CCIP sucker deployer for an (A, B) link shares one
  // address on both ends (see CCIP_SUCKER_DEPLOYER_ADDRESSES[6]), so a two-chain
  // link's single peer entry is identical on both sides and cannot show each
  // chain naming its own peers. A third chain gives each call a distinct peer set.
  const linked: FundLaunchInput = {
    ...input, chainIds: [42161, 8453, 10], mustStartAtOrAfter: 1_800_000_000,
    creationFees: { ...input.creationFees, 42161: 3_456n },
  }
  const intent = buildFundIntent(linked, 'Neighborhood Workshop')
  assert.deepEqual(intent.chainIds, [42161, 8453, 10])
  assert.deepEqual(intent.jb.chainIds, [42161, 8453, 10])
  assert.equal(intent.jb.mustStartAtOrAfter, 1_800_000_000)
  assert.equal(intent.deploymentCalls.length, 3)
  const [a, b, c] = intent.deploymentCalls
  assert.notEqual(a.data, b.data)
  assert.notEqual(b.data, c.data)
  assert.notEqual(a.data, c.data)
  for (const call of intent.deploymentCalls) assert.equal(call.to, HOMERUN_DEPLOYER)
})

const forwarderOn = (chainId: number) => v6Address('ERC2771Forwarder', chainId as never)
const forwardedData = (to: Address, data: Hex, value: bigint) => encodeFunctionData({
  abi: erc2771ForwarderAbi,
  functionName: 'execute',
  args: [{ from: owner, to, value, gas: 900_000n, deadline: 2_000_000_000, data, signature: `0x${'ab'.repeat(65)}` as Hex }],
})
const relayFor = (intent: JBCenterIntent, chainId: number, overrides: Partial<FundRelayRequest> = {}): FundRelayRequest => {
  const calls = intentLaunchCalls(intent, chainId)
  return {
    chainId, to: forwarderOn(chainId), value: 0n, gas: 900_000n, deadline: 2_000_000_000,
    data: forwardedData(calls.launch.to, calls.launch.data, 0n),
    setup: calls.setup.map(call => ({ to: call.to, data: call.data, value: 0n })),
    ...overrides,
  }
}

test('an intent may name any supported chain, and no other', () => {
  assert.equal(fundIntentEligibleChains([8453]), true)
  assert.equal(fundIntentEligibleChains([1, 8453]), true)
  assert.equal(fundIntentEligibleChains([]), false)
  assert.equal(fundIntentEligibleChains([8453, 8453]), false)
  assert.equal(fundIntentEligibleChains([137]), false)
  const intent = buildFundIntent({ ...input, chainIds: [1, 8453], creationFees: { 1: 0n, 8453: 0n }, mustStartAtOrAfter: 1_800_000_000 }, 'Neighborhood Workshop')
  assert.deepEqual(intent.chainIds, [1, 8453])
  assert.throws(() => buildFundIntent({ ...input, chainIds: [137], creationFees: { 137: 0n } }, 'Neighborhood Workshop'), /Unsupported FUND chain 137/)
  assert.throws(() => buildFundIntent(input, '   '), /project name/)
})

test('a relay request that forwards this intent\u2019s own launch is readable', () => {
  const intent = { envelope: buildFundIntent({ ...input, chainIds: [1], creationFees: { 1: 0n } }, 'Neighborhood Workshop') } as unknown as JBCenterIntent
  const forwarded = checkRelayRequest(intent, relayFor(intent, 1))
  assert.equal(forwarded.to, intentLaunchCalls(intent, 1).launch.to)
  assert.equal(forwarded.data, intentLaunchCalls(intent, 1).launch.data)
})

test('a relay request that forwards anything else is refused', () => {
  const intent = { envelope: buildFundIntent({ ...input, chainIds: [1], creationFees: { 1: 0n } }, 'Neighborhood Workshop') } as unknown as JBCenterIntent
  const other = `0x${'11'.repeat(20)}` as Address
  const refusal = new RegExp(RELAY_UNREADABLE_MESSAGE)
  assert.throws(() => checkRelayRequest(intent, relayFor(intent, 1, { to: other })), refusal)
  assert.throws(() => checkRelayRequest(intent, relayFor(intent, 1, { to: '0x11' as Address })), refusal)
  assert.throws(() => checkRelayRequest(intent, relayFor(intent, 1, { data: forwardedData(other, intentLaunchCalls(intent, 1).launch.data, 0n) })), refusal)
  assert.throws(() => checkRelayRequest(intent, relayFor(intent, 1, { data: forwardedData(intentLaunchCalls(intent, 1).launch.to, '0xdeadbeef', 0n) })), refusal)
  assert.throws(() => checkRelayRequest(intent, relayFor(intent, 1, { value: 1n })), refusal)
  assert.throws(() => checkRelayRequest(intent, relayFor(intent, 1, { setup: [{ to: other, data: '0xdead', value: 0n }] })), refusal)
  assert.throws(() => checkRelayRequest(intent, relayFor(intent, 1, { deadline: 1_600_000_000 })), /expired/)
  assert.throws(() => checkRelayRequest(intent, { ...relayFor(intent, 1), chainId: 10 }), refusal)
})

test('the project a paid deployment created is read out of its receipt', () => {
  const intent = { envelope: buildFundIntent({ ...input, chainIds: [1], creationFees: { 1: 0n } }, 'Neighborhood Workshop') } as unknown as JBCenterIntent
  const deployer = intentLaunchCalls(intent, 1).launch.to
  const launched = (projectId: bigint, logOwner: Address, address = deployer) => ({
    address,
    topics: encodeEventTopics({ abi: homerunDeployerAbi, eventName: 'FundLaunched', args: { projectId, owner: logOwner } }),
    data: encodeAbiParameters([{ type: 'address' }], [`0x${'5e'.repeat(20)}` as Address]),
  })
  const receipt = (logs: unknown[]) => ({ status: 'success', logs } as unknown as Pick<TransactionReceipt, 'status' | 'logs'>)
  assert.equal(readLaunchedProjectId(intent, 1, receipt([launched(7n, owner)])), '7')
  assert.throws(() => readLaunchedProjectId(intent, 1, receipt([])), /did not create/)
  assert.throws(() => readLaunchedProjectId(intent, 1, receipt([launched(7n, `0x${'99'.repeat(20)}` as Address)])), /did not create/)
  assert.throws(() => readLaunchedProjectId(intent, 1, receipt([launched(7n, owner, `0x${'88'.repeat(20)}` as Address)])), /did not create/)
  assert.throws(() => readLaunchedProjectId(intent, 1, receipt([launched(7n, owner), launched(8n, owner)])), /did not create/)
})

test('a relay cost reads as one short amount of ETH', () => {
  assert.equal(relayCostLabel(4_200_000_000_000_000n), 'costs ~0.0042 ETH')
  assert.equal(relayCostLabel(0n), 'costs ~0 ETH')
  assert.equal(relayCostLabel(20_000_000_000_000n), 'costs ~0.00002 ETH')
})

test('publishing signs Center’s prepared message and sends the envelope with the publisher', async () => {
  const contentHash = `0x${'ab'.repeat(32)}` as Hex
  // Center's own signing message, word for word (docs/rest/PROJECT_INTENTS.md):
  // publishSignedIntent refuses to sign anything else.
  const message = `Juice Central project intent\nVersion: 1\nContent hash: ${contentHash}`
  const signature = `0x${'cd'.repeat(65)}` as Hex
  const prepareIntent = vi.fn(async (envelope: unknown) => ({ contentHash, message, envelope }))
  const publishIntent = vi.fn(async (body: Record<string, unknown>) => ({
    id: '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f', status: 'undeployed', contentHash,
    envelope: (body as { format: string }), publisher: owner, signature,
    createdAt: new Date(0).toISOString(), deployments: [], deploys: [],
    name: 'Neighborhood Workshop', description: null, tagline: null, tags: [], logoUri: null, owner,
  }))
  const client = { prepareIntent, publishIntent } as unknown as JBCenterClient
  const sign = vi.fn(async () => signature)

  const published = await publishFundIntent({ client, input, name: 'Neighborhood Workshop', publisher: owner, sign })

  expect(sign).toHaveBeenCalledWith(message)
  assert.deepEqual(publishIntent.mock.calls[0][0], {
    ...buildFundIntent(input, 'Neighborhood Workshop'), publisher: owner, signature,
  })
  assert.equal(published.id, '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f')
})

test('only the wallet that prepared the launch may publish it', async () => {
  const client = {} as JBCenterClient
  await assert.rejects(
    publishFundIntent({ client, input, name: 'Neighborhood Workshop', publisher: '0x2222222222222222222222222222222222222222', sign: async () => '0x' }),
    /wallet that prepared/,
  )
})

test('the FUND terms are read back out of the signed calls', () => {
  const envelope = buildFundIntent({ ...input, chainIds: [10, 8453], mustStartAtOrAfter: 1_800_000_000 }, 'Neighborhood Workshop')
  const decoded = decodeFundIntent({ envelope } as unknown as JBCenterIntent)
  assert.deepEqual(decoded, {
    owner, projectUri, tokenName: 'House FUND', ticker: 'HOUSE',
    mustStartAtOrAfter: 1_800_000_000, chainIds: [10, 8453], safes: [],
  })
})

test('a call Homerun did not build is refused rather than displayed', () => {
  const envelope = buildFundIntent(input, 'Neighborhood Workshop')
  const foreign = { ...envelope, deploymentCalls: [{ ...envelope.deploymentCalls[0], data: '0xdeadbeef' as Hex }] }
  assert.throws(() => decodeFundIntent({ envelope: foreign } as unknown as JBCenterIntent), /not created by Homerun/)
})

test('a planned owner Safe is created by the intent, before the launch, on every chain', () => {
  const linked = { ...withSafes([ownerPlan]), chainIds: [10, 8453], mustStartAtOrAfter: 1_800_000_000 }
  const intent = buildFundIntent(linked, 'Neighborhood Workshop')
  assert.equal(intent.deploymentCalls.length, 4)
  assert.deepEqual(intent.deploymentCalls.map(call => call.chainId), [10, 10, 8453, 8453])
  for (const index of [0, 2]) {
    assert.equal(intent.deploymentCalls[index].to, SAFE_FACTORY)
    assert.equal(intent.deploymentCalls[index].data, multisigCreationData(planned(ownerPlan)))
  }
  for (const index of [1, 3]) assert.equal(intent.deploymentCalls[index].to, HOMERUN_DEPLOYER)
  assert.equal(intent.jb.owner, planned(ownerPlan).address)
  assert.deepEqual(intent.jb.safes, [{
    role: 'owner', address: planned(ownerPlan).address, owners: [...signers],
    threshold: 2, saltNonce: ownerPlan.saltNonce,
  }])
})

test('a launch with no planned Safe keeps the single-call envelope and no safes form', () => {
  const intent = buildFundIntent(input, 'Neighborhood Workshop')
  assert.equal(intent.deploymentCalls.length, 1)
  assert.equal(Object.hasOwn(intent.jb, 'safes'), false)
})

test('an owner Safe and an operator Safe are two setup calls, the launch last', () => {
  const intent = buildFundIntent(withSafes([ownerPlan, operatorPlan]), 'Neighborhood Workshop')
  assert.equal(intent.deploymentCalls.length, 3)
  assert.deepEqual(intent.deploymentCalls.map(call => call.to), [SAFE_FACTORY, SAFE_FACTORY, HOMERUN_DEPLOYER])
  assert.deepEqual(intent.jb.safes?.map(safe => safe.role), ['owner', 'operator'])
})

test('the Safes are read back out of the signed setup calls, with their roles', () => {
  const envelope = buildFundIntent(withSafes([ownerPlan, operatorPlan]), 'Neighborhood Workshop')
  const decoded = decodeFundIntent({ envelope } as unknown as JBCenterIntent)
  assert.deepEqual(decoded.chainIds, [8453])
  assert.deepEqual(decoded.safes, [
    { role: 'owner', address: planned(ownerPlan).address, owners: [...signers], threshold: 2, saltNonce: ownerPlan.saltNonce },
    { role: 'operator', address: planned(operatorPlan).address, owners: [...signers], threshold: 2, saltNonce: operatorPlan.saltNonce },
  ])
  assert.equal(decoded.owner, planned(ownerPlan).address)
})

test('an owner Safe that does not own the project makes the intent unreadable', () => {
  const envelope = buildFundIntent(withSafes([ownerPlan]), 'Neighborhood Workshop')
  const foreign = { ...envelope, jb: { ...envelope.jb, safes: [{ ...envelope.jb.safes![0], role: 'owner' as const, address: owner }] } }
  assert.throws(() => decodeFundIntent({ envelope: foreign } as unknown as JBCenterIntent), new RegExp(SAFES_UNREADABLE_MESSAGE))
})

test('a setup call whose bytes do not create the Safe it decodes to is refused', () => {
  const envelope = buildFundIntent(withSafes([ownerPlan]), 'Neighborhood Workshop')
  const tampered = {
    ...envelope,
    deploymentCalls: [
      { ...envelope.deploymentCalls[0], data: multisigCreationData({ ...planned(ownerPlan), threshold: 1 }) },
      envelope.deploymentCalls[1],
    ],
  }
  assert.throws(() => decodeFundIntent({ envelope: tampered } as unknown as JBCenterIntent), new RegExp(SAFES_UNREADABLE_MESSAGE))
})

test('a jb form that hides or invents a Safe is refused', () => {
  const envelope = buildFundIntent(withSafes([ownerPlan]), 'Neighborhood Workshop')
  const hidden = { ...envelope, jb: { ...envelope.jb, safes: [] } }
  assert.throws(() => decodeFundIntent({ envelope: hidden } as unknown as JBCenterIntent), new RegExp(SAFES_UNREADABLE_MESSAGE))
  const plain = buildFundIntent(input, 'Neighborhood Workshop')
  const invented = { ...plain, jb: { ...plain.jb, safes: [{ role: 'owner' as const, address: owner, owners: [...signers], threshold: 2, saltNonce: ownerPlan.saltNonce }] } }
  assert.throws(() => decodeFundIntent({ envelope: invented } as unknown as JBCenterIntent), new RegExp(SAFES_UNREADABLE_MESSAGE))
})

test('every watched call runs on the client itself, so its own fields keep working', async () => {
  class Center {
    #reads = 0
    async getIntent(intentId: string) { this.#reads++; return { id: intentId, reads: this.#reads } }
    async recordDeployment(intentId: string, deployment: { chainId: number }) { return { intentId, ...deployment, reads: this.#reads } }
    async requestDeploy() { return { deploys: [] } }
  }
  const watcher = watchDeployRefusal(new Center() as unknown as JBCenterClient)
  assert.deepEqual(await watcher.client.getIntent('3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'), { id: '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f', reads: 1 })
  assert.deepEqual(
    await watcher.client.recordDeployment('3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f', { chainId: 8453, projectId: '42', transactionHash: `0x${'ef'.repeat(32)}` }),
    { intentId: '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f', chainId: 8453, projectId: '42', transactionHash: `0x${'ef'.repeat(32)}`, reads: 1 },
  )
})

test('a sponsorship refusal stays readable after ensureDeployed replaces it', async () => {
  const refusal = new JBCenterRequestError('quota reached', 429, 'sponsor_quota')
  const base = { requestDeploy: vi.fn(async () => { throw refusal }) } as unknown as JBCenterClient
  const watcher = watchDeployRefusal(base)
  await assert.rejects(watcher.client.requestDeploy('3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'))
  assert.equal(watcher.refusal(), refusal)
})
