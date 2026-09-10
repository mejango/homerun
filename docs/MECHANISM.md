# Rooftop: cash-backed property financing

**Earlier capped prototype.** This document describes the numerical model and standalone reference vault. The current [FUND/REV network design](NETWORK_DESIGN.md) has separate continuing property and revenue claims, operator issuance and no fixed-payoff target. The rules below do not describe the current website.

Design specification, September 8, 2026. This repository is a product prototype, not a deployed financing. Screens and examples are illustrative. Property documents, security rights, closing evidence, a production Juicebox adapter, and independent contract review remain required before accepting investment.

## What investors buy

Rooftop investors finance one property through a dedicated entity, Juicebox project, and protected redemption vault. Their fixed units carry a contractual right to redeem against that vault and defined rights against the property until payoff or an agreed enforcement settlement. The sponsor retains the residual interest and manages the property within documented limits.

After operating expenses and reserves, an agreed share of collected cash enters the vault. Investors receive value through a rising cash-out price. There are no periodic reward distributions. Depositing rent does not issue tokens or increase an investor's token count.

**Cash-backed today** and **secured by a property** mean different things. The vault holds spendable settlement assets. Property rights provide a separate recovery process. An appraisal, unsigned pledge, projected rent, or promise to sell cannot increase today's redeemable cash.

## The cash-out rule

For one settlement asset, let:

| Symbol | Meaning |
| --- | --- |
| `B` | Protected liquid redemption balance actually received |
| `S` | Outstanding investor units; issuance closes with the financing |
| `T` | Fixed target redemption amount per unit |
| `P` | Original subscription price per unit |

```text
current cash-out price = min(B / S, T), when S > 0
cash-out of x units = x × current cash-out price
remaining target liability = S × T
additional funding to reach target = max(0, S × T − B)
```

The cash-out burns `x` units and pays their proportional cash amount, with zero cash-out tax. Contract arithmetic rounds conservatively to settlement-asset precision. Transactions require an investor-specified minimum output; reject cash-outs that would burn units for zero proceeds. No quote exists when `S = 0`.

Below the cap, a proportional redemption leaves the remaining price unchanged, apart from rounding:

```text
(B − x × B/S) / (S − x) = B/S
```

Early redeemers receive the same fraction of existing cash as their fraction of outstanding supply. They cannot take their full target ahead of others when the vault is underfunded. Fees, if any, need an explicit payer outside the quoted protected amount; a hidden terminal fee would break this promise.

### An early exit permanently sells the remaining rights

Assume 500,000 units issued for $1 each, a $1.30 target, and $100,000 in the vault. Today's cash-out price is $0.20. Redeeming 50,000 units pays $10,000 and burns every future right attached to those units, including participation in later rent or a property sale. Relative to a $50,000 subscription, that realizes a $40,000 loss.

The remaining vault has $90,000 backing 450,000 units: still $0.20 each. Its target is now $585,000, requiring another $495,000. Without that exit, another $550,000 would have been required. Early discounted exits reduce the sponsor's ultimate financing cost by the surrendered entitlement; they do not transfer that entitlement to continuing holders. This is an explicit deal term investors must see before subscribing and again before redeeming.

Track historical cash paid separately from remaining liability. Here, full eventual settlement pays $595,000 in aggregate: $10,000 already withdrawn plus $585,000 owed to remaining units at target. A dashboard must not present the reduced liability as an investment return earned by the sponsor.

## Operations and final payoff

Rent goes first to a controlled collection account. The servicer pays permitted expenses, taxes, insurance, senior obligations, and actual reserve replenishment under the approved budget. Tenant deposits and operating/capital reserves stay outside `B`. Sweep the agreed share of remaining cash into the redemption vault; permit only documented sponsor distributions from the residual.

Once deposited, redemption cash cannot fund repairs, management fees, another property, or discretionary sponsor withdrawals. Reserve shortages must be resolved with operating cash, sponsor funding, or the documented workout process. Sponsor top-ups and realized sale proceeds can also back the vault without minting units.

At `B >= S × T`, segregate enough irrevocable cash to settle every outstanding unit. Future financing rights can then terminate under the executed legal documents, allowing the authorized representative to release the collateral. Unredeemed units retain their full cash claim; legal release must not depend on every investor claiming promptly. The contract cannot itself release a lien or transfer title.

Cash above the full remaining target belongs to the documented residual beneficiary. It must never include cash reserved for unredeemed units. Zero outstanding supply also requires explicit residual handling and the corresponding legal release procedure.

## Returns and limits

For an investor who subscribes once and cashes out once after `n` years:

```text
annualized return = (cash-out proceeds / subscription cost)^(1/n) − 1
```

A $500,000 issue with a $650,000 target and $4,800 monthly backing deposits reaches the target in month 136 if there are no early exits, fees, or interruptions. Holding to that date produces about **2.34% annualized**, not the 4.95% IRR of receiving monthly amortization payments. Retained rent increases redemption value; the base model assumes no yield on the vault itself. Show target date as a scenario, never a promised maturity outcome.

Initial redemption backing may be zero because subscriptions financed the property. Display that plainly. Principal is fully cash-backed only when price reaches `P`; the target is fully cash-backed only when price reaches `T`. Settlement-asset depegging, bank remittance failures, contract faults, and property losses remain distinct risks.

At maturity or default, a representative follows the agreed cure, workout, and sale process. Only realized net proceeds enter `B`. Specify seniority, enforcement costs, and whether the legal default claim includes the target premium. A shortfall requires the documented settlement or haircut process; neither an appraisal oracle nor a sponsor button may declare investors whole. Liquidation can lose money.

## Juicebox integration boundary

Use a closed investor supply and constrain minting, project ownership, controller/terminal migration, allowances, successor rulesets, and payout paths. A future adapter must make the protected vault the single source of redemption liquidity and burn the same units that carry the legal claim. Core terminal surplus is not automatically the vault balance.

Local [`JBMultiTerminal.addToBalanceOf`](../../../nana-core-v6/src/JBMultiTerminal.sol) illustrates adding funds without issuing tokens; ordinary terminal cash-outs need a verified adapter or must be disabled to prevent duplicate or reserve-funded exits. The prototype does not establish those production permissions. Stock Revnet token-backed loans do not implement property foreclosure. Review the implementation README for the exact current scope.
