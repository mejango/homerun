# INCOME integration

Creating a Homerun project launches FUND only. After a successful purchase and the operator FUND allocation, a separate transaction launches the INCOME revnet. Wallet connection, SDK builders, mandatory transaction review, simulation, signing, and receipt/Safe execution handling use the reference clients' stack.

## Initial allocation includes every snapshot holder

The initial 500,000 INCOME is allocated proportionally to a fixed FUND ownership snapshot, including inactive ERC-20 balances, unclaimed credits, and operator FUND. Claiming requires no FUND deposit, delegation, burn, vesting period, or continuing FUND balance. A later FUND transfer does not move this one-time entitlement.

`fund-global-snapshot.ts` reconstructs the historical reciprocal Sucker graph and pins a finalized block on every chain. Local event discovery reconciles combined credit and ERC-20 ownership; bridge reconstruction reconciles complete outbox trees, destination claims and emergency settlements. Live FUND remains assigned to its current chain. Unsettled bridge rights are assigned to the destination beneficiary on the destination chain, preserving contract-wallet claim identity. The global denominator includes both live supply and unsettled rights without counting settled bridge claims twice.

`fund-global-manifest.ts` publishes the complete source report, every positive entitlement, exact INCOME allocation, proof, chain/project/block identity, and bridge evidence. Allocations use one global integer floor division across 500,000 INCOME; the lowest (chain ID, address) receives the remainder. Claims remain on each entitlement’s chain; identical addresses on different chains are distinct beneficiaries. Every graph chain is included, even when its local allocation is zero. Positive zero-address credits remain in the denominator and their allocation is permanently unclaimable. Holders whose allocation rounds to zero remain in the manifest. There is no 200-holder limit.

The managed Sticky project must be created after this initial snapshot. Pre-existing custody requires explicit beneficial-ownership reconciliation; a raw terminal balance must not be represented as a verified allocation to its underlying users. Direct token donations to a terminal are not by themselves proof of managed custody. The deployment attestation must disclose any unresolved wrappers or custodians.

## Root trust boundary

The root uses OpenZeppelin-compatible sorted Merkle proofs and double-hashed leaves:

```
distributionId = keccak256(abi.encode(
  TYPEHASH, destinationChainId, helper, fundProjectId,
  sourceSetHash, totalFundSupply, launchSalt
))
leaf = keccak256(bytes.concat(keccak256(abi.encode(
  distributionId, index, beneficiary, fundBalance, incomeAmount
))))
```

`TYPEHASH` is the hash of `HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,bytes32 sourceSetHash,uint256 totalFundSupply,bytes32 salt)`. `sourceSetHash` hashes the canonical full global snapshot report; `totalFundSupply` is the global denominator. The helper's permanent local FUND→INCOME→vault binding associates this launch domain with the actual resulting INCOME ID without guessing the next project ID.

**The root is an operator attestation.** Membership proofs do not prove that the root includes every holder, uses truthful historical balances, follows the intended proportions, or sums to 500,000. A bad root can exclude holders permanently, over-allocate a claimant and exhaust the pool, or strand tokens. The public generator and independent reconstruction verify those properties offchain; transaction review must explicitly distinguish that verification from an onchain completeness proof. The manifest's exact canonical JSON bytes are committed by hash and published at the immutable IPFS URI so anyone can regenerate proofs.

Recent snapshot block hashes are checked inside the launch transaction. On Arbitrum One and Arbitrum Sepolia, the helper uses canonical `ArbSys` at address `0x64` for the L2 block number and hash, matching the RPC snapshot domain; ordinary `block.number` there is an L1-origin height. Other supported chains use the normal EVM opcodes. After the 256-block history expires, the helper accepts the explicitly attested historical hash so delayed Safe execution need not change entitlements. Client preparation still requires a finalized source block, independent historical reconstruction, and final source/observation hash checks.

## Local atomic launch and perpetual claims

