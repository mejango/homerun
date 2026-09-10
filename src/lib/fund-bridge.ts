/** FUND adapter: revnets never gain FUND ownership permissions through bridge reuse. */
import { USDC_ADDRESSES } from "@bananapus/nana-sdk-core";
import type { Address, PublicClient } from "viem";
import {
  assertFundStateForWrite,
  readFundProjectState,
  readLinkedFundProjects,
  type FundProjectState,
} from "./fund-state";
import {
  readProjectBridgeRoute,
  readProjectBridgePrepareQuote,
  buildProjectBridgeApproval,
  buildProjectBridgePrepare,
  type ProjectBridgeRoute,
  type ProjectBridgeMovement,
  type ProjectBridgeClientFor,
  type ProjectBridgePrepareQuote,
} from "./project-bridge";
export type FundBridgeClientFor = ProjectBridgeClientFor;
export type FundBridgeRoute = ProjectBridgeRoute<FundProjectState>;
export type FundBridgeMovement = ProjectBridgeMovement;
export type FundBridgePrepareQuote = ProjectBridgePrepareQuote;
export {
  readProjectBridgeMovements as readFundBridgeMovements,
  readProjectBridgeSendValue as readFundBridgeSendValue,
  buildProjectBridgeSend as buildFundBridgeSend,
  buildProjectBridgeClaim as buildFundBridgeClaim,
} from "./project-bridge";

export async function readFundBridgeRoute(
  clientForChainId: FundBridgeClientFor,
  sourceState: FundProjectState,
  destinationChainId: number,
  sourceToken: Address = USDC_ADDRESSES[sourceState.chainId],
): Promise<FundBridgeRoute> {
  if (destinationChainId === sourceState.chainId)
    throw new Error("Select a different destination chain.");
  const client = await clientForChainId(sourceState.chainId);
  const fresh = await readFundProjectState(client, {
    chainId: sourceState.chainId,
    projectId: sourceState.projectId,
    ...(sourceState.account ? { account: sourceState.account } : {}),
  });
  const states = await readLinkedFundProjects(clientForChainId, fresh);
  const source = states.find((state) => state.chainId === fresh.chainId)!;
  const destination = states.find(
    (state) => state.chainId === destinationChainId,
  );
  if (!destination)
    throw new Error("The destination is not a verified linked FUND project.");
  assertFundStateForWrite(source);
  assertFundStateForWrite(destination);
  return readProjectBridgeRoute(
    clientForChainId,
    source,
    destination,
    sourceToken,
  );
}
function assertRoute(route: FundBridgeRoute) {
  assertFundStateForWrite(route.source, route.source.account ?? undefined);
  assertFundStateForWrite(route.destination);
}
export async function readFundBridgePrepareQuote(
  client: PublicClient,
  route: FundBridgeRoute,
  tokenCount: bigint,
  slippageBps = 100,
) {
  assertRoute(route);
  return readProjectBridgePrepareQuote(client, route, tokenCount, slippageBps);
}
export function buildFundBridgeApproval(
  route: FundBridgeRoute,
  tokenCount: bigint,
) {
  assertRoute(route);
  return buildProjectBridgeApproval(route, tokenCount);
}
export function buildFundBridgePrepare(
  route: FundBridgeRoute,
  input: { amount: bigint; beneficiary: Address; minTokensReclaimed: bigint },
) {
  assertRoute(route);
  return buildProjectBridgePrepare(route, input);
}
