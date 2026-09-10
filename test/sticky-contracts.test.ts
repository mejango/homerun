import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jbContractAddress, type JBChainId } from "@bananapus/nana-sdk-core";
import { v6Address } from "@bananapus/nana-sdk-core/v6";
import {
  decodeFunctionData,
  encodeFunctionData,
  zeroAddress,
  type Address,
} from "viem";
import {
  buildStickyApproval,
  buildStickyCreditClaim,
  buildStickyRewardClaim,
  buildStickyStake,
  buildStickyUnstake,
  registeredStickyContract,
  stickyMinimum,
  type StickyIdentity,
} from "../src/lib/sticky-contracts";

const DEPLOYER = "0x1111111111111111111111111111111111111111",
  FUND = "0x2222222222222222222222222222222222222222",
  SHARE = "0x3333333333333333333333333333333333333333",
  HOLDER = "0x4444444444444444444444444444444444444444",
  DISTRIBUTOR = "0x5555555555555555555555555555555555555555";
const registry = jbContractAddress["6"] as Record<
  string,
  Partial<Record<JBChainId, Address>>
>;
const priorSticky = registry.JBStickyDeployer,
  priorDistributor = registry.JBTokenDistributor;
const identity: StickyIdentity = {
  chainId: 1,
  fundProjectId: 7n,
  stickyProjectId: 9n,
  deployer: DEPLOYER,
  fundToken: FUND,
  shareToken: SHARE,
  terminal: v6Address("JBMultiTerminal", 1),
};
beforeEach(() => {
  registry.JBStickyDeployer = { 1: DEPLOYER };
  registry.JBTokenDistributor = { 1: DISTRIBUTOR };
});
afterEach(() => {
  if (priorSticky) registry.JBStickyDeployer = priorSticky;
  else delete registry.JBStickyDeployer;
  if (priorDistributor) registry.JBTokenDistributor = priorDistributor;
  else delete registry.JBTokenDistributor;
});
function decoded(request: ReturnType<typeof buildStickyStake>) {
  return decodeFunctionData({
    abi: request.abi,
    data: encodeFunctionData({
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
    }),
  });
}

describe("Sticky transaction targets and limits", () => {
  it("does not substitute simulated or caller-provided addresses for a missing registry entry", () => {
    delete registry.JBStickyDeployer;
    expect(registeredStickyContract(1, "JBStickyDeployer")).toBeNull();
    expect(() => buildStickyStake(identity, HOLDER, 10n, 9n)).toThrow(
      /verified Sticky/,
    );
  });
  it("rejects a foreign terminal, unregistered factory, aliased projects and tokens", () => {
    for (const fields of [
      { terminal: HOLDER },
      { deployer: HOLDER },
      { stickyProjectId: 7n },
      { fundProjectId: 0n },
      { shareToken: FUND },
      { fundToken: zeroAddress },
    ])
      expect(() =>
        buildStickyStake({ ...identity, ...fields }, HOLDER, 10n, 9n),
      ).toThrow();
  });
  it("claims FUND credits to the same holder, separate from SHARE issuance", () => {
    const request = buildStickyCreditClaim(identity, HOLDER, 100n);
    expect(request.address).toBe(v6Address("JBController", 1));
    expect(decoded(request).args).toEqual([HOLDER, 7n, 100n, HOLDER]);
  });
  it("uses exact approval, explicit nonzero reset, and skips only an identical allowance", () => {
    expect(buildStickyApproval(identity, 0n, 100n)?.args).toEqual([
      identity.terminal,
      100n,
    ]);
    expect(buildStickyApproval(identity, 90n, 100n)?.args).toEqual([
      identity.terminal,
      0n,
    ]);
    expect(buildStickyApproval(identity, 101n, 100n)?.args).toEqual([
      identity.terminal,
      0n,
    ]);
    expect(buildStickyApproval(identity, 100n, 100n)).toBeNull();
  });
  it("stakes FUND into the Sticky project with a protected SHARE minimum and empty user metadata", () => {
    const request = buildStickyStake(identity, HOLDER, 100n, 97n);
    expect(request.address).toBe(identity.terminal);
    expect(decoded(request).args).toEqual([
      9n,
      FUND,
      100n,
      HOLDER,
      97n,
      "Stake FUND for Homerun SHARE",
      "0x",
    ]);
  });
  it("unstakes SHARE for protected FUND, never burning the original FUND project", () => {
    expect(
      decoded(buildStickyUnstake(identity, HOLDER, 100n, 93n)).args,
    ).toEqual([HOLDER, 9n, 100n, FUND, 93n, HOLDER, "0x"]);
    expect(() => buildStickyUnstake(identity, HOLDER, 100n, 0n)).toThrow(
      /positive/,
    );
  });
  it("encodes reward hook as SHARE and token ID as the holder address", () => {
    const request = buildStickyRewardClaim(identity, HOLDER, FUND, true);
    expect(request.address).toBe(DISTRIBUTOR);
    expect(decoded(request).args).toEqual([
      SHARE,
      [BigInt(HOLDER)],
      [FUND],
      HOLDER,
    ]);
    expect(
      decoded(buildStickyRewardClaim(identity, HOLDER, FUND, false))
        .functionName,
    ).toBe("beginVesting");
    delete registry.JBTokenDistributor;
    expect(() => buildStickyRewardClaim(identity, HOLDER, FUND, true)).toThrow(
      /distributor/,
    );
  });
  it("never rounds positive quotes down to an unprotected zero minimum", () => {
    expect(stickyMinimum(100n)).toBe(99n);
    expect(stickyMinimum(1n)).toBe(1n);
    for (const value of [0n, -1n, 1n << 256n])
      expect(() => stickyMinimum(value)).toThrow();
    expect(() => stickyMinimum(100n, 10_000n)).toThrow();
  });
});
