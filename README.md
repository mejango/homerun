# Homerun

Run your homes' investments and revenues.

Homerun combines an asset-funding **FUND** Juicebox with a separate **INCOME** Revnet. This checkout contains the native Next.js application, live FUND transaction integration, and an illustrative Founder Haus simulator. The deployment configuration targets Railway and `homerun.money`; implementation and local verification do not mean this revision has been deployed there.

## Application status

The application uses Next.js/React, Wagmi/Viem, TanStack Query, the Nana SDK deployment registry, Juicebox Center RPC/pinning services, and the shared wallet and mandatory transaction-review runtime from Juicebox Money. The comparison with Juicebox Money and Revnet Money, including remaining configuration and indexer requirements, is recorded in [ARCHITECTURE_PARITY.md](docs/ARCHITECTURE_PARITY.md). Matching the stack alone does not establish complete feature or reliability parity.

- **`/create`** prepares and deploys only the initial FUND Juicebox. It does not deploy INCOME, issue the Owner's success allocation, or grant asset withdrawals. A linked launch reviews and confirms each selected chain separately.
- **`/project/<chainId>/<projectId>`** reads live project ownership, permissions, rulesets, treasury accounting and holder balances. Its FUND **Pay on** dropdown resolves available chains from reciprocal registered bridges and uses each chain’s own project ID. Pay opens a modal with currency, amount, protected quote, approvals and transaction review. Incomplete peer launches do not block payments on the current chain; pending payments lock chain selection, and closing the modal preserves its amount and receipt tracking. Supported FUND actions include payments, credit/ERC20 transfers and claims, cash-outs, campaign rule changes, success minting, explicit withdrawal allowances, and balance deposits for refunds or asset-sale proceeds. Availability depends on fresh contract state and permissions.
- **`/founderhaus`** is an illustrative model. Its payment and owner dialogs never submit transactions. Historical **`/project?id=<UUID>`** links remain browser-local previews, not shared deployed projects.
- **`/projects`** finds indexed projects you own and tokens you hold, with search across standard Juiceboxes and Revnets. Project pages show indexed activity independently of their current contract reads.
- **`/account/<address>`** shows an account’s activity, project tokens, shop items, owned projects and delegated project permissions. It can be viewed without connecting a wallet and supports Mainnet/Testnet selection.
- **INCOME** uses a finalized, published global FUND snapshot; each chain records its share of the initial allocation as a stock revnet auto-issuance that anyone mints to the FUND owner, who settles it to the snapshot holders offchain. The owner names the token, sets the reserved percent, and holds that reserved split until it is redirected; ongoing holder rewards (Sticky) come later through that split. The snapshot includes linked-chain ownership and unsettled bridge claims. Each chain separately confirms its local share of the global allocation. The native launch and holder controls require verified deployments in the Nana registry. Existing canonical INCOME operations are accessible at `/income/<chainId>/<projectId>`. An INCOME URL or metadata field is not deployment evidence.

[TRANSACTIONS.md](docs/TRANSACTIONS.md) describes each contract operation, required evidence, recovery behavior and current boundary. Writes pass through review, account/chain checks, fresh prerequisites, simulation and wallet signing. A submitted hash or Safe proposal remains pending until actual execution and its receipt are verified. Local storage preserves drafts and recovery records; it cannot prove a transaction or project outcome.

## Project navigation

The connected wallet appears as a compact **Signed in** button with an ENS name or shortened address. Its menu opens **View account**, **Your projects**, **Copy address**, and **Sign out**. The account view groups activity, holdings and projects into separate tabs.

The demo and live project pages share the Juicebox-style layout: a large project logo beside the title, the location immediately below the title, and pip-separated **Key: Value** metadata, Pay and Activity on the left, and **Overview, Stages, Owners, Shop** on the right. **Extras** and **Operators** expand inline after Shop when the vertical three dots are clicked. The dots move to the end and collapse those tabs on the next click. The demo header includes a compact funding meter. Header figures follow the demo stage or verified live treasury and token supply; a payment draft does not change project totals. On phones, Activity becomes a tab. Actions appear within their relevant sections, with likely next steps linked from Stages. Demo Activity shows the latest 20 illustrative events for the selected stage and modeling inputs, without including future revenue or treating a payment draft as received money.

