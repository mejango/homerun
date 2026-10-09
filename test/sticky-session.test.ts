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
  adoptStickyProposal,
  assertSafeProposalCall,
  beginStickySubmission,
  clearStickyPending,
  readStickyPending,
  recordStickyHash,
  releaseStickyUnsubmitted,
  stickySessionKey,
  verifyStickyExecution,
  type StickyPending,
} from "../src/lib/sticky-session";
import { safeExecutionLog } from "./support/safe-logs";
import { failReservationReadback } from "./support/reservation-storage";

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
it.each([undefined, "replacement"])("cleans only its exact failed pre-wallet Sticky reservation (%s)", replacement => {
  const storage = memory(), broken = failReservationReadback(storage, key, { replacement });
  expect(() => beginStickySubmission(broken, key, request, 9n, HOLDER, false, "Approve FUND", 100n)).toThrow();
  expect(storage.getItem(key)).toBe(replacement ?? null);
});
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
function saved(safe = false): StickyPending {
  return beginStickySubmission(
    memory(),
    key,
    request,
    9n,
    HOLDER,
    safe,
    "Approve FUND",
    100n,
  );
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
  it('distinguishes identical attempts even when the clock does not advance', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const storage = memory()
      const first = beginStickySubmission(storage, key, request, 9n, HOLDER, false, 'Approve FUND', 100n)
      releaseStickyUnsubmitted(storage, key, first)
      const second = beginStickySubmission(storage, key, request, 9n, HOLDER, false, 'Approve FUND', 100n)
      expect(second.submittedAt).toBe(first.submittedAt)
      expect(second.id).not.toBe(first.id)
      expect(() => recordStickyHash(storage, key, HASH, first)).toThrow(/changed/)
      expect(() => clearStickyPending(storage, key, first)).toThrow(/changed/)
      expect(readStickyPending(storage, key)).toEqual(second)
    } finally { now.mockRestore() }
  })
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
  it("persists the exact payload before signing and blocks a duplicate after reopening", () => {
    const storage = memory(),
      record = beginStickySubmission(
        storage,
        key,
        request,
        9n,
        HOLDER,
        false,
        "Approve FUND",
        100n,
      );
    expect(readStickyPending(storage, key)).toEqual(record);
    expect(() =>
      beginStickySubmission(
        storage,
        key,
        request,
        9n,
        HOLDER,
        false,
        "Approve FUND",
        100n,
      ),
    ).toThrow(/already be pending/);
    recordStickyHash(storage, key, HASH);
    expect(readStickyPending(storage, key)?.hash).toBe(HASH);
  });
  it("fails closed on corrupt or mismatched local data", () => {
    const storage = memory();
    storage.setItem(key, "{oops");
    expect(() => readStickyPending(storage, key)).toThrow(/unreadable/);
    storage.setItem(key, JSON.stringify({ ...saved(), holder: OTHER }));
    expect(() => readStickyPending(storage, key)).toThrow(/does not match/);
  });
  it("withdraws only the exact unsubmitted attempt and retains submitted hashes", () => {
    const storage = memory();
    const record = beginStickySubmission(storage, key, request, 9n, HOLDER, false, "Approve FUND", 100n);
    releaseStickyUnsubmitted(storage, key, record);
    expect(readStickyPending(storage, key)).toBeNull();
    const next = beginStickySubmission(storage, key, request, 9n, HOLDER, false, "Approve FUND", 100n);
    const submitted = recordStickyHash(storage, key, HASH, next);
    expect(() => releaseStickyUnsubmitted(storage, key, next)).toThrow(/changed or was submitted/);
    expect(() => releaseStickyUnsubmitted(storage, key, submitted)).toThrow(/changed or was submitted/);
    expect(readStickyPending(storage, key)).toEqual(submitted);
  });
  it("cannot overwrite or release a replaced attempt with the same call and timestamp", () => {
    const storage = memory();
    const record = beginStickySubmission(storage, key, request, 9n, HOLDER, false, "Approve FUND", 100n);
    const replacement = { ...record, afterBlock: "101" };
    storage.setItem(key, JSON.stringify(replacement));
    expect(() => recordStickyHash(storage, key, HASH, record)).toThrow(/changed before its hash/);
    expect(() => releaseStickyUnsubmitted(storage, key, record)).toThrow(/changed or was submitted/);
    expect(readStickyPending(storage, key)).toEqual(replacement);
  });
  it("does not clear a newer submission record from another tab", () => {
    const storage = memory(),
      record = beginStickySubmission(
        storage,
        key,
        request,
        9n,
        HOLDER,
        false,
        "Approve FUND",
        100n,
      );
    storage.setItem(
      key,
      JSON.stringify({ ...record, submittedAt: record.submittedAt + 1 }),
    );
    expect(() => clearStickyPending(storage, key, record)).toThrow(/changed/);
    expect(readStickyPending(storage, key)).not.toBeNull();
  });
  it('does not clear a record whose wallet identity arrived while its earlier proof was pending', () => {
    const storage = memory()
    const record = beginStickySubmission(storage, key, request, 9n, HOLDER, false, 'Approve FUND', 100n)
    recordStickyHash(storage, key, HASH, record)
    expect(() => clearStickyPending(storage, key, record)).toThrow(/changed/)
    expect(readStickyPending(storage, key)?.hash).toBe(HASH)
  })
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

