/** Illustrative payment routing. This fixed rate is not a market or swap quote. */
export const PREVIEW_ETH_USDC_RATE = 2_500;
export const PAYMENT_CURRENCIES = Object.freeze({
  USDC: Object.freeze({ symbol: 'USDC', decimals: 2, usdcRate: 1 }),
  ETH: Object.freeze({ symbol: 'ETH', decimals: 8, usdcRate: PREVIEW_ETH_USDC_RATE }),
});
const MAX_USDC_CENTS = 100_000_000_000n;

/** Convert source units with integer arithmetic, rounding settlement down to USDC cents. */
export function parsePaymentAmount(raw, currency = 'USDC') {
  const asset = Object.hasOwn(PAYMENT_CURRENCIES, currency) ? PAYMENT_CURRENCIES[currency] : null;
  if (!asset) return { error: 'Choose USDC or ETH.' };
  const text = String(raw ?? '').trim();
  const pattern = new RegExp(`^(?:(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d{0,${asset.decimals}})?|\\.\\d{1,${asset.decimals}})$`);
  if (text.length > 64 || !pattern.test(text)) {
    return { error: currency === 'USDC' ? 'Enter a USDC amount in whole cents.' : 'Enter an ETH amount with up to 8 decimal places.' };
  }
  const [whole, fraction = ''] = text.replaceAll(',', '').split('.');
  const scale = 10n ** BigInt(asset.decimals);
  const units = BigInt(whole || '0') * scale + BigInt(fraction.padEnd(asset.decimals, '0'));
  const settlementNumerator = units * BigInt(asset.usdcRate) * 100n;
  const settlementCents = settlementNumerator / scale;
  if (settlementCents < 1n || settlementNumerator > MAX_USDC_CENTS * scale) {
    return { error: currency === 'USDC'
      ? 'Enter an amount from 0.01 to 1,000,000,000 USDC.'
      : 'Enter an amount from 0.000004 to 400,000 ETH at the preview rate.' };
  }
  return {
    sourceAmount: Number(units) / Number(scale),
    sourceCurrency: currency,
    amount: Number(settlementCents) / 100,
    settlementCurrency: 'USDC',
    previewRate: asset.usdcRate,
  };
}

export function formatPaymentAmount(amount, currency = 'USDC') {
  const asset = Object.hasOwn(PAYMENT_CURRENCIES, currency) ? PAYMENT_CURRENCIES[currency] : null;
  if (!asset) throw new TypeError('Choose USDC or ETH.');
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: asset.decimals }).format(amount);
}

/** Every whole USDC cent is exactly representable at the chosen ETH preview rate. */
export function sourceAmountFromUSDC(amount, currency = 'USDC') {
  const asset = Object.hasOwn(PAYMENT_CURRENCIES, currency) ? PAYMENT_CURRENCIES[currency] : null;
  if (!asset) throw new TypeError('Choose USDC or ETH.');
  return formatPaymentAmount(amount / asset.usdcRate, currency);
}
