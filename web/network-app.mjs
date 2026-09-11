import { mountSiteIntegration } from './site-integration.mjs';
import { DEFAULT_NETWORK, projectNetwork } from './network-model.mjs';
import { ownerActionDraft } from './owner-actions.mjs';
import { FIELD_HELP } from './field-help.mjs';
import { initFieldHelp } from './field-help-ui.mjs';
import { budgetChart, cashHistoryChart, borrowingChart, initProjectionCharts } from './projection-charts.mjs';
import { ownershipCharts, initOwnershipCharts } from './ownership-charts.mjs';
import { initFounderHaus } from './founder-haus.mjs';
import { journeyMarkup, initProjectJourney } from './project-journey.mjs';
import { initPayPanel } from './pay-panel.mjs';
import { renderIncomePaymentDetails } from './income-payment-preview.mjs';
import { loadCreatedProject, creationSummary } from './create-model.mjs';
import { drawAssetSketch } from './asset-sketch.mjs';
import { NETWORK_FAMILIES } from './create-networks.mjs';

const phases = [['raising', 'Raising funds'], ['funded', 'Raise closed'], ['refunding', 'Refunding'], ['refunded', 'Refunds complete'], ['earning', 'Earning income'], ['liquidated', 'Asset sold']];
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
const number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const percent = value => `${number(value)}%`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const createdProject = location.pathname.startsWith('/project') ? loadCreatedProject(new URLSearchParams(location.search).get('id')) : null;
const instanceDefaults = createdProject ? { ...creationSummary(createdProject.values).networkInputs, investment: Math.min(100, createdProject.values.purchaseBudget) } : DEFAULT_NETWORK;
const projectName = createdProject?.values.name || 'Founder Haus';
const projectLocation = createdProject?.values.location || (createdProject ? '' : 'Jurerê Internacional, Florianópolis');
const projectNetworkNote = createdProject ? `<p class="created-project-note">Local project preview <span aria-hidden="true">|</span>${createdProject.deployment.networkEnvironment === 'testnet' ? '<span>Testnets</span>' : ''}<span class="created-network-symbols" role="group" aria-label="Planned networks">${createdProject.deployment.plannedNetworks.map(network => {
  const family = NETWORK_FAMILIES.find(item => item.production.chainId === network.chainId || item.testnet.chainId === network.chainId);
  return family ? `<img src="${family.icon}" alt="${escape(network.name)}" title="${escape(network.name)}" width="18" height="18">` : '';
}).join('')}</span></p>` : '';
const coverMarkup = createdProject ? `<div class="deal-image created-cover">${createdProject.values.photo ? `<img src="${escape(createdProject.values.photo)}" alt="${escape(projectName)} cover photo">` : '<canvas id="created-asset-sketch" aria-hidden="true"></canvas>'}</div>` : `<button type="button" id="open-house-gallery" class="deal-image house-photo-button" aria-label="View Founder Haus photos and details" aria-haspopup="dialog" aria-controls="house-gallery"><img src="/assets/founder-haus/exterior.jpg" alt="Founder Haus exterior, pool and garden" width="1440" height="1080"><span>3 photos ↗</span></button>`;
let phase = 'raising';
let inputs = { ...instanceDefaults };
let projectProjection;
let projection;
let currentDraft;

const ungroupInput = value => value.replaceAll(',', '').trim();
function formatInput(value) {
  const [whole, fraction] = String(value).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
}
function numericField(input) {
  // Keep the original numeric limits and step checks with a comma-friendly display.
  const numeric = document.createElement('input');
  numeric.type = 'number';
  for (const attribute of ['min', 'max', 'step', 'required']) {
    if (input.hasAttribute(attribute)) numeric.setAttribute(attribute, input.getAttribute(attribute));
  }
  const value = input.value.trim();
  const wellFormed = /^-?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)$/.test(value);
  numeric.value = wellFormed ? ungroupInput(value) : '';
  return { valid: wellFormed && numeric.checkValidity(), value: numeric.valueAsNumber };
}

function field(key, label, { min = 0, max, step = .01, suffix, prefix } = {}) {
  return `<div class="projection-field"><div class="field-label"><label for="field-${key}">${label}</label><button type="button" class="field-help" aria-label="Explain ${escape(label)}" aria-controls="help-${key}" aria-describedby="help-${key}" aria-expanded="false"><span aria-hidden="true">?</span></button></div><div class="field-control">${prefix ? `<span aria-hidden="true">${prefix}</span>` : ''}<input id="field-${key}" data-input="${key}" aria-describedby="help-${key}" type="text" inputmode="${step === 1 ? 'numeric' : 'decimal'}" autocomplete="off" spellcheck="false" min="${min}" ${max === undefined ? '' : `max="${max}"`} step="${step}" value="${formatInput(inputs[key])}" required>${suffix ? `<span aria-hidden="true">${suffix}</span>` : ''}</div><div id="help-${key}" class="field-tooltip" role="tooltip" hidden>${escape(FIELD_HELP[key])}</div></div>`;
}
const dollarField = (key, label, options = {}) => field(key, label, { prefix: '$', ...options });
const percentField = (key, label, max = 100, min = 0) => field(key, label, { suffix: '%', max, min });
const pair = (...fields) => `<div class="input-pair">${fields.join('')}</div>`;

