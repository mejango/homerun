"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, isAddressEqual, type Hex, type PublicClient } from "viem";
import { useWallet } from "@/hooks/useWallet";
import { txPhaseLabel, useSafeTx } from "@/hooks/useSafeTx";
import { wagmiConfig } from "@/providers/Providers";
import {
  isSafeConnection,
  waitForSafeExecutionHash,
} from "@/lib/safe-connector";
import { jbCenterIpfs } from "@/lib/jbcenter-ipfs";
import { explorerTxUrl } from "@/lib/chainDisplay";
import {
  fundGlobalManifestHash,
  parseFundGlobalManifest,
} from "@/lib/fund-global-manifest";
import type { FundProjectState } from "@/lib/fund-state";
import {
  recordStickyHash,
  stickySessionKey,
  type StickyPending,
} from "@/lib/sticky-session";
import {
  beginStickyCreationSubmission,
  clearStickyCreationPending,
  prepareStickyCreate,
  readStickyCreated,
  readStickyCreationPending,
  saveStickyCreated,
  stickyCreateBlockers,
  verifyStickyCreationExecution,
  type PreparedStickyCreate,
  type StickyCreatedRecord,
} from "@/lib/sticky-create";

export type StickyCreateProps = {
  state: FundProjectState;
  client: PublicClient;
  manifest: unknown;
  clients?: ReadonlyMap<number, PublicClient>;
  launchUnavailable?: boolean;
  onCreated: (projectId: bigint) => void;
};
const RECOVERY_EVENT = "homerun-sticky-recovery";
const changed = () => window.dispatchEvent(new Event(RECOVERY_EVENT));
const message = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "Sticky creation could not be verified.";

