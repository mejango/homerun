"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPublicClient,
  formatUnits,
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { USDC_ADDRESSES, type JBChainId } from "@bananapus/nana-sdk-core";
import {
  useSafeTx,
  txPhaseLabel,
  type TxRequest,
  type TxSendOptions,
} from "@/hooks/useSafeTx";
import { useWallet } from "@/hooks/useWallet";
import {
  displayChainName,
  displayChainSlug,
  explorerTxUrl,
} from "@/lib/chainDisplay";
import { jbCenterRpcTransport } from "@/lib/jbcenter-rpc";
import { parseAmount } from "@/lib/fund-contracts";
import type { FundTransaction } from "@/lib/fund-contracts";
import type {
  BridgeProjectState,
  ProjectBridgeClientFor,
  ProjectBridgePrepareQuote,
} from "@/lib/project-bridge";
import {
  buildProjectBridgeSend,
  buildProjectBridgeClaim,
  readProjectBridgeMovements,
  readProjectBridgeSendValue,
  type ProjectBridgeRoute,
  type ProjectBridgeMovement,
} from "@/lib/project-bridge";
import { verifyFundBridgeReceipt } from "@/lib/fund-bridge-receipts";

const clients = new Map<JBChainId, PublicClient>();
function clientFor(chainId: JBChainId): PublicClient {
  let client = clients.get(chainId);
  if (!client) {
    client = createPublicClient({
      transport: jbCenterRpcTransport(chainId, 60_000),
    });
    clients.set(chainId, client);
  }
  return client;
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The bridge could not be verified. Refresh and try again.";
}
function positive(value: string) {
  try {
    return parseAmount(value.trim(), 18);
  } catch {
    return 0n;
  }
}
function referenceLink(
  state: Pick<BridgeProjectState, "chainId" | "projectId">,
) {
  return `https://juicebox.money/${displayChainSlug(state.chainId) ?? state.chainId}:${state.projectId}`;
}
const notices = {
  approved: "Token approval confirmed. Review preparation to continue.",
  prepared:
    "Prepared on the source chain. Relay and destination claim are still required.",
  sent: "Sent from the source chain. Waiting for delivery and a claim on the destination.",
  claimed: "Token claim confirmed on the destination chain.",
};

