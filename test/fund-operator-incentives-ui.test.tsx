import './dialog-shim'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionData, type Address, type PublicClient } from 'viem'
import { v6Address } from '@bananapus/nana-sdk-core/v6'
import { initialFundRuleset } from '../src/lib/fund-contracts'
import { USDC_ADDRESSES } from '@bananapus/nana-sdk-core'
import type { FundProjectState } from '../src/lib/fund-state'

const runtime = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111' as Address,
  state: null as FundProjectState | null,
  send: vi.fn(), readContract: vi.fn(), query: vi.fn(),
  configure: undefined as undefined | ((input: { amount: bigint; currency: number; contextIndex: number }) => Promise<void>),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: runtime.account }) }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => ({ phase: 'idle', busy: false, send: runtime.send, track: async () => null }), txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle }))
vi.mock('@/components/FundAssetWithdrawals', () => ({ FundAssetWithdrawals: ({ onConfigureAllowance }: { onConfigureAllowance: typeof runtime.configure }) => { runtime.configure = onConfigureAllowance; return null } }))
vi.mock('@/lib/fund-state', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/fund-state')>(), readFundProjectState: async () => runtime.state }))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (options: unknown) => { runtime.query(options); return { data: 5n * 10n ** 18n, isError: false } },
}))
import { FundOperatorActions } from '../src/components/FundOperatorActions'
import { intent, writeIntentKey } from '@bananapus/nana-sdk-core/review'
import { expectRetryHeldByIntent } from './support/intent-retry'

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
  /** Review opens jbm's confirm dialog; its action sends the mint. */
  async function reviewAndConfirm() {
    await act(async () => mintButton().click())
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[data-tx-confirm] button')].find(button => button.textContent === 'Confirm & mint')!.click())
  }
  async function selectOwner() {
    const selection = host.querySelector('select')!
    await act(async () => { selection.value = 'operator-share'; selection.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => host.querySelector<HTMLInputElement>('#fund-success-controls ~ label input[type="checkbox"]')!.click())
  }
  async function setInput(field: HTMLInputElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('mints the 20% success share to the owner using the owner’s holdings', async () => {
    await render(); await selectOwner()
    expect(host.textContent).toContain(`Owner recipient: ${OWNER}`)
    expect(host.textContent).toContain('Additional FUND to mint: 18.75.')
    expect(runtime.query).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['fund-owner-balance', 8453, '7', OWNER, '100'], enabled: false }))
    await reviewAndConfirm()
    const [request, options] = runtime.send.mock.calls[0]
    const decoded = decodeFunctionData({ abi: request.abi, data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) })
    expect(decoded.functionName).toBe('mintTokensOf')
    expect(decoded.args?.slice(0, 3)).toEqual([7n, 18_750_000_000_000_000_000n, OWNER])
    expect(options.reviewNotice).toContain('owner may distribute these tokens to the operator at their discretion')
    expect(options.reviewedAccount).toBe(runtime.account)
    await options.reverify()
    expect(runtime.readContract.mock.calls.every(([input]) => input.args[0] === OWNER)).toBe(true)
  })

  it('offers no editable recipient and does not reuse the contributor wallet for the owner share', async () => {
    await render()
    const contributor = [...host.querySelectorAll('label')].find(label => label.textContent === 'Contributor wallet')!.querySelector('input')!
    await setInput(contributor, OPERATOR)
    await selectOwner()
    expect([...host.querySelectorAll('label')].some(label => /wallet|recipient/i.test(label.textContent ?? ''))).toBe(false)
    await reviewAndConfirm()
    const [request] = runtime.send.mock.calls[0]
    expect(request.args[2]).toBe(OWNER)
  })

  it('uses owner holdings when a different wallet has explicit minting permission', async () => {
    runtime.account = OPERATOR; runtime.state = state()
    runtime.state.permissions.mintTokens = true
    await render(); await selectOwner()
    expect(host.textContent).toContain('Additional FUND to mint: 18.75.')
    expect(runtime.query).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['fund-owner-balance', 8453, '7', OWNER, '100'], enabled: true }))
    await reviewAndConfirm()
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
    await reviewAndConfirm()
    expect(host.textContent).toContain('Project ownership changed')
    expect(runtime.send).not.toHaveBeenCalled()
  })

  const sent = () => runtime.send.mock.calls.map(([request, options]) => ({ request, options }))

  it('holds an owner-share mint by its chosen target, so a retry after the owner holdings changed is held by the first', async () => {
    await render(); await selectOwner()
    await reviewAndConfirm()
    // The owner's holdings moved after the lost reply: the calculated count is another.
    runtime.readContract.mockResolvedValue(6n * UNIT)
    await reviewAndConfirm()
    const [first, retry] = sent()
    await expectRetryHeldByIntent(first, retry, writeIntentKey('fund-mint', { project: 7n, kind: 'operator-share', beneficiary: intent.address(OWNER), target: 2000 }))
  })

  it('holds a ruleset change by its chosen action, so a retry after a preserved field changed is held by the first', async () => {
    await render()
    const review = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Review disabling owner minting')!
    const confirm = () => [...host.querySelectorAll<HTMLButtonElement>('[data-tx-confirm] button')].find(button => button.textContent !== 'Cancel' && !button.getAttribute('aria-label'))!
    await act(async () => review().click()); await act(async () => confirm().click())
    // A field the change preserves (the issuance weight) moved after the lost reply.
    const next = state()
    next.rulesetSnapshot.configuration!.weight = next.rulesetSnapshot.configuration!.weight - 1n
    runtime.state = next
    await render()
    await act(async () => review().click()); await act(async () => confirm().click())
    const [first, retry] = sent()
    await expectRetryHeldByIntent(first, retry, writeIntentKey('fund-ruleset', { project: 7n, action: 'finish-success-minting' }))
  })

  it('holds an asset allowance by its terminal and token, so a retry after a preserved field changed is held by the first', async () => {
    const TERMINAL = v6Address('JBMultiTerminal', 8453)
    const USDC = USDC_ADDRESSES[8453]!
    const CURRENCY = Number(BigInt(USDC) & 0xffffffffn)
    const withContext = () => {
      const next = state()
      const context = { token: USDC, terminal: TERMINAL, decimals: 6, currency: CURRENCY, symbol: 'USDC', balance: 0n, surplus: 0n, surplusAllowances: [] }
      Object.assign(next, { accountingContexts: [context] })
      Object.assign(next.rulesetSnapshot, { accountingContexts: [context] })
      return next
    }
    runtime.state = withContext()
    await render()
    await act(async () => { await runtime.configure!({ amount: 5_000_000n, currency: CURRENCY, contextIndex: 0 }) })
    const next = withContext()
    next.rulesetSnapshot.configuration!.weight = next.rulesetSnapshot.configuration!.weight - 1n
    runtime.state = next
    await render()
    await act(async () => { await runtime.configure!({ amount: 5_000_000n, currency: CURRENCY, contextIndex: 0 }) })
    const [first, retry] = sent()
    await expectRetryHeldByIntent(first, retry, writeIntentKey('fund-allowance', { project: 7n, terminal: intent.address(TERMINAL), token: intent.address(USDC) }))
  })
})
