import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { jbContractAddress, type JBChainId } from "@bananapus/nana-sdk-core";
import { v6Address } from "@bananapus/nana-sdk-core/v6";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getContractAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { initialFundRuleset } from "../src/lib/fund-contracts";
import {
  readFundProjectState,
  type FundProjectState,
} from "../src/lib/fund-state";
import type { FundOwnershipSnapshot } from "../src/lib/fund-snapshot";
import {
  readFundGlobalSnapshot,
  type FundGlobalSnapshot,
} from "../src/lib/fund-global-snapshot";
import { buildFundGlobalManifest } from "../src/lib/fund-global-manifest";
import {
  readStickyProjectState,
  type StickyProjectState,
} from "../src/lib/sticky-state";
import {
  recordStickyHash,
  stickySessionKey,
  type StickyPending,
  type StickyStorage,
} from "../src/lib/sticky-session";
import {
  beginStickyCreationSubmission,
  clearStickyCreationPending,
  prepareStickyCreate,
  readStickyCreated,
  readStickyCreationPending,
  saveStickyCreated,
  stickyCreateAbi,
  stickyCreatedKey,
  verifyStickyCreationExecution,
} from "../src/lib/sticky-create";
import { StickyCreate } from "../src/components/StickyCreate";

vi.mock("../src/lib/fund-state", async (original) => ({
  ...(await original<typeof import("../src/lib/fund-state")>()),
  readFundProjectState: vi.fn(),
}));
vi.mock("../src/lib/fund-global-snapshot", () => ({
  readFundGlobalSnapshot: vi.fn(),
}));
vi.mock("../src/lib/sticky-state", () => ({ readStickyProjectState: vi.fn() }));
vi.mock("../src/hooks/useWallet", () => ({
  useWallet: () => ({ address: OWNER }),
}));
vi.mock("../src/hooks/useSafeTx", () => ({
  useSafeTx: () => ({ phase: "idle", busy: false, error: null, send: vi.fn() }),
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
}));
vi.mock("../src/providers/Providers", () => ({ wagmiConfig: {} }));
vi.mock("../src/lib/safe-connector", () => ({
  isSafeConnection: () => false,
  waitForSafeExecutionHash: vi.fn(),
}));
vi.mock("../src/lib/jbcenter-ipfs", () => ({
  jbCenterIpfs: { pinJson: vi.fn() },
}));
const DEPLOYER = "0x1111111111111111111111111111111111111111",
  FUND = "0x2222222222222222222222222222222222222222",
  SHARE = "0x3333333333333333333333333333333333333333",
  OWNER = "0x4444444444444444444444444444444444444444",
  DISTRIBUTOR = "0x5555555555555555555555555555555555555555",
  IMPLEMENTATION = "0x8888888888888888888888888888888888888888";
const HOOK = getContractAddress({ from: DEPLOYER, nonce: 1n }),
  hash = (n: bigint) => toHex(n, { size: 32 }),
  EXECUTION = hash(700n);
const registry = jbContractAddress["6"] as Record<
    string,
    Partial<Record<JBChainId, Address>>
  >,
  oldFactory = registry.JBStickyDeployer,
  oldDistributor = registry.JBTokenDistributor;
const controller = v6Address("JBController", 1),
  terminal = v6Address("JBMultiTerminal", 1),
  tokens = v6Address("JBTokens", 1),
  directory = v6Address("JBDirectory", 1),
  projects = v6Address("JBProjects", 1);
const timestamp = 1_800_000_000n,
  name = "House SHARE",
  uri = "ipfs://bafyverifiedsharemetadata";
