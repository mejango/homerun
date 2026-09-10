/**
 * Canonical FUND ownership-history integration proof on the local Base fork.
 * Requires Anvil at the literal http://127.0.0.1:8567, chain 8453. No live writes,
 * existing project mutations, private keys, USDC, or external deployments.
 * Run: node --import tsx scripts/verify-fund-snapshot-fork.mts
 */
import assert from 'node:assert/strict'
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, isAddressEqual, parseEther, toHex, zeroAddress, type Address, type Chain, type Hex } from 'viem'
import { base } from 'viem/chains'
import { jbControllerAbi, jbProjectsAbi } from '@bananapus/nana-sdk-core'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { buildFundClaimCredits, buildFundDeployErc20, buildFundLaunch, buildFundMint, buildFundRulesetChange, type FundRulesetAction, type FundTransaction } from '../src/lib/fund-contracts.ts'
import { readFundProjectState } from '../src/lib/fund-state.ts'
import { checkLaunchDeployment, verifyFundLaunch } from '../src/lib/fund-launch-verification.ts'
import { readFundOwnershipSnapshot } from '../src/lib/fund-snapshot.ts'
import { buildFundSnapshotManifest, fundSnapshotManifestHash, parseFundSnapshotManifest, serializeFundSnapshotManifest, verifyFundSnapshotHistory } from '../src/lib/fund-snapshot-manifest.ts'
import { INITIAL_INCOME_SUPPLY } from '../src/lib/income-contracts.ts'
import { simulateStateChangingTransaction } from '../src/lib/transaction-simulation.ts'

const URL = 'http://127.0.0.1:8567'
const CHAIN_ID = 8453
// Retain Base's runtime formatters while using the generic Chain type expected
// by the application's PublicClient adapters. RPC chain checks remain explicit.
const client = createPublicClient({ chain: base as Chain, transport: http(URL, { timeout: 180_000 }), cacheTime: 0, pollingInterval: 100 })
const owner: Address = '0x00000000000000000000000000000000736e6101'
const alice: Address = '0x00000000000000000000000000000000736e6102'
const bob: Address = '0x00000000000000000000000000000000736e6103'
const carol: Address = '0x00000000000000000000000000000000736e6104'
const dave: Address = '0x00000000000000000000000000000000736e6105'
// Domain separation only: this script does not deploy, approve, or call a helper.
const helper: Address = '0x00000000000000000000000000000000736e6106'
const salt = `0x${'73'.repeat(32)}` as Hex
let transactions = 0

async function rawRpc(method: string, params: unknown[] = []): Promise<unknown> {
  assert.equal(URL, 'http://127.0.0.1:8567')
  assert.equal(client.transport.url, URL)
  return (client.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method, params })
}

async function assertLocalAnvil() {
  assert.equal(URL, 'http://127.0.0.1:8567')
  assert.equal(client.transport.url, URL)
  assert.equal(await client.getChainId(), CHAIN_ID)
  assert(await rawRpc('anvil_nodeInfo'), 'No state changes are permitted outside local Anvil.')
}

async function mutate(method: string, params: unknown[] = []) {
  await assertLocalAnvil()
  return rawRpc(method, params)
}

async function send(label: string, account: Address, request: FundTransaction) {
  await assertLocalAnvil()
  assert.equal(request.chainId, CHAIN_ID)
  await mutate('evm_increaseTime', [1])
  await mutate('evm_mine')
  const data = encodeFunctionData(request)
  await simulateStateChangingTransaction(client, { from: account, to: request.address, data, value: request.value, gas: 30_000_000n })
  const wallet = createWalletClient({ account, chain: base, transport: http(URL, { timeout: 180_000 }) })
  assert.equal(wallet.transport.url, URL)
  await assertLocalAnvil()
  const hash = await wallet.sendTransaction({ to: request.address, data, value: request.value, gas: 30_000_000n })
  const receipt = await client.waitForTransactionReceipt({ hash })
  assert.equal(receipt.status, 'success')
  assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash)
  transactions++
  console.log(`PASS ${label}: ${hash}`)
  return receipt
}

async function state(projectId: bigint) {
  return readFundProjectState(client, { chainId: CHAIN_ID, projectId, account: owner })
}

async function rules(projectId: bigint, action: FundRulesetAction) {
  const current = await state(projectId)
  const plan = buildFundRulesetChange({ snapshots: [current.rulesetSnapshot], action, mustStartAtOrAfter: 0 })
  await send(action, owner, plan.requests[0])
}

