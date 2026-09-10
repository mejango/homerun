/** Shared V6 sucker mechanics. Product adapters verify ownership and hooks before entering this pipeline. */
import {
  NATIVE_TOKEN,
  jbMultiTerminalAbi,
  jbSuckerRegistryAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import {
  CCIP_SUCKER_TRANSPORT_VALUES,
  NATIVE_SUCKER_TRANSPORT_VALUES,
  assertSuckerTransportValue,
  buildBridgePrepareTx,
  buildBridgeClaimTx,
  buildToRemoteTx,
  cashOutProtocolFee,
  claimFromSuckerMovement,
  classifySuckerTransport,
  findSuckerTransportValue,
  getAllV6SuckerPairs,
  getSuckerMovements,
  jbSuckerV6ViewAbi,
  suckerAccountingContextKey,
  suckerBranchRoot,
  suckerBytes32ToAddress,
  suckerLeafHash,
  v6Address,
  type JBSuckerMovement,
  type JBSuckerTransport,
} from "@bananapus/nana-sdk-core/v6";
import {
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { type FundTransaction } from "./fund-contracts";
import type {
  FundAccountingContext,
  FundLinkedPeer,
  FundProjectState,
} from "./fund-state";

export type BridgeAccountingContext = Omit<
  FundAccountingContext,
  "payoutLimits" | "surplusAllowances"
>;
export type BridgeProjectState = Pick<
  FundProjectState,
  | "chainId"
  | "projectId"
  | "blockNumber"
  | "blockHash"
  | "account"
  | "tokenAddress"
  | "creditBalance"
  | "erc20Balance"
> & {
  accountingContexts: BridgeAccountingContext[];
  linkedPeers: FundLinkedPeer[];
};

export type ProjectBridgeClientFor = (
  chainId: JBChainId,
) => PublicClient | Promise<PublicClient>;
export type ProjectBridgeRoute<
  State extends BridgeProjectState = BridgeProjectState,
> = {
  source: State;
  destination: State;
  sourceSucker: Address;
  destinationSucker: Address;
  sourceToken: Address;
  destinationToken: Address;
  sourceContext: BridgeAccountingContext;
  destinationContext: BridgeAccountingContext;
  transport: JBSuckerTransport;
  baseFee: bigint;
  canPrepare: boolean;
  prepareIssue: string | null;
};
export type ProjectBridgeMovement = JBSuckerMovement & {
  sourceSucker: Address;
  destinationSucker: Address;
  sourceChainId: number;
  destinationChainId: number;
  sourceProjectId: bigint;
  destinationProjectId: bigint;
  beneficiary: Address;
  /** Root against which the SDK actually verified this claim's sibling path. */
  inboxRoot: Hex | null;
};
export type ProjectBridgePrepareQuote = {
  amount: bigint;
  grossReclaimAmount: bigint;
  netReclaimAmount: bigint;
  minTokensReclaimed: bigint;
  fee: bigint;
  allowance: bigint;
};
const UINT128_MAX = (1n << 128n) - 1n;
const feelessAbi = parseAbi([
  "function isFeelessFor(address addr,uint256 projectId,address caller) view returns (bool)",
]);
const suckerStateAbi = parseAbi(["function state() view returns (uint8)"]);
function recipient(value: Address): Address {
  if (!isAddress(value) || isAddressEqual(value, zeroAddress))
    throw new Error("Enter a valid nonzero bridge beneficiary.");
  return getAddress(value);
}
function amount(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value <= 0n || value > UINT128_MAX)
    throw new Error(
      `${label} must be a positive amount within the sucker’s uint128 leaf limit.`,
    );
}
function routeForPrepare(
  route: ProjectBridgeRoute,
  tokenCount: bigint,
): Address {
  if (!route.canPrepare)
    throw new Error(
      route.prepareIssue ?? "This bridge cannot prepare new movements.",
    );
  if (!route.source.account || !route.source.tokenAddress)
    throw new Error(
      "Connect a wallet and claim internal credits as ERC20 tokens before bridging.",
    );
  amount(tokenCount, "project tokens to bridge");
  if (tokenCount > route.source.erc20Balance)
    throw new Error(
      "Claim sufficient internal credits as ERC20 tokens before bridging this amount.",
    );
  return recipient(route.source.tokenAddress);
}

/** The adapter must supply fresh states whose registered peers are already reciprocal. */
export async function readProjectBridgeRoute<State extends BridgeProjectState>(
  clientForChainId: ProjectBridgeClientFor,
  source: State,
  destination: State,
  sourceToken: Address,
): Promise<ProjectBridgeRoute<State>> {
  if (source.chainId === destination.chainId)
    throw new Error("Select a different destination chain.");
  const sourceClient = await clientForChainId(source.chainId);
  const peers = source.linkedPeers.filter(
    (peer) => peer.chainId === destination.chainId,
  );
  if (peers.length !== 1)
    throw new Error(
      "Select an unambiguous registered bridge route in Juicebox.",
    );
  const peer = peers[0];
  const sourceContext = source.accountingContexts.find((context) =>
    isAddressEqual(context.token, sourceToken),
  );
  if (!sourceContext)
    throw new Error(
      "The source treasury does not accept the selected backing token.",
    );
  const at = { blockNumber: source.blockNumber };
  const [mapping, transport, baseFee, sendingState] = await Promise.all([
    sourceClient.readContract({
      address: peer.localSuckerAddress,
      abi: jbSuckerV6ViewAbi,
      functionName: "remoteTokenFor",
      args: [sourceToken],
      ...at,
    }),
    classifySuckerTransport(sourceClient, peer.localSuckerAddress),
    sourceClient.readContract({
      address: v6Address("JBSuckerRegistry", source.chainId),
      abi: jbSuckerRegistryAbi,
      functionName: "toRemoteFee",
      ...at,
    }),
    sourceClient.readContract({
      address: peer.localSuckerAddress,
      abi: suckerStateAbi,
      functionName: "state",
      ...at,
    }),
  ]);
  const sourceKey = suckerAccountingContextKey(
    sourceToken,
    source.chainId,
    sourceContext.decimals,
  );
  const candidates = destination.accountingContexts.filter(
    (context) =>
      suckerAccountingContextKey(
        context.token,
        destination.chainId,
        context.decimals,
      ) === sourceKey,
  );
  const destinationToken =
    mapping.addr !== zeroHash
      ? suckerBytes32ToAddress(mapping.addr)
      : candidates.length === 1
        ? candidates[0].token
        : undefined;
  const destinationContext =
    destinationToken &&
    destination.accountingContexts.find((context) =>
      isAddressEqual(context.token, destinationToken),
    );
  if (
    !destinationContext ||
    destinationContext.decimals !== sourceContext.decimals ||
    suckerAccountingContextKey(
      destinationContext.token,
      destination.chainId,
      destinationContext.decimals,
    ) !== sourceKey
  ) {
    throw new Error(
      "The sucker mapping does not match the verified destination backing asset and precision.",
    );
  }
  const prepareIssue =
    sendingState >= 2
      ? "The sucker no longer accepts new outbound movements."
      : !mapping.enabled || mapping.addr === zeroHash
        ? "The backing-token mapping is disabled for new movements."
        : transport === "unknown"
          ? "The bridge transport could not be verified."
          : transport === "native" && !isAddressEqual(sourceToken, NATIVE_TOKEN)
            ? "Use a CCIP route for this ERC20 backing token; a native route may strand it."
            : !source.tokenAddress
              ? "The project needs a deployed ERC20 before its tokens can bridge."
              : null;
  const block = await sourceClient.getBlock({
    blockNumber: source.blockNumber,
  });
  if (block.hash !== source.blockHash)
    throw new Error("The source chain changed during bridge verification.");
  return {
    source,
    destination,
    sourceSucker: peer.localSuckerAddress,
    destinationSucker: peer.suckerAddress,
    sourceToken,
    destinationToken: destinationContext.token,
    sourceContext,
    destinationContext,
    transport,
    baseFee,
    canPrepare: prepareIssue === null,
    prepareIssue,
  };
}

/**
 * Reconstruct proofs locally from RPC events, including deprecated routes.
 * No indexer row, browser draft, or external prover certifies claimability.
 */
export async function readProjectBridgeMovements(
  clientForChainId: ProjectBridgeClientFor,
  route: ProjectBridgeRoute,
): Promise<ProjectBridgeMovement[]> {
  const [sourceClient, destinationClient] = await Promise.all([
    clientForChainId(route.source.chainId),
    clientForChainId(route.destination.chainId),
  ]);
  if (
    (await sourceClient.getChainId()) !== route.source.chainId ||
    (await destinationClient.getChainId()) !== route.destination.chainId
  )
    throw new Error("A bridge RPC returned the wrong chain.");
  const [sourcePairs, destinationPairs] = await Promise.all([
    getAllV6SuckerPairs(sourceClient, {
      chainId: route.source.chainId,
      projectId: route.source.projectId,
    }),
    getAllV6SuckerPairs(destinationClient, {
      chainId: route.destination.chainId,
      projectId: route.destination.projectId,
    }),
  ]);
  if (sourcePairs.length > 32 || destinationPairs.length > 32)
    throw new Error(
      "This bridge history exceeds the supported route count; use the full Juicebox interface.",
    );
  const pairs = sourcePairs.filter(
    (pair) => pair.remoteChainId === BigInt(route.destination.chainId),
  );
  const batches = await Promise.all(
    pairs.map(async (pair) => {
      if (
        !destinationPairs.some(
          (other) =>
            other.remoteChainId === BigInt(route.source.chainId) &&
            isAddressEqual(other.local, pair.remote) &&
            isAddressEqual(other.remote, pair.local),
        )
      )
        throw new Error(
          "The historical sucker route is not reciprocally registered.",
        );
      const [sourceId, destinationId] = await Promise.all([
        sourceClient.readContract({
          address: pair.local,
          abi: jbSuckerV6ViewAbi,
          functionName: "projectId",
        }),
        destinationClient.readContract({
          address: pair.remote,
          abi: jbSuckerV6ViewAbi,
          functionName: "projectId",
        }),
      ]);
      if (
        sourceId !== route.source.projectId ||
        destinationId !== route.destination.projectId
      )
        throw new Error("A historical bridge belongs to different projects.");
      const outbox = await sourceClient.readContract({
        address: pair.local,
        abi: jbSuckerV6ViewAbi,
        functionName: "outboxOf",
        args: [route.sourceToken],
      });
      if (outbox.tree.count > 4096n)
        throw new Error(
          "This bridge history exceeds the supported movement count; use the full Juicebox interface.",
        );
      const movements = await getSuckerMovements(
        sourceClient,
        destinationClient,
        {
          sourceSucker: pair.local,
          destinationSucker: pair.remote,
          sourceToken: route.sourceToken,
          remoteToken: route.destinationToken,
          blockRange: 9_999n,
          maxBlockRanges: 512,
        },
      );
      if (movements.length > 4096)
        throw new Error(
          "This bridge history exceeds the supported movement count; use the full Juicebox interface.",
        );
      return movements.map((movement) => ({
        ...movement,
        sourceSucker: pair.local,
        destinationSucker: pair.remote,
        sourceChainId: route.source.chainId,
        destinationChainId: route.destination.chainId,
        sourceProjectId: route.source.projectId,
        destinationProjectId: route.destination.projectId,
        beneficiary: suckerBytes32ToAddress(movement.leaf.beneficiary),
        inboxRoot: movement.proof
          ? suckerBranchRoot(
              movement.leafHash,
              movement.proof,
              Number(movement.leaf.index),
            )
          : null,
      }));
    }),
  );
  return batches
    .flat()
    .sort((left, right) =>
      left.blockNumber > right.blockNumber
        ? -1
        : left.blockNumber < right.blockNumber
          ? 1
          : 0,
    );
}

export async function readProjectBridgePrepareQuote(
  client: PublicClient,
  route: ProjectBridgeRoute,
  tokenCount: bigint,
  slippageBps = 100,
): Promise<ProjectBridgePrepareQuote> {
  const projectToken = routeForPrepare(route, tokenCount);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500)
    throw new Error("Bridge slippage must be between 0 and 5%.");
  if ((await client.getChainId()) !== route.source.chainId)
    throw new Error("The bridge quote RPC returned the wrong chain.");
  const at = { blockNumber: route.source.blockNumber };
  const terminal = route.sourceContext.terminal;
  const [preview, feeFreeSurplus, feelessAddresses, allowance] =
    await Promise.all([
      client.readContract({
        account: route.sourceSucker,
        address: terminal,
        abi: jbMultiTerminalAbi,
        functionName: "previewCashOutFrom",
        args: [
          route.sourceSucker,
          route.source.projectId,
          tokenCount,
          route.sourceToken,
          route.sourceSucker,
          "0x",
        ],
        ...at,
      }),
      client.readContract({
        address: terminal,
        abi: jbMultiTerminalAbi,
        functionName: "feeFreeSurplusOf",
        args: [route.source.projectId, route.sourceToken],
        ...at,
      }),
      client.readContract({
        address: terminal,
        abi: jbMultiTerminalAbi,
        functionName: "FEELESS_ADDRESSES",
        ...at,
      }),
      client.readContract({
        address: projectToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [route.source.account!, route.sourceSucker],
        ...at,
      }),
    ]);
  const beneficiaryIsFeeless = await client.readContract({
    address: feelessAddresses,
    abi: feelessAbi,
    functionName: "isFeelessFor",
    args: [route.sourceSucker, route.source.projectId, route.sourceSucker],
    ...at,
  });
  const grossReclaimAmount = preview[1];
  const fee = cashOutProtocolFee({
    reclaimAmount: grossReclaimAmount,
    cashOutTaxRate: preview[2],
    beneficiaryIsFeeless,
    feeFreeSurplus,
  });
  const netReclaimAmount = grossReclaimAmount - fee;
  const minTokensReclaimed =
    (netReclaimAmount * BigInt(10_000 - slippageBps)) / 10_000n;
  amount(netReclaimAmount, "Quoted bridge backing");
  amount(minTokensReclaimed, "Protected bridge minimum");
  const block = await client.getBlock({
    blockNumber: route.source.blockNumber,
  });
  if (block.hash !== route.source.blockHash)
    throw new Error("The chain changed during the bridge quote.");
  return {
    amount: tokenCount,
    grossReclaimAmount,
    netReclaimAmount,
    minTokensReclaimed,
    fee,
    allowance,
  };
}