function fundState(): FundProjectState {
  return {
    chainId: 1,
    projectId: 7n,
    blockNumber: 120n,
    blockHash: hash(120n),
    blockTimestamp: timestamp,
    owner: OWNER,
    operator: OWNER,
    account: OWNER,
    controller,
    supportedController: true,
    knownOwnerWrapper: true,
    supportedTerminals: true,
    tokenAddress: FUND,
    tokenDecimals: 18,
    linkedChainIds: [1],
    linkedPeers: [],
    pendingReservedTokens: 0n,
    totalSupply: 100n,
    hasPendingRuleset: false,
    ruleset: {
      id: 77,
      duration: 0,
      weightCutPercent: 0,
      approvalHook: zeroAddress,
    },
    metadata: {
      ...initialFundRuleset().metadata,
      pausePay: true,
      cashOutTaxRate: 10_000,
      allowOwnerMinting: false,
    },
  } as FundProjectState;
}
function ownership(): FundOwnershipSnapshot {
  return {
    chainId: 1,
    projectId: 7n,
    blockNumber: 100n,
    blockHash: hash(100n),
    blockTimestamp: timestamp - 100n,
    creationBlockNumber: 10n,
    creationTransactionHash: hash(10n),
    owner: OWNER,
    tokenAddress: FUND,
    totalFundSupply: 100n,
    totalCreditSupply: 20n,
    totalErc20Supply: 80n,
    holders: [
      { holder: OWNER, balance: 100n, creditBalance: 20n, erc20Balance: 80n },
    ],
    evidence: {
      projects,
      controller,
      tokens,
      suckerRegistry: v6Address("JBSuckerRegistry", 1),
      eventCounts: { Mint: 1, DeployERC20: 1, ClaimTokens: 1, Transfer: 1 },
      candidateCount: 1,
      bridgePolicy: "no-historical-suckers",
    },
  };
}
function globalSnapshot(
  local: FundOwnershipSnapshot = ownership(),
): FundGlobalSnapshot {
  const project = {
    ...local,
    historicalSuckers: [],
    evidence: {
      ...local.evidence,
      bridgePolicy: "historical-graph-required" as const,
    },
  };
  return {
    kind: "homerun-global-fund-entitlements",
    version: 1,
    root: { chainId: 1, projectId: 7n },
    claimPolicy: "live-chain-and-pending-bridge-destination",
    historyAttestation: "complete-canonical-rpc-log-history-required",
    graph: {
      cuts: [
        {
          chainId: 1,
          blockNumber: local.blockNumber,
          blockHash: local.blockHash,
          blockTimestamp: local.blockTimestamp,
        },
      ],
      projects: [
        {
          chainId: 1,
          projectId: 7n,
          owner: local.owner,
          controller,
          historicalSuckers: [],
        },
      ],
      lanes: [],
    },
    projects: [project],
    bridges: [],
    entitlements: local.holders.map((holder) => ({
      claimChainId: 1,
      beneficiary: holder.holder,
      liveFundBalance: holder.balance,
      pendingFundBalance: 0n,
      fundBalance: holder.balance,
      sources: [
        {
          kind: "live-balance",
          chainId: 1,
          projectId: 7n,
          amount: holder.balance,
        },
      ],
    })),
    totals: {
      liveFundSupply: local.totalFundSupply,
      pendingFundSupply: 0n,
      globalFundSupply: local.totalFundSupply,
    },
  };
}
const manifest = (snapshot = globalSnapshot()) =>
  buildFundGlobalManifest(snapshot, {
    helper: DEPLOYER,
    launchSalt: hash(400n),
  });
function multiSnapshot(emptyLocal = false): FundGlobalSnapshot {
  const local = emptyLocal
    ? {
        ...ownership(),
        totalFundSupply: 0n,
        totalCreditSupply: 0n,
        totalErc20Supply: 0n,
        tokenAddress: null,
        holders: [],
      }
    : ownership();
  const report = globalSnapshot(local);
  const remote = {
    ...globalSnapshot().projects[0],
    chainId: 10 as const,
    projectId: 99n,
    blockNumber: 200n,
    blockHash: hash(200n),
    historicalSuckers: [SHARE],
  };
  report.projects[0].historicalSuckers = [FUND];
  report.projects.push(remote);
  report.graph.cuts.push({
    chainId: 10,
    blockNumber: 200n,
    blockHash: hash(200n),
    blockTimestamp: timestamp - 100n,
  });
  report.graph.projects[0].historicalSuckers = [FUND];
  report.graph.projects.push({
    chainId: 10,
    projectId: 99n,
    owner: OWNER,
    controller: v6Address("JBController", 10),
    historicalSuckers: [SHARE],
  });
  report.graph.lanes.push(
    {
      sourceChainId: 1,
      sourceProjectId: 7n,
      sourceSucker: FUND,
      destinationChainId: 10,
      destinationProjectId: 99n,
      destinationSucker: SHARE,
    },
    {
      sourceChainId: 10,
      sourceProjectId: 99n,
      sourceSucker: SHARE,
      destinationChainId: 1,
      destinationProjectId: 7n,
      destinationSucker: FUND,
    },
  );
  report.entitlements.push({
    claimChainId: 10,
    beneficiary: OWNER,
    liveFundBalance: 100n,
    pendingFundBalance: 0n,
    fundBalance: 100n,
    sources: [
      { kind: "live-balance", chainId: 10, projectId: 99n, amount: 100n },
    ],
  });
  report.totals.liveFundSupply += 100n;
  report.totals.globalFundSupply += 100n;
  return report;
}
function remoteClient(reorg = false): PublicClient {
  return {
    getChainId: vi.fn(async () => 10),
    getBlock: vi.fn(async () => ({
      number: 200n,
      hash: hash(reorg ? 999n : 200n),
    })),
  } as unknown as PublicClient;
}

