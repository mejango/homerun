# Existing Safe proposal recovery

## Plan refinement

- **Objective:** Allow Homerun's existing durable transaction owners to adopt an already authorized exact Safe proposal without submitting another write; preserve canonical execution proof and immutable plans.
- **System fit:** The shared hook discovers an exact known proposal and invokes a separate adoption callback; product journal owners bind its hash and original call to saved intent, and existing canonical receipt verification alone resolves recovery. Hooks and components remain owned by other agents.
- **Reuse and simplicity:** Reuse each journal parser, persistence checks, request builders, and existing historical receipt verification. Put proposal hash/call validation in the already shared Sticky recovery module, and replace its Safe execTransaction decoder with SDK safeExecutionRunsCalls while retaining single-call policy and canonical proposal-event proof. Separate persistence extraction from adoption behavior, and leave SDK APIs unchanged.
- **Evidence and unknowns:** Current generic Safe queue recovery returns before beforeWrite and leaves durable product journals missing. Known hash plus original call is required. Raw admin/holder journals retain earlier stamps only through SDK heldCall equivalence; immutable plans require exact call equality. Shop uses snapshot/prerequisite blocks, income its embedded local snapshot, Sticky creation its prepared snapshot; only admin/holder/payer journals lacking snapshots may use block zero because exact proposal events remain required.
- **Verification:** Focused journal tests prove atomic hash persistence, wrong hash/call rejection, unchanged duplicate and immutable-plan guards, historical execution acceptance, snapshot/prerequisite lower bounds, and exact Safe execution-event binding. Run targeted tests and type checks, then give parent diff/evidence for full gates.
- **Resource budget:** Limit source edits to the seven assigned journal owners and focused tests, reuse inspected fixtures, and run one focused batch after implementation. Parent owns integration and complete build gates. Replan if adoption would require trusting mutated current state or changing SDK contracts.

## Work

- [x] Add explicit owner APIs and exact-call validation.
- [x] Cover successful historical recovery and rejected mismatches with focused tests.
- [x] Run focused verification and report signatures/results to integration owners.

## Review

- Seven journal suites passed: 317 tests, including 16 new adoption regressions; the prior 301 tests passed before adding those cases.
- TypeScript and targeted ESLint passed against the qualified SDK preview. Diff whitespace check and refinement gate passed.
- Raw admin/Sticky adoption retains SDK-equivalent original stamped calldata and exact proposal hash; immutable plan owners reject any call differences. Shop proves canonical completed prerequisites before adopting and rechecks concurrent journal changes; income and Sticky creation retain snapshot bounds.
- FUND adoption leaves ordinary transition guards intact, preserves the immutable current plan and other chains, rejects a concurrently changed/deleted journal, and checks storage readback. Payer returns validated recovery facts for its existing component persistence owner.
- Sticky canonical verification now reuses SDK single-call matching with batching explicitly disabled; exact proposal event, outer-revert recovery, chain, canonical block, and historical bounds remain enforced.
- Hooks/components, SDK source, dependencies, and release gates remain owned by the integration agents. No commits made.

## Plan refinement

- **Objective:** Add a Homerun CI source gate that keeps reconciled protocol rules in their SDK owners.
- **System fit:** Existing Vitest discovery runs the new architecture test; application adapters retain product policy while importing shared pacing, reviewed writes/messages, Safe proof, Relayr binding/retry and activity rules.
- **Reuse and simplicity:** Follow the root tools/check_client_architecture.py ownership constraints and inspect actual named SDK imports/re-exports; test source boundaries rather than duplicating protocol behavior.
- **Evidence and unknowns:** Current source imports identify the intended owners; the gate can catch named duplicated implementations/constants and bypasses, but does not prove all semantic equivalence or deployed behavior.
- **Verification:** Run only test/architecture-owners.test.ts, confirm the gate catches representative source regressions with temporary in-memory mutations, and check the final diff. Parent owns broader test/build gates.
- **Resource budget:** Limit code changes to one source-inspection test and this refinement entry; reuse existing module paths and avoid dependency changes or AST tooling.

- [x] Enforce SDK ownership at actual adapters and prevent copied shared rules.
- [x] Run the focused gate and report results.

Architecture gate result: `test/architecture-owners.test.ts` passed 19 checks. Actual adapters must import and call/re-export SDK pacing, reviewed-write/message, Safe, Relayr, and cross-chain activity owners. Whole-source checks reject copied known shared declarations, Safe execution ABI/stamp literals, and local RPC retry timers/classifiers. In-memory regressions verify removed owners, unused imports, and copied declarations are rejected. The gate uses the package working directory because Vitest's browser environment rewrites `import.meta.url` to HTTP. This is a source boundary gate, not a substitute for functional or build evidence.

## Plan refinement

- **Objective:** Refuse changed wallet authority at the last application-controlled boundary of Center intent signatures and caller-funded intent deployment sends.
- **System fit:** SDK publishSignedIntent still owns the exact prepared message/envelope; CreatePreview owns eligible publisher connection and consent. DeployChains owns reviewed setup/forwarder calls and transaction recovery. Wallet identity is rechecked after Center, wallet-client and receipt awaits; parent owns raw Relayr and other signatures.
- **Reuse and simplicity:** Reuse existing view-as/account/Safe checks and parent-owned wallet plumbing; use a captured wallet client to place the final synchronous guard immediately before its signer/sender. Add no journal, dependency or new publication protocol.
- **Evidence and unknowns:** CreatePreview currently checks the sender before asynchronous SDK preparation and passes an unguarded wagmi signMessage callback. DeployChains sends after review and setup-receipt awaits. Plain Center messages are chainless; deployment transactions remain explicitly bound to their reviewed chain and ordinary external wallet.
- **Verification:** Add deferred preparation/client-acquisition and deployment prerequisite tests for account, connector, view-as and wallet eligibility drift; prove no signature/transaction/publication after refusal and preserve unchanged success/recovery cases. Run only affected UI/intent tests and typecheck when dependencies are stable.
- **Resource budget:** Limit edits to CreatePreview/DeployChains and their focused tests, plus Center payment's missing view-as write guard and focused regressions; fund-intent only if callback semantics require it. Read local Next client-component guidance. Coordinate with parent's wallet-core owner and avoid package, Relayr or useSafeTx edits. Center status/recovery stays readable in view-as; new preparation and submission recheck after identity authorization awaits.

- [x] Guard Center publication signing and each exact intent-deployment send after the last await.
- [x] Run focused authority regressions and report all audited sites.

Final authority result: CreatePreview captures the publisher/connector before review, obtains the wallet client after SDK message preparation, and rechecks the shared ordinary-wallet/view-as guard immediately before signing that exact message. DeployChains reuses the same guard after review, wallet acquisition and each setup receipt; every send pins the reviewed account and configured chain explicitly. Center payment checks view-as after its final identity authorization before a new SDK preparation/submission, while submitted recovery and status remain readable. The fund-intent SDK envelope owner, LiveCreate navigation and Center runtime adapter need no duplicate signer policy.

Three focused suites passed 87 tests, including 36 new boundary cases. Account/disconnect/connector/Safe/Center/view-as changes during publication preparation/acquisition are refused; chainless publication permits chain changes. Deployments additionally reject chain drift after review/acquisition/setup receipts, and never record an unsent launch. Center tests defer final authorization, prove no new preparation/submission under view-as, retain the original journal and allow status/recovery. TypeScript and diff whitespace checks passed; focused lint passes with the existing test-only Next image warning.
