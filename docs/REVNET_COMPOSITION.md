# Rooftop as a property-specific Revnet

**Earlier exploration, superseded by [NETWORK_DESIGN.md](NETWORK_DESIGN.md).** The current design keeps FUND property claims separate from REV revenue claims and includes ongoing rent issuance. Its operating-token cash-outs replace the net-rent sweep below. The fixed-supply proof and payoff floor are historical assumptions, not guarantees for the current model.

Preferred architecture direction following the holder-loan discussion, September 8, 2026. This is a source-reviewed design, not a deployed or integration-tested configuration. The product explanation now presents this composition and the [Juicebox fundraising escrow](JUICEBOX_ESCROW.md). Its numerical simulations and standalone vault remain the earlier capped-redemption prototype; they do not implement this composition or loans.

## What changes

Use the existing `REVDeployer`, `REVOwner`, and `REVLoans` for token ownership, cash-outs, and holder loans. Rooftop supplies the property transaction, investor allocation, net-income remittance, evidence, and the condition for ending the property's obligation.

The earlier objection about Revnet having no ordinary property-payoff payout was too broad. Investor capital can go through a separate property closing escrow. It does not have to enter the Revnet treasury before paying the existing lender or seller.

The important economic change is to define the target as a **minimum redemption floor that completes the property's financing**, not a permanent maximum on token value. Once the floor is funded, the property's rent/security obligation can end under the agreed documents. The Revnet remains as an independent treasury for tokens and outstanding loans. Later fees, donations, and loan forfeitures may increase token value above the release floor.

## The proposed transaction

1. Subscriptions enter a dedicated fundraising Juicebox controlled by a constrained Rooftop contract. At commitment, its funds go to the agreed property closing escrow for creditor payoff or purchase consideration, closing costs, and separate operating reserves. The [launcher specification](JUICEBOX_ESCROW.md) defines receipt refunds, fees, closing states and the separate external-settlement boundary.
2. Launch one stock Revnet for that property and financing series, with the entire initial investor allocation issued at closing. Investors receive tokens in proportion to their funded subscriptions. Initial liquid redemption backing can be zero because their capital financed the property.
3. The property manager/servicer pays permitted expenses and maintains reserves outside the Revnet. The agreed net cash enters the Revnet through `addToBalanceOf`, without issuing new tokens.
4. Token holders may cash out or use the existing Revnet loan machinery. A holder can borrow only against that holder's tokens; the sponsor receives no separate borrowing privilege over investors' backing.
5. When the measured redemption floor meets the agreed release threshold, the representative can discharge the property's rent/security obligations under the signed documents. Existing token and loan rights continue against the Revnet treasury; the sponsor does not receive or drain that treasury.

There is no need to transfer the Juicebox project NFT to the sponsor when the property's financing ends. Project ownership and real-property rights are different things.

## Narrow launch configuration

| Parameter | Proposed setting | Reason |
| --- | --- | --- |
| Accepted accounting assets | One settlement token | Avoid exchange-rate dependencies inside the guarantee |
| Chain scope | One chain, local balances | Avoid remote-liquidity assumptions |
| Stages | One permanent stage | No future issuance or cash-out-tax changes |
| `initialIssuance` | `0` | Ordinary payments cannot create fresh investor claims |
| `issuanceCutFrequency` / `issuanceCutPercent` | `0` / `0` | No recurring stage or issuance decay |
| `splitPercent` / reserved splits | `0` / empty | No reserved-token dilution |
| `cashOutTaxRate` | `0` | Proportional cash-out/loan valuation |
| Initial `autoIssuances` | One complete allocation, fully materialized at closing | All investor claims count before backing is valued |
| Later auto-issuance | None | No unpriced future claims |
| Additional NFT/bridge integrations | None initially | Keep the asset and claim accounting bounded |

Zero is an actual zero issuance weight in the local core, not its weight-inheritance sentinel. See [`JBRulesets`](../../../nana-core-v6/src/JBRulesets.sol) and [`REVDeployer._makeRulesetConfiguration`](../../../revnet-core-v6/src/REVDeployer.sol).

**Initial issuance must be completed, not merely scheduled.** Revnet's auto-issuance configuration records amounts that `REVOwner.autoIssueFor` mints later. Unissued allocations are not automatically included in token supply. A robust closing adapter can mint the whole series to an allocation distributor in the same transaction, then let investors claim existing tokens. Passive investors remain in the denominator because their tokens already exist. Any alternative must ensure every allocation is materialized before backing can be valued or the property released. See [`REVOwner.autoIssueFor`](../../../revnet-core-v6/src/REVOwner.sol).

Zero issuance does not disable Revnet's buyback-pool initialization. Source loan fees can be routed through a purchase of existing tokens. At zero fresh issuance and zero reserved split, the inspected buyback path does not create net new claim supply, but fees may benefit market sellers instead of remaining in the treasury. This routing and its permissions require end-to-end validation; do not advertise a nonexistent no-AMM switch.

