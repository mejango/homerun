export type LivePhase = 'raising' | 'funded' | 'earning' | 'liquidated' | 'refunding' | null

export type LiveFundPhaseInput = {
  pausePay: boolean
  cashOutTaxRate: number
  allowOwnerMinting: boolean
  hasIncome: boolean
  supported: boolean
}

export type LiveFundPhase = { phase: LivePhase; status: string }

// Mirrors the FUND ruleset templates in FundOperatorActions (basis points of 10_000).
export const RAISING_CASH_OUT_TAX_RATE = 1_000
export const CLOSED_CASH_OUT_TAX_RATE = 10_000
export const OPEN_CASH_OUT_TAX_RATE = 0

// Zero-tax cash-outs look the same onchain after a sale or a failed raise, so neither status claims a sale happened.
export function liveFundPhase({ pausePay, cashOutTaxRate, allowOwnerMinting, hasIncome, supported }: LiveFundPhaseInput): LiveFundPhase {
  if (!supported) return { phase: null, status: 'Unsupported FUND configuration' }
  if (cashOutTaxRate === RAISING_CASH_OUT_TAX_RATE && !allowOwnerMinting) {
    return { phase: 'raising', status: pausePay ? 'Contributions paused' : 'Raising funds' }
  }
  if (cashOutTaxRate === CLOSED_CASH_OUT_TAX_RATE) {
    if (hasIncome) return { phase: 'earning', status: 'Earning' }
    if (pausePay) return { phase: 'funded', status: 'Funded' }
  }
  if (cashOutTaxRate === OPEN_CASH_OUT_TAX_RATE) {
    return { phase: hasIncome ? 'liquidated' : 'refunding', status: 'Cash-outs open' }
  }
  return { phase: null, status: 'Custom rules' }
}
