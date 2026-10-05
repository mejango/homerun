/** Durable duplicate protection. Recovery state can block a write, but can never prove execution. */
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddress,
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { FundTransaction } from "./fund-contracts";
import {
  SAFE_EXEC_ABI,
  safeExecutionResult,
} from "@bananapus/nana-sdk-core/safe-service";

export type StickyPending = {
  version: 1;
  chainId: number;
  projectId: string;
  holder: Address;
  target: Address;
  data: Hex;
  value: string;
  label: string;
  safe: boolean;
  submittedAt: number;
  afterBlock: string;
  hash?: Hex;
};
export type StickyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const HASH = /^0x[\da-fA-F]{64}$/;
export function stickySessionKey(
  chainId: number,
  projectId: bigint,
  holder: Address,
) {
  return `homerun:sticky:pending:v1:${chainId}:${projectId}:${holder.toLowerCase()}`;
}
export function readStickyPending(
  storage: StickyStorage,
  key: string,
): StickyPending | null {
  const saved = storage.getItem(key);
  if (saved === null) return null;
  let value: StickyPending;
  try {
    value = JSON.parse(saved) as StickyPending;
  } catch {
    throw new Error(
      "Sticky recovery data is unreadable. Restore the saved transaction record before sending another action.",
    );
  }
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.chainId) ||
    value.chainId <= 0 ||
    !/^[1-9]\d*$/.test(value.projectId) ||
    !isAddress(value.holder) ||
    !isAddress(value.target) ||
    !/^0x(?:[\da-fA-F]{2})+$/.test(value.data) ||
    !/^\d+$/.test(value.value) ||
    !/^\d+$/.test(value.afterBlock) ||
    typeof value.safe !== "boolean" ||
    typeof value.label !== "string" ||
    !Number.isSafeInteger(value.submittedAt) ||
    (value.hash !== undefined && !HASH.test(value.hash)) ||
    key !==
      stickySessionKey(value.chainId, BigInt(value.projectId), value.holder)
  )
    throw new Error(
      "Sticky recovery data does not match this wallet and project. Resolve it before another action.",
    );
  return value;
}
export function beginStickySubmission(
  storage: StickyStorage,
  key: string,
  request: FundTransaction,
  projectId: bigint,
  holder: Address,
  safe: boolean,
  label: string,
  afterBlock: bigint,
): StickyPending {
  if (readStickyPending(storage, key))
    throw new Error(
      "A Sticky transaction may already be pending. Verify its execution before submitting another.",
    );
  if (afterBlock < 0n)
    throw new Error("A mined prerequisite block is required.");
  const record: StickyPending = {
    version: 1,
    chainId: request.chainId,
    projectId: projectId.toString(),
    holder,
    target: request.address,
    data: encodeFunctionData({
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
    }),
    value: (request.value ?? 0n).toString(),
    label,
    safe,
    submittedAt: Date.now(),
    afterBlock: afterBlock.toString(),
  };
  if (key !== stickySessionKey(record.chainId, projectId, holder))
    throw new Error("The Sticky recovery identity changed.");
  storage.setItem(key, JSON.stringify(record));
  if (storage.getItem(key) !== JSON.stringify(record))
    throw new Error(
      "The browser could not save Sticky transaction recovery data.",
    );
  return record;
}
export function recordStickyHash(
  storage: StickyStorage,
  key: string,
  hash: Hex,
): void {
  if (!HASH.test(hash))
    throw new Error("Invalid transaction or Safe proposal hash.");
  const record = readStickyPending(storage, key);
  if (!record)
    throw new Error("The pending Sticky transaction record is missing.");
  storage.setItem(key, JSON.stringify({ ...record, hash }));
}
/** Release only the exact matching record; another tab may already have advanced to a new action. */
export function clearStickyPending(
  storage: StickyStorage,
  key: string,
  record: StickyPending,
): void {
  const current = readStickyPending(storage, key);
  if (
    current &&
    current.submittedAt === record.submittedAt &&
    current.data === record.data &&
    current.target === record.target
  )
    storage.removeItem(key);
}
export async function verifyStickyExecution(
  client: PublicClient,
  record: StickyPending,
  hash: Hex,
): Promise<"confirmed" | "reverted"> {
  if (!HASH.test(hash) || (await client.getChainId()) !== record.chainId)
    throw new Error("Use an execution hash on the saved Sticky network.");
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash }),
    client.getTransactionReceipt({ hash }),
  ]);
  let reverted = receipt.status !== "success";
  if (
    receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
    transaction.hash.toLowerCase() !== hash.toLowerCase() ||
    !transaction.to ||
    transaction.blockNumber === null ||
    transaction.blockNumber !== receipt.blockNumber ||
    receipt.blockNumber <= BigInt(record.afterBlock)
  )
    throw new Error(
      "The transaction is not a new confirmed execution of this action.",
    );
  if (!record.safe) {
    if (
      !isAddressEqual(transaction.from, record.holder) ||
      !isAddressEqual(transaction.to, record.target) ||
      transaction.input.toLowerCase() !== record.data.toLowerCase() ||
      transaction.value !== BigInt(record.value)
    )
      throw new Error(
        "The execution does not match the saved Sticky transaction.",
      );
  } else {
    if (!isAddressEqual(transaction.to, record.holder))
      throw new Error("The execution is not from the saved Safe.");
    const decoded = decodeFunctionData({
      abi: SAFE_EXEC_ABI,
      data: transaction.input,
    });
    if (decoded.functionName !== "execTransaction")
      throw new Error(
        "The Safe execution does not match the saved single Sticky call.",
      );
    const [target, value, data, operation] = decoded.args;
    if (
      !isAddressEqual(target, record.target) ||
      value !== BigInt(record.value) ||
      data.toLowerCase() !== record.data.toLowerCase() ||
      operation !== 0
    )
      throw new Error(
        "The Safe execution does not match the saved single Sticky call.",
      );
    // A reverted outer transaction ran nothing and spent no nonce: the
    // proposal can still execute, so its record must stay.
    if (receipt.status !== "success")
      throw new Error(
        "The outer Safe transaction reverted before resolving its proposal. Keep this Sticky record and check Safe for its eventual execution.",
      );
    // The saved proposal hash names this execution's event. Without one, this
    // transaction is the Safe's one execTransaction, so its own hash does.
    const result = safeExecutionResult(
      receipt,
      record.holder,
      record.hash ?? hash,
    );
    if (result.status === "unproven")
      throw new Error(
        record.hash
          ? "The Safe execution does not match the saved proposal hash."
          : "The Safe has not confirmed successful execution of this call.",
      );
    reverted = result.status === "failed";
  }
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (
    canonical.hash !== receipt.blockHash ||
    transaction.blockHash !== receipt.blockHash
  )
    throw new Error(
      "The execution block changed. Wait for confirmation and check again.",
    );
  return reverted ? "reverted" : "confirmed";
}
