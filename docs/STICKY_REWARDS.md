# Stock Sticky rewards

**Status (September 19, 2026): deferred.** Stock Sticky is not deployed and `HomerunDeployer` v4 no longer wires it or the token distributor. INCOME launches with its whole reserved split held by the Owner; connecting Sticky later is a split change, not a helper change. The policy below is what that connection is expected to look like.

Chosen policy, September 10, 2026: use stock `Sticky` and `JBTokenDistributor` for ongoing INCOME rewards. Holders stake FUND for Sticky SHARE tokens. A funded round allocates INCOME proportionally to SHARE balances at its recorded snapshot, with four weekly vesting rounds. There is no minimum staking period or age multiplier. Streaks and deposit timestamps are informational.

## Initial allocation and ongoing rewards

| | Initial 500,000 INCOME | Ongoing INCOME rewards |
| --- | --- | --- |
| Eligibility | Global FUND ownership at the reviewed closing snapshot, including credits, undelegated ERC-20 balances, unsettled bridge rights and the completed operator allocation | Sticky SHARE ownership at each distributor snapshot on its chain |
| Custody required | None | FUND deposited into its verified Sticky project |
| Allocation | Proportional closing balances, reconciled to the full FUND supply | `floor(roundAmount × pastShareVotes / roundTotalShareVotes)` |
| Collection | Minted to the current FUND owner through the helper's permissionless `mintInitialAllocation`, then settled offchain with no vesting or deadline | Stock distributor vesting and collection |

Freeze and publish the initial ownership manifest **before creating the managed Sticky projects**. The global reader reconciles live credits/ERC20 and unsettled bridge entitlements across the complete historical FUND graph. Existing canonical Sticky pools are recursively traced to their SHARE holders, using exact rational ownership through the final INCOME allocation. Shared-terminal balances are reduced only by pool backing owned by those shares; orphaned backing and unrelated donations retain their actual terminal identity. Whole FUND-atom projections are display values, and a zero projection can still receive INCOME for an exact fractional position. The complete pool evidence is committed in the manifest. Arbitrary wrappers require separate beneficial-owner reconciliation. More than one historical FUND project on the same chain is explicitly rejected by the current composition.

Each chain's initial allocation is a stock revnet auto-issuance to the helper; anyone calls `HomerunDeployer.mintInitialAllocation` once the stage starts, which pays it to whoever owns the FUND, and the owner settles the published per-holder allocation offchain. The allocation is owner-attested: the contract does not itself prove historical ownership, manifest completeness or per-holder sums. Independently reconcile the manifest, including credits and bridge rights, before approval. The ordered per-chain allocations total exactly 500,000 INCOME globally. Other chains finish independently under stock Revnet's asynchronous deployment and supply messaging. See [`HomerunDeployer.sol`](../src/HomerunDeployer.sol) and [`income-launch.ts`](../src/lib/income-launch.ts).

## Snapshot and vesting behavior

Sticky tokens self-delegate automatically and prohibit changing delegates. Their historical active-vote total equals historical SHARE supply. Ongoing rewards therefore use the SHARE token as their stake source, not vanilla FUND or its credits. Claim FUND credits as ERC-20 tokens before staking.

When connected, the INCOME reserved split row for rewards must set **`hook = JBTokenDistributor` and `beneficiary = Sticky SHARE token`**; the Owner adds that row through the stock controller, since the v4 helper routes the whole reserved split to the Owner at launch. Sending tokens directly to the distributor does not register a reward round.

Each chain has its own Sticky project and reward pool. INCOME distributed on that chain uses that chain's SHARE snapshots. Stock Sticky does not aggregate staking weights or redistribute a revenue round across chains.

Each round has a distributor-wide snapshot block. If no snapshot exists, funding pins the current round to `block.number - 1`; permissionless `poke()` pins both the current and following rounds. A snapshot already pinned by another pool or caller is reused. First funding records that pool's denominator, and later funding in the same round uses the same snapshot and reward pot.

Buying or staking after the snapshot does not earn that round. Selling or unstaking afterward does not remove its historical entitlement. Even a short-lived position may earn a snapshot's rewards; the four-round vesting setting does not make eligibility depend on continuing to stake. Read the recorded snapshot before describing any allocation as earned. The checked distributor source governs this behavior; Sticky's README currently overstates which interactions also pin the next round.

| Verified stock release parameter | Required value |
| --- | --- |
| `ROUND_DURATION()` | `604800` seconds, seven days |
| `VESTING_ROUNDS()` | `4` |
| `CLAIM_DURATION()` | `94608000` seconds, three times 365 days |
| `REV_OWNER()` and `REV_LOANS()` | Both zero; no loans against uncollected distributor rewards |
| `STARTING_TIMESTAMP()` | Nonzero, no later than the verification block |

Current-round funding can start vesting once a later round begins. `beginVesting` materializes completed-round allocations; `collectVestedRewards` can also materialize them while collecting unlocked amounts. Materializing in round R sets release round R+4. One quarter unlocks at each following weekly boundary, so full release occurs 21–28 days after materialization, depending on its timing. This is four weekly round transitions, not an exact 28-day lock from staking or funding. Delaying materialization delays vesting.

