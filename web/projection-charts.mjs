const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value);
const compactMoney = value => `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`;
const percent = value => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)}%`;
const mounted = new WeakSet();
const listeningDocuments = new WeakSet();
const dismissedCharts = new WeakSet();
const touchPinnedCharts = new WeakSet();
const chartData = new WeakMap();
const budgetTriggers = new WeakMap();
let nextId = 0;

/** The complete fundraising goal, including cash already spent before closing. */
export function budgetChart(p) {
  const parts = [
    { name: 'Asset', value: p.purchaseBudget, kind: 'house' },
    { name: 'Cash reserve', value: p.opsReserve, kind: 'reserve' },
    { name: 'Fees & expenses', value: Math.max(0, Math.round((p.raiseGoal - p.purchaseBudget - p.opsReserve) * 100) / 100), kind: 'expenses' },
  ];
  const id = `projection-budget-${++nextId}`;
  return `<figure class="projection-chart pc-budget" data-projection-chart="budget">
    <figcaption id="${id}">What the raise pays for <span>${money(p.raiseGoal)} total</span></figcaption>
    <div class="pc-budget-bar" role="img" aria-label="${escape(parts.map(part => `${part.name}: ${money(part.value)}`).join('; '))}">${parts.map((part, index) => `<span class="pc-budget-segment pc-${part.kind}" data-budget-part="${index}" style="width:${p.raiseGoal > 0 ? part.value / p.raiseGoal * 100 : 0}%" aria-hidden="true"></span>`).join('')}</div>
    <ul class="pc-budget-legend">${parts.map((part, index) => `<li><button type="button" data-budget-part="${index}" data-budget-description="${escape(`${part.name}: ${money(part.value)} | ${percent(p.raiseGoal > 0 ? part.value / p.raiseGoal * 100 : 0)} of the total goal`)}" aria-describedby="${id}-tooltip"><i class="pc-budget-swatch pc-${part.kind}" aria-hidden="true"></i><span>${part.name}<strong>${money(part.value)}</strong></span></button></li>`).join('')}</ul>
    <div class="pc-tooltip pc-budget-tooltip" id="${id}-tooltip" role="tooltip" hidden></div>
  </figure>`;
}

function rowsThroughSelectedMonth(p) {
  if (!p.purchaseCompleted || !Array.isArray(p.history)) return [];
  return p.history.filter(row => row.month >= 0 && row.month <= p.monthsApplied);
}

function niceMaximum(value) {
  if (!(value > 0)) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}

function historyChart(p, { title, series, note, kind }) {
  const source = rowsThroughSelectedMonth(p);
  if (!source.length) return '';
  const rows = source.map(row => ({ month: row.month, values: series.map(item => row[item.key]) }));
  if (rows.some(row => row.values.some(value => !Number.isFinite(value) || value < 0))) return '';
  const last = rows.at(-1);
  const domain = Math.max(1, last.month);
  const maximum = niceMaximum(Math.max(...rows.flatMap(row => row.values)));
  const x = month => month / domain * 1000;
  const y = value => 160 - value / maximum * 160;
  const id = `projection-${kind}-${++nextId}`;
  const data = { rows, series, domain, maximum };
  const summary = `${title}. Illustrative monthly values from purchase through month ${last.month}. ${series.map((item, index) => `${item.name}: ${money(rows[0].values[index])} at purchase and ${money(last.values[index])} at month ${last.month}`).join('. ')}.`;
  const selectedText = row => `Month ${row.month}. ${series.map((item, index) => `${item.name}: ${money(row.values[index])}`).join('. ')}`;
  const ticks = [...new Set([0, Math.round(domain / 2), domain])];
  return `<figure class="projection-chart pc-history" data-projection-chart="history" data-chart-kind="${kind}" data-chart-data="${escape(JSON.stringify(data))}">
    <figcaption id="${id}">${title}<span>After purchase: months 0–${last.month}${p.phase === 'liquidated' ? ': before sale' : ''}</span></figcaption>
    <p class="pc-sr-only" id="${id}-summary">${escape(summary)}</p>
    <div class="pc-plot">
      <div class="pc-y-axis" aria-hidden="true">${[0, .5, 1].map(fraction => `<span style="bottom:${fraction * 100}%">${compactMoney(maximum * fraction)}</span>`).join('')}</div>
      <div class="pc-canvas" data-chart-plot>
        <svg viewBox="0 0 1000 160" preserveAspectRatio="none" role="img" aria-labelledby="${id}" aria-describedby="${id}-summary">
          ${[0, .5, 1].map(fraction => `<line class="pc-grid" x1="0" x2="1000" y1="${y(maximum * fraction)}" y2="${y(maximum * fraction)}"/>`).join('')}
          ${series.map((item, index) => `<path class="pc-line pc-series-${index}" d="${rows.map((row, position) => `${position ? 'L' : 'M'}${x(row.month).toFixed(2)},${y(row.values[index]).toFixed(2)}`).join(' ')}"/>`).join('')}
          <line class="pc-guide" data-chart-guide x1="${x(last.month)}" x2="${x(last.month)}" y1="0" y2="160"/>
        </svg>
        ${series.map((item, index) => `<span class="pc-point pc-point-${index}" data-chart-point="${index}" style="left:${last.month / domain * 100}%;top:${100 - last.values[index] / maximum * 100}%" aria-hidden="true"></span>`).join('')}
        <div class="pc-tooltip" id="${id}-tooltip" role="tooltip" hidden><strong data-chart-tooltip-month>Month ${last.month}</strong>${series.map((item, index) => `<span>${item.name}<b data-chart-tooltip-value="${index}">${money(last.values[index])}</b></span>`).join('')}</div>
      </div>
      <div class="pc-x-axis" aria-hidden="true">${ticks.map((month, index) => `<span class="${index === 0 ? 'pc-first-tick' : index === ticks.length - 1 ? 'pc-last-tick' : ''}" style="left:${month / domain * 100}%">${month === 0 ? 'Purchase' : `Month ${month}`}</span>`).join('')}</div>
    </div>
    <label class="pc-sr-only" for="${id}-month">Inspect ${title.toLowerCase()} by month</label>
    <input class="pc-month-slider" id="${id}-month" data-chart-month type="range" min="0" max="${last.month}" step="1" value="${last.month}" ${last.month === 0 ? 'disabled' : ''} aria-valuetext="${escape(selectedText(last))}" aria-describedby="${id}-hint">
    <ul class="pc-chart-legend">${series.map((item, index) => `<li><i class="pc-line-key pc-series-${index}" aria-hidden="true"></i><span>${item.name}</span></li>`).join('')}</ul>
    <p class="pc-chart-note" id="${id}-hint">${note} ${last.month > 0 ? 'Hover, tap, or move the slider to inspect a month.' : 'The chart starts at purchase.'}</p>
  </figure>`;
}

/** History stays before sale, when unused operating cash still sits in the reserve. */
export function cashHistoryChart(p) {
  return historyChart(p, {
    title: 'Cash over time',
    kind: 'cash',
    series: [{ key: 'revCash', name: 'Revenue held' }, { key: 'opsReserveCash', name: 'Cash reserve' }],
    note: p.phase === 'liquidated' ? 'History ends before the sale; unused reserve then returns to FUND holders.' : 'Two separate pools. The reserve pays asset expenses.',
  });
}

/** Reads the existing model's first-loan cash figure; it adds no fee assumptions. */
export function borrowingChart(p) {
  return historyChart(p, {
    title: 'Your borrowing power',
    kind: 'loan',
    series: [{ key: 'personalLoanCash', name: 'First loan, after estimated fees' }],
    note: 'A first-loan estimate at each month, assuming you have not borrowed. These amounts do not add up.',
  });
}

function dataFor(chart) {
  if (!chartData.has(chart)) chartData.set(chart, JSON.parse(chart.dataset.chartData));
  return chartData.get(chart);
}

function showHistoryMonth(chart, month) {
  const data = dataFor(chart);
  const row = data.rows.reduce((nearest, candidate) => Math.abs(candidate.month - month) < Math.abs(nearest.month - month) ? candidate : nearest);
  const slider = chart.querySelector('[data-chart-month]');
  slider.value = row.month;
  slider.setAttribute('aria-valuetext', `Month ${row.month}. ${data.series.map((series, index) => `${series.name}: ${money(row.values[index])}`).join('. ')}`);
  const guide = chart.querySelector('[data-chart-guide]');
  guide.setAttribute('x1', row.month / data.domain * 1000);
  guide.setAttribute('x2', row.month / data.domain * 1000);
  for (const point of chart.querySelectorAll('[data-chart-point]')) {
    const index = Number(point.dataset.chartPoint);
    point.style.left = `${row.month / data.domain * 100}%`;
    point.style.top = `${100 - row.values[index] / data.maximum * 100}%`;
  }
  chart.querySelector('[data-chart-tooltip-month]').textContent = `Month ${row.month}`;
  for (const value of chart.querySelectorAll('[data-chart-tooltip-value]')) value.textContent = money(row.values[Number(value.dataset.chartTooltipValue)]);
  const tooltip = chart.querySelector('.pc-tooltip');
  tooltip.hidden = false;
  tooltip.classList.toggle('pc-tooltip-left', row.month / data.domain > .55);
}

function positionBudgetTooltip(chart) {
  const trigger = budgetTriggers.get(chart);
  const tooltip = chart.querySelector('.pc-budget-tooltip');
  if (!trigger?.isConnected || !tooltip || tooltip.hidden) return;
  // Legend buttons fill their columns; anchor to the visible label inside them.
  const anchor = (trigger.matches('button') ? trigger.querySelector('span') : null) || trigger;
  const bounds = chart.getBoundingClientRect();
  const target = anchor.getBoundingClientRect();
  const view = chart.ownerDocument.defaultView;
  const margin = 8;
  const leftEdge = Math.max(bounds.left, margin);
  const rightEdge = Math.min(bounds.right, chart.ownerDocument.documentElement.clientWidth - margin);
  tooltip.style.maxWidth = `${Math.max(0, rightEdge - leftEdge)}px`;
  const bubble = tooltip.getBoundingClientRect();
  const left = Math.max(leftEdge, Math.min(target.left + target.width / 2 - bubble.width / 2, rightEdge - bubble.width));
  const above = target.top - bubble.height - margin;
  const below = target.bottom + margin;
  const top = above >= margin ? above : Math.min(below, view.innerHeight - bubble.height - margin);
  tooltip.style.left = `${left - bounds.left}px`;
  tooltip.style.top = `${Math.max(margin, top) - bounds.top}px`;
}

function showBudgetPart(chart, trigger) {
  const button = chart.querySelector(`button[data-budget-part="${trigger.dataset.budgetPart}"]`);
  if (!button) return;
  const tooltip = chart.querySelector('.pc-tooltip');
  tooltip.textContent = button.dataset.budgetDescription;
  tooltip.hidden = false;
  budgetTriggers.set(chart, trigger);
  positionBudgetTooltip(chart);
}

/** Call on the stable container after rendering. Repeated calls do not add listeners. */
export function initProjectionCharts(root = document) {
  if (mounted.has(root)) return;
  mounted.add(root);
  const within = node => node instanceof Element && root.contains(node);
  const hide = chart => {
    for (const tooltip of chart.querySelectorAll('.pc-tooltip')) tooltip.hidden = true;
    touchPinnedCharts.delete(chart);
    budgetTriggers.delete(chart);
  };
  const ownerDocument = root.ownerDocument || root;
  if (!listeningDocuments.has(ownerDocument)) {
    listeningDocuments.add(ownerDocument);
    const repositionBudgets = () => {
      for (const chart of ownerDocument.querySelectorAll('.pc-budget')) positionBudgetTooltip(chart);
    };
    ownerDocument.defaultView.addEventListener('resize', repositionBudgets);
    ownerDocument.addEventListener('scroll', repositionBudgets, { capture: true, passive: true });
    ownerDocument.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      for (const chart of ownerDocument.querySelectorAll('[data-projection-chart]')) {
        if (!chart.querySelector('.pc-tooltip:not([hidden])')) continue;
        hide(chart);
        dismissedCharts.add(chart);
      }
    });
    ownerDocument.addEventListener('pointerdown', event => {
      for (const chart of ownerDocument.querySelectorAll('[data-projection-chart]')) {
        if (!chart.contains(event.target)) hide(chart);
      }
    });
  }
  const inspect = event => {
    if (!within(event.target)) return;
    const chart = event.target.closest('[data-projection-chart]');
    if (!chart || dismissedCharts.has(chart)) return;
    const part = event.target.closest('[data-budget-part]');
    if (part) return showBudgetPart(chart, part);
    const plot = event.target.closest('[data-chart-plot]');
    if (!plot) return;
    const bounds = plot.getBoundingClientRect();
    const data = dataFor(chart);
    const month = Math.max(0, Math.min(data.rows.at(-1).month, Math.round((event.clientX - bounds.left) / bounds.width * data.domain)));
    showHistoryMonth(chart, month);
  };
  root.addEventListener('pointermove', inspect);
  root.addEventListener('pointerdown', event => {
    if (within(event.target)) {
      const chart = event.target.closest('[data-projection-chart]');
      if (chart) {
        dismissedCharts.delete(chart);
        if (event.pointerType === 'touch') touchPinnedCharts.add(chart);
      }
    }
    inspect(event);
  });
  root.addEventListener('pointerover', inspect);
  root.addEventListener('pointerout', event => {
    if (!within(event.target)) return;
    const chart = event.target.closest('[data-projection-chart]');
    if (chart && !chart.contains(event.relatedTarget)) {
      dismissedCharts.delete(chart);
      if (!touchPinnedCharts.has(chart) && !chart.contains(ownerDocument.activeElement)) hide(chart);
    }
  });
  root.addEventListener('input', event => {
    if (within(event.target) && event.target.matches('[data-chart-month]')) {
      const chart = event.target.closest('[data-projection-chart]');
      dismissedCharts.delete(chart);
      showHistoryMonth(chart, Number(event.target.value));
    }
  });
  root.addEventListener('focusin', event => {
    if (!within(event.target)) return;
    const chart = event.target.closest('[data-projection-chart]');
    if (!chart) return;
    dismissedCharts.delete(chart);
    if (event.target.matches('[data-chart-month]')) showHistoryMonth(chart, Number(event.target.value));
    else if (event.target.matches('[data-budget-part]')) showBudgetPart(chart, event.target);
  });
  root.addEventListener('focusout', event => {
    if (!within(event.target)) return;
    const chart = event.target.closest('[data-projection-chart]');
    if (chart && !touchPinnedCharts.has(chart) && !chart.contains(event.relatedTarget)) hide(chart);
  });
}
