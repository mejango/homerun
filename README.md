# Homerun ⚾︎

Fund and earn together.

Site name: **Homerun ⚾︎**. Production domain: **homerun.money**. Hosted on Railway.

**Current design:** [FUND and INCOME have separate continuing rights](docs/NETWORK_DESIGN.md). The corporation owns the asset and the owner-controlled fundraising Juicebox. FUND participates equally per token in its eventual net sale distribution. At successful purchase, FUND holders receive an initial INCOME allocation without surrendering FUND. FUND holders receive ongoing INCOME automatically, in proportion to their FUND holdings, without staking or a vesting delay. Gross revenue enters the Revnet; newly issued INCOME goes to operations, FUND holders and the customers making revenue payments. Operators can redeem or borrow against available INCOME for expenses. The projection uses redemptions, with an investor-funded operating reserve covering early gaps; it does not simulate operator loans.

Founder Haus remains the rental-house example. The website uses asset and revenue language so the flow also describes other income-producing assets. The preview calls the revenue token INCOME (FH-INCOME). Internal model keys and the earlier Rooftop reference-contract names remain unchanged.

The demo uses three photographs from the [official Founder Haus site](https://founderhaus.club/), with a gallery and concise venue details. [Source notes](docs/FOUNDER_HAUS_SOURCES.md) record the images and evidence. The financial figures remain scenario assumptions.

The editable starting model budgets $500,000 for the house and $100,000 of usable operating cash. Including the assumed 2.5% outbound fee, that requires about $615,384.62 gross. Baseline rent is $10,000/month and expenses are $6,000/month. Operators receive 20% of post-success FUND supply; investors hold the remaining 80%. The hybrid keeps a **500,000 INCOME premint**, then allocates **70% of new INCOME to operations, 10% to FUND holders and 20% to customers**. The [design document](docs/NETWORK_DESIGN.md) explains the quarterly issuance reductions, automatic holder rewards, reserve checks and sale accounting. Issuance falls 5% every three months for two years: eight cuts, then a fixed rate.

The website is a working local simulation with [reviewable owner action drafts](docs/OWNER_ACTIONS.md). It does not connect a wallet, queue a real ruleset, accept live investments, verify title or enforce corporate rights. `src/Rooftop.sol` is an earlier capped-redemption reference and does not implement the current design.

## Run the product

From this directory, using Node 20 or newer:

```sh
npm run dev
```

Open the [homepage](http://localhost:3010), or go straight to the [Founder Haus demo](http://localhost:3010/founderhause). The homepage ballpark is drawn in JavaScript on canvas. All five asset types appear in the neighborhood. The geometry stays still while a WebGL color drift changes pixel colors at up to 24 frames per second. Footer controls select Shapes or Acid mode, intensity, pace and grouping. Motion pauses offscreen or in hidden tabs, respects reduced-motion settings, and can be paused from the footer. There are no web runtime dependencies to install. `PORT` can override the preview port. The development server binds to localhost; `HOST` overrides the bind address. Production serves `dist/` with `NODE_ENV=production`.

```sh
npm test
npm run build
npm run test:contracts
```

`build` writes a standalone site to `dist/`. Solidity tests use Foundry, Solidity 0.8.28, and the existing OpenZeppelin and forge-std dependencies in the sibling `nana-core-v6` workspace package; see `remappings.txt`.

With the preview running, `npm run test:browser` checks lifecycle states, live projection edits, scenario downloads and mobile layouts. It uses the existing Playwright installation in `webclients/juicescan` and macOS Chrome; `PLAYWRIGHT_MODULE`, `CHROME_PATH`, and `BASE_URL` can override those defaults.

`npm run test:a11y` runs automated WCAG 2 A/AA checks across lifecycle states, expanded details and owner action dialogs. Automated results are a limited check, not a certification of accessibility.

## Create a Homerun

The homepage links to `/create`. Four steps cover the asset, the fundraising budget and operator allocation, the income plan, a written revenue plan and an ownership-over-time slider, and a review with selected networks and optional INCOME revnet operator controls. All four production networks are selected by default: Ethereum, Optimism, Base and Arbitrum. Switching to testnets selects their Sepolia counterparts. The selector uses the same network symbols as Juicebox. The revnet operator role is distinct from the FUND project owner and from receiving operator tokens; its intended address applies across the selected networks. There is no fixed fundraising window; closing remains an owner action. Empty fields can use the example defaults, including “Untitled”. Invalid entered amounts and overallocated token splits must be corrected.

The form saves a draft in this browser. Creation saves a local project and produces a downloadable, explicitly non-executable deployment draft. No wallet is connected and no transaction is sent. `/project/?id=…` loads that project’s name, photo, assumptions and terms into the simulator; these links work only in the browser where the project is stored. A new preview starts at $0 raised. Its Pay component can quote a prospective contribution without changing the displayed fundraising balance. The Founder Haus example remains separate. Revenue plans are retained in the setup export, review and income preview.

`npm run test:create` checks the creation flow, local persistence, independent project previews, mobile layouts and accessibility using the same browser dependencies as the main UI suite.

## Product flows

- **Switch states:** a distinct “Preview controls” panel groups stage selection, fundraising progress, elapsed income months and the later hypothetical sale price. These controls change the illustration, with asset estimates alongside them above the project header. The three bases in the header are display-only. Stages include raising, raise complete, refunding, refunds complete, earning income, or asset sold. Process steps mark completed and upcoming steps. There is no automatic payoff target.
- **Edit projections:** asset price, cash reserve, monthly revenue and monthly expenses appear in the top preview section. “Annual growth” directly reveals the revenue and expense growth estimates. A single hypothetical sale-price input appears later in the “Asset sold” preview; debt and selling-expense inputs are not shown. Agreed token allocations, issuance and protocol fees are explained as fixed terms, rather than presented as visitor inputs.
- **Understand each input:** hover a field, focus it with the keyboard, or tap its question mark for a plain-language explanation. Fundraising progress includes an example using the current dollar goal. Escape and outside taps dismiss help.
- **Preview your contribution:** the Pay box routes payments to FUND during fundraising and INCOME during operation, or shows a refund or sale cash-out. Its dropdowns contain contribution details, token ownership, and cash-out and borrowing estimates that respond to the payment amount. Earlier FUND holdings stay separate from new INCOME payments. Pay accepts USDC or illustrative ETH input, converting ETH to USDC using a fixed, labeled preview rate of 2,500 USDC per ETH. This is not a live market or router quote; refunds and sale claims remain in USDC. FUND ownership alone earns the ongoing holder allocation; no staking action is required.
- **Read the money:** a budget bar explains the fundraising goal, charts show revenue held and reserve history, and a borrowing chart shows estimated personal liquidity over time. Hover or use the month sliders to inspect values. Ownership rings distinguish current FUND and INCOME balances, including automatically allocated holder rewards. “How the money moves” explains the token allocation and reserve stress scenarios.
- **See borrowing grow:** set the month directly beside your quote, or advance one month, to update the preview and its ownership charts. Compare cash-out and estimated first-loan proceeds for initial INCOME plus automatic holder rewards. FUND ownership is unaffected by an INCOME exit.
- **Prepare owner actions:** review and download ordered closing, refund, purchase-completion and sale-redemption drafts. State preview buttons change only the simulation; missing chain and project data remain explicit prerequisites.
- **Save or reset:** download the current inputs and projection at the bottom of the page, or restore the example. On mobile, preview settings appear first; contribution details remain in dropdowns beneath Pay.

All investment states live at `/founderhause`, linked from the illustrated homepage. The previous `/demo.html` URL redirects there. `network-app.mjs` and `network-model.mjs` are current. The older story, lifecycle and capped calculator modules remain references and are not loaded by the website.

The owner determines fundraising outcomes and manually queues state changes. A failed raise refunds the remaining cash after incurred expenses, with no operator success mint. At successful purchase, ordinary FUND issuance stops after the operator allocation. FUND continues as the proposed corporate/property claim. Take the initial INCOME snapshot before enabling automatic holder rewards, resolving prior custodians without double counting, then atomically launch and materialize the full initial allocation. Later claims preserve FUND and cannot repeat the closing allocation. The premint gives early participation, not senior repayment priority.

The revenue model includes operator and optional customer redemptions, operating reserve use, automatic FUND-holder rewards and unpaid expense gaps. Each revenue payment allocates the holder share immediately across all FUND, including the operator’s tokens. Production distribution still needs a reviewed implementation that accounts for transfers, snapshots and replay protection without requiring holders to deposit FUND. Owner drafts describe that unimplemented specification; they do not substitute the earlier Sticky hook or provide executable transactions. An explicit legacy staking mode remains available for model comparisons, but the website uses direct holder rewards.

The default month-12 example holds $62,399.44 in the INCOME revnet and $85,600.56 in operating reserve. Its $10,000 contributor has an $835.16 cash-out estimate or a $785.05 first-loan estimate. These are alternative choices and scenario assumptions, not guarantees.

The model assumes one local USDC revnet balance, zero INCOME cash-out tax and no actual holder loans. The first-loan preview uses 6% assumed upfront fees, excluding subsequent fee-payment issuance and repayment effects. Next-month quotes assume no loan today. Cross-chain balances, live holder snapshots and transfers, AMM routing, historical FUND trades/exits, taxes and corporate enforcement are not simulated. Dollar ledgers use cents; illustrative token units are not calldata.

At a sale, net property proceeds and the unused operating reserve enter FUND once. Every FUND token receives the same proportional claim. INCOME backing, loans and earned holder rewards remain separate from the FUND redemption. No property, revenue collection, expense, sale or corporate documentation has been independently verified.

## Earlier reference model: capped cash-outs without loans

Let `B` be protected liquid backing, `S` outstanding token units, `T` the target per unit, and `x` the units redeemed:

```text
cash-out amount = min(floor(B × x / S), x × T)
additional backing required = max(0, S × T − B)
```

Redemption burns the units and terminates all their future rights. Before full backing, an exit can realize a loss and forfeit the rest of the target. Proportional redemption leaves the remaining unit price unchanged except for rounding. Future receipts benefit the remaining units; early discounted exits also reduce the sponsor's final funding requirement.

The property itself is recovery security, not instantly spendable cash. Initial backing can be zero after subscription proceeds are deployed at closing. The product does not guarantee that principal or the target return will be recovered.

At full target backing, governing documents can authorize legal release while preserving cash for holders who have not redeemed. If every investor voluntarily redeems below target instead, claims can be extinguished without anyone having received their full target. These outcomes are deliberately separate in both the explanation and contract signals.

Retained backing is not a dividend. The earlier $2 million example used 2,000,000 $1 tokens and $185,600 of illustrative backing. It remains in the legacy reference modules only.

## Implementation map

| Path | Responsibility |
| --- | --- |
| [web/index.html](web/index.html), [web/home.css](web/home.css), [web/ballpark.mjs](web/ballpark.mjs) | Homepage with a neighborhood ballpark drawn in JavaScript |
| [web/founderhause/index.html](web/founderhause/index.html), [web/network-app.mjs](web/network-app.mjs), [web/network.css](web/network.css) | Investment simulator and editable projections |
| [web/founder-haus.mjs](web/founder-haus.mjs), [web/founder-haus.css](web/founder-haus.css), [docs/FOUNDER_HAUS_SOURCES.md](docs/FOUNDER_HAUS_SOURCES.md) | Real venue photographs, accessible gallery and source notes |
| [web/field-help.mjs](web/field-help.mjs), [web/field-help-ui.mjs](web/field-help-ui.mjs) | Plain-language help for mouse, keyboard and touch |
| [web/projection-charts.mjs](web/projection-charts.mjs), [web/projection-charts.css](web/projection-charts.css) | Budget, rent cash, operating reserve and borrowing visuals |
| [web/ownership-charts.mjs](web/ownership-charts.mjs), [web/ownership-charts.css](web/ownership-charts.css) | Current FUND and INCOME ownership rings and quote-month styling |
| [web/network-model.mjs](web/network-model.mjs), [test/network-model.test.mjs](test/network-model.test.mjs) | FUND/INCOME claims, automatic holder rewards, issuance, operating redemptions, reserves and sale accounting |
| [web/owner-actions.mjs](web/owner-actions.mjs), [test/owner-actions.test.mjs](test/owner-actions.test.mjs) | Ordered, non-executable owner action drafts and phase guards |
| [docs/NETWORK_DESIGN.md](docs/NETWORK_DESIGN.md), [docs/OWNER_ACTIONS.md](docs/OWNER_ACTIONS.md) | Current economics, assumptions, source dependencies and owner workflow |
| [web/lifecycle-model.mjs](web/lifecycle-model.mjs), [test/lifecycle-model.test.mjs](test/lifecycle-model.test.mjs) | Earlier fixed-supply lifecycle comparison |
| [web/model.mjs](web/model.mjs) | Earlier capped cash-out and recovery reference model |
| [src/Rooftop.sol](src/Rooftop.sol) | One-property subscription escrow and protected redemption vault |
| [test/model.test.mjs](test/model.test.mjs) | Cash conservation, early exits, reserves, stress, recovery, and return tests |
| [test/Rooftop.t.sol](test/Rooftop.t.sol) | Escrow/receipt lifecycle, backing protections, precision, and fuzz tests |
| [docs/MECHANISM.md](docs/MECHANISM.md) | Financial mechanics and settlement semantics |
| [docs/PLAYBOOK.md](docs/PLAYBOOK.md) | Earlier financing playbook; current economics superseded by NETWORK_DESIGN.md |
| [docs/JUICEBOX_ESCROW.md](docs/JUICEBOX_ESCROW.md) | Earlier constrained launcher and receipt-conversion exploration |
| [docs/REVNET_COMPOSITION.md](docs/REVNET_COMPOSITION.md) | Earlier fixed-supply Revnet and property-release-floor exploration |
| [web/assets/IMAGE.md](web/assets/IMAGE.md) | Generated illustrative property image and full prompt |

## Reference contract scope

`Rooftop` is a standalone escrow and ERC-20 receipt vault. Receipts are deliberately nontransferable and use whole units. Issue and target prices are expressed in the settlement token's base units.

- Immutable issue price, target, raise ceiling, deadline, agreement hash, closing attestor, and proceeds recipient.
- Exact subscription accounting and refunds for cancelled or expired closing.
- A single mint of the full supply at attested closing. Passive subscribers' unclaimed receipts remain included in the denominator.
- Protected backing deposits, capped cash-outs, minimum-output checks, and zero-value burn rejection.
- No discretionary withdrawal, subsequent mint, independent burn, approval, or transfer function.
- `targetWasFullyFunded` records full backing of then-outstanding units. `allClaimsExtinguished` records zero remaining units. `releaseEligible()` expresses economic eligibility, not a title transfer or proof of historical investor returns.

The closing attestor is trusted to assess off-chain conditions; a document hash is only an assertion reference. Closing proceeds go to the immutable closing recipient, which must handle creditor/seller payments and initial reserves. The vault has no enforcement over that recipient.

The asset must be a standard, non-rebasing ERC-20. Exact balance checks reject fee-on-transfer behavior, but cannot prevent issuer freezes, depegging, malicious balance reporting, or asset implementation changes. Explicit funding returns only excess from that deposit. Unsolicited direct-transfer excess is intentionally unsweepable.

The reference vault does not enforce the current product's operating policy, rent remittance, corporate rights or sale distribution. It is an earlier contract exploration.

## Earlier capped adapter exploration

The preferred product direction is NETWORK_DESIGN.md. The following notes explain the limitations of adapting the earlier capped vault directly; they are not requirements to replace the stock Revnet loan system.

The local V6 cash-out data-hook interface can express zero-tax capped proportional math by using protected surplus bounded by the outstanding target. A production adapter must additionally preserve exactly the same claim supply, currency precision, and actual liquid custody, without duplicate exits.

Two source details prevent treating this as a drop-in hook:

1. [`JBController.burnTokensOf`](../../nana-core-v6/src/JBController.sol) permits token burns outside the terminal cash-out hook. The adapter must constrain or explicitly account for every way legal claim supply can change.
2. [`JBMultiTerminal`](../../nana-core-v6/src/JBMultiTerminal.sol) can charge a terminal fee on qualifying cash-outs even at zero cash-out tax. Its store preview is not necessarily the investor's final net receipt. The production UI must show net cash, actual fees, and transaction costs; it must never describe a gross target as a guaranteed net return.

Project permissions, mint paths, allowances, payout destinations, successor rulesets, and controller/terminal migration also need complete constraints. The standalone prototype avoids implying these production guarantees already exist. No deployed contracts or RPC state are used by the current interface.

## Deploy

The Dockerfile builds the static site and runs a dependency-free Node server on `0.0.0.0:$PORT`. Railway reads `railway.json` and checks `/` before routing traffic. Only the built website is served; the reference contracts are not deployed.
