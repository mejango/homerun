import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jbContractAddress, type JBChainId } from "@bananapus/nana-sdk-core";
import { v6Address } from "@bananapus/nana-sdk-core/v6";
import {
  encodeEventTopics,
  encodeAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { initialFundRuleset } from "../src/lib/fund-contracts";
import {
  quoteStickyStake,
  quoteStickyUnstake,
  readIncomeStickyBinding,
  readStickyProjectState,
  readStickyRewards,
} from "../src/lib/sticky-state";
import { homerunIncomeDeployerAbi } from "../src/lib/income-contracts";
import { readInitialIncomeAllocation } from "../src/lib/income-allocation-state";

vi.mock("../src/lib/income-allocation-state", () => ({
  readInitialIncomeAllocation: vi.fn(),
}));

const DEPLOYER = "0x1111111111111111111111111111111111111111",
  FUND = "0x2222222222222222222222222222222222222222",
  SHARE = "0x3333333333333333333333333333333333333333",
  HOLDER = "0x4444444444444444444444444444444444444444",
  DISTRIBUTOR = "0x5555555555555555555555555555555555555555",
  HOOK = "0x6666666666666666666666666666666666666666",
  FEED = "0x7777777777777777777777777777777777777777",
  IMPLEMENTATION = "0x8888888888888888888888888888888888888888",
  INCOME = "0x9999999999999999999999999999999999999999";
const BLOCK = 1000n,
  HASH = `0x${"ab".repeat(32)}` as Hex,
  TIMESTAMP = 1_800_000_000n;
const registry = jbContractAddress["6"] as Record<
    string,
    Partial<Record<JBChainId, Address>>
  >,
  priorSticky = registry.JBStickyDeployer,
  priorDistributor = registry.JBTokenDistributor;
const currency = Number(BigInt(FUND) & 0xffffffffn);
const input = {
  chainId: 1 as const,
  fundProjectId: 7n,
  stickyProjectId: 9n,
  account: HOLDER,
};
beforeEach(() => {
  registry.JBStickyDeployer = { 1: DEPLOYER, 42161: DEPLOYER };
  registry.JBTokenDistributor = { 1: DISTRIBUTOR, 42161: DISTRIBUTOR };
});
afterEach(() => {
  if (priorSticky) registry.JBStickyDeployer = priorSticky;
  else delete registry.JBStickyDeployer;
  if (priorDistributor) registry.JBTokenDistributor = priorDistributor;
  else delete registry.JBTokenDistributor;
});
type Request = {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
  blockNumber?: bigint;
  account?: Address;
};
type Options = {
  chainId?: 1 | 42161;
  overrides?: Record<string, unknown>;
  reorg?: boolean;
  wrongChain?: boolean;
  customFund?: boolean;
  fail?: string;
  noCode?: boolean;
  metadata?: Record<string, unknown>;
  deployment?: Record<string, unknown>;
};
function fixture(options: Options = {}) {
  const chainId = options.chainId ?? 1,
    controller = v6Address("JBController", chainId),
    terminal = v6Address("JBMultiTerminal", chainId),
    tokens = v6Address("JBTokens", chainId),
    directory = v6Address("JBDirectory", chainId),
    owner = v6Address("REVOwner", chainId);
  const metadata = {
    ...initialFundRuleset().metadata,
    baseCurrency: 0xffffffff,
    cashOutTaxRate: 0,
    pauseCreditTransfers: true,
    allowSetCustomToken: true,
    allowAddPriceFeed: true,
    useDataHookForPay: true,
    useDataHookForCashOut: true,
    dataHook: HOOK,
    ...options.metadata,
  };
  const ruleset = {
    cycleNumber: 1,
    id: 77,
    basedOnId: 0,
    start: 1_799_000_000,
    duration: 0,
    weight: 10n ** 18n,
    weightCutPercent: 0,
    approvalHook: zeroAddress,
    metadata: 0n,
  };
  const readContract = vi.fn(async (request: Request): Promise<unknown> => {
    expect(request.blockNumber).toBe(BLOCK);
    const { address, functionName: fn, args = [] } = request;
    const label =
      fn === "tokenOf"
        ? address === HOOK
          ? "hookToken"
          : args[0] === 7n
            ? "fundToken"
            : args[0] === 11n
              ? "incomeToken"
              : "shareToken"
        : fn === "balanceOf"
          ? address === FUND
            ? "fundBalance"
            : address === SHARE
              ? "shareBalance"
              : "backing"
          : fn === "currentRulesetOf" && args[0] === 11n
            ? "incomeRuleset"
            : fn === "ownerOf" && args[0] === 11n
              ? "incomeOwner"
              : fn === "TOKENS" && address === SHARE
                ? "shareRegistry"
                : fn === "HOOK" && address === FEED
                  ? "feedHook"
                  : fn === "TOKEN" && address === FEED
                    ? "feedToken"
                    : fn;
    if (options.fail === label) throw new Error(`RPC failure: ${label}`);
    if (Object.hasOwn(options.overrides ?? {}, label))
      return options.overrides![label];
    switch (label) {
      case "CONTROLLER":
      case "controllerOf":
        return controller;
      case "TERMINAL":
      case "primaryTerminalOf":
        return terminal;
      case "TOKENS":
      case "shareRegistry":
        return tokens;
      case "HOOK":
      case "feedHook":
        return HOOK;
      case "fundToken":
      case "stakedTokenOf":
      case "UNDERLYING_TOKEN":
        return FUND;
      case "shareToken":
      case "hookToken":
      case "feedToken":
        return SHARE;
      case "incomeToken":
        return INCOME;
      case "ownerOf":
      case "DEPLOYER":
        return DEPLOYER;
      case "terminalsOf":
        return [terminal];
      case "currentRulesetOf":
        return [ruleset, metadata];
      case "incomeRuleset":
        return [ruleset, { ...metadata, dataHook: owner }];
      case "incomeOwner":
        return owner;
      case "priceFeedOf":
        return FEED;
      case "cashOutTaxRateOf":
        return 0n;
      case "payoutLimitsOf":
      case "surplusAllowancesOf":
        return [];
      case "DIRECTORY":
        return directory;
      case "PROJECT_ID":
        return 9n;
      case "SOULBOUND":
        return true;
      case "decimals":
      case "DECIMALS":
        return 18;
      case "accountingContextsOf":
        return [{ token: FUND, currency, decimals: 18 }];
      case "TOKEN":
        return IMPLEMENTATION;
      case "CURRENCY":
        return currency;
      case "totalSupply":
        return 100n;
      case "totalCreditSupplyOf":
      case "pendingReservedTokenBalanceOf":
      case "orphanedBalanceOf":
        return 0n;
      case "backing":
        return 200n;
      case "fundBalance":
        return 150n;
      case "shareBalance":
      case "stakedBalanceOf":
      case "getVotes":
        return 10n;
      case "creditBalanceOf":
        return 20n;
      case "allowance":
        return 150n;
      case "streakStartOf":
        return TIMESTAMP - 1000n;
      case "longestStreakOf":
        return 1000n;
      case "trancheCountOf":
        return 1n;
      case "delegates":
        return HOLDER;
      case "tranchesOf":
        expect(args).toEqual([9n, HOLDER, 0n, 1n]);
        return [{ amount: 10n, timestamp: Number(TIMESTAMP - 1000n) }];
      case "REV_LOANS":
      case "REV_OWNER":
        return zeroAddress;
      case "currentRound":
        return 3n;
      case "ROUND_DURATION":
        return 604800n;
      case "VESTING_ROUNDS":
        return 4n;
      case "CLAIM_DURATION":
        return 94_608_000;
      case "CLOCK_MODE":
        return "mode=blocknumber&from=default";
      case "clock":
        return BLOCK;
      case "splitsOf":
        return [
          {
            percent: 125000000,
            hook: DISTRIBUTOR,
            beneficiary: SHARE,
            projectId: 0n,
            lockedUntil: 0,
            preferAddToBalance: false,
          },
        ];
      case "collectableFor":
        return 5n;
      case "claimedFor":
        return 20n;
      case "nextClaimRoundOf":
        expect(args).toEqual([SHARE, 0n, BigInt(HOLDER), INCOME]);
        return 1n;
      case "activeVestingLoanIdOf":
        return 0n;
      case "getPastTotalActiveVotes":
        return 100n;
      case "rewardRoundOf":
        expect(args[0]).toBe(SHARE);
        return {
          amount: 1000n,
          snapshotBlock: 800,
          claimedAmount: 0n,
          claimDeadline: 1_900_000_000,
          totalStake: 100n,
        };
      case "getPastVotes":
        expect(args).toEqual([HOLDER, 800n]);
        return 10n;
      case "previewPayFor":
        expect(request.account).toBe(HOLDER);
        expect(args).toEqual([9n, FUND, 100n, HOLDER, "0x"]);
        return [ruleset, 50n, 0n, []];
      case "previewCashOutFrom":
        expect(request.account).toBe(HOLDER);
        return [ruleset, 20n, 0n, []];
      case "feeFreeBalanceOf":
      case "feeFreeSurplusOf":
        return 0n;
      default:
        throw new Error(`Unexpected read: ${label}`);
    }
  });
  const getBlock = vi.fn(async (request: { blockNumber?: bigint }) => ({
    number: request.blockNumber ?? BLOCK,
    hash:
      options.reorg && request.blockNumber
        ? (`0x${"cd".repeat(32)}` as Hex)
        : HASH,
    timestamp: TIMESTAMP,
  }));
  const getCode = vi.fn(
    async ({
      address,
      blockNumber,
    }: {
      address: Address;
      blockNumber: bigint;
    }) => {
      expect(blockNumber).toBe(BLOCK);
      if (options.noCode) return "0x";
      return address === FUND && !options.customFund
        ? `0x363d3d373d3d3d363d73${IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3`
        : "0x1234";
    },
  );
  const simulateContract = vi.fn(async (request: Request) => {
    expect(request.blockNumber).toBe(BLOCK);
    expect(request.account).toBe(HOLDER);
    expect(request.functionName).toBe("cashOutTokensOf");
    expect(request.args).toEqual([HOLDER, 9n, 10n, FUND, 0n, HOLDER, "0x"]);
    return { result: options.overrides?.netReclaim ?? 19n };
  });
  const deployArgs = {
    fundProjectId: 7n,
    incomeProjectId: 11n,
    operator: HOLDER,
    fundToken: FUND,
    initialAllocationVault: FEED,
    rewardToken: SHARE,
    merkleRoot: HASH,
    ...options.deployment,
  };
  const deploymentLog = {
    address: DEPLOYER,
    topics: encodeEventTopics({
      abi: homerunIncomeDeployerAbi,
      eventName: "IncomeDeployed",
      args: { fundProjectId: 7n, incomeProjectId: 11n, operator: HOLDER },
    }),
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [
        deployArgs.fundToken as Address,
        deployArgs.initialAllocationVault as Address,
        deployArgs.rewardToken as Address,
        deployArgs.merkleRoot as Hex,
      ],
    ),
    blockNumber: 990n,
    blockHash: HASH,
    transactionHash: HASH,
    logIndex: 0,
    transactionIndex: 0,
    removed: false,
    args: deployArgs,
  };
  const getLogs = vi.fn(async () =>
    options.deployment?.missing ? [] : [deploymentLog],
  );
  const getTransactionReceipt = vi.fn(async () => ({
    transactionHash: HASH,
    blockNumber: 990n,
    blockHash: HASH,
    status: options.deployment?.reverted ? "reverted" : "success",
    logs: options.deployment?.duplicate
      ? [deploymentLog, deploymentLog]
      : [deploymentLog],
  }));
  const client = {
    getLogs,
    getTransactionReceipt,
    chain: { id: chainId },
    getChainId: vi.fn(async () => (options.wrongChain ? 10 : chainId)),
    getBlock,
    getCode,
    readContract,
    simulateContract,
  } as unknown as PublicClient;
  return {
    client,
    readContract,
    getBlock,
    simulateContract,
    getLogs,
    getTransactionReceipt,
  };
}

