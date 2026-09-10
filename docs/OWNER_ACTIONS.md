# Owner action drafts

`web/owner-actions.mjs` prepares reviewable instructions for FH-FUND and the separate FH-INCOME network. The hybrid keeps the initial INCOME premint and adds ongoing INCOME for all FUND holders. The default holder-distribution integration is an unimplemented specification. An explicit staking comparison instead adds a third FUND Sticky project. The module does not connect a wallet, read a chain, prepare complete contract arguments or execute transactions. Every result has `executable: false`.

Founder Haus is the concrete house example. The asset and revenue wording allows other use cases to be discussed; it does not establish ownership or enforce cash-flow rights for another asset. Internal `rev*` and `renter*` projection fields remain compatibility identifiers, while the displayed revenue token is FH-INCOME.

Call `ownerActionDraft(action, projection)` with one of:

| Action | Allowed starting state | Intended next state |
| --- | --- | --- |
| `close_raise` | `raising` | `funded`: capital committed, purchase pending |
| `enable_refunds` | `raising`, `funded` | `refunding` |
| `complete_purchase` | `funded` | `earning` |
| `enable_sale_redemptions` | `earning` | `liquidated` |

Required projection fields are `phase`, `raiseGoal`, `purchaseBudget`, `opsReserve`, `escrowCash`, `precloseSpent`, `fundInvestorSupply`, `fundOperatorMint` and `fundTotalSupply`. Money uses display USDC amounts; supply uses display token units. These are not ABI integers. The two operator-related supply fields describe the planned post-success mint even while raising. They do not prove a mint occurred.

`operatorFundPercent` defaults to 20 and describes the operator's **post-mint** share. The planned mint must equal `investorSupply × percent / (100 − percent)`; total supply must include that mint. At 20%, mint one quarter of the investor supply, resulting in 20% operator and 80% investor ownership. Zero operator participation is supported. `payoutFeePercent` defaults to 2.5; additional net `closingCosts` default to zero. The $500,000 purchase and $100,000 operating reserve are net amounts. At the default fee, the closing cash requirement rounds conservatively to $615,384.62. `raiseGoal` must also cover `precloseSpent`, the gross amount already spent. That prior spending is already excluded from `escrowCash` and must not be deducted twice. Optional `raised` is checked against the gross raise goal separately. Actual contract fees require a quote in USDC base units.

Optional state guards are `operatorFundMinted`, `revenuePreminted`, `purchaseCompleted`, `saleProceedsReceived` and `completedOwnerActions`. `netSaleProceeds` supplies the verified sale amount when known. Missing verification remains an explicit prerequisite, not a successful chain-state check. Known completed actions and incompatible phases make the draft ineligible; the function keeps no transaction history of its own. A partially completed success sequence must be reconciled before preparing a continuation.

The result contains `steps`, `changes`, `warnings`, `requiresVerification`, `blockedReasons` and `eligible`. Steps are ordered objects with `id`, `title`, `description` and optional field `patch`. `eligible` means only that the supplied illustration passes the local guards. Field patches must be merged into the complete reviewed live configuration, including pending rulesets and activation requirements. Missing chain IDs, project IDs, terminals, beneficiaries, snapshot hashes and revenue premint amounts are deliberately not invented.

## What the owner reviews

Closing requires actual escrow cash to cover the remaining gross closing budget; any provided cumulative `raised` must also meet the gross raise goal. Previously spent expenses count only in the gross raise goal, not a second time in required remaining cash. Closing pauses payments and sets FH-FUND's cash-out tax to `10000`, replacing prior payout limits with the reviewed closing reservation. The draft releases no purchase cash. In current Juicebox core, a 100% tax returns zero; it does not revert an attempted cash-out that accepts zero output. Investors must not mistake this setting for a protective transfer or burn pause.

The purchase sequence verifies closing, temporarily enables owner minting, mints the disclosed operator FUND allocation without reserved issuance, then disables owner minting. The final snapshot includes **all investor and operator FUND**, including unclaimed credits and agreed beneficial ownership, after the mint and issuance review. If wrappers or custodians hold FUND, resolve beneficial ownership without counting their FUND and receipt tokens twice or sending the premint into a custody terminal. In the optional staking comparison, take the snapshot **before enabling the managed FUND Sticky route**. FH-INCOME is allocated once in proportion to that snapshot. **No FH-FUND is burned or replaced.** FH-FUND continues as the asset claim.

The draft includes known `revenuePremint`, `revPrice`, `issuanceCutPercent`, `issuanceCutMonths`, `issuanceCutYears`, `operatorSplitPercent`, `ongoingOperatorSplitPercent`, `stickySplitPercent` and `fundRewardMode` inputs. The agreed model settings are **500,000 initial INCOME**, $0.10 initial issuance price (10 INCOME/USDC), **75% of total new issuance to operators, 15% to FUND holders and 10% to customers**, and eight quarterly issuance cuts of 5% over two years, then flat issuance. The 75/15/10 allocation applies throughout the schedule. `stickySplitPercent` is a compatibility field name for the ongoing FUND reward percentage; it does not require staking in holder mode. These are display-stage economics, not complete Revnet calldata. Missing policy values remain null, and a complete stage table requires the FUND reward percentage too. The draft does not assume a one-to-one FUND/INCOME ratio. A zero-premint comparison is supported and explicitly skips the initial autoissuance and claims.

