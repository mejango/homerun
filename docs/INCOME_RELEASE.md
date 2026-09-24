# INCOME release evidence

**Status: v4 source prepared; contract deployments and proposal submission remain deferred.** Current source and preparation scripts describe `homerun-deployer-global-v4-candidate`. No contract has been deployed or signed by this preparation. The app keeps features that require missing verified deployment records unavailable until a contract release and SDK publication.

**The checked-in manifest and size/test totals below are historical v2 evidence.** Current source launches every FUND itself through `launchFundFor` with fixed campaign rules and a caller-named ERC-20, registers the router terminal registry on FUND and INCOME so any token can pay through swap routing, only attaches INCOME to a FUND it launched, resolves the signer behind the stock ERC-2771 forwarder, gives INCOME a caller-supplied name and ticker, one issuance stage (10/USD, 2% cut per quarter, 10% cash-out tax), and one unlocked reserved split held by the FUND owner. Stock Sticky and the token distributor are no longer constructor dependencies; the owner redirects the reserved split once they exist. The revised helper requires a new verified deployment and SDK registration.

The verified helper and hook addresses are pinned in `src/lib/homerun-addresses.ts` from `deployments/<network>/verified.json`; an SDK registry entry, when present, takes precedence.

[INCOME_RELEASE_MANIFEST.json](INCOME_RELEASE_MANIFEST.json) records the exact source graph, artifact hashes, locations and hashes of full compiler inputs, constructors, size checks, installed SDK addresses, and remaining blockers. The full build files remain local, ignored artifacts; the manifest does not embed them. [prepare-income-release.mts](../scripts/prepare-income-release.mts) regenerates it using local files only. It has no RPC, wallet, broadcast, registry-write, or address-override option. Predictions and locally compiled templates never establish deployed addresses or live runtime identity.

## Global release profile

The same `HomerunDeployer` artifact is constructed on every chain with `(revDeployer, omnichainDeployer, allowlistHook, deployer)`, all identical on the eight networks; `deployer` is the `homerun` Sphinx Safe `0xd5136c794ee43BEf1eD4cF1eB6DEe45b7F803437`. The Safe then calls `setChainSpecificConstants` once per chain with its group's ordered `HomerunChainConfig` entries `(uint32 chainId, address revDeployer, address usdc, address omnichainDeployer, address allowlistHook)`. `HomerunAllowlistHook(projects, permissions, trustedForwarder)` and the `HomerunDeployerLib` external library are deployed once per chain before the helper, the library at the same deterministic address everywhere so the linked helper initcode stays identical.

The complete array is identical on every network and sorted numerically:

```
1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420
```

The helper derives the controller and the router terminal registry from `REVDeployer` during construction. Its immutables are the same on every network, so a matching address on all eight networks is the profile check. USDC lives in storage, set once by the configurator, so verify every chain's `USDC` and `usdcOf` independently.

The FUND Owner remains the authorized caller and becomes `REVConfig.operator`, the stock Revnet control wallet. The separate Homerun Operator is a nonzero initial INCOME incentive beneficiary, passed after `suckerConfiguration`; canonical `REVOwner` continues to hold the INCOME NFT. The client verifies helper version 3 before freezing a new plan and before preparing unfinished networks. Legacy receipt and pending-record decoding preserves exact original calldata; it is not a new-launch compatibility path for an old helper. Recovery and binding lookup currently require the saved helper to remain in the registry. If a future registry replaces an already-used helper, retain explicit legacy helper discovery before migration.

