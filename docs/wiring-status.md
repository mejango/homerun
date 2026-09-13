# Homerun wiring status

Audit date: **2026-09-13**. This records source-level wiring, with an additional read of the installed SDK deployment registry. Shop authoring is implemented in the current change; this document does not establish that the frontend has been deployed. A working handler is not proof of a completed production transaction. No production-chain transactions were submitted for this change.

## Remaining work

| Priority | Area | Current state and evidence |
| --- | --- | --- |
| High | INCOME launch and Sticky setup | UI, transaction builders and recovery exist. The v3 release source is prepared, but the installed SDK has no `HomerunIncomeDeployer`, `JBTokenDistributor`, or `JBStickyDeployer` entries on any of the eight supported chains. Launch guards require verified registrations. See [release status](INCOME_RELEASE.md), [launch prerequisites](../src/lib/income-launch.ts), [INCOME registry lookups](../src/lib/income-contracts.ts), and [Sticky registry lookups](../src/lib/sticky-contracts.ts). This does **not** establish that the contracts do not exist onchain. |
| Medium | Shop authoring outside the supported scope | First-shop creation rejects nonzero treasury budgets, timed or approval-controlled rulesets, pending rulesets and foreign hooks; these configurations require the full Juicebox editor. The item-replacement helper exists, but the UI currently offers add/remove only. Legacy INCOME hooks that prohibit tier edits cannot be unlocked by frontend changes. See [creation guards](../src/lib/project-shop-create.ts), [write planning](../src/lib/project-shop-write.ts), [item helpers](../src/lib/project-shop-items.ts), and [management UI](../src/components/ProjectShopManagement.tsx). |
| Medium | Edit published project details | Creation publishes the complete normalized setup and image references, but there is no post-launch profile/metadata editor or project-URI write action. `setProjectUri` permission is already read. See [creation](../src/components/LiveCreate.tsx), [metadata builder](../src/lib/fund-project-metadata.ts), [permissions](../src/lib/fund-state.ts), and [FUND controls](../src/components/FundProject.tsx). |
| Medium | Current Operator in public project details | The live Operator replacement updates the INCOME split recipient, while both public project overviews still display the Operator wallet from published metadata. The label says “Published Operator wallet,” but this is not the current Operator address after a replacement. Dataflow is traced below. |
| Medium | General ownership, permissions and splits administration | A live action changes the INCOME Operator beneficiary. There is no general UI to change split percentages/other recipients, transfer program ownership, or grant/revoke project management permissions. The loan-specific permission grant is implemented. See [Operator builder](../src/lib/income-operator.ts), [Operator controls](../src/components/IncomeOperatorActions.tsx), and [loan actions](../src/components/IncomeProject.tsx). |
| Medium | Native shop checkout and customer operations | The live inventory links out to Juicebox for checkout. Customers lists current indexed NFT owners; it does not provide native redemption, fulfillment, booking, or shipping controls. See [shop inventory and customers](../src/components/ProjectShop.tsx). |
| Medium | Add funds / fiat onramp entry point | The Para controller and provider implement `requestAddFunds`, but no app UI calls it. Payment and account views have no add-funds entry point. See [Para context](../src/providers/ParaAuthContext.tsx), [provider](../src/providers/Providers.tsx), [onramp host](../src/providers/ParaModalHost.tsx), [payment](../src/components/ProjectPayment.tsx), and [account](../src/components/AccountView.tsx). |

## Current Operator dataflow

1. [Creation metadata](../src/lib/fund-project-metadata.ts) copies `CreateValues.operatorWallet` into `homerun.setup`; parsing exposes it as `details.plan.operatorWallet`.
2. [The live Operator action](../src/components/IncomeOperatorActions.tsx) reads the current/upcoming INCOME splits and submits `buildIncomeOperatorTx`. [That builder](../src/lib/income-operator.ts) changes the selected split's beneficiary while preserving the other split fields, then calls `buildSetSplitGroupsTx`.
3. [The FUND overview](../src/components/FundProject.tsx) supplies `plan?.operatorWallet` to `OperatorProfile`. [The INCOME overview](../src/components/IncomeProject.tsx) reloads the linked FUND's published metadata and supplies `details?.plan?.operatorWallet`.
4. Neither overview reads the new split beneficiary for its Operator profile. Refetching the same project URI cannot reflect a change made only to onchain splits. The overview needs a current Operator read, with published profile information distinguished from the active recipient. The Owner address already follows verified FUND ownership when available.

## Implemented transaction paths

These controls have live handlers with transaction review and verification. Availability still depends on supported contracts, current permissions, balances, rulesets and any deployment prerequisites.

