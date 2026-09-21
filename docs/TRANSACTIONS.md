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

Every FUND launches through `HomerunDeployer.launchFundFor`, which hardcodes the campaign rules above and forwards to the SDK omnichain deployer. The caller supplies only the owner, metadata URI, start timestamp, salt and, for linked networks, one CCIP sucker deployer per peer chain. The omnichain deployer includes its standard empty NFT hook infrastructure on every FUND and carries `HomerunAllowlistHook` as the FUND's extra pay hook; this does not create an INCOME project. The allowlist gates payment beneficiaries and starts closed. The owner's **Payment allowlist** controls (`setAllowed`, `setOpen`) are owner-only, reviewed transactions; the contribute panel tells a wallet that is not allowed before any review. Rule changes re-carry the hook so closing, minting or refund rulesets never drop the gate; cash outs are never gated. The deployer records `isFund` and emits `FundLaunched`, which is how Homerun and other Juicebox clients tell a FUND from any other project; INCOME can only attach to a FUND launched this way. Linked launches use the same frozen owner, sender, salt and metadata URI on every chain. Each chain has its own fee, review, signature and confirmation.

The journal is saved before sending and coordinated with browser Web Locks. A returned transaction hash remains pending until verified. An interrupted attempt without a hash requires wallet-history reconciliation. A successful Safe proposal lookup is followed by verification of the actual Safe execution payload and receipt. Confirmation checks the deployer's `FundLaunched` event and `isFund` record, the omnichain deployer's canonical creation and launch events, new project ownership, controller, metadata, the specific launch ruleset, accounting context and withdrawal limits.

`/create/recover` opens the saved launch without requiring the original form to be filled out. It also imports downloaded deployment records. Imported confirmations return to pending until verified from their actual receipts; a JSON file cannot prove deployment.

## FUND project actions

| Action | Contract operation | Required evidence |
| --- | --- | --- |
| Contribute | exact ERC20 approval, then terminal `pay` | fresh hook-aware quote and protected minimum output; approval receipt before payment |
| Cash out, claim refunds or sale proceeds | terminal `cashOutTokensOf` | current spendable surplus, holder balance, fresh quote and minimum reclaim; a zero quote cannot enable a burn |
| Claim token credits | controller `claimTokensOf` | only for projects that ever held credits; a deployer-launched FUND has its ERC-20 from launch and never accrues credits |
| Transfer FUND | ERC20 transfer | wallet ownership and current token balance |
| Bridge FUND | exact approval, SDK prepare, source relay and destination claim | reciprocal registered peers, protected prepare quote, rebuilt Merkle proof and separately verified receipts; relay is not destination receipt |
| Voluntarily burn FUND | controller `burnTokensOf` | current holder balance and review stating no funds are returned |
| Deploy the standard FUND ERC20 | controller `deployERC20For` | never needed for a deployer-launched FUND; the control only appears for a project without a token |
| Pause or resume the campaign | queue a complete preserved ruleset | actual queue permission, no conflicting pending ruleset, supported hooks and accounting |
| Close the raise for purchase | pause payments and disable cash-outs through the ruleset | all affected peer projects identified and each change independently confirmed |
| Open refunds after failure or sale | clear withdrawal reservations/allowances and enable zero-tax cash-outs | verified active rule changes; actual returned money is a separate balance deposit |
| Return money or deposit sale proceeds | exact approval, then `addToBalanceOf` | confirmed token approval and balance addition; no new FUND minted |
| Mint offchain contribution FUND | controller `mintTokensOf`, without reserved issuance | closed campaign and explicitly enabled success minting; offchain settlement is Owner-attested |
| Issue the Owner's FUND share | controller `mintTokensOf` | verified current Owner recipient, supply/ownership calculation, and success-minting configuration; actual Owner/permission authorizes the mint, and linked in-flight bridge supply must not be guessed |
| Purchase/expense withdrawals | explicit allowance rules, then `useAllowanceOf` | separately reviewed amount and beneficiary, active allowance, treasury funds and protected minimum; model budgets never automatically grant access |

Queueing an owner action does not prove an asset purchase or legal outcome. Future ruleset permissions also mean the owner can later change monetary policy. Offchain contribution refunds remain offchain; they are not made redeemable against other holders' treasury funds by minting early FUND.

## INCOME allocation and the reserved split

The FUND Owner launches INCOME and becomes its stock Revnet control wallet (`REVConfig.operator`), while canonical `REVOwner` holds the INCOME NFT. The Owner supplies the INCOME name and ticker and the reserved percent of new issuance (0–100%). The deployer routes the entire reserved share to one unlocked split (`lockedUntil = 0`) held by the Owner, who can replace recipients or change allocations later using the stock controller's `setSplitGroupsOf`. `deployIncome` takes `(fundProjectId, snapshot, description, reservedBps, startsAtOrAfter, suckerConfiguration)` and requires `LAUNCH_VERSION() = 4` on every participating helper before freeze/preparation; INCOME only attaches to a FUND the same deployer launched.

