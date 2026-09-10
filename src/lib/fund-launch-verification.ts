import { jbControllerAbi, jbProjectsAbi, jbDirectoryAbi, jbMultiTerminalAbi, jbFundAccessLimitsAbi, jbOmnichainDeployerAbi, jbPricesAbi, USDC_ADDRESSES, type JBChainId } from '@bananapus/nana-sdk-core'
import { BASE_CURRENCY_USD, tokenCurrencyId, v6Address } from '@bananapus/nana-sdk-core/v6'
import { decodeEventLog, decodeFunctionData, encodeFunctionData, isAddressEqual, parseAbi, type Address, type PublicClient, type TransactionReceipt } from 'viem'
import { buildFundLaunch, initialFundRuleset, type FundLaunchInput, type FundTransaction } from './fund-contracts'

const safeExecutionAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
])

export async function checkLaunchDeployment(client: PublicClient, request: FundTransaction): Promise<void> {
  if (await client.getChainId() !== request.chainId) throw new Error('RPC returned the wrong chain.')
  const id = request.chainId as JBChainId
  const targets = new Set([request.address, v6Address('JBProjects', id), v6Address('JBController', id), v6Address('JBMultiTerminal', id), v6Address('JBPrices', id), USDC_ADDRESSES[id]])
  await Promise.all([...targets].map(async target => {
    const code = await client.getCode({ address: target })
    if (!code || code === '0x') throw new Error(`Juicebox V6 is not deployed at ${target} on this chain.`)
  }))
  const fee = await client.readContract({ address: v6Address('JBProjects', id), abi: jbProjectsAbi, functionName: 'creationFee' })
  if (fee !== request.value) throw new Error('The project creation fee changed. Prepare and review the updated fee before signing.')
  // Same token-keyed accounting and shared USD denomination as Juicebox Money.
  // A project whose required feed is missing would launch but reject payments.
  const price = await client.readContract({ address: v6Address('JBPrices', id), abi: jbPricesAbi, functionName: 'pricePerUnitOf', args: [0n, BigInt(tokenCurrencyId(USDC_ADDRESSES[id])), BigInt(BASE_CURRENCY_USD), 6n] })
  if (price <= 0n) throw new Error('The USDC/USD price feed is unavailable. FUND payments cannot be enabled safely on this chain.')
}

/** A Safe service hash mapping is a lookup hint, not proof of the signed call. */
async function verifyMinedCall(client: PublicClient, request: FundTransaction, input: FundLaunchInput, receipt: TransactionReceipt, safe: boolean, requireSafeSuccess = true): Promise<void> {
  const tx = await client.getTransaction({ hash: receipt.transactionHash })
  const data = encodeFunctionData(request)
  if (!safe) {
    if (!isAddressEqual(tx.from, input.sender) || !tx.to || !isAddressEqual(tx.to, request.address)
      || tx.value !== (request.value ?? 0n) || tx.input.toLowerCase() !== data.toLowerCase()) throw new Error('The mined transaction does not match this reviewed deployment.')
    return
  }
  if (!tx.to || !isAddressEqual(tx.to, input.sender)) throw new Error('This transaction was not executed by the Safe that prepared the deployment.')
  let decoded
  try { decoded = decodeFunctionData({ abi: safeExecutionAbi, data: tx.input }) }
  catch { throw new Error('This Safe execution format cannot be verified here. Keep the launch record and verify the execution in Safe.') }
  if (decoded.functionName !== 'execTransaction') throw new Error('Unsupported Safe execution method.')
  const [to, value, innerData, operation] = decoded.args
  if (!isAddressEqual(to, request.address) || value !== (request.value ?? 0n) || innerData.toLowerCase() !== data.toLowerCase() || operation !== 0) throw new Error('The Safe executed a different deployment payload.')
  if (!requireSafeSuccess) return
  const succeeded = receipt.logs.some(log => {
    if (!isAddressEqual(log.address, input.sender)) return false
    try { return decodeEventLog({ abi: safeExecutionAbi, eventName: 'ExecutionSuccess', data: log.data, topics: log.topics }).eventName === 'ExecutionSuccess' }
    catch { return false }
  })
  if (!succeeded) throw new Error('The receipt does not prove successful execution by the expected Safe.')
}

