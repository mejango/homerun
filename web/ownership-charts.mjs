const formatNumber = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
const formatPercent = value => value > 0 && value < .01 ? '<0.01%' : `${formatNumber(value)}%`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let nextId = 0;

function ownershipRing({ token, total, parts, note, empty }) {
  const id = `ownership-${token.toLowerCase()}-${++nextId}`;
  const visible = parts.filter(part => part.value > 0);
  const summary = total > 0
    ? `${token} outstanding: ${formatNumber(total)} tokens. ${visible.map(part => `${part.label}: ${formatPercent(part.value / total * 100)}, ${formatNumber(part.value)} tokens`).join('. ')}.`
    : empty;
  let offset = 0;
  const segments = visible.map(part => {
    const share = part.value / total * 100;
    const segment = `<circle class="ownership-segment ownership-${part.kind}" cx="70" cy="70" r="49" pathLength="100" stroke-dasharray="${share} ${100 - share}" stroke-dashoffset="${-offset}"><title>${escape(`${part.label}: ${formatPercent(share)}: ${formatNumber(part.value)} ${token}`)}</title></circle>`;
    offset += share;
    return segment;
  }).join('');
  return `<figure class="ownership-card" data-ownership-chart="${token.toLowerCase()}" data-ownership-total="${total}">
    <figcaption id="${id}">${token} ownership<span>${token === 'FUND' ? 'Asset-sale claim' : 'Revenue claim'}</span></figcaption>
    <div class="ownership-body"><svg class="ownership-ring" viewBox="0 0 140 140" role="img" aria-labelledby="${id}" aria-describedby="${id}-summary"><desc id="${id}-summary">${escape(summary)}</desc><circle class="ownership-ring-track" cx="70" cy="70" r="49"/><g transform="rotate(-90 70 70)">${segments}</g><text x="70" y="67" class="ownership-ring-label">${token}</text><text x="70" y="85" class="ownership-ring-caption">${total > 0 ? 'outstanding' : 'none'}</text></svg>
      ${total > 0 ? `<ul class="ownership-legend">${visible.map(part => `<li data-owner="${part.kind}" data-owner-tokens="${part.value}"><i class="ownership-key ownership-${part.kind}" aria-hidden="true"></i><span>${part.label}</span><strong>${escape(formatPercent(part.value / total * 100))}</strong></li>`).join('')}</ul>` : `<p class="ownership-empty">${empty}</p>`}
    </div><p class="ownership-note">${note}</p>
  </figure>`;
}

/** Partition current outstanding claims, never the percentages of newly issued tokens. */
export function ownershipCharts(p) {
  const successFund = p.separateOwnerOperator ? p.ownerFundMinted ? p.fundOwnerMint ?? 0 : 0 : p.operatorFundMinted ? p.fundOperatorMint : 0;
  const successLabel = p.separateOwnerOperator ? 'Owner' : 'Operators';
  const successPossessive = p.separateOwnerOperator ? 'Owner’s' : 'operators’';
  const fund = ownershipRing({
    token: 'FUND', total: p.fundSupply,
    parts: [
      { label: 'You', kind: 'you', value: p.personalFundTokens },
      { label: 'Other investors', kind: 'investors', value: Math.max(0, p.fundSupply - p.personalFundTokens - successFund) },
      { label: successLabel, kind: p.separateOwnerOperator ? 'owner' : 'operators', value: successFund },
    ],
    empty: p.phase === 'refunded' ? 'All FUND was redeemed for refunds.' : 'No FUND has been issued.',
    note: p.phase === 'refunded' ? 'The asset was not purchased.' : p.purchaseCompleted
      ? p.phase === 'liquidated' ? 'Sale claims are shown before FUND is redeemed.' : `Includes the ${successPossessive} allocation at purchase.`
      : `Current fundraising tokens; the ${successPossessive} allocation comes after purchase.`,
  });
  const income = ownershipRing({
    token: 'INCOME', total: p.revSupply,
    parts: [
      { label: 'You', kind: 'you', value: p.personalRevTokens },
      { label: 'Other investors', kind: 'investors', value: Math.max(0, p.revInvestorTokens - p.personalRevTokens) },
      ...(p.separateOwnerOperator ? [{ label: 'Owner', kind: 'owner', value: p.revOwnerTokens ?? 0 }] : []),
      { label: p.separateOwnerOperator ? 'Operator' : 'Operators', kind: 'operators', value: p.revOperatorTokens },
      { label: 'Customers', kind: 'customers', value: p.revRenterTokens },
      { label: 'Rewards waiting', kind: 'pending', value: p.revStickyPendingTokens },
      { label: 'Unallocated', kind: 'unallocated', value: p.revStickyUnallocatedTokens },
    ],
    empty: p.purchaseCompleted ? 'No INCOME remains outstanding.' : 'No INCOME has been issued.',
    note: !p.purchaseCompleted ? 'Revenue tokens start after a successful purchase.' : p.revStickyPendingTokens > 0
      ? '“You” shows available INCOME. Waiting rewards for all holders are counted separately.'
      : p.revStickyUnallocatedTokens > 0 ? 'Unallocated rewards stay in supply without a holder.' : 'Current token balances, after any modeled cash-outs.',
  });
  return `<section class="ownership-section" aria-label="Token ownership at this stage"><div class="ownership-heading"><h3>Who holds the tokens?</h3><p>Shares of outstanding tokens at this stage.</p></div><div class="ownership-charts">${fund}${income}</div></section>`;
}

/** Keep this supplement independent of the homepage and shared header styles. */
export function initOwnershipCharts(ownerDocument = document) {
  if (ownerDocument.querySelector('#ownership-chart-styles')) return;
  const link = ownerDocument.createElement('link');
  link.id = 'ownership-chart-styles';
  link.rel = 'stylesheet';
  link.href = new URL('./ownership-charts.css', import.meta.url).href;
  ownerDocument.head.append(link);
}
