# Deploying the Homerun contracts

Homerun's contracts deploy through the same Sphinx proposal workflow and canonical CREATE2 factory as the other Juicebox V6 repositories, under the `homerun` Sphinx project and its 1-of-3 `V6 Jango` Safe (`0xd5136c794ee43BEf1eD4cF1eB6DEe45b7F803437`, the same address on every chain). The rollout lives in this repository: `script/Deploy.s.sol:Deploy` is the production entrypoint, `script/helpers/HomerunDeployment.sol` holds the restartable deployment and verification logic, and `script/deploy.mjs` runs it per network group. Nothing here is executed by `deploy-all-v6`.

## What gets deployed

Two singletons, in this order, both with the salt `HomerunV6`:

1. `HomerunAllowlistHook`, constructed with the canonical `JBProjects`, the controller's `JBPermissions` and the trusted forwarder of the local `JBOmnichainDeployer`.
2. `HomerunDeployer`, constructed with `REVDeployer`, `JBOmnichainDeployer`, the allowlist hook and the Safe as its one-time configurator. The controller and the router terminal registry are read from `REVDeployer` in the constructor.

Every constructor argument of both contracts is the same address on all eight chains, so the hook and the deployer each have one address on every mainnet (Ethereum, Optimism, Base, Arbitrum) and every testnet (their Sepolias). USDC is the only chain-specific value. In the same proposal the Safe calls `HomerunDeployer.setChainSpecificConstants` once per chain with one `HomerunChainConfig` per chain of the network group, in ascending chain ID: chain ID, `REVDeployer`, USDC, `JBOmnichainDeployer` and the allowlist hook. The deployer requires every entry's protocol addresses to be its own, stores every chain's USDC for sucker mappings, checks the local USDC's 6 decimals, and refuses a second call. Only the Safe can configure, so a stranger who sends the identical creation code first gains nothing.

## Reproducible checkout

The contracts compile against the sibling protocol checkouts named in `remappings.txt` (`../../nana-core-v6` and so on), not npm packages. `script/deploy.mjs` pins the reviewed commit of every sibling that appears in the compiled deployer's `metadata.sources` (eleven checkouts) and the version of every npm package reached through their `node_modules` (OpenZeppelin, Permit2, Solady, PRBMath, Chainlink CCIP); proposals and verification refuse a sibling at another commit or with changes under its `src/` (tests and scratch files do not compile into the contracts), a package at another version, and an uncommitted Homerun checkout. Rehearsals allow development changes. Update the pins when a reviewed revision changes, and rerun every rehearsal. `npm run test:deployment` checks that the pin set still covers every source root of the compiled artifact.

Use the Foundry and Node versions the workspace uses, then:

```sh
npm ci
forge fmt --check
npm run test:contracts
npm run test:deployment
sh scripts/forge.sh build --sizes --skip '*/test/**'
```

`scripts/forge.sh` and every deployment command give Foundry absolute remapping targets (see `scripts/forge-remappings.mjs`); the external-library linker needs them when the sibling packages are compiled.

Changing source, compiler settings, sibling revisions, USDC addresses, or protocol artifacts changes the CREATE2 predictions. All chains of a group must use the same reviewed checkout to obtain matching addresses.

## Configuration and preflight

Provide RPC endpoints for the intended group and, for proposals, `SPHINX_ORG_ID`, `SPHINX_API_KEY` and `SPHINX_MANAGED_BASE_URL` for the existing Sphinx organization. The variable names are listed in `.env.example`. To reuse the workspace setup without copying credentials:

```sh
export HOMERUN_ENV_FILE=../../deploy-all-v6/.env
```

An explicit `HOMERUN_ENV_FILE` must exist; otherwise the commands load this package's `.env` when present, or the current environment. The commands select the `deploy` Foundry profile (`isolate = false`), which Sphinx requires. Never commit credentials.

| Sphinx / RPC alias | Environment variable | Artifact folder |
| --- | --- | --- |
| ethereum | RPC_ETHEREUM_MAINNET | ethereum |
| optimism | RPC_OPTIMISM_MAINNET | optimism |
| base | RPC_BASE_MAINNET | base |
| arbitrum | RPC_ARBITRUM_MAINNET | arbitrum |
| ethereum_sepolia | RPC_ETHEREUM_SEPOLIA | sepolia |
| optimism_sepolia | RPC_OPTIMISM_SEPOLIA | optimism_sepolia |
| base_sepolia | RPC_BASE_SEPOLIA | base_sepolia |
| arbitrum_sepolia | RPC_ARBITRUM_SEPOLIA | arbitrum_sepolia |

Protocol addresses come from the sibling `deployments/<network>/` trees: `revnet-core-v6/…/REVDeployer.json` and `nana-omnichain-deployers-v6/…/JBOmnichainDeployer.json`. Preflight also compares each artifact with the Nana SDK's deployment registry and refuses a disagreement. `HOMERUN_WORKSPACE_PATH` (default `../..`) overrides the workspace root; a path outside the committed `fs_permissions` in `foundry.toml` needs an extra read permission. USDC addresses are fixed in the helper and match `deploy-all-v6`'s `JBChainTokens`. Every chain of the group is read on every chain, and each artifact must record its chain ID; only the connected chain's dependencies are checked live: code, `isAllowedToSetFirstController`, the revnet owner's deployer binding, the revnet and omnichain deployers' controller, directory and sucker registry bindings, USDC's six decimals, and a working USD price feed for USDC in `JBPrices` (without it nothing launched here can be paid).

