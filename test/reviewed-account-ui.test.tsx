/**
 * A FUND cash out, burn or transfer, an INCOME loan, and a project permissions
 * update are built for the account that reviewed them: its tokens, its
 * proceeds, its collateral, the authority read for it. When the wallet
 * switches to another account before the confirm, or between a loan's
 * permission and its borrow, nothing more reaches the wallet: the real
 * useSafeTx and the SDK's reviewed write refuse the send before its review
 * opens, and the dialog says why.
 */
import './dialog-shim'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isAddressEqual, parseAbi, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FundProjectState } from '@/lib/fund-state'
import type { IncomeProjectState } from '@/lib/income-state'
import type { ProjectAuthorityState } from '@/lib/project-authority'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const TERMINAL = '0x3333333333333333333333333333333333333333' as Address
const RECIPIENT = '0x4444444444444444444444444444444444444444' as Address
const TOKEN = '0x5555555555555555555555555555555555555555' as Address
const USDC = '0x7777777777777777777777777777777777777777' as Address
const CONTROLLER = '0x8888888888888888888888888888888888888888' as Address
const DELEGATE = '0x9999999999999999999999999999999999999999' as Address
const BLOCK_HASH = `0x${'ef'.repeat(32)}` as Hex
const UNIT = 10n ** 18n
const CHANGED = 'The connected account changed. Review again.'

const m = vi.hoisted(() => ({ quote: vi.fn(), prepare: vi.fn(), permitted: false }))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@wagmi/core')>()),
    getAccount: () => ({ address: wallet.account, chainId: 1 }),
  }
})
vi.mock('wagmi', async importOriginal => {
  const { walletHooks } = await import('./support/fake-wallet')
  return { ...(await importOriginal<typeof import('wagmi')>()), ...walletHooks }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('./support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/lib/transaction-review', async importOriginal => {
  const { wallet } = await import('./support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
    requestContractTransactionReview: wallet.requestReview,
  }
})
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))
vi.mock('@/lib/fund-state', () => ({ readFundWriteState: async () => fund }))
vi.mock('@/lib/income-state', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/income-state')>()),
  readIncomeProjectState: async () => ({ ...income, blockNumber: 200n }),
}))
// Alice owns project 7; Bob can manage its permissions too. Each read is for the connected account.
vi.mock('@/lib/project-authority', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/project-authority')>()),
  readProjectAuthority: async (_client: unknown, input: { account?: Address | null; operator?: Address | null }) => authority(input.account ?? null, input.operator ?? null),
  reverifyProjectAuthority: async () => undefined,
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getHookAwareCashOutQuote: m.quote,
  prepareHookAwareCashOut: m.prepare,
  getBorrowableAmount: async () => ({ borrowableNow: 1_000_000n, borrowableCapacity: 1_000_000n }),
  hasPermissions: async () => m.permitted,
}))

import { sentHash, wallet } from './support/fake-wallet'
import { CashOutPanel, HolderActions } from '@/components/live-transactions'
import { IncomeBorrow } from '@/components/IncomeProject'
import { ProjectPermissionsEditor } from '@/components/ProjectPermissionsEditor'

const fund = {
  chainId: 1, projectId: 7n, blockNumber: 100n, account: ALICE, controller: CONTROLLER,
  supportedController: true, supportedTerminals: true, knownOwnerWrapper: true, tokenAddress: TOKEN,
  creditBalance: 0n, erc20Balance: 100n * UNIT, metadata: { cashOutTaxRate: 1000, pausePay: false },
  accountingContexts: [{ token: USDC, terminal: TERMINAL, decimals: 6, currency: 1, symbol: 'USDC', balance: 0n }],
} as unknown as FundProjectState
const incomeContext = { token: USDC, terminal: TERMINAL, decimals: 6, currency: 1, symbol: 'USDC', isPrimary: true, balance: 0n }
const income = {
  chainId: 1, projectId: 9n, blockNumber: 100n, controller: CONTROLLER, tokenAddress: TOKEN,
  totalBalance: 100n * UNIT, cashOutsAvailable: true, accountingContexts: [incomeContext],
} as unknown as IncomeProjectState
function authority(account: Address | null, operator: Address | null): ProjectAuthorityState {
  const isOwner = !!account && isAddressEqual(account, ALICE)
  return {
    chainId: 1, projectId: 7n, account, owner: ALICE, controller: CONTROLLER, kind: 'project', blockNumber: 100n, blockHash: BLOCK_HASH,
    isOwner, isRevnetOperator: false, canTransfer: isOwner, canManagePermissions: !!account,
    accountPermissions: 0n, accountGlobalPermissions: 0n, operator, operatorPermissions: 0n, operatorGlobalPermissions: 0n,
    identity: `${account}:${operator}`,
  }
}
const cashOutAbi = parseAbi([
  'function cashOutTokensOf(address holder,uint256 projectId,uint256 cashOutCount,address tokenToReclaim,uint256 minTokensReclaimed,address beneficiary,bytes metadata) returns (uint256 reclaimAmount)',
])

let host: HTMLDivElement
let root: Root
let cache: QueryClient
const render = (element: ReactNode) => act(async () => { root.render(<QueryClientProvider client={cache}>{element}</QueryClientProvider>) })
/** Lets the sends a confirmation starts, and the effects they set off, run out. */
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const click = async (text: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(button, text).toBeDefined()
  await act(async () => button!.click())
  await settle()
}
async function type(label: string, value: string) {
  const input = [...host.querySelectorAll('label')].find(node => node.textContent?.startsWith(label))!.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}
