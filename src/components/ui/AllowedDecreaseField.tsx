'use client'

/** Max-slippage presets in basis points; 1% is the cross-client default. */
const SLIPPAGE_PRESETS_BPS = [50, 100, 300]

/** How far a return may fall from its quote: presets plus a custom percent. */
export function AllowedDecreaseField({
  bps,
  onChange,
  limitPercent = 100,
}: {
  bps: number
  onChange: (bps: number) => void
  /** The custom field accepts percents below this. */
  limitPercent?: number
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="shrink-0 text-xs font-medium text-smoke-700">Allowed decrease</span>
      {SLIPPAGE_PRESETS_BPS.map(preset => (
        <button
          key={preset}
          onClick={() => onChange(preset)}
          aria-pressed={bps === preset}
          className={`px-2.5 py-0.5 text-[11px] ${
            bps === preset
              ? 'inline-flex items-center justify-center rounded-lg border border-bluebs-500 bg-bluebs-25 font-medium text-bluebs-700'
              : 'btn-secondary'
          }`}
        >
          {preset / 100}%
        </button>
      ))}
      <label className="input-well !flex !h-7 !w-[76px] shrink-0 items-center px-2 text-[11px] text-smoke-700">
        <span className="sr-only">Custom allowed decrease percent</span>
        <input
          type="number"
          min="0"
          max={limitPercent - 0.01}
          step="0.1"
          inputMode="decimal"
          value={bps / 100}
          onChange={(event) => {
            const percent = Number(event.target.value)
            // Checked after rounding to basis points: 49.999% rounds to the 50% limit itself.
            const bps = Math.round(percent * 100)
            if (Number.isFinite(percent) && bps >= 0 && bps < limitPercent * 100) {
              onChange(bps)
            }
          }}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-right outline-none ring-0 focus:border-0 focus:ring-0"
        />
        <span>%</span>
      </label>
    </div>
  )
}
