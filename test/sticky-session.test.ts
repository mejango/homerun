import { placeReceipt } from "./support/recovery-receipt";
import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  zeroAddress,
  type Hex,
  type PublicClient,
} from "viem";
import {
  assertSafeProposalCall,
  clearStickyPending,
  readStickyPending,
  stickyIntent,
  stickyPendingAttempt,
  stickySessionKey,
  verifyStickyExecution,
  type StickyPending,
} from "../src/lib/sticky-session";
import { safeExecutionLog } from "./support/safe-logs";

const HOLDER = "0x1111111111111111111111111111111111111111",
  TARGET = "0x2222222222222222222222222222222222222222",
  OTHER = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}` as Hex,
  BLOCK_HASH = `0x${"cd".repeat(32)}` as Hex;
const request = {
  chainId: 1,
  address: TARGET,
  abi: erc20Abi,
  functionName: "approve",
  args: [OTHER, 100n],
};
const key = stickySessionKey(1, 9n, HOLDER);
const safeAbi = parseAbi([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
  "event ExecutionSuccess(bytes32 txHash,uint256 payment)",
  "event ExecutionFailure(bytes32 txHash,uint256 payment)",
]);
function memory() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
  };
}
/** What the Sticky journal saved before SDK holds: the shape each execution is verified against. */
function saved(safe = false): StickyPending {
  return {
    version: 1, id: "11111111-1111-4111-8111-111111111111", chainId: 1, projectId: "9", holder: HOLDER, target: TARGET,
    data: encodeFunctionData(request), value: "0", label: "Approve FUND", safe, submittedAt: 1_000, afterBlock: "100",
  };
}
function clientFor(
  record: StickyPending,
  options: {
    wrongPayload?: boolean;
    wrongSender?: boolean;
    old?: boolean;
    reorg?: boolean;
    reverted?: boolean;
    safeFailure?: boolean;
    noEvent?: boolean;
    delegateCall?: boolean;
    logs?: ReturnType<typeof safeExecutionLog>[];
    finalized?: bigint;
  } = {},
) {
  const safeData = encodeFunctionData({
    abi: safeAbi,
    functionName: "execTransaction",
    args: [
      record.target,
      0n,
      options.wrongPayload ? "0x1234" : record.data,
      options.delegateCall ? 1 : 0,
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      "0x",
    ],
  });
  const transaction = {
    hash: HASH,
    to: record.safe ? HOLDER : record.target,
    from: options.wrongSender ? OTHER : HOLDER,
    input: record.safe
      ? safeData
      : options.wrongPayload
        ? "0x1234"
        : record.data,
    value: 0n,
    blockNumber: options.old ? 100n : 101n,
    blockHash: BLOCK_HASH,
  };
  const eventName = options.safeFailure
    ? "ExecutionFailure"
    : "ExecutionSuccess";
  const logs = options.logs ??
    (record.safe && !options.noEvent
      ? [
          {
            address: HOLDER,
            topics: encodeEventTopics({ abi: safeAbi, eventName }),
            data: encodeAbiParameters(
              [{ type: "bytes32" }, { type: "uint256" }],
              [HASH, 0n],
            ),
          },
        ]
      : []);
  const receipt = {
    transactionHash: HASH,
    blockNumber: transaction.blockNumber,
    blockHash: BLOCK_HASH,
    status: options.reverted ? "reverted" : "success",
    logs,
  };
  placeReceipt(transaction, receipt);
  return {
    getChainId: async () => 1,
    getTransaction: async () => transaction,
    getTransactionReceipt: async () => receipt,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint }) => ({ hash: options.reorg ? HASH : BLOCK_HASH, number: blockNumber ?? options.finalized ?? 200n, timestamp: 1_000n }),
  } as unknown as PublicClient;
}
describe("Sticky durable submission recovery", () => {
  it('holds a hashless attempt despite a later matching failure', async () => {
    const record = saved()
    await expect(verifyStickyExecution(clientFor(record, { reverted: true }), record, HASH)).rejects.toThrow(/historical failure/)
  })
  it('does not release a known failed write before its receipt is finalized', async () => {
    const record = { ...saved(), hash: HASH }
    await expect(verifyStickyExecution(clientFor(record, { reverted: true, finalized: 100n }), record, HASH)).rejects.toThrow(/not yet proven/)
  })
  it('does not settle a saved EOA hash with another identical transaction', async () => {
    const record = { ...saved(), hash: BLOCK_HASH }
    await expect(verifyStickyExecution(clientFor(record), record, HASH)).rejects.toThrow(/saved Sticky transaction hash/)
  })
  it("fails closed on corrupt or mismatched local data", () => {
    const storage = memory();
    storage.setItem(key, "{oops");
    expect(() => readStickyPending(storage, key)).toThrow(/unreadable/);
    storage.setItem(key, JSON.stringify({ ...saved(), holder: OTHER }));
    expect(() => readStickyPending(storage, key)).toThrow(/does not match/);
  });
  it("does not clear a newer submission record from another tab", () => {
    const storage = memory(),
      record = saved();
    storage.setItem(key, JSON.stringify(record));
    storage.setItem(
      key,
      JSON.stringify({ ...record, submittedAt: record.submittedAt + 1 }),
    );
    expect(() => clearStickyPending(storage, key, record)).toThrow(/changed/);
    expect(readStickyPending(storage, key)).not.toBeNull();
  });
  it("verifies the exact EOA payload and fresh canonical receipt", async () => {
    const record = { ...saved(), hash: HASH };
    await expect(
      verifyStickyExecution(clientFor(record), record, HASH),
    ).resolves.toBe("confirmed");
    await expect(
      verifyStickyExecution(
        clientFor(record, { reverted: true }),
        record,
        HASH,
      ),
    ).resolves.toBe("reverted");
  });
  it.each([
    { wrongPayload: true },
    { wrongSender: true },
    { old: true },
    { reorg: true },
  ])(
    "rejects foreign, historical or reorged EOA execution %j",
    async (options) => {
      const record = saved();
      await expect(
        verifyStickyExecution(clientFor(record, options), record, HASH),
      ).rejects.toThrow();
    },
  );
  it("requires a matching Safe single-call execution and its actual success event", async () => {
    const record = { ...saved(true), hash: HASH };
    await expect(
      verifyStickyExecution(clientFor(record), record, HASH),
    ).resolves.toBe("confirmed");
    await expect(
      verifyStickyExecution(
        clientFor(record, { safeFailure: true }),
        record,
        HASH,
      ),
    ).resolves.toBe("reverted");
    for (const options of [
      { wrongPayload: true },
      { noEvent: true },
      { delegateCall: true },
      { reorg: true, safeFailure: true },
    ])
      await expect(
        verifyStickyExecution(clientFor(record, options), record, HASH),
      ).rejects.toThrow();
  });
  it("matches a known Safe proposal hash instead of accepting another identical proposal", async () => {
    const record = { ...saved(true), hash: HASH };
    await expect(
      verifyStickyExecution(clientFor(record), record, HASH),
    ).resolves.toBe("confirmed");
    await expect(
      verifyStickyExecution(
        clientFor(record),
        { ...record, hash: BLOCK_HASH },
        HASH,
      ),
    ).rejects.toThrow(/proposal hash/);
  });
});

describe("Sticky Safe execution events", () => {
  const PROPOSAL = `0x${"ef".repeat(32)}` as Hex;
  const proposed = (): StickyPending => ({ ...saved(true), hash: PROPOSAL });
  const verify = (logs: ReturnType<typeof safeExecutionLog>[]) =>
    verifyStickyExecution(clientFor(proposed(), { logs }), proposed(), HASH);

  it("confirms a Safe 1.4.1 execution, whose txHash is indexed", async () => {
    await expect(verify([safeExecutionLog(HOLDER, PROPOSAL)])).resolves.toBe("confirmed");
  });
  it("reads a Safe 1.4.1 ExecutionFailure as reverted", async () => {
    await expect(verify([safeExecutionLog(HOLDER, PROPOSAL, { failed: true })])).resolves.toBe("reverted");
  });
  it("keeps the record when the Safe's execution transaction reverted, since its proposal can still execute", async () => {
    await expect(
      verifyStickyExecution(clientFor(proposed(), { reverted: true, logs: [] }), proposed(), HASH),
    ).rejects.toThrow("before resolving its proposal");
  });
  it("confirms a Safe 1.3 execution, whose txHash is in data", async () => {
    await expect(verify([safeExecutionLog(HOLDER, PROPOSAL, { version: "1.3" })])).resolves.toBe("confirmed");
  });
  it("ignores another Safe's failure in the same receipt", async () => {
    await expect(
      verify([safeExecutionLog(OTHER, PROPOSAL, { failed: true }), safeExecutionLog(HOLDER, PROPOSAL)]),
    ).resolves.toBe("confirmed");
  });
});

describe("a Sticky record from before SDK holds", () => {
  it("is recovered under its action's intent with its own evidence", () => {
    const record = { ...saved(true), hash: HASH, submittedAt: 1_800_000_000_000 }, client = {} as never;
    expect(stickyPendingAttempt(client, record)).toMatchObject({
      request: { chainId: 1, address: TARGET, functionName: "approve", value: 0n, label: "Approve FUND" },
      namespace: stickyIntent(9n, "approve"),
      attempt: { chainId: 1, account: HOLDER, safe: true, namespaces: [stickyIntent(9n, "approve")], call: { to: TARGET, data: encodeFunctionData(request), value: 0n },
        saved: { started: true, submittedAt: 1_800_000_000_000, safeTxHash: HASH } },
    });
    expect(stickyPendingAttempt(client, saved()).attempt.saved).toEqual({ started: true, submittedAt: 1_000 });
  });
  it("holds each holder action on its own, one at a time per Sticky project", () => {
    const actions = ["claimTokensFor", "approve", "pay", "cashOutTokensOf", "beginVesting", "collectVestedRewards"];
    expect(new Set(actions.map(action => stickyIntent(9n, action))).size).toBe(actions.length);
    expect(stickyIntent(9n, "pay")).not.toBe(stickyIntent(10n, "pay"));
    expect(() => stickyIntent(9n, "transfer")).toThrow("Unknown Sticky action");
  });
  it("matches a Safe proposal only to its exact call, Permit2 expiration included", () => {
    const abi = parseAbi([
      "function approve(address token,address spender,uint160 amount,uint48 expiration)",
    ]);
    const renewed = { ...request, abi, args: [TARGET, OTHER, 100n, 2000] };
    const original = { ...renewed, args: [TARGET, OTHER, 100n, 1000] };
    const proposal = { proposalHash: HASH, call: { to: TARGET, data: encodeFunctionData(original) } };
    expect(() => assertSafeProposalCall(original, proposal)).not.toThrow();
    expect(() => assertSafeProposalCall({ ...renewed, args: [TARGET, OTHER, 101n, 2000] }, proposal)).toThrow("does not match");
  });
});
