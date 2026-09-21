# INCOME integration

Creating a Homerun project launches FUND only. After a successful purchase and the Owner FUND allocation, a separate transaction launches the INCOME revnet. Wallet connection, SDK builders, mandatory transaction review, simulation, signing, and receipt/Safe execution handling use the reference clients' stack.

## Owner and Operator wallets

The **Owner** controls the FUND Juicebox and executes program changes permitted by its contracts. When that wallet launches INCOME, it becomes the stock Revnet control wallet (`REVConfig.operator`); canonical `REVOwner` holds the INCOME project NFT. The **Owner** receives the 20% FUND success allocation and may distribute those tokens to the Operator at their discretion. The **Operator** receives only the ongoing INCOME token split by virtue of that role. These wallets can match, but receiving incentives does not grant program control. Published wallet fields only prefill reviewed recipients; contract ownership and permissions authorize transactions.

`deployIncome(fundProjectId, snapshot, description, reservedBps, startsAtOrAfter, suckerConfiguration)` requires a FUND launched by the same helper; the caller must own that FUND and becomes `config.operator`. The `description` supplies the Owner-chosen INCOME name and ticker. `reservedBps` is the reserved share of new issuance; it lands in one unlocked split whose beneficiary is the caller. The Owner can replace that beneficiary or add rows at any time through the stock controller’s split-group controls. No split is locked.

Recovery accepts only this selector and preserves saved pending/executed calldata byte for byte. Authorized split changes on an already-launched sibling do not block later chains from completing the original launch plan; the reserved percent itself is part of the frozen stock identity.

Minimum revenue is a monthly USD target with written consequences, published in the project plan. It creates no automatic contract action, token penalty, withdrawal right, or change to the income projection. The Owner must execute any stated program changes within the contracts' available controls.

## Initial allocation includes every snapshot holder

The initial 500,000 INCOME is allocated proportionally to a fixed FUND ownership snapshot, including inactive ERC-20 balances and Owner FUND (a Homerun FUND has no credits). Receiving it requires no FUND deposit, delegation, burn, vesting period, or continuing FUND balance. A later FUND transfer does not move this one-time entitlement.

`fund-global-snapshot.ts` reconstructs the historical reciprocal Sucker graph and pins a finalized block on every chain. Local event discovery reconciles combined credit and ERC-20 ownership; bridge reconstruction reconciles complete outbox trees, destination claims and emergency settlements. Live FUND remains assigned to its current chain. Unsettled bridge rights are assigned to the destination beneficiary on the destination chain, preserving contract-wallet claim identity. The global denominator includes both live supply and unsettled rights without counting settled bridge claims twice.

`fund-global-manifest.ts` publishes the complete source report, every positive entitlement, exact INCOME allocation, chain/project/block identity, and bridge evidence. Allocations use one global integer floor division across 500,000 INCOME; the lowest (chain ID, address) receives the remainder. Each entitlement is settled on its own chain; identical addresses on different chains are distinct beneficiaries. Every graph chain is included, even when its local allocation is zero. Positive zero-address credits remain in the denominator and their allocation is permanently unclaimable. Holders whose allocation rounds to zero remain in the manifest. There is no 200-holder limit.

## Snapshot trust boundary

The launch commits to `sourceSetHash` (the hash of the canonical full global snapshot report), `totalFundSupply` (the global denominator), `manifestHash` and the ordered per-chain allocations through `configurationSaltFor`, which becomes the REV description salt and so part of INCOME's cross-chain identity. Only launches with the same snapshot and launch salt pair.

**The snapshot is an Owner attestation.** Nothing onchain proves that it includes every holder, uses truthful historical balances, follows the intended proportions, or names the right source blocks; the contract only checks its shape, that this chain's entry names this FUND, and that the allocations sum to 500,000. The public generator and independent reconstruction verify the rest offchain; transaction review must explicitly distinguish that verification from an onchain completeness proof. The manifest's exact canonical JSON bytes are committed by hash and published at the immutable IPFS URI so anyone can regenerate and reconcile it.

## Local launch and the initial allocation

Canonical `REVDeployer.deployFor` records initial auto-issuance entitlements without minting them. Pending entitlements are absent from loan and cash-out supply calculations until minted. Cross-chain deployment remains asynchronous, as in stock Revnet Money: unlaunched chains and unreported remote issuance do not enter the circulating supply denominator merely because their auto-issuance appears in the common configuration. Payments are available after each local launch; no custom all-chain quorum is introduced.

`HomerunDeployer.deployIncome` performs the following in one non-reentrant transaction:

1. Require a FUND launched by this deployer (`isFund`), the actual FUND NFT owner, a nonzero shared start, a snapshot whose allocations name this FUND on this chain and sum to 500,000, and the stock USDC/CCIP sucker topology for the snapshot's chains. `JBProjects` charges the creation fee out of the forwarded value and rejects a wrong amount itself. The FUND's rules are not checked onchain: close the campaign on every linked chain, let bridged FUND settle, then take the snapshot.
2. Deploy INCOME through the six-argument canonical REVDeployer overload with the identical ordered global auto-issuance list on every chain. Counts sum to 500,000 and every beneficiary is the deployer itself (the same address on every chain). The revnet's single stage starts at the shared `startsAtOrAfter`.
3. Record the permanent FUND→INCOME mapping. Stock `REVDeployer` results are trusted rather than re-asserted afterwards: REVOwner holds INCOME, the launching owner is its operator, and the stage carries this chain's allocation because the deployer passed them in. The mapping reads 0 until a FUND has INCOME and the INCOME project ID after that, so a second launch for the same FUND is refused; a `nonReentrant` guard covers the external calls in between.

