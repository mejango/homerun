import { DEFAULT_SCENARIO, LOAN_FEE_ASSUMPTIONS, projectScenario } from './lifecycle-model.mjs';

const phases = [
  ['raising', 'Raising funds'],
  ['funded', 'Raise complete'],
  ['refunding', 'Refunding'],
  ['refunded', 'Refunds complete'],
  ['earning', 'Earning rent'],
  ['paid_off', 'Paid off'],
];
const money = value => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2,
}).format(value);
const num = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let phase = 'raising';
let inputs = { ...DEFAULT_SCENARIO };
let projection = null;

function field(key, label, options = {}) {
  return `<label for="field-${key}" class="projection-field"><span>${label}</span><div class="field-control">${options.prefix ? `<span aria-hidden="true">${options.prefix}</span>` : ''}<input id="field-${key}" data-input="${key}" type="number" min="${options.min ?? 0}" ${options.max !== undefined ? `max="${options.max}"` : ''} step="${options.step ?? .01}" value="${inputs[key]}" required>${options.suffix ? `<span aria-hidden="true">${options.suffix}</span>` : ''}</div></label>`;
}

document.querySelector('#main').innerHTML = `<div class="simulator">
  <section class="deal-heading"><div><span class="kicker">Life of an investment</span><h1>Founder Haus</h1><p>Edit the numbers. See what happens at each stage.</p></div><div class="deal-image"><img src="./assets/courtyard-property.png" alt="Illustrative property, not a photograph of Founder Haus"><span>Illustration</span></div></section>

  <section class="state-picker" aria-labelledby="state-label"><div class="picker-label"><h2 id="state-label">Show a possible state</h2><span>Simulation only</span></div><div class="phase-buttons">${phases.map(([id, label]) => `<button type="button" data-phase="${id}" aria-pressed="${id === phase}">${label}</button>`).join('')}</div></section>

  <div class="simulator-layout">
    <aside class="assumptions"><button type="button" id="toggle-assumptions" class="assumptions-toggle" aria-controls="assumptions-body" aria-expanded="true"><span>Your assumptions</span><span id="assumptions-toggle-label">Hide ↑</span></button><div id="assumptions-body"><form id="projection-form" novalidate>
      <div class="input-pair">${field('goal', 'Property needs ($)', { prefix: '$', min: .01 })}${field('investment', 'You invest ($)', { prefix: '$', min: .01 })}</div>
      <div class="input-pair">${field('monthlyRent', 'Monthly rent ($)', { prefix: '$' })}${field('monthlyCosts', 'Costs & reserves / month ($)', { prefix: '$' })}</div>
      <div class="input-pair">${field('investorPercent', 'Remaining rent to investors (%)', { suffix: '%', max: 100 })}${field('returnPercent', 'Target total gain (%)', { suffix: '%', max: 500 })}</div>
      <p class="input-hint">The gain is over the whole investment, not per year.</p>
      <div id="raise-input" class="state-input">${field('raisedPercent', 'Amount of raise collected (%)', { suffix: '%', max: 100 })}</div>
      <div id="revenue-input" class="state-input" hidden>${field('revenueMonths', 'Months of rent collected', { min: 0, max: 1200, step: 1 })}</div>
      <p id="projection-error" role="alert" hidden></p>
      <button type="button" class="save-scenario" id="download-scenario">Save this scenario <span aria-hidden="true">↓</span></button>
    </form><p class="assumptions-note">Rent and costs are unverified examples. Loan quotes include assumed upfront fees. Taxes, cash-out fees and transactions are not simulated.</p></div></aside>

    <section class="process" aria-label="Investment process"><ol id="process-steps" class="process-steps"></ol><div id="phase-panel" class="phase-panel" aria-live="polite"></div><div class="process-navigation"><button type="button" id="failure-state" class="quiet-button">What if the raise fails?</button><button type="button" id="next-state" class="button"></button></div></section>
  </div>
</div>`;

function metric(id, label, value, note = '', emphasis = false) {
  return `<div class="state-metric ${emphasis ? 'emphasis' : ''}"><span>${label}</span><strong id="${id}">${money(value)}</strong>${note ? `<p>${note}</p>` : ''}</div>`;
}