async function main() {
  await assertLocalAnvil()
  const initialBlock = await client.getBlock()
  const initial = await mutate('evm_snapshot')
  try {
    for (const account of [owner, alice, bob, carol, dave]) {
      assert.equal((await client.getCode({ address: account })) ?? '0x', '0x', 'Test fixtures must have no delegated code.')
      await mutate('anvil_setBalance', [account, toHex(parseEther('20'))])
      await mutate('anvil_impersonateAccount', [account])
    }
    const fee = await client.readContract({ address: v6Address('JBProjects', CHAIN_ID), abi: jbProjectsAbi, functionName: 'creationFee' })
    const input = {
      owner, sender: owner, chainIds: [CHAIN_ID], projectUri: 'ipfs://QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH',
      salt, mustStartAtOrAfter: 0, creationFees: { [CHAIN_ID]: fee },
    }
    const request = buildFundLaunch(input).requests[0]
    await checkLaunchDeployment(client, request)
    const creation = await send('Create a new FUND project', owner, request)
    const projectId = await verifyFundLaunch(client, request, input, creation, false)
    await rules(projectId, 'close')
    await rules(projectId, 'enable-success-minting')
    for (const beneficiary of [alice, bob]) {
      await send('Mint 500 FUND credits for a successful offchain contribution', owner, buildFundMint({
        snapshot: (await state(projectId)).rulesetSnapshot, beneficiary, tokenCount: parseEther('500'), kind: 'offchain-contribution',
      }))
    }
    await rules(projectId, 'finish-success-minting')
    // Core permits this balance; the application's user-facing transfer builder
    // rejects zero. Snapshot completeness still must preserve the entitlement.
    await send('Transfer one credit wei to zero via the canonical controller', bob, {
      chainId: CHAIN_ID, address: v6Address('JBController', CHAIN_ID), abi: jbControllerAbi,
      functionName: 'transferCreditsFrom', args: [bob, projectId, zeroAddress, 1n],
    })
    await send('Deploy canonical FUND ERC20', owner, buildFundDeployErc20({ chainId: CHAIN_ID, projectId, projectName: 'Snapshot fork verification', salt }))
    const tokenAddress = (await state(projectId)).tokenAddress
    assert(tokenAddress)
    for (const beneficiary of [alice, carol]) {
      await send('Claim 50 credits as FUND ERC20', alice, buildFundClaimCredits({ chainId: CHAIN_ID, projectId, holder: alice, tokenCount: parseEther('50'), beneficiary, tokenAddress }))
    }
    const lastReceipt = await send('Transfer 25 FUND ERC20 to another holder', alice, {
      chainId: CHAIN_ID, address: tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [dave, parseEther('25')],
    })
    const inputSnapshot = { chainId: CHAIN_ID, projectId, snapshotBlockNumber: lastReceipt.blockNumber, creationBlockNumber: creation.blockNumber, logBlockWindow: 8n } as const
    const snapshot = await readFundOwnershipSnapshot(client, inputSnapshot)
    assert.equal(snapshot.holders.length, 5)
    assert.equal(snapshot.totalFundSupply, parseEther('1000'))
    assert.equal(snapshot.totalCreditSupply, parseEther('900'))
    assert.equal(snapshot.totalErc20Supply, parseEther('100'))
    for (const [account, credits, erc20] of [
      [zeroAddress, 1n, 0n], [alice, parseEther('400'), parseEther('25')],
      [bob, parseEther('500') - 1n, 0n], [carol, 0n, parseEther('50')], [dave, 0n, parseEther('25')],
    ] as const) {
      const entry = snapshot.holders.find(row => isAddressEqual(row.holder, account))
      assert(entry, `Missing historical holder ${account}`)
      assert.equal(entry.creditBalance, credits)
      assert.equal(entry.erc20Balance, erc20)
      assert.equal(entry.balance, credits + erc20)
    }
    assert.equal(snapshot.evidence.eventCounts.Mint, 2)
    assert.equal(snapshot.evidence.eventCounts.ClaimTokens, 2)
    assert.equal(snapshot.evidence.eventCounts.TransferCredits, 1)
    assert.equal(snapshot.evidence.eventCounts.Transfer, 3)
    const manifest = buildFundSnapshotManifest(snapshot, { destinationChainId: CHAIN_ID, helper, launchSalt: salt })
    const parsed = parseFundSnapshotManifest(JSON.parse(serializeFundSnapshotManifest(manifest)))
    const expectedHash = fundSnapshotManifestHash(manifest)
    assert.equal(fundSnapshotManifestHash(parsed), expectedHash)
    assert.equal(parsed.holders.reduce((sum, row) => sum + BigInt(row.incomeAmount), 0n), INITIAL_INCOME_SUPPLY)
    assert.equal(parsed.holders.find(row => isAddressEqual(row.beneficiary, zeroAddress))?.claimable, false)
    const verified = await verifyFundSnapshotHistory(client, parsed, { logBlockWindow: 8n })
    assert.equal(fundSnapshotManifestHash(verified), expectedHash)

    await send('Move tokens after the chosen snapshot', carol, { chainId: CHAIN_ID, address: tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [dave, parseEther('5')] })
    const historicalAgain = await verifyFundSnapshotHistory(client, parsed, { logBlockWindow: 8n })
    assert.equal(fundSnapshotManifestHash(historicalAgain), expectedHash, 'Later transfers must not change a pinned historical ownership manifest.')
    console.log(JSON.stringify({ result: 'passed', chainId: CHAIN_ID, forkBlock: initialBlock.number?.toString(), projectId: projectId.toString(), snapshotBlock: snapshot.blockNumber.toString(), holderCount: snapshot.holders.length, totalFund: '1000', totalCredits: '900', totalErc20: '100', manifestHash: expectedHash, root: manifest.merkleRoot, transactions, eventCounts: snapshot.evidence.eventCounts, historicalSnapshotUnchangedAfterTransfer: true }, null, 2))
  } finally {
    assert.equal(await mutate('evm_revert', [initial]), true)
    console.log('Restored initial local Base fork state. No live transactions were sent.')
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