export function buildProjectBridgeApproval(
  route: ProjectBridgeRoute,
  tokenCount: bigint,
): FundTransaction {
  const projectToken = routeForPrepare(route, tokenCount);
  return {
    chainId: route.source.chainId,
    address: projectToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [route.sourceSucker, tokenCount],
  };
}

export function buildProjectBridgePrepare(
  route: ProjectBridgeRoute,
  input: { amount: bigint; beneficiary: Address; minTokensReclaimed: bigint },
): FundTransaction {
  routeForPrepare(route, input.amount);
  amount(input.minTokensReclaimed, "Protected bridge minimum");
  return buildBridgePrepareTx({
    chainId: route.source.chainId,
    sucker: route.sourceSucker,
    projectTokenCount: input.amount,
    beneficiary: recipient(input.beneficiary),
    minTokensReclaimed: input.minTokensReclaimed,
    token: route.sourceToken,
    metadata: zeroHash,
  });
}

/** Read the registry charge, then simulate each native transport budget exactly. */
export async function readProjectBridgeSendValue(
  client: PublicClient,
  route: ProjectBridgeRoute,
  account: Address,
): Promise<bigint> {
  recipient(account);
  if ((await client.getChainId()) !== route.source.chainId)
    throw new Error("The bridge-send RPC returned the wrong chain.");
  const [baseFee, transport] = await Promise.all([
    client.readContract({
      address: v6Address("JBSuckerRegistry", route.source.chainId),
      abi: jbSuckerRegistryAbi,
      functionName: "toRemoteFee",
    }),
    classifySuckerTransport(client, route.sourceSucker),
  ]);
  if (baseFee !== route.baseFee || transport !== route.transport)
    throw new Error(
      "The bridge fee or transport changed. Refresh the route and review again.",
    );
  if (transport === "unknown")
    throw new Error("The bridge transport could not be verified.");
  const budgets =
    transport === "ccip"
      ? CCIP_SUCKER_TRANSPORT_VALUES
      : NATIVE_SUCKER_TRANSPORT_VALUES;
  const value = await findSuckerTransportValue(
    budgets.map((budget) => baseFee + budget),
    async (candidate) => {
      const request = buildProjectBridgeSend(route, candidate);
      await client.simulateContract({ ...request, account });
    },
  );
  if (value === null)
    throw new Error(
      "No bounded bridge transport fee could be simulated. No send transaction was prepared.",
    );
  return value;
}