function progress(label, current, target, endLabel) {
  const percent = target > 0 ? Math.min(100, current / target * 100) : 100;
  return `<div class="scenario-progress"><div><span>${label}</span><strong>${num(percent)}%</strong></div><div id="scenario-progress" class="scenario-progress-bar" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(2)}" aria-valuetext="${money(current)} of ${money(target)}"><span style="width:${percent}%"></span></div><p>${money(current)} of ${money(target)} ${endLabel}</p></div>`;
}

function receiptNote(text) {
  return `<div class="your-position"><span class="person-mark" aria-hidden="true">You</span><p>${text}</p></div>`;
}

function rentFlow(p) {
  return `<div class="rent-flow"><div><span>Monthly rent</span><strong>${money(p.monthlyRent)}</strong></div><span class="flow-operator" aria-hidden="true">−</span><div><span>Costs & reserves</span><strong>${money(p.monthlyCosts)}</strong></div><span class="flow-operator" aria-hidden="true">→</span><div class="rent-destination"><span>To investor pool</span><strong>${money(p.monthlySweep)}</strong></div></div>${p.operatingShortfall > 0 ? `<p class="scenario-caution">Rent is ${money(p.operatingShortfall)} short of monthly costs. Nothing reaches investors.</p>` : `<p class="flow-note">The owner keeps the other ${money(p.monthlyOwnerShare)} per month.</p>`}`;
}

function holderChoices(p) {
  const status = p.loanAvailable ? 'Available in this scenario' : 'No cash to borrow yet';
  return `<section class="holder-options" aria-labelledby="holder-heading">
    <div class="holder-heading"><h3 id="holder-heading">Your ${money(p.investment)} investment</h3><p>Borrow or cash out using the same tokens.</p></div>
    <div class="holder-cards">
      <div class="loan-card">
        <h4>Borrow against your tokens</h4><span class="loan-status" id="loan-status">${status}</span>
        <strong class="choice-amount" id="your-loan-cash">${money(p.personalLoanCash)}</strong><span class="choice-caption">Estimated cash you receive, after fees</span>
        <div class="loan-breakdown"><div><span>Loan principal</span><strong id="your-loan-principal">${money(p.personalLoanPrincipal)}</strong></div><div><span>Assumed upfront fees (${num(LOAN_FEE_ASSUMPTIONS.totalPercent)}%)</span><strong id="your-loan-fees">${money(p.personalLoanFees)}</strong></div></div>
        <p>Pledge your tokens. Repay the loan and any further fees to get them back. An expired loan can forfeit them.</p>
      </div>
      <div class="cashout-card">
        <h4>Cash out your tokens</h4><span class="choice-alternative">Or leave the investment</span>
        <strong class="choice-amount" id="your-cashout">${money(p.personalCashout)}</strong><span class="choice-caption">Cash-out value, before fees</span>
        <p>Exchange your tokens for cash. You give up their future value.</p>
      </div>
    </div>
    <p class="choice-note">You cannot borrow and cash out with the same tokens at the same time.</p>
    ${phase === 'earning' && !p.goalReached ? `<div class="loan-growth"><div><span>If you wait one more month</span><p>Borrow <strong id="next-month-loan">${money(p.nextMonthLoanCash)}</strong> <span class="loan-increase" id="loan-increase">(+${money(p.nextMonthLoanCashIncrease)})</span></p><small>Estimated after fees, assuming the same rent and no loan today.</small></div><button type="button" id="add-rent-month" ${p.revenueMonths >= 1200 ? 'disabled' : ''}>+1 month of rent <span aria-hidden="true">→</span></button></div>` : ''}
    <details class="holder-choices"><summary>Loan estimate & terms</summary><div><p>This estimates a first loan against all your tokens. Rent adds cash to the pool, which increases what those tokens can borrow. Only cash already in the pool is available today.</p><p>Assumed upfront fees: ${num(LOAN_FEE_ASSUMPTIONS.terminalPercent)}% terminal + ${num(LOAN_FEE_ASSUMPTIONS.sourcePercent)}% prepaid source fee + ${num(LOAN_FEE_ASSUMPTIONS.revPercent)}% Revnet fee. These are not annual rates. The minimum source fee covers 182.5 days; further source fees accrue afterward. Loans expire after 10 years.</p><p>This illustration assumes one cash asset, zero cash-out tax, and no existing loans or prior redemptions. A live quote must check available cash, your unpledged tokens and current fees.</p></div></details>
  </section>`;
}