The initial 500,000 INCOME is allocated globally across every fixed-snapshot FUND balance and unsettled bridge entitlement: ERC-20 balances and completed Owner FUND (a Homerun FUND has its token from launch, so there are no credits). Settlement requires no stake, delegation, burn, continuing FUND ownership, vesting period, or deadline. The canonical event/balance snapshots, complete Sucker trees and settlement evidence, and public global manifest reconcile supply offchain. Live balances are listed on their current chain; pending bridge beneficiaries on the destination chain. Smart-wallet addresses are never silently moved between chains. The published allocation is explicitly Owner-attested: the contract records each chain's amount for the FUND owner and commits the manifest hash; it does not establish historical balances, holder completeness, or correct per-holder amounts. A bad manifest can shortchange holders or over-allocate the pool.

`HomerunDeployer` deploys the canonical INCOME revnet and commits the same global 500,000 auto-issuance list on every chain, each row a stock revnet auto-issuance to the FUND owner (the `deployIncome` caller, who becomes INCOME's operator). The local amounts sum to 500,000. Once the shared stage has started, anyone calls `REVOwner.autoIssueFor(incomeProjectId, stageId, owner)` to mint that chain's amount to the owner, who settles the published per-holder allocation offchain. Cross-chain startup and remote accounting retain stock REV asynchronous semantics: a committed but unminted remote allocation is not circulating supply, and local payments are not held behind a custom global readiness gate. The helper records the permanent FUND→INCOME binding and retains no project ownership, tokens or permissions beyond forwarding each mint. There is no full-holder loop during launch.

Zero-address balances remain in the denominator with an unsettleable allocation, rather than blocking launch or reallocating their share. Arbitrary wrappers are not automatically unwrapped.

Ongoing holder rewards are deferred: stock Sticky is not deployed and is no longer a deployer dependency. When it exists, the Owner points part of the reserved split at it; nothing in the helper changes.

The issuance schedule is 10 INCOME/USD initially, falling 2% every 7,884,000 seconds (91.25 days) indefinitely, in one stage. These are fixed durations, not calendar-month boundaries. INCOME cash outs are taxed 10%. Both FUND and INCOME register the router terminal registry with no accounting contexts, so payers can use any token that routes to USDC. Explicit zero-reserved and fully-reserved allocations are supported; a fully reserved INCOME shows a no-INCOME payment notice.

Canonical INCOME projects are accessible at `/income/<chainId>/<projectId>`. A `?fund=<projectId>` parameter supplies a candidate relationship only; verified helper events, the launcher's FUND→INCOME binding and canonical Sticky/FUND token wiring establish the relationship. Current reserved splits determine ongoing funding; a later funding change does not remove access to an original pool or earned claims. Payments, cash-outs, token/credit operations, loans, repayments, refinancing, loan NFT transfers, auto-issuances, reserved-token distribution, minting the initial allocation to the FUND owner and verified ongoing rewards use the shared reviewed transaction flow.

Anyone can call the canonical controller’s `sendReservedTokensToSplitsOf` through **Distribute reserved INCOME**. Review shows the current pending amount, every recipient and any owner remainder; fresh reads check these again before signing. The stock call distributes all reserves with the splits active at execution, so the amount can change before mining or Safe execution. Confirmation verifies the exact call and distribution events, reconciles split totals, and identifies hook failures or project-payment fallbacks instead of treating a successful outer transaction as proof of reward delivery. Holder vesting and collection remain separate actions.

The helper is a new, unaudited integration contract. Verified deployments and SDK registry publication remain prerequisites; metadata and simulation addresses are not authority. Linked deployments use the same deterministic helper address, common absolute stages, identical global auto-issuance list and manifest commitment, stock USDC/CCIP Sucker configurations, global cash-out accounting, and the normal Sucker extension/retry permission. A late deployment receives the stock seven-day local cash-out/loan delay. Missing or ambiguous global ownership history blocks preparation instead of silently allocating only local holders. See [INCOME_INTEGRATION.md](INCOME_INTEGRATION.md) for exact calldata, trust boundaries and validation.

## Service and validation status

Juicebox Center production commit `ebe3ca7` permits `https://homerun.money` through the same RPC, pinning and intent origin controls as Juicebox Money and Revnet Money. Development commit `32c9554` permits localhost ports 3010 and 3014 on development Center. Live origin/RPC checks passed; no server secrets were added to browser code.

`npm test` checks the retained financial models. `npm run test:live` checks the live builders, reads, recovery, metadata boundaries and shared wallet/review runtime. Browser suites cover the rendered Next pages, mobile layout, accessibility, wallet/review surfaces and persistent drafts. `scripts/check-fund-preflight.ts` checks production read-only prerequisites; with `FUND_LOCAL_FORKS=true` its guarded Anvil nodes execute test transactions locally, using simulated funds. These checks do not authorize an agent to spend real funds or substitute for a user's wallet confirmation.
