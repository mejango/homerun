import { incomePaymentPreview } from '../../web/income-payment-preview.mjs'
import type { projectNetwork } from '../../web/network-model.mjs'

type Projection = ReturnType<typeof projectNetwork>

export type DemoPaymentResult = {
  route: 'FUND' | 'INCOME'
  tokens: number
  supplyAfter: number
  sharePercent: number
  balanceAfter: number
  cashoutValue: number | null
  allocations: { key: string; label: string; color: string; tokens: number; percent: number }[]
}

function nonnegative(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} is outside the supported preview range.`)
  return value
}

/** A new contribution is limited by what is still needed, not by past contributions. */
export function fundPaymentLimitError(baseline: Pick<Projection, 'raised' | 'raiseGoal'>, amount: number): string {
  const goalCents = Math.round(baseline.raiseGoal * 100)
  const raisedCents = Math.round(baseline.raised * 100)
  const amountCents = Math.round(amount * 100)
  if (![goalCents, raisedCents, amountCents].every(value => Number.isSafeInteger(value) && value >= 0)) {
    return 'Update the project assumptions to preview this payment.'
  }
  const remainingCents = Math.max(0, goalCents - raisedCents)
  if (amountCents <= remainingCents) return ''
  const remaining = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(remainingCents / 100)
  return `Your payment cannot exceed ${remaining} left to raise.`
}

/** Quote one additional payment against the project before that payment.
 * Personal projections may already contain a draft contribution; do not pass them here.
 */
export function demoPaymentResult(baseline: Projection, amount: number, fundTokens: number): DemoPaymentResult {
  const amountCents = Math.round(amount * 100)
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amount !== amountCents / 100) {
    throw new RangeError('Enter a positive payment in whole USDC cents.')
  }
  if (baseline.phase === 'earning') {
    const payment = incomePaymentPreview(baseline, amount)
    return {
      route: 'INCOME',
      tokens: payment.payerTokens,
      supplyAfter: payment.supplyAfter,
      sharePercent: payment.payerSharePercent,
      balanceAfter: payment.cashAfter,
      cashoutValue: payment.cashoutValue,
      allocations: payment.allocations.map(part => ({
        ...part,
        label: part.key === 'stakers' ? 'New FUND-holder allocation' : part.label,
      })),
    }
  }
  if (baseline.phase !== 'raising') throw new RangeError('This stage is not accepting payments.')
  const limitError = fundPaymentLimitError(baseline, amount)
  if (limitError) throw new RangeError(limitError)
  const supplyBefore = nonnegative(baseline.fundSupply, 'FUND supply')
  const tokens = nonnegative(fundTokens, 'New FUND')
  const supplyAfter = nonnegative(supplyBefore + tokens, 'FUND supply after payment')
  const raisedCents = Math.round(nonnegative(baseline.raised, 'Funds raised') * 100)
  if (!Number.isSafeInteger(raisedCents) || !Number.isSafeInteger(raisedCents + amountCents)) {
    throw new RangeError('Funds raised exceed the supported preview range.')
  }
  const sharePercent = supplyAfter > 0 ? tokens / supplyAfter * 100 : 0
  return {
    route: 'FUND', tokens, supplyAfter, sharePercent,
    balanceAfter: (raisedCents + amountCents) / 100,
    cashoutValue: null,
    allocations: [
      { key: 'payer', label: 'Your new FUND', color: '#285b3b', tokens, percent: sharePercent },
      { key: 'existing', label: 'Existing FUND', color: '#bbc7b0', tokens: supplyBefore, percent: supplyAfter > 0 ? 100 - sharePercent : 0 },
    ],
  }
}