function poolBalance(p, note) {
  return `<div class="pool-balance"><div><span>Cash in the pool for all investors</span><p>${note}</p></div><strong id="cash-in-pool">${money(p.backingCash)}</strong></div>`;
}

function renderPanel(p) {
  let title, explanation, content;
  if (phase === 'raising') {
    title = p.raised >= p.goal ? 'The funding goal is reached.' : 'Investors are funding the property.';
    explanation = 'Money stays in escrow. It has not paid for the property yet.';
    content = `<div class="state-metrics">${metric('escrow-cash', 'Collected so far', p.escrowCash, 'Held for this raise.')}${metric('raise-gap', 'Still needed', p.goal - p.raised, `The property needs ${money(p.goal)}.`)}</div>${progress('Fundraising progress', p.raised, p.goal, 'collected')}${receiptNote(`Your <strong>${money(inputs.investment)}</strong> is part of the raise. You hold a subscription receipt.`)}`;
  } else if (phase === 'funded') {
    title = 'The raise is complete. Closing is next.';
    explanation = 'The funding goal was met. Money stays in escrow until the closing conditions are satisfied.';
    content = `<div class="state-metrics single">${metric('escrow-cash', 'Waiting in escrow', p.escrowCash, 'The full raise is still here.')}</div><div class="closing-uses"><span>At closing</span><div><span>Pay the debt</span><span>Pay closing costs</span><span>Fund reserves</span></div></div>${receiptNote(`After the deal closes, your <strong>${money(inputs.investment)}</strong> receipt exchanges for property tokens. Borrowing becomes available as rent adds cash behind them.`)}`;
  } else if (phase === 'refunding') {
    title = 'The raise failed. Return the money.';
    explanation = 'Closing never happened in this scenario. The money is still in escrow and can be refunded.';
    content = `<div class="state-metrics">${metric('refundable-cash', 'Available for all refunds', p.refundableCash, 'Still held in escrow.')}${metric('your-refund', 'Your refund before fees', p.personalRefund, 'Your subscription is returned.', true)}</div>${progress('Refunds completed', 0, p.raised, 'returned')}<p class="plain-note">No property tokens are issued. If funds had already left for a closing agent, they would need to be returned first.</p>`;
  } else if (phase === 'refunded') {
    title = 'The investors have been refunded.';
    explanation = 'This investment ends here. The property was not financed.';
    content = `<div class="state-metrics">${metric('refunded-cash', 'Returned to investors', p.refundedCash, 'Before any applicable fees.')}${metric('escrow-cash', 'Left in escrow', p.escrowCash, 'No further investment claims.')}</div>${progress('Refunds completed', p.refundedCash, p.raised, 'returned')}${receiptNote(`Your <strong>${money(p.personalRefund)}</strong> has been returned in this scenario, before fees.`)}`;
  } else if (phase === 'earning') {
    title = p.goalReached ? 'The repayment goal is funded.' : 'As rent comes in, you can borrow more.';
    explanation = p.goalReached ? 'Enough cash is set aside for the repayment goal. Legal release is the remaining step.' : 'Rent covers costs first. Your share of the cash left in the pool can back a loan against your tokens.';
    content = `${p.goalReached ? `<p class="plain-note">The property’s contributions stop at the funded goal. The final month adds only the remaining amount needed.</p>` : rentFlow(p)}${poolBalance(p, `After ${num(p.monthsApplied)} months of rent.`)}${holderChoices(p)}${progress('Repayment goal funded', p.backingCash, p.totalTarget, 'set aside for investors')}<div class="personal-goal"><span>Your goal, including your investment</span><strong id="your-target">${money(p.personalTarget)}</strong></div><p class="timing-note" id="payoff-timing">${p.payoffMonths === null ? 'These rents do not fund the goal.' : `At these inputs: ${num(p.payoffMonths)} months (${num(p.payoffMonths / 12)} years) from the first rent payment to the goal.`} Timing and returns are not guaranteed.</p>`;
  } else {
    title = 'The property is paid off.';
    explanation = 'This state assumes the goal is funded and legal release is complete. The money stays in the pool for token holders.';
    content = `${poolBalance(p, 'The property can stop paying.')}${p.settlementFundingNeeded > 0 ? `<p class="scenario-caution" id="settlement-note">These rents never fund payoff. This state requires a separate ${money(p.settlementFundingNeeded)} deposit, such as sale or refinance proceeds.</p>` : ''}${holderChoices(p)}${progress('Repayment goal funded', p.backingCash, p.totalTarget, 'set aside')}<div class="personal-goal"><span>Your funded goal</span><strong id="your-target">${money(p.personalTarget)}</strong></div>${p.settlementFundingNeeded > 0 ? '' : `<p class="timing-note" id="payoff-timing">This projection advances to month ${num(p.monthsApplied)} (${num(p.monthsApplied / 12)} years). It is an assumed outcome, not a guaranteed return.</p>`}<p class="plain-note">Unclaimed tokens and existing holder loans continue. The owner does not take this pool.</p>`;
  }
  document.querySelector('#phase-panel').innerHTML = `<div class="phase-copy"><span class="kicker">${phases.find(([id]) => id === phase)[1]}</span><h2 id="scenario-title">${title}</h2><p>${explanation}</p></div>${content}`;
}

