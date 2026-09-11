type FundActionsState = {
  paymentsPaused: boolean
  cashOutsEnabled: boolean
  mintingEnabled: boolean
  hasLinkedIncome: boolean
}

type IncomeActionsState = {
  cashOutsEnabled: boolean
  hasInitialAllocation: boolean
}

type Props =
  | { token: 'FUND'; state?: FundActionsState }
  | { token: 'INCOME'; state?: IncomeActionsState }

type Action = { label: string; href: string }

/** Supplied state must come from verified contracts. Links open existing forms;
 * those forms remain responsible for permission, balance and transaction review.
 * Paused payments do not establish a purchase, failure or asset sale.
 */
export function LiveProjectActions(props: Props) {
  if (!props.state) return null
  const actions: Action[] = []

  if (props.token === 'FUND') {
    const { paymentsPaused, cashOutsEnabled, mintingEnabled, hasLinkedIncome } = props.state
    actions.push({ label: 'Use FUND', href: '#owners/accounts' })
    if (cashOutsEnabled) actions.push({ label: 'Cash out FUND', href: '#owners/market' })
    if (hasLinkedIncome) actions.push({ label: 'Check initial INCOME allocation', href: '#owners/accounts' })
    actions.push({ label: 'Manage contributions', href: '#operators' })
    if (paymentsPaused && !cashOutsEnabled) actions.push({ label: 'Manage treasury withdrawals', href: '#operators' })
    if (paymentsPaused && !cashOutsEnabled && mintingEnabled) actions.push({ label: 'Issue FUND', href: '#operators' })
  } else {
    actions.push({ label: 'Use INCOME', href: '#owners/accounts' })
    if (props.state.hasInitialAllocation) actions.push({ label: 'Check initial INCOME allocation', href: '#owners/accounts' })
    if (props.state.cashOutsEnabled) actions.push({ label: 'Cash out INCOME', href: '#owners/market' })
    actions.push({ label: 'Manage loans', href: '#owners/loans' })
    actions.push({ label: 'Distribute allocations', href: '#owners/splits' })
  }

  return <nav aria-label={`${props.token} actions`} className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
    {actions.map(action => <a key={action.label} href={action.href} className="inline-flex min-h-11 items-center gap-2 text-sm font-medium underline underline-offset-4">
      {action.label}<span aria-hidden="true">→</span>
    </a>)}
  </nav>
}
