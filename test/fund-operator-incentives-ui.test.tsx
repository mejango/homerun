import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionData, type Address, type PublicClient } from 'viem'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { initialFundRuleset } from '../src/lib/fund-contracts'
import type { FundProjectState } from '../src/lib/fund-state'

const runtime = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  state: null as FundProjectState | null,
  send: vi.fn(), readContract: vi.fn(), query: vi.fn(),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, send: runtime.send }), txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle }))
vi.mock('@/components/FundAssetWithdrawals', () => ({ FundAssetWithdrawals: () => null }))
vi.mock('@/lib/fund-state', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/fund-state')>(), readFundProjectState: async () => runtime.state }))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: unknown) => { runtime.query(options); return { data: 5n * 10n ** 18n, isError: false } },
}))
import { FundOperatorActions } from '../src/components/FundOperatorActions'

const OWNER = '0x1111111111111111111111111111111111111111' as const
const OPERATOR = '0x2222222222222222222222222222222222222222' as const
const UNIT = 10n ** 18n
function state(): FundProjectState {
  const configuration = initialFundRuleset()
  configuration.metadata.pausePay = true; configuration.metadata.cashOutTaxRate = 10000; configuration.metadata.allowOwnerMinting = true
  return {
    chainId: 8453, projectId: 7n, blockNumber: 100n, owner: OWNER, account: runtime.account,
    controller: v6Address('JBController', 8453), supportedController: true, supportedTerminals: true, knownOwnerWrapper: true,
    ruleset: { id: 1 }, metadata: configuration.metadata, totalSupply: 100n * UNIT, creditBalance: (runtime.account === OWNER ? 5n : 40n) * UNIT, erc20Balance: 0n,
    pendingReservedTokens: 0n, hasPendingRuleset: false, linkedChainIds: [8453], accountingContexts: [],
    rulesetSnapshot: { chainId: 8453, projectId: 7n, blockNumber: 100n, controller: v6Address('JBController', 8453), currentRulesetId: 1n, upcomingRulesetId: 0n, linkedChainIds: [8453], configuration },
    permissions: { queueRulesets: runtime.account === OWNER, mintTokens: runtime.account === OWNER },
  } as unknown as FundProjectState
}

describe('FUND success allocation belongs to the owner', () => {
  let host: HTMLDivElement, root: Root
  beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks(); runtime.account = OWNER; runtime.state = state()
    runtime.readContract.mockResolvedValue(5n * UNIT); runtime.send.mockResolvedValue(null)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove() })
  const client = { readContract: runtime.readContract } as unknown as PublicClient
  async function render() { await act(async () => root.render(<FundOperatorActions state={runtime.state!} client={client} contextIndex={0} />)) }
  function mintButton() { return [...host.querySelectorAll('button')].find(button => button.textContent === 'Review FUND allocation')! }
  async function selectOwner() {
    const selection = host.querySelector('select')!
    await act(async () => { selection.value = 'operator-share'; selection.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => host.querySelector<HTMLInputElement>('#fund-success-controls + p + label input')!.click())
  }
  async function setInput(field: HTMLInputElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('mints the 20% success share to the owner using the owner’s holdings', async () => {
    await render(); await selectOwner()
    expect(host.textContent).toContain(`Owner recipient: ${OWNER}`)
    expect(host.textContent).toContain('Additional FUND to mint: 18.75.')
    expect(runtime.query).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['fund-owner-balance', 8453, '7', OWNER, '100'], enabled: false }))
    await act(async () => mintButton().click())
    const [request, options] = runtime.send.mock.calls[0]
    const decoded = decodeFunctionData({ abi: request.abi, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) })
    expect(decoded.functionName).toBe('mintTokensOf')
    expect(decoded.args?.slice(0, 3)).toEqual([7n, 18_750_000_000_000_000_000n, OWNER])
    expect(options.reviewNotice).toContain('owner may distribute these tokens to the operator at their discretion')
    await options.reverify()
    expect(runtime.readContract.mock.calls.every(([input]) => input.args[0] === OWNER)).toBe(true)
  })

  it('offers no editable recipient and does not reuse the contributor wallet for the owner share', async () => {
    await render()
    const contributor = [...host.querySelectorAll('label')].find(label => label.textContent === 'Contributor wallet')!.querySelector('input')!
    await setInput(contributor, OPERATOR)
    await selectOwner()
    expect([...host.querySelectorAll('label')].some(label => /wallet|recipient/i.test(label.textContent ?? ''))).toBe(false)
    await act(async () => mintButton().click())
    const [request] = runtime.send.mock.calls[0]
    expect(request.args[2]).toBe(OWNER)
  })

  it('uses owner holdings when a different wallet has explicit minting permission', async () => {
    runtime.account = OPERATOR; runtime.state = state()
    runtime.state.permissions.mintTokens = true
    await render(); await selectOwner()
    expect(host.textContent).toContain('Additional FUND to mint: 18.75.')
    expect(runtime.query).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['fund-owner-balance', 8453, '7', OWNER, '100'], enabled: true }))
    await act(async () => mintButton().click())
    const [request] = runtime.send.mock.calls[0]
    expect(request.args[2]).toBe(OWNER)
    expect(request.args[1]).toBe(18_750_000_000_000_000_000n)
  })

  it('does not give the Operator authority to mint or change rules', async () => {
    runtime.account = OPERATOR; runtime.state = state()
    await render(); await selectOwner()
    expect(mintButton().disabled).toBe(true)
    expect(host.textContent).toContain('This wallet does not have permission to mint FUND.')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  it('refuses to mint when the live owner changed after the displayed allocation', async () => {
    await render(); await selectOwner()
    runtime.state = { ...runtime.state!, owner: OPERATOR }
    await act(async () => mintButton().click())
    expect(host.textContent).toContain('Project ownership changed')
    expect(runtime.send).not.toHaveBeenCalled()
  })
})