export function buildProjectBridgeSend(
  route: ProjectBridgeRoute,
  value: bigint,
): FundTransaction {
  if (typeof value !== "bigint" || value < route.baseFee || value >= 1n << 256n)
    throw new Error(
      "Include the current registry fee in the bridge transport amount.",
    );
  assertSuckerTransportValue(route.transport, value, route.baseFee);
  return buildToRemoteTx({
    chainId: route.source.chainId,
    sucker: route.sourceSucker,
    token: route.sourceToken,
    value,
  });
}

/** Always re-read this movement with readProjectBridgeMovements before signing. */
export function buildProjectBridgeClaim(
  route: ProjectBridgeRoute,
  movement: ProjectBridgeMovement,
): FundTransaction {
  if (
    movement.sourceChainId !== route.source.chainId ||
    movement.destinationChainId !== route.destination.chainId ||
    movement.sourceProjectId !== route.source.projectId ||
    movement.destinationProjectId !== route.destination.projectId ||
    !isAddressEqual(movement.sourceToken, route.sourceToken) ||
    !isAddressEqual(movement.remoteToken, route.destinationToken)
  )
    throw new Error(
      "The verified bridge movement belongs to a different route.",
    );
  recipient(movement.sourceSucker);
  recipient(movement.destinationSucker);
  if (
    movement.status !== "claimable" ||
    !movement.proof ||
    movement.proof.length !== 32 ||
    !movement.inboxRoot
  )
    throw new Error(
      "Wait for the destination inbox root before claiming the movement.",
    );
  if (movement.leaf.index < 0n || movement.leaf.index >= 1n << 32n)
    throw new Error("The bridge leaf index is invalid.");
  if (
    !isAddressEqual(
      movement.beneficiary,
      suckerBytes32ToAddress(movement.leaf.beneficiary),
    )
  )
    throw new Error(
      "The bridge beneficiary does not match its committed leaf.",
    );
  const hash = suckerLeafHash(movement.leaf);
  if (
    hash.toLowerCase() !== movement.leafHash.toLowerCase() ||
    suckerBranchRoot(
      hash,
      movement.proof,
      Number(movement.leaf.index),
    ).toLowerCase() !== movement.inboxRoot.toLowerCase()
  )
    throw new Error(
      "The bridge proof does not match the verified leaf and destination root.",
    );
  return buildBridgeClaimTx({
    chainId: route.destination.chainId,
    sucker: movement.destinationSucker,
    claim: claimFromSuckerMovement(movement),
  });
}