The demo **Fund** module shows what the payer receives and a compact ownership chart after one additional payment. INCOME previews credit only the payer’s allocation. Payment previews do not change the project’s received funding or activity history.

**Owners** contains Accounts, Market, Settlement, Splits and Loans. Accounts shows your position above all owners, with both sections visible. Verified linked FUND and INCOME controls appear together. Tabs mount on first use and remain mounted, so changing tabs preserves drafts and pending receipt tracking. Hash links such as `/founderhaus#owners/accounts/all` support direct navigation and browser history.

An **Operator** introduction follows the token representation in Overview. Create supports an operator name, introduction and optional picture; local drafts retain the profile, and published FUND metadata stores the photo on IPFS. These display fields do not grant operator permissions.

**Stages** keeps the demo's modeling inputs, journey, history and future projections together. Live stages display confirmed rulesets and published plans without treating paused payments as proof of a purchase or sale. **Shop** reads verified inventory and customers; checkout currently opens the corresponding Juicebox shop. **Extras** lists stock payer addresses and provides reviewed payer creation. The demo uses explicitly modeled milestones and has no real payer addresses.

The demo **Shop** includes a Juicebox-style item editor with media, pricing, supply, discounts, categories, sale splits, reserves, voting power and item rules. Items are reviewed before being saved locally and can be edited or removed. Each project has separate FUND (Juicebox) and INCOME (Revnet) inventories and pricing currencies. Raising, closed-raise and refund stages use FUND; earning and sold stages use INCOME. Existing saved drafts belong to FUND. Clearing a shop affects only that phase; **Reset example** clears both shops for the current project. This editor does not publish items, pin media, or send contract transactions; the live shop remains separate.

## FUND and INCOME

The [current design](docs/NETWORK_DESIGN.md) gives FUND and INCOME separate continuing rights. The corporation owns the asset and the owner-controlled FUND Juicebox. Every FUND token participates equally in eventual net asset-sale proceeds. INCOME participates in the separate revenue pool. Cashing out or borrowing against INCOME does not surrender FUND.

The creation defaults model a $500,000 asset and $100,000 operating reserve. Including an assumed 2.5% outbound fee gives a $615,384.62 gross raise goal. Monthly revenue starts at $10,000 and expenses at $6,000. Blue modeling inputs are estimates: asset price and cash reserve do **not** automatically create payout limits or withdrawal allowances.

`HomerunDeployer` launches every FUND with fixed rules: a USDC treasury that accepts any token through the router terminal registry, 10,000 FUND per USD, a 10% fundraising cash-out tax, owner minting disabled, zero reserved issuance and no withdrawal allowances. The creator names the FUND token and ticker, and the ERC-20 is deployed with the project. Every FUND carries `HomerunAllowlistHook` as its pay hook: contributions are accepted only for wallets the owner has allowed, or for anyone once the owner opens it, and a new FUND starts closed. The gate is on the beneficiary (who receives FUND), so it also holds for swap-routed payments; cash outs are never gated. The deployer records which projects are FUNDs, and INCOME can only attach to one of them. After a successful purchase, the proposed Owner allocation is 20% of post-mint FUND supply; contributors retain 80%. The Owner must separately review the permitted rule changes and actual mint amounts. Owner-controlled future rulesets remain mutable; a queued transaction does not prove an off-chain purchase or legal outcome.

Off-chain contributions stay settled off-chain. Mint their FUND only after success; refund failed off-chain contributions off-chain. On-chain failure refunds share the actual remaining treasury. Returned money and asset-sale proceeds enter through `addToBalanceOf`, which adds backing without issuing new FUND. Expenses and protocol fees can reduce recovery.

