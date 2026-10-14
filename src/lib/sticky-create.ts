/** Stock Sticky creation. A snapshot is finalized before FUND can enter custody. */
import {
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbProjectsAbi,
  jbTokensAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import { v6Address } from "@bananapus/nana-sdk-core/v6";
import {
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getContractAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { FundTransaction } from "./fund-contracts";
import {
  assertFundStateForWrite,
  readFundProjectState,
  type FundProjectState,
} from "./fund-state";
import {
  fundGlobalManifestHash,
  parseFundGlobalManifest,
  verifyFundGlobalManifestHistory,
  type FundGlobalManifest,
  type GlobalIncomeAllocation,
} from "./fund-global-manifest";
import { closedFundIncomeBlockers } from "./income-launch";
import {
  registeredStickyContract,
  stickyDeployerAbi,
  stickyDistributorAbi,
  stickyHookAbi,
} from "./sticky-contracts";
import {
  readStickyProjectState,
  type StickyProjectState,
} from "./sticky-state";
import {
  clearStickyPending,
  readStickyPending,
  savedRecordAttempt,
  stickySessionKey,
  verifyStickyExecution,
  type StickyPending,
  type StickyStorage,
} from "./sticky-session";
import { writeIntentKey, type ReviewedWriteRecoveryRecord, type SavedAttempt } from "@bananapus/nana-sdk-core/review";

export const stickyCreateAbi = parseAbi([
  "function deployStickyFor(address stakedToken,string name,string symbol,string projectUri,uint256 cashOutTaxRate,address[] granters,bool soulbound) payable returns (uint256 projectId)",
  "event DeploySticky(uint256 indexed projectId,address indexed stakedToken,address token,uint256 cashOutTaxRate,bool soulbound,address caller)",
]);
// The stock webclient selects Locked and resets to that option for each launch.
export const STICKY_CREATE_SOULBOUND = true;
export const STICKY_CREATE_TAX = 0n;
const stockDistributorAbi = [
  ...stickyDistributorAbi,
  ...parseAbi(["function STARTING_TIMESTAMP() view returns (uint256)"]),
] as const;
export type StickyCreateInput = {
  chainId: JBChainId;
  fundProjectId: bigint;
  account: Address;
  manifest: unknown;
  clients?: ReadonlyMap<number, PublicClient>;
  name: string;
  projectUri: string;
};
export type PreparedStickyCreate = {
  request: FundTransaction;
  fund: FundProjectState;
  manifest: FundGlobalManifest;
  localAllocation: GlobalIncomeAllocation;
  manifestHash: Hex;
  deployer: Address;
  distributor: Address;
  hook: Address;
  creationFee: bigint;
};
function same(actual: Address, expected: Address, label: string) {
  if (!isAddressEqual(actual, expected))
    throw new Error(`${label} does not match the registered deployment.`);
}
export function stickyCreateBlockers(state: FundProjectState): string[] {
  const issues: string[] = [];
  if (!registeredStickyContract(state.chainId, "StickyDeployer"))
    issues.push("A verified Sticky factory is not registered on this network.");
  if (!registeredStickyContract(state.chainId, "JBTokenDistributor"))
    issues.push(
      "A verified SHARE reward distributor is not registered on this network.",
    );
  if (
    !state.supportedController ||
    !state.knownOwnerWrapper ||
    !state.supportedTerminals
  )
    issues.push("The FUND controller, owner, or terminals are unsupported.");
  if (!state.tokenAddress || state.tokenDecimals !== 18)
    issues.push("Deploy the canonical FUND ERC20 before creating SHARE.");
  issues.push(...closedFundIncomeBlockers(state));
  if (
    state.ruleset.duration !== 0 ||
    state.ruleset.weightCutPercent !== 0 ||
    !isAddressEqual(state.ruleset.approvalHook, zeroAddress)
  )
    issues.push("FUND must have no recurring or approval-controlled rules.");
  return issues;
}

/** Verify factory, hook and stock reward policy at one mined block. */
export async function verifyStickyCreateWiring(
  client: PublicClient,
  chainId: JBChainId,
  blockNumber: bigint,
) {
  const deployer = registeredStickyContract(chainId, "StickyDeployer"),
    distributor = registeredStickyContract(chainId, "JBTokenDistributor");
  if (!deployer || !distributor)
    throw new Error(
      "Verified Sticky and SHARE reward deployments are required.",
    );
  const controller = v6Address("JBController", chainId),
    tokens = v6Address("JBTokens", chainId),
    terminal = v6Address("JBMultiTerminal", chainId),
    directory = v6Address("JBDirectory", chainId),
    projects = v6Address("JBProjects", chainId),
    at = { blockNumber };
  const [
    actualController,
    actualTokens,
    actualTerminal,
    hook,
    distributorController,
    distributorDirectory,
    revLoans,
    revOwner,
    roundDuration,
    vestingRounds,
    claimDuration,
    startingTimestamp,
    block,
  ] = await Promise.all([
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "CONTROLLER",
      ...at,
    }),
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "TOKENS",
      ...at,
    }),
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "TERMINAL",
      ...at,
    }),
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "HOOK",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "CONTROLLER",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "DIRECTORY",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "REV_LOANS",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "REV_OWNER",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "ROUND_DURATION",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "VESTING_ROUNDS",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "CLAIM_DURATION",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stockDistributorAbi,
      functionName: "STARTING_TIMESTAMP",
      ...at,
    }),
    client.getBlock({ blockNumber }),
  ]);
  same(actualController, controller, "Sticky controller");
  same(actualTokens, tokens, "Sticky token registry");
  same(actualTerminal, terminal, "Sticky terminal");
  same(distributorController, controller, "Distributor controller");
  same(distributorDirectory, directory, "Distributor directory");
  same(
    hook,
    getContractAddress({ from: deployer, nonce: 1n }),
    "Factory-created Sticky hook",
  );
  if (
    !isAddressEqual(revLoans, zeroAddress) ||
    !isAddressEqual(revOwner, zeroAddress) ||
    roundDuration !== 604_800n ||
    vestingRounds !== 4n ||
    BigInt(claimDuration) !== 94_608_000n ||
    startingTimestamp <= 0n ||
    startingTimestamp > block.timestamp
  )
    throw new Error(
      "SHARE requires stock weekly rewards, four vesting rounds, a three-year claim window, and no distributor loans.",
    );
  const [
    hookDeployer,
    hookDirectory,
    controllerDirectory,
    controllerProjects,
    controllerTokens,
    terminalDirectory,
    terminalProjects,
    terminalTokens,
    terminalStore,
    directoryProjects,
    ...codes
  ] = await Promise.all([
    client.readContract({
      address: hook,
      abi: stickyHookAbi,
      functionName: "DEPLOYER",
      ...at,
    }),
    client.readContract({
      address: hook,
      abi: stickyHookAbi,
      functionName: "DIRECTORY",
      ...at,
    }),
    client.readContract({
      address: controller,
      abi: jbControllerAbi,
      functionName: "DIRECTORY",
      ...at,
    }),
    client.readContract({
      address: controller,
      abi: jbControllerAbi,
      functionName: "PROJECTS",
      ...at,
    }),
    client.readContract({
      address: controller,
      abi: jbControllerAbi,
      functionName: "TOKENS",
      ...at,
    }),
    client.readContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: "DIRECTORY",
      ...at,
    }),
    client.readContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: "PROJECTS",
      ...at,
    }),
    client.readContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: "TOKENS",
      ...at,
    }),
    client.readContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: "STORE",
      ...at,
    }),
    client.readContract({
      address: directory,
      abi: jbDirectoryAbi,
      functionName: "PROJECTS",
      ...at,
    }),
    ...[
      deployer,
      distributor,
      hook,
      controller,
      terminal,
      tokens,
      directory,
      projects,
    ].map((address) => client.getCode({ address, ...at })),
  ]);
  same(hookDeployer, deployer, "Hook deployer");
  same(hookDirectory, directory, "Hook directory");
  same(controllerDirectory, directory, "Controller directory");
  same(controllerProjects, projects, "Controller projects");
  same(controllerTokens, tokens, "Controller tokens");
  same(terminalDirectory, directory, "Terminal directory");
  same(terminalProjects, projects, "Terminal projects");
  same(terminalTokens, tokens, "Terminal tokens");
  same(terminalStore, v6Address("JBTerminalStore", chainId), "Terminal store");
  same(directoryProjects, projects, "Directory projects");
  if (codes.some((code) => !code || code === "0x"))
    throw new Error(
      "A required Sticky deployment has no code on this network.",
    );
  return { deployer, distributor, hook };
}

