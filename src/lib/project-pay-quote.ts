import {
  jbContractAddress, jbControllerAbi, jbDirectoryAbi, jbMultiTerminalAbi,
  NATIVE_TOKEN, USDC_ADDRESSES, type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  prepareUserPay, slippageFloor, v6Address, type PayPreview,
  type PreparedUserPay,
} from '@bananapus/nana-sdk-core/v6'
import { erc20Abi, isAddress, isAddressEqual, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'

export type ProjectPayQuoteInput = {
  /** Current Center passkey profile supports exact direct terminal payments only. */
  directTerminalOnly?: boolean
  chainId: JBChainId
  projectId: bigint
  token: Address
  amount: bigint
  beneficiary: Address
  /** The selected project's verified accounting terminal, never an indexer address. */
  terminal: Address
}

export type ProjectPayQuote = {
  /** The listed terminal the payment goes to. */
  terminal: Address
  preview: PayPreview
  minimumTokenCount: bigint
  reservedTokenCount: bigint
  /** The pay metadata the payment sends with this minimum. */
  metadata: Hex
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
 * Prepares a payment on each listed terminal through the SDK's prepareUserPay
 * (buyback skipSplits metadata: the hook picks the pool or a mint for the payer)
 * and keeps the best protected return. This helper only reads. The caller must
 * freeze/review the returned minimum, validate its wallet, approve the terminal,
 * and simulate its call.
 */
export async function prepareProjectPayQuote(client: PublicClient, input: ProjectPayQuoteInput): Promise<ProjectPayQuote> {
  const { chainId, projectId, token, amount, beneficiary, terminal } = input
  if (projectId <= 0n || amount <= 0n || ![token, beneficiary, terminal].every(address => isAddress(address))) throw new Error('Enter a valid project, token, beneficiary, and positive payment amount.')
  if (await client.getChainId() !== chainId) throw new Error('The payment RPC is connected to the wrong chain.')
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
  // SDK helpers intentionally accept a PublicClient. Pin their terminal and
  // quoter reads to one block to avoid mixing ruleset stages.
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
  const candidates = (input.directTerminalOnly ? [multi] : [multi, registry]).filter((address): address is Address => !!address && terminals.some(listed => same(listed, address)))
  if (!candidates.some(address => same(address, terminal))) throw new Error('The selected payment terminal is no longer listed for this project.')
  const [ruleset, metadata] = await snapshot.readContract({ address: controller, abi: jbControllerAbi, functionName: 'currentRulesetOf', args: [projectId] })
  if (BigInt(ruleset.id) === 0n || BigInt(ruleset.start) > block.timestamp) throw new Error('The project’s payment rules have not started.')
  if (metadata.pausePay) throw new Error('The project has paused payments.')

  const routes = (await Promise.all(candidates.map(async address => {
    try {
      const args = { chainId, terminal: address, projectId, token, amount, beneficiary }
      return { terminal: address, ...await (input.directTerminalOnly ? exactTerminalPay(snapshot, args) : prepareUserPay(snapshot, { ...args, slippageBps: SLIPPAGE_BPS })) }
    } catch { return null }
  }))).filter(route => !!route)
  routes.sort((a, b) => {
    if (a.minReturnedTokens !== b.minReturnedTokens) return a.minReturnedTokens > b.minReturnedTokens ? -1 : 1
    if (a.preview.reservedTokenCount !== b.preview.reservedTokenCount) return a.preview.reservedTokenCount > b.preview.reservedTokenCount ? -1 : 1
    return same(a.terminal, multi) ? -1 : same(b.terminal, multi) ? 1 : 0
  })
  const best = routes[0]
  if (!best) throw new Error('No listed payment route has a live quote for this token.')
  if (best.minReturnedTokens === 0n && !(metadata.reservedPercent === 10_000 && best.preview.reservedTokenCount > 0n)) throw new Error('No protected token return is available for this payment.')
  return { terminal: best.terminal, preview: best.preview, minimumTokenCount: best.minReturnedTokens, reservedTokenCount: best.preview.reservedTokenCount, metadata: best.metadata, blockNumber }
}

/** Center's passkey profile pays with empty metadata. It keeps the terminal's own count, so a payment the buyback hook would swap has no protected return here and is refused. */
async function exactTerminalPay(client: PublicClient, { terminal, projectId, token, amount, beneficiary }: { terminal: Address; projectId: bigint; token: Address; amount: bigint; beneficiary: Address }): Promise<PreparedUserPay> {
  const [, beneficiaryTokenCount, reservedTokenCount] = await client.readContract({ address: terminal, abi: jbMultiTerminalAbi, functionName: 'previewPayFor', args: [projectId, token, amount, beneficiary, '0x'] })
  return { metadata: '0x', preview: { beneficiaryTokenCount, reservedTokenCount }, minReturnedTokens: slippageFloor(beneficiaryTokenCount, SLIPPAGE_BPS) }
}