describe("Sticky verified reads and quotes", () => {
  it("pins all bindings, backing, tranches and holder reads to one canonical block", async () => {
    const { client } = fixture(),
      state = await readStickyProjectState(client, input);
    expect(state.shareBalance).toBe(10n);
    expect(state.fundBalance).toBe(150n);
    expect(state.backing).toBe(200n);
    expect(state.tranches).toEqual([
      { amount: 10n, timestamp: Number(TIMESTAMP - 1000n) },
    ]);
    expect(state.rewards).toBeNull();
  });
  it("fails before RPC when the Sticky deployment is not registered", async () => {
    delete registry.JBStickyDeployer;
    const { client, readContract } = fixture();
    await expect(readStickyProjectState(client, input)).rejects.toThrow(
      /no verified/,
    );
    expect(readContract).not.toHaveBeenCalled();
  });
  it.each([
    [
      "foreign backing",
      { overrides: { stakedTokenOf: HOLDER } },
      /Staked FUND/,
    ],
    [
      "foreign project owner",
      { overrides: { ownerOf: HOLDER } },
      /project owner/,
    ],
    [
      "foreign SHARE registry",
      { overrides: { shareRegistry: HOLDER } },
      /SHARE registry/,
    ],
    [
      "different feed token",
      { overrides: { feedToken: FUND } },
      /Price feed SHARE/,
    ],
    [
      "unexpected withdrawal rights",
      { overrides: { surplusAllowancesOf: [{ amount: 1n }] } },
      /withdrawal rights/,
    ],
    [
      "owner minting",
      { metadata: { allowOwnerMinting: true } },
      /permanent staking policy/,
    ],
    ["foreign token clone", { customFund: true }, /canonical FUND/],
    [
      "inconsistent stake accounting",
      { overrides: { stakedBalanceOf: 11n } },
      /inconsistent token/,
    ],
    [
      "inconsistent tranches",
      { overrides: { tranchesOf: [] } },
      /tranche page/,
    ],
    [
      "delegated reward power",
      { overrides: { delegates: DEPLOYER } },
      /inconsistent token/,
    ],
    ["RPC failure", { fail: "fundBalance" }, /RPC failure/],
    ["wrong chain", { wrongChain: true }, /different chain/],
    ["missing deployed code", { noCode: true }, /no deployed code/],
    ["reorg", { reorg: true }, /chain changed/],
  ] as const)("rejects %s", async (_, options, expected) => {
    await expect(
      readStickyProjectState(fixture(options).client, input),
    ).rejects.toThrow(expected);
  });
  it("quotes backing-priced SHARE with the actual payer and preserves the SDK minimum", async () => {
    const { client } = fixture(),
      state = await readStickyProjectState(client, input);
    expect(await quoteStickyStake(client, state, 100n)).toEqual({
      shares: 50n,
      minimumShares: 49n,
    });
    await expect(quoteStickyStake(client, state, 151n)).rejects.toThrow(
      /available FUND/,
    );
  });
  it("uses the actual simulated net FUND return, not a hand-calculated gross cash-out", async () => {
    const { client, simulateContract } = fixture(),
      state = await readStickyProjectState(client, input);
    expect(await quoteStickyUnstake(client, state, 10n)).toEqual({
      fund: 19n,
      minimumFund: 18n,
    });
    expect(simulateContract).toHaveBeenCalledOnce();
    await expect(quoteStickyUnstake(client, state, 11n)).rejects.toThrow(
      /available SHARE/,
    );
  });
  it("does not prepare a zero-return withdrawal", async () => {
    const { client } = fixture({ overrides: { netReclaim: 0n } }),
      state = await readStickyProjectState(client, input);
    await expect(quoteStickyUnstake(client, state, 10n)).rejects.toThrow(
      /positive/,
    );
  });
});