const dialogText = () => document.querySelector('[data-tx-confirm]')?.textContent ?? ''
/** The wallet switches to `account`; every hook reading it renders again. */
const switchTo = (account: Address) => act(async () => wallet.connect(account))

beforeEach(() => {
  wallet.reset()
  wallet.connect(ALICE)
  m.permitted = false
  m.quote.mockReset().mockResolvedValue({ minimumReturn: 9_000_000n })
  m.prepare.mockReset().mockResolvedValue({
    route: { minimumReturn: 8_900_000n },
    transaction: { chainId: 1, address: TERMINAL, abi: cashOutAbi, functionName: 'cashOutTokensOf', args: [ALICE, 7n, 10n * UNIT, USDC, 8_900_000n, ALICE, '0x'] },
  })
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); cache.clear() })

describe('a FUND cash out reviewed for one account', () => {
  it('never sends from an account switched to before confirming', async () => {
    await render(<CashOutPanel state={fund} client={{} as never} contextIndex={0} />)
    await type('FUND to cash out', '10')
    await click('Review cash-out')
    expect(dialogText()).toContain('Confirm cash out')

    await switchTo(BOB)
    await click('Confirm & cash out')

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(wallet.requestReview).not.toHaveBeenCalled()
    expect(dialogText()).toContain(CHANGED)
  })

  it('cashes out from the account that reviewed it', async () => {
    await render(<CashOutPanel state={fund} client={{} as never} contextIndex={0} />)
    await type('FUND to cash out', '10')
    await click('Review cash-out')
    await click('Confirm & cash out')

    expect(wallet.writes()).toEqual([{ functionName: 'cashOutTokensOf', account: ALICE }])
  })
})

describe.each([
  ['burn', 'Review burn', 'Confirm & burn', 'burnTokensOf'],
  ['transferTokens', 'Review transfer', 'Confirm & transfer', 'transfer'],
] as const)('a FUND %s reviewed for one account', (action, review, confirm, functionName) => {
  async function reviewAction() {
    await render(<HolderActions state={fund} client={{} as never} />)
    await act(async () => {
      const select = host.querySelector('select')!
      select.value = action
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await type('FUND amount', '5')
    if (action === 'transferTokens') await type('Recipient wallet', RECIPIENT)
    await click(review)
  }

  it('never sends from an account switched to before confirming', async () => {
    await reviewAction()
    await switchTo(BOB)
    await click(confirm)

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(wallet.requestReview).not.toHaveBeenCalled()
    expect(dialogText()).toContain(CHANGED)
  })

  it('sends from the account that reviewed it', async () => {
    await reviewAction()
    await click(confirm)

    expect(wallet.writes()).toEqual([{ functionName, account: ALICE }])
  })
})

describe('an INCOME loan reviewed for one account', () => {
  async function confirmLoan() {
    await render(<IncomeBorrow state={income} client={wallet.client as never} context={incomeContext} />)
    await type('INCOME collateral', '10')
    await click('Review loan')
    await click('Confirm & borrow')
    // The permission for REVLoans to burn Alice's collateral reached her wallet.
    expect(wallet.writes()).toEqual([{ functionName: 'setPermissionsFor', account: ALICE }])
  }

  it('never borrows, or opens the borrow review, from an account switched to after its permission', async () => {
    await confirmLoan()
    await switchTo(BOB)
    await act(async () => wallet.confirm(sentHash(1)))
    await settle()

    expect(wallet.writes()).toEqual([{ functionName: 'setPermissionsFor', account: ALICE }])
    expect(wallet.requestReview).toHaveBeenCalledOnce()
    expect(dialogText()).toContain(CHANGED)
  })

  it('borrows for the account that reviewed it once its permission lands', async () => {
    await confirmLoan()
    await act(async () => wallet.confirm(sentHash(1)))
    await settle()

    expect(wallet.writes()).toEqual([
      { functionName: 'setPermissionsFor', account: ALICE },
      { functionName: 'borrowFrom', account: ALICE },
    ])
  })
})

describe('a project permissions update reviewed for one account', () => {
  beforeEach(() => {
    localStorage.clear()
    // The project admin journal coordinates tabs through Web Locks, and reads the latest block.
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, _options: unknown, task: (lock: object) => Promise<unknown>) => task({}) },
    })
    Object.assign(wallet.client, { getBlock: vi.fn(async () => ({ number: 100n, hash: BLOCK_HASH })) })
  })
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks')
    localStorage.clear()
  })

  async function reviewGrant() {
    await render(<ProjectPermissionsEditor chainId={1} projectId={7n} client={wallet.client as never} />)
    await type('Delegate wallet', DELEGATE)
    await click('Look up permissions')
    const payouts = [...host.querySelectorAll('label')].find(node => node.textContent?.startsWith('Send payouts'))!.querySelector('input')!
    await act(async () => payouts.click())
    await click('Review permission changes')
    expect(dialogText()).toContain('Save permissions')
  }

  it('never reviews or sends from an account switched to before confirming', async () => {
    await reviewGrant()
    await switchTo(BOB)
    await click('Confirm & save')

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(wallet.requestReview).not.toHaveBeenCalled()
    expect(dialogText()).toContain(CHANGED)
  })

  it('sends from the account that reviewed it', async () => {
    await reviewGrant()
    await click('Confirm & save')

    expect(wallet.writes()).toEqual([{ functionName: 'setPermissionsFor', account: ALICE }])
  })
})
