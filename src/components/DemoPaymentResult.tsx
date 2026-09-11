import type { DemoPaymentResult as PaymentResult } from '@/lib/demo-payment-result'
import styles from './DemoPaymentResult.module.css'

const quantity = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 })
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const percent = (value: number) => `${value > 0 && value < 0.01 ? '<0.01' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}%`

export function DemoPaymentResult({ result }: { result: PaymentResult }) {
  const circumference = 2 * Math.PI * 40
  const description = result.allocations.map(part => `${part.label}: ${quantity.format(part.tokens)} tokens, ${percent(part.percent)}`).join('; ')
  return <div className={`demo-payment-result ${styles.result}`} data-payment-route={result.route}>
    <p className={styles.heading}>After this payment</p>
    <div className={styles.summary}>
      <svg viewBox="0 0 104 104" width="104" height="104" role="img" aria-label={`${result.route} ownership after this payment. ${description}`}>
        <title>{`${result.route} ownership after this payment`}</title>
        <circle cx="52" cy="52" r="40" fill="none" stroke="#edf0e7" strokeWidth="18" />
        {result.allocations.filter(part => part.percent > 0).map(part => {
          const offset = result.allocations.slice(0, result.allocations.indexOf(part)).reduce((sum, item) => sum + item.percent, 0)
          return <circle key={part.key} data-payment-segment={part.key} cx="52" cy="52" r="40" fill="none" stroke={part.color} strokeWidth="18"
            strokeDasharray={`${circumference * part.percent / 100} ${Math.max(0, circumference * (1 - part.percent / 100))}`}
            strokeDashoffset={-circumference * offset / 100} transform="rotate(-90 52 52)" />
        })}
      </svg>
      <dl className={styles.values}>
        <div><dt>Your new share</dt><dd id="pay-result-share">{percent(result.sharePercent)}</dd></div>
        <div><dt>{result.route === 'FUND' ? 'Raised after' : 'Revenue balance after'}</dt><dd id="pay-result-balance">{money.format(result.balanceAfter)}</dd></div>
        {result.cashoutValue !== null && <div><dt>Cash-out value</dt><dd>{money.format(result.cashoutValue)}</dd></div>}
      </dl>
    </div>
    <ul className={styles.legend} aria-label={`${result.route} ownership legend`}>
      {result.allocations.map(part => <li key={part.key}><i style={{ background: part.color }} aria-hidden="true" />{part.label}</li>)}
    </ul>
  </div>
}
