import type { projectNetwork } from '../../web/network-model.mjs';
import { buildDemoActivity, type DemoActivityEvent, type DemoActivityKind } from '@/lib/demo-activity';

const compactDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const compactTokens = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const fullDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 20 });
const fullTokens = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });

const iconPaths: Record<DemoActivityKind, string> = {
  configuration: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  contribution: 'M17 5 5 17M5 5v12h12',
  income: 'M17 5 5 17M5 5v12h12',
  milestone: 'M5 12.5 9.5 17 19 7',
  purchase: 'm3 10 9-7 9 7M5 9v11h14V9M10 20v-7h4v7',
  issuance: 'M4 7c0-2 3.6-3 8-3s8 1 8 3-3.6 3-8 3-8-1-8-3Zm0 0v5c0 2 3.6 3 8 3s8-1 8-3V7M4 12v5c0 2 3.6 3 8 3s8-1 8-3v-5',
  expense: 'M5 19 19 5M7 5h12v12',
  cashout: 'M5 19 19 5M7 5h12v12',
  reward: 'M3 8h18v4H3zM5 12v8h14v-8M12 8v12M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z',
  refund: 'M4 9h10a6 6 0 0 1 0 12M4 9l5-5M4 9l5 5',
  sale: 'm3 10 9-7 9 7M5 9v11h14V9M9 14h6M12 11v6',
};

function ActivityIcon({ kind }: { kind: DemoActivityKind }) {
  return <svg className="demo-activity-icon" data-activity-icon={kind} aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={iconPaths[kind]} /></svg>;
}

function preciseValue(amount: number, unit: DemoActivityEvent['unit']) {
  return unit === 'USD' ? fullDollars.format(amount) : `${fullTokens.format(amount)} ${unit ?? ''}`.trim();
}

function ActivityValue({ amount, unit }: { amount: number; unit: DemoActivityEvent['unit'] }) {
  const usd = unit === 'USD';
  const full = preciseValue(amount, unit);
  const compact = usd ? compactDollars.format(amount) : `${compactTokens.format(amount)} ${unit ?? ''}`.trim();
  return <span title={full}><span aria-hidden="true">{compact}</span><span className="demo-activity-accessible-value">{full}</span></span>;
}

function cashDirection(event: DemoActivityEvent): 'in' | 'out' | null {
  if (event.amount === undefined || event.amount === 0 || event.unit !== 'USD') return null;
  if (event.kind === 'contribution' || event.kind === 'income') return 'in';
  if (['expense', 'cashout', 'refund', 'purchase'].includes(event.kind)) return 'out';
  return null;
}

export function DemoActivity({ projection }: { projection: ReturnType<typeof projectNetwork> | null }) {
  const events = projection ? buildDemoActivity(projection) : [];
  return <section className="demo-activity" aria-label="Scenario activity" data-activity-phase={projection?.phase}>
    <div className="demo-activity-heading"><h2>Activity</h2><span className="demo-activity-count">{events.length || ''}</span></div>
    <p className="demo-activity-source">{events.length ? 'Modeled history | Latest first' : 'Demo activity'}</p>
    {events.length ? <ol aria-label="Demo activity events">
      {events.map(event => {
        const direction = cashDirection(event);
        return <li key={event.id} data-activity-id={event.id} data-activity-kind={event.kind}>
          <details className="demo-activity-event">
            <summary>
              <ActivityIcon kind={event.kind} />
              <span className="demo-activity-body">
                <span className="demo-activity-topline">
                  {event.amount !== undefined ? <span className="demo-activity-flow">
                    <strong className="demo-activity-amount"><ActivityValue amount={event.amount} unit={event.unit} /></strong>
                    {direction && <span className={`demo-activity-direction demo-activity-direction-${direction}`}>{direction}</span>}
                  </span> : <span className="demo-activity-action demo-activity-action-primary">{event.title}</span>}
                  <span className="demo-activity-period">{event.period}</span>
                </span>
                {event.amount !== undefined && <span className="demo-activity-action">{event.title}</span>}
                {event.tokens && <span className="demo-activity-effect"><ActivityValue amount={event.tokens.amount} unit={event.tokens.unit} /> {event.tokens.action}</span>}
              </span>
              <svg className="demo-activity-chevron" aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 4 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </summary>
            <div className="demo-activity-detail">
              {event.amount !== undefined && <p className="demo-activity-full-value">{preciseValue(event.amount, event.unit)}</p>}
              <p>{event.detail}</p>
            </div>
          </details>
        </li>;
      })}
    </ol> : <p className="demo-activity-note">Check the modeling inputs to see this scenario.</p>}
    {events.length > 0 && <p className="demo-activity-note">Illustrative events follow this scenario.</p>}
  </section>;
}
