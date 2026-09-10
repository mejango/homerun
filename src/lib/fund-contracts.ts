/**
 * Homerun's FUND adapter. Transaction construction deliberately delegates to the
 * same nana-sdk-core/v6 builders used by juicebox-money/src/lib/launch.ts.
 * This module has no wallet, browser storage, RPC, or lifecycle-state authority.
 * Callers must refresh chain reads, simulate, review and confirm each request.
 */
import { MappableAsset, NATIVE_TOKEN, USDC_ADDRESSES, jbMultiTerminalAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_USD, buildAccountingContext, buildTerminalConfigurations,
  buildRulesetConfiguration, buildRulesetMetadata, buildLaunchProjectTx,
  buildOmnichainLaunchProjectTx, buildQueueRulesetsTx, buildOmnichainQueueRulesetsTx,
  buildMintTokensTx, buildClaimTokensTx, buildPayTx, buildCashOutTx,
  buildDeployErc20Tx, buildTransferCreditsTx, v6Address,
  type JBRulesetConfig, type JBRulesetMetadata,
} from '@bananapus/nana-sdk-core/v6'
import { erc20Abi, getAddress, isAddress, zeroAddress, zeroHash, type Abi, type Address, type Hex } from 'viem'

export const FUND_WEIGHT = 10_000n * 10n ** 18n
export const FUND_INITIAL_CASH_OUT_TAX = 1_000
export const FUND_CASH_OUTS_DISABLED = 10_000
export const FUND_CHAIN_IDS = [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614] as const
const MAINNETS = new Set<number>([1, 10, 8453, 42161])
const UINT208_MAX = (1n << 208n) - 1n

export type FundTransaction = {
  chainId: number
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
}