Canonical `REVDeployer.deployFor` records initial auto-issuance entitlements without minting them. Pending entitlements are absent from loan and cash-out supply calculations. The helper consumes all local initial issuance before returning. Cross-chain deployment remains asynchronous, as in stock Revnet Money: unlaunched chains and unreported remote issuance do not enter the circulating supply denominator merely because their auto-issuance appears in the common configuration. Payments are available after each local launch; no custom all-chain quorum is introduced.

`HomerunIncomeDeployer` performs the following in one non-reentrant transaction:

1. Require the actual FUND NFT owner, correct creation fee, closed FUND (plain core or its verified empty canonical omnichain hook), finished owner minting, no pending reserved tokens or future rulesets, and the canonical FUND ERC-20.
2. Verify the factory-owned, zero-tax Sticky project accepts that FUND and its SHARE token matches the canonical factory, hook, token registry and terminal.
3. Deploy INCOME through the six-argument canonical REVDeployer overload with the identical ordered global auto-issuance list on every chain. Counts sum to 500,000 and each beneficiary is the same deterministic helper address; stock REV records only the current chain’s count.
4. Resolve the first queued stage ID and execute `REVOwner.autoIssueFor`, verifying the complete local allocation exists as ERC-20 tokens and no local initial or reserved issuance remains pending. A zero-allocation chain skips minting. Late launches use the original stage ID even after the final stage has begun.
5. Deploy `HomerunInitialIncomeVault` with immutable actual INCOME identity, snapshot/domain/root, manifest commitment and factory; transfer the complete local allocation into it. Verify exact vault funding and zero helper residue before returning.
6. Verify canonical INCOME ownership/operator identity and record the permanent FUND→INCOME and FUND→vault mappings. A reserved mapping value prevents duplicate launch and reentry during external calls.

The helper acquires no project ownership or persistent operator permission. The vault has no owner, sweep, root replacement, approval, arbitrary-call method, or expiry. Anyone can submit a proof, but payment always goes to its encoded beneficiary. Bitmap tracking, an immutable local payout cap, checks-effects-interactions and reentrancy protection prevent repeated or redirected claims. Invalid zero-address/zero-amount claims leave those allocations untouched. Claims transfer already minted INCOME, preserving supply throughout the lifecycle. A zero-allocation chain still has a verified zero-cap vault; positive FUND dust that rounds to zero INCOME remains unclaimable. Beneficial custody ownership uses exact rational FUND weights in the committed manifest before INCOME allocation: a holder with less than one FUND atom may have a zero integer `fundBalance` display projection and still claim a positive INCOME amount. The vault verifies that committed leaf without rounding away the allocation. The sum of all local caps is exactly 500,000 at launch.

The helper constructor receives the same ordered per-chain dependency array everywhere and selects the local dependencies into immutable fields. Identical initcode, constructor calldata, salt and the canonical CREATE2 factory produce the same helper address across chains, which stock REV requires for matching token and Sucker addresses. The public `PROTOCOL_CONFIG_HASH` binds this deployment profile. The effective REV description salt commits the user launch salt, global source hash, global denominator, manifest hash and ordered chain allocations. The fixed absolute start, decay stages and all nonzero global auto-issuances then enter the stock REV configuration hash.

Each chain receives the SDK’s USDC/CCIP default-peer configuration with the same Sucker salt. Cash-outs use global accounting and every stage keeps the stock Sucker-deployment bit enabled. A past common start triggers the stock seven-day local cash-out/loan delay; it does not pause payments or replace asynchronous bridge accounting. Later-chain preparation checks any already-bound sibling’s actual configuration hash and locked split weights before offering another transaction.

## Stock Sticky ongoing rewards

The selected ongoing integration is stock Sticky. Each chain’s reserved INCOME rewards that chain’s Sticky SHARE snapshots; this is not a cross-chain aggregate staking-weight oracle. It issues separate SHARE tokens backed by deposited FUND. SHARE voting weight is automatically self-delegated, and rewards use SHARE ownership at the distributor's recorded snapshot. **There is no minimum stake-age requirement or age multiplier.** Four weeks of reward vesting must not be described as four weeks of required staking.

