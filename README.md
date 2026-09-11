# Homerun

Fund and earn together.

Homerun combines an asset-funding **FUND** Juicebox with a separate **INCOME** Revnet. This checkout contains the native Next.js application, live FUND transaction integration, and an illustrative Founder Haus simulator. The deployment configuration targets Railway and `homerun.money`; implementation and local verification do not mean this revision has been deployed there.

## Application status

The application uses Next.js/React, Wagmi/Viem, TanStack Query, the Nana SDK deployment registry, Juicebox Center RPC/pinning services, and the shared wallet and mandatory transaction-review runtime from Juicebox Money. The comparison with Juicebox Money and Revnet Money, including remaining configuration and indexer requirements, is recorded in [ARCHITECTURE_PARITY.md](docs/ARCHITECTURE_PARITY.md). Matching the stack alone does not establish complete feature or reliability parity.

- **`/create`** prepares and deploys only the initial FUND Juicebox. It does not deploy INCOME, issue the operator's success allocation, or grant asset withdrawals. A linked launch reviews and confirms each selected chain separately.
- **`/project/<chainId>/<projectId>`** reads live project ownership, permissions, rulesets, treasury accounting and holder balances. Supported FUND actions include payments, credit/ERC20 transfers and claims, cash-outs, campaign rule changes, success minting, explicit withdrawal allowances, and balance deposits for refunds or asset-sale proceeds. Availability depends on fresh contract state and permissions.
- **`/founderhaus`** is an illustrative model. Its payment and owner dialogs never submit transactions. Historical **`/project?id=<UUID>`** links remain browser-local previews, not shared deployed projects.
- **`/projects`** finds indexed projects you own and tokens you hold, with search across standard Juiceboxes and Revnets. Project pages show indexed activity independently of their current contract reads.
- **INCOME** uses a finalized, published global FUND snapshot, one initial-claim vault per chain, and stock Sticky for ongoing rewards. The snapshot includes linked-chain ownership and unsettled bridge claims. Each chain separately confirms its local share of the global allocation. The native launch and holder controls require verified deployments in the Nana registry. Existing canonical INCOME operations are accessible at `/income/<chainId>/<projectId>`. An INCOME URL or metadata field is not deployment evidence.

[TRANSACTIONS.md](docs/TRANSACTIONS.md) describes each contract operation, required evidence, recovery behavior and current boundary. Writes pass through review, account/chain checks, fresh prerequisites, simulation and wallet signing. A submitted hash or Safe proposal remains pending until actual execution and its receipt are verified. Local storage preserves drafts and recovery records; it cannot prove a transaction or project outcome.

## Project navigation

The demo and live project pages share the Juicebox-style layout: a large project logo beside the title and pip-separated **Key: Value** metadata, Pay and Activity on the left, and **Overview, Stages, Owners, Shop** on the right. **Extras** and **Operators** are in the vertical three-dot menu after Shop. Header figures follow the demo stage or verified live treasury and token supply; a payment draft does not change project totals. On phones, Activity becomes a tab. Actions appear within their relevant sections, with likely next steps linked from Stages.

**Owners** contains Accounts, Market, Settlement, Splits and Loans. Accounts shows your position above all owners, with both sections visible. Verified linked FUND and INCOME controls appear together. Tabs mount on first use and remain mounted, so changing tabs preserves drafts and pending receipt tracking. Hash links such as `/founderhaus#owners/accounts/all` support direct navigation and browser history.

**Stages** keeps the demo's modeling inputs, journey, history and future projections together. Live stages display confirmed rulesets and published plans without treating paused payments as proof of a purchase or sale. **Shop** reads verified inventory and customers; checkout currently opens the corresponding Juicebox shop. **Extras** lists stock payer addresses and provides reviewed payer creation. The demo uses explicitly modeled milestones and has no real payer addresses.

The demo **Shop** includes a Juicebox-style item editor with media, pricing, supply, discounts, categories, sale splits, reserves, voting power and item rules. Items are reviewed before being saved locally and can be edited or removed. Drafts are isolated by project and cleared by **Reset example**. This editor does not publish items, pin media, or send contract transactions; the live shop remains separate.

## FUND and INCOME

The [current design](docs/NETWORK_DESIGN.md) gives FUND and INCOME separate continuing rights. The corporation owns the asset and the owner-controlled FUND Juicebox. Every FUND token participates equally in eventual net asset-sale proceeds. INCOME participates in the separate revenue pool. Cashing out or borrowing against INCOME does not surrender FUND.

