import { projectNetwork } from './network-model.mjs';

const MONTH_LIMIT = 60;
const COHORTS = [
  { id: 'owner', label: 'Owner', color: '#34546a', field: 'revOwnerTokens' },
  { id: 'operators', label: 'Operator', color: '#42674d', field: 'revOperatorTokens' },
  { id: 'holders', label: 'Other FUND holders', color: '#b1bd91', field: 'revInvestorTokens' },
  { id: 'customers', label: 'Customers', color: '#b58e66', field: 'revRenterTokens' },
];
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/** Outstanding INCOME assuming all FUND participates in Sticky and rewards are fully vested.
 * The legacy holders calculation is the full-participation baseline, not live reward eligibility.
 * The four weekly vesting rounds after an ongoing reward claim are not modeled here. */
export function ownershipAtMonth(networkInputs = {}, month = 0) {
  if (!networkInputs || typeof networkInputs !== 'object' || Array.isArray(networkInputs)) {
    throw new TypeError('Income assumptions must be an object.');
  }
  if (!Number.isInteger(month) || month < 0 || month > MONTH_LIMIT) {
    throw new RangeError(`Month must be an integer between 0 and ${MONTH_LIMIT}.`);
  }
  const projection = projectNetwork({
    ...networkInputs,
    investment: 0,
    revenueMonths: month,
    fundRewardMode: 'holders',
    separateOwnerOperator: true,
  }, 'earning');
  const totalSupply = projection.revSupply;
  const groups = COHORTS.map(({ id, label, color, field }) => ({
    id, label, color,
    tokens: projection[field],
    percent: totalSupply > 0 ? projection[field] / totalSupply * 100 : 0,
  }));
  return {
    month,
    totalSupply,
    groups,
    revenue: projection.cumulativeRent,
    issuanceRate: projection.currentIssuanceRate,
  };
}

/** Mount once so editing assumptions never replaces the focused range control. */
export function initCreateIncomePreview(container) {
  container.classList.add('create-income-preview');
  container.innerHTML = `
    <h3 id="create-income-preview-title">INCOME ownership over time</h3>
    <div class="income-timeline-label">
      <label for="create-income-months">Months of revenue</label>
      <output id="create-income-month-label" for="create-income-months">At purchase</output>
    </div>
    <input id="create-income-months" type="range" min="0" max="${MONTH_LIMIT}" step="1" value="0" aria-describedby="create-income-preview-note">
    <div class="income-timeline-ends" aria-hidden="true"><span>At purchase</span><span>5 years</span></div>
    <p class="income-preview-error" role="status" hidden>Enter valid income assumptions to preview ownership.</p>
    <figure class="income-ownership-figure" aria-labelledby="create-income-preview-title">
      <div class="income-ownership-body">
        <div class="income-ownership-pie" role="img" aria-label="INCOME ownership at purchase">
          <div class="income-ownership-center" aria-hidden="true"><strong data-income-total>500,000</strong><span>INCOME</span></div>
        </div>
        <ul class="income-ownership-legend" aria-label="Outstanding INCOME by holder">
          ${COHORTS.map(group => `<li data-income-group="${group.id}"><span class="income-ownership-key" style="background:${group.color}" aria-hidden="true"></span><span class="income-ownership-label">${group.label}</span><strong data-income-share>—</strong><span data-income-tokens>—</span></li>`).join('')}
        </ul>
      </div>
      <div class="income-preview-revenue"><span>Revenue received</span><strong data-income-revenue>$0</strong></div>
      <figcaption id="create-income-preview-note">The Owner receives initial INCOME and Sticky rewards through their FUND share. The Operator receives its ongoing INCOME split. Expenses use the cash reserve first, then Operator token cash-outs. Projections assume all FUND participates in Sticky and rewards are fully vested; weekly reward vesting is not modeled.</figcaption>
    </figure>`;

  const slider = container.querySelector('#create-income-months');
  const output = container.querySelector('#create-income-month-label');
  const figure = container.querySelector('.income-ownership-figure');
  const error = container.querySelector('.income-preview-error');
  const pie = container.querySelector('.income-ownership-pie');
  const total = container.querySelector('[data-income-total]');
  const revenue = container.querySelector('[data-income-revenue]');
  let inputs = null;
  let month = 0;

  function render() {
    const when = month === 0 ? 'At purchase' : `Month ${month}`;
    output.textContent = when;
    slider.value = String(month);
    slider.setAttribute('aria-valuetext', when);
    slider.style.setProperty('--income-timeline-progress', `${month / MONTH_LIMIT * 100}%`);
    let state;
    try { state = ownershipAtMonth(inputs, month); } catch {
      slider.disabled = true;
      figure.hidden = true;
      error.hidden = false;
      return;
    }
    slider.disabled = false;
    figure.hidden = false;
    error.hidden = true;
    let cursor = 0;
    const stops = state.groups.map(group => {
      const start = cursor;
      cursor += group.percent;
      return `${group.color} ${start}% ${cursor}%`;
    });
    pie.style.background = state.totalSupply > 0 ? `conic-gradient(${stops.join(',')})` : '#e5e8dc';
    pie.setAttribute('aria-label', state.totalSupply > 0
      ? `${when}: ${state.groups.map(group => `${group.label} ${percent.format(group.percent)}%`).join(', ')} of outstanding INCOME.`
      : `${when}: no INCOME outstanding.`);
    total.textContent = number.format(state.totalSupply);
    total.nextElementSibling.textContent = state.totalSupply > 0 ? 'INCOME' : 'INCOME issued';
    for (const group of state.groups) {
      const row = container.querySelector(`[data-income-group="${group.id}"]`);
      row.querySelector('[data-income-share]').textContent = `${percent.format(group.percent)}%`;
      row.querySelector('[data-income-tokens]').textContent = `${number.format(group.tokens)} INCOME`;
    }
    revenue.textContent = money.format(state.revenue);
  }

  slider.addEventListener('input', () => {
    month = Number(slider.value);
    render();
  });

  return {
    update(networkInputs) {
      inputs = networkInputs && typeof networkInputs === 'object' ? { ...networkInputs } : null;
      render();
    },
    reset() {
      month = 0;
      render();
    },
  };
}
