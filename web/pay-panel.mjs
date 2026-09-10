/** A payment and redemption preview. No wallet, transaction, or balance changes. */
import { PREVIEW_ETH_USDC_RATE, parsePaymentAmount, formatPaymentAmount, sourceAmountFromUSDC } from './payment-currencies.mjs';
const PHASES = new Set(['raising', 'funded', 'refunding', 'refunded', 'earning', 'liquidated']);
const mounted = new WeakMap();
const dollars = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amounts = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const tokens = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const tokenText = value => value > 0 && value < 0.000001 ? '<0.000001' : tokens.format(value);

/** Pure quote helper. Payment output is estimated token issuance, not cash-out value. */
export function payPanelQuote({ phase, projection, amount, currency = 'USDC', contributionError } = {}) {
  const quote = {
    kind: 'disabled', route: phase === 'earning' ? 'INCOME' : 'FUND',
    enabled: false, amount: null, sourceAmount: null, sourceCurrency: null,
    settlementCurrency: 'USDC', previewRate: null, tokenOutput: null, cashOutput: null,
    error: '', reason: '', actionLabel: 'Unavailable',
  };
  if (!PHASES.has(phase)) return { ...quote, reason: 'Choose a project stage to see its payment options.' };
  if (!projection || typeof projection !== 'object' || (projection.phase && projection.phase !== phase)) {
    return { ...quote, error: 'Update the asset assumptions to preview this stage.' };
  }
  if (phase === 'funded') return { ...quote, error: contributionError ? String(contributionError) : '', reason: 'The raise is closed while the asset purchase is prepared.', actionLabel: 'Raise closed' };
  if (phase === 'refunded') return { ...quote, error: contributionError ? String(contributionError) : '', reason: 'Refunds are complete. This raise is no longer accepting payments.', actionLabel: 'Refunds complete' };
  if (phase === 'refunding' || phase === 'liquidated') {
    if (contributionError) return { ...quote, error: String(contributionError) };
    const refund = phase === 'refunding';
    const cash = refund ? (projection.personalFundRefund ?? projection.personalRefund) : projection.personalFundSaleClaim;
    if (typeof cash !== 'number' || !Number.isFinite(cash) || cash < 0) {
      return { ...quote, error: 'A valid FUND cash-out estimate is needed for this preview.' };
    }
    return {
      ...quote, kind: refund ? 'refund' : 'sale', cashOutput: cash,
      enabled: cash > 0,
      reason: cash > 0
        ? refund ? 'Your share of remaining cash. The refund has no cash-out tax; protocol fees may apply.'
          : 'Your share of net asset-sale proceeds, before any applicable cash-out fees.'
        : refund ? 'This position has no remaining refund to preview.' : 'This position has no asset-sale cash to preview.',
      actionLabel: refund ? 'Preview refund' : 'Preview cash-out',
    };
  }

  const parsed = parsePaymentAmount(amount, currency);
  if (parsed.error) return { ...quote, error: parsed.error, actionLabel: 'Preview payment' };
  // A separate INCOME payment never changes the user's historical FUND position.
  if (contributionError && phase !== 'earning') return { ...quote, error: String(contributionError) };
  const rate = phase === 'raising' ? 10_000 : projection.currentIssuanceRate;
  const payerPercent = phase === 'raising' ? 100 : projection.currentRenterSplitPercent;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0
    || typeof payerPercent !== 'number' || !Number.isFinite(payerPercent) || payerPercent < 0 || payerPercent > 100) {
    return { ...quote, error: 'A valid issuance rate and payer allocation are needed for this preview.' };
  }
  const output = parsed.amount * rate * payerPercent / 100;
  if (!Number.isFinite(output)) return { ...quote, error: 'This token estimate exceeds the preview range.' };
  return {
    ...quote, ...parsed, kind: 'payment', enabled: true, tokenOutput: output,
    actionLabel: 'Preview payment',
    reason: phase === 'raising'
      ? '10,000 FUND per USDC. Your contribution preview updates with this amount.'
      : output === 0
        ? 'The current issuance terms give the payer no INCOME tokens for this payment.'
        : `${tokenText(rate * payerPercent / 100)} INCOME per USDC for the payer.${payerPercent < 100 ? ' Other newly issued tokens go to operators and FUND holders.' : ''}`,
  };
}

