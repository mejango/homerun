/** Native adapters for the canonical JBSticky sources. No predicted deployment is a write target. */
import { jbContractAddress, type JBChainId } from "@bananapus/nana-sdk-core";
import {
  buildClaimTokensTx,
  buildPayTx,
  buildCashOutTx,
  v6Address,
} from "@bananapus/nana-sdk-core/v6";
import {
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import type { FundTransaction } from "./fund-contracts";

export const stickyDeployerAbi = parseAbi([
  "function CONTROLLER() view returns (address)",
  "function HOOK() view returns (address)",
  "function TERMINAL() view returns (address)",
  "function TOKENS() view returns (address)",
  "function stakedTokenOf(uint256 projectId) view returns (address)",
  "function cashOutTaxRateOf(uint256 projectId) view returns (uint256)",
  "function priceFeedOf(uint256 projectId) view returns (address)",
]);
export const stickyHookAbi = parseAbi([
  "function DEPLOYER() view returns (address)",
  "function DIRECTORY() view returns (address)",
  "function tokenOf(uint256 projectId) view returns (address)",
  "function orphanedBalanceOf(uint256 projectId) view returns (uint256)",
  "function stakedBalanceOf(uint256 projectId,address holder) view returns (uint256)",
  "function streakStartOf(uint256 projectId,address holder) view returns (uint256)",
  "function longestStreakOf(uint256 projectId,address holder) view returns (uint256)",
  "function trancheCountOf(uint256 projectId,address holder) view returns (uint256)",
  "function tranchesOf(uint256 projectId,address holder,uint256 start,uint256 count) view returns ((uint208 amount,uint48 timestamp)[])",
]);
export const stickyTokenAbi = parseAbi([
  "function HOOK() view returns (address)",
  "function TOKENS() view returns (address)",
  "function PROJECT_ID() view returns (uint256)",
  "function SOULBOUND() view returns (bool)",
  "function delegates(address holder) view returns (address)",
  "function getVotes(address holder) view returns (uint256)",
  "function getPastVotes(address holder,uint256 blockNumber) view returns (uint256)",
  "function getPastTotalActiveVotes(uint256 blockNumber) view returns (uint256)",
  "function clock() view returns (uint48)",
  "function CLOCK_MODE() view returns (string)",
]);
export const stickyDistributorAbi = parseAbi([
  "function DIRECTORY() view returns (address)",
  "function CONTROLLER() view returns (address)",
  "function REV_LOANS() view returns (address)",
  "function REV_OWNER() view returns (address)",
  "function ROUND_DURATION() view returns (uint256)",
  "function VESTING_ROUNDS() view returns (uint256)",
  "function CLAIM_DURATION() view returns (uint48)",
  "function currentRound() view returns (uint256)",
  "function roundStartTimestamp(uint256 round) view returns (uint256)",
  "function roundSnapshotBlock(uint256 round) view returns (uint256)",
  "function nextClaimRoundOf(address hook,uint256 groupId,uint256 tokenId,address token) view returns (uint256)",
  "function activeVestingLoanIdOf(address hook,uint256 groupId,uint256 tokenId,address token) view returns (uint256)",
  "function rewardRoundOf(address hook,uint256 groupId,address token,uint256 round) view returns ((uint208 amount,uint48 snapshotBlock,uint208 claimedAmount,uint48 claimDeadline,uint208 totalStake))",
  "function collectableFor(address hook,uint256 tokenId,address token) view returns (uint256)",
  "function claimedFor(address hook,uint256 tokenId,address token) view returns (uint256)",
  "function beginVesting(address hook,uint256[] tokenIds,address[] tokens)",
  "function collectVestedRewards(address hook,uint256[] tokenIds,address[] tokens,address beneficiary)",
]);

/** Verified SDK records only. Sticky deployment simulation files are intentionally excluded. */
export function registeredStickyContract(
  chainId: JBChainId,
  name: "JBStickyDeployer" | "JBTokenDistributor",
): Address | null {
  const value = (
    jbContractAddress["6"] as Record<
      string,
      Partial<Record<JBChainId, Address>>
    >
  )[name]?.[chainId];
  return value && isAddress(value) && !isAddressEqual(value, zeroAddress)
    ? getAddress(value)
    : null;
}

export type StickyIdentity = {
  chainId: JBChainId;
  fundProjectId: bigint;
  stickyProjectId: bigint;
  deployer: Address;
  fundToken: Address;
  shareToken: Address;
  terminal: Address;
};
export function assertStickyIdentity(state: StickyIdentity): void {
  if (
    state.fundProjectId <= 0n ||
    state.stickyProjectId <= 0n ||
    state.fundProjectId === state.stickyProjectId
  )
    throw new Error(
      "Distinct positive FUND and Sticky project IDs are required.",
    );
  const registered = registeredStickyContract(
    state.chainId,
    "JBStickyDeployer",
  );
  if (!registered || !isAddressEqual(registered, state.deployer))
    throw new Error(
      "No verified Sticky deployment is registered for this project.",
    );
  if (
    !isAddressEqual(state.terminal, v6Address("JBMultiTerminal", state.chainId))
  )
    throw new Error("The Sticky terminal is not the registered V6 terminal.");
  for (const token of [state.fundToken, state.shareToken])
    if (!isAddress(token) || isAddressEqual(token, zeroAddress))
      throw new Error("Verified FUND and SHARE ERC20 tokens are required.");
  if (isAddressEqual(state.fundToken, state.shareToken))
    throw new Error("FUND and SHARE must be separate tokens.");
}
function holderAddress(holder: Address): void {
  if (!isAddress(holder) || isAddressEqual(holder, zeroAddress))
    throw new Error("A valid holder address is required.");
}
function positive(amount: bigint): void {
  if (typeof amount !== "bigint" || amount <= 0n || amount >= 1n << 256n)
    throw new Error("A positive uint256 amount is required.");
}
export function stickyMinimum(quote: bigint, slippageBps = 100n): bigint {
  positive(quote);
  if (slippageBps < 0n || slippageBps >= 10_000n)
    throw new Error("Invalid slippage tolerance.");
  const minimum = (quote * (10_000n - slippageBps)) / 10_000n;
  return minimum > 0n ? minimum : 1n;
}
export function buildStickyCreditClaim(
  state: StickyIdentity,
  holder: Address,
  amount: bigint,
): FundTransaction {
  assertStickyIdentity(state);
  holderAddress(holder);
  positive(amount);
  return buildClaimTokensTx({
    chainId: state.chainId,
    projectId: state.fundProjectId,
    holder,
    beneficiary: holder,
    tokenCount: amount,
  });
}
/** Each approval is exact. Reset a prior nonzero approval before changing its amount. */
export function buildStickyApproval(
  state: StickyIdentity,
  allowance: bigint,
  amount: bigint,
): FundTransaction | null {
  assertStickyIdentity(state);
  positive(amount);
  if (allowance < 0n || allowance >= 1n << 256n)
    throw new Error("Invalid current allowance.");
  if (allowance === amount) return null;
  return {
    chainId: state.chainId,
    address: state.fundToken,
    abi: erc20Abi,
    functionName: "approve",
    args: [state.terminal, allowance > 0n ? 0n : amount],
  };
}
export function buildStickyStake(
  state: StickyIdentity,
  holder: Address,
  amount: bigint,
  minimumShares: bigint,
): FundTransaction {
  assertStickyIdentity(state);
  holderAddress(holder);
  positive(amount);
  positive(minimumShares);
  return buildPayTx({
    chainId: state.chainId,
    projectId: state.stickyProjectId,
    terminal: state.terminal,
    token: state.fundToken,
    amount,
    beneficiary: holder,
    minReturnedTokens: minimumShares,
    memo: "Stake FUND for Homerun SHARE",
    metadata: "0x",
  });
}
export function buildStickyUnstake(
  state: StickyIdentity,
  holder: Address,
  shares: bigint,
  minimumFund: bigint,
): FundTransaction {
  assertStickyIdentity(state);
  holderAddress(holder);
  positive(shares);
  positive(minimumFund);
  return buildCashOutTx({
    chainId: state.chainId,
    projectId: state.stickyProjectId,
    terminal: state.terminal,
    holder,
    beneficiary: holder,
    cashOutCount: shares,
    tokenToReclaim: state.fundToken,
    minTokensReclaimed: minimumFund,
    metadata: "0x",
  });
}
export function buildStickyRewardClaim(
  state: StickyIdentity,
  holder: Address,
  incomeToken: Address,
  collect: boolean,
): FundTransaction {
  assertStickyIdentity(state);
  holderAddress(holder);
  holderAddress(incomeToken);
  const distributor = registeredStickyContract(
    state.chainId,
    "JBTokenDistributor",
  );
  if (!distributor)
    throw new Error(
      "A verified SHARE reward distributor is not registered on this chain.",
    );
  const args = [state.shareToken, [BigInt(holder)], [incomeToken]] as const;
  return {
    chainId: state.chainId,
    address: distributor,
    abi: stickyDistributorAbi,
    functionName: collect ? "collectVestedRewards" : "beginVesting",
    args: collect ? [...args, holder] : args,
  };
}