export async function prepareStickyCreate(
  client: PublicClient,
  input: StickyCreateInput,
): Promise<PreparedStickyCreate> {
  if (
    !input.name.trim() ||
    input.name.length > 160 ||
    !/^ipfs:\/\/[^\s/?#]+(?:\/[^\s]*)?$/.test(input.projectUri)
  )
    throw new Error("A SHARE name and published metadata URI are required.");
  if ((await client.getChainId()) !== input.chainId)
    throw new Error("The Sticky RPC is on a different network.");
  if (
    !registeredStickyContract(input.chainId, "StickyDeployer") ||
    !registeredStickyContract(input.chainId, "JBTokenDistributor")
  )
    throw new Error(
      "Verified Sticky and SHARE reward deployments are required.",
    );
  const parsed = parseFundGlobalManifest(input.manifest);
  const localAllocation = parsed.allocations.find(
    (allocation) =>
      allocation.chainId === input.chainId &&
      BigInt(allocation.fundProjectId) === input.fundProjectId,
  );
  if (!localAllocation)
    throw new Error(
      "The global ownership manifest does not include this FUND and network.",
    );
  const clients = new Map(input.clients ?? [[input.chainId, client]]);
  clients.set(input.chainId, client);
  if (parsed.allocations.some((allocation) => !clients.has(allocation.chainId)))
    throw new Error(
      "Provide verified RPC clients for every chain in the global ownership manifest.",
    );
  const finalized = await client.getBlock({ blockTag: "finalized" });
  if (
    finalized.number === null ||
    !finalized.hash ||
    BigInt(localAllocation.snapshotBlockNumber) > finalized.number
  )
    throw new Error(
      "Finalize the initial FUND ownership snapshot before creating Sticky.",
    );
  const manifest = await verifyFundGlobalManifestHistory(clients, parsed);
  const fund = await readFundProjectState(client, {
    chainId: input.chainId,
    projectId: input.fundProjectId,
    account: input.account,
  });
  assertFundStateForWrite(fund, input.account);
  const blockers = stickyCreateBlockers(fund);
  if (blockers.length) throw new Error(blockers.join(" "));
  same(fund.owner, input.account, "FUND owner");
  // The full report has just been reconstructed from canonical history. Keep
  // the historical token identity, without treating local supply as
  // constant: legitimate bridges can move it after this fixed global cut.
  const report = manifest.snapshot as {
    projects: {
      chainId: number;
      projectId: string;
      owner: Address;
      tokenAddress: Address | null;
    }[];
  };
  const historical = report.projects.find(
    (project) =>
      project.chainId === input.chainId &&
      BigInt(project.projectId) === input.fundProjectId,
  );
  if (!historical)
    throw new Error(
      "The global report is missing this FUND's ownership history.",
    );
  if (!fund.tokenAddress)
    throw new Error("Deploy the canonical FUND ERC20 before creating SHARE.");
  if (historical.tokenAddress)
    same(historical.tokenAddress, fund.tokenAddress, "Snapshot FUND token");
  if (BigInt(localAllocation.snapshotBlockNumber) >= fund.blockNumber)
    throw new Error(
      "The ownership snapshot must precede this Sticky creation.",
    );
  const { deployer, distributor, hook } = await verifyStickyCreateWiring(
    client,
    input.chainId,
    fund.blockNumber,
  );
  const at = { blockNumber: fund.blockNumber };
  const [implementation, tokenCode, creationFee, tokenDecimals] =
    await Promise.all([
      client.readContract({
        address: v6Address("JBTokens", input.chainId),
        abi: jbTokensAbi,
        functionName: "TOKEN",
        ...at,
      }),
      client.getCode({ address: fund.tokenAddress, ...at }),
      client.readContract({
        address: v6Address("JBProjects", input.chainId),
        abi: jbProjectsAbi,
        functionName: "creationFee",
        ...at,
      }),
      client.readContract({
        address: fund.tokenAddress,
        abi: erc20Abi,
        functionName: "decimals",
        ...at,
      }),
    ]);
  const expected =
    `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
  if (
    !tokenCode ||
    isAddressEqual(implementation, zeroAddress) ||
    keccak256(tokenCode) !== keccak256(expected) ||
    tokenDecimals !== 18
  )
    throw new Error("Sticky requires the canonical FUND ERC20.");
  const sameBlock = await client.getBlock({ blockNumber: fund.blockNumber });
  if (sameBlock.hash !== fund.blockHash)
    throw new Error(
      "The chain changed during Sticky creation preparation. Refresh and try again.",
    );
  await Promise.all(
    manifest.allocations.map(async (allocation) => {
      const source = clients.get(allocation.chainId)!;
      const block = await source.getBlock({
        blockNumber: BigInt(allocation.snapshotBlockNumber),
      });
      if (
        (await source.getChainId()) !== allocation.chainId ||
        block.hash !== allocation.snapshotBlockHash
      )
        throw new Error(
          "A snapshot chain changed during Sticky creation preparation. Refresh the global ownership history.",
        );
    }),
  );
  return {
    fund,
    manifest,
    localAllocation,
    manifestHash: fundGlobalManifestHash(manifest),
    deployer,
    distributor,
    hook,
    creationFee,
    request: {
      chainId: input.chainId,
      address: deployer,
      abi: stickyCreateAbi,
      functionName: "deployStickyFor",
      args: [
        fund.tokenAddress,
        input.name.trim(),
        "SHARE",
        input.projectUri,
        STICKY_CREATE_TAX,
        [],
        STICKY_CREATE_SOULBOUND,
      ],
      value: creationFee,
    },
  };
}

export type StickyCreationResult =
  | { status: "reverted" }
  | { status: "confirmed"; projectId: bigint; state: StickyProjectState };
/** Local IDs never prove creation. Verify the exact saved call, canonical event and live project. */
export async function verifyStickyCreationExecution(
  client: PublicClient,
  record: StickyPending,
  executionHash: Hex,
): Promise<StickyCreationResult> {
  const deployer = registeredStickyContract(
    record.chainId as JBChainId,
    "StickyDeployer",
  );
  if (!deployer)
    throw new Error(
      "The saved Sticky factory is not in the verified deployment registry.",
    );
  same(record.target, deployer, "Saved Sticky factory");
  const decoded = decodeFunctionData({
    abi: stickyCreateAbi,
    data: record.data,
  });
  const [underlying, name, symbol, uri, tax, granters, soulbound] =
    decoded.args;
  if (
    decoded.functionName !== "deployStickyFor" ||
    tax !== STICKY_CREATE_TAX ||
    soulbound !== STICKY_CREATE_SOULBOUND ||
    granters.length ||
    symbol !== "SHARE"
  )
    throw new Error(
      "The saved creation does not match the reviewed stock Sticky configuration.",
    );
  const status = await verifyStickyExecution(client, record, executionHash);
  if (status === "reverted") return { status };
  const receipt = await client.getTransactionReceipt({ hash: executionHash });
  const events = receipt.logs
    .filter((log) => isAddressEqual(log.address, deployer))
    .flatMap((log) => {
      try {
        const event = decodeEventLog({
          abi: stickyCreateAbi,
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        return event.eventName === "DeploySticky" ? [event.args] : [];
      } catch {
        return [];
      }
    });
  if (events.length !== 1)
    throw new Error("Exactly one canonical Sticky creation event is required.");
  const event = events[0];
  if (
    event.projectId <= 0n ||
    event.projectId === BigInt(record.projectId) ||
    !isAddressEqual(event.stakedToken, underlying) ||
    !isAddressEqual(event.caller, record.holder) ||
    event.cashOutTaxRate !== tax ||
    event.soulbound !== soulbound
  )
    throw new Error(
      "The Sticky creation event differs from the reviewed call.",
    );
  const state = await readStickyProjectState(client, {
    chainId: record.chainId as JBChainId,
    fundProjectId: BigInt(record.projectId),
    stickyProjectId: event.projectId,
    account: record.holder,
  });
  if (
    state.blockNumber < receipt.blockNumber ||
    !isAddressEqual(state.shareToken, event.token) ||
    !isAddressEqual(state.fundToken, underlying) ||
    state.cashOutTaxRate !== tax ||
    state.soulbound !== soulbound
  )
    throw new Error(
      "The created Sticky project does not match its confirmed event.",
    );
  const at = { blockNumber: state.blockNumber };
  const [actualName, actualSymbol, actualUri] = await Promise.all([
    client.readContract({
      address: state.shareToken,
      abi: erc20Abi,
      functionName: "name",
      ...at,
    }),
    client.readContract({
      address: state.shareToken,
      abi: erc20Abi,
      functionName: "symbol",
      ...at,
    }),
    client.readContract({
      address: state.controller,
      abi: jbControllerAbi,
      functionName: "uriOf",
      args: [event.projectId],
      ...at,
    }),
  ]);
  if (actualName !== name || actualSymbol !== symbol || actualUri !== uri)
    throw new Error("The SHARE metadata differs from the reviewed creation.");
  const [creationBlock, stateBlock] = await Promise.all([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getBlock({ blockNumber: state.blockNumber }),
  ]);
  if (
    creationBlock.hash !== receipt.blockHash ||
    stateBlock.hash !== state.blockHash
  )
    throw new Error(
      "The Sticky creation or current project block changed. Verify its execution again.",
    );
  return { status: "confirmed", projectId: event.projectId, state };
}

/** Completed creation stays saved before the pending lock is released. */
export type StickyCreatedRecord = {
  version: 1;
  pending: StickyPending;
  executionHash: Hex;
  projectId: string;
};
export const stickyCreatedKey = (chainId: number, fundProjectId: bigint) =>
  `homerun:sticky:created:v1:${chainId}:${fundProjectId}`;
export function readStickyCreated(
  storage: StickyStorage,
  chainId: number,
  fundProjectId: bigint,
): StickyCreatedRecord | null {
  const value = storage.getItem(stickyCreatedKey(chainId, fundProjectId));
  if (value === null) return null;
  let parsed: StickyCreatedRecord;
  try {
    parsed = JSON.parse(value) as StickyCreatedRecord;
  } catch {
    throw new Error(
      "The saved Sticky creation is unreadable. Recover it before creating another project.",
    );
  }
  if (
    parsed.version !== 1 ||
    !parsed.pending ||
    !/^0x[\da-fA-F]{64}$/.test(parsed.executionHash) ||
    !/^[1-9]\d*$/.test(parsed.projectId)
  )
    throw new Error(
      "The saved Sticky creation is invalid. Recover its execution before continuing.",
    );
  const record = readStickyPending(
    { ...storage, getItem: () => JSON.stringify(parsed.pending) },
    stickySessionKey(chainId, fundProjectId, parsed.pending.holder),
  );
  if (!record || BigInt(parsed.projectId) === fundProjectId)
    throw new Error("The saved Sticky creation belongs to a different FUND.");
  return { ...parsed, pending: record };
}
export function saveStickyCreated(
  storage: StickyStorage,
  record: StickyPending,
  executionHash: Hex,
  projectId: bigint,
): void {
  const value: StickyCreatedRecord = {
    version: 1,
    pending: record,
    executionHash,
    projectId: projectId.toString(),
  };
  const key = stickyCreatedKey(record.chainId, BigInt(record.projectId)),
    serialized = JSON.stringify(value);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized)
    throw new Error(
      "The browser could not save the confirmed Sticky creation. Keep its pending record and execution hash.",
    );
}

const creationPendingKey = (chainId: number, fundProjectId: bigint) =>
  `homerun:sticky:create-pending:v1:${chainId}:${fundProjectId}`;
/** A FUND-wide pointer keeps another wallet/owner from bypassing an unresolved creation. */
export function readStickyCreationPending(
  storage: StickyStorage,
  chainId: number,
  fundProjectId: bigint,
  holder?: Address,
): StickyPending | null {
  const pointer = storage.getItem(creationPendingKey(chainId, fundProjectId));
  const key =
    pointer ??
    (holder ? stickySessionKey(chainId, fundProjectId, holder) : null);
  if (!key) return null;
  const pending = readStickyPending(storage, key);
  if (pointer && !pending)
    throw new Error(
      "The Sticky creation recovery record is missing. Restore it before another creation.",
    );
  if (
    pending &&
    (pending.chainId !== chainId ||
      pending.projectId !== fundProjectId.toString())
  )
    throw new Error("The saved Sticky creation belongs to a different FUND.");
  return pending;
}
/** A Sticky creation's hold: the FUND project it creates SHARE for, one at a time. TODO(SDK 2.38): the SDK's shared builder. */
export function stickyCreateIntent(fundProjectId: bigint): string {
  return writeIntentKey("sticky-create", { fund: fundProjectId });
}

/** The creation a reviewed call makes, as its execution is verified: the call, its sender and the snapshot block. */
export function stickyCreationRecord(
  prepared: PreparedStickyCreate,
  holder: Address,
  safe: boolean,
  hash?: Hex,
): StickyPending {
  const { request, fund } = prepared;
  return {
    version: 1,
    chainId: request.chainId,
    projectId: fund.projectId.toString(),
    holder,
    target: request.address,
    data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }),
    value: (request.value ?? 0n).toString(),
    label: "Create the FUND Sticky project and SHARE token",
    safe,
    submittedAt: Date.now(),
    afterBlock: fund.blockNumber.toString(),
    ...(hash ? { hash } : {}),
  };
}

/** A creation's exact request, from its saved record. */
export function stickyCreationRequest(record: StickyPending): FundTransaction {
  const { functionName, args } = decodeFunctionData({ abi: stickyCreateAbi, data: record.data });
  return { chainId: record.chainId, address: record.target, abi: stickyCreateAbi, functionName, args, value: BigInt(record.value) } as FundTransaction;
}

/** What a recovered Sticky creation proves: the record it was verified against, and the project it created. */
export type StickyCreationProof = { record: StickyPending; projectId: bigint };

/**
 * This FUND's Sticky creation as the SDK's saved-attempt recovery reads it: the saved completion
 * (re-proven on every load), else a record the journal saved before SDK holds, else the FUND's
 * creation hold alone (saved as unsent: the hold has any send). `authenticate` proves one
 * transaction is this FUND's creation; with no record, an account's own factory call names it.
 * `confirmRetirable` refuses while a completion is saved.
 */
export function stickyCreationAttempt(client: PublicClient, storage: StickyStorage, chainId: number, fundProjectId: bigint, account: Address, safe: boolean, saved: { completed: StickyCreatedRecord | null; pending: StickyPending | null },
  verify: typeof verifyStickyCreationExecution = verifyStickyCreationExecution): SavedAttempt<StickyCreationProof> {
  const record = saved.completed ? { ...saved.completed.pending, hash: saved.completed.pending.hash ?? saved.completed.executionHash } : saved.pending;
  const namespace = stickyCreateIntent(fundProjectId);
  const confirmRetirable = async () => !readStickyCreated(storage, chainId, fundProjectId);
  const authenticate: SavedAttempt<StickyCreationProof>["authenticate"] = async hash => {
    if (!hash) return { result: "unknown", reason: "No saved creation transaction to check." };
    const proven = record ?? stickyCreationFromTransaction(await client.getTransaction({ hash }), chainId, fundProjectId);
    const result = await verify(client, proven, hash);
    return result.status === "confirmed" ? { result: "proven", value: { record: proven, projectId: result.projectId } } : { result: "not-this", reason: "The creation reverted." };
  };
  return record ? savedRecordAttempt(record, namespace, authenticate, confirmRetirable)
    : { chainId, account, safe, namespaces: [namespace], saved: { started: false }, confirmRetirable, authenticate };
}
/** The creation an SDK hold holds, as the record its settled execution is verified against. */
export function stickyCreationFromHold(record: ReviewedWriteRecoveryRecord, fundProjectId: bigint): StickyPending {
  return {
    version: 1, chainId: record.chainId, projectId: fundProjectId.toString(), holder: record.account,
    target: record.call.to, data: record.call.data, value: record.call.value,
    label: "Create the FUND Sticky project and SHARE token", safe: record.safe,
    // ponytail: the hold keeps no prerequisite block; the exact call, event and live project still bind it.
    submittedAt: Number(record.submittedAt ?? Date.now()), afterBlock: "0",
    ...(record.hash ? { hash: record.hash } : {}),
  };
}
/**
 * The creation a settled transaction ran, as the record its execution is verified against: only an
 * account's own direct call to the factory carries its call. A Safe's execution names no proposal
 * here, so it can't be authenticated from the transaction alone.
 */
export function stickyCreationFromTransaction(
  transaction: { from: Address; to: Address | null; input: Hex; value: bigint },
  chainId: number,
  fundProjectId: bigint,
): StickyPending {
  if (!transaction.to) throw new Error("The settled creation has no factory call.");
  const { functionName } = decodeFunctionData({ abi: stickyCreateAbi, data: transaction.input });
  if (functionName !== "deployStickyFor") throw new Error("The settled transaction is not a Sticky creation.");
  return {
    version: 1, chainId, projectId: fundProjectId.toString(), holder: transaction.from, target: transaction.to,
    data: transaction.input, value: transaction.value.toString(), label: "Create the FUND Sticky project and SHARE token",
    safe: false, submittedAt: Date.now(), afterBlock: "0",
  };
}
export function clearStickyCreationPending(
  storage: StickyStorage,
  record: StickyPending,
): void {
  const projectId = BigInt(record.projectId),
    key = stickySessionKey(record.chainId, projectId, record.holder),
    pointer = creationPendingKey(record.chainId, projectId);
  clearStickyPending(storage, key, record);
  if (storage.getItem(key) === null && storage.getItem(pointer) === key)
    storage.removeItem(pointer);
}