type ReadRequest = {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
};
function clientFixture(
  options: {
    overrides?: Record<string, unknown>;
    finalized?: bigint;
    reorg?: bigint;
    customFund?: boolean;
    noCode?: Address;
  } = {},
) {
  const readContract = vi.fn(
    async ({
      address,
      functionName: fn,
      blockNumber,
    }: ReadRequest): Promise<unknown> => {
      expect([120n, 140n]).toContain(blockNumber);
      const label = address === DISTRIBUTOR ? `distributor.${fn}` : fn;
      if (Object.hasOwn(options.overrides ?? {}, label))
        return options.overrides![label];
      switch (fn) {
        case "CONTROLLER":
          return controller;
        case "TERMINAL":
          return terminal;
        case "TOKENS":
          return tokens;
        case "HOOK":
          return HOOK;
        case "DEPLOYER":
          return DEPLOYER;
        case "DIRECTORY":
          return directory;
        case "PROJECTS":
          return projects;
        case "STORE":
          return v6Address("JBTerminalStore", 1);
        case "TOKEN":
          return IMPLEMENTATION;
        case "REV_LOANS":
        case "REV_OWNER":
          return zeroAddress;
        case "ROUND_DURATION":
          return 604_800n;
        case "VESTING_ROUNDS":
          return 4n;
        case "CLAIM_DURATION":
          return 94_608_000;
        case "STARTING_TIMESTAMP":
          return timestamp - 1_000n;
        case "creationFee":
          return 123n;
        case "decimals":
          return 18;
        case "allSuckersOf":
          return [];
        case "name":
          return name;
        case "symbol":
          return "SHARE";
        case "uriOf":
          return uri;
        default:
          throw new Error(`Unexpected read ${fn}`);
      }
    },
  );
  const getBlock = vi.fn(
    async ({
      blockTag,
      blockNumber,
    }: {
      blockTag?: string;
      blockNumber?: bigint;
    }) => {
      const number =
        blockNumber ??
        (blockTag === "finalized" ? (options.finalized ?? 110n) : 120n);
      return {
        number,
        hash: hash(options.reorg === number ? 999n : number),
        timestamp,
      };
    },
  );
  const getCode = vi.fn(async ({ address }: { address: Address }) =>
    address === options.noCode
      ? "0x"
      : address === FUND
        ? options.customFund
          ? "0x6001"
          : `0x363d3d373d3d3d363d73${IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3`
        : "0x6000",
  );
  return {
    client: {
      getChainId: vi.fn(async () => 1),
      getBlock,
      readContract,
      getCode,
    } as unknown as PublicClient,
    readContract,
    getBlock,
  };
}
function storageFixture(): StickyStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}
const input = () => ({
  chainId: 1 as const,
  fundProjectId: 7n,
  account: OWNER,
  manifest: manifest(),
  name,
  projectUri: uri,
});
beforeEach(() => {
  localStorage.clear();
  registry.JBStickyDeployer = { 1: DEPLOYER };
  registry.JBTokenDistributor = { 1: DISTRIBUTOR };
  vi.mocked(readFundProjectState).mockReset().mockResolvedValue(fundState());
  vi.mocked(readFundGlobalSnapshot)
    .mockReset()
    .mockResolvedValue(globalSnapshot());
  vi.mocked(readStickyProjectState)
    .mockReset()
    .mockResolvedValue({
      chainId: 1,
      fundProjectId: 7n,
      stickyProjectId: 9n,
      blockNumber: 140n,
      blockHash: hash(140n),
      controller,
      fundToken: FUND,
      shareToken: SHARE,
      cashOutTaxRate: 0n,
      soulbound: true,
    } as StickyProjectState);
});
afterEach(() => {
  if (oldFactory) registry.JBStickyDeployer = oldFactory;
  else delete registry.JBStickyDeployer;
  if (oldDistributor) registry.JBTokenDistributor = oldDistributor;
  else delete registry.JBTokenDistributor;
});

