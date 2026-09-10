import { describe, expect, it } from "vitest";
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
  beginStickySubmission,
  clearStickyPending,
  readStickyPending,
  recordStickyHash,
  stickySessionKey,
  verifyStickyExecution,
  type StickyPending,
} from "../src/lib/sticky-session";

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
  const logs =
    record.safe && !options.noEvent
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
      : [];
  const receipt = {
    transactionHash: HASH,
    blockNumber: transaction.blockNumber,
    blockHash: BLOCK_HASH,
    status: options.reverted ? "reverted" : "success",
    logs,
  };
  return {
    getChainId: async () => 1,
    getTransaction: async () => transaction,
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ hash: options.reorg ? HASH : BLOCK_HASH }),
  } as unknown as PublicClient;
}
describe("Sticky durable submission recovery", () => {
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
    clearStickyPending(storage, key, record);
    expect(readStickyPending(storage, key)).not.toBeNull();
  });
  it("verifies the exact EOA payload and fresh canonical receipt", async () => {
    const record = saved();
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
    const record = saved(true);
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