Nothing is minted at launch. Once the shared stage has started, anyone calls `HomerunDeployer.mintInitialAllocation(fundProjectId)` on each chain: it runs `REVOwner.autoIssueFor` for the deployer and pays the minted amount to whoever owns the FUND at that moment (`JBProjects.ownerOf`), exactly once; the site offers this as "Mint initial INCOME to the FUND owner". The owner then settles the published per-holder allocation from their balance. This is a promise recorded in the published manifest and committed into INCOME's cross-chain identity through `configurationSaltFor`, not an onchain claim: there is no vault, Merkle root or proof. Launch the first chain with `startsAtOrAfter` a few minutes ahead so REVDeployer applies no cash out delay there; chains launched after the shared start inherit REVDeployer's standard `CASH_OUT_DELAY`.

The helper acquires no project ownership or persistent operator permission, and holds INCOME only between `autoIssueFor` and the transfer to the owner within `mintInitialAllocation`. Beneficial custody ownership uses exact rational FUND weights in the committed manifest before INCOME allocation: a holder with less than one FUND atom may have a zero integer `fundBalance` display projection and still be owed a positive INCOME amount. The sum of all chain allocations is exactly 500,000 at launch.

The helper constructor receives the same ordered per-chain dependency array everywhere and selects the local dependencies into immutable fields. Identical initcode, constructor calldata, salt and the canonical CREATE2 factory produce the same helper address across chains, which stock REV requires for matching token and Sucker addresses. That shared address is itself the commitment to the deployment profile. The effective REV description salt commits the user launch salt, global source hash, global denominator, manifest hash and ordered chain allocations. The fixed absolute start, the single stage and all nonzero global auto-issuances then enter the stock REV configuration hash.

Each chain receives the SDK’s USDC/CCIP default-peer configuration with the same Sucker salt. Cash-outs use global accounting and every stage keeps the stock Sucker-deployment bit enabled. A past common start triggers the stock seven-day local cash-out/loan delay; it does not pause payments or replace asynchronous bridge accounting. Later-chain preparation checks any already-bound sibling’s original economic configuration hash and global-allocation identity before offering another transaction. Current split recipients and weights remain mutable.

## Ongoing rewards

Ongoing holder rewards are deferred. Stock Sticky is not deployed and is no longer a helper dependency; the earlier profile (chain-local SHARE snapshots, 604,800-second rounds, four vesting rounds, 94,608,000-second claim window, zero loan dependencies) is recorded in [STICKY_REWARDS.md](STICKY_REWARDS.md) for when it is. Connecting it later is a split change by the Owner, not a helper change.

## Issuance and routing

The Owner chooses the reserved percent of new INCOME (0–100%); creation planning defaults to 80% (70% operators plus 10% stakers), leaving 20% for the payer beneficiary. The deployer writes one reserved split row with `percent = 1,000,000,000`, `beneficiary = the FUND Owner`, no hook and `lockedUntil = 0`. The Owner redirects it through the stock controller once operators, stakers or Sticky recipients exist; a successful parent payment alone does not prove any later hook delivered tokens.

Issuance starts at 10 INCOME/USD and declines 2% every 7,884,000 seconds (91.25 days) indefinitely, in a single stage. Cash-out tax is 10%, while protocol/hook fees can still apply. USDC accounting uses six decimals and token-keyed currency; the router terminal registry is registered with no contexts so payments can arrive in any token that routes to USDC. The INCOME name and ticker are Owner-supplied and frozen in the shared plan.

## Holder operations and verification

`/income/[chainId]/[projectId]` exposes protected payments and cash-outs, ERC-20 transfers, voluntary burns, borrowing, full/partial repayment, excess-collateral refinancing, loan NFT transfer, scheduled auto-issuance collection and permissionless reserved-token distribution. The initial-mint and Sticky components derive their relationship from verified helper events, the immutable FUND→INCOME binding and canonical token wiring. Current reserved splits describe ongoing funding; changed funding does not affect the initial allocation. Metadata cannot establish these relationships.

Reads are pinned to a mined block and reject chain, identity or reorganization mismatches. New writes reverify state and pass mandatory review and simulation. Safe proposals remain pending until execution. Background read failures and wallet changes disable new actions while preserving existing receipt watchers. The initial mint reads the helper's current binding and the revnet's pending auto-issuance, without making old archive RPC availability a requirement.

## Verification and deployment status

The actual-protocol tests instantiate Juicebox, REVDeployer/REVOwner/REVLoans, the router terminal registry, the 721 infrastructure and Suckers locally. They exercise exact supply materialization, minting to the current FUND owner after a post-snapshot FUND transfer, a future shared start, a stranger triggering `autoIssueFor` early, payments and reserved routing, salt scoping and rollback. Holder enumeration occurs outside the launch transaction.

The helper is a new integration contract, not a verified production deployment. Installed SDK records do not yet contain a verified Homerun helper deployment.

The same composition supports one or multiple chains, with exactly one linked FUND project per chain. Complete source history, immutable global manifests, and canonical deployment registration are required. Missing RPC history, ambiguous per-chain project identities or unresolved custody must remain explicit blockers rather than silently reducing the allocation scope. Actual-protocol tests compare identical REV hashes, token addresses and reciprocal CCIP peers across delayed chains, including a launch after the eight-quarter boundary.