Unmaterialized allocations expire three times 365 days after the funded round ends and may be recycled. Vesting already started retains its allocation. Completed zero-denominator rounds can also be recycled. Historical claims scan unprocessed rounds; the UI must respect reader limits and simulate claim gas rather than promise constant-cost lifetime claims. Ordinary Revnet loans on INCOME held directly remain separate from distributor vesting.

## Backing and exits

SHARE represents a proportional position in Sticky's FUND backing, not a guaranteed one-for-one redemption. Deposits use the current backing price. Donations and retained exit tax can increase backing per existing share without increasing those shares' reward weight.

Stock Sticky accepts a permanent cash-out tax and a permanent soulbound/transferable choice at launch. Homerun intends **zero Sticky cash-out tax** so using stock Sticky does not introduce another exit tax; the v4 helper no longer checks this, so it becomes a launch-time review item for the Sticky project. Read and disclose the actual share transfer mode. Zero tax gives proportional reclaim before any applicable terminal fees and rounding. Use the live terminal quote with the actual payer/holder, an exact approval and a reviewed positive minimum. Do not calculate exits from a fixed exchange rate.

There is no staking time lock. The stock supply floor rejects a burn that leaves positive global SHARE supply below `1e12` atoms; emptying the supply is permitted, subject to the usual quote and execution checks. Streak/tranche displays do not change reward weights, vesting or historical rights.

## Deployment evidence and release gates

At this audit, the installed Nana SDK `2.3.2` registry has no verified `StickyDeployer` or `JBTokenDistributor` entries. Sticky's checkout contains an ignored Base `simulation.json`, marked `kind: simulation` and `revision: unrecorded`, with these predictions:

| Contract | Unverified prediction |
| --- | --- |
| `StickyDeployer` | `0x548B27933aD9005bcc66d9A465069bc8553Fa2e2` |
| `StickyHook` | `0xe96d1eda8A34BC3054b5373757B09BEaF9608A7a` |
| `JBTokenDistributor` | `0xEDa8563977EB0857616C163b8084B3152332e6BE` |

Read-only code checks on September 10, 2026 returned `0x` for all three predictions on Ethereum, Optimism, Base, Arbitrum and their four Sepolia networks: chain IDs `1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614`. These checks establish only that those predicted addresses were undeployed, not that no historical Sticky deployment exists elsewhere. Predictions are never transaction targets.

Before enabling production:

1. Retain the reviewed compilation, exact dependency commits, executed deployment receipts and per-chain `verified.json`; publish verified addresses through the normal V6 SDK registry. Follow Sticky's [`DEPLOYMENT.md`](../../Sticky/DEPLOYMENT.md). A local rehearsal is insufficient.
2. Verify runtime code and every immutable binding against that release, including factory/hook reciprocity, canonical controller/terminal/token registry, the per-project FUND/SHARE/feed relationship, factory NFT ownership, permanent rules and zero withdrawal allowances.
3. Verify all distributor parameters above, SHARE's block-number clock and locked self-delegation, and the actual INCOME reserved split. A positive round duration alone is insufficient. Verify the initial-allocation helper independently.
4. Reconcile the public global manifest, confirm each chain's recorded auto-issuance and its mint to the FUND owner, and reject unsupported custody or historical graph shapes. Mark global launch complete only after every required execution is verified.
5. Exercise target-chain flows: credit claim, exact approval, quoted stake and exit, snapshot before/after a position change, completed-round materialization, all four vesting boundaries, expired/empty-round recycling and the initial mint to the FUND owner. Check actual receipts and resulting balances; Safe proposals stay pending until execution.
6. Keep production actions disabled when registry, identity, quote, manifest or historical-state verification is unavailable. Preserve pending transaction watchers across wallet changes and read failures.

## Sources checked

Checkout paths are relative to the V6 EVM workspace; source paths are relative to each checkout. The three protocol checkouts were clean when inspected. Homerun integration files are working-tree changes and require their own reviewed release commit.

| Checkout commit | Source paths |
| --- | --- |
| `extensions/Sticky` at `584c6322584a0c85f5fe2e32c2f572822cbb4d1d` | `src/StickyDeployer.sol`, `src/StickyHook.sol`, `src/StickyToken.sol`, `script/helpers/StickyDeployment.sol`, `DEPLOYMENT.md` |
| `nana-distributor-v6` at `79af754e642b648347aba0c7df8a3398215e74a5` | `src/JBDistributor.sol` (`_recordRewardRound`, `_ensureSnapshotBlock`, `_claimDeadlineFor`), `src/JBTokenDistributor.sol` (`processSplitWith`, `_claimPastRewards`, `_claimRewardRoundFor`, `_totalStake`), `src/libraries/JBVestingMath.sol` |
| `nana-core-v6` at `898f08b96194391d545df31a62f9d89ef6759f9a` | `src/JBMultiTerminal.sol` (`pay`, `previewPayFor`, `cashOutTokensOf`), `src/JBTokens.sol` |

This document records the selected stock policy. Earlier integration notes describing ongoing vanilla FUND activation do not describe the selected Homerun launch route.
