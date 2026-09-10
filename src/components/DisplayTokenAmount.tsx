import { formatUnits } from 'viem'

/** Compact display only; the full precision remains available on hover. */
export function DisplayTokenAmount({ value, decimals = 18 }: { value: bigint; decimals?: number }) {
  const exact = formatUnits(value, decimals)
  const [whole, rawFraction = ''] = exact.split('.')
  const precision = whole === '0' ? 6 : 4
  const fraction = rawFraction.slice(0, precision).replace(/0+$/, '')
  const formatted = value > 0n && whole === '0' && !fraction
    ? `<${'0.' + '0'.repeat(precision - 1)}1`
    : `${BigInt(whole).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`
  return <span title={exact} className="tabular-nums">{formatted}</span>
}
