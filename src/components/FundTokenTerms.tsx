/** What a setup fixes about its tokens, read from the published setup first and from its plan otherwise. */
export type FundTokenTerms = {
  tokenName: string | null
  tokenSymbol: string | null
  ownerFundPercent: number | null
  operatorSplitPercent: number | null
  fundHolderSplitPercent: number | null
}

const share = (value: number | null) => value === null ? 'not specified' : `${value}%`

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
    <h3>Starting token terms</h3>
    <p>The initial 500,000 INCOME is allocated to all FUND holders at the published snapshot, including inactive ERC20 balances and unclaimed token credits. Claiming that allocation requires no activation, staking or vesting. Ongoing FUND rewards are separate and require eligible Sticky staking.</p>
    <p>Planned Owner FUND share: {share(ownerFundPercent)}. The Owner may distribute these FUND tokens at their discretion. Current balances and supply determine actual ownership.</p>
    {allocated && <p>Planned new INCOME allocation: {operatorSplitPercent}% operators / {fundHolderSplitPercent}% eligible FUND stakers / {100 - operatorSplitPercent - fundHolderSplitPercent}% customers.</p>}
    <p>Borrowing or cashing out INCOME does not sell FUND. Neither token has a promised repayment date.</p>
  </section>
}
