# Homerun: an asset claim and a revenue network

Current product specification, September 9, 2026. The hybrid combines an initial INCOME allocation with ongoing rewards for all FUND holders. It supersedes the earlier premint-only, fixed-payoff, burn-to-convert and net-revenue designs. Founder Haus remains the concrete house example: its modeled revenue is rent and its customers are renters. The same framing can describe other income-producing assets, but asset ownership and enforceable rights require their own verified arrangements. The website is an editable simulation. It does not deploy projects, verify corporate rights, collect revenue, or submit transactions.

## Two claims and an optional staking comparison

The example assumes that the corporation owns the underlying asset and the fundraising Juicebox project. It operates the revenue Revnet; the stock `REVOwner` contract holds that project's NFT and constrains its economic schedule. The default model allocates ongoing rewards directly to all FUND holders without staking or vesting. The production integration for that distribution is not implemented. An explicit `fundRewardMode = 'staking'` comparison instead uses a third, separate FUND Sticky project that accepts FH-FUND and issues a SHARE token representing the deposited FUND.

| Token | Issuance | Proposed economic right | What happens on an exit |
| --- | --- | --- | --- |
| FH-FUND | 10,000 per USDC subscribed; one operator allocation on successful purchase | Equal participation per token in the corporation's designated asset-sale distribution | A fundraising/failure/sale cash-out burns the redeemed FUND tokens |
| FH-INCOME | A complete initial allocation to the closing FUND snapshot, plus scheduled issuance for revenue payments | Equal participation per token in the Revnet cash pool, with stock cash-outs and loans | Cash-out burns INCOME; borrowing encumbers INCOME under the stock loan terms |
| FUND Sticky SHARE, optional comparison | Issued when FUND is deposited into the separate Sticky project | Recovery of underlying FUND and eligibility for ongoing INCOME reward snapshots | Unstick SHARE to recover FUND; already-earned reward claims remain separate |

FUND is **not surrendered or burned** to claim the initial INCOME. That entitlement is fixed by one closing snapshot, including operator FUND. A holder also receives a recurring INCOME allocation in proportion to its FUND ownership. A buyer of FUND after the closing snapshot buys continuing FUND rights and eligibility for future rewards, but receives no duplicate closing premint. In the optional staking comparison, that ongoing eligibility requires depositing FUND in the separate Sticky project. Custody does not create a second asset claim. A customer who only owns INCOME has no FUND claim on the asset-sale pool.

Every holder within each token class has the same per-token economics. Operator-owned FUND earns the same proportional holder rewards as other FUND. The premint creates a large early ownership share; **it is not a senior repayment waterfall**. The initial operating reserve is also financed by the subscribers. The corporation's governing documents must establish the proposed FUND rights, sale distribution, control of the asset and treatment of liabilities; a Juicebox token does not itself establish legal title.

## Fundraising and manual owner transitions

Default usable budget:

| Use | Amount |
| --- | ---: |
| Asset acquisition | $500,000 |
| Separate operating cash reserve | $100,000 |
| Other purchase costs | Editable; $0 placeholder |
| Usable cash required | $600,000 before other costs |
| Illustrative payout fee | 2.5% of the gross withdrawal |
| Gross raise required | $615,384.62 before other costs |

The fee estimate grosses up the withdrawal so the two uses actually receive $600,000. Actual terminal rounding, exemptions, routing and minimum net delivery must be quoted before execution. Gas and project creation are separate. A gross amount already spent during fundraising is an additional funding requirement; it must not be subtracted twice when checking remaining escrow.

The corporation manually queues Juicebox rulesets. The description records its success and failure policy. Reaching a displayed amount does not automatically activate either outcome. The product prepares ordered owner action drafts for closing, refunds, purchase completion and sale redemptions. See [OWNER_ACTIONS.md](OWNER_ACTIONS.md).

While fundraising, the cash-out tax parameter is 10%. For a holder redeeming fraction `f` of outstanding supply, the gross quote is `surplus × f × (0.9 + 0.1f)`. Protocol fees are separate. This is a curve, not a flat 10% charge. Only the permitted operating budget should be reserved for payouts at this point; reserving the whole purchase price would remove it from cash-out surplus before purchase commitment.

At committed closing, pause payments and disable FUND cash-outs while capital is committed. On failure before purchase, disable further issuance, remove withdrawal allowances and unused payout reservations, and enable zero-tax cash-outs of the remaining USDC. Refunds follow outstanding FUND holdings and remaining cash after incurred costs; the simulation does not reconstruct earlier trades or partial exits.

