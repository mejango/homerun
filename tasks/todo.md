# Homerun client reconciliation

- [x] Install the official reconciled SDK 2.25.0 and align shared runtime/security dependencies with current Juicebox.
- [x] Reuse shared SDK policy for activity, review and receipts; preserve FUND/INCOME launch journals and Center wallet boundaries.
- [x] Reconcile wallet restore, RPC pacing, bounded read freshness and visible payment/error phases with supported sibling behavior.
- [x] Regress identity changes during final checks, wrapped payment proof, recovery and exact activity grouping.
- [ ] Run unit/component, lint, registry, type/build, browser and dependency gates; record results and limitations.

## Plan refinement

- **Objective:** Bring every applicable Homerun client capability to current Juicebox/Revnet/SDK behavior, while retaining its financial models and Center wallet.
- **System fit:** SDK owns shared transaction evidence and review rules; Homerun owns product-specific checks, journals and UI. Display/preparation reads may be reused briefly, while final account/chain guards, simulation and canonical receipts establish execution and recovery.
- **Reuse and simplicity:** Start from origin/main 195b07b, reuse SDK 2.24.5 exports and shared extractions coordinated by the root agent. Refactor duplicated policy before behavior changes; avoid new product features or a UI framework.
- **Evidence and unknowns:** Current siblings and their regression tests are the adapter reference; old shared checkouts are not. Installed dependencies must physically match the lock. SDK extraction APIs are being coordinated; no unpublished runtime is presumed released.
- **Verification:** Target payment identity races, wrapper receipt proof, Safe proposal/execution distinction, activity links/keys, cache freshness and wallet restore; then lint, indexer registry, model tests, Vitest, build/typecheck, all browser suites and dependency audit. Root schedules heavy gates.
- **Resource budget:** One writer owns Homerun and a read-only reviewer compares adapter gaps. Reuse existing suites and fixtures, serialize builds/browser runs, avoid directory swaps, and replan if a journal migration or authority change becomes necessary.

## Plan refinement

- **Objective:** Preserve duplicate-proposal prevention together with each product's durable recovery when a Safe already holds the reviewed call; close final wallet identity races.
- **System fit:** Shared SDK owns proposal identity and exact call proof; the React adapter reports existing proposals without entering the write pipeline; each product journal adopts known proposal facts using its existing snapshot/prerequisite bounds, and only canonical execution releases its lock.
- **Reuse and simplicity:** Reuse existing journals and verifiers through explicit adoption methods; keep beforeWrite exclusive to new writes. Use original proposal calldata, never freshly stamped calldata, and never relax snapshot ordering to make adoption pass.
- **Evidence and unknowns:** The current early return skips beforeWrite in admin/shop/INCOME/Sticky/FUND paths. Latest-block markers can exclude an already-mined execution; adoption must retain exact proposal/call identity and the owning product's established lower bound.
- **Verification:** Regress queue adoption without wallet writes, storage reload/locks, exact call mismatch, prerequisite ordering, and account/chain/view-as changes after asynchronous beforeWrite, then run full application gates against the physical SDK preview.
- **Resource budget:** Delegate journal owners/tests to the existing reviewer, keep hook changes here and coordinate component wiring with the UI owner; avoid schema migrations unless existing validated facts cannot represent known proposals.

## Verification progress

Qualified local SDK preview (before public release): `sha512-znySEtMoxnrcJAKNuidcxDRLk8jN7EYjFiHy431uw7P9znnuGqBpnU0y8Cln18hdtyFBrtqM0036x0+lBCMG5g==`. Node 26.7.0 and npm 12.0.1; install and a fresh physical `npm ci` both passed. No dependency directory substitutions.

- Full controlled Vitest: 154 files, 2,840 tests passed (`--maxWorkers=4`); the first unconstrained run exposed a Node-environment setup guard, outdated intent/mocked query fixtures, and a timeout cascade. Those were fixed before the clean full run.
- Model suite: 340 tests passed; TypeScript, full lint, 17-document indexer registry, dependency tree and production audit passed (zero advisories).
- Production build and all six browser suites passed: project browser 28/28, Create 48/48, accessibility 68 states with zero automated violations, shop at 1440/390/320px, intent publication/deployment, and Center sign-in/retry/reload/disconnect. The final published dependency gate remains pending. Shared Safe lifecycle follow-up retains known proposals through reverted or unproven execution and later service outages; its six-file regression set passed all 136 tests. A subsequent admin phase-boundary regression passed all 15 focused tests.
- Source architecture ownership is enforced by 19 automatically discovered tests. CI and Docker derive npm from packageManager, matching the locally tested toolchain.

