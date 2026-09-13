'use client'

export function PaymentChainSelect({ label, value, options, disabled, onChange }: {
  label: string
  value: number
  options: { chainId: number; name: string }[]
  disabled?: boolean
  onChange: (chainId: number) => void
}) {
  const selected = options.find(option => option.chainId === value) ?? options[0]
  return <span className="payment-chain-control">
    <span className="payment-chain-value" aria-hidden="true">{selected?.name}</span>
    <select className="payment-chain-select" aria-label={label} value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
      {options.map(option => <option key={option.chainId} value={option.chainId}>{option.name}</option>)}
    </select>
  </span>
}