describe("verified stock Sticky creation", () => {
  it("uses exact factory calldata, fee and stock locked-transfer settings after reconstructing a finalized snapshot", async () => {
    const { client } = clientFixture(),
      prepared = await prepareStickyCreate(client, input());
    expect(readFundGlobalSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        root: { chainId: 1, projectId: 7n },
        clients: new Map([[1, client]]),
        cuts: new Map([[1, { blockNumber: 100n, blockHash: hash(100n) }]]),
      }),
    );
    expect(prepared.request.address).toBe(DEPLOYER);
    expect(prepared.request.value).toBe(123n);
    const decoded = decodeFunctionData({
      abi: stickyCreateAbi,
      data: encodeFunctionData(prepared.request),
    });
    expect(decoded.args).toEqual([FUND, name, "SHARE", uri, 0n, [], true]);
    expect(prepared.localAllocation.snapshotBlockNumber).toBe("100");
  });
  it("never treats a predicted or absent deployment as authority", async () => {
    delete registry.JBStickyDeployer;
    await expect(
      prepareStickyCreate(clientFixture().client, input()),
    ).rejects.toThrow("Verified Sticky");
    expect(readFundGlobalSnapshot).not.toHaveBeenCalled();
  });
  it("rejects a snapshot ahead of finality before reconstructing history", async () => {
    await expect(
      prepareStickyCreate(clientFixture({ finalized: 99n }).client, input()),
    ).rejects.toThrow("Finalize");
    expect(readFundGlobalSnapshot).not.toHaveBeenCalled();
  });
  it("does not accept an internally consistent manifest whose balances differ from chain history", async () => {
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(
      globalSnapshot({
        ...ownership(),
        totalCreditSupply: 21n,
        totalErc20Supply: 79n,
        holders: [
          {
            holder: OWNER,
            balance: 100n,
            creditBalance: 21n,
            erc20Balance: 79n,
          },
        ],
      }),
    );
    await expect(
      prepareStickyCreate(clientFixture().client, input()),
    ).rejects.toThrow("independently reconstructed");
  });
  it.each([
    ["owner", { owner: SHARE }, "FUND owner"],
    [
      "minting",
      { metadata: { ...fundState().metadata, allowOwnerMinting: true } },
      "close minting",
    ],
    ["pending rules", { hasPendingRuleset: true }, "pending rulesets"],
  ])("blocks %s before creation", async (_label, patch, expected) => {
    vi.mocked(readFundProjectState).mockResolvedValue({
      ...fundState(),
      ...patch,
    } as FundProjectState);
    await expect(
      prepareStickyCreate(clientFixture().client, input()),
    ).rejects.toThrow(expected);
  });
  it.each([
    ["HOOK", SHARE, "Factory-created"],
    ["distributor.ROUND_DURATION", 86_400n, "stock weekly"],
    ["distributor.VESTING_ROUNDS", 0n, "stock weekly"],
    ["distributor.CLAIM_DURATION", 0, "stock weekly"],
    ["distributor.REV_LOANS", SHARE, "stock weekly"],
    ["distributor.REV_OWNER", SHARE, "stock weekly"],
    ["distributor.STARTING_TIMESTAMP", timestamp + 1n, "stock weekly"],
  ])("rejects inconsistent %s", async (key, value, expected) => {
    await expect(
      prepareStickyCreate(
        clientFixture({ overrides: { [key]: value } }).client,
        input(),
      ),
    ).rejects.toThrow(expected);
  });
  it("rejects custom token bytecode and missing contract code", async () => {
    await expect(
      prepareStickyCreate(clientFixture({ customFund: true }).client, input()),
    ).rejects.toThrow("canonical FUND ERC20");
    await expect(
      prepareStickyCreate(clientFixture({ noCode: DEPLOYER }).client, input()),
    ).rejects.toThrow("no code");
  });
  it("rejects snapshot or current-block reorganizations", async () => {
    await expect(
      prepareStickyCreate(clientFixture({ reorg: 100n }).client, input()),
    ).rejects.toThrow("chain changed");
    await expect(
      prepareStickyCreate(clientFixture({ reorg: 120n }).client, input()),
    ).rejects.toThrow("chain changed");
  });
});

