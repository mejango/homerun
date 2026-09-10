/**
 * A single additional INCOME payment, quoted against a selected monthly state.
 * No original FUND holding, premint, earlier holder rewards, or future payment
 * history belongs to the payer position returned here. Nothing is executed.
 */
const MAX_PAYMENT = 1_000_000_000;
const TOKEN_LABELS = [
  ['existing', 'Existing INCOME', '#bbc7b0'],
  ['payer', 'Your new INCOME', '#285b3b'],
  ['operators', 'New operator allocation', '#b29e6e'],
  ['stakers', 'New FUND-staker allocation', '#72958b'],
];

function finite(name, value, min = 0, max = Number.MAX_VALUE) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  if (value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}.`);
  return value;
}

function cents(name, value) {
  finite(name, value);
  const result = Math.round(value * 100);
  if (!Number.isSafeInteger(result) || value !== result / 100) {
    throw new RangeError(`${name} must be whole cents within the supported money range.`);
  }
  return result;
}

function paymentAmount(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) {
      throw new RangeError('Enter a valid USDC amount in whole cents.');
    }
    value = Number(text.replaceAll(',', ''));
  }
  finite('Payment amount', value, 0.01, MAX_PAYMENT);
  return cents('Payment amount', value);
}

/** The payer owns only the new customer allocation from this payment. */
export function incomePaymentPreview(p, amount) {
  if (!p || typeof p !== 'object' || p.phase !== 'earning') {
    throw new RangeError('An INCOME payment can only be previewed while the project is earning revenue.');
  }
  const month = finite('Selected month', p.monthsApplied, 0, 360);
  if (!Number.isInteger(month)) throw new RangeError('Selected month must be an integer.');
  const amountCents = paymentAmount(amount);
  const cashBeforeCents = cents('Modeled revnet cash', p.revCash);
  const cashAfterCents = cashBeforeCents + amountCents;
  if (!Number.isSafeInteger(cashAfterCents)) throw new RangeError('Cash after this payment exceeds the supported money range.');
  const supplyBefore = finite('Outstanding INCOME', p.revSupply);
  const issuanceRate = finite('INCOME issuance rate', p.currentIssuanceRate);
  const operatorPercent = finite('Operator issuance allocation', p.currentOperatorSplitPercent, 0, 100);
  const stakerPercent = finite('FUND-staker issuance allocation', p.currentStickySplitPercent, 0, 100);
  const payerPercent = finite('Payer issuance allocation', p.currentRenterSplitPercent, 0, 100);
  if (Math.abs(operatorPercent + stakerPercent + payerPercent - 100) > 1e-8) {
    throw new RangeError('Operator, FUND-staker, and payer allocations must total 100 percent of new issuance.');
  }
  const paid = amountCents / 100;
  const totalMinted = finite('New INCOME issuance', paid * issuanceRate);
  const operatorTokens = totalMinted * (operatorPercent / 100);
  const stakerTokens = totalMinted * (stakerPercent / 100);
  const payerTokens = totalMinted * (payerPercent / 100);
  const supplyAfter = finite('INCOME supply after this payment', supplyBefore + totalMinted);
  const payerShare = supplyAfter > 0 ? Math.min(1, payerTokens / supplyAfter) : 0;
  const cashoutCents = Math.min(cashAfterCents, Math.floor(cashAfterCents * payerShare));
  // Same illustrative FIRST-loan convention as network-model.mjs. Quoting a
  // loan neither withdraws backing nor adds debt, fees, or tokens to the model.
  const loanCashCents = Number(BigInt(cashoutCents) * 94n / 100n);
  const quantities = [supplyBefore, payerTokens, operatorTokens, stakerTokens];
  return {
    month,
    amount: paid,
    cashBefore: cashBeforeCents / 100,
    cashAfter: cashAfterCents / 100,
    supplyBefore,
    supplyAfter,
    totalMinted,
    payerTokens,
    operatorTokens,
    stakerTokens,
    payerSharePercent: payerShare * 100,
    cashoutValue: cashoutCents / 100,
    loanPrincipal: cashoutCents / 100,
    loanCash: loanCashCents / 100,
    loanFees: (cashoutCents - loanCashCents) / 100,
    loanAvailable: loanCashCents > 0,
    issuanceRate,
    payerPercent,
    operatorPercent,
    stakerPercent,
    allocations: TOKEN_LABELS.map(([key, label, color], index) => ({
      key, label, color, tokens: quantities[index],
      percent: supplyAfter > 0 ? quantities[index] / supplyAfter * 100 : 0,
    })),
  };
}

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quantity = value => value > 0 && value < 0.000001 ? '<0.000001' : grouped.format(value);
const percent = value => `${quantity(value)}%`;

function allocationChart(preview) {
  const radius = 37;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const rings = preview.allocations.filter(part => part.tokens > 0).map(part => {
    const length = circumference * part.percent / 100;
    const ring = `<circle data-income-segment="${part.key}" cx="60" cy="60" r="${radius}" fill="none" stroke="${part.color}" stroke-width="15" stroke-dasharray="${length} ${Math.max(0, circumference - length)}" stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)"/>`;
    offset += length;
    return ring;
  }).join('');
  const description = preview.allocations.map(part => `${part.label}: ${quantity(part.tokens)} tokens, ${percent(part.percent)}`).join('; ');
  return `<figure class="income-payment-chart" data-income-payment-chart="allocation">
    <svg viewBox="0 0 120 120" width="132" height="132" role="img" aria-label="${escape(`INCOME after this payment. ${description}`)}" style="display:block;max-width:100%;height:auto;margin:12px auto">
      <title>INCOME allocation after this payment</title><circle cx="60" cy="60" r="${radius}" fill="none" stroke="#edf0e7" stroke-width="15"/>${rings}
      <text x="60" y="56" text-anchor="middle" fill="#31523a" font-family="sans-serif" font-size="9">Your share</text><text x="60" y="71" text-anchor="middle" fill="#203a29" font-family="sans-serif" font-size="10">${escape(percent(preview.payerSharePercent))}</text>
    </svg>
    <figcaption>Of ${escape(quantity(preview.supplyAfter))} INCOME outstanding after this payment.</figcaption>
  </figure>`;
}