The creation defaults model a $500,000 asset and $100,000 operating reserve. Including an assumed 2.5% outbound fee gives a $615,384.62 gross raise goal. Monthly revenue starts at $10,000 and expenses at $6,000. Blue modeling inputs are estimates: asset price and cash reserve do **not** automatically create payout limits or withdrawal allowances.

Initial FUND accepts USDC, issues 10,000 FUND per USD, uses a 10% fundraising cash-out tax, and starts with owner minting disabled, zero reserved issuance and no withdrawal allowances. After a successful purchase, the proposed operator allocation is 20% of post-mint FUND supply; contributors retain 80%. The operator must separately review the permitted rule changes and actual mint amounts. Owner-controlled future rulesets remain mutable; a queued transaction does not prove an off-chain purchase or legal outcome.

Off-chain contributions stay settled off-chain. Mint their FUND only after success; refund failed off-chain contributions off-chain. On-chain failure refunds share the actual remaining treasury. Returned money and asset-sale proceeds enter through `addToBalanceOf`, which adds backing without issuing new FUND. Expenses and protocol fees can reduce recovery.

The initial allocation is **500,000 INCOME globally** for every FUND holder at fixed, finalized source blocks, including inactive ERC20 balances, unclaimed credits, unsettled bridge entitlements and the completed operator allocation. Existing balances claim on their recorded chain; unsettled bridge rights claim at their destination. Canonical Sticky custody is traced to its SHARE holders, preserving exact fractional ownership until the final INCOME allocation. Each chain atomically mints its portion into an immutable claim vault before local activity. Linked launches follow stock asynchronous deployment: other chains can finish later, and cross-chain supply updates arrive separately. Initial claims require no staking, activation or vesting, never expire, and always deliver to the snapshot beneficiary. The published Merkle root is an operator attestation: the site independently reconciles canonical ownership and total supply, while the contract verifies membership under that immutable commitment. Holder enumeration happens offchain, so fragmented holdings cannot exceed a launch transaction holder limit. Arbitrary custody wrappers require separate beneficial-owner reconciliation; historical graphs containing multiple FUND projects on one chain are explicitly unsupported. See [INCOME_INTEGRATION.md](docs/INCOME_INTEGRATION.md).

Creation defaults allocate **70% of new INCOME to operators, 10% to FUND stakers and 20% to customers**. Issuance starts at 10 INCOME per USD, falls 5% every quarter for eight quarters, then stays fixed. These percentages divide new tokens, not cash. The retained Founder Haus demo uses its earlier 75% / 15% / 10% comparison. The projection pays expenses from the reserve first, then operator INCOME cash-outs; it does not simulate operator loans.

**Ongoing rewards use stock Sticky.** A holder claims FUND credits as wallet tokens, stakes FUND, and receives Sticky SHARE. Historical SHARE balances divide each reward round proportionally on the chain receiving that revenue; stock pools do not combine stake weights across chains. There is no minimum staking period or age multiplier; participating longer can earn more rounds. Claimed ongoing rewards vest across four weekly round transitions, independently of the perpetual initial allocation. The selected Sticky profile has zero FUND cash-out tax. Unstake SHARE to recover FUND before exercising an asset-sale claim. See [STICKY_REWARDS.md](docs/STICKY_REWARDS.md) for exact timing, expiry and release verification.

The asset's appraised value is not spendable INCOME backing. Borrowing and cash-out estimates are alternative uses of the same tokens. At sale, net proceeds and unused reserve belong to FUND, while INCOME backing and loan obligations remain separate. Neither token promises repayment or a fixed payoff date. See [NETWORK_DESIGN.md](docs/NETWORK_DESIGN.md) and [OWNER_ACTIONS.md](docs/OWNER_ACTIONS.md) for the economic assumptions and lifecycle decisions.

## Run locally

Use Node **24.1 or newer** and npm **11 or newer**. The Dockerfile uses Node 26.7.

```sh
npm ci
npm run dev
```

