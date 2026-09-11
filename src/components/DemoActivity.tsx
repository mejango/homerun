import type { projectNetwork } from '../../web/network-model.mjs';
import { buildDemoActivity } from '@/lib/demo-activity';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const tokens = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function DemoActivity({ projection }: { projection: ReturnType<typeof projectNetwork> | null }) {
  const events = projection ? buildDemoActivity(projection) : [];
  return <section className="demo-activity" aria-label="Scenario activity" data-activity-phase={projection?.phase}>
    <h2>Activity</h2>
    <p className="demo-activity-source">{events.length ? `${events.length} demo events · Latest first` : 'Demo activity'}</p>
    {events.length ? <ol aria-label="Demo activity events">
      {events.map(event => <li key={event.id} data-activity-id={event.id} data-activity-kind={event.kind}>
        <span className="demo-activity-dot" aria-hidden="true" />
        <div className="demo-activity-body">
          <div className="demo-activity-topline">
            <h3>{event.title}</h3>
            {event.amount !== undefined && <span className="demo-activity-amount">
              {event.unit === 'USD' ? dollars.format(event.amount) : `${tokens.format(event.amount)} ${event.unit ?? ''}`}
            </span>}
          </div>
          <p>{event.detail}</p>
          <span className="demo-activity-period">{event.period}</span>
        </div>
      </li>)}
    </ol> : <p className="demo-activity-note">Check the modeling inputs to see this scenario.</p>}
    {events.length > 0 && <p className="demo-activity-note">Illustrative history follows the selected stage and modeling inputs.</p>}
  </section>;
}
