/** What a setup fixes about its tokens, read from the published setup first and from its plan otherwise. */
export type FundTokenTerms = {
  tokenName: string | null
  tokenSymbol: string | null
  ownerFundPercent: number | null
  operatorSplitPercent: number | null
  fundHolderSplitPercent: number | null
}

/**
 * The FUND token and the terms its holders start with. One block, on the Owners
 * tab, on the live project page and on the preview and intent pages alike.
 */
export function FundTokenTermsSection({ terms }: { terms: FundTokenTerms }) {
  const { tokenName, tokenSymbol, ownerFundPercent, operatorSplitPercent, fundHolderSplitPercent } = terms
  const allocated = operatorSplitPercent !== null && fundHolderSplitPercent !== null
    && operatorSplitPercent + fundHolderSplitPercent <= 100
  return <section className="demo-section demo-published-token" aria-label="FUND token">
    <h2>FUND token</h2>
    {(tokenName || tokenSymbol) && <dl className="demo-account-balances">
      <div><dt>Token name</dt><dd>{tokenName ?? 'Not specified'}</dd></div>
      <div><dt>Ticker</dt><dd>{tokenSymbol ?? 'Not specified'}</dd></div>
    </dl>}
    <ul className="demo-token-terms">
      {ownerFundPercent !== null && <li>The owner receives {ownerFundPercent}% of FUND once the asset is bought.</li>}
      <li>When INCOME launches, 500,000 INCOME is split across FUND holders.</li>
      {allocated && <li>New INCOME goes {operatorSplitPercent}% to operators, {fundHolderSplitPercent}% to FUND stakers and {100 - operatorSplitPercent - fundHolderSplitPercent}% to customers.</li>}
    </ul>
  </section>
}