describe("global Sticky prerequisites", () => {
  it("requires all source clients and reconstructs the full global cut before local creation", async () => {
    const report = multiSnapshot(),
      value = manifest(report),
      { client } = clientFixture(),
      remote = remoteClient();
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(report);
    await expect(
      prepareStickyCreate(client, { ...input(), manifest: value }),
    ).rejects.toThrow("every chain");
    expect(readFundGlobalSnapshot).not.toHaveBeenCalled();
    const clients = new Map([
      [1, client],
      [10, remote],
    ]);
    const prepared = await prepareStickyCreate(client, {
      ...input(),
      manifest: value,
      clients,
    });
    expect(prepared.manifest.allocations).toHaveLength(2);
    expect(prepared.localAllocation.fundProjectId).toBe("7");
    expect(readFundGlobalSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        clients,
        cuts: new Map([
          [1, { blockNumber: 100n, blockHash: hash(100n) }],
          [10, { blockNumber: 200n, blockHash: hash(200n) }],
        ]),
      }),
    );
  });
  it("creates Sticky on a locally empty chain with zero initial allocation and a positive global supply", async () => {
    const report = multiSnapshot(true),
      value = manifest(report),
      { client } = clientFixture();
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(report);
    vi.mocked(readFundProjectState).mockResolvedValue({
      ...fundState(),
      totalSupply: 0n,
      linkedChainIds: [1, 10],
    });
    const prepared = await prepareStickyCreate(client, {
      ...input(),
      manifest: value,
      clients: new Map([
        [1, client],
        [10, remoteClient()],
      ]),
    });
    expect(prepared.localAllocation.incomeAmount).toBe("0");
    expect(prepared.localAllocation.leafCount).toBe("0");
    expect(prepared.request.args[0]).toBe(FUND);
  });
  it("allows the current FUND owner to finish a frozen snapshot after NFT ownership changes", async () => {
    const report = globalSnapshot({ ...ownership(), owner: SHARE });
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(report);
    const prepared = await prepareStickyCreate(clientFixture().client, {
      ...input(),
      manifest: manifest(report),
    });
    expect(prepared.fund.owner).toBe(OWNER);
  });
  it("accepts a canonical ERC20 deployed after a credits-only historical snapshot", async () => {
    const report = globalSnapshot({
      ...ownership(),
      tokenAddress: null,
      totalCreditSupply: 100n,
      totalErc20Supply: 0n,
      holders: [
        { holder: OWNER, balance: 100n, creditBalance: 100n, erc20Balance: 0n },
      ],
    });
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(report);
    const prepared = await prepareStickyCreate(clientFixture().client, {
      ...input(),
      manifest: manifest(report),
    });
    expect(prepared.request.args[0]).toBe(FUND);
  });
  it("rejects replacing a nonzero historical ERC20 even when the current token passes other gates", async () => {
    const report = globalSnapshot({ ...ownership(), tokenAddress: SHARE });
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(report);
    await expect(
      prepareStickyCreate(clientFixture().client, {
        ...input(),
        manifest: manifest(report),
      }),
    ).rejects.toThrow("Snapshot FUND token");
  });
  it("allows legitimate local supply movement after the fixed global snapshot", async () => {
    vi.mocked(readFundProjectState).mockResolvedValue({
      ...fundState(),
      totalSupply: 0n,
    });
    await expect(
      prepareStickyCreate(clientFixture().client, input()),
    ).resolves.toMatchObject({ fund: { totalSupply: 0n } });
  });
  it("rejects a source-chain reorg discovered after global history verification", async () => {
    const report = multiSnapshot(),
      { client } = clientFixture();
    vi.mocked(readFundGlobalSnapshot).mockResolvedValue(report);
    await expect(
      prepareStickyCreate(client, {
        ...input(),
        manifest: manifest(report),
        clients: new Map([
          [1, client],
          [10, remoteClient(true)],
        ]),
      }),
    ).rejects.toThrow("snapshot chain changed");
  });
  it("accepts only the verified empty canonical omnichain wrapper", async () => {
    const omni = {
      ...fundState(),
      linkedChainIds: [1, 10],
      metadata: {
        ...fundState().metadata,
        dataHook: v6Address("JBOmnichainDeployer", 1),
        useDataHookForPay: true,
        useDataHookForCashOut: true,
      },
      rulesetSnapshot: {
        omnichainHooks: {
          dataHook: zeroAddress,
          useDataHookForPay: false,
          useDataHookForCashOut: false,
          tiered721Hook: SHARE,
          tiered721UseDataHookForCashOut: false,
          tiered721HasTiers: false,
        },
      },
    } as FundProjectState;
    vi.mocked(readFundProjectState).mockResolvedValue(omni);
    await expect(
      prepareStickyCreate(clientFixture().client, input()),
    ).resolves.toBeDefined();
    for (const patch of [
      { dataHook: SHARE },
      { tiered721UseDataHookForCashOut: true },
      { tiered721HasTiers: true },
    ]) {
      vi.mocked(readFundProjectState).mockResolvedValue({
        ...omni,
        rulesetSnapshot: {
          ...omni.rulesetSnapshot,
          omnichainHooks: { ...omni.rulesetSnapshot.omnichainHooks, ...patch },
        },
      });
      await expect(
        prepareStickyCreate(clientFixture().client, input()),
      ).rejects.toThrow("no custom hooks");
    }
  });
  it("requires this exact FUND in the global allocation and a cut strictly before creation", async () => {
    await expect(
      prepareStickyCreate(clientFixture().client, {
        ...input(),
        fundProjectId: 8n,
      }),
    ).rejects.toThrow("does not include");
    vi.mocked(readFundProjectState).mockResolvedValue({
      ...fundState(),
      blockNumber: 100n,
    });
    await expect(
      prepareStickyCreate(clientFixture().client, input()),
    ).rejects.toThrow("must precede");
  });
});