The initial allocation is **500,000 INCOME globally** for every FUND holder at fixed, finalized source blocks, including inactive ERC-20 balances, unsettled bridge entitlements and the completed Owner allocation (a Homerun FUND has its token from launch, so there are no credits). Existing balances are listed on their recorded chain; unsettled bridge rights at their destination. Each chain records its portion as a stock revnet auto-issuance held by the deployer; once INCOME's shared stage has started, anyone calls `HomerunDeployer.mintInitialAllocation`, which mints it and pays whoever owns the FUND at that moment, and the owner settles it to the snapshot holders per the published allocation. The first chain launches with the start a few minutes ahead so no revnet cash out delay applies. Linked launches follow stock asynchronous deployment: other chains can finish later, and cross-chain supply updates arrive separately. The allocation is a promise from the owner, not an onchain claim: the site independently reconciles canonical ownership and total supply, and the launch commits the manifest hash and every chain's amount into the revnet configuration. Holder enumeration happens offchain, so fragmented holdings cannot exceed a launch transaction holder limit. Arbitrary custody wrappers require separate beneficial-owner reconciliation; historical graphs containing multiple FUND projects on one chain are explicitly unsupported. See [INCOME_INTEGRATION.md](docs/INCOME_INTEGRATION.md).

Creation defaults plan **70% of new INCOME for operators, 10% for FUND stakers and 20% for customers**. At launch the deployer reserves the operator and staker share (80% by default, editable) as one unlocked split held by the owner; the owner redirects it to operators, stakers or Sticky afterwards through the stock controller. Issuance starts at 10 INCOME per USD and falls 2% every quarter indefinitely; INCOME cash outs are taxed 10%. These percentages divide new tokens, not cash. The retained Founder Haus demo uses its earlier 75% / 15% / 10% comparison. The projection pays expenses from the reserve first, then operator INCOME cash-outs; it does not simulate operator loans.

**Ongoing rewards are deferred.** Stock Sticky is not deployed yet and is no longer a deployer dependency. When it is, the owner points part of INCOME's reserved split at it; the intended profile (stake FUND for SHARE, weekly rounds, four vesting rounds, no minimum staking age) is recorded in [STICKY_REWARDS.md](docs/STICKY_REWARDS.md). The Sticky holder components remain in the codebase but are not wired to INCOME.

The asset's appraised value is not spendable INCOME backing. Borrowing and cash-out estimates are alternative uses of the same tokens. At sale, net proceeds and unused reserve belong to FUND, while INCOME backing and loan obligations remain separate. Neither token promises repayment or a fixed payoff date. See [NETWORK_DESIGN.md](docs/NETWORK_DESIGN.md) and [OWNER_ACTIONS.md](docs/OWNER_ACTIONS.md) for the economic assumptions and lifecycle decisions.

## Run locally

Use Node **24.1 or newer** and npm **11 or newer**. The Dockerfile uses Node 26.7.

```sh
npm ci
npm run dev
```