The verified release policy is 604,800-second rounds, four vesting rounds, and a 94,608,000-second claim window. The helper constructor and launch preparation enforce those values. `beginVesting` materializes eligible historical rewards; each weekly transition unlocks a quarter, and `collectVestedRewards` delivers unlocked INCOME. Activation after a particular reward snapshot is not retroactive. Already-earned rewards remain separate from later FUND withdrawal.

The stock release uses zero REVLoans/REVOwner distributor parameters, disabling loans against uncollected rewards. New launches require both dependencies to be zero and a valid distributor starting timestamp. Existing holder readers can also recognize the canonical loan pair for older compatible reward programs; mixed or foreign pairs are rejected. Ordinary INCOME loans remain available after the holder directly owns INCOME tokens. Initial vault claims are perpetual, independently of the ongoing distributor's claim window.

## Issuance and routing

Default new issuance is 70% operator, 10% Sticky SHARE holders, and 20% payer beneficiary. The reserved bucket is 80%; its internal weights are 875,000,000 and 125,000,000 out of 1,000,000,000. The reward row uses `hook = JBTokenDistributor`, `beneficiary = verified SHARE ERC-20`, and project ID zero. Neither raw FUND nor the Sticky hook is that beneficiary. User-selected allocations remain supported, including an explicit zero-customer share that payment review discloses.

Both reserved split rows are locked through `type(uint48).max` in every stage. This preserves both recipients even if the operator role later changes. A successful parent payment alone does not prove its reserved reward hook delivered tokens; actual balances/distributor funding must be checked.

Issuance starts at 10 INCOME/USD and declines 5% every 7,884,000 seconds (91.25 days). After eight quarters, exactly 730 days, the second immutable stage inherits the rate and stops further cuts. Cash-out tax is zero, while protocol/hook fees can still apply. USDC accounting uses six decimals and token-keyed currency; USD denomination uses currency ID 2. The empty store uses six price decimals and restricted operator store permissions, matching Revnet Money's deployment path.

## Holder operations and verification

`/income/[chainId]/[projectId]` exposes protected payments and cash-outs, ERC-20/credit transfers, credit claiming, voluntary burns, borrowing, full/partial repayment, excess-collateral refinancing, loan NFT transfer, scheduled auto-issuance collection and permissionless reserved-token distribution. Initial claim and Sticky components derive their relationship from verified helper events, immutable vault bindings and canonical token wiring. Current reserved splits describe ongoing funding; changed funding does not remove access to the original pool or earned claims. Metadata cannot establish these relationships.

Reads are pinned to a mined block and reject chain, identity or reorganization mismatches. New writes reverify state and pass mandatory review and simulation. Safe proposals remain pending until execution. Background read failures and wallet changes disable new actions while preserving existing receipt watchers. Perpetual initial claims rely on current immutable vault commitments, without making old archive RPC availability an additional claiming requirement.

## Verification and deployment status

The actual-protocol tests instantiate Juicebox, REVDeployer/REVOwner/REVLoans, the 721 infrastructure, Suckers, canonical Sticky and the distributor locally. They exercise exact supply materialization, inactive/credit-holder claims, post-snapshot FUND transfers, payments and reserved routing, stock vesting, locked splits and rollback. A 204-holder snapshot launches and all allocations claim; holder enumeration occurs outside the launch transaction.

The helper and vault are new, unaudited integration contracts, not verified production deployments. Installed SDK records do not yet contain verified Homerun helper, Sticky and distributor deployments for this flow. Simulation/test artifacts are not production deployment evidence. Source review, verification and registry publication remain prerequisites; no agent wallet has deployed these contracts or moved user funds.

The same composition supports one or multiple chains, with exactly one linked FUND project per chain. Complete source history, immutable global manifests, canonical deployment registration, and reviewed local Sticky setup are required. Missing RPC history, ambiguous per-chain project identities or unresolved custody must remain explicit blockers rather than silently reducing the allocation scope. Actual-protocol tests compare identical REV hashes, token addresses and reciprocal CCIP peers across delayed chains, including a launch after the eight-quarter boundary.
