/**
 * Real V6 contracts, isolated Anvil state only. Never accepts a live write URL.
 *
 * anvil --host 127.0.0.1 --port 8647 --chain-id 1 \
 *   --fork-url https://juicebox.center/v1/rpc/1 \
 *   --fork-header 'Origin: https://homerun.money' --timeout 120000
 * node --import tsx scripts/verify-fund-fork.mts
 *
 * Remote access is read-only through Anvil. Public development accounts and
 * impersonation fund local fork copies, never Ethereum. Snapshot branches are
 * restored in finally so no test lifecycle state survives a completed run.
 */
import assert from 'node:assert/strict'
import { createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, http, isAddressEqual, parseEther, toHex, type Address, type Hex, type TransactionReceipt } from 'viem'
import { mainnet } from 'viem/chains'
import { USDC_ADDRESSES, jbProjectsAbi } from '@bananapus/nana-sdk-core'
import { prepareHookAwareCashOut, previewPay, v6Address } from '@bananapus/nana-sdk-core/v6'
import {
  FUND_WEIGHT, buildFundApproval, buildFundAssetAllowanceChange, buildFundClaimCredits,
  buildFundDeployErc20, buildFundLaunch, buildFundMint, buildFundPay, buildFundReturn,
  buildFundRulesetChange, buildFundTransferCredits, buildFundUseAllowance,
  offchainFundAmount, operatorMintAmount, type FundRulesetAction, type FundTransaction,
} from '../src/lib/fund-contracts.ts'
import { readFundProjectState, type FundProjectState } from '../src/lib/fund-state.ts'
import { checkLaunchDeployment, verifyFundLaunch } from '../src/lib/fund-launch-verification.ts'
import { simulateStateChangingTransaction } from '../src/lib/transaction-simulation.ts'

const LOCAL_RPC = 'http://127.0.0.1:8647' as const
const CHAIN_ID = 1
const client = createPublicClient({ chain: mainnet, transport: http(LOCAL_RPC, { timeout: 180_000 }), cacheTime: 0, pollingInterval: 100 })
// Deliberate local impersonation fixtures. Well-known Anvil mnemonic addresses
// can have EIP-7702 delegated code on Ethereum, so do not assume they are EOAs.
// No private keys or user wallets are accessed.
const owner: Address = '0x0000000000000000000000000000000064657601'
const holder: Address = '0x0000000000000000000000000000000064657602'
const recipient: Address = '0x0000000000000000000000000000000064657603'
const seller: Address = '0x0000000000000000000000000000000064657604'
const circleReserve: Address = '0x55FE002aefF02F77364de339a1292923A15844B8'
const usdc = USDC_ADDRESSES[CHAIN_ID]
const terminal = v6Address('JBMultiTerminal', CHAIN_ID)
const records: { step: string; block: string; hash: Hex; gasUsed: string }[] = []

function assertLocal() {
  assert.equal(LOCAL_RPC, 'http://127.0.0.1:8647')
  assert.equal(client.transport.url, LOCAL_RPC, 'No remote write transport is permitted.')
}

async function localRpc(method: string, params: unknown[] = []): Promise<unknown> {
  assertLocal()
  // This RPC type intentionally admits Anvil methods only after a literal-URL
  // assertion. No user-supplied transport or endpoint enters this script.
  return (client.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method, params })
}

async function send(step: string, sender: Address, request: FundTransaction): Promise<TransactionReceipt> {
  assertLocal()
  assert.equal(request.chainId, CHAIN_ID)
  assert.equal(await client.getChainId(), CHAIN_ID)
  assert(await localRpc('anvil_nodeInfo'), 'Writes require Anvil, not a live RPC node.')
  await localRpc('evm_increaseTime', [1])
  await localRpc('evm_mine')
  const data = encodeFunctionData(request)
  await simulateStateChangingTransaction(client, { from: sender, to: request.address, data, value: request.value, gas: 30_000_000n })
  const wallet = createWalletClient({ account: sender, chain: mainnet, transport: http(LOCAL_RPC, { timeout: 180_000 }) })
  assert.equal(wallet.transport.url, LOCAL_RPC)
  const hash = await wallet.sendTransaction({ to: request.address, data, value: request.value, gas: 30_000_000n })
  const receipt = await client.waitForTransactionReceipt({ hash })
  assert.equal(receipt.status, 'success', step)
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  assert.equal(block.hash, receipt.blockHash)
  records.push({ step, block: receipt.blockNumber.toString(), hash, gasUsed: receipt.gasUsed.toString() })
  console.log(`PASS ${step}: block ${receipt.blockNumber}, gas ${receipt.gasUsed}, ${hash}`)
  return receipt
}

