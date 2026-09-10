/**
 * Real FUND + stock Sticky custody proof on an exclusively held local Base fork.
 *
 * Prerequisite: build the reviewed stock contracts with
 *   (cd ../JBSticky && forge build --offline --skip test --skip script)
 * Run: node --import tsx scripts/verify-fund-sticky-fork.mts
 *
 * The write URL is fixed to http://127.0.0.1:8567 and every mutation verifies
 * Anvil and chain 8453. All projects/contracts are created inside a snapshot
 * restored in finally. No private keys, real funds, persistent SDK registry
 * changes, storage overrides, or mock accounting contracts are used.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPublicClient, createWalletClient, decodeEventLog, encodeDeployData, encodeFunctionData, erc20Abi, http, isAddressEqual, parseEther, toHex, type Abi, type Address, type Chain, type Hex, type TransactionReceipt } from 'viem'
import { base } from 'viem/chains'
import { jbContractAddress, jbMultiTerminalAbi, jbProjectsAbi, jbTokensAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { buildFundClaimCredits, buildFundDeployErc20, buildFundLaunch, buildFundMint, buildFundRulesetChange, type FundRulesetAction, type FundTransaction } from '../src/lib/fund-contracts.ts'
import { readFundProjectState } from '../src/lib/fund-state.ts'
import { checkLaunchDeployment, verifyFundLaunch } from '../src/lib/fund-launch-verification.ts'
import { readFundOwnershipForGlobalSnapshot, readFundOwnershipSnapshot } from '../src/lib/fund-snapshot.ts'
import { ownershipWeight, sumOwnershipWeights } from '../src/lib/fund-ownership-weight.ts'
import { simulateStateChangingTransaction } from '../src/lib/transaction-simulation.ts'

const LOCAL_RPC = 'http://127.0.0.1:8567'
const CHAIN_ID = 8453
const client = createPublicClient({ chain: base as Chain, transport: http(LOCAL_RPC, { timeout: 180_000 }), cacheTime: 0, pollingInterval: 100 })
const owner: Address = '0x0000000000000000000000000000000073747101'
const alice: Address = '0x0000000000000000000000000000000073747102'
const bob: Address = '0x0000000000000000000000000000000073747103'
const carol: Address = '0x0000000000000000000000000000000073747104'
const dave: Address = '0x0000000000000000000000000000000073747105'
const terminal = v6Address('JBMultiTerminal', CHAIN_ID)
const tokens = v6Address('JBTokens', CHAIN_ID)
const controller = v6Address('JBController', CHAIN_ID)
const URI = 'ipfs://QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH'
const salt = `0x${'71'.repeat(32)}` as Hex
const MICRO = 10n ** 12n
const LARGE_BACKING = 10n ** 36n + 1n
const records: { label: string; block: string; hash: Hex; gasUsed: string }[] = []
type Pool = { projectId: bigint; share: Address }
type Artifact = { abi: Abi; bytecode: { object: Hex; linkReferences?: Record<string, unknown> }; metadata: { compiler: { version: string } } }

async function rawRpc(method: string, params: unknown[] = []): Promise<unknown> {
  assert.equal(LOCAL_RPC, 'http://127.0.0.1:8567')
  assert.equal(client.transport.url, LOCAL_RPC)
  return (client.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method, params })
}
async function assertLocalAnvil() {
  assert.equal(LOCAL_RPC, 'http://127.0.0.1:8567')
  assert.equal(client.transport.url, LOCAL_RPC)
  assert.equal(await client.getChainId(), CHAIN_ID)
  const node = await rawRpc('anvil_nodeInfo')
  assert(node && typeof node === 'object', 'All writes require the exclusive local Anvil fork.')
}
async function mutate(method: string, params: unknown[] = []) {
  await assertLocalAnvil()
  return rawRpc(method, params)
}
async function sendData(label: string, account: Address, data: Hex, to?: Address, value = 0n): Promise<TransactionReceipt> {
  await assertLocalAnvil()
  await mutate('evm_increaseTime', [1])
  await mutate('evm_mine')
  if (to) await simulateStateChangingTransaction(client, { from: account, to, data, value, gas: 30_000_000n })
  const wallet = createWalletClient({ account, chain: base, transport: http(LOCAL_RPC, { timeout: 180_000 }) })
  assert.equal(wallet.transport.url, LOCAL_RPC)
  await assertLocalAnvil()
  const hash = await wallet.sendTransaction({ ...(to ? { to } : {}), data, value, gas: 30_000_000n })
  const receipt = await client.waitForTransactionReceipt({ hash })
  assert.equal(receipt.status, 'success', label)
  assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash)
  records.push({ label, block: receipt.blockNumber.toString(), hash, gasUsed: receipt.gasUsed.toString() })
  console.log(`PASS ${label}: ${hash}`)
  return receipt
}
async function send(label: string, account: Address, request: FundTransaction) {
  assert.equal(request.chainId, CHAIN_ID)
  return sendData(label, account, encodeFunctionData(request), request.address, request.value)
}
async function state(projectId: bigint) { return readFundProjectState(client, { chainId: CHAIN_ID, projectId, account: owner }) }
async function rules(projectId: bigint, action: FundRulesetAction) {
  const plan = buildFundRulesetChange({ snapshots: [(await state(projectId)).rulesetSnapshot], action, mustStartAtOrAfter: 0 })
  await send(action, owner, plan.requests[0])
}
async function transfer(token: Address, account: Address, beneficiary: Address, amount: bigint, label: string) {
  return send(label, account, { chainId: CHAIN_ID, address: token, abi: erc20Abi, functionName: 'transfer', args: [beneficiary, amount] })
}
async function approve(token: Address, amount: bigint) {
  await send('Approve exact aggregate fixture deposits', owner, { chainId: CHAIN_ID, address: token, abi: erc20Abi, functionName: 'approve', args: [terminal, amount] })
}
async function stake(pool: Pool, underlying: Address, amount: bigint, beneficiary = owner) {
  await send('Stake real underlying through the stock terminal', owner, { chainId: CHAIN_ID, address: terminal, abi: jbMultiTerminalAbi, functionName: 'pay', args: [pool.projectId, underlying, amount, beneficiary, 1n, 'Sticky custody fork verification', '0x'] })
}
async function donate(pool: Pool, underlying: Address, amount: bigint) {
  await send('Add accounted backing without issuing SHARE', owner, { chainId: CHAIN_ID, address: terminal, abi: jbMultiTerminalAbi, functionName: 'addToBalanceOf', args: [pool.projectId, underlying, amount, false, 'Sticky custody donation', '0x'] })
}

async function main() {
  const artifact = JSON.parse(await readFile(new URL('../../JBSticky/out/JBStickyDeployer.sol/JBStickyDeployer.json', import.meta.url), 'utf8')) as Artifact
  assert.equal(artifact.metadata.compiler.version, '0.8.28+commit.7893614a')
  assert.equal(Object.keys(artifact.bytecode.linkReferences ?? {}).length, 0, 'The stock factory artifact must have no unresolved library links.')
  assert(/^0x[0-9a-f]+$/i.test(artifact.bytecode.object))
  await assertLocalAnvil()
  const originalBlock = await client.getBlock()
  const initial = await mutate('evm_snapshot')
  const registry = jbContractAddress['6'] as Record<string, Partial<Record<number, Address>>>
  const oldStickyRegistry = registry.JBStickyDeployer
  try {
    for (const account of [owner, alice, bob, carol, dave]) {
      assert.equal((await client.getCode({ address: account })) ?? '0x', '0x')
      await mutate('anvil_setBalance', [account, toHex(parseEther('20'))])
      await mutate('anvil_impersonateAccount', [account])
    }
    const fee = await client.readContract({ address: v6Address('JBProjects', CHAIN_ID), abi: jbProjectsAbi, functionName: 'creationFee' })
    const input = { owner, sender: owner, chainIds: [CHAIN_ID], projectUri: URI, salt, mustStartAtOrAfter: 0, creationFees: { [CHAIN_ID]: fee } }
    const launch = buildFundLaunch(input).requests[0]
    await checkLaunchDeployment(client, launch)
    const creation = await send('Launch fresh canonical FUND', owner, launch)
    const fundProjectId = await verifyFundLaunch(client, launch, input, creation, false)
    await rules(fundProjectId, 'close')
    await rules(fundProjectId, 'enable-success-minting')
    const ownerMint = LARGE_BACKING + parseEther('1000')
    for (const [beneficiary, amount] of [[owner, ownerMint], [bob, parseEther('50')]] as const) {
      await send('Mint an offchain contribution in canonical FUND credits', owner, buildFundMint({ snapshot: (await state(fundProjectId)).rulesetSnapshot, beneficiary, tokenCount: amount, kind: 'offchain-contribution' }))
    }
    await rules(fundProjectId, 'finish-success-minting')
    await send('Attach canonical FUND ERC20', owner, buildFundDeployErc20({ chainId: CHAIN_ID, projectId: fundProjectId, projectName: 'Sticky custody fork', salt }))
    const fund = (await state(fundProjectId)).tokenAddress
    assert(fund)
    await send('Claim owner FUND while preserving another holder’s credits', owner, buildFundClaimCredits({ chainId: CHAIN_ID, projectId: fundProjectId, holder: owner, beneficiary: owner, tokenCount: ownerMint, tokenAddress: fund }))

    const deployed = await sendData('Deploy compiled stock JBStickyDeployer', owner, encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [controller, terminal] }))
    const factory = deployed.contractAddress
    assert(factory)
    // Test-process-only discovery entry; finally restores the previous object.
    registry.JBStickyDeployer = { ...oldStickyRegistry, [CHAIN_ID]: factory }
    async function deployPool(underlying: Address, name: string, tax = 0n): Promise<Pool> {
      const receipt = await send('Deploy stock Sticky pool: ' + name, owner, { chainId: CHAIN_ID, address: factory!, abi: artifact.abi, functionName: 'deployStickyFor', args: [underlying, name, 'SHARE', URI, tax, [owner], false], value: fee })
      for (const log of receipt.logs) if (isAddressEqual(log.address, factory!)) {
        try {
          const event = decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics })
          if (event.eventName === 'DeploySticky') {
            const args = event.args as unknown as { projectId: bigint; token: Address }
            return { projectId: args.projectId, share: args.token }
          }
        } catch { /* Unrelated factory event. */ }
      }
      throw new Error('Missing canonical DeploySticky receipt.')
    }
    const amplified = await deployPool(fund, 'Amplified principal')
    const nested = await deployPool(amplified.share, 'Nested principal')
    const dust = await deployPool(fund, 'Taxed dust', 1000n)
    const orphaned = await deployPool(fund, 'Orphaned then granted')
    const empty = await deployPool(fund, 'Empty orphaned pool')
    await approve(fund, LARGE_BACKING + 4n * MICRO + 20n)
    await stake(amplified, fund, 2n * MICRO)
    await donate(amplified, fund, LARGE_BACKING - 2n * MICRO)
    await approve(amplified.share, MICRO + 1n)
    await stake(nested, amplified.share, MICRO)
    await donate(nested, amplified.share, 1n)
    await transfer(nested.share, owner, alice, 1n, 'Give Alice one nested SHARE atom with fractional amplified backing')
    await stake(dust, fund, 3n * MICRO)
    await donate(dust, fund, 1n)
    await transfer(dust.share, owner, carol, 1n, 'Give Carol one SHARE atom in the dust pool')
    await donate(orphaned, fund, 7n)
    await stake(orphaned, fund, MICRO, dave)
    await donate(orphaned, fund, 1n)
    await donate(empty, fund, 11n)
    await transfer(fund, owner, terminal, 17n, 'Transfer unaccounted FUND directly to the shared terminal')
    await send('Real taxed partial cashout leaves backing for remaining shares', owner, { chainId: CHAIN_ID, address: terminal, abi: jbMultiTerminalAbi, functionName: 'cashOutTokensOf', args: [owner, dust.projectId, MICRO, fund, 1n, owner, '0x'] })
    assert.equal(await client.readContract({ address: fund, abi: erc20Abi, functionName: 'allowance', args: [owner, terminal] }), 0n)
    assert.equal(await client.readContract({ address: amplified.share, abi: erc20Abi, functionName: 'allowance', args: [owner, terminal] }), 0n)
    for (const pool of [amplified, nested, dust, orphaned, empty]) assert.equal(await client.readContract({ address: tokens, abi: jbTokensAbi, functionName: 'totalCreditSupplyOf', args: [pool.projectId] }), 0n)

    const snapshotBlock = await client.getBlock()
    assert(snapshotBlock.number !== null)
    const snapshotInput = { chainId: CHAIN_ID, projectId: fundProjectId, snapshotBlockNumber: snapshotBlock.number, creationBlockNumber: creation.blockNumber, logBlockWindow: 64n } as const
    await assert.rejects(readFundOwnershipSnapshot(client, snapshotInput), /Sticky stakers/)
    const snapshot = await readFundOwnershipForGlobalSnapshot(client, snapshotInput)
    assert(snapshot.stickyCustody)
    assert.equal(snapshot.stickyCustody.pools.length, 5)
    const pools = snapshot.stickyCustody.pools
    const a = pools.find(pool => pool.projectId === amplified.projectId)!
    const b = pools.find(pool => pool.projectId === nested.projectId)!
    const c = pools.find(pool => pool.projectId === dust.projectId)!
    const d = pools.find(pool => pool.projectId === orphaned.projectId)!
    const e = pools.find(pool => pool.projectId === empty.projectId)!
    assert.equal(a.backing, LARGE_BACKING)
    assert.equal(b.backing, MICRO + 1n)
    assert.equal(b.totalShareSupply, MICRO)
    assert.equal(c.totalShareSupply, 2n * MICRO)
    assert(c.shareOwnedBacking * 3n * MICRO > (3n * MICRO + 1n) * c.totalShareSupply, 'A taxed exit increases retained backing per remaining share.')
    assert.equal(d.orphanedBacking, 7n)
    assert.equal(d.shareOwnedBacking, MICRO + 1n)
    assert.equal(e.totalShareSupply, 0n)
    assert.equal(e.recordedOrphanedBacking, 0n)
    assert.equal(e.orphanedBacking, 11n)
    assert.equal(e.shareOwnedBacking, 0n)
    const beneficiaries = snapshot.beneficialHolders!
    const weightOf = (holder: Address) => beneficiaries.find(row => isAddressEqual(row.holder, holder))!.weight
    const expectedAlice = ownershipWeight(LARGE_BACKING * (MICRO + 1n), 2n * MICRO * MICRO)
    assert.deepEqual(weightOf(alice), expectedAlice)
    assert.deepEqual(weightOf(carol), ownershipWeight(c.shareOwnedBacking, c.totalShareSupply))
    assert.deepEqual(weightOf(dave), ownershipWeight(MICRO + 1n))
    assert.deepEqual(weightOf(bob), ownershipWeight(parseEther('50')))
    assert.deepEqual(sumOwnershipWeights(beneficiaries.map(row => row.weight)), ownershipWeight(snapshot.totalFundSupply))
    assert.equal(beneficiaries.reduce((sum, row) => sum + row.balance, 0n), snapshot.totalFundSupply)
    const rawTerminal = snapshot.holders.find(row => isAddressEqual(row.holder, terminal))!
    const expectedResidual = rawTerminal.balance - a.shareOwnedBacking - c.shareOwnedBacking - d.shareOwnedBacking
    assert(expectedResidual >= 35n, 'Orphans and naked transfers retain their actual terminal identity.')
    assert.deepEqual(weightOf(terminal), ownershipWeight(expectedResidual))
    const fractionalNested = b.allocatedUnderlying.find(row => isAddressEqual(row.holder, alice))!
    assert.deepEqual(fractionalNested.weight, ownershipWeight(MICRO + 1n, MICRO))
    const discardedByPrematureFlooring = ownershipWeight(LARGE_BACKING, 2n * MICRO * MICRO)
    assert(discardedByPrematureFlooring.numerator / discardedByPrematureFlooring.denominator > 0n)

    await transfer(nested.share, owner, alice, 1n, 'Move another nested SHARE atom after the snapshot')
    const historical = await readFundOwnershipForGlobalSnapshot(client, snapshotInput)
    assert.deepEqual(historical.beneficialHolders, snapshot.beneficialHolders, 'Later SHARE transfers must not change historical beneficial ownership.')
    console.log(JSON.stringify({ result: 'passed', chainId: CHAIN_ID, forkBlock: originalBlock.number?.toString(), snapshotBlock: snapshotBlock.number.toString(), fundProjectId: fundProjectId.toString(), factory, poolCount: pools.length, transactions: records.length, totalFundSupply: snapshot.totalFundSupply.toString(), terminalResidual: expectedResidual.toString(), aliceExactWeight: { numerator: expectedAlice.numerator.toString(), denominator: expectedAlice.denominator.toString() }, nestedFractionPreserved: true, taxedExitVerified: true, orphanedAndNakedDonationsExcluded: true, grantBeneficiaryVerified: true, historicalSnapshotStable: true, records }, null, 2))
  } finally {
    try {
      if (oldStickyRegistry === undefined) delete registry.JBStickyDeployer
      else registry.JBStickyDeployer = oldStickyRegistry
    } finally {
      assert.equal(await mutate('evm_revert', [initial]), true)
      console.log('Restored initial local Base fork state and in-memory SDK registry. No live transactions were sent.')
    }
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