Logs are retained under `/private/tmp/homerun-*-qualified*.log`; browser server diagnostics are under `test-results/`. No external deployment, wallet transaction or service mutation was performed.

## Plan refinement

- **Objective:** Close every remaining signature/submission race in Homerun after the final awaited wallet or journal preparation, including published intents and paid deployment.
- **System fit:** Wallet-core owns synchronous live account/connector/chain/view-as/route identity. Callers capture reviewed identity and supply operation-specific Safe/Center eligibility; SDK owns the typed unsent Relayr outcome and rollback classification.
- **Reuse and simplicity:** Reuse the existing reviewed account assertion, view-as guard and Safe connector owner. Acquire a wallet client before the final synchronous guard; invoke its writer immediately afterward. Keep chainless message signatures chainless.
- **Evidence and unknowns:** Census found the main hook, forwarder typed signature, Relayr payment, CreatePreview publication signature and DeployChains paid/setup sends. Center operations use SDK Connect's session identity adapter. A new SDK preview will carry RelayrPaymentNotSentError before app tests consume it.
- **Verification:** Regress account/connector/chain/Safe/view-as changes during wallet acquisition and journal persistence; prove no signature/send and preserve prior submitted payments. Run affected suites and type/lint, then final release graph/build gates.
- **Resource budget:** Parent owns wallet-core and Relayr; existing child owns publication/deployment adapters. Separate hydration owner handles delayed hydration only. Serialize physical dependency installs and final builds; avoid broad retests until changed boundaries pass.

## Final source verification

- Qualified preview 3 physically installed: `sha512-ViaQFhNfQ3kg1/pOdlM69wafbdx4a3ZUhZ5Bd7yrJolFPbDV9dmZrXTL+bMpH6Lptt+0EyVW3v4XwoFbEbH10Q==`. The official release pin and clean-install/full/build gate remain pending.
- Final wallet census: main hook/forwarder/payment 109 focused tests; wallet acquisition 7 tests; intent publication, deployment and Center 87 tests (36 new authority races). Final Relayr marker and payment recovery suites pass 187 tests against preview 3, including no-send refusals after the asynchronous marker and preserving prior reverted payment history. Logs: `/private/tmp/homerun-final-wallet-gates.log`, `/private/tmp/homerun-wallet-core-final.log`, `/private/tmp/homerun-preview3-payment.log`.
- [Delayed hydration evidence](homerun-delayed-hydration.md): five failed-before DOM cases; seven passing hydration/mount cases, 76 affected component tests and 108 persistence-scope tests. Server metadata and explicit null bindings survive delayed hydration. These cases join the final aggregate suite.

## Plan refinement

- **Objective:** Prevent a wallet-returned error from granting Relayr's local pre-send rollback authority, including SDK-branded errors containing nested rejection codes.
- **System fit:** The app's synchronous guard alone can prove non-invocation; SDK owns both normalizing wallet errors and classifying persisted payment outcomes. Existing post-submission receipt/recovery authority stays unchanged.
- **Reuse and simplicity:** Consume the new SDK relayrWalletPaymentError at the actual wallet catch instead of creating another local neutralization rule. Preserve ordinary wallet rejection and ambiguous payment presentation.
- **Evidence and unknowns:** Preview 3 exports the local refusal class; the final review identified that a wallet could return that same brand. Preview 4 will provide the shared normalization boundary and is required before verification.
- **Verification:** Regress wallet-returned typed errors with ordinary and nested rejection causes, asserting the sent payment remains unresolved; retain existing local guard rollback and real wallet rejection tests, then types and focused lint.
- **Resource budget:** Change only the payment catch/import and focused boundary regressions; wait for the qualified physical SDK artifact and defer aggregate checks to the final official release gate.

## Wallet error boundary review