async function balance(account: Address): Promise<bigint> {
  return client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] })
}

async function state(projectId: bigint, account = owner): Promise<FundProjectState> {
  const result = await readFundProjectState(client, { chainId: CHAIN_ID, projectId, account })
  assert.equal(result.supportedController, true)
  assert.equal(result.supportedTerminals, true)
  assert.equal(result.knownOwnerWrapper, true)
  assert.equal(result.hasPendingRuleset, false)
  assert.equal(result.terminals.length, 2, 'The SDK registers both MultiTerminal and router registry.')
  assert.equal(result.accountingContexts.length, 1, 'The router is not a second treasury.')
  assert(isAddressEqual(result.accountingContexts[0].token, usdc))
  assert.deepEqual(result.linkedChainIds, [CHAIN_ID])
  return result
}

async function rules(projectId: bigint, action: FundRulesetAction) {
  const current = await state(projectId)
  const plan = buildFundRulesetChange({ snapshots: [current.rulesetSnapshot], action, mustStartAtOrAfter: 0 })
  assert.equal(plan.requests.length, 1)
  await send(`Rules: ${action}`, owner, plan.requests[0])
  const next = await state(projectId)
  assert.equal(next.metadata.pausePay, plan.configurations[0].metadata.pausePay)
  assert.equal(next.metadata.cashOutTaxRate, plan.configurations[0].metadata.cashOutTaxRate)
  assert.equal(next.metadata.allowOwnerMinting, plan.configurations[0].metadata.allowOwnerMinting)
  return next
}

async function approve(account: Address, projectId: bigint, amount: bigint) {
  const request = buildFundApproval({ chainId: CHAIN_ID, projectId, terminal, token: usdc, amount })
  assert(request)
  await send(`Approve exactly ${formatUnits(amount, 6)} USDC`, account, request)
  assert.equal(await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'allowance', args: [account, terminal] }), amount)
}

async function pay(projectId: bigint, amount: bigint) {
  await approve(holder, projectId, amount)
  const before = await state(projectId, holder)
  const quote = await previewPay(client, { chainId: CHAIN_ID, projectId, terminal, token: usdc, amount, beneficiary: holder })
  const minimum = quote.beneficiaryTokenCount * 99n / 100n
  assert(minimum > 0n)
  await send('Contribute USDC with a protected FUND quote', holder, buildFundPay({ chainId: CHAIN_ID, projectId, terminal, token: usdc, amount, beneficiary: holder, minReturnedTokens: minimum }))
  const after = await state(projectId, holder)
  assert.equal(after.totalBalance - before.totalBalance, quote.beneficiaryTokenCount)
  assert.equal(after.accountingContexts[0].balance - before.accountingContexts[0].balance, amount)
  assert.equal(after.pendingReservedTokens, 0n)
  return after
}

async function returnFunds(projectId: bigint, amount: bigint, reason: 'refunds' | 'asset-sale') {
  await approve(owner, projectId, amount)
  const before = await state(projectId)
  await send(`Return ${reason} funds without minting FUND`, owner, buildFundReturn({ chainId: CHAIN_ID, projectId, terminal, token: usdc, amount, reason, shouldReturnHeldFees: true }))
  const after = await state(projectId)
  assert.equal(after.totalSupply, before.totalSupply)
  assert(after.accountingContexts[0].balance >= before.accountingContexts[0].balance + amount)
}

async function cashOut(projectId: bigint, account: Address, label: string) {
  const before = await state(projectId, account)
  const count = before.totalBalance
  assert(count > 0n)
  const prepared = await prepareHookAwareCashOut(client, { chainId: CHAIN_ID, projectId, terminal, holder: account, beneficiary: account, tokenToReclaim: usdc, cashOutCount: count, slippageBps: 100n })
  assert(prepared.route.minimumReturn > 0n)
  const beforeUsdc = await balance(account)
  await send(label, account, prepared.transaction)
  const after = await state(projectId, account)
  const returned = await balance(account) - beforeUsdc
  assert.equal(after.totalBalance, 0n)
  assert.equal(after.totalSupply, before.totalSupply - count)
  assert(returned >= prepared.route.minimumReturn)
  console.log(`  Verified ${formatUnits(returned, 6)} USDC returned to unstaked holder.`)
}