Use the canonical deterministic factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` and the prepared release salt:

```
keccak256(UTF8("homerun.deployer.global.v4"))
0xa2a960cb8927a1e155394f7d77e26c5ef65e17499299983f0f25e75e15d95bcf
```

This is a reproducible release constant, not a deployment record. All eight transactions must use the same creation bytecode, complete constructor calldata, factory, and salt. Changing the array or artifact changes the predicted helper address and breaks the standard same-address linked Revnet route. With every dependency already in the installed SDK registry, the packet can now encode the shared constructor and predict the helper address; that prediction is still not a deployment record.

Mainnet projects link Ethereum, Optimism, Base and Arbitrum; test projects use their four test networks. These are separate launch groups using the same eight-network helper profile, not separate helper constructor arrays. Each initial allocation requires exactly one linked FUND project per participating chain.

The initial supply is one global 500,000 INCOME allocation. A finalized historical report includes live ERC-20 balances, Owner FUND and unsettled Sucker rights; pending bridge claims retain the destination chain, preserving contract-wallet identity. Beneficial custody ownership retains exact rational FUND weights before allocating INCOME. A holder with less than one FUND atom can therefore have a zero integer display balance and a positive INCOME allocation. Per-chain allocations sum to 500,000. Empty chains record a zero allocation, and positive FUND dust that rounds to zero INCOME remains in the public manifest. Each chain's allocation is minted to the FUND's current owner on request, who settles it to the manifest's holders; there is no stake requirement, deadline, vesting or administrator onchain.

The published allocation remains an **Owner attestation**. The contract records each chain's amount as an auto-issuance to the helper, paid to the FUND owner on mint, and commits the manifest hash; it does not establish historical truth, completeness or correct per-holder amounts. The client reconstructs the full global history and reconciles the public manifest before review.

`sourceSetHash` commits the complete canonical global report; the helper's effective REV description salt additionally commits the manifest and all ordered local amounts. Every chain repeats the same global auto-issuance rows to the helper. Anyone mints the local amount through `HomerunDeployer.mintInitialAllocation` once the stage has started, which pays whoever owns the FUND, and the owner settles it offchain; cross-chain launch and remote supply reporting retain stock REV asynchronous behavior. No global readiness oracle is added. A shared past start produces the stock seven-day local cash-out/loan delay, while local payments are available after launch.

Snapshot numbers and hashes use each chain's RPC block domain and are the owner's attestation; the helper does not check them onchain.

The single stage retains global cash-out accounting and the normal Sucker deployment/retry bit. Issuance begins at 10 INCOME/USD and falls 2% every 7,884,000 seconds indefinitely; cash outs are taxed 10%. The caller chooses the reserved percent (0–100%); one split row with `lockedUntil = 0` sends all of it to the FUND owner, who can change recipients and allocations at any time through the stock controller. The INCOME name and ticker are caller-supplied.

Ongoing holder rewards are deferred. When Sticky (or any other recipient) is deployed and verified, the owner redirects part of the reserved split to it; nothing in this helper changes.

## Compilation and size evidence

The profile uses Solidity `0.8.28+commit.7893614a`, optimizer enabled with 200 runs, `viaIR`, and Cancun. Homerun helper artifacts use IPFS metadata hashing.

The packet verifies every source hash in each artifact's compiler metadata and locates matching full build information with the exact compiler input and output. It rejects stale sources, changed constructor components/order, unexpected or missing library links, missing build information and incompatible settings. Constructor validation recurses through the entire tuple array. Source-pattern checks are a guard against profile drift, not formal verification.

| Contract | Creation template | Runtime template | Full initcode / limit |
| --- | ---: | ---: | --- |
| `HomerunDeployer` | 26,896 bytes | 21,544 bytes | 28,752 bytes with the eight-entry constructor; below 49,152 |
| `HomerunAllowlistHook` | 2,739 bytes | 2,554 bytes | Three-word constructor |

The claim vault and its `HomerunDeployerLib` creation library are gone; the helper records the initial allocation as a stock revnet auto-issuance instead, and its sizes above predate that change, so re-measure them before release. The helper's constructor occupies 128 bytes (four address words). Its runtime has 3,032 bytes of EIP-170 headroom. EIP-3860 applies to **creation bytecode plus constructor arguments**, not the creation template alone. The script checks complete fixed singleton constructors and the known helper payload size even while dependency values are unavailable.

Runtime templates contain unresolved immutable words. Their hashes are not live code hashes. Verification must patch and compare **every immutable occurrence** using actual chain/project/constructor values, including full uint256 and EIP712 words. Keep the exact compiler input: the local integration build resolves remappings to absolute source paths, which enter IPFS metadata. Recompiling elsewhere with rewritten paths can change bytecode even if source contents match.

The historical global implementation passed 119 Forge tests using Foundry 1.8.1; the current source passes its own suite (see `npm run test:contracts`), including real REV/CCIP deployment identity across delayed chains, zero/partial local allocation, fractional beneficial ownership and Arbitrum snapshot clocks. The 204-holder case launches and every allocation claims. These results apply to the tested source; subsequent edits require refreshed evidence.

## Reproduce the packet

Use Foundry 1.8.1 (`982849d3140c01fd3b72905759581a132df7aa98`) on `PATH`. The recorded local release toolchain is in ignored `artifacts/income-release-tools/v1.8.1`; a fresh checkout must install the same official version. The v4 helper depends only on already-deployed core, REV, omnichain and router-terminal contracts; no stock Sticky build is part of this release.

Compile and test the Homerun profile with full verification input, then generate the packet:

```sh
node scripts/test-contracts.mjs --build-info
node --import tsx scripts/prepare-income-release.mts > docs/INCOME_RELEASE_MANIFEST.json
```

These commands do not invoke a deployment script. The packet records dependency revisions, tracked changes, lockfile hashes, source graphs and compiler-input fingerprints separately; a commit identifier alone is insufficient while files are changing. Freeze the reviewed source, lockfiles and verification artifacts before any later contract release.

## Local rehearsal coverage

Earlier stock Sticky rehearsals (six networks in an isolated local VM, Arbitrum pending) belonged to the v3 profile, whose helper wired the Sticky deployer and token distributor into its constructor. The v4 helper does not: ongoing holder rewards are deferred, the owner holds INCOME's reserved split, and Sticky will be connected later by redirecting that split. Those rehearsal logs remain ignored under `../Sticky/cache/homerun-release-rehearsal` as history only, and the former `rehearse-income-release.mts` script was removed with them. A v4 helper rehearsal (isolated Forge VM load of the exact artifact, immutable-word and runtime verification, CREATE2 reuse) is still to be written before any deployment.

## Deployment dependencies and current blockers

| Component | Required constructor / creation boundary |
| --- | --- |
| `HomerunDeployer` | The same complete ordered eight-chain dependency array on every network |

The installed `@bananapus/nana-sdk-core` has canonical core, omnichain, router-terminal, Revnet, USDC and CCIP records; the Homerun hook and helper come from `src/lib/homerun-addresses.ts` until the registry carries them.

Required evidence for the current v4 release:

1. Executed receipts for the shared helper deployments, with chain, transaction, block hash, constructor calldata, factory and salt, and each chain's `setChainSpecificConstants` receipt from the configurator. A proposal or simulation is insufficient.
2. Per-chain source/runtime/immutable verification. Verify both launch selectors, every `usdcOf` entry, `CONTROLLER`, `TERMINAL`, `ROUTER_TERMINAL_REGISTRY` and the local core/REV/omnichain bindings.
3. Every directed SDK CCIP route's allowlisting, directory/tokens, singleton, router, remote selector and chain ID, plus matching reciprocal default peers. The helper accepts an approved compatible route; registry approval alone does not prove two independently selected deployer generations produce matching peers. The packet records the exact SDK route addresses for review.
4. Initial project relationships: the FUND launched by the helper with its deployed ERC-20, FUND owner control of INCOME, the single unlocked reserved split to the owner, and the recorded helper auto-issuance matching the manifest's local amount. Preserve actual project IDs and addresses from receipts, never predictions.
5. Publish executed-chain artifacts through `juice-sdk-v4/packages/core`: update registry types and artifact inputs, use the SDK's generators, publish the package, and pin its release in Homerun. Do not hand-edit only generated output or insert simulation addresses. Re-run runtime wiring checks and testnet transaction/bridge smoke flows against that SDK before enabling the corresponding chains.

The packet is concrete preparation for those remaining deployment and verification steps. It does not claim the new helper is audited or that an unavailable deployment is ready for use.
