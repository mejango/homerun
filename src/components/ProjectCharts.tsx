'use client';

import { useId, useState, type PointerEvent } from 'react';

type HistoryRow = {
  month: number;
  revCash: number;
  opsReserveCash: number;
  personalLoanCash: number;
};

/** The chart inputs are a subset of the pure projectNetwork result. */
export type ProjectionChartData = {
  purchaseBudget: number;
  opsReserve: number;
  raiseGoal: number;
  purchaseCompleted: boolean;
  monthsApplied: number;
  phase: string;
  history: HistoryRow[];
  operatorFundMinted: boolean;
  fundOperatorMint: number;
  fundSupply: number;
  personalFundTokens: number;
  revSupply: number;
  personalRevTokens: number;
  revInvestorTokens: number;
  revOperatorTokens: number;
  revRenterTokens: number;
  revStickyPendingTokens: number;
  revStickyUnallocatedTokens: number;
};

type ChartProps = { projection: ProjectionChartData };
type HistorySeries = { key: Exclude<keyof HistoryRow, 'month'>; name: string };
type OwnershipPart = { label: string; kind: string; value: number };

const money = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
}).format(value);
const compactMoney = (value: number) => `$${new Intl.NumberFormat('en-US', {
  notation: 'compact', maximumFractionDigits: 1,
}).format(value)}`;
const number = (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const percent = (value: number) => value > 0 && value < .01 ? '<0.01%' : `${number(value)}%`;

export function BudgetChart({ projection: p }: ChartProps) {
  const id = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const parts = [
    { name: 'Asset', value: p.purchaseBudget, kind: 'house' },
    { name: 'Cash reserve', value: p.opsReserve, kind: 'reserve' },
    { name: 'Fees & expenses', value: Math.max(0, Math.round((p.raiseGoal - p.purchaseBudget - p.opsReserve) * 100) / 100), kind: 'expenses' },
  ];
  const share = (value: number) => p.raiseGoal > 0 ? value / p.raiseGoal * 100 : 0;
  const selectedPart = selected === null ? undefined : parts[selected];
  return (
    <figure className="projection-chart pc-budget" data-projection-chart="budget"
      onKeyDown={event => { if (event.key === 'Escape') setSelected(null); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSelected(null); }}
      onPointerLeave={event => { if (event.pointerType !== 'touch') setSelected(null); }}>
      <figcaption id={id}>What the raise pays for <span>{money(p.raiseGoal)} total</span></figcaption>
      <div className="pc-budget-bar" role="img" aria-label={parts.map(part => `${part.name}: ${money(part.value)}`).join('; ')}>
        {parts.map((part, index) => (
          <span key={part.kind} className={`pc-budget-segment pc-${part.kind}`} data-budget-part={index}
            style={{ width: `${share(part.value)}%` }} aria-hidden="true"
            onPointerEnter={() => setSelected(index)} onPointerDown={() => setSelected(index)} />
        ))}
      </div>
      <ul className="pc-budget-legend">
        {parts.map((part, index) => (
          <li key={part.kind}>
            <button type="button" data-budget-part={index} aria-describedby={selected === index ? `${id}-tooltip` : undefined}
              onFocus={() => setSelected(index)} onPointerEnter={() => setSelected(index)} onClick={() => setSelected(index)}>
              <i className={`pc-budget-swatch pc-${part.kind}`} aria-hidden="true" />
              <span>{part.name}<strong>{money(part.value)}</strong></span>
            </button>
          </li>
        ))}
      </ul>
      <div className="pc-tooltip pc-budget-tooltip" id={`${id}-tooltip`} role="tooltip" hidden={!selectedPart}
        style={{ top: 'auto', bottom: '100%', marginBottom: 8 }}>
        {selectedPart && `${selectedPart.name}: ${money(selectedPart.value)} | ${percent(share(selectedPart.value))} of the total goal`}
      </div>
    </figure>
  );
}

function niceMaximum(value: number) {
  if (!(value > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}

function HistoryChart({ projection: p, title, series, note, kind }: ChartProps & {
  title: string; series: HistorySeries[]; note: string; kind: string;
}) {
  const id = useId();
  const [selectedMonth, setSelectedMonth] = useState<number | null>(null);
  const [showTooltip, setShowTooltip] = useState(false);
  const rows = p.purchaseCompleted && Array.isArray(p.history)
    ? p.history.filter(row => row.month >= 0 && row.month <= p.monthsApplied)
      .map(row => ({ month: row.month, values: series.map(item => row[item.key]) }))
    : [];
  const last = rows.at(-1);
  if (!last || rows.some(row => row.values.some(value => !Number.isFinite(value) || value < 0))) return null;
  const first = rows[0];
  const domain = Math.max(1, last.month);
  const maximum = niceMaximum(Math.max(...rows.flatMap(row => row.values)));
  const x = (month: number) => month / domain * 1000;
  const y = (value: number) => 160 - value / maximum * 160;
  const selected = selectedMonth === null ? last : rows.reduce((nearest, row) => (
    Math.abs(row.month - selectedMonth) < Math.abs(nearest.month - selectedMonth) ? row : nearest
  ));
  const ticks = [...new Set([0, Math.round(domain / 2), domain])];
  const selectedText = `Month ${selected.month}. ${series.map((item, index) => `${item.name}: ${money(selected.values[index])}`).join('. ')}`;
  const inspect = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    setSelectedMonth(Math.max(0, Math.min(last.month, Math.round((event.clientX - bounds.left) / bounds.width * domain))));
    setShowTooltip(true);
  };
  return (
    <figure className="projection-chart pc-history" data-projection-chart="history" data-chart-kind={kind}
      onKeyDown={event => { if (event.key === 'Escape') setShowTooltip(false); }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setShowTooltip(false); }}
      onPointerLeave={event => { if (event.pointerType !== 'touch') setShowTooltip(false); }}>
      <figcaption id={id}>{title}<span>After purchase, months 0–{last.month}{p.phase === 'liquidated' ? ', before sale' : ''}</span></figcaption>
      <p className="pc-sr-only" id={`${id}-summary`}>
        {title}. Illustrative monthly values from purchase through month {last.month}.{' '}
        {series.map((item, index) => `${item.name}: ${money(first.values[index])} at purchase and ${money(last.values[index])} at month ${last.month}`).join('. ')}.
      </p>
      <div className="pc-plot">
        <div className="pc-y-axis" aria-hidden="true">
          {[0, .5, 1].map(fraction => <span key={fraction} style={{ bottom: `${fraction * 100}%` }}>{compactMoney(maximum * fraction)}</span>)}
        </div>
        <div className="pc-canvas" data-chart-plot onPointerMove={inspect} onPointerDown={inspect}>
          <svg viewBox="0 0 1000 160" preserveAspectRatio="none" role="img" aria-labelledby={id} aria-describedby={`${id}-summary`}>
            {[0, .5, 1].map(fraction => <line key={fraction} className="pc-grid" x1="0" x2="1000" y1={y(maximum * fraction)} y2={y(maximum * fraction)} />)}
            {series.map((item, index) => (
              <path key={item.key} className={`pc-line pc-series-${index}`}
                d={rows.map((row, position) => `${position ? 'L' : 'M'}${x(row.month).toFixed(2)},${y(row.values[index]).toFixed(2)}`).join(' ')} />
            ))}
            <line className="pc-guide" data-chart-guide x1={x(selected.month)} x2={x(selected.month)} y1="0" y2="160" />
          </svg>
          {series.map((item, index) => (
            <span key={item.key} className={`pc-point pc-point-${index}`} data-chart-point={index}
              style={{ left: `${selected.month / domain * 100}%`, top: `${100 - selected.values[index] / maximum * 100}%` }} aria-hidden="true" />
          ))}
          <div className={`pc-tooltip${selected.month / domain > .55 ? ' pc-tooltip-left' : ''}`} id={`${id}-tooltip`} role="tooltip" hidden={!showTooltip}>
            <strong data-chart-tooltip-month>Month {selected.month}</strong>
            {series.map((item, index) => <span key={item.key}>{item.name}<b data-chart-tooltip-value={index}>{money(selected.values[index])}</b></span>)}
          </div>
        </div>
        <div className="pc-x-axis" aria-hidden="true">
          {ticks.map((month, index) => (
            <span key={month} className={index === 0 ? 'pc-first-tick' : index === ticks.length - 1 ? 'pc-last-tick' : undefined}
              style={{ left: `${month / domain * 100}%` }}>{month === 0 ? 'Purchase' : `Month ${month}`}</span>
          ))}
        </div>
      </div>
      <label className="pc-sr-only" htmlFor={`${id}-month`}>Inspect {title.toLowerCase()} by month</label>
      <input className="pc-month-slider" id={`${id}-month`} data-chart-month type="range" min="0" max={last.month} step="1"
        value={selected.month} disabled={last.month === 0} aria-valuetext={selectedText} aria-describedby={`${id}-hint`}
        onChange={event => { setSelectedMonth(Number(event.target.value)); setShowTooltip(true); }} onFocus={() => setShowTooltip(true)} />
      <ul className="pc-chart-legend">
        {series.map((item, index) => <li key={item.key}><i className={`pc-line-key pc-series-${index}`} aria-hidden="true" /><span>{item.name}</span></li>)}
      </ul>
      <p className="pc-chart-note" id={`${id}-hint`}>{note} {last.month > 0 ? 'Hover, tap, or move the slider to inspect a month.' : 'The chart starts at purchase.'}</p>
      <details className="pc-chart-note">
        <summary>View monthly values</summary>
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <table>
            <caption className="pc-sr-only">{title}, monthly modeling estimates</caption>
            <thead><tr><th scope="col">Month</th>{series.map(item => <th key={item.key} scope="col">{item.name}</th>)}</tr></thead>
            <tbody>{rows.map(row => <tr key={row.month}><th scope="row">{row.month === 0 ? 'Purchase' : row.month}</th>{row.values.map((value, index) => <td key={series[index].key}>{money(value)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export function CashHistoryChart({ projection }: ChartProps) {
  return <HistoryChart projection={projection} title="Cash over time" kind="cash"
    series={[{ key: 'revCash', name: 'Revenue held' }, { key: 'opsReserveCash', name: 'Cash reserve' }]}
    note={projection.phase === 'liquidated' ? 'History ends before the sale; unused reserve then returns to FUND holders.' : 'Two separate pools. The reserve pays asset expenses.'} />;
}

export function BorrowingChart({ projection }: ChartProps) {
  return <HistoryChart projection={projection} title="Your borrowing power" kind="loan"
    series={[{ key: 'personalLoanCash', name: 'First loan, after estimated fees' }]}
    note="A first-loan estimate at each month, assuming you have not borrowed. These amounts do not add up." />;
}

function OwnershipRing({ token, total, parts, note, empty }: {
  token: 'FUND' | 'INCOME'; total: number; parts: OwnershipPart[]; note: string; empty: string;
}) {
  const id = useId();
  const visible = total > 0 ? parts.filter(part => part.value > 0) : [];
  const summary = total > 0
    ? `${token} outstanding: ${number(total)} tokens. ${visible.map(part => `${part.label}: ${percent(part.value / total * 100)}, ${number(part.value)} tokens`).join('. ')}.`
    : empty;
  return (
    <figure className="ownership-card" data-ownership-chart={token.toLowerCase()} data-ownership-total={total}>
      <figcaption id={id}>{token} ownership<span>{token === 'FUND' ? 'Asset-sale claim' : 'Revenue claim'}</span></figcaption>
      <div className="ownership-body">
        <svg className="ownership-ring" viewBox="0 0 140 140" role="img" aria-labelledby={id} aria-describedby={`${id}-summary`}>
          <desc id={`${id}-summary`}>{summary}</desc>
          <circle className="ownership-ring-track" cx="70" cy="70" r="49" />
          <g transform="rotate(-90 70 70)">
            {visible.map((part, index) => {
              const share = part.value / total * 100;
              const offset = visible.slice(0, index).reduce((sum, previous) => sum + previous.value / total * 100, 0);
              return <circle key={part.kind} className={`ownership-segment ownership-${part.kind}`} cx="70" cy="70" r="49" pathLength="100"
                strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-offset}>
                <title>{`${part.label}: ${percent(share)}, ${number(part.value)} ${token}`}</title>
              </circle>;
            })}
          </g>
          <text x="70" y="67" className="ownership-ring-label">{token}</text>
          <text x="70" y="85" className="ownership-ring-caption">{total > 0 ? 'outstanding' : 'none'}</text>
        </svg>
        {total > 0 ? <ul className="ownership-legend">
          {visible.map(part => <li key={part.kind} data-owner={part.kind} data-owner-tokens={part.value}>
            <i className={`ownership-key ownership-${part.kind}`} aria-hidden="true" /><span>{part.label}</span><strong>{percent(part.value / total * 100)}</strong>
          </li>)}
        </ul> : <p className="ownership-empty">{empty}</p>}
      </div>
      <p className="ownership-note">{note}</p>
      {total > 0 && <details className="ownership-note">
        <summary>View token balances</summary>
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <table>
            <caption>{token} outstanding balances</caption>
            <thead><tr><th scope="col">Holder</th><th scope="col">Tokens</th><th scope="col">Share</th></tr></thead>
            <tbody>{visible.map(part => <tr key={part.kind}><th scope="row">{part.label}</th><td>{number(part.value)}</td><td>{percent(part.value / total * 100)}</td></tr>)}</tbody>
          </table>
        </div>
      </details>}
    </figure>
  );
}

/** Current outstanding claims, distinct from the allocation of newly issued tokens. */
export function OwnershipCharts({ projection: p }: ChartProps) {
  const operatorFund = p.operatorFundMinted ? p.fundOperatorMint : 0;
  return (
    <section className="ownership-section" aria-label="Token ownership at this stage">
      <div className="ownership-heading"><h3>Who holds the tokens?</h3><p>Shares of outstanding tokens at this stage.</p></div>
      <div className="ownership-charts">
        <OwnershipRing token="FUND" total={p.fundSupply}
          parts={[
            { label: 'You', kind: 'you', value: p.personalFundTokens },
            { label: 'Other investors', kind: 'investors', value: Math.max(0, p.fundSupply - p.personalFundTokens - operatorFund) },
            { label: 'Operators', kind: 'operators', value: operatorFund },
          ]}
          empty={p.phase === 'refunded' ? 'All FUND was redeemed for refunds.' : 'No FUND has been issued.'}
          note={p.phase === 'refunded' ? 'The asset was not purchased.' : p.purchaseCompleted
            ? p.phase === 'liquidated' ? 'Sale claims are shown before FUND is redeemed.' : 'Includes the operators’ allocation at purchase.'
            : 'Current fundraising tokens; the operators’ allocation comes after purchase.'} />
        <OwnershipRing token="INCOME" total={p.revSupply}
          parts={[
            { label: 'You', kind: 'you', value: p.personalRevTokens },
            { label: 'Other investors', kind: 'investors', value: Math.max(0, p.revInvestorTokens - p.personalRevTokens) },
            { label: 'Operators', kind: 'operators', value: p.revOperatorTokens },
            { label: 'Customers', kind: 'customers', value: p.revRenterTokens },
            { label: 'Rewards waiting', kind: 'pending', value: p.revStickyPendingTokens },
            { label: 'Unallocated', kind: 'unallocated', value: p.revStickyUnallocatedTokens },
          ]}
          empty={p.purchaseCompleted ? 'No INCOME remains outstanding.' : 'No INCOME has been issued.'}
          note={!p.purchaseCompleted ? 'Revenue tokens start after a successful purchase.' : p.revStickyPendingTokens > 0
            ? '“You” shows available INCOME. Waiting rewards for all holders are counted separately.'
            : p.revStickyUnallocatedTokens > 0 ? 'Unallocated rewards stay in supply without a holder.' : 'Current token balances, after any modeled cash-outs.'} />
      </div>
    </section>
  );
}
