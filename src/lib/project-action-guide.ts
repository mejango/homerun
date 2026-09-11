import { transactionCatalog, transactionRoles, type TransactionStage } from './transaction-catalog'

export type ProjectActionSection = 'stages' | 'accounts' | 'market' | 'settlement' | 'splits' | 'loans' | 'operators'
type CatalogEntry = (typeof transactionCatalog)[number]
export type ProjectGuideAction = CatalogEntry & {
  section: ProjectActionSection
  href: string
  roleLabel: string
}

export const projectActionSections: Record<ProjectActionSection, { title: string; tabLabel: string; href: string }> = {
  stages: { title: 'Next actions', tabLabel: 'Payment panel', href: '#pay-panel' },
  accounts: { title: 'Account actions', tabLabel: 'Accounts', href: '#owners/accounts' },
  market: { title: 'Cash-out actions', tabLabel: 'Market', href: '#owners/market' },
  settlement: { title: 'Bridge actions', tabLabel: 'Settlement', href: '#owners/settlement' },
  splits: { title: 'Income distributions', tabLabel: 'Splits', href: '#owners/splits' },
  loans: { title: 'Loan actions', tabLabel: 'Loans', href: '#owners/loans' },
  operators: { title: 'Operator actions', tabLabel: 'Operators', href: '#operators' },
}

/** Payments belong to the persistent payment panel; cash-outs sit beside account balances. */
export const projectActionIds: Record<ProjectActionSection, readonly string[]> = {
  stages: ['contribute', 'income-pay'],
  accounts: ['fund-cashout', 'refund', 'sale-claim', 'income-cashout', 'fund-credit', 'fund-transfer', 'fund-burn', 'initial-income', 'stake', 'unstake', 'vest', 'collect', 'income-credit', 'income-transfer', 'income-burn'],
  market: [],
  settlement: ['fund-bridge', 'income-bridge'],
  splits: ['reserved', 'scheduled'],
  loans: ['borrow', 'repay', 'refinance', 'transfer-loan'],
  operators: ['pause', 'close', 'fail', 'return', 'allowance', 'withdraw', 'enable-minting', 'offchain', 'operator-share', 'disable-minting', 'erc20', 'sticky-setup', 'income-launch', 'sale'],
}

const nextActions: Record<TransactionStage, readonly string[]> = {
  create: [],
  raising: ['pause', 'fail', 'return'],
  funded: ['pause', 'withdraw', 'offchain'],
  refunding: [],
  refunded: [],
  earning: ['initial-income', 'stake'],
  liquidated: ['unstake', 'collect'],
}

const operatorOrder: Record<TransactionStage, readonly string[]> = {
  create: [],
  raising: ['pause', 'close', 'fail', 'erc20'],
  funded: ['allowance', 'withdraw', 'enable-minting', 'offchain', 'operator-share', 'disable-minting', 'erc20', 'sticky-setup', 'income-launch', 'return', 'fail'],
  refunding: ['return', 'fail', 'erc20'],
  refunded: ['return', 'erc20'],
  earning: ['return', 'sale', 'allowance', 'withdraw', 'erc20'],
  liquidated: ['return', 'sale', 'allowance', 'withdraw', 'erc20'],
}

const primaryIds: Partial<Record<ProjectActionSection, readonly string[]>> = {
  accounts: ['initial-income', 'collect', 'stake', 'fund-credit', 'fund-transfer', 'income-credit', 'income-transfer'],
  market: [],
  settlement: ['fund-bridge', 'income-bridge'],
  splits: ['reserved'],
  loans: ['borrow', 'repay'],
}

const roleLabels: Record<string, string> = {
  'initial-income': 'Snapshot recipient',
  unstake: 'SHARE holder',
  vest: 'Reward recipient',
  collect: 'Reward recipient',
  repay: 'Loan owner',
  refinance: 'Loan owner',
  'transfer-loan': 'Loan owner',
}

function action(entry: CatalogEntry): ProjectGuideAction | undefined {
  const section = (Object.keys(projectActionIds) as ProjectActionSection[]).find(key => projectActionIds[key].includes(entry.id))
  if (!section) return undefined
  return {
    ...entry,
    section,
    href: projectActionSections[section].href,
    roleLabel: roleLabels[entry.id] ?? transactionRoles.find(role => role.id === entry.role)!.label,
  }
}

function ordered(entries: ProjectGuideAction[], ids: readonly string[]): ProjectGuideAction[] {
  const rank = (id: string) => { const index = ids.indexOf(id); return index === -1 ? Number.MAX_SAFE_INTEGER : index }
  return [...entries].sort((a, b) => rank(a.id) - rank(b.id))
}

/** Stage selects relevant guidance; it never establishes contract permissions. */
export function projectActionsFor(stage: TransactionStage, section: ProjectActionSection, goalReached = false): {
  primary: ProjectGuideAction[]
  other: ProjectGuideAction[]
} {
  // Reaching the goal changes suggested purchase guidance, never live permissions.
  const guidanceStage = section === 'stages' && stage === 'raising' && goalReached ? 'funded' : stage
  const relevant = transactionCatalog.filter(entry => entry.stages.includes(guidanceStage)).flatMap(entry => {
    const mapped = action(entry)
    return mapped ? [mapped] : []
  })
  if (section === 'stages') return {
    primary: ordered(relevant.filter(entry => nextActions[guidanceStage].includes(entry.id)), nextActions[guidanceStage]).slice(0, 3),
    other: [],
  }
  const entries = relevant.filter(entry => entry.section === section)
  const ids = section === 'operators' ? operatorOrder[stage]
    : section === 'accounts' && stage === 'liquidated' ? ['unstake', 'collect', 'initial-income', 'fund-credit', 'fund-transfer', 'income-credit', 'income-transfer']
      : section === 'loans' && stage === 'liquidated' ? ['repay', 'borrow'] : primaryIds[section] ?? []
  const prioritized = ordered(entries, ids)
  const primary = prioritized.filter(entry => ids.includes(entry.id)).slice(0, section === 'operators' || section === 'accounts' ? 3 : ids.length)
  return { primary, other: prioritized.filter(entry => !primary.some(chosen => chosen.id === entry.id)) }
}
