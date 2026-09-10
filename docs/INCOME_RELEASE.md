# INCOME release evidence

**Status: source and offline release evidence prepared; contract deployments and proposal submission deferred.** This packet describes `homerun-income-global-stock-sticky-v2-candidate`. It replaces the earlier single-chain draft; its constructor, allocation domain, local vault caps and bridge policy are different. No contract has been deployed or signed by this preparation. The app keeps features that require missing verified deployment records unavailable until a later contract release and SDK publication.

[INCOME_RELEASE_MANIFEST.json](INCOME_RELEASE_MANIFEST.json) records the exact source graph, artifact hashes, locations and hashes of full compiler inputs, constructors, size checks, installed SDK addresses, and remaining blockers. The full build files remain local, ignored artifacts; the manifest does not embed them. [prepare-income-release.mts](../scripts/prepare-income-release.mts) regenerates it using local files only. It has no RPC, wallet, broadcast, registry-write, or address-override option. Predictions and locally compiled templates never establish deployed addresses or live runtime identity.

## Global release profile

The same `HomerunIncomeDeployer` artifact takes one ordered array of eight chain configurations. Each entry is `(uint32 chainId, address controller, address revDeployer, address tokenDistributor, address usdc, address stickyDeployer, address omnichainDeployer)`.

The complete array is identical on every network and sorted numerically:

```
1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420
```

The helper selects its local dependencies from that array during construction. `PROTOCOL_CONFIG_HASH = keccak256(abi.encode(chains))` must match on all eight networks. Local immutable values, including USDC, can differ, so **identical CREATE2 addresses do not imply identical deployed runtime hashes**. Verify every chain independently.

