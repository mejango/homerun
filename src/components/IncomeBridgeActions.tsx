"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAddressEqual, createPublicClient, type PublicClient } from "viem";
import type { JBChainId } from "@bananapus/nana-sdk-core";
import { useWallet } from "@/hooks/useWallet";
import type { IncomeProjectState } from "@/lib/income-state";
import { jbCenterRpcTransport } from "@/lib/jbcenter-rpc";
import {
  readLinkedIncomeProjects,
  readIncomeBridgeRoute,
  readIncomeBridgePrepareQuote,
  buildIncomeBridgeApproval,
  buildIncomeBridgePrepare,
  type IncomeLinkedProjectState,
} from "@/lib/income-bridge";
import {
  ProjectBridgeActions,
  type ProjectBridgeAdapter,
} from "./ProjectBridgeActions";

const clients = new Map<JBChainId, PublicClient>();
function clientFor(chainId: JBChainId) {
  let client = clients.get(chainId);
  if (!client) {
    client = createPublicClient({
      transport: jbCenterRpcTransport(chainId, 60_000),
    });
    clients.set(chainId, client);
  }
  return client;
}
const adapter: ProjectBridgeAdapter<IncomeLinkedProjectState> = {
  tokenLabel: "INCOME",
  description:
    "Move INCOME and its local treasury backing to a linked Revnet. Prepare, relay, then claim on the destination. Each step needs its own confirmation. Bridging remains available during the ordinary cash-out delay; the live quote includes local loan accounting.",
  readRoute: readIncomeBridgeRoute,
  readQuote: readIncomeBridgePrepareQuote,
  approval: buildIncomeBridgeApproval,
  prepare: buildIncomeBridgePrepare,
};
/** Parent mounts only for a verified live INCOME project; this does not enable any global launch. */
export function IncomeBridgeActions({ state }: { state: IncomeProjectState }) {
  const { address } = useWallet();
  const [enabled, setEnabled] = useState(false);
  const [lastState, setLastState] = useState<IncomeLinkedProjectState | null>(
    null,
  );
  const graph = useQuery({
    queryKey: [
      "income-bridge",
      "identity",
      state.chainId,
      state.projectId.toString(),
      address ?? null,
    ],
    enabled,
    retry: false,
    staleTime: 20_000,
    queryFn: async () => {
      const states = await readLinkedIncomeProjects(clientFor, {
        ...state,
        account: address ?? null,
      });
      const source = states.find(
        (project) =>
          project.chainId === state.chainId &&
          project.projectId === state.projectId,
      );
      if (!source)
        throw new Error(
          "The INCOME project was missing from its verified graph.",
        );
      return source;
    },
  });
  useEffect(() => {
    if (graph.data) setLastState(graph.data);
  }, [graph.data]);
  const displayed = graph.data ?? lastState;
  if (displayed)
    return (
      <div>
        {graph.isError && (
          <p role="alert" className="mb-3 text-sm">
            Linked Revnet verification failed.{" "}
            {graph.error instanceof Error
              ? graph.error.message
              : "Refresh before taking another action."}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => void graph.refetch()}
            >
              Try again
            </button>
          </p>
        )}
        <fieldset
          className="m-0 min-w-0 border-0 p-0"
          disabled={
            graph.isError ||
            !graph.data ||
            !!address !== !!graph.data.account ||
            (!!address &&
              !!graph.data.account &&
              !isAddressEqual(address, graph.data.account))
          }
        >
          <ProjectBridgeActions
            state={displayed}
            adapter={adapter}
            initiallyExpanded
          />
        </fieldset>
      </div>
    );
  return (
    <section className="rounded-md border border-[#c4cdbb] bg-[#eef1e7] p-5 sm:p-7">
      <h3 className="font-serif text-3xl">Move INCOME between chains</h3>
      <p className="mt-3 text-sm">
        Discover linked Revnets from their registered bridges, including earlier
        movements that still need a destination claim.
      </p>
      <button
        type="button"
        className="btn-secondary mt-4 min-h-11 px-4"
        disabled={graph.isFetching}
        onClick={() => (enabled ? void graph.refetch() : setEnabled(true))}
      >
        {graph.isFetching ? "Verifying linked Revnets…" : "Find linked chains"}
      </button>
      {graph.isError && (
        <p role="alert" className="mt-3 text-sm">
          {graph.error instanceof Error
            ? graph.error.message
            : "The INCOME bridge graph could not be verified."}
        </p>
      )}
    </section>
  );
}
