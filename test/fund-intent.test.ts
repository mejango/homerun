import assert from 'node:assert/strict'
import { expect, test, vi } from 'vitest'
vi.mock('@bananapus/nana-sdk-core', async importOriginal => (await import('./fixtures/homerun-deployer')).withHomerunDeployer(await importOriginal()))

import { encodeFunctionData, zeroHash, type Hex } from 'viem'
import { JBCenterRequestError, type JBCenterClient, type JBCenterIntent } from '@bananapus/nana-sdk-core/jbcenter'
import { HOMERUN_DEPLOYER } from './fixtures/homerun-deployer'
import { homerunDeployerAbi } from '../src/lib/income-contracts'
import type { FundLaunchInput } from '../src/lib/fund-contracts'
import {
  FUND_INTENT_FORMAT, buildFundIntent, decodeFundIntent, fundIntentEligibleChains,
  publishFundIntent, watchDeployRefusal,
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

test('mainnet and new multisigs cannot be created without a transaction', () => {
  assert.equal(fundIntentEligibleChains([8453]), true)
  assert.equal(fundIntentEligibleChains([1, 8453]), false)
  assert.equal(fundIntentEligibleChains([]), false)
  assert.equal(fundIntentEligibleChains([8453, 8453]), false)
  assert.throws(() => buildFundIntent({ ...input, chainIds: [1], creationFees: { 1: 0n } }, 'Neighborhood Workshop'), /Optimism, Base, Arbitrum/)
  assert.throws(() => buildFundIntent({
    ...input,
    multisigs: [{ role: 'owner', address: owner, owners: [owner], threshold: 1, saltNonce: salt, proxyCreationCode: '0x60' }],
  } as FundLaunchInput, 'Neighborhood Workshop'), /multisig/)
  assert.throws(() => buildFundIntent(input, '   '), /project name/)
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
    mustStartAtOrAfter: 1_800_000_000, chainIds: [10, 8453],
  })
})

test('a call Homerun did not build is refused rather than displayed', () => {
  const envelope = buildFundIntent(input, 'Neighborhood Workshop')
  const foreign = { ...envelope, deploymentCalls: [{ ...envelope.deploymentCalls[0], data: '0xdeadbeef' as Hex }] }
  assert.throws(() => decodeFundIntent({ envelope: foreign } as unknown as JBCenterIntent), /not created by Homerun/)
})

test('a sponsorship refusal stays readable after ensureDeployed replaces it', async () => {
  const refusal = new JBCenterRequestError('quota reached', 429, 'sponsor_quota')
  const base = { requestDeploy: vi.fn(async () => { throw refusal }) } as unknown as JBCenterClient
  const watcher = watchDeployRefusal(base)
  await assert.rejects(watcher.client.requestDeploy('3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'))
  assert.equal(watcher.refusal(), refusal)
})