Use the canonical deterministic factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` and the prepared release salt:

```
keccak256(UTF8("homerun.income-deployer.global.v2"))
0xc86981997c4d58e74ea847e64cb14d90ecc409f6f9455f143c80a6e61031c086
```

This is a reproducible release constant, not a deployment record. All eight transactions must use the same creation bytecode, complete constructor calldata, factory, and salt. Changing the array or artifact changes the predicted helper address and breaks the standard same-address linked Revnet route. The current packet leaves the helper's encoded constructor, initcode hash, protocol configuration hash and address **null** because the required Sticky/distributor registry inputs are missing. It does not insert old simulation predictions.

Mainnet projects link Ethereum, Optimism, Base and Arbitrum; test projects use their four test networks. These are separate launch groups using the same eight-network helper profile, not separate helper constructor arrays. Each initial allocation requires exactly one linked FUND project per participating chain.

The initial supply is one global 500,000 INCOME allocation. A finalized historical report includes live ERC-20 balances, credits, operator FUND and unsettled Sucker rights; pending bridge claims retain the destination chain, preserving contract-wallet identity. Beneficial custody ownership retains exact rational FUND weights before allocating INCOME. A holder with less than one FUND atom can therefore have a zero integer display balance and a positive INCOME claim. Local vault caps sum to 500,000. Empty chains receive zero-cap vaults, and positive FUND dust that rounds to zero INCOME remains in the public manifest. Claims transfer already-minted INCOME to fixed beneficiaries, with no stake requirement, deadline, vesting or administrator.

The immutable Merkle roots remain **operator attestations**. Membership proofs do not establish historical truth, completeness or correct totals. The client reconstructs the full global history and reconciles the public manifest before review. The domain is:

```
HomerunInitialIncome(uint256 chainId,address deployer,uint256 fundProjectId,bytes32 sourceSetHash,uint256 totalFundSupply,bytes32 salt)
```

`sourceSetHash` commits the complete canonical global report; the helper's effective REV description salt additionally commits the manifest and all ordered local roots/counts. Every chain repeats the same nonzero global auto-issuance rows. Only the local allocation is minted and moved to its vault atomically; cross-chain launch and remote supply reporting retain stock REV asynchronous behavior. No global readiness oracle is added. A shared past start produces the stock seven-day local cash-out/loan delay, while local payments are available after launch.

Snapshot numbers and hashes use each chain's RPC block domain. Arbitrum One and Arbitrum Sepolia resolve that domain through canonical `ArbSys` at `0x64`; their Solidity `block.number` reports an L1-origin height. The helper checks recent L2 hashes through `arbBlockHash` and uses ordinary EVM hashes on other chains. Older snapshots remain explicitly operator-attested so Safe execution can outlive the 256-block history window. [Arbitrum's block-number reference](https://docs.arbitrum.io/arbitrum-essentials/arbitrum-vs-ethereum/block-numbers-and-time) explains the distinction.

All stages retain global cash-out accounting and the normal Sucker deployment/retry bit. Issuance begins at 10 INCOME/USD, falls 5% every 7,884,000 seconds for eight cuts, then stays fixed. The default reserved 80% splits 70/80 to operations and 10/80 to the local Sticky SHARE rewards. Both split rows remain locked through `type(uint48).max`. Stock Revnet identity excludes individual split weights and routing; the client verifies those commitments separately when continuing a linked launch.

Ongoing rewards use **stock, chain-local Sticky SHARE snapshots**, with zero Sticky exit tax, no minimum stake age and no age multiplier. The distributor profile is 604,800-second rounds, four vesting rounds, a 94,608,000-second claim duration, and both REV loan dependencies zero. `STARTING_TIMESTAMP` is its immutable deployment timestamp and must be positive and no later than the observed block. Four vesting rounds are not a staking eligibility delay. The ongoing claim window does not limit initial vault claims.

## Compilation and size evidence

Both profiles use Solidity `0.8.28+commit.7893614a`, optimizer enabled with 200 runs, `viaIR`, and Cancun. Homerun helper/vault artifacts use IPFS metadata hashing; stock Sticky uses **`metadata.bytecodeHash = none`**, matching its deployment configuration. Do not deploy stock singleton artifacts from the Homerun integration compilation.

The packet verifies every source hash in each artifact's compiler metadata and locates matching full build information with the exact compiler input and output. It rejects stale sources, changed constructor components/order, missing library links, missing build information and incompatible settings. Constructor validation recurses through the entire tuple array. Source-pattern checks are a guard against profile drift, not formal verification.

| Contract | Creation template | Runtime template | Full initcode / limit |
| --- | ---: | ---: | --- |
| `HomerunIncomeDeployer` | 30,167 bytes | 22,512 bytes | 32,023 bytes with the eight-entry constructor; below 49,152 |
| `HomerunInitialIncomeVault` | 4,122 bytes | 2,850 bytes | Measure its actual 13 arguments, including the UTF-8 manifest URI, on each launch |

The helper's constructor occupies `64 + 224 × 8 = 1,856` bytes. Its runtime has 2,064 bytes of EIP-170 headroom. EIP-3860 applies to **creation bytecode plus constructor arguments**, not the creation template alone. The script checks complete fixed singleton constructors and the known helper payload size even while dependency values are unavailable. A per-project vault's dynamic URI must be included in its own size and transaction simulation checks.

Runtime templates contain unresolved immutable words. Their hashes are not live code hashes. Verification must patch and compare **every immutable occurrence** using actual chain/project/constructor values, including full uint256 and EIP712 words. Keep the exact compiler input: the local integration build resolves remappings to absolute source paths, which enter IPFS metadata. Recompiling elsewhere with rewritten paths can change bytecode even if source contents match.

The global implementation passed 119 Forge tests using Foundry 1.8.1, including actual REV/Sticky/CCIP deployment identity across delayed chains, zero/partial local allocation, fractional beneficial ownership and Arbitrum snapshot clocks. The 204-holder case launches and every allocation claims. Its isolated CCIP fixture verifies deployment and peer identity, not transport delivery. The complete live-client suite passed 1,338 tests across 58 files. These results apply to the tested source; subsequent edits require refreshed evidence.

## Reproduce the packet

Use Foundry 1.8.1 (`982849d3140c01fd3b72905759581a132df7aa98`) on `PATH`. The recorded local release toolchain is in ignored `artifacts/income-release-tools/v1.8.1`; a fresh checkout must install the same official version. Compile stock with its own profile into ignored Homerun output, preserving script imports so the distributor artifact is present:

```sh
forge build --root ../JBSticky \
  --out "$PWD/artifacts/income-release-stock/out" \
  --cache-path "$PWD/artifacts/income-release-stock/cache" \
  --build-info-path "$PWD/artifacts/income-release-stock/build-info" \
  --build-info --offline --skip '*/test/**'