function moneyRow(label, value, data) {
  return `<div><dt>${label}</dt><dd${data ? ` data-income-payment-value="${data}"` : ''}>${currency.format(value)}</dd></div>`;
}

/** Self-contained dropdown markup. It needs no global identifiers or handlers. */
export function renderIncomePaymentDetails(p, amount) {
  const preview = incomePaymentPreview(p, amount);
  const context = `After this payment at month ${preview.month}`;
  const legend = preview.allocations.map(part => `<li data-income-allocation="${part.key}"><span class="income-payment-swatch" aria-hidden="true" style="color:${part.color}">●</span><span>${part.label}</span><strong>${escape(quantity(part.tokens))}</strong><span>${escape(percent(part.percent))}</span></li>`).join('');
  return `<details class="income-payment-details" data-income-payment-details="allocation">
    <summary>Your tokens & share</summary><div class="income-payment-detail-body">
      <p>${context}.</p><p><strong data-income-payment-value="payer-tokens">${escape(quantity(preview.payerTokens))} INCOME</strong> for you, or <strong>${escape(percent(preview.payerSharePercent))}</strong> of outstanding INCOME.</p>
      ${allocationChart(preview)}<ul class="income-payment-legend">${legend}</ul>
      <p>${currency.format(preview.amount)} creates ${escape(quantity(preview.totalMinted))} INCOME in total: ${escape(percent(preview.operatorPercent))} for operators, ${escape(percent(preview.stakerPercent))} for eligible FUND stakers, and ${escape(percent(preview.payerPercent))} for you.</p>
      <p>Only your new customer INCOME from this payment is included. No FUND is issued. Your initial INCOME allocation and ongoing Sticky rewards are separate. Projections assume all FUND participates in Sticky and rewards are fully vested.</p>
    </div>
  </details>
  <details class="income-payment-details" data-income-payment-details="liquidity">
    <summary>Cash-out & borrowing estimate</summary><div class="income-payment-detail-body">
      <p>${context}.</p><dl class="income-payment-values">
        ${moneyRow('Revnet before payment', preview.cashBefore, 'cash-before')}
        ${moneyRow('This payment', preview.amount, 'payment')}
        ${moneyRow('Revnet after payment', preview.cashAfter, 'cash-after')}
        ${moneyRow('Your cash-out, before fees', preview.cashoutValue, 'cashout')}
        ${moneyRow('First-loan gross principal', preview.loanPrincipal, 'loan-principal')}
        ${moneyRow('Assumed upfront loan fees', preview.loanFees, 'loan-fees')}
        ${moneyRow('Estimated loan cash', preview.loanCash, 'loan-cash')}
      </dl>
      <p>The payment is added to the modeled INCOME revnet. All existing INCOME and all newly issued tokens, including operator and FUND-holder allocations, count toward the cash-out price.</p>
      <p>The first-loan estimate assumes 6% upfront fees and rounds net cash down to cents. The gross principal remains owed. Actual availability and fees require a live quote.</p>
      <p>Cashing out burns these INCOME tokens. Borrowing uses them as collateral. These are alternatives, not amounts you can add together.</p>
      <p>This is a single-payment preview. It does not change the monthly history or model later operator cash-outs or loans.</p>
    </div>
  </details>`;
}