/** Keep this mounted while parent queries refresh: recovery is independent of current launch eligibility. */
export function StickyCreate({
  state,
  client,
  clients,
  manifest,
  launchUnavailable = false,
  onCreated,
}: StickyCreateProps) {
  const { address } = useWallet(),
    tx = useSafeTx(state.chainId);
  const [name, setName] = useState("Homerun SHARE"),
    [prepared, setPrepared] = useState<PreparedStickyCreate | null>(null);
  const [preparing, setPreparing] = useState(false),
    [verifying, setVerifying] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<StickyPending | null>(null),
    [completed, setCompleted] = useState<StickyCreatedRecord | null>(null),
    [storageError, setStorageError] = useState<string | null>(null),
    [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [executionHash, setExecutionHash] = useState(""),
    [verifiedId, setVerifiedId] = useState<{
      scope: string;
      id: bigint;
    } | null>(null);
  const scope = `${state.chainId}:${state.projectId}`,
    walletScope = `${scope}:${address?.toLowerCase() ?? ""}`;
  let manifestHash: Hex | null = null;
  try {
    manifestHash = fundGlobalManifestHash(parseFundGlobalManifest(manifest));
  } catch {
    /* Only a complete verified manifest can prepare creation. */
  }
  const identity = `${walletScope}:${manifestHash ?? ""}:${name}`;
  const liveUnavailable = useRef(launchUnavailable);
  liveUnavailable.current = launchUnavailable;
  const liveIdentity = useRef(identity),
    liveScope = useRef(scope),
    callback = useRef(onCreated),
    notified = useRef<string | null>(null);
  liveIdentity.current = identity;
  liveScope.current = scope;
  callback.current = onCreated;
  useEffect(() => {
    const refresh = () => {
      try {
        setPending(
          readStickyCreationPending(
            localStorage,
            state.chainId,
            state.projectId,
            address,
          ),
        );
        setCompleted(
          readStickyCreated(localStorage, state.chainId, state.projectId),
        );
        setStorageError(null);
      } catch (reason) {
        setStorageError(message(reason));
      } finally {
        setLoadedScope(walletScope);
      }
    };
    refresh();
    window.addEventListener(RECOVERY_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(RECOVERY_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [address, state.chainId, state.projectId, walletScope]);

  const recover = useCallback(
    async (record: StickyPending, hash: Hex, expectedProjectId?: string) => {
      const result = await verifyStickyCreationExecution(client, record, hash);
      if (result.status === "confirmed") {
        if (
          expectedProjectId &&
          result.projectId.toString() !== expectedProjectId
        )
          throw new Error(
            "The saved project ID does not match its canonical creation event.",
          );
        // Save completion first. A reload between these writes must retain duplicate protection.
        const existing = readStickyCreated(
          localStorage,
          record.chainId,
          BigInt(record.projectId),
        );
        if (
          existing &&
          (existing.executionHash !== hash ||
            existing.projectId !== result.projectId.toString())
        )
          throw new Error(
            "A different Sticky creation is already saved for this FUND. Resolve both executions before continuing.",
          );
        const unresolved = readStickyCreationPending(
          localStorage,
          record.chainId,
          BigInt(record.projectId),
          record.holder,
        );
        if (!existing)
          saveStickyCreated(localStorage, record, hash, result.projectId);
        if (unresolved) clearStickyCreationPending(localStorage, record);
        if (!existing || unresolved) changed();
        if (liveScope.current === `${record.chainId}:${record.projectId}`) {
          setVerifying(false);
          setVerifiedId({ scope: liveScope.current, id: result.projectId });
          const receiptKey = `${record.chainId}:${hash}`;
          if (notified.current !== receiptKey) {
            notified.current = receiptKey;
            callback.current(result.projectId);
          }
        }
      } else {
        if (expectedProjectId)
          throw new Error(
            "The saved completed creation has no successful execution.",
          );
        clearStickyCreationPending(localStorage, record);
        changed();
        if (liveScope.current === `${record.chainId}:${record.projectId}`) {
          setVerifying(false);
          setError(
            "The exact creation transaction reverted. No Sticky project was created by that call; prepare a fresh review.",
          );
        }
      }
    },
    [client],
  );

  // A known hash is recoverable after refresh, including Safe proposals that have not executed yet.
  useEffect(() => {
    if (loadedScope !== walletScope || storageError) return;
    const record = completed?.pending ?? pending;
    const hash = completed?.executionHash ?? pending?.hash;
    if (!record || !hash) return;
    if (completed && notified.current === `${record.chainId}:${hash}`) return;
    const controller = new AbortController();
    let cancelled = false;
    setVerifying(true);
    void (async () => {
      const execution = completed
        ? hash
        : record.safe
          ? await waitForSafeExecutionHash(record.chainId, hash, {
              signal: controller.signal,
            })
          : hash;
      if (!completed && !record.safe)
        await client.waitForTransactionReceipt({
          hash: execution,
          timeout: 120_000,
        });
      if (!cancelled) await recover(record, execution, completed?.projectId);
    })()
      .catch((reason) => {
        if (!cancelled)
          setError(
            `The saved creation is still unresolved. ${message(reason)}`,
          );
      })
      .finally(() => {
        if (!cancelled) setVerifying(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    client,
    completed,
    loadedScope,
    pending,
    recover,
    storageError,
    walletScope,
  ]);

  const owner = !!address && isAddressEqual(address, state.owner);
  const blockers = stickyCreateBlockers(state);
  const busy = preparing || verifying || tx.busy || tx.phase === "review";
  const recoveryLocked =
    loadedScope !== walletScope || !!storageError || !!pending || !!completed;
  const verified = verifiedId?.scope === scope ? verifiedId.id : null;

  async function prepare() {
    if (
      !address ||
      !owner ||
      !manifestHash ||
      blockers.length ||
      launchUnavailable ||
      recoveryLocked
    )
      return;
    const captured = identity;
    setPreparing(true);
    setError(null);
    setPrepared(null);
    try {
      const snapshot = parseFundGlobalManifest(manifest);
      const local = snapshot.allocations.find(
        (allocation) =>
          allocation.chainId === state.chainId &&
          BigInt(allocation.fundProjectId) === state.projectId,
      );
      if (!local)
        throw new Error(
          "The global snapshot does not include this FUND and network.",
        );
      const pin = await jbCenterIpfs.pinJson({
        name: name.trim(),
        description:
          "SHARE represents staked FUND in this Homerun project. Initial INCOME ownership follows the prior finalized FUND snapshot.",
        symbol: "SHARE",
        homepage: `https://homerun.money/project/${state.chainId}/${state.projectId}`,
        homerun: {
          kind: "sticky-share",
          chainId: state.chainId,
          fundProjectId: state.projectId.toString(),
          fundSnapshotBlock: local.snapshotBlockNumber,
          fundSnapshotHash: local.snapshotBlockHash,
          manifestHash,
          cashOutTaxRate: 0,
          soulbound: true,
        },
      });
      const next = await prepareStickyCreate(client, {
        chainId: state.chainId,
        fundProjectId: state.projectId,
        account: address,
        manifest: snapshot,
        clients,
        name,
        projectUri: `ipfs://${pin.cid}`,
      });
      if (captured !== liveIdentity.current || liveUnavailable.current)
        throw new Error(
          "The wallet, project, or snapshot changed during preparation. Prepare this creation again.",
        );
      setPrepared(next);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPreparing(false);
    }
  }
  async function submit() {
    if (
      !address ||
      !prepared ||
      busy ||
      recoveryLocked ||
      !owner ||
      launchUnavailable
    )
      return;
    const reviewed = prepared,
      captured = identity;
    let saved: StickyPending | null = null;
    setError(null);
    try {
      const hash = await tx.send(
        {
          ...reviewed.request,
          label: "Create Sticky SHARE for this FUND project",
        },
        {
          reviewNotice:
            "This creates a separate Juicebox staking project and SHARE token, owned permanently by the stock Sticky factory. It moves no FUND and deploys no INCOME. SHARE transfers are locked; unstaking uses zero cash-out tax and current backing. Rewards use snapshot balances, not streak age; zero-tax staking permits short-lived snapshot participation. The initial INCOME snapshot predates this creation.",
          reverify: async () => {
            if (captured !== liveIdentity.current || liveUnavailable.current)
              throw new Error(
                "The wallet, project, or ownership manifest changed. Review a fresh creation.",
              );
            const current = await prepareStickyCreate(client, {
              chainId: state.chainId,
              fundProjectId: state.projectId,
              account: address,
              manifest: reviewed.manifest,
              clients,
              name: reviewed.request.args[1] as string,
              projectUri: reviewed.request.args[3] as string,
            });
            if (
              current.manifestHash !== reviewed.manifestHash ||
              current.creationFee !== reviewed.creationFee ||
              !isAddressEqual(current.deployer, reviewed.deployer) ||
              !isAddressEqual(
                current.fund.tokenAddress!,
                reviewed.fund.tokenAddress!,
              )
            )
              throw new Error(
                "The FUND snapshot, factory or creation fee changed. Prepare a fresh review.",
              );
          },
          beforeWrite: async () => {
            if (liveUnavailable.current)
              throw new Error(
                "FUND verification is unavailable. Refresh before creating SHARE.",
              );
            if (captured !== liveIdentity.current)
              throw new Error("The creation context changed before signing.");
            if (!navigator.locks)
              throw new Error(
                "Use a browser with Web Locks support to coordinate creation across tabs.",
              );
            await navigator.locks.request(
              `homerun-sticky-create:${scope}`,
              async () => {
                if ((await client.getChainId()) !== reviewed.fund.chainId)
                  throw new Error("The creation RPC changed networks.");
                const block = await client.getBlock({ blockTag: "latest" });
                if (block.number === null || !block.hash)
                  throw new Error(
                    "A mined block is required before submission.",
                  );
                if (
                  liveUnavailable.current ||
                  captured !== liveIdentity.current
                )
                  throw new Error(
                    "FUND verification or the creation context changed before signing.",
                  );
                saved = beginStickyCreationSubmission(
                  localStorage,
                  reviewed,
                  address,
                  isSafeConnection(wagmiConfig),
                  block.number,
                );
                changed();
              },
            );
          },
          onWriteRejected: async () => {
            if (saved) clearStickyCreationPending(localStorage, saved);
            changed();
          },
        },
      );
      if (hash) {
        recordStickyHash(
          localStorage,
          stickySessionKey(state.chainId, state.projectId, address),
          hash,
        );
        changed();
      }
    } catch (reason) {
      setError(message(reason));
    }
  }
  async function verifyManual() {
    const record = completed?.pending ?? pending;
    if (!record || !/^0x[\da-fA-F]{64}$/.test(executionHash)) {
      setError(
        "Enter the actual onchain execution transaction hash. A Safe proposal hash is not an execution hash.",
      );
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      await recover(record, executionHash as Hex, completed?.projectId);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setVerifying(false);
    }
  }
  const explorer =
    completed?.executionHash ?? (!pending?.safe ? pending?.hash : undefined);
  const explorerLink = explorer ? explorerTxUrl(state.chainId, explorer) : null;
  return (
    <section
      className="mt-6 rounded border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7"
      aria-label="Create Sticky SHARE"
    >
      <h3 className="text-2xl">Create SHARE for staked FUND</h3>
      <p className="mt-3 text-sm">
        Keep the initial INCOME ownership snapshot before putting FUND into
        Sticky custody. Creation uses the stock Sticky factory; holders choose
        whether to stake afterward.
      </p>
      {verified ? (
        <p role="status" className="mt-4">
          Sticky project {verified.toString()} is confirmed and verified.
        </p>
      ) : completed || pending ? (
        <div className="mt-4 rounded border border-[#bfc9b5] p-4 text-sm">
          <p>
            {completed
              ? "Rechecking the saved Sticky creation."
              : pending?.safe
                ? "The Safe creation proposal is saved. SHARE is created only after its execution is verified."
                : pending?.hash
                  ? "The saved creation is awaiting verified execution."
                  : "The wallet may have submitted this creation. Its recovery record is saved; another creation is blocked."}
          </p>
          <p className="mt-3">
            Keep this record. Check the wallet history for its execution hash if
            automatic confirmation is unavailable.
          </p>
          <label className="mt-4 grid gap-2">
            Execution transaction hash
            <input
              className="min-h-12 min-w-0 rounded border border-[#bfc9b5] bg-white px-3"
              value={executionHash}
              onChange={(event) => setExecutionHash(event.target.value)}
              placeholder="0x…"
            />
          </label>
          <button
            type="button"
            className="btn-secondary mt-3 min-h-11 px-5"
            disabled={verifying}
            onClick={() => void verifyManual()}
          >
            {verifying ? "Verifying execution…" : "Verify saved creation"}
          </button>
        </div>
      ) : (
        <>
          {launchUnavailable && (
            <p role="status" className="mt-4 text-sm">
              New SHARE creation is paused until the FUND project is verified.
              Saved creation recovery remains available.
            </p>
          )}
          {blockers.length > 0 ? (
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm">
              {blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : !manifestHash ? (
            <p className="mt-4 text-sm">
              Verify and publish the complete initial FUND ownership snapshot
              first.
            </p>
          ) : !owner ? (
            <p className="mt-4 text-sm">
              The FUND owner can create its SHARE project.
            </p>
          ) : (
            <div className="mt-5 grid gap-4">
              <label className="grid gap-2 text-sm">
                SHARE token name
                <input
                  className="min-h-12 rounded border border-[#bfc9b5] bg-white px-3"
                  value={name}
                  maxLength={160}
                  disabled={busy}
                  onChange={(event) => {
                    setName(event.target.value);
                    setPrepared(null);
                  }}
                />
              </label>
              <p className="text-sm">
                Zero unstaking tax. SHARE transfers locked. No permanent grant
                senders. Rewards use weekly snapshots and four vesting rounds,
                with a three-year claim window.
              </p>
              <button
                type="button"
                className="btn-secondary min-h-11 justify-self-start px-5"
                disabled={
                  busy || recoveryLocked || launchUnavailable || !name.trim()
                }
                onClick={() => void prepare()}
              >
                {preparing
                  ? "Verifying snapshot and deployment…"
                  : "Prepare Sticky creation"}
              </button>
              {prepared && (
                <div className="rounded border border-[#bfc9b5] p-4 text-sm">
                  <p>
                    Global FUND snapshot verified; this chain’s block is{" "}
                    {prepared.localAllocation.snapshotBlockNumber}. Exact
                    project creation fee:{" "}
                    {formatUnits(prepared.creationFee, 18)} ETH.
                  </p>
                  <p className="mt-3 break-all">Factory: {prepared.deployer}</p>
                  <button
                    type="button"
                    className="btn-primary mt-4 min-h-11 px-5"
                    disabled={busy || recoveryLocked || launchUnavailable}
                    onClick={() => void submit()}
                  >
                    {txPhaseLabel(tx.phase, {
                      idle: "Review Sticky creation",
                      pending: "Confirming onchain…",
                    })}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <div
        role="status"
        aria-live="polite"
        className="mt-4 break-words text-sm"
      >
        {verifying && <p>Verifying canonical creation and project state…</p>}
        {(error || storageError || tx.error) && (
          <p role="alert" className="text-red-800">
            {error ?? storageError ?? tx.error}
          </p>
        )}
        {explorerLink && (
          <a
            className="mt-3 inline-block underline"
            href={explorerLink}
            target="_blank"
            rel="noreferrer"
          >
            View creation transaction
          </a>
        )}
      </div>
    </section>
  );
}
