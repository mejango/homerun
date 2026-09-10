"use client";

import { type JBChainId } from "@bananapus/nana-sdk-core";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  formatUnits,
  isAddressEqual,
  type Address,
  type PublicClient,
} from "viem";
import { usePublicClient } from "wagmi";
import {
  useSafeTx,
  txPhaseLabel,
  type TxRequest,
  type TxSendOptions,
} from "@/hooks/useSafeTx";
import { useWallet } from "@/hooks/useWallet";
import { displayChainName, explorerTxUrl } from "@/lib/chainDisplay";
import { parseAmount } from "@/lib/fund-contracts";
import {
  buildStickyApproval,
  buildStickyCreditClaim,
  buildStickyRewardClaim,
  buildStickyStake,
  buildStickyUnstake,
} from "@/lib/sticky-contracts";
import {
  quoteStickyStake,
  quoteStickyUnstake,
  readStickyRewards,
  readStickyProjectState,
  type StickyProjectState,
  type StickyRewardState,
} from "@/lib/sticky-state";
import {
  beginStickySubmission,
  clearStickyPending,
  readStickyPending,
  recordStickyHash,
  stickySessionKey,
  verifyStickyExecution,
  type StickyPending,
} from "@/lib/sticky-session";
import { isSafeConnection } from "@/lib/safe-connector";
import { wagmiConfig } from "@/providers/Providers";

export type StickyHolderProps = {
  chainId: JBChainId;
  fundProjectId: bigint;
  stickyProjectId: bigint;
  incomeProjectId?: bigint;
};
type StickyTx = ReturnType<typeof useSafeTx>;
const units = (value: bigint) => formatUnits(value, 18);
function reason(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The Sticky contracts could not be verified. Refresh and try again.";
}
function parse(value: string) {
  try {
    return parseAmount(value, 18);
  } catch {
    return 0n;
  }
}
function duration(seconds: bigint) {
  const days = seconds / 86400n;
  return days > 0n
    ? `${days.toString()} ${days === 1n ? "day" : "days"}`
    : `${(seconds / 3600n).toString()} hours`;
}
const inputClass =
  "min-h-12 w-full rounded border border-[#bfc9b5] bg-white px-3 text-base";
