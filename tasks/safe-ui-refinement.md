# Safe submission UI reconciliation

## Plan refinement
- **Objective:** Every Homerun transaction review can finish on Done after a Safe proposal is submitted while only proven execution counts as success or advances dependent operations.
- **System fit:** Existing useSafeTx owns proposal tracking and proof; components display its notice, explicitly dismiss results and preserve existing product receipt verification and launch journals.
- **Reuse and simplicity:** Add the same separate dialog settlement field used in Sticky; reuse readableError for visible launch statuses and remove proposal-hash guesses where the hook already provides phase and notice.
- **Evidence and unknowns:** Hook port and parent task plan are implemented; the shared SDK preview is pending. Existing UI tests and call-site census are the evidence, not deployment claims.
- **Verification:** Regress Done without confirmed step marks or dependent sends, explicit dismissal/reopen, pending proposal hash capture, and launch error presentation; run scoped lint and relevant existing UI tests after the preview is staged.
- **Resource budget:** One component writer and parent hook/lib owner; bounded all-caller audit, no full build or browser run without the root's coordinated slot.

## Work
- [x] Reconcile all confirm/status consumers and launch presentation.
- [x] Run focused checks and hand off residual gates.

## Queued proposal adoption refinement

The new hook can recover an existing Safe proposal before wallet preparation, so components that previously created recovery records only in `beforeWrite` must explicitly adopt that proposal. The hook's adoption callback supplies the original proposal hash and exact call; owning journal helpers validate and save that evidence without inventing a wallet attempt or applying current stamped fields.

## Plan refinement
- **Objective:** Preserve recovery and exact product proof when the hook finds a held or queued Safe proposal, without submitting it again.
- **System fit:** Hook owns identity checks and proposal lookup; journal modules own atomic adoption validation/storage; components connect returned evidence to existing recovery and receipt verifiers.
- **Reuse and simplicity:** Reuse parent-provided onExistingProposal and journal adoption helpers, keeping beforeWrite for actual wallet submissions and reusing existing intent evidence where exact-call equality is established.
- **Evidence and unknowns:** Read-only census found beforeWrite-only bookkeeping in launch, shop, Sticky and operator/bridge consumers. Journal helper APIs are being implemented by their owning agent before wiring.
- **Verification:** Add focused existing-proposal regressions for durable and in-memory callers, ensure no duplicate write or false successful effect, and run the changed UI tests after dependency staging ends.
- **Resource budget:** Parent owns hook and library changes; this writer owns component wiring and UI tests. No independent journal policy, SDK changes or heavy builds are introduced.

## Review

- All confirmation consumers use separate submitted settlement and actual hook notices. Successful step advancement and product refresh remain gated by execution proof; standalone receipt-verification panels retain their pending locks.
- Sticky, Sticky creation, INCOME launch, FUND launch, shop and payer recovery adopt existing proposals through owning journal helpers. Operator and reserve intents retain their proof context; bridge adoption retains original calldata and the pending lock.
- Bridge Safe outer reverts remain submitted even if an engine reports an error. FUND multisig setup uses shared Safe execution proof, preserves unresolved proposals and requires their proof before proceeding to launch.
- Launch runtime and saved error presentation use shared normalization without changing journal evidence.
- Validation: component ESLint passed, with fresh targeted lint after the bridge/setup edits; `git diff --check` passed. The focused adoption run initially passed 111/113 tests; two new fixture assertions were corrected and the four-suite rerun passed 85/85. INCOME project surface rerun passed 31/31, and final bridge suite passed 9/9. Earlier payment, holder, loan, metadata and split confirmation regressions passed. Parent owns the final aggregate suite, typecheck and build gates.
