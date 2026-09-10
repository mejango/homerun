import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { USDC_ADDRESSES, type JBChainId } from "@bananapus/nana-sdk-core";
import { tokenCurrencyId, v6Address } from "@bananapus/nana-sdk-core/v6";
import {
  decodeFunctionData,
  encodeFunctionData,
  padHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { initialFundRuleset } from "../src/lib/fund-contracts";
import type { IncomeProjectState } from "../src/lib/income-state";
import type { FundGlobalSnapshotGraph } from "../src/lib/fund-global-snapshot-graph";
import {
  assertIncomeBridgeState,
  readLinkedIncomeProjects,
  readIncomeBridgeRoute,
  readIncomeBridgePrepareQuote,
  buildIncomeBridgeApproval,
  buildIncomeBridgePrepare,
  type IncomeBridgeRoute,
} from "../src/lib/income-bridge";
import { buildFundBridgeApproval } from "../src/lib/fund-bridge";

const mocks = vi.hoisted(() => ({
  graph: vi.fn(),
  state: vi.fn(),
  transport: vi.fn(),
}));
vi.mock("../src/lib/fund-global-snapshot-graph", () => ({
  readFundGlobalSnapshotGraph: mocks.graph,
}));
vi.mock("../src/lib/income-state", () => ({
  readIncomeProjectState: mocks.state,
}));
vi.mock("@bananapus/nana-sdk-core/v6", async (original) => ({
  ...(await original<typeof import("@bananapus/nana-sdk-core/v6")>()),
  classifySuckerTransport: mocks.transport,
}));
beforeEach(() => vi.resetAllMocks());
const account = "0x1111111111111111111111111111111111111111" as const;
const sourceSucker = "0x2222222222222222222222222222222222222222" as const;
const destinationSucker = "0x3333333333333333333333333333333333333333" as const;
const incomeToken = "0x4444444444444444444444444444444444444444" as const;
const stranger = "0x5555555555555555555555555555555555555555" as const;
const hash = `0x${"ab".repeat(32)}` as Hex;
const otherHash = `0x${"cd".repeat(32)}` as Hex;
function state(chainId: 8453 | 10): IncomeProjectState {
  const owner = v6Address("REVOwner", chainId);
  const terminal = v6Address("JBMultiTerminal", chainId);
  const token = USDC_ADDRESSES[chainId];
  const metadata = {
    ...initialFundRuleset().metadata,
    dataHook: owner,
    useDataHookForPay: true,
    useDataHookForCashOut: true,
    cashOutTaxRate: 9000,
  };
  return {
    chainId,
    projectId: chainId === 8453 ? 7n : 19n,
    blockNumber: 110n,
    blockHash: hash,
    blockTimestamp: 1000n,
    owner,
    operator: null,
    account,
    controller: v6Address("JBController", chainId),
    ruleset: {
      cycleNumber: 1,
      id: 1,
      basedOnId: 0,
      start: 900,
      duration: 0,
      weight: 100n,
      weightCutPercent: 0,
      approvalHook: zeroAddress,
      metadata: 0n,
    },
    metadata,
    projectUri: "",
    tokenAddress: incomeToken,
    tokenSymbol: "INCOME",
    tokenDecimals: 18,
    totalSupply: 1000n,
    totalCreditSupply: 100n,
    pendingReservedTokens: 0n,
    totalSupplyWithReservedTokens: 1000n,
    creditBalance: 10n,
    erc20Balance: 20n,
    totalBalance: 30n,
    terminals: [terminal],
    accountingContexts: [
      {
        token,
        terminal,
        primaryTerminal: terminal,
        isPrimary: true,
        decimals: 6,
        currency: tokenCurrencyId(token),
        balance: 1000n,
        surplus: 1000n,
        symbol: "USDC",
      },
    ],
    cashOutDelay: 2000n,
    cashOutsAvailable: false,
    isOperator: false,
    rewards: null,
    rewardIssue: null,
    issues: [],
  };
}
type Request = {
  functionName: string;
  address: Address;
  args?: readonly unknown[];
  blockNumber?: bigint;
  account?: Address;
};
function fixture() {
  const source = state(8453),
    destination = state(10);
  const graph: FundGlobalSnapshotGraph = {
    cuts: [8453, 10].map((chainId) => ({
      chainId: chainId as JBChainId,
      blockNumber: 100n,
      blockHash: hash,
      blockTimestamp: 900n,
    })),
    projects: [source, destination].map((item) => ({
      chainId: item.chainId,
      projectId: item.projectId,
      owner: item.owner,
      controller: item.controller,
      historicalSuckers: [
        item.chainId === 8453 ? sourceSucker : destinationSucker,
      ],
    })),
    lanes: [
      {
        sourceChainId: 8453,
        sourceProjectId: 7n,
        sourceSucker,
        destinationChainId: 10,
        destinationProjectId: 19n,
        destinationSucker,
      },
      {
        sourceChainId: 10,
        sourceProjectId: 19n,
        sourceSucker: destinationSucker,
        destinationChainId: 8453,
        destinationProjectId: 7n,
        destinationSucker: sourceSucker,
      },
    ],
  };
  const pairs = new Map([
    [
      8453,
      [
        {
          local: sourceSucker,
          remote: padHex(destinationSucker, { size: 32 }),
          remoteChainId: 10n,
        },
      ],
    ],
    [
      10,
      [
        {
          local: destinationSucker,
          remote: padHex(sourceSucker, { size: 32 }),
          remoteChainId: 8453n,
        },
      ],
    ],
  ]);
  const reads = vi.fn(
    async (chainId: 8453 | 10, request: Request): Promise<unknown> => {
      assert.equal(request.blockNumber, 110n);
      if (request.functionName === "suckerPairsOf") return pairs.get(chainId);
      if (request.functionName === "remoteTokenFor")
        return {
          enabled: true,
          addr: padHex(USDC_ADDRESSES[chainId === 8453 ? 10 : 8453], {
            size: 32,
          }),
        };
      if (request.functionName === "toRemoteFee") return 100n;
      if (request.functionName === "state") return 0;
      if (request.functionName === "previewCashOutFrom") {
        assert.equal(request.account, sourceSucker);
        assert.deepEqual(request.args, [
          sourceSucker,
          7n,
          20n,
          USDC_ADDRESSES[8453],
          sourceSucker,
          "0x",
        ]);
        // Hook output incorporates local loans; no ordinary-holder/global formula is substituted.
        return [20n, 1000n, 0, []];
      }
      if (request.functionName === "feeFreeSurplusOf") return 0n;
      if (request.functionName === "FEELESS_ADDRESSES") return stranger;
      if (request.functionName === "isFeelessFor") return true;
      if (request.functionName === "allowance") return 20n;
      throw new Error(`Unexpected ${request.functionName}`);
    },
  );
  const blocks = vi.fn(
    async (_chainId: number, input: { blockNumber: bigint }) => ({
      number: input.blockNumber,
      hash,
    }),
  );
  const clients = new Map(
    [8453, 10].map((id) => [
      id,
      {
        getChainId: vi.fn(async () => id),
        getBlock: (input: { blockNumber: bigint }) => blocks(id, input),
        readContract: (request: Request) => reads(id as 8453 | 10, request),
      } as unknown as PublicClient,
    ]),
  );
  const clientFor = (chainId: JBChainId) =>
    clients.get(chainId) ?? ({} as PublicClient);
  mocks.graph.mockResolvedValue(graph);
  mocks.state.mockImplementation(async (_client, input) =>
    input.chainId === 8453 ? source : destination,
  );
  mocks.transport.mockResolvedValue("ccip");
  return {
    source,
    destination,
    graph,
    pairs,
    reads,
    blocks,
    clients,
    clientFor,
  };
}
test("reads actual remote IDs and fresh wallet balances through the historical graph", async () => {
  const f = fixture();
  const route = await readIncomeBridgeRoute(
    f.clientFor,
    { ...f.source, erc20Balance: 999n },
    10,
  );
  assert.equal(route.source.erc20Balance, 20n);
  assert.equal(route.destination.projectId, 19n);
  assert.equal(route.sourceSucker, sourceSucker);
  assert.equal(route.destinationSucker, destinationSucker);
  assert.equal(route.canPrepare, true);
  assert.deepEqual(
    mocks.state.mock.calls.map((call) => call[1]),
    [
      { chainId: 8453, projectId: 7n, account },
      { chainId: 10, projectId: 19n, account },
    ],
  );
});
test("uses the sucker hook quote during ordinary cashout delay, including its local loan accounting", async () => {
  const f = fixture();
  const route = await readIncomeBridgeRoute(f.clientFor, f.source, 10);
  assert.equal(route.source.cashOutsAvailable, false);
  const quote = await readIncomeBridgePrepareQuote(
    f.clients.get(8453)!,
    route,
    20n,
  );
  assert.equal(quote.grossReclaimAmount, 1000n);
  assert.equal(quote.netReclaimAmount, 1000n);
  assert.equal(quote.minTokensReclaimed, 990n);
});
test("approval targets INCOME ERC20 with an exact amount and prepare retains the reviewed minimum", async () => {
  const f = fixture(),
    route = await readIncomeBridgeRoute(f.clientFor, f.source, 10);
  const approval = buildIncomeBridgeApproval(route, 20n);
  assert.equal(approval.address, incomeToken);
  assert.deepEqual(approval.args, [sourceSucker, 20n]);
  const request = buildIncomeBridgePrepare(route, {
    amount: 20n,
    beneficiary: account,
    minTokensReclaimed: 990n,
  });
  const decoded = decodeFunctionData({
    abi: request.abi,
    data: encodeFunctionData(request),
  });
  assert.equal(request.address, sourceSucker);
  assert.deepEqual(decoded.args?.slice(0, 4), [
    20n,
    padHex(account, { size: 32 }),
    990n,
    USDC_ADDRESSES[8453],
  ]);
  assert.throws(() =>
    buildIncomeBridgePrepare(route, {
      amount: 20n,
      beneficiary: account,
      minTokensReclaimed: 0n,
    }),
  );
  assert.throws(() => buildIncomeBridgeApproval(route, 21n));
});
test("cannot pass INCOME state through the FUND ownership adapter", async () => {
  const f = fixture(),
    route = await readIncomeBridgeRoute(f.clientFor, f.source, 10);
  assert.throws(
    () => buildFundBridgeApproval(route as never, 20n),
    /not supported by FUND/,
  );
});
test("rejects a foreign NFT owner on any linked finalized project", async () => {
  const f = fixture();
  f.graph.projects[1].owner = account;
  await assert.rejects(
    () => readLinkedIncomeProjects(f.clientFor, f.source),
    /not a canonical INCOME/,
  );
});
test("rejects fresh owner, controller, hook, hook flags, stage, and token precision changes", () => {
  const f = fixture();
  for (const change of [
    { owner: account },
    { controller: account },
    { metadata: { ...f.source.metadata, dataHook: account } },
    { metadata: { ...f.source.metadata, useDataHookForCashOut: false } },
    { metadata: { ...f.source.metadata, useDataHookForPay: false } },
    { ruleset: { ...f.source.ruleset, id: 0 } },
    { tokenDecimals: 6 },
  ]) {
    assert.throws(() => assertIncomeBridgeState({ ...f.source, ...change }));
  }
});
test("blocks current routes absent from the finalized reciprocal graph", async () => {
  const f = fixture();
  f.pairs.get(8453)![0].local = stranger;
  await assert.rejects(
    () => readLinkedIncomeProjects(f.clientFor, f.source),
    /Wait for finality/,
  );
});
test("keeps retired routes readable while forbidding approval, quote, and preparation", async () => {
  const f = fixture();
  f.pairs.set(8453, []);
  f.pairs.set(10, []);
  const route = await readIncomeBridgeRoute(f.clientFor, f.source, 10);
  assert.equal(route.sourceSucker, sourceSucker);
  assert.equal(route.canPrepare, false);
  assert.match(route.prepareIssue!, /recovery only/);
  assert.throws(() => buildIncomeBridgeApproval(route, 20n));
  await assert.rejects(() =>
    readIncomeBridgePrepareQuote(f.clients.get(8453)!, route, 20n),
  );
  assert.throws(() =>
    buildIncomeBridgePrepare(route, {
      amount: 20n,
      beneficiary: account,
      minTokensReclaimed: 990n,
    }),
  );
});
test("requires active registration in both directions before new preparation", async () => {
  const f = fixture();
  f.pairs.set(10, []);
  const route = await readIncomeBridgeRoute(f.clientFor, f.source, 10);
  assert.equal(route.canPrepare, false);
});
test("rejects ambiguous same-chain projects and missing graph destinations", async () => {
  const f = fixture();
  f.graph.projects.push({ ...f.graph.projects[0], projectId: 9n });
  await assert.rejects(
    () => readLinkedIncomeProjects(f.clientFor, f.source),
    /ambiguous/,
  );
  f.graph.projects.pop();
  await assert.rejects(
    () => readIncomeBridgeRoute(f.clientFor, f.source, 42161),
    /not a verified linked/,
  );
});
test("rejects stale RPC snapshots, current-block reorgs, and changed finalized identity cuts", async () => {
  const f = fixture();
  f.source.blockNumber = 99n;
  await assert.rejects(
    () => readLinkedIncomeProjects(f.clientFor, f.source),
    /behind/,
  );
  f.source.blockNumber = 110n;
  f.blocks.mockImplementation(async (_id, input) => ({
    number: input.blockNumber,
    hash: otherHash,
  }));
  await assert.rejects(
    () => readLinkedIncomeProjects(f.clientFor, f.source),
    /chain changed/,
  );
  f.blocks.mockImplementation(async (_id, input) => ({
    number: input.blockNumber,
    hash: input.blockNumber === 100n ? otherHash : hash,
  }));
  await assert.rejects(
    () => readLinkedIncomeProjects(f.clientFor, f.source),
    /finalized INCOME bridge identity changed/,
  );
});
test("same-chain requests fail before expensive discovery and disconnected reads omit account", async () => {
  const f = fixture();
  await assert.rejects(
    () => readIncomeBridgeRoute(f.clientFor, f.source, 8453),
    /different destination/,
  );
  assert.equal(mocks.graph.mock.calls.length, 0);
  await readLinkedIncomeProjects(f.clientFor, { ...f.source, account: null });
  assert.deepEqual(mocks.state.mock.calls[0][1], {
    chainId: 8453,
    projectId: 7n,
  });
});
