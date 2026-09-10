/** INCOME adapter for the shared sucker pipeline. No FUND owner flags are fabricated. */
import {
  SUPPORTED_CHAINS,
  USDC_ADDRESSES,
  jbSuckerRegistryAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import { suckerBytes32ToAddress, v6Address } from "@bananapus/nana-sdk-core/v6";
import {
  isAddressEqual,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { readFundGlobalSnapshotGraph } from "./fund-global-snapshot-graph";
import {
  readIncomeProjectState,
  type IncomeProjectState,
} from "./income-state";
import {
  readProjectBridgeRoute,
  readProjectBridgePrepareQuote,
  buildProjectBridgeApproval,
  buildProjectBridgePrepare,
  type ProjectBridgeClientFor,
  type ProjectBridgeRoute,
} from "./project-bridge";
import type { FundLinkedPeer } from "./fund-state";

export type IncomeLinkedProjectState = IncomeProjectState & {
  linkedPeers: FundLinkedPeer[];
  activeSuckers: readonly Address[];
};
export type IncomeBridgeRoute = ProjectBridgeRoute<IncomeLinkedProjectState>;

export function assertIncomeBridgeState(state: IncomeProjectState): void {
  if (
    !isAddressEqual(state.owner, v6Address("REVOwner", state.chainId)) ||
    !isAddressEqual(
      state.controller,
      v6Address("JBController", state.chainId),
    ) ||
    !state.ruleset.id ||
    !isAddressEqual(state.metadata.dataHook, state.owner) ||
    !state.metadata.useDataHookForPay ||
    !state.metadata.useDataHookForCashOut ||
    state.tokenDecimals !== 18
  ) {
    throw new Error(
      "INCOME bridging requires the canonical V6 REVOwner, controller, and active Revnet hooks.",
    );
  }
  // REVOwner checks the registered sucker before the ordinary holder cash-out
  // delay. Do not apply cashOutsAvailable, holder tax, or ordinary cash-out quotes.
}

/**
 * Reuse the complete finalized registry graph, including retired lanes, then
 * read each Revnet freshly. Active routes must already exist in that finalized
 * graph. A newly deployed route waits for finality instead of trusting metadata.
 */
export async function readLinkedIncomeProjects(
  clientsFor: ProjectBridgeClientFor,
  source: IncomeProjectState,
): Promise<IncomeLinkedProjectState[]> {
  const clients = new Map(
    await Promise.all(
      Object.keys(SUPPORTED_CHAINS).map(async (id) => {
        const chainId = Number(id) as JBChainId;
        return [chainId, await clientsFor(chainId)] as const;
      }),
    ),
  );
  const graph = await readFundGlobalSnapshotGraph({ root: source, clients });
  if (
    graph.projects.length > 8 ||
    new Set(graph.projects.map((project) => project.chainId)).size !==
      graph.projects.length
  ) {
    throw new Error(
      "This INCOME graph has ambiguous projects on the same chain or exceeds eight chains. Use the full Revnet interface.",
    );
  }
  const states = await Promise.all(
    graph.projects.map(async (project) => {
      if (
        !isAddressEqual(project.owner, v6Address("REVOwner", project.chainId))
      )
        throw new Error("A linked project is not a canonical INCOME Revnet.");
      const client = clients.get(project.chainId)!;
      const state = await readIncomeProjectState(client, {
        chainId: project.chainId,
        projectId: project.projectId,
        ...(source.account ? { account: source.account } : {}),
      });
      assertIncomeBridgeState(state);
      const cut = graph.cuts.find((cut) => cut.chainId === project.chainId)!;
      if (state.blockNumber < cut.blockNumber)
        throw new Error("The INCOME RPC is behind the verified bridge graph.");
      const historical = graph.lanes.filter(
        (lane) =>
          lane.sourceChainId === project.chainId &&
          lane.sourceProjectId === project.projectId,
      );
      const pairs = await client.readContract({
        address: v6Address("JBSuckerRegistry", state.chainId),
        abi: jbSuckerRegistryAbi,
        functionName: "suckerPairsOf",
        args: [state.projectId],
        blockNumber: state.blockNumber,
      });
      if (pairs.length > 32)
        throw new Error(
          "This INCOME project exceeds the supported active bridge count.",
        );
      const active = pairs.map((pair) => {
        const remote = suckerBytes32ToAddress(pair.remote);
        const lane = historical.find(
          (lane) =>
            BigInt(lane.destinationChainId) === pair.remoteChainId &&
            isAddressEqual(lane.sourceSucker, pair.local) &&
            isAddressEqual(lane.destinationSucker, remote),
        );
        if (!lane)
          throw new Error(
            "A current INCOME route is not in the finalized reciprocal bridge graph yet. Wait for finality and refresh.",
          );
        return {
          chainId: lane.destinationChainId,
          localSuckerAddress: pair.local,
          suckerAddress: remote,
        };
      });
      const destinations = [
        ...new Set(historical.map((lane) => lane.destinationChainId)),
      ];
      const linkedPeers = destinations.flatMap((chainId) => {
        const current = active.filter((peer) => peer.chainId === chainId);
        if (current.length) return current;
        // A retired route can still have a delivered, unclaimed movement. Keep a
        // deterministic lane for history; preparation is explicitly disabled below.
        const lane = historical.find(
          (lane) => lane.destinationChainId === chainId,
        )!;
        return [
          {
            chainId,
            localSuckerAddress: lane.sourceSucker,
            suckerAddress: lane.destinationSucker,
          },
        ];
      });
      const block = await client.getBlock({ blockNumber: state.blockNumber });
      if (block.hash !== state.blockHash)
        throw new Error(
          "The INCOME chain changed while verifying its active bridge routes.",
        );
      return {
        ...state,
        linkedPeers,
        activeSuckers: active.map((peer) => peer.localSuckerAddress),
      };
    }),
  );
  // No cross-chain state is accepted after one of the identity cuts reorgs.
  await Promise.all(
    graph.cuts.map(async (cut) => {
      const block = await clients
        .get(cut.chainId)!
        .getBlock({ blockNumber: cut.blockNumber });
      if (block.hash !== cut.blockHash)
        throw new Error(
          "The finalized INCOME bridge identity changed. Refresh the whole graph.",
        );
    }),
  );
  return states;
}

export async function readIncomeBridgeRoute(
  clients: ProjectBridgeClientFor,
  sourceState: IncomeProjectState,
  destinationChainId: number,
  sourceToken: Address = USDC_ADDRESSES[sourceState.chainId],
): Promise<IncomeBridgeRoute> {
  if (destinationChainId === sourceState.chainId)
    throw new Error("Select a different destination chain.");
  const states = await readLinkedIncomeProjects(clients, sourceState);
  const source = states.find(
    (state) =>
      state.chainId === sourceState.chainId &&
      state.projectId === sourceState.projectId,
  );
  const destination = states.find(
    (state) => state.chainId === destinationChainId,
  );
  if (!source || !destination)
    throw new Error("The destination is not a verified linked INCOME project.");
  const route = await readProjectBridgeRoute(
    clients,
    source,
    destination,
    sourceToken,
  );
  const active =
    source.activeSuckers.some((sucker) =>
      isAddressEqual(sucker, route.sourceSucker),
    ) &&
    destination.activeSuckers.some((sucker) =>
      isAddressEqual(sucker, route.destinationSucker),
    );
  if (!active)
    return {
      ...route,
      canPrepare: false,
      prepareIssue:
        "This retired bridge is available for movement recovery only.",
    };
  return route;
}
function assertRoute(route: IncomeBridgeRoute) {
  assertIncomeBridgeState(route.source);
  assertIncomeBridgeState(route.destination);
  if (
    !route.source.activeSuckers.some((sucker) =>
      isAddressEqual(sucker, route.sourceSucker),
    ) ||
    !route.destination.activeSuckers.some((sucker) =>
      isAddressEqual(sucker, route.destinationSucker),
    )
  )
    throw new Error("This bridge is not an active reciprocal INCOME route.");
  if (
    route.source.tokenAddress &&
    isAddressEqual(route.source.tokenAddress, zeroAddress)
  )
    throw new Error("INCOME needs a deployed ERC20 before bridging.");
}
export async function readIncomeBridgePrepareQuote(
  client: PublicClient,
  route: IncomeBridgeRoute,
  count: bigint,
  slippageBps = 100,
) {
  assertRoute(route);
  return readProjectBridgePrepareQuote(client, route, count, slippageBps);
}
export function buildIncomeBridgeApproval(
  route: IncomeBridgeRoute,
  count: bigint,
) {
  assertRoute(route);
  return buildProjectBridgeApproval(route, count);
}
export function buildIncomeBridgePrepare(
  route: IncomeBridgeRoute,
  input: { amount: bigint; beneficiary: Address; minTokensReclaimed: bigint },
) {
  assertRoute(route);
  return buildProjectBridgePrepare(route, input);
}