/** Verifies the exact event and payload before describing a bridge step as complete. */
function useBridgeTransaction(chainId: JBChainId) {
  const tx = useSafeTx(chainId);
  const { address } = useWallet();
  const cache = useQueryClient();
  const [active, setActive] = useState<{
    request: TxRequest;
    account: Address;
    safe: boolean;
  } | null>(null);
  const [verified, setVerified] = useState<keyof typeof notices | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(
    null,
  );
  const [unknownSubmission, setUnknownSubmission] = useState(false);
  const [checking, setChecking] = useState(false);
  const [verificationAttempt, setVerificationAttempt] = useState(0);
  const checked = useRef<string | null>(null);
  const admitted = useRef(false);
  useEffect(() => {
    if (
      !active ||
      tx.phase !== "success" ||
      !tx.receipt ||
      checked.current === tx.receipt.transactionHash
    )
      return;
    let cancelled = false;
    setChecking(true);
    void verifyFundBridgeReceipt(
      clientFor(chainId),
      active.request,
      tx.receipt,
      active.account,
      active.safe,
    )
      .then((result) => {
        if (cancelled) return;
        checked.current = tx.receipt!.transactionHash;
        setVerified(result);
        setVerificationError(null);
        setUnknownSubmission(false);
        admitted.current = false;
        void cache.invalidateQueries({ queryKey: ["fund-bridge"] });
        void cache.invalidateQueries({ queryKey: ["fund-project"] });
        void cache.invalidateQueries({ queryKey: ["income-project"] });
        void cache.invalidateQueries({ queryKey: ["income-bridge"] });
      })
      .catch((error) => {
        if (!cancelled) setVerificationError(message(error));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, cache, chainId, tx.phase, tx.receipt, verificationAttempt]);
  async function send(request: TxRequest, options: TxSendOptions) {
    if (!address || admitted.current || unknownSubmission) return;
    admitted.current = true;
    checked.current = null;
    setVerified(null);
    setVerificationError(null);
    setActive({ request, account: address, safe: tx.isSafe });
    let attemptedWrite = false;
    try {
      await tx.send(request, {
        ...options,
        beforeWrite: () => {
          attemptedWrite = true;
          setUnknownSubmission(true);
        },
        onWriteRejected: () => {
          attemptedWrite = false;
          setUnknownSubmission(false);
        },
      });
    } finally {
      if (!attemptedWrite) admitted.current = false;
    }
  }
  // A reverted receipt proves no effect; success still needs exact action proof.
  useEffect(() => {
    if (tx.receipt?.status === "reverted") {
      setUnknownSubmission(false);
      admitted.current = false;
    }
  }, [tx.receipt]);
  return {
    ...tx,
    send,
    verified,
    checking,
    verificationError,
    retryVerification: () => setVerificationAttempt((value) => value + 1),
    locked: tx.busy || tx.phase === "review" || checking || unknownSubmission,
  };
}
type BridgeTx = ReturnType<typeof useBridgeTransaction>;

function BridgeStatus({ tx, chainId }: { tx: BridgeTx; chainId: number }) {
  const explorer =
    tx.hash && !tx.safeProposalHash ? explorerTxUrl(chainId, tx.hash) : null;
  return (
    <div
      className="mt-3 space-y-2 break-words text-sm"
      role="status"
      aria-live="polite"
    >
      {tx.verified ? (
        <p>{notices[tx.verified]}</p>
      ) : tx.checking ? (
        <p>Verifying the exact confirmed bridge action…</p>
      ) : tx.safeProposalHash ? (
        <p>Proposed to Safe. Waiting for execution.</p>
      ) : tx.phase === "pending" ? (
        <p>
          Submitted. Waiting for confirmation on {displayChainName(chainId)}.
        </p>
      ) : null}
      {tx.error && <p>{tx.error}</p>}
      {tx.verificationError && (
        <p>
          The bridge action is not yet verified. {tx.verificationError}{" "}
          <button
            type="button"
            className="underline"
            onClick={tx.retryVerification}
          >
            Check again
          </button>
        </p>
      )}
      {tx.locked && tx.phase === "error" && !tx.receipt && (
        <p>
          Submission could not be confirmed. Check your wallet and the project
          in Juicebox before attempting the same move again.
        </p>
      )}
      {explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          View transaction
        </a>
      )}
    </div>
  );
}

/** Mounted only after first expansion; closing keeps submitted transaction tracking alive. */
export type ProjectBridgeAdapter<State extends BridgeProjectState> = {
  tokenLabel: "FUND" | "INCOME";
  description: string;
  readRoute: (
    clients: ProjectBridgeClientFor,
    source: State,
    destinationChainId: number,
    token?: Address,
  ) => Promise<ProjectBridgeRoute<State>>;
  readQuote: (
    client: PublicClient,
    route: ProjectBridgeRoute<State>,
    amount: bigint,
  ) => Promise<ProjectBridgePrepareQuote>;
  approval: (
    route: ProjectBridgeRoute<State>,
    amount: bigint,
  ) => FundTransaction;
  prepare: (
    route: ProjectBridgeRoute<State>,
    input: { amount: bigint; beneficiary: Address; minTokensReclaimed: bigint },
  ) => FundTransaction;
};
export function ProjectBridgeActions<State extends BridgeProjectState>({
  state,
  adapter,
  initiallyExpanded = false,
}: {
  state: State;
  adapter: ProjectBridgeAdapter<State>;
  initiallyExpanded?: boolean;
}) {
  const { address } = useWallet();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [activated, setActivated] = useState(initiallyExpanded);
  const [destination, setDestination] = useState<number>(
    state.linkedPeers[0]?.chainId ?? 0,
  );
  const [backingToken, setBackingToken] = useState<Address | undefined>(
    state.accountingContexts?.find((context) =>
      isAddressEqual(context.token, USDC_ADDRESSES[state.chainId]),
    )?.token ?? state.accountingContexts?.[0]?.token,
  );
  const [lastRoute, setLastRoute] = useState<ProjectBridgeRoute<State> | null>(
    null,
  );
  const [locks, setLocks] = useState<Record<string, boolean>>({});
  const setLock = useCallback(
    (key: string, value: boolean) =>
      setLocks((previous) =>
        previous[key] === value ? previous : { ...previous, [key]: value },
      ),
    [],
  );
  const route = useQuery({
    queryKey: [
      `${adapter.tokenLabel.toLowerCase()}-bridge`,
      "route",
      state.chainId,
      state.projectId.toString(),
      destination,
      backingToken ?? null,
      address ?? null,
    ],
    enabled: activated && expanded && destination > 0,
    queryFn: () =>
      adapter.readRoute(
        clientFor,
        { ...state, account: address ?? null },
        destination,
        backingToken,
      ),
    staleTime: 20_000,
    retry: false,
  });
  useEffect(() => {
    if (route.data) setLastRoute(route.data);
  }, [route.data]);
  const displayedRoute = route.data ?? lastRoute;
  const accountMatches = route.data?.source.account
    ? !!address && isAddressEqual(route.data.source.account, address)
    : !address;
  const writesUnavailable = route.isError || !route.data || !accountMatches;
  const locked = Object.values(locks).some(Boolean);
  return (
    <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={expanded}
        onClick={() => {
          setActivated(true);
          setExpanded((value) => !value);
        }}
      >
        <span className="font-serif text-3xl">
          Move {adapter.tokenLabel} between chains
        </span>
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
      <div hidden={!expanded} className="mt-5">
        <p className="mb-4 text-sm">{adapter.description}</p>
        {!state.linkedPeers.length ? (
          <p className="text-sm">This project has no verified linked chains.</p>
        ) : (
          <>
            <label className="grid gap-2 text-sm">
              Other chain
              <select
                className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 pr-10 text-base"
                disabled={locked}
                value={destination}
                onChange={(event) => setDestination(Number(event.target.value))}
              >
                {state.linkedPeers.map((peer) => (
                  <option key={peer.chainId} value={peer.chainId}>
                    {displayChainName(peer.chainId)}
                  </option>
                ))}
              </select>
            </label>
            {state.accountingContexts?.length > 1 && (
              <label className="mt-4 grid gap-2 text-sm">
                Treasury backing
                <select
                  className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3 pr-10 text-base"
                  disabled={locked}
                  value={backingToken}
                  onChange={(event) =>
                    setBackingToken(event.target.value as Address)
                  }
                >
                  {state.accountingContexts.map((context) => (
                    <option key={context.token} value={context.token}>
                      {context.symbol}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {route.isFetching && (
              <p className="mt-4 text-sm" role="status">
                Verifying linked project IDs and bridge contracts…
              </p>
            )}
            {route.isError && (
              <p role="alert" className="mt-4 text-sm">
                The bridge route could not be verified. {message(route.error)}{" "}
                <button
                  type="button"
                  onClick={() => void route.refetch()}
                  className="underline"
                >
                  Try again
                </button>
              </p>
            )}
            {displayedRoute && (
              <fieldset
                disabled={writesUnavailable}
                className="mt-5 grid min-w-0 gap-7 border-0 p-0"
              >
                {writesUnavailable && (
                  <p className="text-sm">
                    New bridge actions are paused while this wallet’s route is
                    verified. Submitted transactions remain tracked.
                  </p>
                )}
                <BridgePreparation
                  key={`prepare:${displayedRoute.destination.chainId}:${displayedRoute.sourceToken}`}
                  route={displayedRoute}
                  adapter={adapter}
                  setLock={setLock}
                />
                <BridgeMovements
                  key={`outgoing:${displayedRoute.destination.chainId}:${displayedRoute.sourceToken}`}
                  route={displayedRoute}
                  adapter={adapter}
                  incoming={false}
                  setLock={setLock}
                />
                <BridgeMovements
                  key={`incoming:${displayedRoute.destination.chainId}:${displayedRoute.sourceToken}`}
                  route={displayedRoute}
                  adapter={adapter}
                  incoming
                  setLock={setLock}
                />
              </fieldset>
            )}
          </>
        )}
        <a
          href={referenceLink(state)}
          target="_blank"
          rel="noreferrer"
          className="mt-5 inline-block text-sm underline"
        >
          Open this project in Juicebox
        </a>
      </div>
    </section>
  );
}

function BridgePreparation<State extends BridgeProjectState>({
  route,
  setLock,
  adapter,
}: {
  route: ProjectBridgeRoute<State>;
  adapter: ProjectBridgeAdapter<State>;
  setLock: (key: string, value: boolean) => void;
}) {
  const { address } = useWallet();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const preparationLock = useRef(false);
  const approval = useBridgeTransaction(route.source.chainId);
  const tx = useBridgeTransaction(route.source.chainId);
  const count = positive(amount);
  const beneficiary = address ?? "";
  const quote = useQuery({
    queryKey: [
      `${adapter.tokenLabel.toLowerCase()}-bridge`,
      "quote",
      route.source.chainId,
      route.source.projectId.toString(),
      route.destination.chainId,
      route.source.blockNumber.toString(),
      count.toString(),
      address ?? null,
    ],
    enabled:
      !!address &&
      route.canPrepare &&
      count > 0n &&
      count <= route.source.erc20Balance,
    queryFn: () =>
      adapter.readQuote(clientFor(route.source.chainId), route, count),
    staleTime: 10_000,
    retry: false,
  });
  const busy = preparing || approval.locked || tx.locked;
  useEffect(() => {
    setLock("prepare", busy);
    return () => setLock("prepare", false);
  }, [busy, setLock]);
  async function submit() {
    if (
      preparationLock.current ||
      !address ||
      !quote.data ||
      !isAddress(beneficiary) ||
      isAddressEqual(beneficiary, zeroAddress)
    )
      return;
    preparationLock.current = true;
    setPreparing(true);
    setError(null);
    try {
      const fresh = await adapter.readRoute(
        clientFor,
        { ...route.source, account: address },
        route.destination.chainId,
        route.sourceToken,
      );
      const minimumBlock =
        approval.verified === "approved"
          ? approval.receipt?.blockNumber
          : undefined;
      if (minimumBlock !== undefined && fresh.source.blockNumber < minimumBlock)
        throw new Error(
          "The source RPC has not caught up with your approval. Wait and refresh.",
        );
      const nextQuote = await adapter.readQuote(
        clientFor(fresh.source.chainId),
        fresh,
        count,
      );
      if (nextQuote.allowance < count) {
        const request = adapter.approval(fresh, count);
        await approval.send(
          {
            ...request,
            label: `Approve ${formatUnits(count, 18)} ${adapter.tokenLabel} for the verified bridge`,
          },
          {
            reverify: async () => {
              const latest = await adapter.readRoute(
                clientFor,
                { ...fresh.source, account: address },
                fresh.destination.chainId,
                fresh.sourceToken,
              );
              const next = adapter.approval(latest, count);
              if (
                !isAddressEqual(next.address, request.address) ||
                !isAddressEqual(latest.sourceSucker, fresh.sourceSucker)
              )
                throw new Error(
                  "The project token or registered bridge changed during review.",
                );
            },
          },
        );
        return;
      }
      // Keep the displayed minimum even when a later quote is worse.
      const minimum = quote.data.minTokensReclaimed;
      if (nextQuote.netReclaimAmount < minimum)
        throw new Error(
          "The backing quote fell below the displayed minimum. Refresh and review the new quote.",
        );
      const request = adapter.prepare(fresh, {
        amount: count,
        beneficiary,
        minTokensReclaimed: minimum,
      });
      await tx.send(
        {
          ...request,
          label: `Prepare ${formatUnits(count, 18)} ${adapter.tokenLabel} for ${displayChainName(fresh.destination.chainId)}`,
        },
        {
          reviewNotice: `Beneficiary: ${beneficiary}. At least ${formatUnits(minimum, fresh.sourceContext.decimals)} ${fresh.sourceContext.symbol} of treasury backing moves with your ${adapter.tokenLabel}. Relay and destination claim are separate transactions.`,
          simulationBlockNumber:
            minimumBlock === undefined ? undefined : fresh.source.blockNumber,
          reverify: async () => {
            const latest = await adapter.readRoute(
              clientFor,
              { ...fresh.source, account: address },
              fresh.destination.chainId,
              fresh.sourceToken,
            );
            const current = await adapter.readQuote(
              clientFor(latest.source.chainId),
              latest,
              count,
            );
            if (
              !isAddressEqual(latest.sourceSucker, fresh.sourceSucker) ||
              !isAddressEqual(
                latest.destinationSucker,
                fresh.destinationSucker,
              ) ||
              current.allowance < count ||
              current.netReclaimAmount < minimum
            )
              throw new Error(
                "The bridge route, approval or minimum backing changed during review.",
              );
            adapter.prepare(latest, {
              amount: count,
              beneficiary,
              minTokensReclaimed: minimum,
            });
          },
        },
      );
    } catch (reason) {
      setError(message(reason));
    } finally {
      preparationLock.current = false;
      setPreparing(false);
    }
  }
  return (
    <div>
      <h3 className="mb-3 text-2xl">Prepare a move</h3>
      <p className="mb-4 text-sm">
        {displayChainName(route.source.chainId)} project{" "}
        {route.source.projectId.toString()} →{" "}
        {displayChainName(route.destination.chainId)} project{" "}
        {route.destination.projectId.toString()}
      </p>
      <p className="mb-4 text-sm">
        Available: {formatUnits(route.source.erc20Balance, 18)}{" "}
        {adapter.tokenLabel} ERC-20.{" "}
        {route.source.creditBalance > 0n &&
          `Use “Your ${adapter.tokenLabel}” to claim internal credits as ERC-20 before moving them.`}
      </p>
      {!route.canPrepare && (
        <p className="mb-4 text-sm">{route.prepareIssue}</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm">
          {adapter.tokenLabel} to move
          <input
            className="min-h-12 min-w-0 rounded border border-[#bfc9b5] bg-white px-3 text-base"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={busy}
          />
        </label>
        <div className="grid gap-2 text-sm">
          <span>Destination beneficiary</span>
          <p className="break-all py-3">{address ?? "Connect your wallet"}</p>
        </div>
      </div>
      {quote.data && (
        <p className="mt-4 text-sm">
          At least{" "}
          {formatUnits(
            quote.data.minTokensReclaimed,
            route.sourceContext.decimals,
          )}{" "}
          {route.sourceContext.symbol} in backing at 1% maximum slippage. Relay
          also requires a separate network fee.
        </p>
      )}
      {quote.isError && (
        <p className="mt-4 text-sm" role="alert">
          A protected bridge quote is unavailable. {message(quote.error)}
        </p>
      )}
      <button
        type="button"
        className="btn-primary mt-5 min-h-11 px-5"
        disabled={
          !address ||
          busy ||
          !route.canPrepare ||
          !quote.data ||
          count <= 0n ||
          count > route.source.erc20Balance ||
          !isAddress(beneficiary) ||
          isAddressEqual(beneficiary as Address, zeroAddress)
        }
        onClick={() => void submit()}
      >
        {preparing
          ? "Preparing…"
          : txPhaseLabel(approval.locked ? approval.phase : tx.phase, {
              idle:
                quote.data && quote.data.allowance < count
                  ? `Review ${adapter.tokenLabel} approval`
                  : "Review bridge preparation",
              pending: "Confirming onchain…",
            })}
      </button>
      {error && (
        <p className="mt-4 text-sm" role="alert">
          {error}
        </p>
      )}
      <BridgeStatus tx={approval} chainId={route.source.chainId} />
      <BridgeStatus tx={tx} chainId={route.source.chainId} />
    </div>
  );
}

function BridgeMovements<State extends BridgeProjectState>({
  route,
  incoming,
  setLock,
  adapter,
}: {
  route: ProjectBridgeRoute<State>;
  adapter: ProjectBridgeAdapter<State>;
  incoming: boolean;
  setLock: (key: string, value: boolean) => void;
}) {
  const { address } = useWallet();
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const preparationLock = useRef(false);
  const sourceChain = incoming
    ? route.destination.chainId
    : route.source.chainId;
  const destinationChain = incoming
    ? route.source.chainId
    : route.destination.chainId;
  const relay = useBridgeTransaction(sourceChain);
  const claim = useBridgeTransaction(destinationChain);
  const history = useQuery({
    queryKey: [
      `${adapter.tokenLabel.toLowerCase()}-bridge`,
      "movements",
      sourceChain,
      destinationChain,
      route.source.projectId.toString(),
      route.destination.projectId.toString(),
      address ?? null,
    ],
    queryFn: async () => {
      const selected = incoming
        ? await adapter.readRoute(
            clientFor,
            { ...route.destination, account: address ?? null },
            route.source.chainId,
            route.destinationToken,
          )
        : route;
      return {
        route: selected,
        movements: await readProjectBridgeMovements(clientFor, selected),
      };
    },
    staleTime: 20_000,
    refetchInterval: 60_000,
    retry: false,
  });
  const busy = preparing || relay.locked || claim.locked;
  const lockKey = incoming ? "incoming" : "outgoing";
  useEffect(() => {
    setLock(lockKey, busy);
    return () => setLock(lockKey, false);
  }, [busy, lockKey, setLock]);
  const movements =
    history.data?.movements.filter(
      (movement) => !!address && isAddressEqual(movement.beneficiary, address),
    ) ?? [];
  async function act(
    selected: ProjectBridgeMovement,
    action: "relay" | "claim",
  ) {
    if (preparationLock.current || !address || !history.data) return;
    preparationLock.current = true;
    setPreparing(true);
    setError(null);
    try {
      const fresh = await adapter.readRoute(
        clientFor,
        { ...history.data.route.source, account: address },
        history.data.route.destination.chainId,
        history.data.route.sourceToken,
      );
      const find = async () => {
        const rows = await readProjectBridgeMovements(clientFor, fresh);
        const row = rows.find(
          (item) =>
            isAddressEqual(item.sourceSucker, selected.sourceSucker) &&
            item.leaf.index === selected.leaf.index &&
            item.leafHash.toLowerCase() === selected.leafHash.toLowerCase(),
        );
        if (!row || !isAddressEqual(row.beneficiary, address))
          throw new Error(
            "The selected movement no longer matches your verified bridge history.",
          );
        return row;
      };
      const current = await find();
      if (action === "relay") {
        if (!current.canExecute || current.status !== "pending")
          throw new Error(
            "This movement was already sent or delivered. Refresh its status.",
          );
        if (!isAddressEqual(current.sourceSucker, fresh.sourceSucker))
          throw new Error(
            "Use Juicebox to relay this historical bridge route.",
          );
        const value = await readProjectBridgeSendValue(
          clientFor(fresh.source.chainId),
          fresh,
          address,
        );
        await relay.send(
          {
            ...buildProjectBridgeSend(fresh, value),
            label: `Relay ${adapter.tokenLabel} to ${displayChainName(fresh.destination.chainId)}`,
          },
          {
            reviewNotice: `This relays the current batch for this backing token. Maximum transaction value: ${formatUnits(value, 18)} ETH. Destination delivery and claims follow separately.`,
            reverify: async () => {
              const latest = await find();
              if (!latest.canExecute || latest.status !== "pending")
                throw new Error("This bridge batch has already been sent.");
              const nextValue = await readProjectBridgeSendValue(
                clientFor(fresh.source.chainId),
                fresh,
                address,
              );
              if (nextValue > value)
                throw new Error(
                  "The bridge fee increased. Review the new value before sending.",
                );
            },
          },
        );
      } else {
        await claim.send(
          {
            ...buildProjectBridgeClaim(fresh, current),
            label: `Claim ${formatUnits(current.leaf.projectTokenCount, 18)} ${adapter.tokenLabel} on ${displayChainName(fresh.destination.chainId)}`,
          },
          {
            reverify: async () => {
              const latest = await find();
              const prepared = buildProjectBridgeClaim(fresh, latest);
              if (!isAddressEqual(prepared.address, current.destinationSucker))
                throw new Error(
                  "The destination bridge changed during review.",
                );
            },
          },
        );
      }
    } catch (reason) {
      setError(message(reason));
    } finally {
      preparationLock.current = false;
      setPreparing(false);
    }
  }
  return (
    <div className="border-t border-[#c4cdbb] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-2xl">
          {incoming ? "Incoming" : "Outgoing"} {adapter.tokenLabel}
        </h3>
        <button
          type="button"
          className="text-sm underline"
          disabled={history.isFetching || busy}
          onClick={() => void history.refetch()}
        >
          Refresh
        </button>
      </div>
      <p className="mt-2 text-sm">
        {displayChainName(sourceChain)} → {displayChainName(destinationChain)}
      </p>
      {!address ? (
        <p className="mt-4 text-sm">
          Connect your wallet to view movements for your address.
        </p>
      ) : history.isPending ? (
        <p className="mt-4 text-sm" role="status">
          Reconstructing and verifying bridge proofs…
        </p>
      ) : history.isError ? (
        <p className="mt-4 text-sm" role="alert">
          Bridge history or its proof is unavailable. {message(history.error)}{" "}
          Claims remain unavailable until the destination proof can be verified.
        </p>
      ) : !movements.length ? (
        <p className="mt-4 text-sm">
          No verified movements for your address on this route.
        </p>
      ) : (
        <ul className="mt-4 grid gap-4">
          {movements.map((movement) => (
            <li
              key={`${movement.sourceSucker}:${movement.leaf.index}`}
              className="rounded border border-[#c4cdbb] bg-white p-4"
            >
              <p>
                {formatUnits(movement.leaf.projectTokenCount, 18)}{" "}
                {adapter.tokenLabel}
              </p>
              <p className="mt-2 text-sm">
                {movement.status === "claimed"
                  ? "Claimed on the destination"
                  : movement.status === "claimable"
                    ? "Delivered. Ready to claim."
                    : movement.canExecute
                      ? "Prepared. Ready to relay."
                      : "Sent. Waiting for destination delivery."}
              </p>
              {movement.status === "claimable" ? (
                <button
                  type="button"
                  className="btn-secondary mt-3 min-h-11 px-4"
                  disabled={busy || history.isError}
                  onClick={() => void act(movement, "claim")}
                >
                  Review destination claim
                </button>
              ) : movement.canExecute && movement.status === "pending" ? (
                isAddressEqual(
                  movement.sourceSucker,
                  history.data!.route.sourceSucker,
                ) ? (
                  <button
                    type="button"
                    className="btn-secondary mt-3 min-h-11 px-4"
                    disabled={busy || history.isError}
                    onClick={() => void act(movement, "relay")}
                  >
                    Review relay fee and send
                  </button>
                ) : (
                  <a
                    href={referenceLink(history.data!.route.source)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block text-sm underline"
                  >
                    Relay this earlier bridge in Juicebox
                  </a>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="mt-4 text-sm" role="alert">
          {error}
        </p>
      )}
      <BridgeStatus tx={relay} chainId={sourceChain} />
      <BridgeStatus tx={claim} chainId={destinationChain} />
    </div>
  );
}
