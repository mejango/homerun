/** Same-block Sticky identity, backing and holder reads. Candidate IDs are never authority. */
import {
  jbControllerAbi,
  jbDirectoryAbi,
  jbFundAccessLimitsAbi,
  jbMultiTerminalAbi,
  jbProjectsAbi,
  jbSplitsAbi,
  jbTerminalStoreAbi,
  jbTokensAbi,
  type JBChainId,
} from "@bananapus/nana-sdk-core";
import {
  RESERVED_TOKEN_SPLIT_GROUP_ID,
  previewPay,
  getHookAwareCashOutQuote,
  buildCashOutTx,
  v6Address,
} from "@bananapus/nana-sdk-core/v6";
import {
  erc20Abi,
  getAbiItem,
  decodeEventLog,
  isAddressEqual,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  registeredStickyContract,
  stickyDeployerAbi,
  stickyDistributorAbi,
  stickyHookAbi,
  stickyTokenAbi,
  stickyMinimum,
  type StickyIdentity,
} from "./sticky-contracts";
import {
  readInitialIncomeAllocation,
  type InitialIncomeAllocationState,
} from "./income-allocation-state";
import { homerunIncomeDeployerAbi } from "./income-contracts";

const feedAbi = parseAbi([
  "function HOOK() view returns (address)",
  "function PROJECT_ID() view returns (uint256)",
  "function TERMINAL() view returns (address)",
  "function TOKEN() view returns (address)",
  "function UNDERLYING_TOKEN() view returns (address)",
  "function CURRENCY() view returns (uint32)",
  "function DECIMALS() view returns (uint8)",
]);
export type StickyTranche = { amount: bigint; timestamp: number };
export type StickyRewardState = {
  incomeProjectId: bigint;
  incomeToken: Address;
  distributor: Address;
  round: bigint;
  roundDuration: bigint;
  vestingRounds: bigint;
  claimDuration: bigint;
  collectable: bigint;
  claimed: bigint;
  eligibleUnvested: bigint;
  historyIssue: string | null;
  fundingActive: boolean;
  activeVestingLoanId: bigint;
};
export type StickyProjectState = StickyIdentity & {
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp: bigint;
  account: Address | null;
  controller: Address;
  hook: Address;
  feed: Address;
  fundDecimals: number;
  cashOutTaxRate: bigint;
  soulbound: boolean;
  totalSupply: bigint;
  backing: bigint;
  orphanedBacking: bigint;
  fundCreditBalance: bigint;
  fundBalance: bigint;
  allowance: bigint;
  shareBalance: bigint;
  streakStart: bigint;
  longestStreak: bigint;
  trancheCount: bigint;
  trancheStart: bigint;
  tranches: readonly StickyTranche[];
  rewards: StickyRewardState | null;
  rewardIssue: string | null;
};
export type StickyReadInput = {
  chainId: JBChainId;
  fundProjectId: bigint;
  stickyProjectId: bigint;
  account?: Address;
  incomeProjectId?: bigint;
  tranchePage?: bigint;
};
function same(left: Address, right: Address, label: string) {
  if (!isAddressEqual(left, right))
    throw new Error(`${label} does not match its verified deployment.`);
}
async function code(
  client: PublicClient,
  address: Address,
  blockNumber: bigint,
) {
  const deployed = await client.getCode({ address, blockNumber });
  if (!deployed || deployed === "0x")
    throw new Error("A required Sticky contract has no deployed code.");
  return deployed;
}
/** SDK previewPay does not set a payer. Sticky requires the real payer, and all quote reads must use the verified block. */
export function stickySnapshotClient(
  client: PublicClient,
  state: Pick<StickyProjectState, "blockNumber">,
  account: Address,
): PublicClient {
  return {
    ...client,
    readContract: ((parameters) =>
      client.readContract({
        ...parameters,
        account,
        blockNumber: state.blockNumber,
      } as never)) as PublicClient["readContract"],
    simulateContract: ((parameters) =>
      client.simulateContract({
        ...parameters,
        account,
        blockNumber: state.blockNumber,
      } as never)) as PublicClient["simulateContract"],
  } as PublicClient;
}
export async function readStickyProjectState(
  client: PublicClient,
  input: StickyReadInput,
): Promise<StickyProjectState> {
  const { chainId, fundProjectId, stickyProjectId, account } = input;
  if (
    fundProjectId <= 0n ||
    stickyProjectId <= 0n ||
    fundProjectId === stickyProjectId
  )
    throw new Error(
      "Distinct positive FUND and Sticky project IDs are required.",
    );
  const deployer = registeredStickyContract(chainId, "JBStickyDeployer");
  if (!deployer)
    throw new Error(
      "Sticky is not enabled: no verified JBStickyDeployer is registered on this network.",
    );
  if (
    (client.chain && client.chain.id !== chainId) ||
    (await client.getChainId()) !== chainId
  )
    throw new Error("The Sticky RPC is connected to a different chain.");
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.number === null || !block.hash || block.number <= 0n)
    throw new Error("The RPC did not return a mined Sticky snapshot.");
  const blockNumber = block.number,
    at = { blockNumber };
  const controller = v6Address("JBController", chainId),
    terminal = v6Address("JBMultiTerminal", chainId),
    tokens = v6Address("JBTokens", chainId),
    directory = v6Address("JBDirectory", chainId);
  await code(client, deployer, blockNumber);
  const [
    deployerController,
    deployerTerminal,
    deployerTokens,
    hook,
    fundToken,
    underlying,
    shareToken,
    owner,
    activeController,
    fundController,
    terminals,
    current,
    feed,
    cashOutTaxRate,
  ] = await Promise.all([
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "CONTROLLER",
      ...at,
    }),
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "TERMINAL",
      ...at,
    }),
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "TOKENS",
      ...at,
    }),
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "HOOK",
      ...at,
    }),
    client.readContract({
      address: tokens,
      abi: jbTokensAbi,
      functionName: "tokenOf",
      args: [fundProjectId],
      ...at,
    }),
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "stakedTokenOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: tokens,
      abi: jbTokensAbi,
      functionName: "tokenOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: v6Address("JBProjects", chainId),
      abi: jbProjectsAbi,
      functionName: "ownerOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: directory,
      abi: jbDirectoryAbi,
      functionName: "controllerOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: directory,
      abi: jbDirectoryAbi,
      functionName: "controllerOf",
      args: [fundProjectId],
      ...at,
    }),
    client.readContract({
      address: directory,
      abi: jbDirectoryAbi,
      functionName: "terminalsOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: controller,
      abi: jbControllerAbi,
      functionName: "currentRulesetOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "priceFeedOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: deployer,
      abi: stickyDeployerAbi,
      functionName: "cashOutTaxRateOf",
      args: [stickyProjectId],
      ...at,
    }),
  ]);
  same(deployerController, controller, "Sticky controller");
  same(deployerTerminal, terminal, "Sticky terminal");
  same(deployerTokens, tokens, "Sticky token registry");
  same(owner, deployer, "Sticky project owner");
  same(activeController, controller, "Project controller");
  same(fundController, controller, "FUND controller");
  same(underlying, fundToken, "Staked FUND token");
  if (
    [fundToken, shareToken, hook, feed].some((address) =>
      isAddressEqual(address, zeroAddress),
    ) ||
    isAddressEqual(fundToken, shareToken)
  )
    throw new Error(
      "The Sticky project has missing or inconsistent token bindings.",
    );
  if (terminals.length !== 1 || !isAddressEqual(terminals[0], terminal))
    throw new Error("Sticky must use its single immutable V6 terminal.");
  const [ruleset, metadata] = current;
  const currency = Number(BigInt(fundToken) & 0xffffffffn),
    baseCurrency = currency === 0xffffffff ? 0xfffffffe : 0xffffffff;
  if (
    !ruleset.id ||
    ruleset.duration !== 0 ||
    ruleset.weight !== 10n ** 18n ||
    ruleset.weightCutPercent !== 0 ||
    !isAddressEqual(ruleset.approvalHook, zeroAddress) ||
    currency === 0 ||
    cashOutTaxRate > 10_000n ||
    metadata.reservedPercent !== 0 ||
    BigInt(metadata.cashOutTaxRate) !== cashOutTaxRate ||
    metadata.baseCurrency !== baseCurrency ||
    metadata.pausePay ||
    !metadata.pauseCreditTransfers ||
    metadata.allowOwnerMinting ||
    !metadata.allowSetCustomToken ||
    metadata.allowTerminalMigration ||
    metadata.allowSetTerminals ||
    metadata.allowSetController ||
    metadata.allowAddAccountingContext ||
    !metadata.allowAddPriceFeed ||
    metadata.ownerMustSendPayouts ||
    metadata.holdFees ||
    metadata.scopeCashOutsToLocalBalances ||
    !metadata.useDataHookForPay ||
    !metadata.useDataHookForCashOut ||
    !isAddressEqual(metadata.dataHook, hook) ||
    metadata.metadata !== 0
  )
    throw new Error(
      "The Sticky ruleset differs from its permanent staking policy.",
    );
  const [payouts, allowances] = await Promise.all([
    client.readContract({
      address: v6Address("JBFundAccessLimits", chainId),
      abi: jbFundAccessLimitsAbi,
      functionName: "payoutLimitsOf",
      args: [stickyProjectId, BigInt(ruleset.id), terminal, fundToken],
      ...at,
    }),
    client.readContract({
      address: v6Address("JBFundAccessLimits", chainId),
      abi: jbFundAccessLimitsAbi,
      functionName: "surplusAllowancesOf",
      args: [stickyProjectId, BigInt(ruleset.id), terminal, fundToken],
      ...at,
    }),
  ]);
  if (
    payouts.some((limit) => limit.amount > 0n) ||
    allowances.some((limit) => limit.amount > 0n)
  )
    throw new Error(
      "The Sticky project unexpectedly grants treasury withdrawal rights.",
    );
  const [
    hookDeployer,
    hookDirectory,
    hookToken,
    tokenHook,
    tokenRegistry,
    tokenProject,
    soulbound,
    fundDecimals,
    shareDecimals,
    contexts,
    primary,
    implementation,
    fundCode,
    feedHook,
    feedProject,
    feedTerminal,
    feedShare,
    feedFund,
    feedCurrency,
    feedDecimals,
  ] = await Promise.all([
    client.readContract({
      address: hook,
      abi: stickyHookAbi,
      functionName: "DEPLOYER",
      ...at,
    }),
    client.readContract({
      address: hook,
      abi: stickyHookAbi,
      functionName: "DIRECTORY",
      ...at,
    }),
    client.readContract({
      address: hook,
      abi: stickyHookAbi,
      functionName: "tokenOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: shareToken,
      abi: stickyTokenAbi,
      functionName: "HOOK",
      ...at,
    }),
    client.readContract({
      address: shareToken,
      abi: stickyTokenAbi,
      functionName: "TOKENS",
      ...at,
    }),
    client.readContract({
      address: shareToken,
      abi: stickyTokenAbi,
      functionName: "PROJECT_ID",
      ...at,
    }),
    client.readContract({
      address: shareToken,
      abi: stickyTokenAbi,
      functionName: "SOULBOUND",
      ...at,
    }),
    client.readContract({
      address: fundToken,
      abi: erc20Abi,
      functionName: "decimals",
      ...at,
    }),
    client.readContract({
      address: shareToken,
      abi: erc20Abi,
      functionName: "decimals",
      ...at,
    }),
    client.readContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: "accountingContextsOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: directory,
      abi: jbDirectoryAbi,
      functionName: "primaryTerminalOf",
      args: [stickyProjectId, fundToken],
      ...at,
    }),
    client.readContract({
      address: tokens,
      abi: jbTokensAbi,
      functionName: "TOKEN",
      ...at,
    }),
    code(client, fundToken, blockNumber),
    client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "HOOK",
      ...at,
    }),
    client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "PROJECT_ID",
      ...at,
    }),
    client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "TERMINAL",
      ...at,
    }),
    client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "TOKEN",
      ...at,
    }),
    client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "UNDERLYING_TOKEN",
      ...at,
    }),
    client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "CURRENCY",
      ...at,
    }),
    client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "DECIMALS",
      ...at,
    }),
    ...[hook, feed, shareToken].map((address) =>
      code(client, address, blockNumber),
    ),
  ]);
  same(hookDeployer, deployer, "Hook deployer");
  same(hookDirectory, directory, "Hook directory");
  same(hookToken, shareToken, "Hook SHARE token");
  same(tokenHook, hook, "SHARE hook");
  same(tokenRegistry, tokens, "SHARE registry");
  same(primary, terminal, "Primary terminal");
  same(feedHook, hook, "Price feed hook");
  same(feedTerminal, terminal, "Price feed terminal");
  same(feedShare, shareToken, "Price feed SHARE");
  same(feedFund, fundToken, "Price feed FUND");
  const expectedCode =
    `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex;
  if (
    isAddressEqual(implementation, zeroAddress) ||
    keccak256(fundCode) !== keccak256(expectedCode)
  )
    throw new Error("Staking requires the canonical FUND ERC20 clone.");
  if (
    tokenProject !== stickyProjectId ||
    feedProject !== stickyProjectId ||
    shareDecimals !== 18 ||
    fundDecimals !== 18 ||
    feedDecimals !== fundDecimals ||
    feedCurrency !== currency ||
    contexts.length !== 1 ||
    contexts[0].decimals !== fundDecimals ||
    contexts[0].currency !== currency ||
    !isAddressEqual(contexts[0].token, fundToken)
  )
    throw new Error(
      "The Sticky token or price feed accounting is inconsistent.",
    );
  const [
    totalSupply,
    totalCreditSupply,
    pendingReserved,
    backing,
    orphaned,
    shareBalance,
    stakedBalance,
    fundCreditBalance,
    fundBalance,
    allowance,
    streakStart,
    longestStreak,
    trancheCount,
    votes,
    delegate,
  ] = await Promise.all([
    client.readContract({
      address: shareToken,
      abi: erc20Abi,
      functionName: "totalSupply",
      ...at,
    }),
    client.readContract({
      address: tokens,
      abi: jbTokensAbi,
      functionName: "totalCreditSupplyOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: controller,
      abi: jbControllerAbi,
      functionName: "pendingReservedTokenBalanceOf",
      args: [stickyProjectId],
      ...at,
    }),
    client.readContract({
      address: v6Address("JBTerminalStore", chainId),
      abi: jbTerminalStoreAbi,
      functionName: "balanceOf",
      args: [terminal, stickyProjectId, fundToken],
      ...at,
    }),
    client.readContract({
      address: hook,
      abi: stickyHookAbi,
      functionName: "orphanedBalanceOf",
      args: [stickyProjectId],
      ...at,
    }),
    account
      ? client.readContract({
          address: shareToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: hook,
          abi: stickyHookAbi,
          functionName: "stakedBalanceOf",
          args: [stickyProjectId, account],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: tokens,
          abi: jbTokensAbi,
          functionName: "creditBalanceOf",
          args: [account, fundProjectId],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: fundToken,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: fundToken,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account, terminal],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: hook,
          abi: stickyHookAbi,
          functionName: "streakStartOf",
          args: [stickyProjectId, account],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: hook,
          abi: stickyHookAbi,
          functionName: "longestStreakOf",
          args: [stickyProjectId, account],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: hook,
          abi: stickyHookAbi,
          functionName: "trancheCountOf",
          args: [stickyProjectId, account],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: shareToken,
          abi: stickyTokenAbi,
          functionName: "getVotes",
          args: [account],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: shareToken,
          abi: stickyTokenAbi,
          functionName: "delegates",
          args: [account],
          ...at,
        })
      : zeroAddress,
  ]);
  if (
    totalCreditSupply !== 0n ||
    pendingReserved !== 0n ||
    shareBalance !== stakedBalance ||
    shareBalance > totalSupply ||
    orphaned > backing ||
    votes !== shareBalance ||
    (shareBalance > 0n && (!account || !isAddressEqual(delegate, account))) ||
    (shareBalance === 0n) !== (streakStart === 0n) ||
    streakStart > block.timestamp
  )
    throw new Error(
      "The Sticky position has inconsistent token, tranche or reward accounting.",
    );
  const page = input.tranchePage ?? 0n;
  if (page < 0n) throw new Error("Invalid tranche page.");
  const end = trancheCount > page * 50n ? trancheCount - page * 50n : 0n,
    start = end > 50n ? end - 50n : 0n;
  const tranches =
    account && end > start
      ? await client.readContract({
          address: hook,
          abi: stickyHookAbi,
          functionName: "tranchesOf",
          args: [stickyProjectId, account, start, end - start],
          ...at,
        })
      : [];
  if (
    BigInt(tranches.length) !== end - start ||
    tranches.some(
      (tranche, i) =>
        tranche.amount <= 0n ||
        BigInt(tranche.timestamp) > block.timestamp ||
        (i > 0 && tranche.timestamp < tranches[i - 1].timestamp),
    )
  )
    throw new Error(
      "The RPC returned an incomplete or invalid Sticky tranche page.",
    );
  if (
    start === 0n &&
    end === trancheCount &&
    tranches.reduce((sum, tranche) => sum + tranche.amount, 0n) !== shareBalance
  )
    throw new Error("Sticky tranches do not match the SHARE balance.");
  const state: StickyProjectState = {
    chainId,
    fundProjectId,
    stickyProjectId,
    deployer,
    fundToken,
    shareToken,
    terminal,
    controller,
    hook,
    feed,
    blockNumber,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    account: account ?? null,
    fundDecimals,
    cashOutTaxRate,
    soulbound,
    totalSupply,
    backing,
    orphanedBacking: totalSupply === 0n ? backing : orphaned,
    fundCreditBalance,
    fundBalance,
    allowance,
    shareBalance,
    streakStart,
    longestStreak,
    trancheCount,
    trancheStart: start,
    tranches,
    rewards: null,
    rewardIssue: null,
  };
  if (input.incomeProjectId !== undefined) {
    try {
      state.rewards = await readStickyRewards(
        client,
        state,
        input.incomeProjectId,
      );
    } catch (reason) {
      state.rewardIssue =
        reason instanceof Error
          ? reason.message
          : "SHARE rewards could not be verified.";
    }
  }
  if ((await client.getBlock({ blockNumber })).hash !== block.hash)
    throw new Error(
      "The chain changed during the Sticky read. Refresh and try again.",
    );
  return state;
}

export async function readStickyRewards(
  client: PublicClient,
  state: StickyProjectState,
  incomeProjectId: bigint,
): Promise<StickyRewardState> {
  if (
    incomeProjectId <= 0n ||
    incomeProjectId === state.fundProjectId ||
    incomeProjectId === state.stickyProjectId
  )
    throw new Error("A separate INCOME project is required.");
  const distributor = registeredStickyContract(
    state.chainId,
    "JBTokenDistributor",
  );
  if (!distributor)
    throw new Error(
      "No verified SHARE reward distributor is registered on this network.",
    );
  const { chainId, blockNumber, shareToken, account } = state,
    at = { blockNumber };
  await code(client, distributor, blockNumber);
  const [
    incomeOwner,
    incomeController,
    incomeCurrent,
    incomeToken,
    directory,
    controller,
    revOwner,
    revLoans,
    round,
    roundDuration,
    vestingRounds,
    claimDuration,
    clockMode,
    clock,
  ] = await Promise.all([
    client.readContract({
      address: v6Address("JBProjects", chainId),
      abi: jbProjectsAbi,
      functionName: "ownerOf",
      args: [incomeProjectId],
      ...at,
    }),
    client.readContract({
      address: v6Address("JBDirectory", chainId),
      abi: jbDirectoryAbi,
      functionName: "controllerOf",
      args: [incomeProjectId],
      ...at,
    }),
    client.readContract({
      address: state.controller,
      abi: jbControllerAbi,
      functionName: "currentRulesetOf",
      args: [incomeProjectId],
      ...at,
    }),
    client.readContract({
      address: v6Address("JBTokens", chainId),
      abi: jbTokensAbi,
      functionName: "tokenOf",
      args: [incomeProjectId],
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "DIRECTORY",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "CONTROLLER",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "REV_OWNER",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "REV_LOANS",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "currentRound",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "ROUND_DURATION",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "VESTING_ROUNDS",
      ...at,
    }),
    client.readContract({
      address: distributor,
      abi: stickyDistributorAbi,
      functionName: "CLAIM_DURATION",
      ...at,
    }),
    client.readContract({
      address: shareToken,
      abi: stickyTokenAbi,
      functionName: "CLOCK_MODE",
      ...at,
    }),
    client.readContract({
      address: shareToken,
      abi: stickyTokenAbi,
      functionName: "clock",
      ...at,
    }),
  ]);
  same(incomeOwner, v6Address("REVOwner", chainId), "INCOME owner");
  same(incomeController, state.controller, "INCOME controller");
  same(directory, v6Address("JBDirectory", chainId), "Distributor directory");
  same(controller, state.controller, "Distributor controller");
  if (
    !(
      (isAddressEqual(revOwner, zeroAddress) &&
        isAddressEqual(revLoans, zeroAddress)) ||
      (isAddressEqual(revOwner, v6Address("REVOwner", chainId)) &&
        isAddressEqual(revLoans, v6Address("REVLoans", chainId)))
    )
  )
    throw new Error(
      "The reward distributor has unsupported loan dependencies.",
    );
  // IVotes timepoints use the token's native clock. On Arbitrum this is the
  // L1-origin block number, while the RPC block pin above is an L2 height.
  const checkpointClock = BigInt(clock);
  if (
    isAddressEqual(incomeToken, zeroAddress) ||
    !incomeCurrent[0].id ||
    !isAddressEqual(incomeCurrent[1].dataHook, incomeOwner) ||
    !incomeCurrent[1].useDataHookForPay ||
    !incomeCurrent[1].useDataHookForCashOut ||
    new URLSearchParams(clockMode).get("mode") !== "blocknumber" ||
    checkpointClock <= 0n ||
    roundDuration <= 0n
  )
    throw new Error(
      "The INCOME reward route or SHARE snapshot clock is unsupported.",
    );
  const [
    splits,
    collectable,
    claimed,
    cursor,
    priorVotes,
    activeVestingLoanId,
  ] = await Promise.all([
    client.readContract({
      address: v6Address("JBSplits", chainId),
      abi: jbSplitsAbi,
      functionName: "splitsOf",
      args: [
        incomeProjectId,
        BigInt(incomeCurrent[0].id),
        RESERVED_TOKEN_SPLIT_GROUP_ID,
      ],
      ...at,
    }),
    account
      ? client.readContract({
          address: distributor,
          abi: stickyDistributorAbi,
          functionName: "collectableFor",
          args: [shareToken, BigInt(account), incomeToken],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: distributor,
          abi: stickyDistributorAbi,
          functionName: "claimedFor",
          args: [shareToken, BigInt(account), incomeToken],
          ...at,
        })
      : 0n,
    account
      ? client.readContract({
          address: distributor,
          abi: stickyDistributorAbi,
          functionName: "nextClaimRoundOf",
          args: [shareToken, 0n, BigInt(account), incomeToken],
          ...at,
        })
      : round,
    client.readContract({
      address: shareToken,
      abi: stickyTokenAbi,
      functionName: "getPastTotalActiveVotes",
      args: [checkpointClock - 1n],
      ...at,
    }),
    account
      ? client.readContract({
          address: distributor,
          abi: stickyDistributorAbi,
          functionName: "activeVestingLoanIdOf",
          args: [shareToken, 0n, BigInt(account), incomeToken],
          ...at,
        })
      : 0n,
  ]);
  const fundingActive = splits.some(
    (split) =>
      split.percent > 0 &&
      isAddressEqual(split.hook, distributor) &&
      isAddressEqual(split.beneficiary, shareToken),
  );
  if (collectable > claimed || priorVotes < 0n || cursor > round)
    throw new Error("The distributor returned inconsistent reward accounting.");
  let eligibleUnvested = 0n,
    historyIssue: string | null = null;
  if (round - cursor > 4096n)
    historyIssue =
      "Reward history exceeds this reader’s limit. Use a distributor client to start vesting; already unlocked rewards can still be collected here.";
  else if (account) {
    for (let start = cursor; start < round; start += 16n) {
      const ids = Array.from(
        { length: Number(round - start < 16n ? round - start : 16n) },
        (_, i) => start + BigInt(i),
      );
      const rounds = await Promise.all(
        ids.map((id) =>
          client.readContract({
            address: distributor,
            abi: stickyDistributorAbi,
            functionName: "rewardRoundOf",
            args: [shareToken, 0n, incomeToken, id],
            ...at,
          }),
        ),
      );
      const entitlements = await Promise.all(
        rounds.map(async (entry) => {
          if (
            !entry.amount ||
            !entry.totalStake ||
            (entry.claimDeadline !== 0 &&
              BigInt(entry.claimDeadline) <= state.blockTimestamp)
          )
            return 0n;
          if (BigInt(entry.snapshotBlock) >= checkpointClock)
            throw new Error(
              "A reward snapshot is not in the SHARE clock's past.",
            );
          const votes = await client.readContract({
            address: shareToken,
            abi: stickyTokenAbi,
            functionName: "getPastVotes",
            args: [account, BigInt(entry.snapshotBlock)],
            ...at,
          });
          if (votes > entry.totalStake)
            throw new Error("SHARE reward weight exceeds the snapshot total.");
          return (entry.amount * votes) / entry.totalStake;
        }),
      );
      eligibleUnvested += entitlements.reduce(
        (sum, amount) => sum + amount,
        0n,
      );
    }
  }
  if (
    !fundingActive &&
    claimed === 0n &&
    eligibleUnvested === 0n &&
    activeVestingLoanId === 0n &&
    !historyIssue
  )
    throw new Error(
      "No active INCOME funding route or existing SHARE reward entitlement could be verified.",
    );
  if ((await client.getBlock({ blockNumber })).hash !== state.blockHash)
    throw new Error(
      "The chain changed during the SHARE reward read. Refresh and try again.",
    );
  return {
    incomeProjectId,
    incomeToken,
    distributor,
    round,
    roundDuration,
    vestingRounds,
    claimDuration: BigInt(claimDuration),
    collectable,
    claimed,
    eligibleUnvested,
    historyIssue,
    fundingActive,
    activeVestingLoanId,
  };
}

export async function quoteStickyStake(
  client: PublicClient,
  state: StickyProjectState,
  amount: bigint,
) {
  if (!state.account || amount <= 0n || amount > state.fundBalance)
    throw new Error("A positive available FUND amount is required.");
  const quote = await previewPay(
    stickySnapshotClient(client, state, state.account),
    {
      chainId: state.chainId,
      projectId: state.stickyProjectId,
      terminal: state.terminal,
      token: state.fundToken,
      amount,
      beneficiary: state.account,
      metadata: "0x",
    },
  );
  if (quote.reservedTokenCount !== 0n)
    throw new Error("Sticky unexpectedly reserves newly minted SHARE.");
  return {
    shares: quote.beneficiaryTokenCount,
    minimumShares: stickyMinimum(quote.beneficiaryTokenCount),
  };
}
export async function quoteStickyUnstake(
  client: PublicClient,
  state: StickyProjectState,
  shares: bigint,
) {
  if (!state.account || shares <= 0n || shares > state.shareBalance)
    throw new Error("A positive available SHARE amount is required.");
  const snapshotClient = stickySnapshotClient(client, state, state.account);
  // Keep the SDK hook-aware preview, then simulate the exact terminal call to include fee exceptions.
  await getHookAwareCashOutQuote(snapshotClient, {
    chainId: state.chainId,
    projectId: state.stickyProjectId,
    terminal: state.terminal,
    holder: state.account,
    beneficiary: state.account,
    cashOutCount: shares,
    tokenToReclaim: state.fundToken,
    slippageBps: 100n,
  });
  const request = buildCashOutTx({
    chainId: state.chainId,
    projectId: state.stickyProjectId,
    terminal: state.terminal,
    holder: state.account,
    beneficiary: state.account,
    cashOutCount: shares,
    tokenToReclaim: state.fundToken,
    minTokensReclaimed: 0n,
    metadata: "0x",
  });
  const result = await snapshotClient.simulateContract({
    ...request,
    account: state.account,
  } as never);
  if (typeof result.result !== "bigint")
    throw new Error("The terminal returned an invalid FUND reclaim quote.");
  return { fund: result.result, minimumFund: stickyMinimum(result.result) };
}

const stickyDeploymentHints = new WeakMap<PublicClient, Map<string, Hex>>();
/** Event history locates the immutable launch; the receipt and headers still verify every cached hint. */
async function originalStickyRewardToken(
  client: PublicClient,
  allocation: InitialIncomeAllocationState,
) {
  const key = `${allocation.chainId}:${allocation.deployer}:${allocation.fundProjectId}:${allocation.incomeProjectId}:${allocation.vault}`;
  let transactionHash = stickyDeploymentHints.get(client)?.get(key);
  if (!transactionHash) {
    const event = getAbiItem({
      abi: homerunIncomeDeployerAbi,
      name: "IncomeDeployed",
    });
    // Launch follows the immutable snapshot. Small windows also work with RPC
    // providers that restrict log ranges. This is bounded and fails explicitly.
    let fromBlock = allocation.snapshotBlockNumber + 1n;
    for (
      let window = 0;
      fromBlock <= allocation.blockNumber && window < 512;
      window++
    ) {
      const toBlock =
        fromBlock + 9_998n < allocation.blockNumber
          ? fromBlock + 9_998n
          : allocation.blockNumber;
      const logs = await client.getLogs({
        address: allocation.deployer,
        event,
        args: {
          fundProjectId: allocation.fundProjectId,
          incomeProjectId: allocation.incomeProjectId,
        },
        fromBlock,
        toBlock,
        strict: true,
      });
      if (logs.length > 1)
        throw new Error(
          "The INCOME launcher returned conflicting deployment events.",
        );
      if (logs.length) {
        const log = logs[0];
        if (
          log.removed ||
          !log.transactionHash ||
          log.blockNumber === null ||
          log.blockNumber < fromBlock ||
          log.blockNumber > toBlock ||
          !isAddressEqual(log.address, allocation.deployer)
        )
          throw new Error("The INCOME deployment event is not canonical.");
        transactionHash = log.transactionHash;
        break;
      }
      fromBlock = toBlock + 1n;
    }
    if (!transactionHash)
      throw new Error(
        "The original INCOME deployment event could not be found within the supported history range. No Sticky target was inferred from current splits.",
      );
  }
  try {
    const receipt = await client.getTransactionReceipt({
      hash: transactionHash,
    });
    if (
      receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      receipt.status !== "success" ||
      receipt.blockNumber <= allocation.snapshotBlockNumber ||
      receipt.blockNumber > allocation.blockNumber
    )
      throw new Error(
        "The original INCOME deployment receipt is not valid for this snapshot.",
      );
    const events = receipt.logs.flatMap((log) => {
      if (!isAddressEqual(log.address, allocation.deployer)) return [];
      try {
        const decoded = decodeEventLog({
          abi: homerunIncomeDeployerAbi,
          eventName: "IncomeDeployed",
          data: log.data,
          topics: log.topics,
        });
        return decoded.args.fundProjectId === allocation.fundProjectId &&
          decoded.args.incomeProjectId === allocation.incomeProjectId
          ? [decoded.args]
          : [];
      } catch {
        return [];
      }
    });
    if (
      events.length !== 1 ||
      !isAddressEqual(events[0].initialAllocationVault, allocation.vault) ||
      events[0].merkleRoot.toLowerCase() !==
        allocation.merkleRoot.toLowerCase() ||
      isAddressEqual(events[0].rewardToken, zeroAddress)
    )
      throw new Error(
        "The INCOME deployment does not match its immutable FUND allocation and SHARE binding.",
      );
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (
      block.number !== receipt.blockNumber ||
      block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()
    )
      throw new Error(
        "The original INCOME deployment is no longer in the canonical chain.",
      );
    if (!stickyDeploymentHints.has(client))
      stickyDeploymentHints.set(client, new Map());
    stickyDeploymentHints.get(client)!.set(key, transactionHash);
    return {
      shareToken: events[0].rewardToken,
      fundToken: events[0].fundToken,
    };
  } catch (error) {
    stickyDeploymentHints.get(client)?.delete(key);
    throw error;
  }
}

/** Recover the original SHARE pool even after INCOME stops funding it. */
export async function readIncomeStickyBinding(
  client: PublicClient,
  input: { chainId: JBChainId; fundProjectId: bigint; incomeProjectId: bigint },
): Promise<{
  stickyProjectId: bigint;
  shareToken: Address;
  blockNumber: bigint;
} | null> {
  const allocation = await readInitialIncomeAllocation(client, input);
  if (!allocation) return null;
  const { chainId, fundProjectId } = input,
    { blockNumber, blockHash } = allocation;
  const { shareToken, fundToken } = await originalStickyRewardToken(
    client,
    allocation,
  );
  const stickyProjectId = await client.readContract({
    address: shareToken,
    abi: stickyTokenAbi,
    functionName: "PROJECT_ID",
    blockNumber,
  });
  const pinned = {
    ...client,
    getBlock: ((parameters) =>
      client.getBlock({
        ...parameters,
        blockTag: undefined,
        blockNumber,
      } as never)) as PublicClient["getBlock"],
  } as PublicClient;
  // Discovering custody does not depend on ongoing reward funding or the
  // connected wallet having any unclaimed rounds. Those are separate reads.
  const state = await readStickyProjectState(pinned, {
    chainId,
    fundProjectId,
    stickyProjectId,
  });
  if (
    !isAddressEqual(state.shareToken, shareToken) ||
    !isAddressEqual(state.fundToken, fundToken) ||
    state.blockNumber !== blockNumber ||
    state.blockHash !== blockHash
  )
    throw new Error(
      "The original INCOME deployment does not resolve to this FUND’s verified SHARE token.",
    );
  const block = await client.getBlock({ blockNumber });
  if (block.hash !== blockHash)
    throw new Error(
      "The chain changed while recovering the original SHARE pool.",
    );
  return { stickyProjectId, shareToken, blockNumber };
}