| Area | Implemented paths | Source |
| --- | --- | --- |
| FUND creation | Publish metadata/images; deploy the raise; track and recover selected-chain deployments | [LiveCreate](../src/components/LiveCreate.tsx), [metadata publication](../src/lib/publish-fund-project-metadata.ts) |
| Shop authoring | Create the first shop/items, add items and remove eligible items through the shared editor. New shops use USD; existing shops inherit pricing. Metadata/media are pinned to IPFS. First creation attaches the hook through a new ruleset, granting and restoring deployer permissions when needed; saved direct/Safe execution records support recovery. | [ProjectShopManagement](../src/components/ProjectShopManagement.tsx), [shared editor](../src/components/ShopItemEditor.tsx), [item publication](../src/lib/project-shop-items.ts), [write plan](../src/lib/project-shop-write.ts), [recovery](../src/lib/project-shop-session.ts) |
| Payments | FUND/INCOME payments, token approval and supported swap routing | [ProjectPayment](../src/components/ProjectPayment.tsx) |
| FUND lifecycle | Pause/resume/close; refund and sale-claim rules; treasury returns; success minting; purchase allowances and withdrawals | [FundOperatorActions](../src/components/FundOperatorActions.tsx), [FundAssetWithdrawals](../src/components/FundAssetWithdrawals.tsx) |
| Holder tokens | Credit claims, transfers, burns and quoted cash-outs | [FundProject](../src/components/FundProject.tsx), [IncomeProject](../src/components/IncomeProject.tsx) |
| Bridges | Prepare, relay and verify supported FUND/INCOME bridge claims | [ProjectBridgeActions](../src/components/ProjectBridgeActions.tsx) |
| INCOME financing | Borrow, repay, refinance and transfer loan positions | [IncomeProject](../src/components/IncomeProject.tsx), [IncomeLoanTools](../src/components/IncomeLoanTools.tsx) |
| INCOME allocations and Operator | Distribute reserved tokens, trigger scheduled allocations, change the Operator beneficiary | [IncomeReservedTokens](../src/components/IncomeReservedTokens.tsx), [IncomeProject](../src/components/IncomeProject.tsx), [IncomeOperatorActions](../src/components/IncomeOperatorActions.tsx) |
| Launch, initial claims and ongoing rewards | Global launch/snapshot flow, initial allocation claims, Sticky creation/staking/unstaking/vesting/collection; deployment prerequisites remain unresolved as above | [IncomeLaunch](../src/components/IncomeLaunch.tsx), [InitialIncomeClaim](../src/components/InitialIncomeClaim.tsx), [StickyCreate](../src/components/StickyCreate.tsx), [StickyHolder](../src/components/StickyHolder.tsx) |

The [transaction catalog](../src/lib/transaction-catalog.ts) is a navigation/reference map; inclusion there alone does not prove an action is enabled.

## Intentional boundaries

- **Founder Haus and local previews:** `/founderhaus` and `/project` use local simulation state. Phase selection, modeled activity, simulated payments and demo inventory do not submit transactions. See [ProjectPage](../src/components/ProjectPage.tsx) and [DemoProjectShop](../src/components/DemoProjectShop.tsx).
- **Published plans versus enforced rules:** Saving a setup field to `projectUri` does not enforce it. Minimum revenue/consequences, forecasts, asset budgets and planned allocations are metadata. Initial FUND creation installs the fundraising rules; later lifecycle changes require separate authorized transactions. See [metadata](../src/lib/fund-project-metadata.ts), [initial FUND rules](../src/lib/fund-contracts.ts), and [create review](../src/components/CreateFlow.tsx).
- **Offchain operations:** Asset purchases, sales and offchain contribution settlement remain external human operations. Onchain allowance, withdrawal, treasury-return, mint and refund paths exist. Their presence does not verify a purchase, recover externally held money, or automate the stated revenue consequences.
- **Safe execution:** A proposed Safe transaction still requires execution through Safe. The app tracks confirmation; a proposal is not reported as completed execution.

## Validation and audit method

The current v3 release source passed 130 Solidity tests and 138 targeted TypeScript tests. These validate source behavior; they do not establish contract deployment, frontend deployment, or successful production wallet execution. See [release preparation](INCOME_RELEASE.md).

The wiring audit traced visible handlers through transaction builders, searched for missing URI/ownership/permission and onramp callers, and read the installed `@bananapus/nana-sdk-core` registry through `jbContractAddress['6']`. The three add-on entries named above were absent on all eight supported chains. The audit did not verify chain bytecode or submit production transactions.