The committed `sphinx.lock` is the public organization/project/Safe configuration (regenerate it with `node_modules/.bin/sphinx sync`), not credentials. The proposal runner checks that it names the script's `homerun` project and matches `SPHINX_ORG_ID`; `Deploy.run()` refuses any Safe other than `0xd5136c794ee43BEf1eD4cF1eB6DEe45b7F803437`.

## Network-group commands

```sh
npm run deploy:preflight:testnets
npm run deploy:rehearse:testnets
npm run deploy:propose:testnets
# Only after the Sphinx proposal has executed:
npm run deploy:post:testnets
```

The same four exist for `mainnets`; `deploy:testnets` / `deploy:mainnets` alias the proposal commands.

Preflight checks the group's RPC variables and the four protocol artifacts per destination without contacting RPCs. Rehearsal reads a canonical RPC block per destination, pins Forge to it, binds the run to the expected chain ID, checks live bindings, and runs the deployment helper twice: fresh deployment, partial recovery, or verified reuse, then the repeat. It writes `deployments/<network>/simulation.json`, which is ignored and is not deployment evidence. After the group's rehearsals the runner requires every chain to have predicted the same hook, deployer and protocol configuration hash. Proposal reruns the whole group's rehearsals, verifies the pins, then invokes the pinned local Sphinx CLI; a failed or divergent chain stops the command before submission. `deploy:post:*` runs the read-only `Verify` on every destination, requires the same agreement, and writes `deployments/<network>/verified.json`; it then runs `deploy:artifacts:*` (`script/artifacts.mjs`), which verifies both sources on Etherscan (one v2 key for every chain) and writes `deployments/<network>/HomerunAllowlistHook.json` and `HomerunDeployer.json` in the `sphinx-sol-ct-artifact-1` layout the other V6 repositories keep: address, ABI, decoded constructor arguments, creation receipt, bytecode, metadata and source revision. Commit both kinds of file. `npm run check:networks` then proves the client's wiring read-only through the app's own RPC path: every chain's registered hook and deployer exist, every deployer immutable matches the protocol, the creation fee and USDC/USD feed are live, and the CCIP peer deployers the launch would name are allowlisted with the USDC mappings the deployer requests.

The commands record the current commit as `HOMERUN_REVISION`, with `-dirty` appended when the checkout has changes. Commit the reviewed release and rerun its rehearsals before proposing; verify with the identical checkout. Single-chain diagnosis:

```sh
set -a; . ../../deploy-all-v6/.env; set +a
export FOUNDRY_PROFILE=deploy HOMERUN_REVISION="$(git rev-parse HEAD)"
sh scripts/forge.sh script script/Rehearse.s.sol:Rehearse --rpc-url ethereum_sepolia -vv
sh scripts/forge.sh script script/Verify.s.sol:Verify --rpc-url ethereum_sepolia -vv
```

`deploy:broadcast:<group>` sends the missing deployment transactions from `HOMERUN_DEPLOYER_KEY` through the canonical factory on every destination (`script/Broadcast.s.sol:Broadcast`), then rehearses every destination, which simulates the Safe's configuration of what the broadcast deployed. The factory derives every address from the salt and creation code alone, so a broadcast and a proposal land on the same addresses. The key cannot set the chain-specific constants, so follow a broadcast with `deploy:propose:<group>`, whose proposal skips the existing contracts and only configures them, then `deploy:post:<group>`. Like a proposal it refuses an uncommitted checkout and re-checks the dependency pins. Do not run `forge script --broadcast` by hand; use the runner so every destination is verified.

## What a repeated run accepts

A repeated collection or rehearsal skips an existing contract only after checking its compiled runtime against the current artifact, masking only compiler-reported immutable words (every occurrence of an immutable must agree). It then checks every immutable binding through the getters: the hook's `PROJECTS` and forwarder; the deployer's controller, projects, tokens, revnet deployer and owner, terminal, omnichain deployer, router registry, hook and forwarder. The deployer's configurator has no getter; the CREATE2 address binds it, since it is a constructor argument. Before writing a manifest it also checks the configured `USDC` and every `usdcOf`. Unexpected code or bindings fail the run rather than silently reusing a contract. A changed source revision deploys new predictions; it never upgrades or replaces an earlier deployment.

## Interference and recovery

The canonical factory is permissionless, so anyone can send the byte-identical creation code first. That cannot substitute different code (the address commits to the exact creation code, and every immutable is derived from chain state the constructor reads), and it cannot configure the deployer, which only the Safe can, but the Safe's transaction for that contract then reverts on the CREATE2 collision and Sphinx marks that chain's deployment failed. Rerun the rehearsal and a new proposal: an existing contract that passes the runtime and binding checks is reused, and only the missing ones are collected.

The build runs with absolute remapping targets, so standard-JSON source names carry the workspace path; the bytecode does not (`bytecode_hash = "none"`).

## After execution

Retain the Sphinx proposal and transaction receipts with the verified manifests. `verified.json` records the chain context, source revision, addresses, salt, protocol configuration hash and complete runtime hashes; on Arbitrum the `rpcBlock*` fields identify the L2 block and the `evm*` fields the L1 context. Deployment start blocks for client event discovery come from execution receipts, not manifests.

The site does not read these manifests. Publish the executed addresses to the Nana SDK deployment registry through its release process; until then `HomerunDeployer` and `HomerunAllowlistHook` remain unregistered and the native launch stays unavailable.