async function pendingFixture() {
  const { client } = clientFixture(),
    prepared = await prepareStickyCreate(client, input()),
    storage = storageFixture();
  const record = beginStickyCreationSubmission(
    storage,
    prepared,
    OWNER,
    false,
    120n,
  );
  return { client, prepared, storage, record };
}
function executionClient(
  client: PublicClient,
  record: StickyPending,
  options: {
    emitter?: Address;
    caller?: Address;
    projectId?: bigint;
    reverted?: boolean;
    wrongPayload?: boolean;
    stateReorg?: boolean;
  } = {},
) {
  const topics = encodeEventTopics({
    abi: stickyCreateAbi,
    eventName: "DeploySticky",
    args: { projectId: options.projectId ?? 9n, stakedToken: FUND },
  });
  const data = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "bool" },
      { type: "address" },
    ],
    [SHARE, 0n, true, options.caller ?? OWNER],
  );
  const getTransactionReceipt = vi.fn(async () => ({
    transactionHash: EXECUTION,
    blockNumber: 130n,
    blockHash: hash(130n),
    status: options.reverted ? "reverted" : "success",
    logs: [{ address: options.emitter ?? DEPLOYER, topics, data }],
  }));
  return {
    ...client,
    getTransaction: vi.fn(async () => ({
      hash: EXECUTION,
      to: DEPLOYER,
      from: OWNER,
      input: options.wrongPayload ? "0xdeadbeef" : record.data,
      value: 123n,
      blockNumber: 130n,
      blockHash: hash(130n),
    })),
    getTransactionReceipt,
    getBlock: options.stateReorg
      ? vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
          number: blockNumber,
          hash: hash(blockNumber === 140n ? 999n : blockNumber),
          timestamp,
        }))
      : client.getBlock,
  } as unknown as PublicClient;
}
describe("creation recovery and duplicate protection", () => {
  it("saves exact calldata before submission and blocks another wallet from bypassing the pending creation", async () => {
    const { storage, record, prepared } = await pendingFixture();
    expect(readStickyCreationPending(storage, 1, 7n, SHARE)).toEqual(record);
    expect(() =>
      beginStickyCreationSubmission(storage, prepared, SHARE, false, 121n),
    ).toThrow("already has a saved");
    recordStickyHash(storage, stickySessionKey(1, 7n, OWNER), EXECUTION);
    expect(readStickyCreationPending(storage, 1, 7n)?.hash).toBe(EXECUTION);
  });
  it("keeps completed creation after clearing pending so reload cannot create again", async () => {
    const { storage, record, prepared } = await pendingFixture();
    saveStickyCreated(storage, record, EXECUTION, 9n);
    clearStickyCreationPending(storage, record);
    expect(readStickyCreationPending(storage, 1, 7n, OWNER)).toBeNull();
    expect(readStickyCreated(storage, 1, 7n)?.projectId).toBe("9");
    expect(() =>
      beginStickyCreationSubmission(storage, prepared, OWNER, false, 150n),
    ).toThrow("already has a saved");
  });
  it("fails closed on a malformed completion record", () => {
    const storage = storageFixture();
    storage.setItem(stickyCreatedKey(1, 7n), "{broken");
    expect(() => readStickyCreated(storage, 1, 7n)).toThrow("unreadable");
  });
  it("requires exact executed calldata, canonical event and live project before returning its ID", async () => {
    const { client, record } = await pendingFixture();
    const result = await verifyStickyCreationExecution(
      executionClient(client, record),
      record,
      EXECUTION,
    );
    expect(result.status === "confirmed" && result.projectId).toBe(9n);
    expect(readStickyProjectState).toHaveBeenCalledWith(expect.anything(), {
      chainId: 1,
      fundProjectId: 7n,
      stickyProjectId: 9n,
      account: OWNER,
    });
    await expect(
      verifyStickyCreationExecution(
        executionClient(client, record, { wrongPayload: true }),
        record,
        EXECUTION,
      ),
    ).rejects.toThrow("does not match");
    await expect(
      verifyStickyCreationExecution(
        executionClient(client, record, { emitter: SHARE }),
        record,
        EXECUTION,
      ),
    ).rejects.toThrow("canonical Sticky creation");
    await expect(
      verifyStickyCreationExecution(
        executionClient(client, record, { caller: SHARE }),
        record,
        EXECUTION,
      ),
    ).rejects.toThrow("event differs");
  });
  it("distinguishes a proven reverted execution without claiming a project was created", async () => {
    const { client, record } = await pendingFixture();
    expect(
      await verifyStickyCreationExecution(
        executionClient(client, record, { reverted: true }),
        record,
        EXECUTION,
      ),
    ).toEqual({ status: "reverted" });
    expect(readStickyProjectState).not.toHaveBeenCalled();
  });
  it("rejects a live state reorg after metadata verification", async () => {
    const { client, record } = await pendingFixture();
    await expect(
      verifyStickyCreationExecution(
        executionClient(client, record, { stateReorg: true }),
        record,
        EXECUTION,
      ),
    ).rejects.toThrow("current project block changed");
  });
  it("retains the unknown-submission lock after the component reloads", async () => {
    const { client, prepared } = await pendingFixture();
    beginStickyCreationSubmission(localStorage, prepared, OWNER, false, 120n);
    const container = document.createElement("div"),
      root = createRoot(container),
      onCreated = vi.fn();
    try {
      await act(async () => {
        root.render(
          createElement(StickyCreate, {
            state: fundState(),
            client,
            manifest: manifest(),
            launchUnavailable: true,
            onCreated,
          }),
        );
      });
      expect(container.textContent).toContain("wallet may have submitted");
      expect(container.textContent).not.toContain("Prepare Sticky creation");
      expect(onCreated).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("disables new preparation when FUND verification is unavailable", async () => {
    const { client } = clientFixture(),
      container = document.createElement("div"),
      root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          createElement(StickyCreate, {
            state: fundState(),
            client,
            manifest: manifest(),
            launchUnavailable: true,
            onCreated: vi.fn(),
          }),
        ),
      );
      expect(container.textContent).toContain("New SHARE creation is paused");
      expect(
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "Prepare Sticky creation",
        )?.disabled,
      ).toBe(true);
      expect(readFundGlobalSnapshot).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("revalidates completed creation with no manifest and reports it once without a recovery loop", async () => {
    const { client, record } = await pendingFixture();
    saveStickyCreated(localStorage, record, EXECUTION, 9n);
    const container = document.createElement("div"),
      root = createRoot(container),
      onCreated = vi.fn();
    const verifiedClient = executionClient(client, record);
    try {
      await act(async () => {
        root.render(
          createElement(StickyCreate, {
            state: fundState(),
            client: verifiedClient,
            manifest: null,
            launchUnavailable: true,
            onCreated,
          }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(onCreated).toHaveBeenCalledExactlyOnceWith(9n);
      expect(readStickyProjectState).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(
        "Sticky project 9 is confirmed and verified",
      );
      expect(container.textContent).not.toContain(
        "Verifying canonical creation",
      );
      await act(async () => {
        root.render(
          createElement(StickyCreate, {
            state: { ...fundState(), supportedController: false },
            client: verifiedClient,
            manifest: null,
            launchUnavailable: true,
            onCreated,
          }),
        );
      });
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(readStickyProjectState).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
