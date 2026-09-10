# Rooftop property investment playbook

**Earlier financing playbook.** Use [NETWORK_DESIGN.md](NETWORK_DESIGN.md) for the current continuing FUND/REV rights, operator issuance, reserves and sale economics. The property diligence topics below remain useful, but the constrained escrow, fixed-payoff and receipt-exchange provisions are superseded.

Proposed operating playbook, September 8, 2026. No property, appraisal, insurance policy, lien, subscription, or independent verification is asserted by this document. The [earlier mechanism](MECHANISM.md) describes the capped numerical comparison only.

## 1. Source and define the transaction

Create one dedicated property entity and financing series, with a paired fundraising Juicebox and revenue Revnet using one settlement asset. Reuse the underwriting and software template across deals. Keep each property's money, title/security rights, token supply, records, and losses separate. Portfolio views aggregate information; they do not pool collateral. Investing in the next deal requires a new investor decision, with no automatic rollover or cross-subsidy.

Record the address, jurisdiction, beneficial ownership, sponsor, servicer, property manager, and proposed security representative. Establish how rent reaches the controlled account. If payments come from another business, identify that obligor and collection arrangement separately.

## 2. Underwrite repayment and recovery

Obtain operating history, leases, arrears, vacancy, taxes, insurance, inspection findings, repair plans, valuation methodology, debt statements, and title/lien records. Reconcile historical cash receipts to bank evidence. Assess sponsor experience and disclosed related-party fees.

Model base, vacancy/repair, currency stress where relevant, and forced-sale cases. Show available cash after expenses, reserve deficits, target-funding dates, maturity gap, and conservative net sale coverage. A longer target-funding horizon cannot solve insufficient asset recovery. These are established underwriting distinctions discussed in the [OCC Commercial Real Estate Lending handbook](https://www.occ.treas.gov/publications-and-resources/publications/comptrollers-handbook/files/commercial-real-estate-lending/pub-ch-commercial-real-estate.pdf); this playbook does not adopt its bank-specific regulatory requirements.

Set transaction-specific acceptance thresholds in the investment memo: maximum leverage, minimum initial reserves, stressed cash capacity, evidence freshness, and maximum term. Mark each threshold pass, fail, or unresolved. Missing required evidence blocks closing rather than silently receiving a favorable assumption.

## 3. Fix the sources, uses, and investor terms

| Transaction | Primary closing uses |
| --- | --- |
| Refinance | Creditor's dated payoff, lien releases, arrears/cure costs, closing fees, initial reserves |
| Acquisition | Purchase consideration, closing/title costs, applicable taxes, repairs, initial reserves |

Sources include investor subscriptions, disclosed sponsor equity, and any permitted senior financing. Reconcile sources to all uses, including conversion/protocol costs and any initial redemption backing. Identify recipient accounts and who certifies each payment. Disclose seller or sponsor cash received at closing.

Publish receipt price and conversion, initial REV allocation policy, property-release floor per unit, sweep share, maturity date, expense policy, seniority, recourse, transfer restrictions, early-exit and voluntary-burn forfeiture, stock holder-loan fees/expiry, default claim, extension authority, and residual policy. Define gross versus net release value, failed-raise refunds and their fee provision. Specify whether reserve or reporting failures trigger cure or manager replacement. A compliant low-rent month need not be a payment default under a pure cash-flow sweep.

The ownership/security documents must identify the same claims as the token system. Local counsel determines issuance, transfer, entity, security, and enforcement requirements for the actual jurisdiction. Tokenization alone does not determine legal rights, as illustrated by the [SEC staff statement on tokenized securities](https://www.sec.gov/newsroom/speeches-statements/corp-fin-statement-tokenized-securities-012826-statement-tokenized-securities).

## 4. Gate subscriptions and close

Hold subscriptions in the fundraising Juicebox with a funding deadline and specified refund rules. Each receipt carries either a failed-raise refund or fixed conversion right for its current holder. Subscription money is financing capital, never rental income. Finalize legal documents, title/security checks, required insurance, reserve funding, sponsor contributions, and authorized recipients before committing funds.

The closing agent coordinates settlement with effective acquisition or creditor payoff and the required security perfection. Record actual confirmations and unresolved exceptions. Human legal and banking steps are not automatically atomic with blockchain transfers. Materialize the full REV supply into a locked distributor at commitment; only verified closing enables receipt conversion. Failed commitment transactions revert on-chain. Failed external settlement requires the agent to return funds and restore refund capacity; a timeout does not restore spent money.

## 5. Operate and make confidence verifiable

Each reporting period, reconcile collected rent, permitted expenses, reserve balances, sponsor distributions, and the actual backing deposit. Attach receipt references and explain variances. Give investors a compact property dashboard showing:

- Today's net exit quote and original issue price, with actual treasury cash shown separately from outstanding loan principal.
- Release floor, coverage, live units, burned loan collateral, unclaimed allocations and funding gap.
- Reserve balance, required reserve, and last reconciliation date.
- Historical cash deposited and redeemed, separately from remaining liability.
- Maturity, base/stress projections, outstanding breaches, and evidence freshness.

Maintain an evidence register with document name/link or restricted-file reference, property/period, issuer, reviewer, issue date, review date, expiration where applicable, and status. Use `Missing`, `Submitted`, `Reviewed`, `Expired`, or `Disputed`. A file hash proves file identity; it does not verify its contents. An independent-review label requires an actual named reviewer and dated review. Demonstration data must remain labeled as such.

The sponsor proposes budgets and funds deficits. The manager handles property operations. The servicer reconciles cash and reports. The security representative exercises documented remedies and releases. Record who can approve exceptions and related-party spending; changing a spreadsheet is not sufficient authority to change investor rights.

## 6. Redeem, release, or enforce

Before redemption, show units burned, gross and net proceeds, subscription comparison, and all rights surrendered. Investors choose whether to exit at current backing or retain exposure to future funding and property recovery. Before a holder loan, show gross principal, net cash, encumbered units, fees, repayment/remint rights and stock expiry forfeiture. Execution needs appropriate minimum-output protection.

When the agreed minimum redemption floor is funded, publish the Revnet evidence and representative's release status separately. Include both live and loan-collateral tokens in the calculation; zero live supply does not prove all claims have ended. The Revnet treasury, unclaimed allocations and open loans continue after property release, and later token value may exceed the release floor. The sponsor does not receive that treasury. Any applicable unclaimed-property procedure needs explicit legal handling. The sponsor can recover unrestricted property rights only through the documented release process.

At maturity or a covenant breach, show notice, cure deadline, authorized decision, and current remedy status. Sale settlement records gross realized proceeds, transaction/enforcement costs, senior claims, net investor allocation, and residual. Unresolved losses stay visible. Do not label a haircut as full repayment or invent a sale date before one exists.

## 7. Repeat with an auditable record

Archive actual funding duration, realized investor outcomes including discounted exits, expense variance, defaults, and recovered losses. Improve the next property's assumptions using that history. Each new property repeats underwriting, legal review, capital gating, and an explicit subscription. Prior success is evidence about execution, not a guarantee of another property's return.