/**
 * Mount once into #pay-panel. render() preserves the amount input and its caret.
 * FUND edits call onFundAmountChange(USDCString); INCOME edits stay local. The
 * surrounding app owns asset assumptions and the historical FUND contribution.
 */
export function initPayPanel({ onFundAmountChange, onQuoteChange } = {}) {
  const panel = document.querySelector('#pay-panel');
  if (!panel) throw new Error('Pay panel requires a #pay-panel placeholder.');
  if (mounted.has(panel)) return mounted.get(panel);
  panel.classList.add('pay-panel');
  panel.setAttribute('aria-labelledby', 'pay-panel-title');
  panel.innerHTML = `<div class="pay-panel-heading"><h2 id="pay-panel-title" tabindex="-1">Pay</h2><span id="pay-route" class="pay-route">FUND</span></div>
    <p id="pay-context" class="pay-context"></p>
    <form id="pay-form" novalidate>
      <div id="pay-amount-wrap"><label id="pay-amount-label" for="pay-amount">Amount in USDC</label><div class="pay-amount-control"><span id="pay-amount-symbol" aria-hidden="true">$</span><input id="pay-amount" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="24" aria-describedby="pay-conversion pay-settlement pay-note pay-error" required><select id="pay-currency" class="pay-currency" aria-label="Payment currency"><option value="USDC">USDC</option><option value="ETH">ETH</option></select></div><p id="pay-conversion" class="pay-conversion" hidden>1 ETH ≈ ${amounts.format(PREVIEW_ETH_USDC_RATE)} USDC | preview rate</p><p id="pay-settlement" class="pay-settlement" aria-live="polite" hidden></p></div>
      <div class="pay-receipt" aria-live="polite" aria-atomic="true"><span id="pay-output-label">Estimated tokens</span><div><strong id="pay-output">—</strong><span id="pay-output-unit">FUND</span></div></div>
      <p id="pay-note" class="pay-note"></p><p id="pay-error" class="pay-error" role="alert" hidden></p>
      <button id="pay-review" class="pay-review" type="submit" aria-haspopup="dialog" aria-controls="pay-dialog" disabled>Preview payment</button>
      <p class="pay-preview-note">Preview only | no transaction</p>
    </form>`;
  const dialog = document.createElement('dialog');
  dialog.id = 'pay-dialog';
  dialog.className = 'pay-dialog';
  dialog.setAttribute('aria-labelledby', 'pay-dialog-title');
  dialog.setAttribute('aria-describedby', 'pay-dialog-note');
  dialog.innerHTML = `<div class="pay-dialog-heading"><span>Review preview</span><button id="pay-dialog-close" type="button" aria-label="Close payment preview">Close ×</button></div><h2 id="pay-dialog-title"></h2><dl id="pay-dialog-values"></dl><p id="pay-dialog-note"></p><p class="pay-dialog-disclaimer">Nothing is signed, paid, redeemed, or changed. This review does not update balances.</p><button id="pay-dialog-done" type="button" class="pay-review">Done</button>`;
  document.body.append(dialog);

  const input = panel.querySelector('#pay-amount');
  const amountWrap = panel.querySelector('#pay-amount-wrap');
  const currencySelect = panel.querySelector('#pay-currency');
  const amountLabel = panel.querySelector('#pay-amount-label');
  const amountSymbol = panel.querySelector('#pay-amount-symbol');
  const conversion = panel.querySelector('#pay-conversion');
  const settlement = panel.querySelector('#pay-settlement');
  const route = panel.querySelector('#pay-route');
  const context = panel.querySelector('#pay-context');
  const outputLabel = panel.querySelector('#pay-output-label');
  const output = panel.querySelector('#pay-output');
  const outputUnit = panel.querySelector('#pay-output-unit');
  const note = panel.querySelector('#pay-note');
  const error = panel.querySelector('#pay-error');
  const review = panel.querySelector('#pay-review');
  let current = { phase: null, projection: null, contributionError: null };
  let fundRaw = null;
  let incomeRaw = '100';
  let selectedCurrency = 'USDC';
  let lastFundAmount;
  let lastMode;
  let lastQuote;
  let openedSignature;
  const mode = () => current.phase === 'earning' ? 'INCOME' : 'FUND';
  const rawAmount = () => mode() === 'INCOME' ? incomeRaw : fundRaw;
  const setRawAmount = value => { if (mode() === 'INCOME') incomeRaw = value; else fundRaw = value; };
  const publishFundAmount = () => {
    const parsed = parsePaymentAmount(fundRaw, selectedCurrency);
    onFundAmountChange?.(parsed.error ? '' : String(parsed.amount));
  };
  const signature = quote => JSON.stringify([current.phase, quote, current.projection?.monthsApplied,
    current.projection?.personalFundTokens, current.projection?.personalCashout]);

  function paint() {
    const quote = payPanelQuote({ ...current, amount: rawAmount(), currency: selectedCurrency });
    lastQuote = quote;
    if (dialog.open && signature(quote) !== openedSignature) dialog.close();
    const paymentStage = current.phase === 'raising' || current.phase === 'earning';
    const cashStage = current.phase === 'refunding' || current.phase === 'liquidated';
    amountWrap.hidden = !paymentStage;
    input.disabled = !paymentStage;
    currencySelect.disabled = !paymentStage;
    currencySelect.value = selectedCurrency;
    amountLabel.textContent = `Amount in ${selectedCurrency}`;
    amountSymbol.hidden = selectedCurrency !== 'USDC';
    input.setAttribute('aria-describedby', selectedCurrency === 'ETH' ? 'pay-conversion pay-settlement pay-note pay-error' : 'pay-note pay-error');
    conversion.hidden = selectedCurrency !== 'ETH' || !paymentStage;
    const converted = parsePaymentAmount(rawAmount(), selectedCurrency);
    settlement.hidden = conversion.hidden || Boolean(converted.error);
    settlement.textContent = converted.error ? '' : `≈ ${dollars.format(converted.amount)} USDC after conversion`;
    const nextRaw = rawAmount() ?? '';
    if (input.value !== nextRaw) input.value = nextRaw;
    panel.querySelector('#pay-panel-title').textContent = current.phase === 'refunding' ? 'Refund' : current.phase === 'liquidated' ? 'Cash out' : 'Pay';
    route.textContent = cashStage ? 'FUND → USDC' : quote.route;
    context.textContent = current.phase === 'earning'
      ? `Revenue payment | month ${amounts.format(current.projection?.monthsApplied ?? 0)} preview`
      : current.phase === 'raising' ? 'Contribute to the asset raise'
        : current.phase === 'refunding' ? 'Review your remaining FUND refund'
          : current.phase === 'liquidated' ? 'Review your share of asset-sale cash' : 'Project payment options';
    outputLabel.textContent = cashStage ? 'Estimated cash you receive' : 'Estimated tokens you receive';
    output.textContent = quote.tokenOutput !== null ? tokenText(quote.tokenOutput)
      : quote.cashOutput !== null ? dollars.format(quote.cashOutput) : '—';
    outputUnit.textContent = cashStage ? 'USDC' : quote.route;
    note.textContent = quote.reason || '';
    error.textContent = quote.error || '';
    error.hidden = !quote.error;
    input.setAttribute('aria-invalid', String(Boolean(quote.error) && paymentStage));
    review.disabled = !quote.enabled;
    review.textContent = quote.actionLabel;
    panel.dataset.payRoute = quote.route;
    panel.dataset.payKind = quote.kind;
    onQuoteChange?.(quote);
  }

  input.addEventListener('input', () => {
    setRawAmount(input.value);
    if (mode() === 'FUND') publishFundAmount();
    paint();
  });
  input.addEventListener('blur', () => {
    const parsed = parsePaymentAmount(rawAmount(), selectedCurrency);
    if (parsed.error) return;
    setRawAmount(formatPaymentAmount(parsed.sourceAmount, selectedCurrency));
    paint();
  });
  currencySelect.addEventListener('change', () => {
    const nextCurrency = currencySelect.value;
    const fund = parsePaymentAmount(fundRaw, selectedCurrency);
    const income = parsePaymentAmount(incomeRaw, selectedCurrency);
    selectedCurrency = nextCurrency;
    fundRaw = fund.error ? '' : sourceAmountFromUSDC(fund.amount, selectedCurrency);
    incomeRaw = income.error ? '' : sourceAmountFromUSDC(income.amount, selectedCurrency);
    if (mode() === 'FUND') publishFundAmount();
    paint();
  });

  panel.querySelector('#pay-form').addEventListener('submit', event => {
    event.preventDefault();
    paint();
    const quote = lastQuote;
    if (!quote.enabled) return;
    const title = quote.kind === 'payment' ? `Preview ${quote.route} payment`
      : quote.kind === 'refund' ? 'Preview FUND refund' : 'Preview FUND cash-out';
    dialog.querySelector('#pay-dialog-title').textContent = title;
    const rows = quote.kind === 'payment'
      ? [['You would pay', `${quote.sourceCurrency === 'USDC' ? dollars.format(quote.sourceAmount) : formatPaymentAmount(quote.sourceAmount, quote.sourceCurrency)} ${quote.sourceCurrency}`], ...(quote.sourceCurrency === 'ETH' ? [['Estimated settlement', `${dollars.format(quote.amount)} USDC`]] : []), ['Estimated tokens for you', `${tokenText(quote.tokenOutput)} ${quote.route}`]]
      : [
        ['Your modeled balance', Number.isFinite(current.projection?.personalFundTokens) ? `${tokenText(current.projection.personalFundTokens)} FUND` : 'Not available'],
        ['Original contribution', Number.isFinite(current.projection?.investment) ? `${dollars.format(current.projection.investment)} USDC` : 'Not available'],
        ['Estimated cash', `${dollars.format(quote.cashOutput)} USDC`],
      ];
    if (quote.kind === 'sale' && Number.isFinite(current.projection?.personalCashout)) {
      rows.push(['Separate INCOME cash-out estimate', `${dollars.format(current.projection.personalCashout)} USDC`]);
    }
    const values = dialog.querySelector('#pay-dialog-values');
    values.replaceChildren();
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value;
      row.append(term, detail);
      values.append(row);
    }
    dialog.querySelector('#pay-dialog-note').textContent = quote.kind === 'payment'
      ? quote.route === 'FUND'
        ? 'This uses the modeled rate of 10,000 FUND per USDC. It previews the contribution shown on this page.'
        : 'This estimates the payer’s share of new INCOME at the selected month’s issuance rate. It does not change your FUND contribution or add revenue to the simulation.'
      : quote.kind === 'refund'
        ? 'The refund is your proportional share of cash remaining after expenses. There is no refund cash-out tax. Actual protocol fees may reduce proceeds.'
        : 'This reviews net asset-sale cash attributable to FUND. INCOME remains separate; its estimate is not included in this FUND amount.';
    if (quote.kind === 'payment' && quote.sourceCurrency === 'ETH') {
      dialog.querySelector('#pay-dialog-note').textContent += ` Conversion uses a fixed preview rate of 1 ETH ≈ ${amounts.format(PREVIEW_ETH_USDC_RATE)} USDC, rounded down to USDC cents. This is not a live swap quote.`;
    }
    openedSignature = signature(quote);
    dialog.showModal();
  });
  dialog.querySelector('#pay-dialog-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#pay-dialog-done').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (!review.disabled) review.focus({ preventScroll: true });
    else panel.querySelector('#pay-panel-title').focus({ preventScroll: true });
  });

  const api = {
    getQuote() { return lastQuote ? { ...lastQuote } : null; },
    render(next) {
      current = next || { phase: null, projection: null, contributionError: null };
      const nextFundAmount = current.projection?.investment;
      const nextMode = mode();
      if (typeof nextFundAmount === 'number' && Number.isFinite(nextFundAmount)) {
        if (fundRaw === null || (nextFundAmount !== lastFundAmount && document.activeElement !== input)) {
          fundRaw = sourceAmountFromUSDC(nextFundAmount, selectedCurrency);
        }
        lastFundAmount = nextFundAmount;
      }
      if (nextMode !== lastMode) {
        // A route change restores that route's own amount without reusing an
        // INCOME payment as the historical FUND contribution.
        input.value = nextMode === 'INCOME' ? incomeRaw : (fundRaw ?? '');
        lastMode = nextMode;
      }
      paint();
    },
    reset() {
      fundRaw = null;
      incomeRaw = '100';
      selectedCurrency = 'USDC';
      lastFundAmount = undefined;
      lastMode = undefined;
      if (dialog.open) dialog.close();
      api.render(current);
    },
  };
  mounted.set(panel, api);
  return api;
}
