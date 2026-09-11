import styles from './FundingProgress.module.css'

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const percentage = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

/** A display of the modeled raise, including completed and unsuccessful raises. */
export function FundingProgress({ raised, goal, historical = false }: { raised: number; goal: number; historical?: boolean }) {
  if (!Number.isFinite(raised) || !Number.isFinite(goal) || raised < 0 || goal < 0) {
    return <figure className={styles.chart}><figcaption>Funding progress unavailable.</figcaption></figure>
  }

  const funded = goal > 0 ? raised / goal * 100 : 0
  const filled = Math.min(100, Math.max(0, funded))
  const remaining = Math.max(0, goal - raised)
  const overGoal = Math.max(0, raised - goal)
  const remainderLabel = historical ? 'Unraised' : 'Remaining'
  const readablePercent = funded > 0 && funded < 0.1 ? '<0.1' : percentage.format(funded)
  const valueText = goal > 0
    ? `${currency.format(raised)} raised of ${currency.format(goal)} goal. ${readablePercent}% funded. ${overGoal > 0 ? `${currency.format(overGoal)} above goal.` : `${currency.format(remaining)} ${historical ? 'below goal' : 'remaining to goal'}.`}`
    : `${currency.format(raised)} raised. A funding goal has not been set.`

  return <figure className={styles.chart} aria-label={historical ? 'Fundraising result' : 'Fundraising progress'}>
    <div
      className={styles.track}
      role={goal > 0 ? 'progressbar' : 'img'}
      aria-label={goal > 0 ? historical ? 'Funds raised against the goal' : 'Funding goal progress' : valueText}
      aria-valuemin={goal > 0 ? 0 : undefined}
      aria-valuemax={goal > 0 ? 100 : undefined}
      aria-valuenow={goal > 0 ? filled : undefined}
      aria-valuetext={goal > 0 ? valueText : undefined}
      title={valueText}
    >
      <span className={styles.raised} style={{ width: `${filled}%` }} aria-hidden="true" />
    </div>
    <figcaption className={styles.legend}>
      <span className={styles.legendItem}>
        <i className={`${styles.swatch} ${styles.raisedSwatch}`} aria-hidden="true" />
        <span>Raised <strong>{goal > 0 ? `${readablePercent}%` : currency.format(raised)}</strong></span>
      </span>
      <span className={styles.legendItem}>
        {overGoal === 0 && <i className={styles.swatch} aria-hidden="true" />}
        <span>{goal > 0 ? overGoal > 0 ? 'Above goal' : remainderLabel : 'Goal not set'}{goal > 0 && <strong>{overGoal > 0 ? currency.format(overGoal) : `${percentage.format(100 - filled)}%`}</strong>}</span>
      </span>
    </figcaption>
  </figure>
}
