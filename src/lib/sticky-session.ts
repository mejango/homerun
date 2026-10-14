/** Durable duplicate protection. Recovery state can block a write, but can never prove execution. */
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { FundTransaction } from "./fund-contracts";
import { verifyReviewedWriteReceipt, writeIntentKey, type ReviewedWriteRecoveryInput } from "@bananapus/nana-sdk-core/review";
import { jbControllerAbi, jbMultiTerminalAbi } from "@bananapus/nana-sdk-core";
import type { TxRequest } from "@/hooks/useSafeTx";
import type { LegacyWriteEvidence } from "./write-hold";
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

/** The holder's Sticky actions, each held under its own intent while unresolved. */
const STICKY_ACTIONS: Record<string, string> = {
  claimTokensFor: "sticky-claim-credits",
  approve: "sticky-approve",
  pay: "sticky-stake",
  cashOutTokensOf: "sticky-unstake",
  beginVesting: "sticky-rewards-vest",
  collectVestedRewards: "sticky-rewards-collect",
};
const STICKY_ABI = [...jbControllerAbi, ...jbMultiTerminalAbi, ...erc20Abi, ...parseAbi([
  "function beginVesting(address token, uint256[] tokenIds, address[] tokens)",
  "function collectVestedRewards(address token, uint256[] tokenIds, address[] tokens, address beneficiary)",
])];

/**
 * A holder action's hold: the Sticky project and the action, one at a time. Its amounts and quoted
 * minimums are left out, so a retry of the action is held while one is unresolved.
 * TODO(SDK 2.38): the SDK's shared builder.
 */
export function stickyIntent(projectId: bigint, functionName: string): string {
  const action = STICKY_ACTIONS[functionName];
  if (!action) throw new Error(`Unknown Sticky action: ${functionName}`);
  return writeIntentKey(action, { project: projectId });
}

/** A record the Sticky journal saved before SDK holds: the request it was, and the hold it is adopted into. */
export function stickyPendingHold(record: StickyPending): {
  request: TxRequest;
  input: ReviewedWriteRecoveryInput;
  evidence: LegacyWriteEvidence;
} {
  const { functionName, args } = decodeFunctionData({ abi: STICKY_ABI, data: record.data });
  const value = BigInt(record.value);
  return {
    request: { chainId: record.chainId, address: record.target, abi: STICKY_ABI, functionName, args: args ?? [], value, label: record.label },
    input: {
      chainId: record.chainId, account: record.holder, safe: record.safe,
      namespace: stickyIntent(BigInt(record.projectId), functionName),
      call: { to: record.target, data: record.data, value },
    },
    evidence: { submittedAt: record.submittedAt, ...(record.hash ? record.safe ? { safe: { safeTxHash: record.hash } } : { hash: record.hash } : {}) },
  };
}
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