document.querySelector('#main').innerHTML = `<div class="simulator">
  <section class="preview-workbench" aria-label="Preview settings">
    <aside class="assumptions" aria-label="Asset numbers"><h2>Asset assumptions</h2><form id="projection-form" novalidate>
      <div class="core-inputs">${dollarField('purchaseBudget', 'Asset price', { min: .01 })}${dollarField('opsReserve', 'Cash reserve')}${dollarField('monthlyRent', 'Monthly revenue')}${dollarField('monthlyCosts', 'Monthly expenses')}</div>
      <button type="button" id="toggle-assumptions" class="quiet-button" aria-controls="assumptions-body" aria-expanded="false">Annual growth <span id="assumptions-toggle-label" aria-hidden="true">↓</span></button>
      <div id="assumptions-body" hidden>
      ${pair(percentField('rentGrowthPercent', 'Revenue growth / year', 100, -100), percentField('costGrowthPercent', 'Expense growth / year', 100, -100))}
      </div><p id="projection-error" role="alert" hidden></p>
    </form></aside>
    <section id="preview-controls" class="state-picker" aria-labelledby="state-label"><div class="picker-label"><h2 id="state-label">Preview fundraising</h2><span>Changes the example only</span></div><div class="preview-base-buttons" role="group" aria-label="Choose a preview stage">${[['raising', 'Fundraise'], ['earning', 'Income'], ['liquidated', 'Asset sale']].map(([id, label], index) => `<button type="button" data-journey-phase="${id}" aria-pressed="${id === 'raising'}"><span aria-hidden="true">${index + 1}</span>${label}</button>`).join('')}</div><div class="phase-buttons">${phases.map(([id, label]) => `<button type="button" data-phase="${id}" aria-pressed="${id === phase}">${label}</button>`).join('')}</div><div class="scenario-controls"><div id="raise-input">${percentField('raisedPercent', 'Fundraising progress')}</div><div id="revenue-input" hidden>${field('revenueMonths', 'Months of revenue', { max: 360, step: 1 })}</div><div id="sale-scenario" hidden>${dollarField('salePrice', 'Suppose the asset sells for')}</div></div></section>
  </section>
  <section class="deal-heading founder-heading"><div><p id="project-status" class="project-status" role="status" aria-live="polite">Fundraising</p><h1>${escape(projectName)}</h1><p class="asset-location">${escape(projectLocation)}</p>${projectNetworkNote}<div id="project-raise-stats" class="project-raise-stats" aria-label="Fundraising overview" aria-live="polite"><dl><div><dt id="project-raised-label">Raised</dt><dd id="project-raised">—</dd></div><div><dt>Raise goal</dt><dd id="project-goal">—</dd></div></dl><p><strong id="project-funded">—</strong> funded</p></div><span id="property-budget" hidden>${money(inputs.purchaseBudget)} asset</span></div><section id="project-journey" aria-label="Three bases of the project">${journeyMarkup()}</section>${coverMarkup}</section>
  <div class="simulator-layout">
    <aside id="pay-panel" aria-label="Contribution preview"></aside>


    <section class="process" aria-label="Investment process">
      <div id="phase-panel" class="phase-panel" aria-live="polite"></div><div class="process-navigation"><button type="button" id="next-state" class="quiet-button"></button></div>
    </section>
  </div>
  <section id="contribution-section" class="pay-contribution" aria-label="Contribution details">
    <form id="contribution-form" novalidate hidden>
      ${dollarField('investment', 'Your original FUND contribution', { min: .01 })}
      <p id="contribution-error" role="alert" hidden></p>
    </form>
    <div id="income-payment-results" aria-live="polite"></div>
    <details id="fund-position-preview" class="pay-detail"><summary id="fund-position-label">Your contribution</summary><div class="pay-detail-body"><p id="fund-position-basis" class="pay-position-basis"></p><div id="contribution-results" class="contribution-results" aria-live="polite"></div></div></details>
    <details id="fund-ownership-preview" class="pay-detail"><summary id="fund-ownership-label">Who holds the tokens?</summary><div id="contribution-ownership" class="pay-detail-body"></div></details>
  </section>
  <div class="page-tools"><button type="button" class="quiet-button" id="download-scenario">Save scenario ↓</button><details id="owner-tools"><summary>Owner tools</summary><div id="owner-actions" class="owner-actions"></div><button type="button" id="failure-state" class="quiet-button">Preview a failed raise</button></details></div>
</div><dialog id="owner-dialog" aria-labelledby="owner-dialog-title"><div class="dialog-top"><span class="kicker">Owner review draft</span><button type="button" id="close-owner-dialog" class="quiet-button" aria-label="Close owner action draft">Close ×</button></div><h2 id="owner-dialog-title"></h2><div id="owner-dialog-content"></div><div class="dialog-actions"><button type="button" id="download-owner-draft" class="button">Download draft</button><button type="button" id="preview-owner-state" class="outline-button">Preview state</button></div></dialog>`;

if (!createdProject) initFounderHaus();
else {
  document.title = `${projectName} | Homerun preview`;
  document.querySelector('#reset-example').textContent = 'Reset preview ↺';
  const canvas = document.querySelector('#created-asset-sketch');
  if (canvas) new ResizeObserver(() => drawAssetSketch(canvas, createdProject.values.assetType)).observe(canvas);
}
const journey = initProjectJourney();
const payPanel = initPayPanel({ onFundAmountChange(value) {
  const investment = document.querySelector('#field-investment');
  investment.value = value;
  const parsed = numericField(investment);
  if (parsed.valid) investment.value = formatInput(parsed.value);
  update(true);
}, onQuoteChange: renderIncomeContribution });
document.querySelector('#pay-panel').append(document.querySelector('#contribution-section'));

