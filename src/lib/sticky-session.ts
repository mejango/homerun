/** Durable duplicate protection. Recovery state can block a write, but can never prove execution. */
import {
  encodeFunctionData,
  isAddress,
  isAddressEqual,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { FundTransaction } from "./fund-contracts";
import { withPrewalletReservation } from "./prewallet-reservation";
import { verifyReviewedWriteReceipt } from "@bananapus/nana-sdk-core/review";
import {
  heldCall,
  type SafeAppCall,
  safeExecutionRunsCalls,
  safeExecutionResult,
} from "@bananapus/nana-sdk-core/safe-service";

export type StickyPending = {
  version: 1;
  /** Legacy records remain readable; every new reservation has a unique identity. */
  id?: string;
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
export type ExistingSafeProposal = { proposalHash: Hex; call: SafeAppCall };
/** Exact immutable plans remain exact; raw journals may retain a shared SDK-recognized earlier stamp. */
export function assertSafeProposalCall(
  request: FundTransaction,
  proposal: ExistingSafeProposal,
  allowEarlierStamp = false,
): void {
  if (
    !HASH.test(proposal.proposalHash) ||
    proposal.proposalHash.toLowerCase() === zeroHash
  )
    throw new Error("Use a valid existing Safe proposal hash.");
  const expected = {
    to: request.address,
    data: encodeFunctionData(request),
    value: request.value ?? 0n,
  };
  const actual = proposal.call;
  if (
    !isAddress(actual.to) ||
    !/^0x(?:[\da-f]{2})+$/i.test(actual.data) ||
    typeof (actual.value ?? 0n) !== "bigint" ||
    (actual.value ?? 0n) < 0n
  )
    throw new Error("The existing Safe proposal call is invalid.");
  const left = allowEarlierStamp ? heldCall(expected) : expected;
  const right = allowEarlierStamp ? heldCall(actual) : actual;
  if (
    !isAddressEqual(left.to, right.to) ||
    left.data.toLowerCase() !== right.data.toLowerCase() ||
    (left.value ?? 0n) !== (right.value ?? 0n)
  )
    throw new Error(
      "The existing Safe proposal does not match the saved action.",
    );
}
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
    (value.id !== undefined && (typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id))) ||
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
function persistStickySubmission(
  storage: StickyStorage,
  key: string,
  request: FundTransaction,
  projectId: bigint,
  holder: Address,
  safe: boolean,
  label: string,
  afterBlock: bigint,
  proposal?: ExistingSafeProposal,
): StickyPending {
  if (readStickyPending(storage, key))
    throw new Error(
      "A Sticky transaction may already be pending. Verify its execution before submitting another.",
    );
  if (afterBlock < 0n)
    throw new Error("A mined prerequisite block is required.");
  const record: StickyPending = {
    version: 1,
    id: crypto.randomUUID(),
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
    ...(proposal
      ? {
          target: proposal.call.to,
          data: proposal.call.data,
          value: (proposal.call.value ?? 0n).toString(),
          hash: proposal.proposalHash,
        }
      : {}),
  };
  if (key !== stickySessionKey(record.chainId, projectId, holder))
    throw new Error("The Sticky recovery identity changed.");
  const raw = JSON.stringify(record);
  const write = () => {
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw)
      throw new Error("The browser could not save Sticky transaction recovery data.");
    return record;
  };
  return proposal ? write() : withPrewalletReservation(storage, key, null, raw, write);
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
  return persistStickySubmission(
    storage,
    key,
    request,
    projectId,
    holder,
    safe,
    label,
    afterBlock,
  );
}
/** A known proposal hash binds historical execution; an unknown write must still use beginStickySubmission. */
export function adoptStickyProposal(
  storage: StickyStorage,
  key: string,
  request: FundTransaction,
  projectId: bigint,
  holder: Address,
  label: string,
  proposal: ExistingSafeProposal,
  afterBlock = 0n,
): StickyPending {
  assertSafeProposalCall(request, proposal, true);
  return persistStickySubmission(
    storage,
    key,
    request,
    projectId,
    holder,
    true,
    label,
    afterBlock,
    proposal,
  );
}
export function recordStickyHash(
  storage: StickyStorage,
  key: string,
  hash: Hex,
  expected?: StickyPending,
): StickyPending {
  if (!HASH.test(hash))
    throw new Error("Invalid transaction or Safe proposal hash.");
  const record = readStickyPending(storage, key);
  if (!record)
    throw new Error("The pending Sticky transaction record is missing.");
  if (expected && JSON.stringify(record) !== JSON.stringify(expected) && JSON.stringify(record) !== JSON.stringify({ ...expected, hash }))
    throw new Error("The saved Sticky transaction changed before its hash could be recorded.");
  if (record.hash && record.hash.toLowerCase() !== hash.toLowerCase())
    throw new Error("A different Sticky transaction hash is already saved.");
  if (record.hash?.toLowerCase() === hash.toLowerCase()) return record;
  const next = { ...record, hash };
  const serialized = JSON.stringify(next);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized)
    throw new Error("The browser could not save the Sticky transaction hash.");
  return next;
}
/** Only the exact hashless attempt can be withdrawn before a wallet submission. */
export function releaseStickyUnsubmitted(
  storage: StickyStorage,
  key: string,
  record: StickyPending,
): void {
  const current = readStickyPending(storage, key);
  if (record.hash || current?.hash || JSON.stringify(current) !== JSON.stringify(record))
    throw new Error("The saved Sticky transaction changed or was submitted. Keep it pending until its execution is verified.");
  clearStickyPending(storage, key, record);
  if (storage.getItem(key) !== null)
    throw new Error("The browser could not clear the unsubmitted Sticky transaction.");
}
/** Release only the exact matching record; another tab may already have advanced to a new action. */
export function clearStickyPending(
  storage: StickyStorage,
  key: string,
  record: StickyPending,
): void {
  const current = readStickyPending(storage, key);
  if (!current) return;
  if (JSON.stringify(current) !== JSON.stringify(record))
    throw new Error("The saved Sticky transaction changed. Keep the current action pending.");
  storage.removeItem(key);
  if (storage.getItem(key) !== null)
    throw new Error("The browser could not clear the verified Sticky transaction.");
}
export async function verifyStickyExecution(
  client: PublicClient,
  record: StickyPending,
  hash: Hex,
): Promise<"confirmed" | "reverted"> {
  if (!HASH.test(hash) || (await client.getChainId()) !== record.chainId)
    throw new Error("Use an execution hash on the saved Sticky network.");
  if (!record.safe && record.hash && record.hash.toLowerCase() !== hash.toLowerCase())
    throw new Error("Use the saved Sticky transaction hash.");
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
    if (
      !safeExecutionRunsCalls(
        transaction,
        record.holder,
        [
          {
            to: record.target,
            data: record.data,
            value: BigInt(record.value),
          },
        ],
        false,
      )
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
  if (reverted) {
    if (!record.hash)
      throw new Error("The wallet did not return this attempt's identity. A matching historical failure cannot release its recovery record.");
    const outcome = await verifyReviewedWriteReceipt(client, {
      version: 1, id: record.id ?? `sticky:${record.submittedAt}`, chainId: record.chainId,
      account: record.holder, safe: record.safe, hash: record.hash,
      call: { to: record.target, data: record.data, value: record.value },
    }, receipt);
    if (outcome !== "failed") throw new Error("The saved Sticky transaction has not been proven failed.");
  }
  return reverted ? "reverted" : "confirmed";
}