function renderSteps(p) {
  const failed = ['refunding', 'refunded'].includes(phase);
  let statuses;
  if (!p) statuses = ['upcoming', 'upcoming', 'upcoming', 'upcoming'];
  else if (failed) statuses = ['failed', phase === 'refunded' ? 'complete' : 'current', 'skipped', 'skipped'];
  else if (phase === 'paid_off') statuses = ['complete', 'complete', 'complete', 'complete'];
  else if (phase === 'earning') statuses = ['complete', 'complete', p?.goalReached ? 'complete' : 'current', p?.goalReached ? 'current' : 'upcoming'];
  else if (phase === 'funded' || p?.raised >= p?.goal) statuses = ['complete', 'current', 'upcoming', 'upcoming'];
  else statuses = ['current', 'upcoming', 'upcoming', 'upcoming'];
  const labels = [['raise', 'Raise funds'], ['close', failed ? 'Refund investors' : 'Close the deal'], ['revenue', 'Collect rent'], ['release', 'Finish payoff']];
  const statusText = { complete: 'Complete', current: 'Current step', upcoming: 'Later', failed: 'Unsuccessful', skipped: 'Skipped' };
  document.querySelector('#process-steps').innerHTML = labels.map(([id, label], i) => `<li class="process-step" data-step="${id}" data-status="${statuses[i]}" ${statuses[i] === 'current' ? 'aria-current="step"' : ''}><span class="step-icon" aria-hidden="true">${statuses[i] === 'complete' ? '✓' : statuses[i] === 'failed' ? '×' : i + 1}</span><div><strong>${label}</strong><span>${statusText[statuses[i]]}</span></div></li>`).join('');
}

function readInputs() {
  const fields = [...document.querySelectorAll('[data-input]')];
  const result = {};
  for (const input of fields) {
    const key = input.dataset.input;
    const irrelevant = (key === 'raisedPercent' && !['raising', 'refunding', 'refunded'].includes(phase))
      || (key === 'revenueMonths' && phase !== 'earning');
    const valid = input.checkValidity();
    input.setAttribute('aria-invalid', String(!valid && !irrelevant));
    if (!valid && !irrelevant) throw new Error(`Check “${input.closest('label').querySelector('span').textContent}”. Enter a value within the field’s limits.`);
    result[key] = valid ? Number(input.value) : DEFAULT_SCENARIO[key];
  }
  return result;
}

