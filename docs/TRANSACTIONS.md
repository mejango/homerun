# Contract integration

Homerun uses the Juicebox Money wallet and transaction runtime on the same Next/React, Wagmi/Viem, TanStack Query and Nana SDK stack. The architecture comparison and narrowly scoped runtime corrections are recorded in [ARCHITECTURE_PARITY.md](ARCHITECTURE_PARITY.md).

## Sources of authority

- The live route is `/project/<chainId>/<projectId>`. The project NFT, controller, active/queued rulesets, terminal accounting, permissions, balances and receipts are contract reads.
- Metadata is pinned through Juicebox Center. Names, photographs, wallet role descriptions, budgets, planned income allocations and minimum monthly revenue with written consequences are presentation data, not permission or withdrawal authorization. Minimum revenue creates no automatic contract action.
- Local storage preserves drafts and transaction recovery records. It cannot prove project creation, success, failure, funds returned, or an executed Safe proposal.
- `useSafeTx` is the shared reviewed write boundary. Wallet review, account/chain checks, fresh prerequisite reads, exact simulation, gas estimation, signing, receipt tracking and result verification remain separate steps.

## FUND creation

Create launches only the initial FUND Juicebox. The default issuance weight is 10,000 FUND per USD. The treasury accepts USDC through the same token-keyed accounting and USD price-feed convention as Juicebox Money. Initial owner minting is off, reserved issuance is zero, cash-out tax is 10%, and no payout limits or surplus allowances are created. The owner retains the ability to queue future rulesets.

The first create tab separates the **Owner**, which controls FUND and executes program changes, from the **Operator**, which receives the INCOME token split. Deployment uses the Owner wallet. The 20% FUND success allocation is minted to the verified current FUND Owner. The Owner may then transfer those tokens at their discretion. Blank new Owner fields never inherit the Operator wallet; older drafts that omitted Owner preserve their former combined wallet.

A single-network FUND uses the SDK standard controller launch. Linked networks use the SDK omnichain deployer and supported CCIP/USDC routes. The omnichain deployer includes its standard empty NFT hook infrastructure; this does not create an INCOME project. The same frozen owner, sender, salt, metadata URI and rules are used across the linked launch. Each chain has its own fee, review, signature and confirmation.

The journal is saved before sending and coordinated with browser Web Locks. A returned transaction hash remains pending until verified. An interrupted attempt without a hash requires wallet-history reconciliation. A successful Safe proposal lookup is followed by verification of the actual Safe execution payload and receipt. Confirmation checks canonical emitters, new project ownership, controller, metadata, the specific launch ruleset, accounting context and withdrawal limits.

`/create/recover` opens the saved launch without requiring the original form to be filled out. It also imports downloaded deployment records. Imported confirmations return to pending until verified from their actual receipts; a JSON file cannot prove deployment.

## FUND project actions

| Action | Contract operation | Required evidence |
| --- | --- | --- |
| Contribute | exact ERC20 approval, then terminal `pay` | fresh hook-aware quote and protected minimum output; approval receipt before payment |
| Cash out, claim refunds or sale proceeds | terminal `cashOutTokensOf` | current spendable surplus, holder balance, fresh quote and minimum reclaim; a zero quote cannot enable a burn |
| Claim token credits | controller `claimTokensOf` | deployed FUND ERC20 and current credit balance |
| Transfer FUND | ERC20 transfer or credit transfer | wallet ownership and current token/credit balance |
| Bridge FUND | exact approval, SDK prepare, source relay and destination claim | reciprocal registered peers, protected prepare quote, rebuilt Merkle proof and separately verified receipts; relay is not destination receipt |
| Voluntarily burn FUND | controller `burnTokensOf` | current holder balance and review stating no funds are returned |
| Deploy the standard FUND ERC20 | controller `deployERC20For` | current owner/permission and no existing token |
| Pause or resume the campaign | queue a complete preserved ruleset | actual queue permission, no conflicting pending ruleset, supported hooks and accounting |
| Close the raise for purchase | pause payments and disable cash-outs through the ruleset | all affected peer projects identified and each change independently confirmed |
| Open refunds after failure or sale | clear withdrawal reservations/allowances and enable zero-tax cash-outs | verified active rule changes; actual returned money is a separate balance deposit |
| Return money or deposit sale proceeds | exact approval, then `addToBalanceOf` | confirmed token approval and balance addition; no new FUND minted |
| Mint offchain contribution FUND | controller `mintTokensOf`, without reserved issuance | closed campaign and explicitly enabled success minting; offchain settlement is Owner-attested |
| Issue the Owner's FUND share | controller `mintTokensOf` | verified current Owner recipient, supply/ownership calculation, and success-minting configuration; actual Owner/permission authorizes the mint, and linked in-flight bridge supply must not be guessed |
| Purchase/expense withdrawals | explicit allowance rules, then `useAllowanceOf` | separately reviewed amount and beneficiary, active allowance, treasury funds and protected minimum; model budgets never automatically grant access |

Queueing an owner action does not prove an asset purchase or legal outcome. Future ruleset permissions also mean the owner can later change monetary policy. Offchain contribution refunds remain offchain; they are not made redeemable against other holders' treasury funds by minting early FUND.

## INCOME allocation and stock Sticky rewards

The FUND Owner launches INCOME and becomes its stock Revnet control wallet (`REVConfig.operator`), while canonical `REVOwner` holds the INCOME NFT. The separate Homerun Operator receives the INCOME incentive split. New launches leave all split rows unlocked (`lockedUntil = 0`). The Owner can replace recipients or change allocations using the stock controller’s `setSplitGroupsOf`. `deployIncome` now appends that address as its ninth argument, and new plans require `LAUNCH_VERSION() = 2` on every participating helper before freeze/preparation. An existing eight-argument pending or executed record remains recoverable with its original calldata. A legacy frozen plan without a separate recipient retains its original local-owner incentive semantics; recovery never rewrites the recipient from current form values.