function metric(id, label, value, note = '') {
  return `<div class="state-metric"><span>${label}</span><strong id="${id}">${money(value)}</strong>${note ? `<p>${note}</p>` : ''}</div>`;
}
function progress(label, current, target) {
  const value = target > 0 ? Math.min(100, current / target * 100) : 100;
  return `<div class="scenario-progress"><div><span>${label}</span><strong>${percent(value)}</strong></div><div id="scenario-progress" class="scenario-progress-bar" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value.toFixed(2)}"><span style="width:${value}%"></span></div><p>${money(current)} of ${money(target)}</p></div>`;
}
function fundPosition(p, closed = false) {
  const share = closed ? p.personalFundPercent : p.investment / p.raiseGoal * (100 - p.operatorFundPercent);
  return `<div class="outcome property-outcome"><h3>${closed ? 'Your asset share' : 'Asset share after purchase'}</h3><strong id="your-fund-percent">${percent(share)}</strong><p>FUND · Your share of net sale proceeds.</p></div>`;
}
function fundDetails(p, closed = false) {
  return `<dl class="math-values"><div><dt>Your asset tokens</dt><dd id="your-fund-tokens">${number(p.personalFundTokens)} FUND</dd></div>${closed ? `<div><dt>Your share of FUND-holder rewards</dt><dd id="your-sticky-share">${percent(p.personalFundRewardSharePercent ?? p.personalStickySharePercent)}</dd></div>` : ''}</dl><p>${closed ? 'Your FUND claim stays separate when you borrow against or cash out INCOME.' : 'The asset share assumes the full raise and includes the operator’s success allocation. Your current FUND is not yet a claim on a purchased asset.'}</p>`;
}
function fundRewardDetails(p) {
  const rewards = p.personalFundRewardTokens ?? p.personalStickyTokens;
  const pending = p.personalPendingFundRewardTokens ?? p.personalPendingStickyTokens;
  const automatic = p.fundRewardMode === 'holders';
  return `<dl class="rent-allocation"><div><dt>From closing</dt><dd id="your-premint-tokens">${number(p.personalPremintTokens)} INCOME</dd></div><div><dt>FUND-holder rewards</dt><dd id="your-sticky-tokens">${number(rewards)} INCOME</dd></div>${pending > 0 ? `<div><dt>Not available yet</dt><dd id="your-pending-sticky-tokens">${number(pending)} INCOME</dd></div>` : ''}</dl>${pending > 0 ? '<p>Pending rewards are excluded from cash-out and loan estimates.</p>' : ''}<details class="holder-choices" id="staking-terms"><summary>FUND-holder rewards</summary><div><p>${automatic ? `Each revenue payment distributes ${percent(p.currentStickySplitPercent)} of new INCOME automatically among all FUND holders, including operators, in proportion to their FUND. These rewards are available immediately.` : `FUND holders share ${percent(p.currentStickySplitPercent)} of new INCOME through the reward pool. The estimates include rewards available now.`}</p><p>Your FUND remains your claim on net asset-sale proceeds.</p></div></details>`;
}
function operatingFlow(p) {
  return `<div class="rent-flow"><div><span>Revenue received</span><strong id="monthly-rent-in">${money(p.lastMonthRent)}</strong></div><span class="flow-operator" aria-hidden="true">→</span><div><span>Operators cash out or borrow</span><strong id="ops-rev-cash">${money(p.lastOpsCashFromRevnet)}</strong></div><span class="flow-operator" aria-hidden="true">+</span><div><span>Reserve pays the gap</span><strong id="ops-reserve-used">${money(p.lastOpsFromReserve)}</strong></div></div><figure class="allocation-chart"><figcaption>New INCOME tokens are shared</figcaption><div class="allocation-bar" aria-hidden="true"><span style="flex: ${p.currentOperatorSplitPercent}"></span><span style="flex: ${p.currentStickySplitPercent}"></span><span style="flex: ${p.currentRenterSplitPercent}"></span></div><div class="issuance-split" id="rev-payment-split"><div><strong>${percent(p.currentOperatorSplitPercent)}</strong><span>to operators</span></div><div><strong>${percent(p.currentStickySplitPercent)}</strong><span>to FUND holders</span></div><div><strong>${percent(p.currentRenterSplitPercent)}</strong><span>to customers</span></div></div></figure><p>This projection uses operator cash-outs to pay ${money(p.lastMonthCosts)} of monthly expenses; the reserve covers any gap. Operators could also borrow against their INCOME, with loan fees and repayment obligations. Loan effects are not included in these figures. The percentages above divide new tokens, not cash.</p>`;
}
function revenuePosition(p) {
  const sold = phase === 'liquidated';
  const increase = p.nextMonthLoanCashIncrease;
  const removedFromRent = Math.round((p.cumulativeRent - p.revCash) * 100) / 100;
  const growth = p.rentGrowthPercent || p.costGrowthPercent ? ` Revenue grows ${percent(p.rentGrowthPercent)} per year; expenses ${percent(p.costGrowthPercent)}.` : '';
  return `<div class="quote-basis"><div class="quote-month-control"><label for="quote-month">Your quote at month</label><input id="quote-month" class="quote-month-input" data-quote-month type="number" inputmode="numeric" min="0" max="360" step="1" value="${p.monthsApplied}" aria-describedby="quote-month-help quote-month-error" required><span id="quote-month-help">Preview · months after purchase</span></div><p id="quote-month-error" class="quote-month-error" role="status" hidden></p><p>Starting revenue ${money(p.monthlyRent)}/month; expenses ${money(p.monthlyCosts)}/month.${growth}</p><div class="quote-cash-flow"><div><span>Revenue deposited</span><strong>${money(p.cumulativeRent)}</strong></div><span aria-hidden="true">−</span><div><span>Withdrawn for expenses</span><strong>${money(removedFromRent)}</strong></div><span aria-hidden="true">=</span><div><span>Cash backing all INCOME</span><strong>${money(p.revCash)}</strong></div></div><p>The Revnet starts with $0 and receives revenue monthly after purchase. A separate reserve has paid ${money(p.cumulativeOpsFromReserve)} toward expenses.${p.unpaidOps > 0 ? ` ${money(p.unpaidOps)} of expenses remain unpaid.` : ''}</p></div><div class="outcomes">${sold ? `<div class="outcome property-outcome"><h3>Your asset-sale cash</h3><strong id="your-fund-sale">${money(p.personalFundSaleClaim)}</strong><p>Redeem FUND. Before fees.</p><span id="your-fund-percent" hidden>${percent(p.personalFundPercent)}</span></div>` : fundPosition(p, true)}<div class="outcome loan-outcome"><h3>Borrow against INCOME</h3><strong id="your-loan-cash">${money(p.personalLoanCash)}</strong><span id="loan-status">${p.loanAvailable ? 'After estimated upfront fees' : 'No cash to borrow yet'}</span><p>Repay to recover your INCOME. Default can forfeit it.</p></div><div class="outcome"><h3>Or cash out INCOME</h3><strong id="your-cashout">${money(p.personalCashout)}</strong><span>Before fees</span><p>Gives up the INCOME tokens you redeem.</p></div></div>
    <p class="choice-note">Borrow or cash out the same INCOME; these amounts cannot be added together.</p>
    ${sold ? combinedSalePosition(p) : `<div class="loan-growth"><p>Estimated borrowing next month: <strong id="next-month-loan">${money(p.nextMonthLoanCash)}</strong> <span id="loan-increase">(${increase >= 0 ? '+' : ''}${money(increase)})</span></p><button type="button" id="add-rent-month" ${p.revenueMonths >= 360 ? 'disabled' : ''}>+1 month</button></div>`}
    ${borrowingChart(p)}
    <details id="rent-details" class="holder-choices"><summary>Token details</summary><div>${fundDetails(p, true)}<p><strong id="your-rev-tokens">${number(p.personalRevTokens)} INCOME</strong> available now.</p>${fundRewardDetails(p)}
    <details class="holder-choices"><summary>Loan estimate & terms</summary><div><dl class="math-values"><div><dt>Loan principal</dt><dd id="your-loan-principal">${money(p.personalLoanPrincipal)}</dd></div><div><dt>Assumed upfront fees</dt><dd id="your-loan-fees">${money(p.personalLoanFees)}</dd></div></dl><p>This is a first loan against available, unpledged INCOME. The estimate deducts 6% in upfront fees. This is not an annual rate. Further fees accrue after 182.5 days, and the loan expires after 10 years.</p><p>No loan is executed. Next-month estimates assume you have not borrowed today. Actual availability and fees require a live quote.</p></div></details></div></details>`;
}
function assumptionsMath(p) {
  const cadence = p.issuanceCutMonths === 1 ? 'each month' : p.issuanceCutMonths === 3 ? 'each quarter' : p.issuanceCutMonths === 12 ? 'each year' : `every ${number(p.issuanceCutMonths)} months`;
  return `<details class="holder-choices"><summary>Agreed token terms</summary><div><p>Each invested dollar receives 10,000 FUND. After purchase, investors share ${percent(100 - p.operatorFundPercent)} of FUND and the operators hold ${percent(p.operatorFundPercent)}. Each FUND has the same share of net asset-sale proceeds.</p><p>At purchase, ${number(p.revenuePremint)} INCOME tokens are shared among FUND holders in the same proportions. These give holders a share of revenue, without a promise of repayment or priority over other INCOME holders.</p><dl class="math-values"><div><dt>Total asset tokens</dt><dd id="fund-total-supply">${number(p.fundTotalSupply)}</dd></div><div><dt>Asset tokens for operators</dt><dd id="operator-fund-mint">${number(p.fundOperatorMint)}</dd></div><div><dt>New INCOME per $1 of revenue</dt><dd id="rev-issuance-rate">${number(p.currentIssuanceRate)}</dd></div><div><dt>Operator share of new INCOME</dt><dd id="operator-rev-percent">${percent(p.currentOperatorSplitPercent)}</dd></div><div><dt>New INCOME shared by FUND holders</dt><dd id="sticky-rev-percent">${percent(p.currentStickySplitPercent)}</dd></div><div><dt>INCOME currently outstanding</dt><dd id="rev-total-supply">${number(p.revSupply)}</dd></div></dl><p>Each revenue payment creates INCOME tokens: ${percent(p.currentOperatorSplitPercent)} for operators, ${percent(p.currentStickySplitPercent)} shared by FUND holders, and ${percent(p.currentRenterSplitPercent)} for customers. The FUND-holder allocation includes operators in proportion to their FUND. These percentages split tokens. Operators can cash out or borrow against their tokens to pay expenses; this projection spends the cash reserve first, then uses operator cash-outs for any shortfall.</p><p>The amount of new INCOME per revenue dollar falls ${percent(p.issuanceCutPercent)} ${cadence} for ${number(p.issuanceCutYears)} year${p.issuanceCutYears === 1 ? '' : 's'}, then stays fixed. These are the agreed terms used throughout this preview.</p><p>FUND gives access to net asset-sale cash. INCOME gives access to revenue. They stay separate; neither has a promised payoff date.</p></div></details>`;
}
function reserveStress(p) {
  const lessRent = Math.round(inputs.monthlyRent * .9 * 100) / 100;
  const moreCosts = Math.round(inputs.monthlyCosts * 1.1 * 100) / 100;
  const scenarios = [
    ['Your inputs', null],
    ['Revenue 10% lower', { monthlyRent: lessRent }],
    ['Costs 10% higher', { monthlyCosts: moreCosts }],
    ['Both, with at least 2.5% fees', { monthlyRent: lessRent, monthlyCosts: moreCosts, revCashoutFeePercent: Math.max(2.5, inputs.revCashoutFeePercent) }],
  ];
  const rows = scenarios.map(([label, changes]) => {
    try {
      const result = changes ? projectNetwork({ ...inputs, ...changes }, 'earning') : p;
      return `<tr><th scope="row">${label}</th><td>${money(result.minimumOpsReserveCash)}</td><td>${result.firstUnfundedMonth === null ? 'No unpaid costs' : `Unpaid costs from month ${number(result.firstUnfundedMonth)}`}</td></tr>`;
    } catch {
      return `<tr><th scope="row">${label}</th><td colspan="2">Outside the model’s supported range</td></tr>`;
    }
  }).join('');
  return `<details class="holder-choices" id="reserve-stress"><summary>Can the reserve cover operations?</summary><div><p>From the first revenue payment through month <strong id="reserve-horizon">${number(p.diagnosticHorizonMonths)}</strong>. This tests the whole horizon, not just the selected month. The comparison uses your asset estimates and the agreed token terms.</p><div class="stress-table-wrap"><table class="stress-table"><caption>Operating reserve scenarios</caption><thead><tr><th scope="col">Assumptions</th><th scope="col">Lowest reserve</th><th scope="col">Cost coverage</th></tr></thead><tbody>${rows}</tbody></table></div><p>The combined case assumes a cash-out fee of at least 2.5%. These scenarios do not guarantee that the reserve is sufficient for actual costs or every possible shock.</p></div></details>`;
}
function combinedSalePosition(p) {
  const total = Math.round((p.personalFundSaleClaim + p.personalCashout) * 100) / 100;
  const difference = Math.round((total - p.investment) * 100) / 100;
  return `<div class="combined-position"><span>If you redeem FUND and INCOME</span><strong id="combined-cashout">${money(total)}</strong><p id="combined-difference">${money(Math.abs(difference))} ${difference < 0 ? 'below' : 'above'} your ${money(p.investment)} contribution. Before fees; excludes loans${(p.personalPendingFundRewardTokens ?? p.personalPendingStickyTokens) > 0 ? ' and pending rewards' : ''}.</p></div>`;
}
function renderPanel(p) {
  let title, explanation, content, details;
  if (phase === 'raising') {
    title = 'Raise the money.';
    explanation = 'Buy the asset and set aside cash to run it.';
    content = `${progress('Fundraising progress', p.raised, p.raiseGoal)}${budgetChart(p)}`;
    details = `<div class="state-metrics">${metric('raise-goal', 'Goal, including estimated fees', p.raiseGoal)}${metric('escrow-cash', 'Cash still held', p.escrowCash)}</div><p>The goal covers the ${money(p.purchaseBudget)} purchase, ${money(p.opsReserve)} separate operating reserve, purchase expenses and an assumed ${percent(p.payoutFeePercent)} Juicebox payout fee. Expenses already incurred reduce the cash held. Investors receive FUND; failed raises return remaining cash.</p>`;
  } else if (phase === 'funded') {
    title = 'Buy the asset.';
    explanation = 'The raise is closed. The purchase is next.';
    content = `<div class="state-metrics single">${metric('escrow-cash', 'Ready for closing', p.escrowCash)}</div>${budgetChart(p)}`;
    details = `<div class="state-metrics single">${metric('closing-fee', 'Estimated closing fee', p.closingFeeEstimate)}</div><p>After the purchase, FUND holders receive ${number(p.revenuePremint)} INCOME in total, including the operator’s ${percent(p.operatorFundPercent)} share. FUND remains the asset claim and automatically receives a proportional share of new INCOME. The initial raise pays for the asset and a separate operating reserve; the INCOME revnet starts at $0, then receives monthly revenue.</p>`;
  } else if (phase === 'refunding' || phase === 'refunded') {
    const complete = phase === 'refunded';
    title = complete ? 'Refunds complete.' : 'Return the remaining money.';
    explanation = complete ? 'No asset was purchased.' : 'Investors share the cash left after expenses.';
    content = `<div class="state-metrics single">${metric(complete ? 'refunded-cash' : 'refundable-cash', complete ? 'Returned to investors' : 'Available for refunds', complete ? p.refundedCash : p.refundableCash)}</div>`;
    details = `<p>Refunds redeem FUND proportionally. There is no cash-out tax, operator success mint or INCOME allocation. Expenses can reduce recovery; protocol fees may apply.</p>${progress('Refunds completed', complete ? p.refundedCash : 0, complete ? p.refundedCash : p.refundableCash)}`;
  } else {
    const sold = phase === 'liquidated';
    title = sold ? 'Sell the asset. Share the proceeds.' : 'Collect revenue. Pay the bills.';
    explanation = sold ? 'Net sale cash goes to FUND holders.' : 'Revenue comes in. Expenses use the cash reserve first, then operator INCOME cash-outs.';
    content = `${sold ? `<div class="state-metrics single">${metric('fund-sale-cash', 'For all FUND holders', p.fundSaleCash)}</div>` : ''}<div class="pool-balance"><div><span>${sold ? 'Separate cash for INCOME holders' : 'Revenue held for all holders'}</span><p>After ${number(p.monthsApplied)} months</p></div><strong id="cash-in-pool">${money(p.revCash)}</strong></div>${sold ? '' : `<div class="reserve-line"><span>Reserve left</span><strong id="ops-reserve-cash">${money(p.opsReserveCash)}</strong></div>`}${p.unpaidOps > 0 ? `<p class="scenario-caution" id="ops-shortfall">${money(p.unpaidOps)} of costs remain unpaid. The reserve is exhausted.</p>` : ''}${cashHistoryChart(p)}`;
    details = `${sold ? `<p>Assumes ${percent(p.saleCostPercent)} selling expenses. Sale cash includes ${money(p.reserveReturnedToFund)} of unused reserve.${p.unpaidOps > 0 ? ' Unpaid operating expenses have also been deducted.' : ''} Existing INCOME remains separate.</p>` : operatingFlow(p)}${phase === 'earning' ? reserveStress(p) : ''}${assumptionsMath(p)}`;
  }
  document.querySelector('#phase-panel').innerHTML = `<div class="phase-copy"><h2 id="scenario-title" tabindex="-1">${title}</h2><p>${explanation}</p>${phase === 'earning' && createdProject?.values.revenueDescription ? `<p class="revenue-description">${escape(createdProject.values.revenueDescription)}</p>` : ''}</div>${content}<details id="project-details" class="holder-choices"><summary>How the money moves</summary><div>${details}</div></details>`;
}
function renderContribution(p) {
  document.querySelector('#fund-position-label').textContent = phase === 'earning' ? 'Fundraising contribution' : 'Your contribution';
  document.querySelector('#fund-ownership-label').textContent = createdProject && phase === 'raising' ? 'Ownership after this payment' : phase === 'earning' ? 'Ownership from fundraising' : 'Who holds the tokens?';
  document.querySelector('#fund-position-basis').textContent = phase === 'raising' ? createdProject ? `After a prospective ${money(p.investment)} payment. The project’s displayed balance stays unchanged.` : `Based on the ${money(p.investment)} entered above.` : `Based on ${money(p.investment)} entered during fundraising. Use the Fundraise preview to change that amount.`;
  document.querySelector('#contribution-ownership').innerHTML = ownershipCharts(p);
  let content;
  if (phase === 'raising' || phase === 'funded') {
    content = `<div class="outcomes">${fundPosition(p)}</div><p class="contribution-explainer">FUND records your contribution. After purchase, it gives you a share of net sale proceeds. You also receive separate INCOME tokens for a share of revenue.</p><details id="fund-details" class="holder-choices"><summary>Your tokens & exit terms</summary><div>${fundDetails(p)}${phase === 'raising' ? `<div class="personal-goal"><span>Early cash-out, before protocol fees</span><strong id="your-fund-cashout">${money(p.personalFundCashout)}</strong></div><p>Leaving during the raise reduces your refund. This estimate includes the 10% cash-out tax.</p>` : '<p>The money is committed to buying the asset. It is not available to withdraw at this stage.</p>'}<p>After purchase, you would receive ${number(p.plannedPersonalRevTokens)} INCOME tokens. The INCOME revnet starts with $0 and receives monthly revenue after purchase. This allocation does not guarantee repayment or put you ahead of other INCOME holders.</p></div></details>`;
  } else if (phase === 'refunding' || phase === 'refunded') {
    content = `<div class="state-metrics single">${metric('your-refund', 'Your refund', p.personalRefund, 'Before applicable protocol fees.')}</div>`;
  } else content = revenuePosition(p);
  const results = document.querySelector('#contribution-results');
  const activeMonth = document.activeElement?.matches('#quote-month');
  const existingBasis = results.querySelector('.quote-basis');
  if (activeMonth && existingBasis) {
    // Keep the active native number field attached so typing retains its caret.
    const next = document.createElement('template');
    next.innerHTML = content;
    const nextBasis = next.content.querySelector('.quote-basis');
    const existingControl = existingBasis.querySelector('.quote-month-control');
    if (nextBasis && existingControl) {
      for (const node of [...existingBasis.childNodes]) if (node !== existingControl) node.remove();
      for (const node of [...nextBasis.childNodes]) {
        if (node.nodeType !== Node.ELEMENT_NODE || !node.matches('.quote-month-control')) existingBasis.append(node);
      }
      nextBasis.remove();
      for (const node of [...results.childNodes]) if (node !== existingBasis) node.remove();
      results.append(next.content);
      return;
    }
  }
  results.innerHTML = content;
}
function renderIncomeContribution() {
  const target = document.querySelector('#income-payment-results');
  if (!target) return;
  const quote = payPanel.getQuote();
  if (phase !== 'earning' || !projection || !quote?.enabled || quote.amount === null) {
    target.hidden = true;
    return;
  }
  target.hidden = false;
  const open = new Set([...target.querySelectorAll('details[open]')].map(item => item.dataset.incomePaymentDetails));
  try {
    target.innerHTML = renderIncomePaymentDetails(projection, quote.amount);
    for (const detail of target.querySelectorAll('details')) detail.open = open.has(detail.dataset.incomePaymentDetails);
  } catch (error) {
    target.innerHTML = `<p class="pay-error">${escape(error.message)}</p>`;
  }
}
function renderSteps(valid) {
  journey.render({ phase, valid });
}
function renderOwnerActions() {
  const actions = ({ raising: [['close_raise', 'Prepare closing'], ['enable_refunds', 'Prepare refunds']], funded: [['complete_purchase', 'Prepare purchase & allocation'], ['enable_refunds', 'Prepare refunds']], earning: [['enable_sale_redemptions', 'Prepare sale redemptions']] })[phase] || [];
  document.querySelector('#owner-actions').innerHTML = projection && actions.length ? `<span>For the project owner · review drafts only</span><div>${actions.map(([id, label]) => `<button type="button" class="outline-button" data-owner-action="${id}">${label}</button>`).join('')}</div>` : '';
  document.querySelector('#owner-tools').hidden = !projection || !actions.length;
}
function readInputs() {
  const result = { ...instanceDefaults };
  let personalError;
  for (const input of document.querySelectorAll('[data-input]')) {
    const key = input.dataset.input;
    const irrelevant = (key === 'raisedPercent' && !['raising', 'refunding', 'refunded'].includes(phase)) || (key === 'salePrice' && phase !== 'liquidated');
    const { valid, value } = numericField(input);
    input.setAttribute('aria-invalid', String(!valid && !irrelevant));
    if (!valid && !irrelevant) {
      const message = `Check “${input.labels[0].textContent}”. ${input.hasAttribute('max') ? `Use ${input.step === '1' ? 'a whole number' : 'a number'} from ${input.min} to ${input.max}.` : `Use a number of at least ${input.min}.`} ${input.step === '0.01' ? 'Use no more than two decimal places.' : ''}`;
      const error = Object.assign(new Error(message), { inputKey: key });
      if (['investment', 'personalStakePercent'].includes(key)) personalError ||= error;
      else throw error;
    }
    result[key] = valid ? value : instanceDefaults[key];
  }
  return { values: result, personalError };
}
function friendlyError(cause) {
  if (cause.message.startsWith('precloseSpent cannot')) return 'Expenses already paid cannot exceed contributions received. Reduce the expenses or increase fundraising progress.';
  return cause.message.replace(/\b(purchaseBudget|opsReserve|closingCosts|precloseSpent|investment|monthlyRent|monthlyCosts|salePrice|saleDebt|raisedPercent|revenueMonths|rentGrowthPercent|costGrowthPercent)\b/g, key => document.querySelector(`#field-${key}`)?.labels[0].textContent || key);
}
function update(preserveDetails = false) {
  const status = document.querySelector('#project-status');
  status.textContent = ({ raising: 'Fundraising', funded: 'Raise Closed', refunding: 'Refunding', refunded: 'Refunds Complete', earning: 'Earning Income', liquidated: 'Asset Sold' })[phase];
  status.dataset.projectPhase = phase;
  const expanded = new Set(preserveDetails ? [...document.querySelectorAll('#phase-panel details[open], #contribution-results details[open]')].map(details => details.querySelector('summary').textContent) : []);
  const fundraising = ['raising', 'funded', 'refunding', 'refunded'].includes(phase);
  document.querySelectorAll('.preview-base-buttons button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.journeyPhase === (fundraising ? 'raising' : phase))));
  document.querySelectorAll('[data-phase]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.phase === phase));
    button.hidden = !fundraising || ['earning', 'liquidated'].includes(button.dataset.phase);
  });
  document.querySelector('#preview-controls .phase-buttons').hidden = !fundraising;
  document.querySelector('#preview-controls').dataset.base = fundraising ? 'fundraise' : phase === 'earning' ? 'income' : 'sale';
  document.querySelector('#state-label').textContent = fundraising ? 'Preview fundraising' : phase === 'earning' ? 'Preview income' : 'Preview an asset sale';
  document.querySelector('#raise-input').hidden = !['raising', 'refunding', 'refunded'].includes(phase);
  document.querySelector('#revenue-input').hidden = !['earning', 'liquidated'].includes(phase);
  document.querySelector('#sale-scenario').hidden = phase !== 'liquidated';
  document.querySelector('.scenario-controls').hidden = phase === 'funded';
  const next = ({ raising: ['funded', 'Preview closed raise'], funded: ['earning', 'Preview income'], refunding: ['refunded', 'Preview completed refunds'], earning: ['liquidated', 'Preview an asset sale'] })[phase];
  const nextButton = document.querySelector('#next-state');
  nextButton.textContent = next ? `${next[1]} →` : 'End of this scenario';
  nextButton.dataset.nextPhase = next?.[0] || '';
  nextButton.disabled = !next;
  document.querySelector('#failure-state').hidden = !['raising', 'funded'].includes(phase);
  document.querySelector('#help-raisedPercent').textContent = FIELD_HELP.raisedPercent;
  const error = document.querySelector('#projection-error');
  const contributionError = document.querySelector('#contribution-error');
  contributionError.hidden = true;
  contributionError.textContent = '';
  try {
    const read = readInputs();
    inputs = read.values;
    const property = projectNetwork({ ...inputs, investment: 0 }, phase);
    projectProjection = property;
    const prospective = createdProject && phase === 'raising';
    const allowedContribution = prospective ? Math.max(0, property.raiseGoal - property.raised) : property.raised;
    const emptyRefund = createdProject && ['refunding', 'refunded'].includes(phase) && property.raised === 0;
    const personalError = read.personalError || (!emptyRefund && inputs.investment > allowedContribution ? new Error(prospective ? `Your payment cannot exceed the ${money(allowedContribution)} left to raise.` : `Your contribution cannot exceed the ${money(property.raised)} raised in this preview. Lower your contribution or increase fundraising progress.`) : null);
    const personalInputs = prospective ? { ...inputs, raisedPercent: Math.min(100, (Math.round(property.raised * 100) + Math.round(inputs.investment * 100)) / Math.round(property.raiseGoal * 100) * 100) } : emptyRefund ? { ...inputs, investment: 0 } : inputs;
    projection = personalError ? property : projectNetwork(personalInputs, phase);
    error.hidden = true;
    error.textContent = '';
    document.querySelector('#property-budget').textContent = `${money(inputs.purchaseBudget)} asset`;
    document.querySelector('#download-scenario').disabled = Boolean(personalError);
    renderSteps(true);
    renderPanel(createdProject ? property : projection);
    if (personalError) {
      document.querySelector(`#field-${personalError.inputKey || 'investment'}`).setAttribute('aria-invalid', 'true');
      contributionError.hidden = false;
      contributionError.textContent = personalError.message;
      document.querySelector('#contribution-results').innerHTML = '';
    } else renderContribution(projection);
    document.querySelector('#help-raisedPercent').innerHTML = `${escape(FIELD_HELP.raisedPercent)}<p><strong>${percent(inputs.raisedPercent)}</strong> means ${money(projection.raiseGoal * inputs.raisedPercent / 100)} contributed toward the ${money(projection.raiseGoal)} goal.</p>`;
    for (const details of document.querySelectorAll('#phase-panel details, #contribution-results details')) {
      if (expanded.has(details.querySelector('summary').textContent)) details.open = true;
    }
  } catch (cause) {
    projection = null;
    projectProjection = null;
    const personalError = ['investment', 'personalStakePercent'].includes(cause.inputKey) || cause.message.startsWith('investment ');
    error.hidden = personalError;
    error.textContent = personalError ? '' : friendlyError(cause);
    contributionError.hidden = !personalError;
    contributionError.textContent = personalError ? friendlyError(cause) : '';
    document.querySelector('#contribution-results').innerHTML = '<p class="plain-note">Check the assumptions to see your contribution.</p>';
    nextButton.disabled = true;
    document.querySelector('#download-scenario').disabled = true;
    renderSteps(false);
    document.querySelector('#phase-panel').innerHTML = `<div class="phase-copy"><h2 id="scenario-title" tabindex="-1">Check the assumptions.</h2><p>${escape(friendlyError(cause))}</p></div>`;
  }
  for (const detail of document.querySelectorAll('#fund-position-preview, #fund-ownership-preview')) detail.hidden = !projection || !contributionError.hidden;
  document.querySelector('#project-raised-label').textContent = ['earning', 'liquidated', 'refunded'].includes(phase) ? 'Originally raised' : 'Raised';
  const overview = createdProject ? projectProjection : projection;
  document.querySelector('#project-raised').textContent = overview ? money(overview.raised) : '—';
  document.querySelector('#project-goal').textContent = overview ? money(overview.raiseGoal) : '—';
  document.querySelector('#project-funded').textContent = overview ? percent(100 * overview.raised / overview.raiseGoal) : '—';
  payPanel.render({ phase, projection, contributionError: contributionError.hidden ? '' : contributionError.textContent });
  renderOwnerActions();
  fieldHelp.refresh();
}
document.querySelector('.preview-base-buttons').addEventListener('click', event => {
  const button = event.target.closest('button[data-journey-phase]');
  if (button) selectPhase(button.dataset.journeyPhase);
});
function selectPhase(value) { fieldHelp.hide(); phase = value; update(); }
function downloadJSON(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function openOwnerAction(action) {
  if (!projection) return;
  const dialog = document.querySelector('#owner-dialog');
  try {
    currentDraft = ownerActionDraft(action, createdProject ? projectProjection : projection);
    document.querySelector('#owner-dialog-title').textContent = currentDraft.title;
    document.querySelector('#owner-dialog-content').innerHTML = `<p class="draft-only">Review only. Nothing is signed, submitted, queued or changed on-chain.</p><p>${escape(currentDraft.description)}</p>${currentDraft.blockedReasons.length ? `<div class="scenario-caution" id="draft-blocked"><strong>Prerequisites not met</strong><ul>${currentDraft.blockedReasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul></div>` : ''}<ol class="draft-steps">${currentDraft.steps.map(step => `<li><h3>${escape(step.title)}</h3><p>${escape(step.description)}</p></li>`).join('')}</ol><details class="holder-choices"><summary>Prerequisites & verification</summary><ul>${currentDraft.requiresVerification.map(item => `<li>${escape(item)}</li>`).join('')}</ul></details><details class="holder-choices"><summary>Limitations & cautions</summary><ul>${currentDraft.warnings.map(item => `<li>${escape(item)}</li>`).join('')}</ul></details><details class="holder-choices"><summary>Review proposed field changes</summary><pre id="draft-changes">${escape(JSON.stringify(currentDraft.changes, null, 2))}</pre></details>`;
    document.querySelector('#download-owner-draft').disabled = false;
    document.querySelector('#preview-owner-state').disabled = !currentDraft.eligible;
  } catch (error) {
    currentDraft = null;
    document.querySelector('#owner-dialog-title').textContent = 'Draft needs review';
    document.querySelector('#owner-dialog-content').innerHTML = `<p role="alert">${escape(error.message)}</p>`;
    document.querySelector('#download-owner-draft').disabled = true;
    document.querySelector('#preview-owner-state').disabled = true;
  }
  dialog.showModal();
}
document.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => selectPhase(button.dataset.phase)));
function handleProjectionInput(event) {
  const input = event.target.closest('[data-input]');
  if (!input) return;
  if (input && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(ungroupInput(input.value)) && !input.value.split('.')[1]?.includes(',')) {
    const start = input.value.slice(0, input.selectionStart).replaceAll(',', '').length;
    const end = input.value.slice(0, input.selectionEnd).replaceAll(',', '').length;
    input.value = formatInput(ungroupInput(input.value));
    const caretAt = count => {
      let position = 0, digits = 0;
      while (position < input.value.length && digits < count) {
        if (input.value[position] !== ',') digits++;
        position++;
      }
      return position;
    };
    input.setSelectionRange(caretAt(start), caretAt(end));
  }
  update(true);
}
for (const form of document.querySelectorAll('#projection-form, #contribution-form')) {
  form.addEventListener('submit', event => event.preventDefault());
}
document.querySelector('.simulator').addEventListener('input', handleProjectionInput);
document.querySelector('.simulator').addEventListener('input', event => {
  const monthInput = event.target.closest('[data-quote-month]');
  if (!monthInput) return;
  const valid = monthInput.value.trim() !== '' && monthInput.checkValidity();
  const error = document.querySelector('#quote-month-error');
  monthInput.setAttribute('aria-invalid', String(!valid));
  if (!valid) {
    error.hidden = false;
    error.textContent = `Use a whole month from 0 to 360. The results still use month ${inputs.revenueMonths}.`;
    document.querySelector('#download-scenario').disabled = true;
    return;
  }
  document.querySelector('#field-revenueMonths').value = monthInput.value;
  update(true);
  document.querySelector('#quote-month')?.focus({ preventScroll: true });
});
document.querySelector('#failure-state').addEventListener('click', () => selectPhase('refunding'));
document.querySelector('#next-state').addEventListener('click', event => { if (event.currentTarget.dataset.nextPhase) selectPhase(event.currentTarget.dataset.nextPhase); });
document.querySelector('#contribution-results').addEventListener('click', event => {
  if (!event.target.closest('#add-rent-month') || !projection || phase !== 'earning') return;
  document.querySelector('#field-revenueMonths').value = Math.min(360, inputs.revenueMonths + 1);
  update(true);
  document.querySelector('#add-rent-month')?.focus({ preventScroll: true });
});
document.querySelector('#owner-actions').addEventListener('click', event => { const button = event.target.closest('[data-owner-action]'); if (button) openOwnerAction(button.dataset.ownerAction); });
document.querySelector('#close-owner-dialog').addEventListener('click', () => document.querySelector('#owner-dialog').close());
document.querySelector('#download-owner-draft').addEventListener('click', () => { if (currentDraft) downloadJSON(currentDraft, `homerun-${createdProject ? createdProject.id : 'founder-haus'}-${currentDraft.id}-draft.json`); });
document.querySelector('#preview-owner-state').addEventListener('click', () => {
  if (!currentDraft?.eligible) return;
  document.querySelector('#owner-dialog').close();
  selectPhase(currentDraft.toPhase);
  document.querySelector('#scenario-title').focus({ preventScroll: true });
});
document.querySelector('#reset-example').addEventListener('click', () => {
  inputs = { ...instanceDefaults };
  payPanel.reset();
  for (const input of document.querySelectorAll('[data-input]')) input.value = formatInput(inputs[input.dataset.input]);
  for (const details of document.querySelectorAll('.simulator details[open]')) details.open = false;
  showAssumptions(false);
  selectPhase('raising');
});
document.querySelector('#download-scenario').addEventListener('click', () => {
  if (projection) downloadJSON({ product: 'Homerun', asset: projectName, architecture: createdProject ? 'FUND and INCOME' : 'FH-FUND and FH-INCOME', phase, inputs, projection, projectBalance: createdProject ? projectProjection : undefined, illustrative: true, liveOffering: false }, `homerun-${createdProject ? createdProject.id : 'founder-haus'}-${phase}.json`);
});
function showAssumptions(show) {
  document.querySelector('#assumptions-body').hidden = !show;
  document.querySelector('#toggle-assumptions').setAttribute('aria-expanded', String(show));
  document.querySelector('#assumptions-toggle-label').textContent = show ? '↑' : '↓';
  if (!show) fieldHelp.hide();
}
document.querySelector('#toggle-assumptions').addEventListener('click', () => showAssumptions(document.querySelector('#assumptions-body').hidden));
const fieldHelp = initFieldHelp(document.querySelector('.simulator'));
initProjectionCharts(document.querySelector('#main'));
initOwnershipCharts(document);
showAssumptions(false);
update();

mountSiteIntegration(document.querySelector('.simulator'), () => ({ project: { name: projectName, location: projectLocation }, mode: 'illustrative-preview', phase, modelingInputs: { ...inputs }, ...(createdProject ? { setupDraft: createdProject.deployment } : {}), reference: 'https://homerun.money/founderhaus' }));