Only after successful purchase, mint the operator FUND allocation once. The default is **20% of total post-mint supply**, leaving investors with 80%. If the investor supply is `I` and the operator fraction is `p`, mint `I × p / (1 − p)`; a 20% allocation requires `I/4`, not `I/5`. No such allocation is earned on failure. Freeze normal minting after the allocation and publish the resulting supply. An owner who can queue unrestricted future rulesets can still change this policy; the buttons do not create an irreversible restriction.

## Initial INCOME and revenue issuance

Agreed starting settings:

| Setting | Default |
| --- | ---: |
| Total initial INCOME allocation | 500,000 FH-INCOME |
| Allocation basis | All post-success FUND holdings, including the operator allocation |
| Initial issuance price | $0.10 per total newly issued INCOME |
| Initial total issuance | 10 INCOME per USDC, before all allocations |
| Operator share of new issuance | 75% |
| FUND-holder share of total new issuance | 15% |
| Customer share of new issuance | 10% |
| Quarterly reduction in tokens issued per USDC | 5%, for eight reductions over two years |
| Reduction boundaries | Elapsed months 3, 6, 9, 12, 15, 18, 21 and 24 |
| After the eighth reduction | Hold issuance flat; no perpetual reductions |
| INCOME cash-out tax | 0% |
| Starting revenue / monthly operating expense | $10,000 / $6,000 |
| Annual revenue / expense growth | 3% / 3%, editable assumptions |
| Ongoing FUND reward mode | All holders, in proportion to FUND ownership |
| Reward availability | Immediate; no staking or vesting requirement |

The initial allocation has an issuance-price equivalent of $50,000. It is not treasury cash, a market valuation, or a guaranteed redemption amount. Opening INCOME cash is zero. With the default FUND allocation, original investors receive 400,000 initial INCOME and operators receive 100,000. There is no second operator premint on top of that. The ongoing holder rewards supplement this allocation; they do not replace it.

The first month's $10,000 revenue directly mints 100,000 INCOME: approximately 75,000 for operators, 15,000 for FUND-holder rewards and 10,000 for customers. Those 100,000 tokens are the **total** issuance. The holder allocation is not another 15% minted afterward. The 75/15/10 allocation applies throughout the schedule.

The rate becomes 9.5 INCOME/USDC at elapsed month 3 and continues through eight reductions to 6.634204312890625 INCOME/USDC at elapsed month 24. The resulting issuance price is about $0.150734 per INCOME and remains flat afterward. The model counts reductions as `floor(min(elapsedMonth, issuanceCutYears × 12) / issuanceCutMonths)`, with `issuanceCutMonths = 3` and `issuanceCutYears = 2`. Stopping reductions matters: indefinitely reducing issuance can starve operators of recurring purchasing power even while the nominal issuance price rises. This is an illustrative schedule, not an optimized investment recommendation.

Fully materialize the whole initial INCOME allocation before revenue, redemptions or borrowing. Store it in a distributor whose one-time snapshot claims preserve FUND ownership. `REVOwner.autoIssueFor` must actually execute; an unexecuted autoissuance is not automatically included in supply. Launch and materialize this allocation in one reviewed transaction so another participant cannot pay or borrow between those operations. That executor or batch is a production integration requirement, not an implemented feature of the owner drafts. Use already minted vesting or distribution balances if allocations are delayed.

If wrappers or custodians hold FUND at the closing snapshot, resolve the beneficial owners without counting both custody balances and their receipt tokens. Otherwise the closing premint could land in a custody terminal instead of reaching the intended holders. In the optional staking comparison, take this snapshot **before enabling the managed FUND Sticky route**.

## Ongoing FUND-holder rewards

At the agreed allocation, reserve **90% of new INCOME**, then divide that reserved amount between operators and FUND holders in the ratios **75/90 = 5/6 and 15/90 = 1/6**. The remaining 10% goes to the customer/payment beneficiary. The model immediately allocates the 15% holder portion across all FUND ownership, including operator FUND. These rewards are available for cash-out or borrowing without a stake, claim delay or vesting schedule. The complete initial 500,000 INCOME allocation remains a separate closing entitlement.

Automatic distribution to freely held FUND is an **unimplemented integration specification**. The owner draft stays non-executable and requires a reviewed holder-balance source, allocation timing, transfer handling, reward delivery and duplicate-allocation protection. The existing Sticky SHARE route cannot be configured as though it supported this default policy. It specifically serves the custody and snapshot behavior described below.

## Optional FUND Sticky comparison

