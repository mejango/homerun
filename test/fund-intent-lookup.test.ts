import assert from 'node:assert/strict'
import { test } from 'vitest'
import { encodeFunctionData, zeroHash } from 'viem'
import { HOMERUN_DEPLOYER } from './fixtures/homerun-deployer'
import { homerunDeployerAbi } from '../src/lib/income-contracts'
import { findProjectIntent } from '../src/lib/fund-intent-lookup'

const owner = '0x1111111111111111111111111111111111111111' as const
const first = '3f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
const second = '4f0f2f4c-0f3f-4f2f-8f1f-0f2f3f4f5f6f'
const call = (chainId: number) => ({
  chainId, to: HOMERUN_DEPLOYER,
  data: encodeFunctionData({
    abi: homerunDeployerAbi, functionName: 'launchFundFor',
    args: [owner, 'ipfs://bafkreimetadata', 'Neighborhood Workshop FUND', 'FUND', 0, zeroHash, []],
  }),
})
const intent = (id: string, chainIds: number[], deployments: { chainId: number; projectId: string }[]) => ({
  id, status: 'undeployed', contentHash: `0x${'ab'.repeat(32)}`, publisher: owner, signature: `0x${'cd'.repeat(65)}`,
  createdAt: new Date(0).toISOString(), deploys: [],
  deployments: deployments.map(row => ({ ...row, transactionHash: `0x${'ef'.repeat(32)}`, createdAt: new Date(0).toISOString() })),
  name: 'Neighborhood Workshop', description: null, tagline: null, tags: [], logoUri: null, owner,
  envelope: {
    format: 'homerun.money/fund.v1', deploymentVersion: '6', chainIds,
    deploymentCalls: chainIds.map(call),
    jb: { app: 'homerun', kind: 'fund', name: 'Neighborhood Workshop', owner, chainIds, tokenName: 'Neighborhood Workshop FUND', ticker: 'FUND', salt: zeroHash, mustStartAtOrAfter: 0, projectUri: 'ipfs://bafkreimetadata' },
  },
})
const clientFor = (intents: Record<string, unknown>, items: { intentId: string; chainIds: number[] }[] = []) => ({
  getIntent: async (id: string) => { if (!intents[id]) throw new Error('not found'); return intents[id] as never },
  searchIntents: async () => ({ items: items as never, totalCount: items.length, nextCursor: null }),
})

test('a hinted intent that deployed this project is the project’s intent', async () => {
  const client = clientFor({ [first]: intent(first, [8453, 10], [{ chainId: 8453, projectId: '42' }]) })
  const found = await findProjectIntent(client as never, { chainId: 8453, projectId: '42' }, [first])
  assert.equal(found?.id, first)
})

test('a hint that names another project, or no project, is ignored', async () => {
  const client = clientFor({ [first]: intent(first, [8453], [{ chainId: 8453, projectId: '43' }]) })
  assert.equal(await findProjectIntent(client as never, { chainId: 8453, projectId: '42' }, [first]), null)
  assert.equal(await findProjectIntent(client as never, { chainId: 8453, projectId: '42' }, ['not-an-id', null, undefined]), null)
  assert.equal(await findProjectIntent(client as never, { chainId: 8453, projectId: '42' }, [second]), null)
})

test('an intent the owner published is found without a hint', async () => {
  const client = clientFor(
    { [second]: intent(second, [8453, 1], [{ chainId: 8453, projectId: '42' }]) },
    [{ intentId: second, chainIds: [8453, 1] }, { intentId: first, chainIds: [10] }],
  )
  const found = await findProjectIntent(client as never, { chainId: 8453, projectId: '42' }, [], owner)
  assert.equal(found?.id, second)
})

test('an intent that is not a Homerun FUND is not this project’s intent', async () => {
  const foreign = intent(first, [8453], [{ chainId: 8453, projectId: '42' }])
  foreign.envelope.deploymentCalls = [{ chainId: 8453, to: HOMERUN_DEPLOYER, data: '0xdeadbeef' }] as never
  const client = clientFor({ [first]: foreign })
  assert.equal(await findProjectIntent(client as never, { chainId: 8453, projectId: '42' }, [first]), null)
})
