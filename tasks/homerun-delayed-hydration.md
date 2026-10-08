# Homerun delayed hydration parity

## Plan refinement

- **Objective:** Carry Revnet's per-component hydration behavior into Homerun so a disk cache restored before a delayed boundary hydrates cannot replace its server HTML; preserve server-provided project metadata and fixed INCOME binding seeds.
- **System fit:** Providers owns restoration and the five persisted display readers own rendering. Use React's server snapshot during each component's hydration, then expose the existing cache and ordinary query subscriptions. Wallet authority, transaction preparation/execution, canonical confirmation and recovery journals remain unchanged.
- **Reuse and simplicity:** Reuse Revnet's `useSyncExternalStore` hydration helper and each reader's existing server seed/fallback; mask only displayed data and status at the consumer. Do not add a general query wrapper, extra cache, dependency or SDK release. FundProject's persisted display snapshot already reaches rendering through an effect.
- **Evidence and unknowns:** Providers currently restores at window.load, which does not guarantee a streamed child has hydrated. ProjectShop, ProjectParticipants and ProjectActivity render persisted data or flags; ProjectAddress and FundProject additionally seed initialData from the server. Installed Next 16.3.8 server/client documentation confirms client components also prerender on the server. A DOM regression will demonstrate the actual mismatch before the fix.
- **Verification:** Use existing jsdom/Vitest, renderToString and hydrateRoot with the actual persistence owner restoring a changed cache before child hydration. Assert no recoverable hydration error, retained server node/seed at hydration and eventual restored display; include unseeded and seeded readers, pending refresh and later navigation. Run affected component suites, persistence-scope checks, TypeScript and focused lint; no heavy build or live network.
- **Resource budget:** One bounded helper and five existing readers, targeted DOM tests, one failed-before run followed by bounded passing checks. Coordinate file ownership and installation timing with Homerun owner; no heavy build/browser or package mutation. Replan only if server seeds cannot be preserved through direct consumer masking.

## Work

- [x] Read required resources, installed Next docs and all persisted consumers; coordinate exclusive ownership.
- [x] Reproduce delayed hydration failure with real persisted cache restoration.
- [x] Apply existing per-component hydration pattern, preserving seeded server output.
- [x] Pass focused tests, persistence-scope gate, types and lint; report concrete evidence.

## Review

Five DOM regressions failed before the change with React's recoverable hydration mismatch: shop, activity, participants, seeded project identity and seeded null INCOME binding (`/private/tmp/homerun-hydration-before.log`). The fixed suite also covers the actual FUND component preserving server metadata before a restored URI, plus first-commit cache visibility on later client navigation. All seven use real React DOM hydration/mounting; persistence scenarios call the actual cache serialization/restoration owner, preserve the original server boundary node and inspect its first commit while fresh requests remain unresolved.

The six affected component suites passed 76/76 (`/private/tmp/homerun-hydration-after.log`); persistence scope passed 108/108 (`/private/tmp/homerun-hydration-persist.log`); TypeScript and focused ESLint passed (`/private/tmp/homerun-hydration-types.log`, `/private/tmp/homerun-hydration-lint.log`). No build, browser or live transaction was run for this bounded correction. Providers still owns the same restoration timing; query persistence scope, fresh transaction guards and recovery journals remain unchanged. The executable DOM regression is the reusable acceptance gate.