Schedule metadata uses `issuanceCutPercent = 5`, `issuanceCutMonths = 3`, `issuanceCutYears = 2` and `numberOfIssuanceCuts = 8`. Stage boundaries are expressed in elapsed months: 0, 3, 6, 9, 12, 15, 18, 21 and 24. The final rate is 6.634204312890625 INCOME/USDC and remains unchanged after month 24. Production activation timestamps and exact integer issuance weights still require a reviewed deployment configuration.

The entire initial allocation must be materialized through `autoIssueFor` **before revenue backing or holder loans begin**, including all unclaimed INCOME. Require a reviewed atomic deploy-and-mint executor or batch so another transaction cannot pay or borrow in the gap. The owner draft does not implement that executor. Later claims transfer existing allocated tokens; they do not mint additional supply. The operator receives only its proportional FUND-snapshot allocation, with **no additional operator INCOME premint**. The allocation record, finalized block and protection against repeated allocation must be verified separately. Standard FUND ERC20 transfers can continue; later transfers do not create a second INCOME allocation. An owner who controls future FUND rulesets can later reopen minting. The overall manual asset-closing sequence is not automatically atomic or irreversible.

## Ongoing FUND-holder allocation

The default `fundRewardMode = 'holders'` allocates the ongoing FUND portion across all FUND ownership, including operator FUND, immediately when revenue issues INCOME. No stake, vesting period or deferred-reward requirement applies. This portion supplements the complete 500,000-token initial allocation; it does not defer or replace that initial supply.

At 75% operations plus 15% for FUND holders, reserve **90%** of total INCOME issuance (`splitPercent = 9000`). Divide that reserve **75/90 = 5/6** to operations and **15/90 = 1/6** to FUND holders. The remaining 10% of total issuance goes to customers. Integer split counts approximate these ratios, so minting and distribution rounding must be reviewed.

The freely held FUND distribution path is **not implemented**. Owner drafts must leave its delivery integration unresolved and non-executable until the holder-balance source, allocation timing, transfers, recipient delivery and duplicate-allocation protection are verified. The existing Sticky SHARE distributor cannot be presented as supporting unstaked FUND. It has different custody, eligibility and vesting requirements.

## Optional Sticky allocation

These instructions apply only to the explicit `fundRewardMode = 'staking'` comparison.

The third project accepts **FH-FUND** and issues its own SHARE ERC20. Its zero cash-out tax is intended to allow recovery of the underlying FUND; verify actual backing and withdrawal paths. This wrapper preserves the asset claim rather than issuing another one.

At 75% operations plus 15% for FUND stakers, reserve **90%** of total INCOME issuance (`splitPercent = 9000`). Split that reserve **75/90 = 5/6** to operations and **15/90 = 1/6** to FUND Sticky. The remaining 10% of total issuance goes to customers. The integer split counts are `833333333` and `166666667`, summing to `1000000000`. These approximate the desired total issuance ratios; token minting and individual splits also round. The draft flags rounding for review and recommends locking both reserved splits in every stage, using the explicit `lockedUntil` maximum where that permanent destination policy is intended.

For the Sticky portion, **hook = `JBTokenDistributor` and beneficiary = the FUND Sticky SHARE ERC20**, with `projectId = 0`. Neither the raw FUND token nor `JBStickyHook` is the beneficiary. Addresses and project IDs stay null until verified. Confirm distributor registration and actual recipient balances: a failed reserved-token hook can burn unconsumed tokens even when the parent payment/distribution succeeds.

For the former one-month staking comparison, supply `personalStakePercent = 100`, `otherStakePercent = 100` and `stickyVestingMonths = 1`; missing values remain unknown in an owner draft. These fields do not restrict the default holder allocation, which has no vesting lag. The monthly vesting input ranges from zero to 36 for comparison. Actual production vesting uses four weekly rounds after reward materialization. The monthly model auto-claims matured rewards and assumes fixed participation; it does not execute the actual materialization, vesting or claim calls. **Unvested INCOME is not borrowable or redeemable.** Operators can use their vested rewards, earned by staking operator FUND on the same proportional terms, for operating expenses.

Sticky uses ownership at a reward snapshot, **not stake age**. Capturing rewards with a short stake remains unresolved. With no eligible stakers, the model retains an unallocated pot; actual empty rounds may be recyclable starting the following round, subject to verifying the route. The premint gives a large early share, **not senior repayment priority**, and subscribers finance the startup reserve.

## Refunds and asset sale

Failed raises create neither operator FUND nor INCOME. The owner enables zero-tax FUND redemption and removes all unused payout limits and surplus allowances. Holders redeem a proportional share of remaining cash after expenses; this is not a guarantee of the original subscription amount.

On a completed sale, verified net proceeds enter FH-FUND through `addToBalanceOf`, avoiding new FUND issuance. The owner again clears unused payout limits and allowances and enables zero-tax redemption. Current FUND holders, including the operator, redeem FUND to share sale cash once. In the optional staking comparison, stakers first unstick SHARE into FUND; already-earned Sticky claims remain separate and pending rewards can vest after unstaking. The sale view does not advance time to claim them. Existing INCOME tokens and revenue-token loans remain separate in both modes. Zero cash-out tax does not eliminate every protocol fee, and neither gross asset value nor a listed sale price is spendable cash.

Relevant local source: `JBController.queueRulesetsOf` (owner changes), `JBController.mintTokensOf` (mint permissions), `JBTerminalStore._tokenSurplusFrom` (payout reservations), `JBMultiTerminal.addToBalanceOf` (no new tokens), `JBMultiTerminal._cashOutTokensOf` (burn and fees), `JBStickyDeployer` (separate staking project), and `JBTokenDistributor` (reward routing and materialized vesting).