Set `fundRewardMode = 'staking'` explicitly to use the legacy comparison. Here the 15% portion goes to eligible FUND Sticky SHARE holders. In the inspected native configuration, `splitPercent = 9000`, and reserved split percentages are `833333333` for operations and `166666667` for FUND Sticky, out of `1000000000`. These ratios cannot be represented exactly: mint and split arithmetic rounds in base units, and dust can remain with `REVOwner` for a permissionless burn. Review exact integer output; the monthly model uses illustrative token quantities.

The Sticky split uses **`JBTokenDistributor` as its hook and the FUND Sticky SHARE ERC20 as its beneficiary**, with `projectId = 0`. The beneficiary is neither the raw FUND token nor `JBStickyHook`. Create or verify the separate Sticky project, its accepted FUND asset, SHARE token and distributor registration before configuring this route. Lock both reserved splits in every configured Revnet stage; a lock in one ruleset does not protect a different stage's split table.

Check actual recipient balances and the resulting allocation, not merely a successful parent transaction. A failed reserved-token hook can result in unconsumed reward tokens being burned while the parent payment or distribution succeeds.

The proposed Sticky project has zero cash-out tax so its SHARE holders can recover underlying FUND, subject to verifying the actual custody and withdrawal configuration. Existing FUND and INCOME claims stay separate. Staking does not grant anyone a second asset-sale claim.

**Eligibility uses SHARE ownership at a reward snapshot, not stake age.** A participant may try to stake shortly before a snapshot and leave soon afterward. That short-stake capture issue remains unresolved; this product does not describe Sticky as a proven reward for long-term ownership.

The inspected production design uses weekly rounds and four vesting rounds after reward materialization: 25% becomes available at each weekly transition. It is not automatically full vesting one month after revenue is paid. The staking comparison can approximate this with `stickyVestingMonths = 1`; the default holder configuration has no vesting lag. The comparison auto-claims matured rewards and holds participation constant. It does not simulate checkpoint timing, claim calls, opt-in keepers or changing stake balances. **Unvested rewards remain in supply but cannot be cashed out or borrowed.** Operators may use their vested Sticky rewards for expenses on the same terms as other holders.

With no eligible stakers, the model keeps the reward slice in a visible unallocated pot rather than crediting it to investors, customers or operations. Actual distributor rounds with zero eligible supply may recycle starting the next round; the complete recycling route must be verified separately and is not simulated. Already-earned claims can survive unstaking and continue vesting.

## Operators receive tokens, then obtain operating cash

All modeled gross revenue enters the INCOME treasury. The model does **not** divert a cash operating percentage before issuance.

Each month in the default holder model:

1. Revenue arrives and issues INCOME at the scheduled rate, split between operations, FUND holders and customers.
2. The holder portion is allocated immediately in proportion to FUND ownership.
3. Operators may use their initial INCOME, direct operating allocations and rewards earned by holding their own FUND.
4. Operators redeem only enough available INCOME to cover the month's expenses, accounting for the selected cash-out fee. If that balance is insufficient, they redeem it and the separate operating reserve fills the gap.
5. Tokens not needed for expenses remain with operators. Customer tokens remain with customers unless the editable immediate-exit scenario redeems them.
6. If the reserve is exhausted, the model records unpaid operating obligations. It does not silently invent a loan or additional investor deposit. Continuing projected revenue then assumes operations can continue despite that funding need.

The operator percentage is a percentage of token issuance, **not a percentage of revenue received in cash**. Their cash value is lower early on because the opening premint participates in backing. The $100,000 reserve bridges that difference.

With 500,000 initial INCOME, the 75/15/10 allocation and eight quarterly issuance reductions, the default holder-model cash-out baseline uses **$14,399.44** of the investor-funded reserve, leaving a minimum **$85,600.56**. A persistent 10% revenue reduction, 10% expense increase and 2.5% cash-out fee leaves a minimum **$48,371.57** when revenue and expenses subsequently grow 3% annually; holding both flat leaves **$48,359.52**. These checks run through 30 years plus the next-month quote with fixed FUND ownership and immediately available holder rewards, and record no unpaid operating expenses. They are bounded scenario results, not guarantees of indefinite operating solvency. Operator borrowing is an alternative funding method; the trajectory uses cash-outs and does not simulate operator loan draws or repayment.

At month 12, the default $10,000 subscriber holds approximately 6,500 initial INCOME plus 2,134.11 holder rewards, with no pending rewards. The 8,634.11 available tokens support the illustrative **$835.16 cash-out** or **$785.05 first-loan net proceeds**. The INCOME Revnet holds $62,399.44 and the separate operating reserve holds $85,600.56. These cash-out and loan amounts are alternatives for the same tokens, not additive payouts. The corresponding month-1 estimates are $111.58 and $104.88; month 13 gives $877.35 and $824.70, assuming no prior loan or exit. Personal cash-out quotes are before fees; the loan amounts include the model’s upfront fee estimate.