Open [localhost:3010](http://localhost:3010), [Create](http://localhost:3010/create), or the [Founder Haus demo](http://localhost:3010/founderhaus). Next renders the demo body on the server; React owns its controls, gallery and SVG charts. The logo has no tagline on any page. The homepage keeps its large centered headline, cycling from home through farms, business, equipment, energy and other assets. The canvas ballpark and rotating headline share pause controls and respect reduced motion; headline rotation also pauses offscreen and in background tabs. Shapes/Acid color modes remain available. First-time Acid selection starts intensity and color grouping at 20; subsequent visits retain the user’s Acid settings.

Juicebox Center must allow the application's actual origin. The configured development origins are `http://localhost:3010` and `http://localhost:3014`; production configuration uses `https://homerun.money`. Set `NEXT_PUBLIC_SITE_URL` when changing the local origin and, if needed, `NEXT_PUBLIC_JBCENTER_URL` for the corresponding Center service.

Copy `.env.example` to `.env.local` before starting development. Set a valid public Para application key to enable email and social sign-in. The example leaves that key empty; empty or placeholder keys use external wallets. Sign in supports email, phone, passkeys and social accounts, alongside external wallets; authenticated Para sessions restore on reload. The sheet keeps Homerun's branding. The example also includes the shared public `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` for WalletConnect. Without a configured `NEXT_PUBLIC_PARA_API_KEY`, sign-in falls back to external wallets. The Para and WalletConnect dashboards must allow the origin being used, including `https://homerun.money` for production. Use the same public wallet values as Railway build arguments and rebuild when they change.

The Create form saves a browser draft and distinguishes editable assumptions from proposed contract settings. A prepared deployment pins metadata, freezes the launch inputs and saves a resumable per-chain journal before submission. Ethereum, Optimism, Base and Arbitrum are selected by default, with their Sepolia counterparts available for testing. The first step separates the **Owner** wallet, which owns FUND and operates INCOME, from the **Operator** wallet, which receives revenue split tokens. The Owner receives the 20% FUND success allocation and may distribute those tokens at their discretion. The Owner may replace the Operator at any time by changing the INCOME split recipient. No INCOME split is locked; the Owner can also change other split recipients and allocations.

New drafts default to a 2-of-3 Owner Safe, with **Operator same as owner** checked. Unchecking it reveals a separate Operator Safe and the Operator profile fields. Each role supports 2–20 signers or an existing address through **Already have a multisig?** Legacy drafts retain their address settings. Safe construction, deterministic address prediction, deployment calls and policy verification come from `@bananapus/nana-sdk-core/safe`; Homerun retains role selection, draft salts, review and recovery. Saved plans keep their original addresses and calldata. Relayr can bundle Safe deployments before the authenticated FUND launch in one transaction per destination chain, with one funding payment; signatures and confirmations remain per chain. Connected Safe wallets retain the separate, resumable deployment step.

Income planning includes a minimum monthly revenue target and written consequences, published with the plan for the Owner to carry out. The revenue target does not automatically change contracts.

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
| `npm run test:contracts` | Foundry tests for `HomerunDeployer` and `HomerunAllowlistHook` |
| `npm run test:deployment` | Regression tests for the contract deployment scripts and runner; see [DEPLOYMENT.md](DEPLOYMENT.md) |
| `node --import tsx scripts/verify-fund-fork.mts` | Full FUND lifecycle through the deployer on a local Ethereum Anvil fork; see [docs/FUND_FORK_VERIFICATION.md](docs/FUND_FORK_VERIFICATION.md) |
| `npm run test:browser` | Native project/demo behavior, lifecycle calculations, dialogs, local previews and mobile layouts |
| `npm run test:create` | Native Create flow, draft persistence, review and responsive layouts |
| `npm run test:a11y` | Automated accessibility checks across the rendered flows |

Start the app before browser checks. `BASE_URL`, `PLAYWRIGHT_MODULE`, `CHROME_PATH` and `BROWSER_SCREENSHOT_DIR` override their defaults. The existing workspace Playwright installation and macOS Chrome are used by default. Foundry uses Solidity 0.8.28 and sibling workspace dependencies listed in [remappings.txt](remappings.txt). Automated accessibility checks are limited evidence, not a certification.

[FUND_FORK_VERIFICATION.md](docs/FUND_FORK_VERIFICATION.md) records an earlier fork run of the FUND lifecycle (29 local transactions) against the pre-deployer launch path. The current path launches through `HomerunDeployer`, which is not deployed yet; the fork script needs to deploy it locally before that run can be repeated. The production rollout is [DEPLOYMENT.md](DEPLOYMENT.md).

## Implementation map

| Path | Responsibility |
| --- | --- |
| [src/app](src/app) | Native Next routes, layout and metadata |
| [src/providers](src/providers), [src/hooks/useSafeTx.ts](src/hooks/useSafeTx.ts), [src/components/TransactionReviewProvider.tsx](src/components/TransactionReviewProvider.tsx) | Shared wallet connections, query lifecycle and reviewed transaction boundary |
| [src/components/LiveCreate.tsx](src/components/LiveCreate.tsx), [src/lib/fund-launch-session.ts](src/lib/fund-launch-session.ts), [src/lib/fund-launch-verification.ts](src/lib/fund-launch-verification.ts) | Initial FUND launch, persisted recovery and receipt/postcondition verification |
| [src/components/FundProject.tsx](src/components/FundProject.tsx), [src/components/FundOperatorActions.tsx](src/components/FundOperatorActions.tsx), [src/lib/fund-state.ts](src/lib/fund-state.ts), [src/lib/fund-contracts.ts](src/lib/fund-contracts.ts) | Live FUND reads and holder/operator transaction preparation |
| [src/components/IncomeLaunch.tsx](src/components/IncomeLaunch.tsx), [src/components/IncomeProject.tsx](src/components/IncomeProject.tsx), [src/lib/income-launch.ts](src/lib/income-launch.ts) | Gated INCOME composition and contract-based INCOME interfaces |
| [src/HomerunDeployer.sol](src/HomerunDeployer.sol), [src/HomerunAllowlistHook.sol](src/HomerunAllowlistHook.sol), [src/interfaces](src/interfaces), [src/structs](src/structs) | Fixed-rule FUND launches, the owner-managed payment allowlist, and the initial INCOME allocation recorded for the FUND owner |
| [src/components/InitialIncomeMint.tsx](src/components/InitialIncomeMint.tsx), [src/components/StickyHolder.tsx](src/components/StickyHolder.tsx), [src/lib/fund-global-snapshot.ts](src/lib/fund-global-snapshot.ts), [src/lib/fund-global-manifest.ts](src/lib/fund-global-manifest.ts) | Linked-chain snapshot reconciliation, minting the initial allocation to the FUND owner, and the (currently unwired) stock Sticky holder operations |
| [src/components/HomePage.tsx](src/components/HomePage.tsx), [src/components/ProjectPage.tsx](src/components/ProjectPage.tsx), [src/components/ProjectCharts.tsx](src/components/ProjectCharts.tsx), [src/components/CreateFlow.tsx](src/components/CreateFlow.tsx) | Native React presentation, creation and illustrative model controls |
| [web/network-model.mjs](web/network-model.mjs), [web/create-model.mjs](web/create-model.mjs), [web/owner-actions.mjs](web/owner-actions.mjs) | Reused pure financial calculations, local draft normalization and non-executable demo owner drafts |
| [web](web) | Retained styles, assets and pure rendering/model helpers; old HTML and imperative app entry points are comparison artifacts |
| [docs/TRANSACTIONS.md](docs/TRANSACTIONS.md), [docs/ARCHITECTURE_PARITY.md](docs/ARCHITECTURE_PARITY.md) | Contract integration status, runtime provenance and remaining verification gates |

`web/network-app.mjs` is not the active application entry point. `npm run dev:prototype` and `npm run build:prototype` retain the earlier static prototype for comparison. The older story, fixed-supply lifecycle and capped calculator modules are reference material rather than live project state.

## Build and deploy

`npm run build` creates `.next/standalone`; `npm start` runs the standalone server locally. The multi-stage [Dockerfile](Dockerfile) installs application dependencies, builds Next, and copies the standalone runtime, static chunks and public assets into the runtime image. It runs as the `node` user on `0.0.0.0:$PORT`.

[railway.json](railway.json) selects the Dockerfile and checks `/` before routing traffic. Railway supplies the runtime port; the custom domain must target that port. Deploying this web application does not deploy or enable the Homerun contracts; those deploy through the Sphinx workflow in [DEPLOYMENT.md](DEPLOYMENT.md), from this repository.

The Docker build accepts the public site, Center, indexer, WalletConnect and Para variables described above as build arguments. Set them on the Railway service before building; changing `NEXT_PUBLIC_*` variables requires a new build because Next embeds them in browser JavaScript. Only public application configuration belongs in these arguments. Contract deployer keys and server API secrets are never frontend configuration.