Open [localhost:3010](http://localhost:3010), [Create](http://localhost:3010/create), or the [Founder Haus demo](http://localhost:3010/founderhaus). Next renders the demo body on the server; React owns its controls, gallery and SVG charts. The homepage retains the canvas ballpark, Shapes/Acid color modes, reduced-motion support and pause controls.

Juicebox Center must allow the application's actual origin. The configured development origins are `http://localhost:3010` and `http://localhost:3014`; production configuration uses `https://homerun.money`. Set `NEXT_PUBLIC_SITE_URL` when changing the local origin and, if needed, `NEXT_PUBLIC_JBCENTER_URL` for the corresponding Center service. WalletConnect requires `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID`; Para requires its public application configuration, including `NEXT_PUBLIC_PARA_API_KEY`. Those optional integrations do not replace the injected-wallet path.

The Create form saves a browser draft and distinguishes editable assumptions from proposed contract settings. A prepared deployment pins metadata, freezes the launch inputs and saves a resumable per-chain journal before submission. Ethereum, Optimism, Base and Arbitrum are selected by default, with their Sepolia counterparts available for testing. One operator address is entered in the UI, while FUND ownership and any later INCOME operator permissions remain distinct contract roles.

The demo's blue controls change fundraising, failure, income and sale scenarios. Its Pay panel preserves the original FUND contribution when modeling a separate INCOME payment. ETH input uses a labeled fixed conversion rate only in that illustration. Downloads retain the current assumptions, and **Use on your site** supplies an AI integration brief with the current configuration. Founder Haus photographs and venue descriptions are documented in [FOUNDER_HAUS_SOURCES.md](docs/FOUNDER_HAUS_SOURCES.md); the financial figures are assumptions.

## Checks

```sh
npm run check
```

`check` runs lint, the retained model/unit tests, live integration tests, the Next production build, and Foundry contract tests. The individual commands are:

| Command | Scope |
| --- | --- |
| `npm run lint` | Application and script linting |
| `npm run typecheck` | TypeScript checking without emission |
| `npm test` | Financial models and retained JavaScript unit tests |
| `npm run test:live` | Vitest tests for contract builders/reads, launch recovery, metadata boundaries and wallet/review behavior |
| `npm run build` | Stage public assets and build the Next standalone application |
| `npm run test:contracts` | Foundry tests for the Solidity compositions and earlier reference vault |
| `npm run test:browser` | Native project/demo behavior, lifecycle calculations, dialogs, local previews and mobile layouts |
| `npm run test:create` | Native Create flow, draft persistence, review and responsive layouts |
| `npm run test:a11y` | Automated accessibility checks across the rendered flows |

Start the app before browser checks. `BASE_URL`, `PLAYWRIGHT_MODULE`, `CHROME_PATH` and `BROWSER_SCREENSHOT_DIR` override their defaults. The existing workspace Playwright installation and macOS Chrome are used by default. Foundry uses Solidity 0.8.28 and sibling workspace dependencies listed in [foundry.toml](foundry.toml). Automated accessibility checks are limited evidence, not a certification.

[FUND_FORK_VERIFICATION.md](docs/FUND_FORK_VERIFICATION.md) records **29 successful local transactions** against an Ethereum fork: launch, payment, campaign changes, explicit asset withdrawals, success minting, token operations, sale distribution and a separate failure/refund branch. It includes reproducible commands and the guarded local-only write endpoint. That result does not establish browser-wallet, Safe, cross-chain, INCOME or distributor correctness, and no transactions from that run were sent to Ethereum.

## Implementation map

| Path | Responsibility |
| --- | --- |
| [src/app](src/app) | Native Next routes, layout and metadata |
| [src/providers](src/providers), [src/hooks/useSafeTx.ts](src/hooks/useSafeTx.ts), [src/components/TransactionReviewProvider.tsx](src/components/TransactionReviewProvider.tsx) | Shared wallet connections, query lifecycle and reviewed transaction boundary |
| [src/components/LiveCreate.tsx](src/components/LiveCreate.tsx), [src/lib/fund-launch-session.ts](src/lib/fund-launch-session.ts), [src/lib/fund-launch-verification.ts](src/lib/fund-launch-verification.ts) | Initial FUND launch, persisted recovery and receipt/postcondition verification |
| [src/components/FundProject.tsx](src/components/FundProject.tsx), [src/components/FundOperatorActions.tsx](src/components/FundOperatorActions.tsx), [src/lib/fund-state.ts](src/lib/fund-state.ts), [src/lib/fund-contracts.ts](src/lib/fund-contracts.ts) | Live FUND reads and holder/operator transaction preparation |
| [src/components/IncomeLaunch.tsx](src/components/IncomeLaunch.tsx), [src/components/IncomeProject.tsx](src/components/IncomeProject.tsx), [src/lib/income-launch.ts](src/lib/income-launch.ts) | Gated INCOME composition and contract-based INCOME interfaces |
| [src/HomerunIncomeDeployer.sol](src/HomerunIncomeDeployer.sol), [src/HomerunInitialIncomeVault.sol](src/HomerunInitialIncomeVault.sol) | Atomic initial INCOME prefunding, immutable per-holder claims, and canonical stock Sticky routing |
| [src/components/InitialIncomeClaim.tsx](src/components/InitialIncomeClaim.tsx), [src/components/StickyHolder.tsx](src/components/StickyHolder.tsx), [src/lib/fund-global-snapshot.ts](src/lib/fund-global-snapshot.ts), [src/lib/fund-global-manifest.ts](src/lib/fund-global-manifest.ts) | Linked-chain snapshot reconciliation, fixed-beneficiary initial claims, and stock Sticky holder operations |
| [src/components/HomePage.tsx](src/components/HomePage.tsx), [src/components/ProjectPage.tsx](src/components/ProjectPage.tsx), [src/components/ProjectCharts.tsx](src/components/ProjectCharts.tsx), [src/components/CreateFlow.tsx](src/components/CreateFlow.tsx) | Native React presentation, creation and illustrative model controls |
| [web/network-model.mjs](web/network-model.mjs), [web/create-model.mjs](web/create-model.mjs), [web/owner-actions.mjs](web/owner-actions.mjs) | Reused pure financial calculations, local draft normalization and non-executable demo owner drafts |
| [web](web) | Retained styles, assets and pure rendering/model helpers; old HTML and imperative app entry points are comparison artifacts |
| [docs/TRANSACTIONS.md](docs/TRANSACTIONS.md), [docs/ARCHITECTURE_PARITY.md](docs/ARCHITECTURE_PARITY.md) | Contract integration status, runtime provenance and remaining verification gates |

`web/network-app.mjs` is not the active application entry point. `npm run dev:prototype` and `npm run build:prototype` retain the earlier static prototype for comparison. The older story, fixed-supply lifecycle and capped calculator modules are reference material rather than live project state.

## Earlier Rooftop reference

[src/Rooftop.sol](src/Rooftop.sol) is an earlier standalone escrow and receipt vault, **not Homerun's contract backend**. It uses nontransferable whole-unit receipts, immutable closing terms, exact subscription/refund accounting and protected backing. It has no discretionary withdrawal or independent holder burn/transfer path. Its capped redemption model is:

```text
cash-out amount = min(floor(backing × units redeemed / outstanding units), units redeemed × target)
additional backing required = max(0, outstanding units × target − backing)
```

Redemption terminates those units' future rights. Early exits can realize losses; full backing, extinguished claims and legal release are different outcomes. The attestor and off-chain proceeds recipient remain trusted, and the reference vault does not enforce asset ownership, revenue remittance or the current FUND/INCOME policy. [test/Rooftop.t.sol](test/Rooftop.t.sol) retains its invariant and fuzz tests.

[MECHANISM.md](docs/MECHANISM.md), [PLAYBOOK.md](docs/PLAYBOOK.md), [JUICEBOX_ESCROW.md](docs/JUICEBOX_ESCROW.md) and [REVNET_COMPOSITION.md](docs/REVNET_COMPOSITION.md) document earlier explorations. Adapting that capped vault would require accounting for all supply changes, withdrawal authority and actual net cash-out fees; those historical adapter constraints are not a substitute for the current Juicebox/Revnet integration.

## Build and deploy

`npm run build` creates `.next/standalone`; `npm start` runs the standalone server locally. The multi-stage [Dockerfile](Dockerfile) installs application dependencies, builds Next, and copies the standalone runtime, static chunks and public assets into the runtime image. It runs as the `node` user on `0.0.0.0:$PORT`.

[railway.json](railway.json) selects the Dockerfile and checks `/` before routing traffic. Railway supplies the runtime port; the custom domain must target that port. Deploying this web application does not deploy or enable the INCOME helper, reward distributor or earlier Rooftop vault.

The Docker build accepts the public site, Center, indexer, WalletConnect and Para variables described above as build arguments. Set them on the Railway service before building; changing `NEXT_PUBLIC_*` variables requires a new build because Next embeds them in browser JavaScript. Only public application configuration belongs in these arguments. Contract deployer keys and server API secrets are never frontend configuration.