describe("Sticky reward entitlement", () => {
  it("discovers SHARE from the exact immutable helper deployment and preserves its target after split changes", async () => {
    vi.mocked(readInitialIncomeAllocation).mockResolvedValue({
      chainId: 1,
      deployer: DEPLOYER,
      fundProjectId: 7n,
      incomeProjectId: 11n,
      vault: FEED,
      merkleRoot: HASH,
      snapshotBlockNumber: 900n,
      blockNumber: BLOCK,
      blockHash: HASH,
    } as never);
    const { client, readContract } = fixture({
      overrides: {
        splitsOf: [{ percent: 1, hook: DISTRIBUTOR, beneficiary: FUND }],
      },
    });
    await expect(
      readIncomeStickyBinding(client, {
        chainId: 1,
        fundProjectId: 7n,
        incomeProjectId: 11n,
      }),
    ).resolves.toEqual({
      stickyProjectId: 9n,
      shareToken: SHARE,
      blockNumber: BLOCK,
    });
    expect(
      readContract.mock.calls.some(
        ([request]) => request.functionName === "splitsOf",
      ),
    ).toBe(false);
  });
  it("does not discover a Sticky target without a verified allocation binding", async () => {
    vi.mocked(readInitialIncomeAllocation).mockResolvedValue(null);
    const { client, readContract } = fixture();
    await expect(
      readIncomeStickyBinding(client, {
        chainId: 1,
        fundProjectId: 7n,
        incomeProjectId: 11n,
      }),
    ).resolves.toBeNull();
    expect(readContract).not.toHaveBeenCalled();
  });
  it.each([
    ["missing event", { missing: true }, /could not be found/],
    [
      "foreign vault",
      { initialAllocationVault: HOLDER },
      /immutable FUND allocation/,
    ],
    [
      "foreign root",
      { merkleRoot: `0x${"cd".repeat(32)}` },
      /immutable FUND allocation/,
    ],
    ["zero SHARE", { rewardToken: zeroAddress }, /immutable FUND allocation/],
    ["foreign FUND", { fundToken: INCOME }, /verified SHARE token/],
    ["duplicate event", { duplicate: true }, /immutable FUND allocation/],
    ["reverted launch", { reverted: true }, /receipt is not valid/],
  ])(
    "rejects %s as Sticky discovery authority",
    async (_label, deployment, error) => {
      vi.mocked(readInitialIncomeAllocation).mockResolvedValue({
        chainId: 1,
        deployer: DEPLOYER,
        fundProjectId: 7n,
        incomeProjectId: 11n,
        vault: FEED,
        merkleRoot: HASH,
        snapshotBlockNumber: 900n,
        blockNumber: BLOCK,
        blockHash: HASH,
      } as never);
      const { client } = fixture({ deployment });
      await expect(
        readIncomeStickyBinding(client, {
          chainId: 1,
          fundProjectId: 7n,
          incomeProjectId: 11n,
        }),
      ).rejects.toThrow(error);
    },
  );
  it("rechecks a cached original deployment against canonical receipts and current Sticky wiring", async () => {
    vi.mocked(readInitialIncomeAllocation).mockResolvedValue({
      chainId: 1,
      deployer: DEPLOYER,
      fundProjectId: 7n,
      incomeProjectId: 11n,
      vault: FEED,
      merkleRoot: HASH,
      snapshotBlockNumber: 900n,
      blockNumber: BLOCK,
      blockHash: HASH,
    } as never);
    const f = fixture();
    await readIncomeStickyBinding(f.client, {
      chainId: 1,
      fundProjectId: 7n,
      incomeProjectId: 11n,
    });
    await readIncomeStickyBinding(f.client, {
      chainId: 1,
      fundProjectId: 7n,
      incomeProjectId: 11n,
    });
    expect(f.getLogs).toHaveBeenCalledOnce();
    expect(f.getTransactionReceipt).toHaveBeenCalledTimes(2);
    f.getBlock.mockResolvedValue({
      number: 990n,
      hash: `0x${"cd".repeat(32)}` as Hex,
      timestamp: TIMESTAMP,
    });
    await expect(
      readIncomeStickyBinding(f.client, {
        chainId: 1,
        fundProjectId: 7n,
        incomeProjectId: 11n,
      }),
    ).rejects.toThrow(/no longer in the canonical/);
  });
  it("uses completed historical SHARE snapshots and starts a new vesting schedule", async () => {
    const { client } = fixture(),
      state = await readStickyProjectState(client, {
        ...input,
        incomeProjectId: 11n,
      });
    expect(state.rewardIssue).toBeNull();
    expect(state.rewards).toMatchObject({
      eligibleUnvested: 200n,
      collectable: 5n,
      claimed: 20n,
      vestingRounds: 4n,
      fundingActive: true,
    });
  });
  it("uses Arbitrum's native SHARE checkpoint clock while pinning reads to the L2 RPC height", async () => {
    const { client, readContract, getBlock } = fixture({
      chainId: 42161,
      overrides: { clock: 900n },
    });
    const state = await readStickyProjectState(client, {
      ...input,
      chainId: 42161,
      incomeProjectId: 11n,
    });
    expect(state.blockNumber).toBe(BLOCK);
    expect(state.rewardIssue).toBeNull();
    expect(state.rewards?.eligibleUnvested).toBe(200n);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "getPastTotalActiveVotes",
        args: [899n],
        blockNumber: BLOCK,
      }),
    );
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "getPastVotes",
        args: [HOLDER, 800n],
        blockNumber: BLOCK,
      }),
    );
    expect(getBlock).toHaveBeenLastCalledWith({ blockNumber: BLOCK });
  });
  it.each([900, 950])(
    "rejects checkpoint %s outside the token's past even below the L2 RPC height",
    async (snapshotBlock) => {
      const { client, readContract } = fixture({
        chainId: 42161,
        overrides: {
          clock: 900n,
          rewardRoundOf: {
            amount: 1000n,
            totalStake: 100n,
            claimedAmount: 0n,
            claimDeadline: 1_900_000_000,
            snapshotBlock,
          },
        },
      });
      const state = await readStickyProjectState(client, {
        ...input,
        chainId: 42161,
      });
      await expect(readStickyRewards(client, state, 11n)).rejects.toThrow(
        /clock's past/,
      );
      expect(
        readContract.mock.calls.some(
          ([request]) => request.functionName === "getPastVotes",
        ),
      ).toBe(false);
    },
  );
  it.each([{ clock: 0n }, { CLOCK_MODE: "mode=timestamp" }])(
    "rejects unavailable or unsupported SHARE checkpoint clocks %o",
    async (overrides) => {
      const { client, readContract } = fixture({ overrides });
      const state = await readStickyProjectState(client, input);
      await expect(readStickyRewards(client, state, 11n)).rejects.toThrow(
        /snapshot clock is unsupported/,
      );
      expect(
        readContract.mock.calls.some(
          ([request]) => request.functionName === "getPastTotalActiveVotes",
        ),
      ).toBe(false);
    },
  );
  it("preserves already-earned claims after INCOME stops routing new rewards", async () => {
    const { client } = fixture({ overrides: { splitsOf: [] } }),
      state = await readStickyProjectState(client, {
        ...input,
        incomeProjectId: 11n,
      });
    expect(state.rewards?.fundingActive).toBe(false);
    expect(state.rewards?.collectable).toBe(5n);
  });
  it("identifies loans instead of treating collateral as available rewards", async () => {
    const { client } = fixture({
        overrides: { activeVestingLoanIdOf: 77n, collectableFor: 0n },
      }),
      state = await readStickyProjectState(client, {
        ...input,
        incomeProjectId: 11n,
      });
    expect(state.rewards?.activeVestingLoanId).toBe(77n);
  });
  it("does not enable vesting from empty, expired, or zero-weight rounds", async () => {
    for (const round of [
      { amount: 0n, totalStake: 100n, claimDeadline: 1_900_000_000 },
      { amount: 1000n, totalStake: 0n, claimDeadline: 1_900_000_000 },
      { amount: 1000n, totalStake: 100n, claimDeadline: Number(TIMESTAMP) },
    ]) {
      const { client } = fixture({
          overrides: {
            rewardRoundOf: { ...round, snapshotBlock: 800, claimedAmount: 0n },
          },
        }),
        state = await readStickyProjectState(client, {
          ...input,
          incomeProjectId: 11n,
        });
      expect(state.rewards?.eligibleUnvested).toBe(0n);
    }
  });
  it("bounds reward history while retaining already collectable rewards", async () => {
    const { client } = fixture({ overrides: { currentRound: 5000n } }),
      state = await readStickyProjectState(client, {
        ...input,
        incomeProjectId: 11n,
      });
    expect(state.rewards?.historyIssue).toMatch(/history exceeds/);
    expect(state.rewards?.collectable).toBe(5n);
  });
  it("keeps a reward RPC error explicit instead of replacing it with a zero allocation", async () => {
    const { client } = fixture({ fail: "rewardRoundOf" }),
      state = await readStickyProjectState(client, input);
    await expect(readStickyRewards(client, state, 11n)).rejects.toThrow(
      /RPC failure/,
    );
    const full = await readStickyProjectState(client, {
      ...input,
      incomeProjectId: 11n,
    });
    expect(full.rewards).toBeNull();
    expect(full.rewardIssue).toMatch(/RPC failure/);
  });
});