/** A failed unrelated transaction cannot unlock an unresolved launch attempt. */
export async function verifyFailedFundLaunch(client: PublicClient, request: FundTransaction, input: FundLaunchInput, receipt: TransactionReceipt, safe: boolean): Promise<void> {
  if (receipt.status !== 'reverted') throw new Error('The receipt does not prove a reverted deployment.')
  if (await client.getChainId() !== request.chainId) throw new Error('RPC returned the wrong chain.')
  const expected = buildFundLaunch(input).requests.find(value => value.chainId === request.chainId)
  if (!expected || !isAddressEqual(expected.address, request.address) || expected.value !== request.value || encodeFunctionData(expected) !== encodeFunctionData(request)) throw new Error('This request does not match the saved FUND deployment plan.')
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('The deployment receipt is no longer in the canonical chain. Check confirmation again.')
  // An outer Safe revert rolls back the execution and its events; requiring
  // ExecutionSuccess here would be impossible. The exact inner call still binds.
  await verifyMinedCall(client, request, input, receipt, safe, false)
}

/** A successful receipt alone does not establish that the intended project exists. */
export async function verifyFundLaunch(client: PublicClient, request: FundTransaction, input: FundLaunchInput, receipt: TransactionReceipt, safe: boolean): Promise<bigint> {
  if (receipt.status !== 'success') throw new Error('The deployment transaction reverted.')
  if (await client.getChainId() !== request.chainId) throw new Error('RPC returned the wrong chain.')
  const expected = buildFundLaunch(input).requests.find(value => value.chainId === request.chainId)
  if (!expected || !isAddressEqual(expected.address, request.address) || expected.value !== request.value || encodeFunctionData(expected) !== encodeFunctionData(request)) throw new Error('This request does not match the saved FUND deployment plan.')
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error('The deployment receipt is no longer in the canonical chain. Check confirmation again.')
  await verifyMinedCall(client, request, input, receipt, safe)
  const chainId = request.chainId as JBChainId
  const controller = v6Address('JBController', chainId)
  const projects = v6Address('JBProjects', chainId)
  const linked = input.chainIds.length > 1
  const launchEvent = linked ? 'LaunchRulesets' : 'LaunchProject'
  const launched: { projectId: bigint; rulesetId: bigint }[] = []
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, controller)) continue
    try {
      const decoded = decodeEventLog({ abi: jbControllerAbi, eventName: launchEvent, data: log.data, topics: log.topics })
      const expectedCaller = linked ? request.address : input.sender
      if (decoded.args.projectUri === input.projectUri && isAddressEqual(decoded.args.caller, expectedCaller)) launched.push({ projectId: decoded.args.projectId, rulesetId: decoded.args.rulesetId })
    } catch { /* Other controller events are irrelevant. */ }
  }
  if (launched.length !== 1) throw new Error('The receipt does not contain exactly one matching FUND launch. Check its execution before continuing.')
  const { projectId, rulesetId } = launched[0]
  const created = receipt.logs.filter(log => {
    if (!isAddressEqual(log.address, projects)) return false
    try {
      const { args } = decodeEventLog({ abi: jbProjectsAbi, eventName: 'Create', data: log.data, topics: log.topics })
      return args.projectId === projectId && isAddressEqual(args.caller, request.address) && isAddressEqual(args.owner, linked ? request.address : input.owner)
    } catch { return false }
  })
  if (created.length !== 1) throw new Error('This receipt does not prove creation of the matching project NFT.')
  const at = { blockNumber: receipt.blockNumber }
  const usdc = USDC_ADDRESSES[chainId]
  const terminal = v6Address('JBMultiTerminal', chainId)
  const access = v6Address('JBFundAccessLimits', chainId)
  const [owner, configured, latest, actualController, contexts, payouts, allowances, uri] = await Promise.all([
    client.readContract({ address: projects, abi: jbProjectsAbi, functionName: 'ownerOf', args: [projectId], ...at }),
    // Verify the exact launch ruleset even when its start is in the future.
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'getRulesetOf', args: [projectId, rulesetId], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'latestQueuedRulesetOf', args: [projectId], ...at }),
    client.readContract({ address: v6Address('JBDirectory', chainId), abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId], ...at }),
    client.readContract({ address: terminal, abi: jbMultiTerminalAbi, functionName: 'accountingContextsOf', args: [projectId], ...at }),
    client.readContract({ address: access, abi: jbFundAccessLimitsAbi, functionName: 'payoutLimitsOf', args: [projectId, rulesetId, terminal, usdc], ...at }),
    client.readContract({ address: access, abi: jbFundAccessLimitsAbi, functionName: 'surplusAllowancesOf', args: [projectId, rulesetId, terminal, usdc], ...at }),
    client.readContract({ address: controller, abi: jbControllerAbi, functionName: 'uriOf', args: [projectId], ...at }),
  ])
  if (!isAddressEqual(owner, input.owner)) throw new Error('The new FUND project owner differs from the reviewed owner.')
  if (!isAddressEqual(actualController as Address, controller) || uri !== input.projectUri) throw new Error('The new project controller or metadata differs from the reviewed deployment.')
  const expectedConfig = initialFundRuleset(input.mustStartAtOrAfter)
  const [ruleset, metadata] = configured
  // JBRulesets.queueFor substitutes block.timestamp only for the zero sentinel.
  // An explicit first-stage timestamp is preserved, including a past shared
  // timestamp in a linked deployment. See JBRulesets.sol:147 and :812.
  const expectedStart = input.mustStartAtOrAfter === 0 ? block.timestamp : BigInt(input.mustStartAtOrAfter)
  const expectedMetadata = linked ? { ...expectedConfig.metadata, dataHook: request.address, useDataHookForPay: true, useDataHookForCashOut: true } : expectedConfig.metadata
  const metadataMatches = (Object.keys(expectedMetadata) as (keyof typeof expectedMetadata)[]).every(key => {
    const actual = metadata[key]
    const value = expectedMetadata[key]
    return typeof value === 'string' ? typeof actual === 'string' && value.toLowerCase() === actual.toLowerCase() : actual === value
  })
  if (BigInt(ruleset.id) !== rulesetId || BigInt(latest[0].id) !== rulesetId || BigInt(ruleset.start) !== expectedStart
    || ruleset.weight !== expectedConfig.weight || ruleset.duration !== 0 || ruleset.weightCutPercent !== 0
    || !isAddressEqual(ruleset.approvalHook, expectedConfig.approvalHook) || !metadataMatches) throw new Error('The initial FUND rules differ from the reviewed configuration.')
  if (contexts.length !== 1 || !isAddressEqual(contexts[0].token, usdc) || contexts[0].decimals !== 6 || contexts[0].currency !== tokenCurrencyId(usdc) || payouts.length || allowances.length) throw new Error('The new FUND treasury or withdrawal limits differ from the reviewed configuration.')
  if (linked) {
    const extra = await client.readContract({ address: request.address, abi: jbOmnichainDeployerAbi, functionName: 'extraDataHookOf', args: [projectId, rulesetId], ...at })
    if (!isAddressEqual(extra.dataHook, expectedConfig.metadata.dataHook) || extra.useDataHookForPay || extra.useDataHookForCashOut) throw new Error('The linked FUND project has an unexpected extra data hook.')
  }
  return projectId
}