Increasing the premint or rewards paid to other classes can increase the operating bridge requirement. In the optional staking comparison, lower participation changes who receives Sticky rewards. Results also depend on operators making their initial allocation and available rewards usable for expenses; retaining those tokens or delaying claims changes reserve use. The initial premint's early participation is not a guarantee of principal recovery or priority over other INCOME holders.

The fee-free baseline is specifically the direct, externally funded USDC mint/redemption path with zero INCOME cash-out tax and no fee-deferred surplus. Other routes may charge fees. The editable cash-out fee is a sensitivity assumption, not a contract-wide fee declaration.

## Revenue routing is an implementation dependency

Stock buybacks can spend revenue buying existing tokens rather than leave the entire payment in the treasury. Payer-controlled buyback metadata can also skip the reserved-token split on purchased tokens. These paths do not match this direct-mint model.

Production revenue collection must use a controlled path that constructs metadata itself, preserves reserved splits and deliberately selects direct issuance. Under the inspected positive-issuance buyback implementation, supplying a nonzero minimum swap output equal to the direct issuance count selects its mint fallback. This exact source dependency, decimal handling and stage transitions need integration tests. A website setting alone cannot enforce it. Other direct project payments must not be accepted as proof of revenue settlement without the required routing.

## Two pools remain separate at an asset sale

At the selected sale month, stop adding projected revenue from the sold asset. Deduct selling costs, senior debt and any modeled unpaid operating obligations. Add the unused separate operating reserve once. Deposit the resulting net corporate distribution into the FUND Juicebox using `addToBalanceOf`, without reopening subscriptions or minting tokens.

The owner enables zero-tax FUND cash-outs with no remaining payout reservation or withdrawal allowance. Holders redeem FUND against the sale pool. In the optional staking comparison, a FUND staker first unstakes Sticky SHARE to recover FUND. Each FUND token, including operator-held tokens, receives the same proportional quote. A 20% operator success allocation means the original subscribers together own 80% of this distribution. They financed the asset, operating reserve and fees; an unchanged asset price therefore does not imply recovery of their original subscription.

The INCOME treasury is not moved to FUND. Existing INCOME holders keep its backing and stock loan rights. In the optional staking comparison, already-earned Sticky claims can vest after unstaking. The sale view freezes at the chosen month; it does not advance time to claim pending rewards. Cashing out INCOME does not terminate a separate FUND holding. Selling the asset is not represented as paying off a fixed INCOME return target.

## Modeling scope and sources

Cash ledgers use cents and token balances use illustrative floating-point units. Quotes are not transaction calldata or wei-exact protocol simulation. The model includes monthly issuance with quarterly reductions, immediate proportional FUND-holder rewards, operator/customer cash-outs, operating reserve use, unpaid expenses, fundraising cost deductions and net asset-sale allocation. The optional staking comparison adds a fixed-participation Sticky reward queue, mature rewards and unallocated tokens. It does not simulate historical FUND exits/trades, production holder-distribution calls, exact weekly checkpoints, changing participation, short-stake capture, actual claim/vesting calls, AMM liquidity, actual loans or repayments, taxes, collection delays, legal enforcement or external funding. First-loan quotes use a 6% assumed upfront haircut and omit secondary token issuance from loan-fee routing.

Relevant inspected sources:

- [Revnet stage fields](../../../revnet-core-v6/src/structs/REVStageConfig.sol) and [deployer](../../../revnet-core-v6/src/REVDeployer.sol): scheduled issuance and reserved-token shares.
- [REVOwner](../../../revnet-core-v6/src/REVOwner.sol): operator permissions, pending versus materialized autoissuance, loan accounting and hook composition.
- [JBController](../../../nana-core-v6/src/JBController.sol): minting, reserved-token distribution and ruleset changes.
- [JBMultiTerminal](../../../nana-core-v6/src/JBMultiTerminal.sol): cash-out/payout fees and adding balance without issuance.
- [JBBuybackHook](../../../nana-buyback-hook-v6/src/JBBuybackHook.sol): pay metadata, split bypass and mint/buyback routing.
- [JBStickyDeployer](../../JBSticky/src/JBStickyDeployer.sol): the separate project, accepted token and configured reward/vesting relationships.
- [JBTokenDistributor](../../../nana-distributor-v6/src/JBTokenDistributor.sol): SHARE-token reward routing, snapshot eligibility and materialized vesting.
- [Juicebox developer guide](https://juicebox.money/build) and [mechanics guide](https://juicebox.money/learn).