```

Compile and test the Homerun profile with full verification input, then generate the packet:

```sh
node scripts/test-contracts.mjs --build-info
node --import tsx scripts/prepare-income-release.mts > docs/INCOME_RELEASE_MANIFEST.json
```

These commands do not invoke a deployment script. The packet records dependency revisions, tracked changes, lockfile hashes, source graphs and compiler-input fingerprints separately; a commit identifier alone is insufficient while files are changing. Freeze the reviewed source, lockfiles and verification artifacts before any later contract release.

## Local rehearsal coverage

The pinned stock Sticky rehearsal completed both fresh creation and reuse in an isolated local VM on Ethereum, Optimism, Base, Sepolia, Optimism Sepolia and Base Sepolia. These six results are local simulations with no broadcast or live deployment receipt. Their unsigned packets and logs are ignored under `../JBSticky/cache/homerun-release-rehearsal`.

The Arbitrum One and Arbitrum Sepolia stock rehearsals did **not** complete. Foundry's Arbitrum `BLOCKHASH` lookup required an RPC call shape rejected by the restricted read-only transport. A separate read-only observation confirmed the live `ArbSys` block number and parent hash match the pinned L2 RPC headers on both networks; that observation does not replace the missing contract rehearsal. No dependency address or simulation success was inferred from it.

[rehearse-income-release.mts](../scripts/rehearse-income-release.mts) is the optional next rehearsal step. It requires all eight successful stock unsigned packets and matching simulation files, pinned Node 22.23.1 and Foundry 1.8.1. It loads the exact Homerun IPFS artifact into an isolated Forge VM, verifies every helper immutable and the complete runtime, checks CREATE2 reuse, and confirms the source fork remains unchanged. It never broadcasts, signs, uploads a proposal, or writes SDK/deployment records. Its `--prepare-only` mode also requires the complete eight-network evidence because the shared constructor commits every network's dependencies.

Those prerequisites are currently incomplete, so the helper's eight-network rehearsal has **not run**. The script reports missing evidence explicitly and leaves the offline registry-based packet usable. Completing these optional release rehearsals belongs to the deferred contract release work; it is not required to run the app against already verified core deployments.

## Deployment dependencies and current blockers

| Component | Required constructor / creation boundary |
| --- | --- |
| Stock `JBStickyDeployer` | Canonical V6 controller and multi-terminal; creates its hook as its nonce-1 child |
| Stock `JBTokenDistributor` | Canonical directory/controller, zero REVLoans/REVOwner, `604800`, `4`, `94608000` |
| Stock `JBStickyRewardPockets` | Actual verified distributor |
| Stock `JBStickyAutoStick` | Actual verified Sticky deployer and distributor |
| `HomerunIncomeDeployer` | The same complete ordered eight-chain dependency array on every network |
| Project SHARE/feed and initial vault | Created by their verified factories/project launch; actual events and immutable bindings identify them |

The installed `@bananapus/nana-sdk-core` 2.3.2 has canonical core, omnichain, Revnet, USDC and CCIP records, but no `JBStickyDeployer`, `JBTokenDistributor` or `HomerunIncomeDeployer` registry entry on any of the eight networks. All 24 missing entries are explicit in the packet. This is an observation of installed SDK data, not a claim that no contract exists elsewhere.

Stock's production entrypoint is [`script/Deploy.s.sol:Deploy`](../../JBSticky/script/Deploy.s.sol), using [`JBStickyDeployment.sol`](../../JBSticky/script/helpers/JBStickyDeployment.sol). Its established salts remain `bytes32("JBStickyDeployerV6")` for deployer/distributor/pockets and `bytes32("JBStickyAutoStickV6")` for the adapter. A later contract release should use its existing Sphinx proposal and execution workflow documented in [DEPLOYMENT.md](../../JBSticky/DEPLOYMENT.md). Local rehearsals have run as described above; no proposal was submitted and no execution workflow or agent wallet was authorized.

The earlier September 10 read-only check in [STICKY_REWARDS.md](STICKY_REWARDS.md) found empty code at three old simulation predictions on eight chains. That note lacks block hashes and says nothing about contracts at other addresses. The packet retains it as limited historical evidence and makes **zero additional RPC calls**.

Required release evidence:

1. Executed receipts for the reviewed Sticky and shared helper deployments, with chain, transaction, block hash, constructor calldata, factory and salt. A proposal or simulation is insufficient.
2. Per-chain source/runtime/immutable verification and factory/hook reciprocity. Verify helper `PROTOCOL_CONFIG_HASH`, every `usdcOf` entry, local core/REV/omnichain/Sticky bindings, distributor timing and zero-loan policy. Retain stock's real `verified.json` with the reviewed revision.
3. Every directed SDK CCIP route's allowlisting, directory/tokens, singleton, router, remote selector and chain ID, plus matching reciprocal default peers. The helper accepts an approved compatible route; registry approval alone does not prove two independently selected deployer generations produce matching peers. The packet records the exact SDK route addresses for review.
4. Initial project relationships: canonical FUND token, managed Sticky backing and SHARE identity, locked INCOME reserved splits, and immutable local vault source/root/manifest/cap with complete funding. Preserve actual project IDs and creation events.
5. Publish executed-chain artifacts through `juice-sdk-v4/packages/core`: update registry types and artifact inputs, use the SDK's generators, publish the package, and pin its release in Homerun. Do not hand-edit only generated output or insert simulation addresses. Re-run runtime wiring checks and testnet transaction/bridge smoke flows against that SDK before enabling the corresponding chains.

The packet is concrete preparation for those remaining deployment and verification steps. It does not claim the new helper/vault are audited or that an unavailable deployment is ready for use.