## Why holder loans need not impair other holders' liquidity

Use one settlement asset and define:

- `B`: actual locally available treasury cash.
- `F`: live investor token supply.
- `Q`: collateral tokens burned by open Revnet loans, with a right to remint upon repayment.
- `D`: outstanding gross loan principal, excluding uncollected additional interest.
- `q_i`, `d_i`: collateral units and principal of loan `i`.

Revnet's economic supply and proportional price are:

```text
N = F + Q
p = (B + D) / N
```

The existing runtime adds both loan principal and burned collateral to cash-out accounting. Borrowing is bounded by collateral value and live treasury liquidity. See [`REVOwner.beforeCashOutRecordedWith`](../../../revnet-core-v6/src/REVOwner.sol) and [`REVLoans._borrowableAmountFrom`](../../../revnet-core-v6/src/REVLoans.sol).

If every loan satisfies `d_i <= q_i * p`, then:

```text
B = F * p + sum(q_i * p - d_i)
B >= F * p
```

Actual treasury cash can therefore pay every freely held token at the current gross floor, even if none of the borrowers repay. The missing cash corresponds to claims that cannot also be redeemed while pledged. The loan is supported by the borrower's own encumbered token claim, rather than by a promise to recover an unrelated asset.

Cash-out removes a proportional amount of cash and supply. Repayment converts principal into cash and loan collateral into live tokens without changing effective supply. Pairing expired-loan principal removal with collateral forfeiture cannot reduce the remaining floor while the per-loan inequality holds. Downward payout rounding leaves additional backing for remaining holders.

This proof assumes the specified closed issuance, one asset, local accounting, zero tax, no other treasury-spending powers, no adverse settlement-asset balance change, and correct fee/hook accounting. It is not a blanket guarantee for arbitrary Revnet configurations or proof of contract security. A normal terminal's local-cash cap alone would not establish this invariant.

Unpaid interest must not simply be added to backing. For example, with $84 cash, $16 principal, 80 live units and 20 collateral units, adding $10 of unpaid interest would advertise $1.10 per unit and $88 for live holders against only $84 cash. The local Revnet tracks principal separately from later fees charged on repayment.

## Property release with outstanding loans

Suppose the agreed gross release floor is $1.30:

```text
Cash                          $114
Outstanding loan principal     $16
Live tokens                     80
Loan collateral tokens          20
Economic floor                $1.30
```

The 80 live tokens can immediately redeem $104 gross, leaving $10 treasury cash behind the open loan. The borrower can repay $16, remint 20 tokens, and redeem $26 gross. Future property income is not needed to support those rights. Thus the legal release can be tied to the measured floor while the existing loan continues under its original terms.

Stock Revnet expiry has different consequences from a custom net settlement: after the applicable ten-year term, collateral is permanently forfeited and the loan counters are removed. Revnet does not automatically pay the borrower's residual value. If that was the last loan and no tokens remain, residual cash can become stranded. This is an explicit stock-loan tradeoff, not an investor make-whole payment.

The release condition must include `Q` and `D`. Zero live supply does not mean that all claims have ended. The governing documents must identify the loan positions as continuing treasury rights and preauthorize the end of property rights at the defined floor condition.

## Gross floor, net receipts, and actual guarantees

Zero cash-out tax does not universally mean zero transaction fee. The local terminal can deduct a protocol fee from qualifying zero-tax cash-outs. Loans can also include a terminal fee, a source fee, and a REV fee; debt can exceed cash delivered to the borrower. See [`JBMultiTerminal`](../../../nana-core-v6/src/JBMultiTerminal.sol) and [`REVLoans._addTo`](../../../revnet-core-v6/src/REVLoans.sol).

Define whether the release threshold is gross protocol value or a promised net redemption amount. If the product promises net cash, the threshold must include the relevant fee budget and actual execution routing. Gas and settlement-token purchasing power also remain distinct from token accounting.

The defensible guarantee is conditional preservation of **current redemption capacity for unencumbered tokens**. It does not guarantee that rent will fund original principal or the target, that the settlement asset will maintain its price, or that a property sale will recover enough. Borrowers must understand their fees, repayment/remint rights, and expiry forfeiture.

## What Rooftop still supplies

- A fundraising Juicebox escrow, coordinated property closing and an allocation mechanism that fully materializes the initial token supply.
- Property/entity documents, investor and loan-holder rights, and the authority to enforce and release security.
- Controlled net-income remittance, operating-reserve policy, evidence, and reporting.
- A release-condition reader/covenant that accounts for live tokens, burned loan collateral, outstanding principal, fees, and the accepted settlement asset.
- An interface for existing Revnet payments, cash-outs, loan NFTs, repayment, and expiry terms.

Before replacing the current prototype, integration tests should launch this exact stock configuration, fully issue allocations, exercise real fee and buyback paths, borrow, cash out every free token, repay or expire loans, and test release with only loan claims remaining. Verify all mint and spending permissions and the precise deployed version. No custom loan engine should be added merely to duplicate these existing capabilities.