The actual wallet-call catch now consumes the SDK neutralizer before rejection classification. Local synchronous pre-send refusals keep their typed outcome. A wallet-returned typed error, including one whose hidden cause contains rejection code 4001, remains unresolved for both first and prior payments. Qualified preview 4 was physically installed (`sha512-DeJMW245XZq1QUs+0zzgE8E8ETah+s+D7QxJoh0KG5uTzyrQh3Jn3EWDRh69f/hi6mTOBCMR1txt8TWUf0RoMA==`); 208 payment/controller/ownership tests, TypeScript, focused lint and diff checks pass. Logs: `/private/tmp/homerun-preview4-payment.log`, `/private/tmp/homerun-preview4-typecheck.log`, `/private/tmp/homerun-preview4-lint.log`. The dependency still explicitly names a local preview; official release gates remain outstanding.

## Plan refinement

- **Objective:** Qualify the complete frozen Homerun source and all final regression tests before the official SDK pin.
- **System fit:** The full suite combines shared-rule adapters, product authority/recovery, wallet guards and delayed hydration; the root will compare every published SDK payload file to the tested preview before carrying this evidence forward.
- **Reuse and simplicity:** Run the existing aggregate Vitest suite with four workers against the physical preview 4 graph; avoid duplicate full runs if the published SDK payload is byte-identical.
- **Evidence and unknowns:** Earlier full and browser runs passed before the final bounded fixes; the final aggregate count must come from this run. Official package identity and clean-install/build evidence remain pending.
- **Verification:** Record the actual full suite result, preserve logs, then wait for the official dependency pin and physical clean install before production build/browser scheduling. Investigate any failure before claiming the source remains qualified.
- **Resource budget:** Root reserves this four-worker unit slot; no concurrent heavy build/browser work and no new source changes unless a regression fails.

## Frozen-source aggregate result

The final preview 4 aggregate passed all **156 files and 2,912 tests** with `--maxWorkers=4` on Node 26.7.0/npm 12.0.1 (`/private/tmp/homerun-preview4-full.log`). This includes every late wallet, Safe recovery and delayed hydration regression. No source correction was needed. Carrying this qualification to the official pin requires the root's byte-for-byte SDK payload comparison; the official physical clean install and production build are still pending.

## Official release qualification

The root verified published SDK **2.25.0** matches preview 4 in all 762 payload files and tarball integrity (`sha512-DeJMW245XZq1QUs+0zzgE8E8ETah+s+D7QxJoh0KG5uTzyrQh3Jn3EWDRh69f/hi6mTOBCMR1txt8TWUf0RoMA==`). The manifest and lock now name the exact registry release. Final physical clean install, static/type/dependency gates, then the focused commit and PR are authorized; hosted CI will provide final production/browser/container/contract gates while the root coordinates other local builds. Root owns merge after required checks pass.

Official `npm install` and a fresh physical `npm ci` passed. Final full lint, TypeScript, 17-document indexer registry, installed dependency graph and production audit passed (zero advisories). Logs: `/private/tmp/homerun-official-{install,ci,lint,types,indexer,dependencies,audit}.log`. The final SDK is the exact registry version `2.25.0`; no preview file dependency remains. Hosted production/browser/container/contract gates remain pending and are not represented as completed local checks.

## Plan refinement

- **Objective:** Restore the existing contract-test workspace bootstrap under pinned npm 12 without changing application install or contract behavior.
- **System fit:** The bootstrap checks out protocol revisions and verifies dependency versions through the existing deployment owner. Its dependency fetch policy must permit those checkouts' transitive Git packages; runtime wallet and recovery authority are unaffected.
- **Reuse and simplicity:** Add npm's command-scoped `--allow-git=all` only to the bootstrap installs and retain `--ignore-scripts`. Reuse the revision/package pins and verification already in script/deploy.mjs; do not relax global or frontend npm configuration.
- **Evidence and unknowns:** PR 39 job 113137964933 failed with EALLOWGIT for @zksync/contracts at commit 446d391d34bdb48255d5f8fef8a8248925fc98b9. Installed npm 12 config defines allow-git none by default and root permits only direct package.json Git references, so transitive protocol dependencies need all.
- **Verification:** Run existing prepare-workspace tests and scoped lint, then rerun required hosted CI on the follow-up commit. The failed job is the concrete regression; final contract/build/browser results remain pending.
- **Resource budget:** One bootstrap flag and explanatory comment; no new application or contract source, no broad local dependency workspace, and hosted CI remains the final exact-head gate.