The initial 500,000 INCOME is allocated globally across every fixed-snapshot FUND balance and unsettled bridge entitlement: inactive ERC-20s, unclaimed credits, and completed Owner FUND. Claims require no stake, delegation, burn, continuing FUND ownership, vesting period, or deadline. The canonical event/balance snapshots, complete Sucker trees and settlement evidence, and public global manifest reconcile supply offchain. Live balances claim on their current chain; pending bridge beneficiaries claim on the destination chain. Smart-wallet addresses are never silently moved between chains. Its immutable Merkle root is explicitly Owner-attested: an inclusion proof does not cryptographically establish historical balances, holder completeness, or correct total allocations. Bad roots can permanently exclude holders, over-allocate the pool, or strand tokens.

`HomerunIncomeDeployer` deploys the canonical INCOME revnet, commits the same global 500,000 auto-issuance list on every chain, materializes that chain’s full local allocation, deploys an immutable `HomerunInitialIncomeVault`, and funds it in one local transaction. Zero-allocation chains receive zero-cap vaults. The local caps sum to 500,000. This closes the local gap between REV launch and `autoIssueFor`. Cross-chain startup and remote accounting retain stock REV asynchronous semantics: a committed but unminted remote allocation is not circulating supply, and local payments are not held behind a custom global readiness gate. The helper records permanent FUND→INCOME/vault bindings and retains no project ownership or tokens. The vault uses standard OpenZeppelin Merkle proofs, fixed leaf beneficiaries, bitmap replay protection and an immutable local cap; it has no administrator, sweep, root update, expiry or discretionary recipient. There is no full-holder loop during launch: an actual 204-holder test launches and every allocation claims.

Initial snapshot generation precedes managed Sticky creation. Existing canonical Sticky pools are reconciled to their SHARE holders with exact fractional weights, including nested pools; orphaned backing and raw donations retain their actual holder identity. Arbitrary wrappers are not automatically unwrapped. Zero-address credits remain in the denominator with an unclaimable allocation, rather than blocking launch or reallocating their share.

Ongoing rewards from INCOME issued on each chain use **that chain’s stock Sticky SHARE snapshots**, with automatic self-delegation and four weekly vesting rounds. There is no minimum stake-age requirement or age multiplier. The verified policy uses 604,800-second rounds, four vesting rounds, and a 94,608,000-second claim window; this ongoing window does not limit initial vault claims. FUND can be recovered through the verified zero-tax Sticky cash-out route, while already-earned reward claims remain separate.

The issuance schedule is 10 INCOME/USD initially, falling 5% every 7,884,000 seconds (91.25 days) for eight cuts over 730 days, then fixed. These are fixed durations, not calendar-month boundaries. The default 80% reserve divides 70/80 to operations and 10/80 to `JBTokenDistributor` with the verified Sticky SHARE token as beneficiary; customers receive 20% of total issuance. Every split row uses `lockedUntil = 0` in every stage. The Owner can change the recipients and allocations. Explicit zero-customer allocations are supported with a no-INCOME payment notice.

Canonical INCOME projects are accessible at `/income/<chainId>/<projectId>`. A `?fund=<projectId>` parameter supplies a candidate relationship only; verified helper events, immutable vault bindings and canonical Sticky/FUND token wiring establish the relationship. Current reserved splits determine ongoing funding; a later funding change does not remove access to an original pool or earned claims. Payments, cash-outs, token/credit operations, loans, repayments, refinancing, loan NFT transfers, auto-issuances, reserved-token distribution, initial claims and verified ongoing rewards use the shared reviewed transaction flow.

Anyone can call the canonical controller’s `sendReservedTokensToSplitsOf` through **Distribute reserved INCOME**. Review shows the current pending amount, every recipient and any owner remainder; fresh reads check these again before signing. The stock call distributes all reserves with the splits active at execution, so the amount can change before mining or Safe execution. Confirmation verifies the exact call and distribution events, reconciles split totals, and identifies hook failures or project-payment fallbacks instead of treating a successful outer transaction as proof of reward delivery. Holder vesting and collection remain separate actions.

The helper and vault are new, unaudited integration contracts. Verified deployments and SDK registry publication remain prerequisites; metadata and simulation addresses are not authority. Linked deployments use the same deterministic helper address, common absolute stages, identical global auto-issuance list and manifest commitment, stock USDC/CCIP Sucker configurations, global cash-out accounting, and the normal Sucker extension/retry permission. A late deployment receives the stock seven-day local cash-out/loan delay. Missing or ambiguous global ownership history blocks preparation instead of silently allocating only local holders. See [INCOME_INTEGRATION.md](INCOME_INTEGRATION.md) for exact calldata, trust boundaries and validation.

## Service and validation status

Juicebox Center production commit `ebe3ca7` permits `https://homerun.money` through the same RPC, pinning and intent origin controls as Juicebox Money and Revnet Money. Development commit `32c9554` permits localhost ports 3010 and 3014 on development Center. Live origin/RPC checks passed; no server secrets were added to browser code.

`npm test` checks the retained financial models. `npm run test:live` checks the live builders, reads, recovery, metadata boundaries and shared wallet/review runtime. Browser suites cover the rendered Next pages, mobile layout, accessibility, wallet/review surfaces and persistent drafts. `scripts/check-fund-preflight.ts` checks production read-only prerequisites; with `FUND_LOCAL_FORKS=true` its guarded Anvil nodes execute test transactions locally, using simulated funds. These checks do not authorize an agent to spend real funds or substitute for a user's wallet confirmation.
