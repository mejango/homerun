'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { ownershipAtMonth } from '../../web/create-income-preview.mjs';

type IncomeGroup = { id: string; label: string; color: string; tokens: number; percent: number };
type Ownership = { totalSupply: number; groups: IncomeGroup[]; revenue: number };
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export function CreateIncomePreview({ inputs }: { inputs: Record<string, unknown> | null }) {
  const [month, setMonth] = useState(0);
  const state = useMemo(() => {
    if (!inputs) return null;
    try { return ownershipAtMonth(inputs, month) as Ownership; } catch { return null; }
  }, [inputs, month]);
  const when = month === 0 ? 'At purchase' : `Month ${month}`;
  let cursor = 0;
  const stops = state?.groups.map(group => {
    const start = cursor;
    cursor += group.percent;
    return `${group.color} ${start}% ${cursor}%`;
  });

  return <div id="create-income-ownership" className="create-income-preview">
    <h3 id="create-income-preview-title">INCOME ownership over time</h3>
    <div className="income-timeline-label">
      <label htmlFor="create-income-months">Months of revenue</label>
      <output id="create-income-month-label" htmlFor="create-income-months">{when}</output>
    </div>
    <input id="create-income-months" type="range" min={0} max={60} step={1} value={month}
      onChange={event => setMonth(Number(event.target.value))} disabled={!state}
      aria-valuetext={when} aria-describedby="create-income-preview-note"
      style={{ '--income-timeline-progress': `${month / 60 * 100}%` } as CSSProperties} />
    <div className="income-timeline-ends" aria-hidden="true"><span>At purchase</span><span>5 years</span></div>
    {!state ? <p className="income-preview-error" role="status">Enter valid income assumptions to preview ownership.</p> :
      <figure className="income-ownership-figure" aria-labelledby="create-income-preview-title">
        <div className="income-ownership-body">
          <div className="income-ownership-pie" role="img"
            aria-label={`${when}: ${state.groups.map(group => `${group.label} ${percent.format(group.percent)}%`).join(', ')} of outstanding INCOME.`}
            style={{ background: state.totalSupply > 0 ? `conic-gradient(${stops?.join(',')})` : '#e5e8dc' }}>
            <div className="income-ownership-center" aria-hidden="true">
              <strong data-income-total>{number.format(state.totalSupply)}</strong><span>INCOME</span>
            </div>
          </div>
          <ul className="income-ownership-legend" aria-label="Outstanding INCOME by holder">
            {state.groups.map(group => <li key={group.id} data-income-group={group.id}>
              <span className="income-ownership-key" style={{ background: group.color }} aria-hidden="true" />
              <span className="income-ownership-label">{group.label}</span>
              <strong data-income-share>{percent.format(group.percent)}%</strong>
              <span data-income-tokens>{number.format(group.tokens)} INCOME</span>
            </li>)}
          </ul>
        </div>
        <div className="income-preview-revenue"><span>Revenue received</span><strong data-income-revenue>{money.format(state.revenue)}</strong></div>
        <figcaption id="create-income-preview-note">Expenses use the cash reserve first, then operator token cash-outs. Operator ownership includes their FUND share. Projections assume all FUND participates in Sticky and rewards are fully vested; weekly reward vesting is not modeled.</figcaption>
      </figure>}
  </div>;
}
