const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

/** Every dollar figure a setup supplies reads the same on the live, preview and intent pages. */
export function money(value: number): string {
  return usd.format(value)
}