const JOURNAL_EVENT = "homerun-sticky-recovery";
function changedJournal() {
  window.dispatchEvent(new Event(JOURNAL_EVENT));
}
function useStickyJournal(
  chainId: number,
  projectId: bigint,
  account?: Address,
) {
  const key = account ? stickySessionKey(chainId, projectId, account) : null;
  const [pending, setPending] = useState<StickyPending | null>(null),
    [error, setError] = useState<string | null>(null),
    [readyKey, setReadyKey] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    function read() {
      try {
        setPending(key ? readStickyPending(localStorage, key) : null);
        setError(null);
      } catch (failure) {
        setError(reason(failure));
      } finally {
        setReadyKey(key);
      }
    }
    read();
    window.addEventListener(JOURNAL_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(JOURNAL_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [key]);
  return { key, pending, error, ready: readyKey === key };
}
function Status({ tx, chainId }: { tx: StickyTx; chainId: number }) {
  const link =
    tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null;
  return (
    <div role="status" aria-live="polite" className="mt-4 break-words text-sm">
      {tx.safeProposalHash ? (
        <p>
          Proposed to Safe. This action still needs execution and onchain
          confirmation.
        </p>
      ) : tx.phase === "pending" ? (
        <p>Submitted. Waiting for onchain confirmation…</p>
      ) : tx.phase === "success" ? (
        <p>Confirmed onchain. Balances and available actions are refreshing.</p>
      ) : null}
      {tx.error && <p className="text-red-800">{tx.error}</p>}
      {link && (
        <a className="underline" href={link} target="_blank" rel="noreferrer">
          View transaction
        </a>
      )}
    </div>
  );
}
function useStickyTx(state: StickyProjectState) {
  const tx = useSafeTx(state.chainId),
    cache = useQueryClient(),
    previous = useRef<string | null>(null),
    prerequisite = useRef<bigint | undefined>(undefined);
  const { address } = useWallet(),
    client = usePublicClient({ chainId: state.chainId }) as
      | PublicClient
      | undefined;
  const journal = useStickyJournal(
    state.chainId,
    state.stickyProjectId,
    address,
  );
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  useEffect(() => {
    if (
      tx.phase !== "success" ||
      !tx.receipt ||
      previous.current === tx.receipt.transactionHash
    )
      return;
    previous.current = tx.receipt.transactionHash;
    prerequisite.current = tx.receipt.blockNumber;
    for (const key of [
      "sticky-project",
      "sticky-stake",
      "sticky-unstake",
      "sticky-rewards",
    ])
      void cache.invalidateQueries({
        queryKey: [key, state.chainId, state.stickyProjectId.toString()],
      });
    void cache.invalidateQueries({
      queryKey: ["fund-project", state.chainId, state.fundProjectId.toString()],
    });
    if (state.rewards)
      void cache.invalidateQueries({
        queryKey: [
          "income-project",
          state.chainId,
          state.rewards.incomeProjectId.toString(),
        ],
      });
    if (client && journal.pending && journal.key) {
      const record = journal.pending,
        key = journal.key;
      void verifyStickyExecution(client, record, tx.receipt.transactionHash)
        .then(() => {
          clearStickyPending(localStorage, key, record);
          changedJournal();
        })
        .catch((failure) => setRecoveryError(reason(failure)));
    }
  }, [
    cache,
    client,
    journal.key,
    journal.pending,
    state.chainId,
    state.fundProjectId,
    state.stickyProjectId,
    state.rewards,
    tx.phase,
    tx.receipt,
  ]);
  async function send(request: TxRequest, options?: TxSendOptions) {
    if (
      !address ||
      !client ||
      !journal.key ||
      !journal.ready ||
      journal.error ||
      journal.pending
    )
      throw new Error(
        "Resolve the saved Sticky transaction before sending another action.",
      );
    let record: StickyPending | null = null;
    const key = journal.key;
    const hash = await tx.send(request, {
      ...options,
      beforeWrite: async () => {
        await options?.beforeWrite?.();
        if ((await client.getChainId()) !== state.chainId)
          throw new Error("The Sticky RPC changed networks.");
        const block = await client.getBlock({ blockTag: "latest" });
        if (block.number === null)
          throw new Error("A confirmed block is required before submission.");
        const save = () => {
          record = beginStickySubmission(
            localStorage,
            key,
            request,
            state.stickyProjectId,
            address,
            isSafeConnection(wagmiConfig),
            request.label ?? "Sticky transaction",
            block.number!,
          );
          changedJournal();
        };
        if (!navigator.locks)
          throw new Error(
            "This browser cannot coordinate Sticky transaction recovery across tabs. Use a browser with Web Locks support.",
          );
        await navigator.locks.request(`sticky-submit:${key}`, save);
      },
      onWriteRejected: async () => {
        if (record) clearStickyPending(localStorage, key, record);
        changedJournal();
        await options?.onWriteRejected?.();
      },
    });
    if (hash) {
      recordStickyHash(localStorage, key, hash);
      changedJournal();
    }
    return hash;
  }
  return {
    tx: {
      ...tx,
      send,
      busy: tx.busy || !journal.ready || !!journal.pending || !!journal.error,
      error: tx.error ?? journal.error ?? recoveryError,
    },
    prerequisite,
  };
}
async function fresh(
  client: PublicClient,
  state: StickyProjectState,
  account: Address,
  minimumBlock?: bigint,
  includeRewards = false,
) {
  const current = await readStickyProjectState(client, {
    chainId: state.chainId,
    fundProjectId: state.fundProjectId,
    stickyProjectId: state.stickyProjectId,
    incomeProjectId: includeRewards
      ? state.rewards?.incomeProjectId
      : undefined,
    account,
  });
  if (minimumBlock !== undefined && current.blockNumber < minimumBlock)
    throw new Error(
      "The RPC has not caught up with your confirmed prerequisite. Wait a moment and try again.",
    );
  for (const field of [
    "deployer",
    "fundToken",
    "shareToken",
    "terminal",
    "controller",
    "hook",
    "feed",
  ] as const)
    if (!isAddressEqual(current[field], state[field]))
      throw new Error(
        "The Sticky contract bindings changed. Refresh before continuing.",
      );
  return current;
}

/** Candidate project IDs are checked against registered deployments and live contract bindings before writes appear. */
export function StickyHolder({
  chainId,
  fundProjectId,
  stickyProjectId,
  incomeProjectId,
}: StickyHolderProps) {
  const { address } = useWallet();
  const client = usePublicClient({ chainId }) as PublicClient | undefined;
  const [page, setPage] = useState(0n),
    [lastState, setLastState] = useState<StickyProjectState | null>(null);
  const query = useQuery({
    queryKey: [
      "sticky-project",
      chainId,
      stickyProjectId.toString(),
      fundProjectId.toString(),
      incomeProjectId?.toString(),
      address,
      page.toString(),
    ],
    enabled: !!client,
    queryFn: () =>
      readStickyProjectState(client!, {
        chainId,
        fundProjectId,
        stickyProjectId,
        account: address,
        tranchePage: page,
      }),
    staleTime: 10_000,
    refetchInterval: 20_000,
    retry: 1,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (query.data) setLastState(query.data);
  }, [query.data]);
  const state = query.data ?? lastState;
  const accountMatches = query.data?.account
    ? !!address && isAddressEqual(query.data.account, address)
    : !address;
  const unavailable =
    query.isError || query.isPlaceholderData || !query.data || !accountMatches;
  return (
    <section className="mt-8" aria-label="FUND staking and SHARE rewards">
      <h2 className="mb-4 text-4xl">Stake FUND</h2>
      <p className="mb-5">
        Stake FUND to receive SHARE for ongoing INCOME rewards. The initial
        INCOME allocation follows all FUND ownership separately.
      </p>
      {query.isPending && <p role="status">Verifying the Sticky contracts…</p>}
      {query.isError && (
        <div className="rounded border border-[#d8d3bd] p-5" role="alert">
          <p>{reason(query.error)}</p>
          <button
            type="button"
            className="btn-secondary mt-4"
            onClick={() => void query.refetch()}
          >
            Check again
          </button>
        </div>
      )}
      {client && (
        <StickyRecovery
          chainId={chainId}
          projectId={stickyProjectId}
          client={client}
        />
      )}
      {state &&
        state.chainId === chainId &&
        state.fundProjectId === fundProjectId &&
        state.stickyProjectId === stickyProjectId &&
        client && (
          <fieldset
            key={`${chainId}:${fundProjectId}:${stickyProjectId}`}
            className="m-0 min-w-0 border-0 p-0"
            disabled={unavailable}
            aria-label="Sticky holder actions"
          >
            <StickyActions
              state={state}
              client={client}
              incomeProjectId={incomeProjectId}
            />
            <div className="mt-7 rounded border border-[#c4cdbb] p-5 sm:p-7">
              <h3 className="text-2xl">Your staking history</h3>
              <p className="mt-3 text-sm">
                Current streak:{" "}
                {duration(
                  state.streakStart
                    ? state.blockTimestamp - state.streakStart
                    : 0n,
                )}
                . Longest: {duration(state.longestStreak)}.
              </p>
              <p className="mt-3 text-sm">
                Unstaking consumes your newest tranches first. Your streak ends
                when your SHARE balance reaches zero. Streak age is shown
                separately from reward eligibility.
              </p>
              {state.tranches.length ? (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th className="py-2 pr-4">SHARE</th>
                        <th className="py-2">Staked since</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...state.tranches].reverse().map((tranche, index) => (
                        <tr key={`${state.trancheStart}:${index}`}>
                          <td className="break-all py-2 pr-4">
                            {units(tranche.amount)}
                          </td>
                          <td className="py-2">
                            {new Date(
                              tranche.timestamp * 1000,
                            ).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-4 text-sm">No active tranches on this page.</p>
              )}
              {state.trancheCount > 50n && (
                <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
                  <button
                    type="button"
                    className="underline"
                    disabled={page === 0n}
                    onClick={() => setPage((value) => value - 1n)}
                  >
                    Newer tranches
                  </button>
                  <span>
                    {state.tranches.length
                      ? `${(state.trancheStart + 1n).toString()}–${(state.trancheStart + BigInt(state.tranches.length)).toString()}`
                      : "0"}{" "}
                    of {state.trancheCount.toString()}
                  </span>
                  <button
                    type="button"
                    className="underline"
                    disabled={state.trancheStart === 0n}
                    onClick={() => setPage((value) => value + 1n)}
                  >
                    Older tranches
                  </button>
                </div>
              )}
            </div>
          </fieldset>
        )}
    </section>
  );
}

function StickyActions({
  state,
  client,
  incomeProjectId,
}: {
  state: StickyProjectState;
  client: PublicClient;
  incomeProjectId?: bigint;
}) {
  return (
    <div className="grid gap-7">
      <div className="rounded border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
        <p className="text-sm">
          Sticky project {state.stickyProjectId.toString()} verified at block{" "}
          {state.blockNumber.toString()}
        </p>
        <dl className="mt-5 grid gap-5 sm:grid-cols-3">
          <div>
            <dt className="text-sm">FUND available to stake</dt>
            <dd className="mt-2 break-all text-2xl">
              {units(state.fundBalance)}
            </dd>
          </div>
          <div>
            <dt className="text-sm">FUND credits</dt>
            <dd className="mt-2 break-all text-2xl">
              {units(state.fundCreditBalance)}
            </dd>
          </div>
          <div>
            <dt className="text-sm">Your SHARE</dt>
            <dd className="mt-2 break-all text-2xl">
              {units(state.shareBalance)}
            </dd>
          </div>
        </dl>
        <p className="mt-5 text-sm">
          SHARE represents your share of the staked FUND pool. Its exchange rate
          can change; one SHARE is not guaranteed to return one FUND. Unstaking
          returns FUND according to the live quote.
        </p>
        <p className="mt-3 text-sm">
          Unstaking tax: {formatUnits(state.cashOutTaxRate, 2)}%. Applicable
          terminal fees are included in your quote.{" "}
          {state.soulbound
            ? "SHARE transfers between wallets are disabled."
            : "SHARE transfers create fresh tranches for the recipient."}
        </p>
        {!state.account && (
          <p className="mt-4">
            Connect your wallet to see your position and review transactions.
          </p>
        )}
      </div>
      <div className="grid items-start gap-7 lg:grid-cols-2">
        <StickyStake state={state} client={client} />
        <StickyUnstake state={state} client={client} />
      </div>
      {incomeProjectId ? (
        <StickyRewardPanel
          state={state}
          client={client}
          incomeProjectId={incomeProjectId}
        />
      ) : (
        <div className="rounded border border-[#c4cdbb] p-5 text-sm">
          <p>
            {state.rewardIssue ??
              "An INCOME project with a verified SHARE reward route is required before rewards can be shown."}
          </p>
          <p className="mt-3">
            The standard distributor allocates by SHARE balances at snapshots. A
            longer streak does not automatically increase that allocation.
          </p>
        </div>
      )}
    </div>
  );
}

/** Reward history loads independently so it cannot delay staking, balances, or receipt watchers. */
function StickyRewardPanel({
  state,
  client,
  incomeProjectId,
}: {
  state: StickyProjectState;
  client: PublicClient;
  incomeProjectId: bigint;
}) {
  const [lastRewards, setLastRewards] = useState<StickyRewardState | null>(
    null,
  );
  const query = useQuery({
    queryKey: [
      "sticky-rewards",
      state.chainId,
      state.stickyProjectId.toString(),
      incomeProjectId.toString(),
      state.blockNumber.toString(),
      state.account,
    ],
    queryFn: () => readStickyRewards(client, state, incomeProjectId),
    staleTime: 10_000,
    retry: 1,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (query.data) setLastRewards(query.data);
  }, [query.data]);
  const rewards = query.data ?? lastRewards;
  return (
    <div>
      {query.isPending && <p role="status">Reading completed reward rounds…</p>}
      {query.isError && (
        <p role="alert" className="mb-4 text-sm">
          {reason(query.error)}
        </p>
      )}
      {rewards && (
        <fieldset
          className="m-0 min-w-0 border-0 p-0"
          disabled={!query.data || query.isError || query.isPlaceholderData}
          aria-label="SHARE reward transactions"
        >
          <StickyRewards state={{ ...state, rewards }} client={client} />
        </fieldset>
      )}
    </div>
  );
}

function StickyStake({
  state,
  client,
}: {
  state: StickyProjectState;
  client: PublicClient;
}) {
  const { address } = useWallet(),
    { tx, prerequisite } = useStickyTx(state);
  const [input, setInput] = useState(""),
    [error, setError] = useState<string | null>(null),
    [preparing, setPreparing] = useState(false);
  const count = parse(input),
    shortfall = count > state.fundBalance ? count - state.fundBalance : 0n;
  const creditStep = shortfall > 0n && shortfall <= state.fundCreditBalance;
  const approvalStep = !creditStep && state.allowance !== count;
  const busy = preparing || tx.busy || tx.phase === "review";
  const quote = useQuery({
    queryKey: [
      "sticky-stake",
      state.chainId,
      state.stickyProjectId.toString(),
      state.blockNumber.toString(),
      address,
      count.toString(),
    ],
    enabled: !!address && count > 0n && count <= state.fundBalance,
    queryFn: () => quoteStickyStake(client, state, count),
    staleTime: 10_000,
    retry: false,
  });
  async function submit() {
    if (!address || count <= 0n) return;
    setPreparing(true);
    setError(null);
    try {
      const current = await fresh(client, state, address, prerequisite.current);
      if (count > current.fundBalance) {
        const claim = count - current.fundBalance;
        if (claim > current.fundCreditBalance)
          throw new Error("Your available FUND balance is too small.");
        await tx.send(
          {
            ...buildStickyCreditClaim(current, address, claim),
            label: `Claim ${units(claim)} FUND credits as ERC20 before staking`,
          },
          {
            reverify: async () => {
              const latest = await fresh(client, current, address);
              if (claim > latest.fundCreditBalance)
                throw new Error("Your FUND credits changed.");
            },
          },
        );
        return;
      }
      const latestQuote = await quoteStickyStake(client, current, count);
      const approval = buildStickyApproval(current, current.allowance, count);
      if (approval) {
        const reset = approval.args[1] === 0n;
        await tx.send(
          {
            ...approval,
            label: reset
              ? "Reset the prior FUND allowance before approving this stake"
              : `Approve exactly ${units(count)} FUND for the Sticky terminal`,
          },
          {
            simulationBlockNumber: current.blockNumber,
            reverify: async () => {
              const latest = await fresh(
                client,
                current,
                address,
                prerequisite.current,
              );
              if (
                latest.allowance !== current.allowance ||
                count > latest.fundBalance
              )
                throw new Error(
                  "Your allowance or available FUND changed. Review the next step again.",
                );
            },
          },
        );
        return;
      }
      await tx.send(
        {
          ...buildStickyStake(
            current,
            address,
            count,
            latestQuote.minimumShares,
          ),
          label: `Stake ${units(count)} FUND; receive at least ${units(latestQuote.minimumShares)} SHARE`,
        },
        {
          simulationBlockNumber: current.blockNumber,
          reviewNotice: `Your FUND moves into the Sticky pool. The permanent unstaking tax is ${formatUnits(current.cashOutTaxRate, 2)}%, plus applicable terminal fees. ${quote.data && latestQuote.minimumShares < quote.data.minimumShares ? "The SHARE quote decreased since it was displayed." : ""}`,
          reverify: async () => {
            const latest = await fresh(
              client,
              current,
              address,
              prerequisite.current,
            );
            if (
              latest.allowance !== count ||
              count > latest.fundBalance ||
              (await quoteStickyStake(client, latest, count)).shares <
                latestQuote.minimumShares
            )
              throw new Error(
                "The stake conditions changed during review. Refresh the quote.",
              );
          },
        },
      );
    } catch (failure) {
      setError(reason(failure));
    } finally {
      setPreparing(false);
    }
  }
  return (
    <section className="rounded border border-[#c4cdbb] p-5 sm:p-7">
      <h3 className="mb-5 text-2xl">Receive SHARE</h3>
      <label className="grid gap-2 text-sm">
        FUND to stake
        <input
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={busy}
        />
      </label>
      <button
        type="button"
        className="mt-2 text-sm underline"
        disabled={busy}
        onClick={() =>
          setInput(units(state.fundBalance + state.fundCreditBalance))
        }
      >
        Use available FUND
      </button>
      <p className="mt-4 text-sm">
        Claim any required FUND credits, approve this exact amount, then review
        the stake. Each step requires confirmation before the next becomes
        available. SHARE activates its own snapshot voting power automatically.
      </p>
      {quote.data && (
        <p className="mt-3 break-words text-sm">
          At least {units(quote.data.minimumShares)} SHARE with 1% maximum
          slippage.
        </p>
      )}
      {quote.isError && (
        <p role="alert" className="mt-3 text-sm">
          {reason(quote.error)}
        </p>
      )}
      <button
        type="button"
        className="btn-primary mt-5 min-h-11 px-5"
        disabled={
          !address ||
          busy ||
          count <= 0n ||
          count > state.fundBalance + state.fundCreditBalance ||
          (!creditStep && !quote.data)
        }
        onClick={() => void submit()}
      >
        {preparing
          ? "Preparing…"
          : txPhaseLabel(tx.phase, {
              idle: creditStep
                ? "Review credit claim"
                : approvalStep
                  ? state.allowance > 0n
                    ? "Review allowance reset"
                    : "Review FUND approval"
                  : "Review stake",
              pending: "Confirming onchain…",
            })}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <Status tx={tx} chainId={state.chainId} />
    </section>
  );
}

function StickyUnstake({
  state,
  client,
}: {
  state: StickyProjectState;
  client: PublicClient;
}) {
  const { address } = useWallet(),
    { tx } = useStickyTx(state);
  const [input, setInput] = useState(""),
    [error, setError] = useState<string | null>(null),
    [preparing, setPreparing] = useState(false);
  const count = parse(input),
    busy = preparing || tx.busy || tx.phase === "review";
  const quote = useQuery({
    queryKey: [
      "sticky-unstake",
      state.chainId,
      state.stickyProjectId.toString(),
      state.blockNumber.toString(),
      address,
      count.toString(),
    ],
    enabled: !!address && count > 0n && count <= state.shareBalance,
    queryFn: () => quoteStickyUnstake(client, state, count),
    staleTime: 10_000,
    retry: false,
  });
  async function submit() {
    if (!address || count <= 0n || !quote.data) return;
    setPreparing(true);
    setError(null);
    try {
      const current = await fresh(client, state, address),
        latestQuote = await quoteStickyUnstake(client, current, count);
      await tx.send(
        {
          ...buildStickyUnstake(
            current,
            address,
            count,
            latestQuote.minimumFund,
          ),
          label: `Unstake ${units(count)} SHARE; receive at least ${units(latestQuote.minimumFund)} FUND`,
        },
        {
          reviewNotice: `${count === current.shareBalance ? "This exits your entire SHARE position and ends your current staking streak. " : "This consumes your newest SHARE tranches first. "}${latestQuote.minimumFund < quote.data.minimumFund ? "The protected FUND return decreased since it was displayed." : ""}`,
          reverify: async () => {
            const latest = await fresh(client, current, address);
            if (
              count > latest.shareBalance ||
              (await quoteStickyUnstake(client, latest, count)).fund <
                latestQuote.minimumFund
            )
              throw new Error(
                "The unstake conditions changed during review. Refresh the quote.",
              );
          },
        },
      );
    } catch (failure) {
      setError(reason(failure));
    } finally {
      setPreparing(false);
    }
  }
  return (
    <section className="rounded border border-[#c4cdbb] p-5 sm:p-7">
      <h3 className="mb-5 text-2xl">Return to FUND</h3>
      <label className="grid gap-2 text-sm">
        SHARE to unstake
        <input
          className={inputClass}
          inputMode="decimal"
          autoComplete="off"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          disabled={busy}
        />
      </label>
      <button
        type="button"
        className="mt-2 text-sm underline"
        disabled={busy}
        onClick={() => setInput(units(state.shareBalance))}
      >
        Use full SHARE balance
      </button>
      <p className="mt-4 text-sm">
        Burn SHARE to reclaim its share of the staked FUND backing. This returns
        FUND to your wallet; it does not cash out FUND for treasury money. To
        claim refunds or asset-sale proceeds, unstake first, then use Cash out
        FUND once cash-outs are open.
      </p>
      {quote.data && (
        <p className="mt-3 break-words text-sm">
          At least {units(quote.data.minimumFund)} FUND after applicable fees,
          with 1% maximum slippage.
        </p>
      )}
      {quote.isError && (
        <p role="alert" className="mt-3 text-sm">
          {reason(quote.error)}
        </p>
      )}
      {state.cashOutTaxRate === 10_000n && (
        <p className="mt-3 text-sm">
          This pool has a 100% unstaking tax and returns no FUND. A zero-return
          burn is unavailable in this withdrawal control.
        </p>
      )}
      <button
        type="button"
        className="btn-primary mt-5 min-h-11 px-5"
        disabled={
          !address ||
          busy ||
          count <= 0n ||
          count > state.shareBalance ||
          !quote.data
        }
        onClick={() => void submit()}
      >
        {preparing
          ? "Preparing…"
          : txPhaseLabel(tx.phase, {
              idle: "Review unstake",
              pending: "Confirming onchain…",
            })}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <Status tx={tx} chainId={state.chainId} />
    </section>
  );
}

export function StickyRewards({
  state,
  client,
}: {
  state: StickyProjectState;
  client: PublicClient;
}) {
  const { address } = useWallet(),
    { tx } = useStickyTx(state);
  const [error, setError] = useState<string | null>(null),
    [preparing, setPreparing] = useState(false);
  const rewards = state.rewards,
    busy = preparing || tx.busy || tx.phase === "review";
  if (!rewards) return null;
  async function submit(collect: boolean) {
    if (!address || !rewards) return;
    setPreparing(true);
    setError(null);
    try {
      const current = await fresh(client, state, address, undefined, true),
        latest = current.rewards;
      if (
        !latest ||
        latest.activeVestingLoanId !== 0n ||
        (collect ? latest.collectable <= 0n : latest.eligibleUnvested <= 0n)
      )
        throw new Error(
          "No rewards are available for this action, or the vesting position is committed to a loan.",
        );
      await tx.send(
        {
          ...buildStickyRewardClaim(
            current,
            address,
            latest.incomeToken,
            collect,
          ),
          label: collect
            ? `Collect ${units(latest.collectable)} unlocked INCOME rewards`
            : `Begin vesting ${units(latest.eligibleUnvested)} INCOME rewards`,
        },
        {
          reviewNotice: collect
            ? "Collection also starts vesting any eligible completed rounds. Current-round rewards remain unavailable."
            : `These rewards unlock in equal portions at the next ${latest.vestingRounds.toString()} round boundaries after this claim. Each round lasts ${duration(latest.roundDuration)}.`,
          reverify: async () => {
            const checked = (
              await fresh(client, current, address, undefined, true)
            ).rewards;
            if (
              !checked ||
              checked.activeVestingLoanId !== 0n ||
              !isAddressEqual(checked.incomeToken, latest.incomeToken) ||
              (collect
                ? checked.collectable < latest.collectable
                : checked.eligibleUnvested < latest.eligibleUnvested)
            )
              throw new Error(
                "Your available rewards decreased during review. Review the updated allocation.",
              );
          },
        },
      );
    } catch (failure) {
      setError(reason(failure));
    } finally {
      setPreparing(false);
    }
  }
  return (
    <section className="rounded border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
      <h3 className="text-2xl">Your SHARE rewards</h3>
      <p className="mt-3 text-sm">
        This distributor allocates by SHARE held at each completed round’s
        snapshot. Staying staked lets you participate in more rounds; there is
        no minimum staking duration or age multiplier. SHARE delegation is
        automatic and stays with its holder.
      </p>
      <p className="mt-3 text-sm">
        This pool receives rewards from INCOME distributed on{" "}
        {displayChainName(state.chainId)}.
      </p>
      {!rewards.fundingActive && (
        <p className="mt-3 text-sm">
          The current INCOME ruleset no longer routes new rewards here. Existing
          rewards remain available according to their recorded entitlement.
        </p>
      )}
      <dl className="mt-5 grid gap-5 sm:grid-cols-3">
        <div>
          <dt className="text-sm">Ready to collect</dt>
          <dd className="mt-2 break-all text-xl">
            {units(rewards.collectable)} INCOME
          </dd>
        </div>
        <div>
          <dt className="text-sm">
            {rewards.activeVestingLoanId
              ? "Vesting position in a loan"
              : "Still vesting"}
          </dt>
          <dd className="mt-2 break-all text-xl">
            {units(rewards.claimed - rewards.collectable)} INCOME
          </dd>
        </div>
        <div>
          <dt className="text-sm">Ready to begin vesting</dt>
          <dd className="mt-2 break-all text-xl">
            {units(rewards.eligibleUnvested)} INCOME
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-sm">
        Rounds last {duration(rewards.roundDuration)}. New claims unlock in
        equal portions at the next {rewards.vestingRounds.toString()} round
        boundaries.
      </p>
      {rewards.historyIssue && (
        <p className="mt-3 text-sm">{rewards.historyIssue}</p>
      )}
      {rewards.activeVestingLoanId !== 0n && (
        <p className="mt-3 text-sm">
          Vesting loan {rewards.activeVestingLoanId.toString()} uses this
          position as collateral. Resolve it in the distributor’s loan interface
          before claiming these rewards.
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn-primary min-h-11 px-5"
          disabled={
            !address ||
            busy ||
            rewards.activeVestingLoanId !== 0n ||
            rewards.collectable <= 0n
          }
          onClick={() => void submit(true)}
        >
          Review collection
        </button>
        <button
          type="button"
          className="btn-secondary min-h-11 px-5"
          disabled={
            !address ||
            busy ||
            rewards.activeVestingLoanId !== 0n ||
            rewards.eligibleUnvested <= 0n
          }
          onClick={() => void submit(false)}
        >
          Review vesting
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <Status tx={tx} chainId={state.chainId} />
    </section>
  );
}

function StickyRecovery({
  chainId,
  projectId,
  client,
}: {
  chainId: number;
  projectId: bigint;
  client: PublicClient;
}) {
  const { address } = useWallet(),
    journal = useStickyJournal(chainId, projectId, address),
    cache = useQueryClient();
  const [execution, setExecution] = useState(""),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const pending = journal.pending;
  async function recover() {
    if (!pending || !journal.key) return;
    const hash = execution.trim() || (!pending.safe ? pending.hash : null);
    if (!hash || !/^0x[\da-fA-F]{64}$/.test(hash)) {
      setError("Enter the onchain execution hash from your wallet or Safe.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyStickyExecution(client, pending, hash as `0x${string}`);
      clearStickyPending(localStorage, journal.key, pending);
      changedJournal();
      void cache.invalidateQueries({
        queryKey: ["sticky-project", chainId, projectId.toString()],
      });
    } catch (failure) {
      setError(reason(failure));
    } finally {
      setBusy(false);
    }
  }
  if (journal.error)
    return (
      <p role="alert" className="mb-5 text-red-800">
        {journal.error}
      </p>
    );
  if (!pending) return null;
  return (
    <div
      className="mb-6 rounded border border-[#c4cdbb] bg-[#eef1e7] p-5"
      aria-label="Pending Sticky transaction"
    >
      <h3 className="text-2xl">Saved transaction</h3>
      <p className="mt-3 break-words">{pending.label}</p>
      <p className="mt-3 text-sm">
        {pending.hash
          ? pending.safe
            ? "A Safe proposal was submitted. It still needs execution."
            : "A transaction was submitted. Its receipt still needs verification."
          : "Wallet submission may have started, but no hash was returned. Check wallet history before continuing."}{" "}
        Another Sticky action stays unavailable until this record is resolved.
      </p>
      {pending.hash && (
        <p className="mt-3 break-all text-sm">
          {pending.safe ? "Safe proposal" : "Transaction"}: {pending.hash}
        </p>
      )}
      <label className="mt-4 grid gap-2 text-sm">
        Onchain execution hash
        <input
          className={inputClass}
          value={execution}
          onChange={(event) => setExecution(event.target.value)}
          placeholder={
            pending.safe ? "Execution hash from Safe" : (pending.hash ?? "0x…")
          }
          autoComplete="off"
        />
      </label>
      <button
        type="button"
        className="btn-secondary mt-4 min-h-11 px-5"
        disabled={busy}
        onClick={() => void recover()}
      >
        {busy ? "Checking execution…" : "Verify execution"}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
