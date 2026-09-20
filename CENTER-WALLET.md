# Juicebox Center wallet integration

Homerun's web client uses `@bananapus/nana-sdk-connect` (the Juicebox SDK's connect package, which pins `@me.jango/center-wallet`, Center's browser client) for passkey
connections. Para's web SDK and UI dependencies are removed. Existing injected,
WalletConnect, Coinbase and Safe app connections remain available.

The integration stays disabled until all public build-time pins in `.env.example`
are supplied: enablement, issuer, API audience, manifest ID/revision and maximum
EntryPoint prefund in wei. Discovery or callback data cannot change these pins.
The callback `/center/callback` must be in Center's shared allowlist for this
exact app origin. Build configuration does not activate that allowlist.

## Connection and payment behavior

Signing in opens Center in a frame inside the sign-in dialog and the page stays. The
callback lands on `/center/callback` inside that frame, which scrubs its address and
hands the callback URL up to the page; the page finishes the exchange, connects wagmi
and drops the frame. When the person opens the sign-in as a page of its own (or signs
up), the flow is a full-page redirect: the app saves the original local pathname
before preparing the handoff and the callback page completes the exchange itself,
then returns to that page. In both cases the SDK's original exchange is preserved for
retry, and wagmi connects only to the completed Base Safe identity. Closing the wallet
chooser prevents a delayed preparation from launching.

The Center connector supports reads and account discovery. It cannot expose
generic signing, transaction sending or session-permission methods through the
browser API key. Other Homerun transaction types currently require an external
wallet; they do not silently gain authority through Center.

The supported payment profile is Base USDC through the direct V6 payment terminal.
Homerun obtains a fresh direct-terminal quote, checks current project eligibility,
preserves original preparation IDs, and checks the decoded payment against the
selected project, amount, beneficiary, terminal and minimum token return. Center's
SDK independently verifies the exact plan, operation, fee bound and owner approval.
The passkey review and explicit submission are separate steps.

The framed sign-in is the SDK's `passkeyOption({ frame: true })` (0.4.0): Center's
launch form targets a frame the dialog renders with `allow="publickey-credentials-get"`,
and the callback hands up through the SDK's `deliverCenterCallback`. Center serves
the sign-in framed only for apps in its `WALLET_FRAMEABLE_APP_ORIGINS`; the page
inside offers "Open as a page" when it cannot continue there.

The review is shown inside the payment panel, the way Beep shows it: Center's
review page is framed with `allow="publickey-credentials-get"`, reports its own
height by message, and on approval sends the frame to Homerun's `/center/callback`,
which hands the callback up to the framing page by same-origin message; the page
completes the payment and removes the frame. The frame only loads when Center
admits Homerun's origin to frame its own reviews (`WALLET_FRAMEABLE_APP_ORIGINS` on
Center); "Open as a page" is the full-page fallback either way.

The payment journal records submission before sending. A lost response retains
that record; retry and polling observe the original operation. Polling pauses
when hidden/offline and has a finite attempt budget. Another payment cannot
replace an unresolved one. Known terminal outcomes are archived before removal.
Session-storage failure prevents sending. Archiving is not a wallet asset backup.

The wallet address can receive Base USDC and ETH for fees. This integration does
not move existing Para assets or provide an onramp. Current production activation
and real funding are not part of this checkpoint.

## Verification and remaining qualification

Use Node >=24.1/npm >=11. `npm run check` covers lint, indexer schema, model and
component tests, production build and contracts. In an isolated checkout, resolve
Foundry remappings to the existing protocol libraries. Browser commands
`test:browser`, `test:create` and `test:a11y` use `BASE_URL` and the installed
`PLAYWRIGHT_MODULE` against the built local app.

`test:center` exercises an enabled build with fictional issuer
`https://wallet.homerun.test` and audience `https://api.homerun.test`, manifest
`browser-fixture`, revision `0x` followed by 64 `1` characters, and a
`1000000000000000` wei fee bound. Build to `.next-center-test`, serve its standalone
output at `BASE_URL` (default `http://localhost:54064`), then run `npm run test:center`.
It uses the actual app and pinned SDK with explicitly modeled Center responses to
check chooser cancellation, the framed sign-in, URL scrubbing, a lost exchange reply, exact retry,
original-page restoration, reload and sign-out. It writes a sanitized report and
screenshot under `test-results/center-wallet/`. This test does not authorize funds
or establish actual server/chain behavior.

Dedicated tests cover fixed connector authority, callback scrubbing, cancelled
handoff, persisted original payment identity, altered plan effects, improved
minimum returns, lost submission responses, storage failure and history recovery.
These controller tests model the SDK/service boundary; they do not replace a
joined browser test against configured Center and an actual payment provider.

Production qualification still requires that joined test, signup and lost-passkey
replacement on the configured RP, deployment/fee/settlement readiness, verified
funding and restore controls, and physical device acceptance. Center retains its
Para compatibility. Juicebox Money and Revnet Money are outside this change.

Client packages: `@bananapus/nana-sdk-connect` and `@me.jango/center-wallet` from npm.