The four existing workspace-bootstrap tests, scoped ESLint and diff checks pass after the npm 12 compatibility fix. On the first official-package PR revision, Test and build, Container smoke, Forge format and Production dependency audit passed; Forge setup hit the documented npm fetch policy before contract tests ran. All required checks must pass on the follow-up revision before merge.

## Plan refinement

- **Objective:** Qualify Homerun against the additive shared SDK home-chain collector/review release, then pin the normal published SDK 2.26.0 package without changing existing Sticky split behavior.
- **System fit:** SDK owns collector routing and transaction decoding; Homerun retains its existing same-chain Sticky distributor detection, launch/recovery journals and wallet boundaries. No collector is treated as deployed before verified configuration exists.
- **Reuse and simplicity:** Reuse the current shared decoder, existing Sticky helpers and focused suites. Prefer a dependency-only application change; keep collector rules and addresses out of local copies.
- **Evidence and unknowns:** Start from origin/main 3f292b9 on the isolated codex/sticky-home-sdk-20261009 branch. The user has merged the release PR and core 2.26.0 is now available from npm. Compare its runtime payload to the qualified preview and its integrity to the release record before carrying preview results forward; neither package qualification nor registry publication proves contract deployment readiness.
- **Verification:** Review the decoder and same-chain consumers; run focused review/Sticky and architecture-ownership tests, source/model gates, TypeScript, lint, indexer checks and a production build with Node 26.7.0/npm 12.0.1. After release confirmation, install the exact registry version and check the lock/dependency graph; investigate any payload mismatch before carrying preview evidence forward.
- **Resource budget:** One agent owns the dependency and application gates; a read-only reviewer traces imports and classification. Back up the ignored SDK directory before preview substitution, leave manifests/locks untouched until registry publication, and avoid unrelated contract/browser suites. No commit, push, merge or deployment is authorized for this task.

### Home-chain SDK consumer qualification

- [x] Review the shared decoder integration and existing same-chain Sticky behavior.
- [x] Qualify the SDK payload with focused suites and required application gates.
- [x] Pin published SDK 2.26.0 and verify physical package/lock identity.
- [x] Record actual results and unresolved release evidence.

The preview compatibility review found no application change necessary. Homerun consumes the shared review decoder directly; `isStickySplit` retains same-chain distributor semantics, and collector deployment defaults remain empty until verified deployment configuration exists. The focused transaction-review/Sticky/architecture suites passed 236 tests in 17 files; the split-editor suites passed another 68 tests in two files. All 340 model/source tests, full lint, the 17-document indexer registry check, the production build and separate TypeScript check passed. The model suite's first sandboxed run hit loopback `EPERM` in six server cases; the full rerun with loopback access passed without a source change. The published-package comparison below binds these preview results to the installed release.

The core feature PR #196 and user-merged version PR #197 are complete; core 2.26.0 is now published. The preview tarball SHA-256 is `9f4e801d2d7f1089cc8dbf1612455c773bc187e81b912bdcc90c72e62ed97c8a`. Qualification logs are retained as `homerun-home-sdk-{focused,splits,model-unsandboxed,lint,indexer,build,types}.log` in the local temporary evidence directory. The original installed 2.25.0 SDK was restored after preview qualification; the normal registry install below replaces it. No commit, push, merge, deployment or wallet operation was performed.

The normal npm 12 registry install changed exactly one package. The manifest, lock and installed SDK now agree on exact version **2.26.0**, with release integrity `sha512-7V9wFoBtteL0Y7jTzTO5qwfYMcBCKZ+W5C8JEXVadqf8iZ+fuAi5jg6qZzBWvrDFHHRRC7K6Ed2ZpevdXV/79g==`. All 761 installed `dist` files match the qualified preview byte-for-byte; package metadata differs only in `version`, including unchanged exports and dependency declarations. The only changed lock entries are the root core pin and core's own version/URL/integrity; the unrelated dependency graph is unchanged. Against this physical registry install, all **304 focused tests in 19 files** and TypeScript pass again. The identical runtime/declaration payload supports carrying forward the earlier build, model/source, lint and indexer results without repeating them. Installed dependency identity and whitespace checks pass. The package comparison and final logs are retained as `homerun-home-sdk-official-{equivalence.json,install.log,focused.log,types.log}`. Hosted checks remain the final PR gate.