describe("existing Safe proposal adoption", () => {
  it("persists the known hash atomically and accepts historical execution only for that exact proposal", async () => {
    const storage = memory();
    const proposal = {
      proposalHash: HASH,
      call: { to: TARGET, data: encodeFunctionData(request), value: 0n },
    };
    const record = adoptStickyProposal(
      storage,
      key,
      request,
      9n,
      HOLDER,
      "Approve FUND",
      proposal,
    );
    expect(readStickyPending(storage, key)).toEqual(record);
    expect(record).toMatchObject({ safe: true, hash: HASH, afterBlock: "0" });
    await expect(
      verifyStickyExecution(clientFor(record, { old: true }), record, HASH),
    ).resolves.toBe("confirmed");
    await expect(
      verifyStickyExecution(clientFor(record, { noEvent: true }), record, HASH),
    ).rejects.toThrow("proposal hash");
    expect(() =>
      adoptStickyProposal(
        storage,
        key,
        request,
        9n,
        HOLDER,
        "Approve FUND",
        proposal,
      ),
    ).toThrow("already be pending");
  });
  it("retains the original Permit2 expiration while rejecting any changed authorization", () => {
    const abi = parseAbi([
      "function approve(address token,address spender,uint160 amount,uint48 expiration)",
    ]);
    const renewed = { ...request, abi, args: [TARGET, OTHER, 100n, 2000] };
    const original = { ...renewed, args: [TARGET, OTHER, 100n, 1000] };
    const proposal = {
      proposalHash: HASH,
      call: { to: TARGET, data: encodeFunctionData(original) },
    };
    const record = adoptStickyProposal(
      memory(),
      key,
      renewed,
      9n,
      HOLDER,
      "Permit FUND",
      proposal,
    );
    expect(record.data).toBe(encodeFunctionData(original));
    expect(() => assertSafeProposalCall(renewed, proposal)).toThrow(
      "does not match",
    );
    expect(() =>
      adoptStickyProposal(
        memory(),
        key,
        { ...renewed, args: [TARGET, OTHER, 101n, 2000] },
        9n,
        HOLDER,
        "Permit FUND",
        proposal,
      ),
    ).toThrow("does not match");
  });
  it("rejects missing or mismatched evidence before writing storage", () => {
    const storage = memory(),
      call = { to: TARGET, data: encodeFunctionData(request), value: 0n };
    for (const proposal of [
      { proposalHash: `0x${"00".repeat(32)}` as Hex, call },
      { proposalHash: HASH, call: { ...call, to: OTHER } },
      { proposalHash: HASH, call: { ...call, value: 1n } },
    ])
      expect(() =>
        adoptStickyProposal(
          storage,
          key,
          request,
          9n,
          HOLDER,
          "Approve FUND",
          proposal,
        ),
      ).toThrow();
    expect(storage.getItem(key)).toBeNull();
  });
});
