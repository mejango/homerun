"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, isAddressEqual, type Hex, type PublicClient } from "viem";
import { useSavedAttempt } from '@bananapus/nana-sdk-core/review/react';
import { useWallet } from "@/hooks/useWallet";
import { txPhaseLabel, useSafeTx } from "@/hooks/useSafeTx";
import { jbCenterIpfs } from "@/lib/jbcenter-ipfs";
import { explorerTxUrl } from "@/lib/chainDisplay";
import {
  fundGlobalManifestHash,
  parseFundGlobalManifest,
} from "@/lib/fund-global-manifest";
import type { FundProjectState } from "@/lib/fund-state";
import { type StickyPending } from "@/lib/sticky-session";
import { attempts } from "@/lib/write-hold";
import { HeldNotice, retiringExit } from "@/components/ui/HeldWriteExit";
import { SavedAttemptNotice } from "@/components/ui/SavedAttemptNotice";
import {
  clearStickyCreationPending,
  prepareStickyCreate,
  stickyCreateIntent,
  stickyCreationAttempt,
  stickyCreationFromHold,
  stickyCreationRecord,
  stickyCreationRequest,
  readStickyCreated,
  readStickyCreationPending,
  saveStickyCreated,
  stickyCreateBlockers,
  verifyStickyCreationExecution,
  type PreparedStickyCreate,
  type StickyCreatedRecord,
} from "@/lib/sticky-create";
import { projectPath } from '@/lib/urn'

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
  const [completed, setCompleted] = useState<StickyCreatedRecord | null>(null),
    [storageError, setStorageError] = useState<string | null>(null),
    [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [verifiedId, setVerifiedId] = useState<{
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
    async (record: StickyPending, hash: Hex, expectedProjectId?: string, proven?: { status: "confirmed"; projectId: bigint }) => {
      // A creation its saved-attempt recovery already proved is saved as proved, never verified twice.
      const result = proven ?? await verifyStickyCreationExecution(client, record, hash);
      if (!navigator.locks) throw new Error("Use a browser with Web Locks support to coordinate Sticky recovery across tabs.");
      await navigator.locks.request(`homerun-sticky-create:${record.chainId}:${record.projectId}`, () => {
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
          if (!existing) {
            saveStickyCreated(localStorage, record, hash, result.projectId);
            changed();
          }
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
          if (liveScope.current === `${record.chainId}:${record.projectId}`) {
            setVerifying(false);
            setError(
              "The exact creation transaction reverted. No Sticky project was created by that call; prepare a fresh review.",
            );
          }
        }
      });
    },
    [client],
  );

  /** The creation this screen sent or adopted: what its settled execution is verified against. */
  const sent = useRef<StickyPending | null>(null);
  const track = tx.track;
  // This FUND's creation recovers through the SDK before anything is prepared: a saved completion is
  // proven again, a held one shows with its exit, one that settled while away is verified and saved,
  // and one nothing can show asks the user.
  const [pendingVersion, setPendingVersion] = useState(0);
  const legacy = useMemo(() => {
    void pendingVersion;
    try { return { record: loadedScope === walletScope ? readStickyCreationPending(localStorage, state.chainId, state.projectId, address) : null }; }
    catch (reason) { return { record: null, error: message(reason) }; }
  }, [address, loadedScope, pendingVersion, state.chainId, state.projectId, walletScope]);
  const attempt = useMemo(() => loadedScope === walletScope && !storageError && !legacy.error && address
    ? stickyCreationAttempt(client, localStorage, state.chainId, state.projectId, address, tx.isSafe, { completed, pending: legacy.record }, verifyStickyCreationExecution) : null,
  [address, client, completed, legacy, loadedScope, state.chainId, state.projectId, storageError, tx.isSafe, walletScope]);
  const recovery = useSavedAttempt({ recovery: attempts, attempt, client, checkNext: "Create again" });
  const { outcome, retire } = recovery;
  const dropLegacy = (record: StickyPending) => { try { clearStickyCreationPending(localStorage, record); changed(); } catch { /* Read again on the next load. */ } setPendingVersion((value) => value + 1); };
  useEffect(() => {
    if (!outcome) return;
    const record = legacy.record;
    if (outcome.status === "held") {
      sent.current = record ?? stickyCreationFromHold(outcome.state.record, state.projectId);
      // The hold has the journal's attempt now: its records go.
      if (record) dropLegacy(record);
      track({ ...stickyCreationRequest(sent.current), label: "Create Sticky SHARE for this FUND project" }, { reviewedAccount: outcome.state.record.account, recoveryNamespace: stickyCreateIntent(state.projectId), safe: outcome.state.record.safe, reservation: outcome.state.record.id });
    } else if (outcome.status === "done" && outcome.result === "success" && outcome.authenticated) {
      setVerifying(true);
      void recover(outcome.value.record, outcome.hash ?? outcome.value.record.hash!, completed?.projectId, { status: "confirmed", projectId: outcome.value.projectId })
        .then(() => { if (record) dropLegacy(record); })
        .catch((reason) => setError(`The saved creation is still unresolved. ${message(reason)}`))
        .finally(() => setVerifying(false));
    } else if (outcome.status === "done" && outcome.result === "failed" && completed) {
      setError("The saved completed creation has no successful execution.");
    } else if (outcome.status === "none" && outcome.retired && record) dropLegacy(record);
  // Each outcome is handled once, against the journal as it is now.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);
  /** Nothing is prepared or sent until this FUND's creation has recovered, and then only when nothing was done. */
  const recovered = !attempt || !!outcome && (outcome.status === "none" || (outcome.status === "done" && outcome.result === "failed" && !completed));

  // The SDK's hold settled the creation: its exact execution and the live project are verified and saved.
  const settled = tx.phase === "success" ? tx.receipt : null,
    submissionHash = tx.submissionHash;
  useEffect(() => {
    const record = sent.current;
    if (!settled || !record) return;
    let cancelled = false;
    setVerifying(true);
    void recover({ ...record, ...(submissionHash ? { hash: submissionHash } : {}) }, settled.transactionHash)
      .then(() => {
        // Saved: the completion is this FUND's attempt from here, proven again on every load.
        sent.current = null;
      })
      .catch((reason) => {
        if (!cancelled) setError(`The creation confirmed, but could not be verified yet. ${message(reason)}`);
      })
      .finally(() => {
        if (!cancelled) setVerifying(false);
      });
    return () => {
      cancelled = true;
    };
  }, [recover, settled, submissionHash]);

  const owner = !!address && isAddressEqual(address, state.owner);
  const blockers = stickyCreateBlockers(state);
  const busy = preparing || verifying || tx.busy || tx.phase === "review" || !recovered;
  /** The creation is with the wallet, the chain or a Safe: no other is prepared meanwhile. */
  const creating = tx.busy || tx.phase === "submitted" || tx.phase === "success";
  const recoveryLocked =
    loadedScope !== walletScope || !!storageError || !!legacy.error || !!completed || creating;
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
        homepage: `https://homerun.money${projectPath(state.chainId, state.projectId)}`,
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
    setError(null);
    try {
      sent.current = stickyCreationRecord(reviewed, reviewed.fund.owner, tx.isSafe);
      await tx.send(
        {
          ...reviewed.request,
          label: "Create Sticky SHARE for this FUND project",
        },
        {
          // Prepared for the FUND owner of that moment: only that account may send it.
          reviewedAccount: reviewed.fund.owner,
          recoveryNamespace: stickyCreateIntent(reviewed.fund.projectId),
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
          },
        },
      );
    } catch (reason) {
      setError(message(reason));
    }
  }
  const explorer = completed?.executionHash ?? tx.hash ?? undefined;
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
      {/* A held creation shows with its exit whatever else is saved. */}
      {tx.phase === "submitted" && (
        <div className="mt-4 rounded border border-[#bfc9b5] p-4 text-sm">
          <HeldNotice tx={{ notice: tx.notice, held: retiringExit(tx.held, retire) }} />
        </div>
      )}
      {verified ? (
        <p role="status" className="mt-4">
          Sticky project {verified.toString()} is confirmed and verified.
        </p>
      ) : completed ? (
        <div className="mt-4 rounded border border-[#bfc9b5] p-4 text-sm">
          <p>Rechecking the saved Sticky creation.</p>
          <SavedAttemptNotice attempt={recovery} />
        </div>
      ) : tx.phase === "submitted" ? null : outcome && outcome.status !== "none" && !recovered && outcome.status !== "held" ? (
        <SavedAttemptNotice attempt={recovery} />
      ) : tx.phase === "pending" || tx.phase === "success" ? (
        <p role="status" className="mt-4 text-sm">
          Submitted. Waiting for onchain confirmation…
        </p>
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
        {(error || storageError || legacy.error || tx.error) && (
          <p role="alert" className="text-red-800">
            {error ?? storageError ?? legacy.error ?? tx.error}
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
