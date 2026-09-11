import {
  jbBuybackHookAbi, jbBuybackHookRegistryAbi, jbContractAddress, jbControllerAbi,
  jbDirectoryAbi, jbMultiTerminalAbi, jbOmnichainDeployerAbi, jbTokensAbi,
  NATIVE_TOKEN, USDC_ADDRESSES, type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  previewPay, uniswapV4Deployment, v6Address, type PayPreview,
  type UniswapV4PoolKey,
} from '@bananapus/nana-sdk-core/v6'
import { quoteDirectPaySwap, type DirectPaySwapQuote } from '@bananapus/nana-sdk-core/v6/direct-pay'
import { erc20Abi, isAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'

export type ProjectPayQuoteInput = {
  chainId: JBChainId
  projectId: bigint
  token: Address
  amount: bigint
  beneficiary: Address
  /** The selected project's verified accounting terminal, never an indexer address. */
  terminal: Address
}

export type ProjectPayQuote = {
  kind: 'pay' | 'direct-swap'
  /** Execution target: the selected terminal, or the canonical Universal Router. */
  terminal: Address
  preview: PayPreview
  minimumTokenCount: bigint
  reservedTokenCount: bigint
  swapQuote?: DirectPaySwapQuote
  /** All route/quote reads use this same confirmed block. */
  blockNumber: bigint
}

export type ProjectPayTokenOption = {
  token: Address
  decimals: number
  symbol: string
  /** The listed canonical accounting terminal anchors this project's pay surface. */
  terminal: Address
  viaRouter: boolean
}

const SLIPPAGE_BPS = 100n
function minimum(count: bigint) {
  if (count <= 0n) return 0n
  const floor = count * (10_000n - SLIPPAGE_BPS) / 10_000n
  return floor > 0n ? floor : 1n
}
function optionalAddress(name: string, chainId: JBChainId): Address | undefined {
  const value = (jbContractAddress[6] as Record<string, Partial<Record<JBChainId, Address>>>)[name]?.[chainId]
  return value && !isAddressEqual(value, zeroAddress) ? value : undefined
}
function same(a: Address, b: Address | undefined) { return !!b && isAddressEqual(a, b) }

/** Payment choices are separate from the project's treasury accounting contexts. */
export async function readProjectPayTokenOptions(client: PublicClient, { chainId, projectId, terminal }: Pick<ProjectPayQuoteInput, 'chainId' | 'projectId' | 'terminal'>): Promise<ProjectPayTokenOption[]> {
  if (projectId <= 0n || await client.getChainId() !== chainId) throw new Error('The payment token request has the wrong project or chain.')
  const multi = v6Address('JBMultiTerminal', chainId)
  const router = optionalAddress('JBRouterTerminalRegistry', chainId)
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
  const [contexts, terminals] = await Promise.all([
    client.readContract({ address: multi, abi: jbMultiTerminalAbi, functionName: 'accountingContextsOf', args: [projectId], blockNumber }),
    client.readContract({ address: v6Address('JBDirectory', chainId), abi: jbDirectoryAbi, functionName: 'terminalsOf', args: [projectId], blockNumber }),
  ])
  if (!same(terminal, multi) || !terminals.some(address => same(address, multi))) throw new Error('The project’s accounting terminal is no longer available.')
  if (contexts.length > 16) throw new Error('The project has too many accounting tokens to verify its payment choices.')
  const usdc = USDC_ADDRESSES[chainId]
  const options = await Promise.all(contexts.map(async context => {
    const symbol = same(context.token, NATIVE_TOKEN) ? 'ETH' : same(context.token, usdc) ? 'USDC'
      : await client.readContract({ address: context.token, abi: erc20Abi, functionName: 'symbol', blockNumber }).catch(() => `${context.token.slice(0, 6)}…${context.token.slice(-4)}`)
    return { token: context.token, decimals: context.decimals, symbol, terminal: multi, viaRouter: false }
  }))
  if (!router || !terminals.some(address => same(address, router))) return options
  const candidates = [
    { token: NATIVE_TOKEN, decimals: 18, symbol: 'ETH' },
    ...(usdc ? [{ token: usdc, decimals: 6, symbol: 'USDC' }] : []),
  ].filter(candidate => !options.some(option => same(option.token, candidate.token)))
  const routed = await Promise.all(candidates.map(async candidate => {
    try {
      const [ruleset] = await client.readContract({ address: router, abi: jbMultiTerminalAbi, functionName: 'previewPayFor', args: [projectId, candidate.token, 10n ** BigInt(candidate.decimals), '0x0000000000000000000000000000000000000001', '0x'], blockNumber })
      return BigInt(ruleset.id) > 0n ? { ...candidate, terminal: multi, viaRouter: true } : null
    } catch { return null }
  }))
  return [...options, ...routed.filter((option): option is ProjectPayTokenOption => !!option)]
}

/**
 * Current JBM/Revnet payment routing: live terminal previews compete with the
 * canonical hooked V4 market through the SDK (including its ETH/USDC bridge).
 * This helper only reads. The caller must freeze/review the returned minimum,
 * validate its wallet, approve the actual route's spender, and simulate its call.
 */
export async function prepareProjectPayQuote(client: PublicClient, input: ProjectPayQuoteInput): Promise<ProjectPayQuote> {
  const { chainId, projectId, token, amount, beneficiary, terminal } = input
  if (projectId <= 0n || amount <= 0n || ![token, beneficiary, terminal].every(address => isAddress(address))) throw new Error('Enter a valid project, token, beneficiary, and positive payment amount.')
  if (await client.getChainId() !== chainId) throw new Error('The payment RPC is connected to the wrong chain.')
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
  // SDK helpers intentionally accept a PublicClient. Pin their terminal and
  // quoter reads alongside our hook/pool reads to avoid mixing ruleset stages.
  const snapshot = {
    ...client,
    readContract: (request: Parameters<PublicClient['readContract']>[0]) => client.readContract({ ...request, blockNumber }),
    call: (request: Parameters<PublicClient['call']>[0]) => client.call({ ...request, blockTag: undefined, blockNumber } as Parameters<PublicClient['call']>[0]),
  } as PublicClient
  const multi = v6Address('JBMultiTerminal', chainId)
  const registry = optionalAddress('JBRouterTerminalRegistry', chainId)
  const directory = v6Address('JBDirectory', chainId)
  const [controller, terminals, block] = await Promise.all([
    snapshot.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'controllerOf', args: [projectId] }),
    snapshot.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'terminalsOf', args: [projectId] }),
    client.getBlock({ blockNumber }),
  ])
  if (!same(controller, v6Address('JBController', chainId))) throw new Error('The payment controller is not the supported Juicebox V6 controller.')
  const candidates = [multi, registry].filter((address): address is Address => !!address && terminals.some(listed => same(listed, address)))
  if (!candidates.some(address => same(address, terminal))) throw new Error('The selected payment terminal is no longer listed for this project.')
  const [ruleset, metadata] = await snapshot.readContract({ address: controller, abi: jbControllerAbi, functionName: 'currentRulesetOf', args: [projectId] })
  if (BigInt(ruleset.id) === 0n || BigInt(ruleset.start) > block.timestamp) throw new Error('The project’s payment rules have not started.')
  if (metadata.pausePay) throw new Error('The project has paused payments.')

  const routes = (await Promise.all(candidates.map(async address => {
    try {
      const preview = await previewPay(snapshot, { chainId, terminal: address, projectId, token, amount, beneficiary })
      return { terminal: address, preview }
    } catch { return null }
  }))).filter((route): route is { terminal: Address; preview: PayPreview } => !!route)
  routes.sort((a, b) => {
    if (a.preview.beneficiaryTokenCount !== b.preview.beneficiaryTokenCount) return a.preview.beneficiaryTokenCount > b.preview.beneficiaryTokenCount ? -1 : 1
    if (a.preview.reservedTokenCount !== b.preview.reservedTokenCount) return a.preview.reservedTokenCount > b.preview.reservedTokenCount ? -1 : 1
    return same(a.terminal, multi) ? -1 : same(b.terminal, multi) ? 1 : 0
  })
  const best = routes[0]
  if (!best) throw new Error('No listed payment route has a live quote for this token.')

  let dataHook = metadata.useDataHookForPay ? metadata.dataHook : zeroAddress
  const omni = optionalAddress('JBOmnichainDeployer', chainId)
  if (same(dataHook, omni)) {
    const extra = await snapshot.readContract({ address: omni!, abi: jbOmnichainDeployerAbi, functionName: 'extraDataHookOf', args: [projectId, BigInt(ruleset.id)] })
    dataHook = extra.useDataHookForPay ? extra.dataHook : zeroAddress
  }
  const buybackRegistry = optionalAddress('JBBuybackHookRegistry', chainId)
  const concreteHook = optionalAddress('JBBuybackHook', chainId)
  const revOwner = optionalAddress('REVOwner', chainId)
  let hook: Address | undefined
  if (buybackRegistry && (same(dataHook, buybackRegistry) || same(dataHook, revOwner))) {
    const resolved = await snapshot.readContract({ address: buybackRegistry, abi: jbBuybackHookRegistryAbi, functionName: 'hookOf', args: [projectId] })
    if (!same(resolved, zeroAddress)) hook = resolved
  } else if (same(dataHook, concreteHook)) hook = dataHook

  let swapQuote: DirectPaySwapQuote | undefined
  if (hook && uniswapV4Deployment(chainId)?.universalRouter) {
    const [contexts, projectToken] = await Promise.all([
      snapshot.readContract({ address: multi, abi: jbMultiTerminalAbi, functionName: 'accountingContextsOf', args: [projectId] }),
      snapshot.readContract({ address: v6Address('JBTokens', chainId), abi: jbTokensAbi, functionName: 'tokenOf', args: [projectId] }),
    ])
    if (contexts.length > 16) throw new Error('The project has too many accounting tokens to verify its payment routes.')
    if (!same(projectToken, zeroAddress)) {
      const pairs = [...new Set(contexts.map(context => (same(context.token, NATIVE_TOKEN) ? zeroAddress : context.token).toLowerCase()))] as Address[]
      const swaps = await Promise.all(pairs.map(async pair => {
        const key: UniswapV4PoolKey = await snapshot.readContract({ address: hook!, abi: jbBuybackHookAbi, functionName: 'poolKeyOf', args: [projectId, pair] })
        if (same(key.currency0, zeroAddress) && same(key.currency1, zeroAddress)) return null
        const pairIsCurrency0 = same(key.currency0, pair)
        if (!(pairIsCurrency0 ? same(key.currency1, projectToken) : same(key.currency1, pair) && same(key.currency0, projectToken))) throw new Error('The buyback pool does not match this project’s token and accounting currency.')
        try {
          return await quoteDirectPaySwap({ client: snapshot, chainId, poolKey: key, pairIsCurrency0, paymentToken: token, amount, payPreview: best.preview, paySettlement: same(best.terminal, registry) ? 'swap' : 'issuance', slippageBps: SLIPPAGE_BPS })
        } catch { return null }
      }))
      for (const quote of swaps) if (quote && (!swapQuote || quote.minimumTokenCount > swapQuote.minimumTokenCount)) swapQuote = quote
    }
  }
  if (swapQuote) return {
    kind: 'direct-swap', terminal: uniswapV4Deployment(chainId)!.universalRouter!,
    preview: { beneficiaryTokenCount: swapQuote.minimumTokenCount, reservedTokenCount: 0n },
    minimumTokenCount: swapQuote.minimumTokenCount, reservedTokenCount: 0n, swapQuote, blockNumber,
  }
  if (best.preview.beneficiaryTokenCount === 0n && !(metadata.reservedPercent === 10_000 && best.preview.reservedTokenCount > 0n)) {
    // Active buyback settlement returns zero issuance; the SDK preview omits
    // the separate hook specifications. Zero here is not proof of zero output.
    throw new Error('A protected token return could not be verified. The payment may settle through its buyback hook; refresh its market quote before continuing.')
  }
  return { kind: 'pay', terminal: best.terminal, preview: best.preview, minimumTokenCount: minimum(best.preview.beneficiaryTokenCount), reservedTokenCount: best.preview.reservedTokenCount, blockNumber }
}