function update() {
  document.querySelectorAll('[data-phase]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.phase === phase)));
  document.querySelector('#raise-input').hidden = !['raising', 'refunding', 'refunded'].includes(phase);
  document.querySelector('#revenue-input').hidden = phase !== 'earning';
  const next = { raising: ['funded', 'View successful raise'], funded: ['earning', 'View revenue stage'], refunding: ['refunded', 'View completed refunds'], earning: ['paid_off', 'View payoff'] }[phase];
  const nextButton = document.querySelector('#next-state');
  nextButton.textContent = next ? `${next[1]} →` : 'Process complete';
  nextButton.dataset.nextPhase = next?.[0] || '';
  nextButton.disabled = !next;
  document.querySelector('#failure-state').hidden = !['raising', 'funded'].includes(phase);
  const error = document.querySelector('#projection-error');
  try {
    inputs = readInputs();
    projection = projectScenario(inputs, phase);
    error.hidden = true;
    error.textContent = '';
    document.querySelector('#download-scenario').disabled = false;
    renderSteps(projection);
    renderPanel(projection);
  } catch (cause) {
    projection = null;
    nextButton.disabled = true;
    error.hidden = false;
    const message = cause.message.includes('investment cannot exceed the property funding goal') ? 'Your investment cannot be larger than the property’s raise.' : cause.message.includes('investment cannot exceed the amount raised') ? 'The collected amount must include your investment. Increase the collected percentage or reduce your investment.' : cause.message;
    error.textContent = message;
    document.querySelector('#download-scenario').disabled = true;
    renderSteps(null);
    document.querySelector('#phase-panel').innerHTML = `<div class="phase-copy"><h2 id="scenario-title">Check the assumptions.</h2><p>${escape(message)}</p></div>`;
  }
}

function selectPhase(next) {
  phase = next;
  update();
}

document.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => selectPhase(button.dataset.phase)));
document.querySelector('#projection-form').addEventListener('input', update);
document.querySelector('#projection-form').addEventListener('submit', event => event.preventDefault());
document.querySelector('#phase-panel').addEventListener('click', event => {
  const advance = event.target.closest('#add-rent-month');
  if (!advance || advance.disabled || phase !== 'earning' || !projection || projection.goalReached) return;
  document.querySelector('#field-revenueMonths').value = Math.min(1200, inputs.revenueMonths + 1);
  update();
  const nextAdvance = document.querySelector('#add-rent-month');
  if (nextAdvance && !nextAdvance.disabled) nextAdvance.focus({ preventScroll: true });
  else {
    const title = document.querySelector('#scenario-title');
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
  }
});
document.querySelector('#failure-state').addEventListener('click', () => selectPhase('refunding'));
document.querySelector('#next-state').addEventListener('click', event => {
  if (event.currentTarget.dataset.nextPhase) selectPhase(event.currentTarget.dataset.nextPhase);
});
document.querySelector('#reset-example').addEventListener('click', () => {
  inputs = { ...DEFAULT_SCENARIO };
  for (const input of document.querySelectorAll('[data-input]')) input.value = inputs[input.dataset.input];
  selectPhase('raising');
});
document.querySelector('#download-scenario').addEventListener('click', () => {
  if (!projection) return;
  const scenario = { product: 'Rooftop', property: 'Founder Haus', phase, inputs, projection, illustrative: true, liveOffering: false, loanEstimate: { fees: LOAN_FEE_ASSUMPTIONS, firstLoanOnly: true, entirePositionUnpledged: true, nextMonthAssumesNoLoanToday: true }, excludes: ['taxes', 'cash-out fees', 'loan execution and repayment', 'existing loans', 'prior redemptions'], createdAt: new Date().toISOString() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(scenario, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `rooftop-founder-haus-${phase}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const smallScreen = window.matchMedia('(max-width: 760px)');
function showAssumptions(show) {
  document.querySelector('#assumptions-body').hidden = !show;
  document.querySelector('#toggle-assumptions').setAttribute('aria-expanded', String(show));
  document.querySelector('#assumptions-toggle-label').textContent = show ? 'Hide ↑' : 'Edit ↓';
}
document.querySelector('#toggle-assumptions').addEventListener('click', () => showAssumptions(document.querySelector('#assumptions-body').hidden));
smallScreen.addEventListener('change', event => showAssumptions(!event.matches));
showAssumptions(!smallScreen.matches);
document.title = 'Rooftop — Founder Haus investment simulator';
update();