async function main() {
  assertLocal()
  const node = await localRpc('anvil_nodeInfo')
  assert(node && typeof node === 'object', 'This test requires a local Anvil fork.')
  assert.equal(await client.getChainId(), CHAIN_ID)
  const initialBlock = await client.getBlock()
  console.log(`Ethereum fork starts at block ${initialBlock.number}; write endpoint fixed to ${LOCAL_RPC}.`)
  const initialSnapshot = await localRpc('evm_snapshot')
  try {
    for (const account of [owner, holder, recipient, seller, circleReserve]) {
      if (account !== circleReserve) assert.equal((await client.getCode({ address: account })) ?? '0x', '0x', 'Test fixtures must be plain accounts with no delegated code.')
      await localRpc('anvil_setBalance', [account, toHex(parseEther('100'))])
      await localRpc('anvil_impersonateAccount', [account])
    }
    const funding = 5_000n * 10n ** 6n
    assert(await balance(circleReserve) >= funding * 2n, 'The known reserve does not have enough USDC in this fork.')
    for (const account of [owner, holder]) await send('Prefund a local fork test account with USDC', circleReserve, { chainId: CHAIN_ID, address: usdc, abi: erc20Abi, functionName: 'transfer', args: [account, funding] })

    const fee = await client.readContract({ address: v6Address('JBProjects', CHAIN_ID), abi: jbProjectsAbi, functionName: 'creationFee' })
    const input = {
      owner, sender: owner, chainIds: [CHAIN_ID],
      projectUri: 'ipfs://QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH',
      salt: `0x${'64'.repeat(32)}` as Hex, mustStartAtOrAfter: 0, creationFees: { [CHAIN_ID]: fee },
    }
    const launch = buildFundLaunch(input).requests[0]
    await checkLaunchDeployment(client, launch)
    const receipt = await send('Launch initial FUND only', owner, launch)
    const projectId = await verifyFundLaunch(client, launch, input, receipt, false)
    const launched = await state(projectId)
    assert(isAddressEqual(launched.owner, owner))
    assert.equal(launched.ruleset.weight, FUND_WEIGHT)
    assert.equal(launched.metadata.cashOutTaxRate, 1_000)
    assert.equal(launched.metadata.allowOwnerMinting, false)
    assert.equal(launched.tokenAddress, null)
    assert.equal(launched.totalSupply, 0n)
    assert.equal(launched.accountingContexts[0].payoutLimits.length, 0)
    assert.equal(launched.accountingContexts[0].surplusAllowances.length, 0)
    assert(launched.permissions.queueRulesets)
    assert.equal((await state(projectId, holder)).permissions.queueRulesets, false)

    const funded = await pay(projectId, 1_000n * 10n ** 6n)
    await rules(projectId, 'pause')
    await rules(projectId, 'resume')
    const branchSnapshot = await localRpc('evm_snapshot')

    await rules(projectId, 'close')
    let current = await state(projectId)
    const context = current.accountingContexts[0]
    const budget = 400n * 10n ** 6n
    const allowanceInput = { chainId: CHAIN_ID, terminal, token: usdc, currency: context.currency, amount: budget }
    const allowance = buildFundAssetAllowanceChange({ snapshots: [current.rulesetSnapshot], mustStartAtOrAfter: 0, allowances: [allowanceInput] })
    await send('Configure an explicit bounded asset allowance', owner, allowance.requests[0])
    current = await state(projectId)
    assert.equal(current.accountingContexts[0].surplusAllowances[0].amount, budget)
    const withdrawalInput = { snapshot: current.rulesetSnapshot, terminal, token: usdc, amount: budget, currency: context.currency, minTokensPaidOut: 1n, beneficiary: seller, feeBeneficiary: owner }
    // Quote the state-changing withdrawal read-only, then protect the actual
    // reviewed request using the quoted net proceeds instead of its gross size.
    const quoteRequest = buildFundUseAllowance(withdrawalInput)
    const quoteData = await simulateStateChangingTransaction(client, { from: owner, to: quoteRequest.address, data: encodeFunctionData(quoteRequest) })
    const netQuote = decodeFunctionResult({ ...quoteRequest, data: quoteData }) as bigint
    assert(netQuote > 0n && netQuote <= budget)
    const sellerBefore = await balance(seller)
    await send('Spend the asset allowance with protected net proceeds', owner, buildFundUseAllowance({ ...withdrawalInput, minTokensPaidOut: netQuote * 99n / 100n }))
    assert.equal(await balance(seller) - sellerBefore, netQuote)
    current = await state(projectId)
    const revoke = buildFundAssetAllowanceChange({ snapshots: [current.rulesetSnapshot], mustStartAtOrAfter: 0, allowances: [{ ...allowanceInput, amount: 0n }] })
    await send('Explicitly revoke the asset allowance', owner, revoke.requests[0])
    assert.equal((await state(projectId)).accountingContexts[0].surplusAllowances.length, 0)

    current = await rules(projectId, 'enable-success-minting')
    const offline = offchainFundAmount('100')
    await send('Mint FUND for a successful offchain contribution', owner, buildFundMint({ snapshot: current.rulesetSnapshot, beneficiary: recipient, tokenCount: offline, kind: 'offchain-contribution' }))
    assert.equal((await state(projectId, recipient)).totalBalance, offline)
    current = await state(projectId)
    const operatorShare = operatorMintAmount(current.totalSupplyWithReservedTokens, current.totalBalance, 2_000)
    await send('Issue the operator 20% FUND share', owner, buildFundMint({ snapshot: current.rulesetSnapshot, beneficiary: owner, tokenCount: operatorShare, kind: 'operator-share' }))
    current = await state(projectId)
    assert.equal(current.totalBalance * 10_000n / current.totalSupply, 2_000n)
    await rules(projectId, 'finish-success-minting')

    const creditTransfer = funded.totalBalance / 10n
    const creditBefore = await state(projectId, holder)
    await send('Transfer unstaked FUND credits', holder, buildFundTransferCredits({ chainId: CHAIN_ID, projectId, holder, recipient, creditCount: creditTransfer }))
    assert.equal((await state(projectId, holder)).creditBalance, creditBefore.creditBalance - creditTransfer)
    await send('Deploy the vanilla FUND ERC20', owner, buildFundDeployErc20({ chainId: CHAIN_ID, projectId, projectName: 'Homerun fork verification', salt: `0x${'65'.repeat(32)}` }))
    current = await state(projectId, holder)
    assert(current.tokenAddress)
    const claim = current.creditBalance / 2n
    await send('Claim FUND credits into ERC20 tokens without staking', holder, buildFundClaimCredits({ chainId: CHAIN_ID, projectId, holder, beneficiary: holder, tokenCount: claim, tokenAddress: current.tokenAddress }))
    assert.equal((await state(projectId, holder)).erc20Balance, claim)
    await send('Transfer vanilla FUND ERC20 tokens', holder, { chainId: CHAIN_ID, address: current.tokenAddress, abi: erc20Abi, functionName: 'transfer', args: [recipient, claim / 2n] })
    assert.equal((await state(projectId, recipient)).erc20Balance, claim / 2n)
    await returnFunds(projectId, 600n * 10n ** 6n, 'asset-sale')
    await rules(projectId, 'asset-sale-refunds')
    await cashOut(projectId, holder, 'Cash out mixed credits and ERC20 FUND after asset sale')
    await cashOut(projectId, owner, 'Cash out operator FUND after asset sale')
    await cashOut(projectId, recipient, 'Cash out offchain-contributor and transferred FUND after asset sale')

    assert.equal(await localRpc('evm_revert', [branchSnapshot]), true)
    current = await state(projectId, holder)
    assert.equal(current.totalBalance, funded.totalBalance)
    assert.equal(current.tokenAddress, null)
    await rules(projectId, 'failure-refunds')
    await returnFunds(projectId, 50n * 10n ** 6n, 'refunds')
    current = await state(projectId)
    assert.equal(current.metadata.cashOutTaxRate, 0)
    assert.equal(current.accountingContexts[0].payoutLimits.length, 0)
    assert.equal(current.accountingContexts[0].surplusAllowances.length, 0)
    await cashOut(projectId, holder, 'Claim the failed campaign refund with unstaked FUND credits')
    assert.equal((await state(projectId)).totalSupply, 0n)
    console.log(JSON.stringify({ result: 'passed', chainId: CHAIN_ID, forkBlock: initialBlock.number?.toString(), projectId: projectId.toString(), transactionCount: records.length, transactions: records }, null, 2))
  } finally {
    assert.equal(await localRpc('evm_revert', [initialSnapshot]), true, 'Restore the initial isolated fork state.')
    console.log('Restored initial local fork snapshot. No live transactions were sent.')
  }
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