/** Never round a user amount through Number, parseFloat, or parseUnits rounding. */
export function parseAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Unsupported amount precision.')
  const normalized = value.trim()
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) throw new Error('Enter a plain non-negative decimal amount without separators.')
  const [whole, fractional = ''] = normalized.split('.')
  if (fractional.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`)
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fractional.padEnd(decimals, '0') || '0')
  if (amount >= 1n << 256n) throw new Error('Amount exceeds uint256.')
  return amount
}

export function parsePercent(value: string): number {
  const basisPoints = parseAmount(value, 2)
  if (basisPoints > 10_000n) throw new Error('Percentage must be between 0 and 100.')
  return Number(basisPoints)
}

function address(value: string, label: string): Address {
  if (!isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error(`A valid ${label} address is required.`)
  return getAddress(value)
}

function chain(value: number): JBChainId {
  if (!(FUND_CHAIN_IDS as readonly number[]).includes(value)) throw new Error(`Unsupported FUND chain ${value}.`)
  // This SDK lookup fails closed when that protocol deployment is absent.
  v6Address('JBController', value as JBChainId)
  return value as JBChainId
}

function nonnegative(value: bigint, label: string): void {
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << 256n) throw new Error(`${label} must be an unsigned uint256.`)
}

function positive(value: bigint, label: string): void {
  nonnegative(value, label)
  if (value === 0n) throw new Error(`${label} must be greater than zero.`)
}

function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 48) throw new Error('Invalid shared ruleset start timestamp.')
}

function selectedChains(values: readonly number[]): JBChainId[] {
  if (values.length === 0 || new Set(values).size !== values.length) throw new Error('Select one or more unique chains.')
  const chains = values.map(chain)
  if (chains.some(id => MAINNETS.has(id)) && chains.some(id => !MAINNETS.has(id))) throw new Error('Production and test networks cannot share a launch.')
  return chains
}

export type FundLaunchInput = {
  owner: Address
  /** Frozen across the launch: omnichain salts are scoped to this sender. */
  sender: Address
  chainIds: readonly number[]
  projectUri: string
  salt: Hex
  /** One shared absolute timestamp on every chain; zero is permitted only for single-chain launches. */
  mustStartAtOrAfter: number
  /** Read JBProjects.creationFee separately on every chain immediately before review. */
  creationFees: Readonly<Record<number, bigint>>
}

export function initialFundRuleset(mustStartAtOrAfter = 0): JBRulesetConfig {
  timestamp(mustStartAtOrAfter)
  return buildRulesetConfiguration({
    mustStartAtOrAfter,
    weight: FUND_WEIGHT,
    metadata: buildRulesetMetadata({
      baseCurrency: BASE_CURRENCY_USD,
      cashOutTaxRate: FUND_INITIAL_CASH_OUT_TAX,
      reservedPercent: 0,
      allowOwnerMinting: false,
    }),
    // Asset price and cash reserve are modeling values, never withdrawal rights.
    splitGroups: [],
    fundAccessLimitGroups: [],
  })
}

export function buildFundLaunch(input: FundLaunchInput): {
  requests: FundTransaction[]
  review: {
    owner: Address; sender: Address; chainIds: readonly number[]; projectUri: string;
    linked: boolean; denomination: 'USD'; acceptedTreasuryToken: 'USDC';
    tokensPerDollar: string; cashOutTaxPercent: string; ownerMinting: false;
    ownerCanQueueRulesets: true; payoutLimits: 'none'; surplusAllowances: 'none';
    incomeDeployed: false; tokensInitially: 'Juicebox credits';
    salt: Hex; mustStartAtOrAfter: number; creationFees: Readonly<Record<number, bigint>>;
  }
} {
  const chains = selectedChains(input.chainIds)
  const owner = address(input.owner, 'project owner')
  const sender = address(input.sender, 'sending wallet')
  if (!/^ipfs:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(input.projectUri)) throw new Error('Publish the project metadata to IPFS before launching.')
  if (!/^0x[\da-fA-F]{64}$/.test(input.salt) || input.salt === zeroHash) throw new Error('A shared nonzero bytes32 launch salt is required.')
  timestamp(input.mustStartAtOrAfter)
  const linked = chains.length > 1
  if (linked && input.mustStartAtOrAfter === 0) throw new Error('Linked launches require one shared absolute start timestamp.')
  const rulesets = [initialFundRuleset(input.mustStartAtOrAfter)]
  const requests = chains.map(chainId => {
    const fee = input.creationFees[chainId]
    nonnegative(fee, `Current project creation fee on chain ${chainId}`)
    const usdc = address(USDC_ADDRESSES[chainId], 'USDC')
    const terminalConfigurations = buildTerminalConfigurations({
      chainId,
      accountingContexts: [buildAccountingContext(usdc, 6)],
    })
    const shared = { chainId, owner, projectUri: input.projectUri, rulesetConfigurations: rulesets, terminalConfigurations, creationFee: fee }
    if (!linked) return buildLaunchProjectTx(shared)
    const request = buildOmnichainLaunchProjectTx({
      ...shared, chainIds: chains, assets: [MappableAsset.USDC], bridge: 'ccip', salt: input.salt,
    })
    const config = request.args[request.args.length - 1] as { deployerConfigurations: readonly unknown[] }
    if (!config.deployerConfigurations.length) throw new Error(`No bridge deployments are available on ${chainId}.`)
    return request
  })
  return {
    requests,
    review: {
      owner, sender, chainIds: chains, projectUri: input.projectUri, linked,
      denomination: 'USD', acceptedTreasuryToken: 'USDC', tokensPerDollar: '10,000', cashOutTaxPercent: '10',
      ownerMinting: false, ownerCanQueueRulesets: true, payoutLimits: 'none', surplusAllowances: 'none',
      incomeDeployed: false, tokensInitially: 'Juicebox credits', salt: input.salt,
      mustStartAtOrAfter: input.mustStartAtOrAfter,
      creationFees: Object.fromEntries(chains.map(id => [id, input.creationFees[id]])),
    },
  }
}

/**
 * Complete, same-block RPC inputs. Merely reading currentRulesetOf does NOT
 * recover split groups or fund access limits: callers must enumerate those too.
 * `null` means incomplete, and is rejected instead of replacing unknown terms.
 */
export type FundRulesetSnapshot = {
  chainId: number
  projectId: bigint
  blockNumber: bigint
  controller: Address
  currentRulesetId: bigint
  upcomingRulesetId: bigint
  configuration: JBRulesetConfig | null
  /** Read actual omnichain membership, including every peer, from the chain. */
  linkedChainIds: readonly number[]
  /** Same-block accepted treasury contexts, including tokens with no access limits yet. */
  accountingContexts?: readonly { terminal: Address; token: Address; currency: number; decimals: number }[]
  /** Same-block extraDataHookOf/tiered721HookOf reads when the metadata hook is the canonical omnichain deployer. */
  omnichainHooks?: {
    dataHook: Address; useDataHookForPay: boolean; useDataHookForCashOut: boolean; tiered721Hook: Address;
    tiered721UseDataHookForCashOut?: boolean;
    /** Proven with the recorded hook's STORE.maxTierIdOf(hook), not a UI assumption. */
    tiered721HasTiers?: boolean;
  }
}

export type FundRulesetAction = 'pause' | 'resume' | 'close' | 'enable-success-minting' | 'finish-success-minting' | 'failure-refunds' | 'asset-sale-refunds'

function assertSnapshot(snapshot: FundRulesetSnapshot): JBRulesetConfig {
  const chainId = chain(snapshot.chainId)
  positive(snapshot.projectId, 'Project ID')
  positive(snapshot.blockNumber, 'Snapshot block')
  positive(snapshot.currentRulesetId, 'Current ruleset ID')
  nonnegative(snapshot.upcomingRulesetId, 'Upcoming ruleset ID')
  if (snapshot.controller.toLowerCase() !== v6Address('JBController', chainId).toLowerCase()) throw new Error('Unsupported project controller.')
  if (snapshot.upcomingRulesetId !== 0n && snapshot.upcomingRulesetId !== snapshot.currentRulesetId) throw new Error('Review the already queued ruleset before replacing project rules.')
  const config = snapshot.configuration
  if (!config || !Array.isArray(config.splitGroups) || !Array.isArray(config.fundAccessLimitGroups)) throw new Error('Read the complete current ruleset, splits and fund access limits before making changes.')
  const metadataKeys = Object.keys(buildRulesetMetadata()) as (keyof JBRulesetMetadata)[]
  if (metadataKeys.some(key => !(key in config.metadata)) || Object.keys(config.metadata).length !== metadataKeys.length) throw new Error('Incomplete or unsupported ruleset metadata.')
  if (config.duration !== 0 || config.weightCutPercent !== 0 || config.approvalHook.toLowerCase() !== zeroAddress) throw new Error('This project has a timed or approval-controlled ruleset; use the full Juicebox ruleset editor.')
  if (config.metadata.dataHook.toLowerCase() === v6Address('JBOmnichainDeployer', chainId).toLowerCase()) {
    const hooks = snapshot.omnichainHooks
    if (!hooks || hooks.dataHook.toLowerCase() !== zeroAddress || hooks.useDataHookForPay || hooks.useDataHookForCashOut) throw new Error('Read and verify the omnichain project hooks before changing rules.')
    if (hooks.tiered721Hook.toLowerCase() !== zeroAddress && (hooks.tiered721UseDataHookForCashOut !== false || hooks.tiered721HasTiers !== false)) throw new Error('This project has active or unread NFT tiers; use the full Juicebox ruleset editor.')
    // JBOmnichainDeployer reinjects itself. Passing its own address as the extra
    // hook causes JBDeployer_SelfReferentialHook and must never be queued.
    return { ...config, metadata: { ...config.metadata, dataHook: zeroAddress, useDataHookForPay: false, useDataHookForCashOut: false } }
  }
  if (config.metadata.dataHook.toLowerCase() !== zeroAddress || config.metadata.useDataHookForPay || config.metadata.useDataHookForCashOut) throw new Error('This project has a custom data hook; use the full Juicebox ruleset editor.')
  return config
}

function serialized(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)
}

export function buildFundRulesetChange(input: {
  snapshots: readonly FundRulesetSnapshot[]
  action: FundRulesetAction
  mustStartAtOrAfter: number
}): { requests: FundTransaction[]; configurations: JBRulesetConfig[]; action: FundRulesetAction } {
  if (!input.snapshots.length) throw new Error('Current onchain project configuration is required.')
  timestamp(input.mustStartAtOrAfter)
  const chains = selectedChains(input.snapshots.map(snapshot => snapshot.chainId))
  const linked = input.snapshots.some(snapshot => snapshot.linkedChainIds.length > 1)
  if (!linked && chains.length !== 1) throw new Error('Unlinked projects must be managed separately.')
  if (linked && input.mustStartAtOrAfter === 0) throw new Error('Use one shared absolute timestamp for every linked chain.')
  const configurations = input.snapshots.map(snapshot => {
    const current = assertSnapshot(snapshot)
    if (input.action !== 'failure-refunds' && input.action !== 'asset-sale-refunds' && current.fundAccessLimitGroups.some(group =>
      group.payoutLimits.some(limit => limit.amount > 0n) || group.surplusAllowances.some(limit => limit.amount > 0n))) {
      // Usage is keyed by ruleset ID. Copying a nominal limit into a new ruleset
      // silently replenishes everything already spent under that limit.
      throw new Error('Explicitly revoke the current withdrawal allowance before changing other FUND rules. Copying its nominal amount would renew already spent withdrawal rights.')
    }
    const membership = [...snapshot.linkedChainIds].sort((a, b) => a - b)
    if (linked && serialized(membership) !== serialized([...chains].sort((a, b) => a - b))) throw new Error('Read and update every linked chain together.')
    const next = structuredClone(current)
    next.mustStartAtOrAfter = input.mustStartAtOrAfter
    switch (input.action) {
      case 'pause': next.metadata.pausePay = true; break
      case 'resume':
        if (next.metadata.cashOutTaxRate !== FUND_INITIAL_CASH_OUT_TAX || next.metadata.allowOwnerMinting) throw new Error('Only a paused fundraising ruleset can resume fundraising.')
        next.metadata.pausePay = false
        break
      case 'close':
      case 'finish-success-minting':
        next.metadata.pausePay = true
        next.metadata.cashOutTaxRate = FUND_CASH_OUTS_DISABLED
        next.metadata.allowOwnerMinting = false
        break
      case 'enable-success-minting':
        if (!next.metadata.pausePay || next.metadata.cashOutTaxRate !== FUND_CASH_OUTS_DISABLED) throw new Error('Confirm the closed campaign ruleset before enabling success mints.')
        next.metadata.allowOwnerMinting = true
        break
      case 'failure-refunds':
      case 'asset-sale-refunds':
        next.metadata.pausePay = true
        next.metadata.cashOutTaxRate = 0
        next.metadata.allowOwnerMinting = false
        next.fundAccessLimitGroups = []
        break
      default: throw new Error('Unsupported FUND ruleset action.')
    }
    if (linked) {
      // RPC reconstruction may include empty groups for each chain's USDC
      // address. They have no effective allocations and must not create a
      // false cross-chain mismatch. Never drop a nonempty group.
      next.splitGroups = next.splitGroups.filter(group => group.splits.length > 0)
      next.fundAccessLimitGroups = next.fundAccessLimitGroups.filter(group => group.payoutLimits.length > 0 || group.surplusAllowances.length > 0)
    }
    return next
  })
  if (linked && configurations.some(config => serialized(config) !== serialized(configurations[0]))) throw new Error('Linked chain configurations differ; use the full omnichain ruleset editor.')
  const requests = input.snapshots.map((snapshot, index) => {
    const args = { chainId: chain(snapshot.chainId), projectId: snapshot.projectId, rulesetConfigurations: [configurations[index]], memo: `Homerun: ${input.action}` }
    const throughOmnichain = linked || snapshot.configuration?.metadata.dataHook.toLowerCase() === v6Address('JBOmnichainDeployer', chain(snapshot.chainId)).toLowerCase()
    return throughOmnichain ? buildOmnichainQueueRulesetsTx(args) : buildQueueRulesetsTx(args)
  })
  return { requests, configurations, action: input.action }
}

/** Additional operator tokens for a target share after the mint, including tokens already owned. */
export function operatorMintAmount(totalSupply: bigint, operatorBalance: bigint, targetBasisPoints: number): bigint {
  nonnegative(totalSupply, 'Total FUND supply')
  nonnegative(operatorBalance, 'Operator FUND balance')
  if (operatorBalance > totalSupply) throw new Error('Operator balance cannot exceed total supply.')
  if (!Number.isInteger(targetBasisPoints) || targetBasisPoints < 0 || targetBasisPoints >= 10_000) throw new Error('Operator share must be below 100%.')
  const numerator = BigInt(targetBasisPoints) * totalSupply - 10_000n * operatorBalance
  if (numerator <= 0n) return 0n
  const denominator = 10_000n - BigInt(targetBasisPoints)
  // Round down by at most one token wei. Never grant more than the reviewed share.
  const mint = numerator / denominator
  if (totalSupply + mint > UINT208_MAX) throw new Error('Resulting FUND supply exceeds the protocol limit.')
  return mint
}

export function offchainFundAmount(usdAmount: string): bigint {
  const usdc = parseAmount(usdAmount, 6)
  positive(usdc, 'Offchain contribution')
  const count = usdc * FUND_WEIGHT / 10n ** 6n
  if (count > UINT208_MAX) throw new Error('FUND mint exceeds the protocol supply limit.')
  return count
}

export function buildFundMint(input: {
  snapshot: FundRulesetSnapshot
  beneficiary: Address
  tokenCount: bigint
  kind: 'offchain-contribution' | 'operator-share'
  memo?: string
}): FundTransaction {
  const current = assertSnapshot(input.snapshot)
  if (!current.metadata.pausePay || current.metadata.cashOutTaxRate !== FUND_CASH_OUTS_DISABLED || !current.metadata.allowOwnerMinting) throw new Error('Confirm the closed campaign success-minting ruleset before minting FUND.')
  if (input.kind === 'offchain-contribution' && (current.weight !== FUND_WEIGHT || current.metadata.baseCurrency !== BASE_CURRENCY_USD)) throw new Error('The FUND issuance rate changed; review offchain allocations with the full project terms.')
  positive(input.tokenCount, 'FUND mint')
  if (input.tokenCount > UINT208_MAX) throw new Error('FUND mint exceeds the protocol supply limit.')
  return buildMintTokensTx({ chainId: chain(input.snapshot.chainId), projectId: input.snapshot.projectId,
    tokenCount: input.tokenCount, beneficiary: address(input.beneficiary, 'beneficiary'),
    useReservedPercent: false, memo: input.memo ?? `Homerun: ${input.kind}` })
}

export type FundTerminalContext = {
  chainId: number
  projectId: bigint
  /** Resolve from JBDirectory and verify the token's accounting context by RPC. */
  terminal: Address
  token: Address
}

function terminalContext(input: FundTerminalContext): { chainId: JBChainId; projectId: bigint; terminal: Address; token: Address } {
  positive(input.projectId, 'Project ID')
  const chainId = chain(input.chainId)
  const terminal = address(input.terminal, 'terminal')
  if (terminal.toLowerCase() !== v6Address('JBMultiTerminal', chainId).toLowerCase()) throw new Error('Resolve a supported project treasury terminal before building this action.')
  return { chainId, projectId: input.projectId, terminal, token: address(input.token, 'treasury token') }
}

/** Exact approval, reviewed and confirmed before a separate ERC20 funding transaction. */
export function buildFundApproval(input: FundTerminalContext & { amount: bigint }): FundTransaction | null {
  const context = terminalContext(input)
  positive(input.amount, 'Approval amount')
  if (context.token.toLowerCase() === NATIVE_TOKEN.toLowerCase()) return null
  return { chainId: context.chainId, address: context.token, abi: erc20Abi, functionName: 'approve', args: [context.terminal, input.amount] }
}

export function buildFundReturn(input: FundTerminalContext & {
  amount: bigint; reason: 'refunds' | 'asset-sale'; shouldReturnHeldFees: boolean; memo?: string
}): FundTransaction {
  const context = terminalContext(input)
  positive(input.amount, 'Returned funds')
  return { chainId: context.chainId, address: context.terminal, abi: jbMultiTerminalAbi,
    functionName: 'addToBalanceOf', args: [context.projectId, context.token, input.amount, input.shouldReturnHeldFees, input.memo ?? `Homerun: ${input.reason}`, '0x'],
    value: context.token.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? input.amount : 0n }
}

export function buildFundPay(input: FundTerminalContext & { amount: bigint; beneficiary: Address; minReturnedTokens: bigint; memo?: string }): FundTransaction {
  const context = terminalContext(input)
  positive(input.amount, 'Contribution')
  positive(input.minReturnedTokens, 'Minimum FUND received from a current quote')
  return buildPayTx({ ...context, amount: input.amount, beneficiary: address(input.beneficiary, 'beneficiary'), minReturnedTokens: input.minReturnedTokens, memo: input.memo ?? '' })
}

export function buildFundCashOut(input: FundTerminalContext & { holder: Address; tokenCount: bigint; minTokensReclaimed: bigint; beneficiary: Address }): FundTransaction {
  const context = terminalContext(input)
  positive(input.tokenCount, 'FUND to cash out')
  positive(input.minTokensReclaimed, 'Minimum proceeds from a current cash-out quote')
  return buildCashOutTx({ ...context, holder: address(input.holder, 'holder'), cashOutCount: input.tokenCount, tokenToReclaim: context.token,
    minTokensReclaimed: input.minTokensReclaimed, beneficiary: address(input.beneficiary, 'beneficiary') })
}

export function buildFundClaimCredits(input: { chainId: number; projectId: bigint; holder: Address; tokenCount: bigint; beneficiary: Address; tokenAddress: Address }): FundTransaction {
  address(input.tokenAddress, 'deployed FUND ERC20')
  positive(input.projectId, 'Project ID')
  positive(input.tokenCount, 'Credits to claim')
  return buildClaimTokensTx({ chainId: chain(input.chainId), projectId: input.projectId, holder: address(input.holder, 'holder'), tokenCount: input.tokenCount, beneficiary: address(input.beneficiary, 'beneficiary') })
}

export function buildFundTransferCredits(input: { chainId: number; projectId: bigint; holder: Address; creditCount: bigint; recipient: Address }): FundTransaction {
  positive(input.projectId, 'Project ID')
  positive(input.creditCount, 'Credits to transfer')
  return buildTransferCreditsTx({ ...input, chainId: chain(input.chainId), holder: address(input.holder, 'holder'), recipient: address(input.recipient, 'recipient') })
}

export function buildFundDeployErc20(input: { chainId: number; projectId: bigint; projectName: string; salt: Hex }): FundTransaction {
  positive(input.projectId, 'Project ID')
  if (!input.projectName.trim()) throw new Error('The FUND token needs a name.')
  if (!/^0x[\da-fA-F]{64}$/.test(input.salt)) throw new Error('A bytes32 token deployment salt is required.')
  return buildDeployErc20Tx({ chainId: chain(input.chainId), projectId: input.projectId, name: `${input.projectName.trim()} FUND`, symbol: 'FUND', salt: input.salt })
}

/** A new, explicitly reviewed allowance on one chain, never a modeled asset budget. */
export type FundAssetAllowance = {
  chainId: number
  terminal: Address
  token: Address
  /** The token's verified accounting-context currency, not a display denomination. */
  currency: number
  /** Gross treasury-token units for this new ruleset only; zero explicitly revokes it. */
  amount: bigint
}

const UINT224_MAX = (1n << 224n) - 1n

function assetAllowanceContext(snapshot: FundRulesetSnapshot, input: Pick<FundAssetAllowance, 'terminal' | 'token' | 'currency'>) {
  const context = terminalContext({ chainId: snapshot.chainId, projectId: snapshot.projectId, terminal: input.terminal, token: input.token })
  if (context.token.toLowerCase() !== USDC_ADDRESSES[context.chainId]?.toLowerCase() && context.token.toLowerCase() !== NATIVE_TOKEN.toLowerCase()) {
    throw new Error('Use the verified canonical USDC or native-token treasury for asset withdrawals.')
  }
  const matches = snapshot.accountingContexts?.filter(item => item.terminal.toLowerCase() === context.terminal.toLowerCase() && item.token.toLowerCase() === context.token.toLowerCase())
  if (!matches || matches.length !== 1) throw new Error('Read exactly one matching treasury accounting context before configuring or spending its allowance.')
  if (!Number.isInteger(input.currency) || input.currency < 0 || input.currency >= 2 ** 32 || input.currency !== matches[0].currency) {
    throw new Error('Use the treasury token’s verified accounting currency for the allowance; currency conversion is not supported here.')
  }
  if (matches[0].decimals !== (context.token.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? 18 : 6)) throw new Error('The treasury token has an unsupported accounting precision.')
  return context
}

function boundedAssetAllowance(amount: bigint, allowZero = false): void {
  if (allowZero) nonnegative(amount, 'Asset allowance')
  else positive(amount, 'Asset allowance')
  // type(uint224).max is the protocol's unlimited-access sentinel, not a budget.
  if (amount >= UINT224_MAX) throw new Error('Enter a finite bounded asset allowance below uint224 maximum.')
}

function closedAssetRuleset(snapshot: FundRulesetSnapshot): JBRulesetConfig {
  const current = assertSnapshot(snapshot)
  if (!current.metadata.pausePay || current.metadata.cashOutTaxRate !== FUND_CASH_OUTS_DISABLED) {
    throw new Error('Confirm the closed campaign ruleset with contributions and FUND cash-outs disabled before configuring or spending the asset allowance.')
  }
  return current
}

/**
 * Explicitly replaces the selected treasury's allowance. The caller must review
 * this as a NEW budget: JBTerminalStore usage is keyed by ruleset ID and does not
 * carry forward. Existing payouts or any other nonzero allowance fail closed,
 * rather than being silently replenished, removed, or assumed unspent.
 *
 * Linked projects require all peers, but the budget is granted ONLY on the
 * explicitly selected chains. The omnichain deployer forwards each chain's
 * ruleset to its controller; it does not require local treasury-token addresses
 * to be byte-identical. Every other effective rule must remain identical.
 */
export function buildFundAssetAllowanceChange(input: {
  snapshots: readonly FundRulesetSnapshot[]
  mustStartAtOrAfter: number
  allowances: readonly FundAssetAllowance[]
}): { requests: FundTransaction[]; configurations: JBRulesetConfig[]; action: 'configure-asset-allowance' } {
  if (!input.snapshots.length) throw new Error('Read the complete current FUND configuration before configuring an allowance.')
  if (!input.allowances.length) throw new Error('Select an explicit asset allowance and treasury.')
  timestamp(input.mustStartAtOrAfter)
  const chains = selectedChains(input.snapshots.map(snapshot => snapshot.chainId))
  const linked = input.snapshots.some(snapshot => snapshot.linkedChainIds.length > 1)
  if (!linked && chains.length !== 1) throw new Error('Unlinked projects must be managed separately.')
  if (linked && input.mustStartAtOrAfter === 0) throw new Error('Use one shared absolute timestamp for every linked chain.')
  const memberships = serialized([...chains].sort((a, b) => a - b))
  const selections = new Map<number, FundAssetAllowance>()
  for (const allowance of input.allowances) {
    if (!chains.includes(chain(allowance.chainId))) throw new Error('An allowance selected a chain outside the verified project membership.')
    if (selections.has(allowance.chainId)) throw new Error('Review one treasury allowance per chain in each asset-budget plan.')
    boundedAssetAllowance(allowance.amount, true)
    selections.set(allowance.chainId, allowance)
  }
  const comparable: JBRulesetConfig[] = []
  const configurations = input.snapshots.map(snapshot => {
    const current = closedAssetRuleset(snapshot)
    if (serialized([...snapshot.linkedChainIds].sort((a, b) => a - b)) !== memberships) throw new Error('Read and update every linked chain together.')
    const selected = selections.get(snapshot.chainId)
    const selectedContext = selected ? assetAllowanceContext(snapshot, selected) : undefined
    let matchingGroups = 0
    for (const group of current.fundAccessLimitGroups) {
      const selectedGroup = !!selectedContext && group.terminal.toLowerCase() === selectedContext.terminal.toLowerCase() && group.token.toLowerCase() === selectedContext.token.toLowerCase()
      if (selectedGroup) matchingGroups++
      if (group.payoutLimits.some(limit => limit.amount > 0n)) throw new Error('Existing payout limits could be replenished by a new ruleset. Review them with the full Juicebox ruleset editor.')
      if (group.surplusAllowances.some(limit => limit.amount > 0n && (!selectedGroup || limit.currency !== selected?.currency))) {
        throw new Error('Another existing allowance could be replenished by a new ruleset. Review all remaining allowances before continuing.')
      }
    }
    if (selected && matchingGroups > 1) throw new Error('The treasury returned duplicate fund access limit groups.')
    const next = structuredClone(current)
    next.mustStartAtOrAfter = input.mustStartAtOrAfter
    next.splitGroups = next.splitGroups.filter(group => group.splits.length > 0)
    next.fundAccessLimitGroups = []
    comparable.push(structuredClone(next))
    if (selected && selectedContext && selected.amount > 0n) next.fundAccessLimitGroups = [{
      terminal: selectedContext.terminal, token: selectedContext.token,
      payoutLimits: [], surplusAllowances: [{ currency: selected.currency, amount: selected.amount }],
    }]
    return next
  })
  if (linked && comparable.some(config => serialized(config) !== serialized(comparable[0]))) throw new Error('Linked chain rules differ beyond the selected asset allowance. Review the full omnichain ruleset before continuing.')
  const requests = input.snapshots.map((snapshot, index) => {
    const chainId = chain(snapshot.chainId)
    const args = { chainId, projectId: snapshot.projectId, rulesetConfigurations: [configurations[index]], memo: 'Homerun: configure-asset-allowance' }
    const throughOmnichain = linked || snapshot.configuration?.metadata.dataHook.toLowerCase() === v6Address('JBOmnichainDeployer', chainId).toLowerCase()
    return throughOmnichain ? buildOmnichainQueueRulesetsTx(args) : buildQueueRulesetsTx(args)
  })
  return { requests, configurations, action: 'configure-asset-allowance' }
}

/**
 * V6's exact eight-argument surplus withdrawal. `amount` is the gross budget
 * spent; `minTokensPaidOut` protects net proceeds after fees. The caller must
 * read usedSurplusAllowanceOf and treasury surplus at the snapshot block, then
 * simulate this exact call for the connected account before review/signing.
 */
export function buildFundUseAllowance(input: {
  snapshot: FundRulesetSnapshot
  terminal: Address
  token: Address
  amount: bigint
  currency: number
  minTokensPaidOut: bigint
  beneficiary: Address
  feeBeneficiary: Address
  memo?: string
}): FundTransaction {
  const current = closedAssetRuleset(input.snapshot)
  const context = assetAllowanceContext(input.snapshot, input)
  boundedAssetAllowance(input.amount)
  positive(input.minTokensPaidOut, 'Minimum net asset withdrawal from the current quote')
  if (input.minTokensPaidOut > input.amount) throw new Error('Minimum net withdrawal cannot exceed the gross treasury amount.')
  const matchingGroups = current.fundAccessLimitGroups.filter(group => group.terminal.toLowerCase() === context.terminal.toLowerCase() && group.token.toLowerCase() === context.token.toLowerCase())
  if (matchingGroups.length !== 1) throw new Error('Read exactly one matching treasury allowance before spending it.')
  const limits = matchingGroups[0].surplusAllowances.filter(limit => limit.currency === input.currency)
  if (limits.length !== 1 || limits[0].amount < input.amount) throw new Error('The gross withdrawal exceeds the verified configured allowance.')
  boundedAssetAllowance(limits[0].amount)
  return {
    chainId: context.chainId, address: context.terminal, abi: jbMultiTerminalAbi,
    functionName: 'useAllowanceOf',
    args: [context.projectId, context.token, input.amount, BigInt(input.currency), input.minTokensPaidOut,
      address(input.beneficiary, 'asset-purchase beneficiary'), address(input.feeBeneficiary, 'fee-token beneficiary'), input.memo ?? 'Homerun: asset purchase'],
  }
}
