import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, type Address } from "viem";
import type { TxRequest, TxSendOptions } from "../src/hooks/useSafeTx";
import { jbV6ContractAddress, type JBChainId } from "@bananapus/nana-sdk-core";
import { v6Address } from "@bananapus/nana-sdk-core/v6";
import { StickyHolder } from "../src/components/StickyHolder";
import {
  readStickyProjectState,
  readStickyRewards,
  quoteStickyStake,
  quoteStickyUnstake,
  type StickyProjectState,
} from "../src/lib/sticky-state";
import { readStickyPending, stickyIntent, stickySessionKey } from "../src/lib/sticky-session";
import { installRecoveryLocks } from "./runtime/write-recovery-fixture";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  track: vi.fn(),
  client: {} as Record<string, unknown>,
  phase: "idle",
  receipt: null as null | { status: string; transactionHash: string; blockNumber: bigint },
}));
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    address: "0x1111111111111111111111111111111111111111",
    isConnected: true,
  }),
}));
vi.mock("wagmi", () => ({ usePublicClient: () => mocks.client }));
vi.mock("@/providers/Providers", () => ({ wagmiConfig: {} }));
vi.mock("@/hooks/useSafeTx", () => ({
  useSafeTx: () => ({
    send: mocks.send,
    track: mocks.track,
    phase: mocks.phase,
    busy: false,
    hash: mocks.receipt?.transactionHash ?? null,
    safeProposalHash: null,
    receipt: mocks.receipt,
    error: null,
  }),
  txPhaseLabel: (_: unknown, labels: { idle: string }) => labels.idle,
}));
vi.mock("@/lib/sticky-state", () => ({
  readStickyProjectState: vi.fn(),
  readStickyRewards: vi.fn(),
  quoteStickyStake: vi.fn(),
  quoteStickyUnstake: vi.fn(),
}));

const HOLDER = "0x1111111111111111111111111111111111111111",
  FUND = "0x2222222222222222222222222222222222222222",
  TERMINAL = v6Address("JBMultiTerminal", 1),
  SHARE = "0x3333333333333333333333333333333333333333",
  DEPLOYER = "0x4444444444444444444444444444444444444444";
const registry = jbV6ContractAddress as Record<
  string,
  Partial<Record<JBChainId, Address>>
>;
const oldFactory = registry.StickyDeployer;
const state = {
  chainId: 1,
  fundProjectId: 7n,
  stickyProjectId: 9n,
  blockNumber: 100n,
  blockTimestamp: 1800000000n,
  account: HOLDER,
  fundToken: FUND,
  shareToken: SHARE,
  deployer: DEPLOYER,
  terminal: TERMINAL,
  controller: v6Address("JBController", 1),
  hook: DEPLOYER,
  feed: DEPLOYER,
  fundBalance: 2n * 10n ** 18n,
  fundCreditBalance: 0n,
  shareBalance: 0n,
  allowance: 0n,
  cashOutTaxRate: 0n,
  soulbound: true,
  streakStart: 0n,
  longestStreak: 0n,
  trancheCount: 0n,
  trancheStart: 0n,
  tranches: [],
  rewards: null,
  rewardIssue: null,
} as StickyProjectState;
let root: Root, element: HTMLDivElement, cache: QueryClient;
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function mount(incomeProjectId?: bigint) {
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(StickyHolder, {
          chainId: 1,
          fundProjectId: 7n,
          stickyProjectId: 9n,
          incomeProjectId,
        }),
      ),
    ),
  );
  await settle();
  await settle();
}
beforeEach(() => {
  localStorage.clear();
  installRecoveryLocks();
  registry.StickyDeployer = { 1: DEPLOYER };
  vi.clearAllMocks();
  mocks.client = {};
  mocks.phase = "idle";
  mocks.receipt = null;
  vi.mocked(readStickyProjectState).mockResolvedValue(state);
  vi.mocked(quoteStickyStake).mockResolvedValue({
    shares: 10n ** 18n,
    minimumShares: 99n * 10n ** 16n,
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  if (oldFactory) registry.StickyDeployer = oldFactory;
  else delete registry.StickyDeployer;
  await act(async () => root.unmount());
  cache.clear();
  element.remove();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "locks");
});
describe("Sticky holder recovery and independent loading", () => {
  it("adopts a transaction the journal saved before SDK holds into its hold, and shows it in its action's panel", async () => {
    const key = stickySessionKey(1, 9n, HOLDER);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [TERMINAL, 10n ** 18n] });
    localStorage.setItem(key, JSON.stringify({
      version: 1, id: "11111111-1111-4111-8111-111111111111", chainId: 1, projectId: "9", holder: HOLDER, target: FUND, data, value: "0",
      label: "Approve FUND", safe: true, submittedAt: 1_800_000_000_000, afterBlock: "99", hash: `0x${"ab".repeat(32)}`,
    }));
    // Its Safe proposal can't be read here: the SDK holds it (the exit comes with time), never sends it.
    mocks.client = { getChainId: async () => 1 };
    await mount();
    await vi.waitFor(() => expect(readStickyPending(localStorage, key)).toBeNull());
    expect(element.textContent).not.toContain("Saved transaction");
    // The adopted action is shown in its panel, once.
    expect(mocks.track).toHaveBeenCalledOnce();
    expect(mocks.track.mock.calls[0][0]).toMatchObject({ address: FUND, functionName: "approve", args: [getAddress(TERMINAL), 10n ** 18n] });
    expect(mocks.track.mock.calls[0][1]).toEqual({ reviewedAccount: HOLDER, recoveryNamespace: stickyIntent(9n, "approve"), safe: true });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("renders balances and staking controls while reward history is still loading", async () => {
    vi.mocked(readStickyRewards).mockReturnValue(new Promise(() => {}));
    await mount(11n);
    expect(element.textContent).toContain("Reading completed reward rounds");
    expect(element.textContent).toContain("FUND available to stake");
    const max = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Use available FUND",
    )!;
    expect(max.disabled).toBe(false);
    await act(async () => max.click());
    await settle();
    await settle();
    expect(quoteStickyStake).toHaveBeenCalled();
    expect(
      [...element.querySelectorAll("button")].find(
        (button) => button.textContent === "Review FUND approval",
      )?.disabled,
    ).toBe(false);
  });
  it("offers a credit claim before requesting a stake quote for a credits-only holder", async () => {
    vi.mocked(readStickyProjectState).mockResolvedValue({
      ...state,
      fundBalance: 0n,
      fundCreditBalance: 2n * 10n ** 18n,
    });
    await mount();
    const max = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Use available FUND",
    )!;
    await act(async () => max.click());
    await settle();
    const claim = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Review credit claim",
    )!;
    expect(claim.disabled).toBe(false);
    expect(quoteStickyStake).not.toHaveBeenCalled();
    await act(async () => claim.click());
    expect(mocks.send).toHaveBeenCalledOnce();
    // Held under the claim's own intent while unresolved, not its amount.
    expect(mocks.send.mock.calls[0][1].recoveryNamespace).toBe(stickyIntent(9n, "claimTokensFor"));
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      functionName: "claimTokensFor",
      args: [HOLDER, 7n, 2n * 10n ** 18n, HOLDER],
    });
  });
  it("keeps full unstaking reachable while reward history is unavailable and returns FUND, not treasury currency", async () => {
    vi.mocked(readStickyProjectState).mockResolvedValue({
      ...state,
      shareBalance: 2n * 10n ** 18n,
    });
    vi.mocked(readStickyRewards).mockReturnValue(new Promise(() => {}));
    vi.mocked(quoteStickyUnstake).mockResolvedValue({
      fund: 2n * 10n ** 18n,
      minimumFund: 198n * 10n ** 16n,
    });
    await mount(11n);
    const max = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Use full SHARE balance",
    )!;
    await act(async () => max.click());
    await settle();
    await settle();
    const unstake = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Review unstake",
    )!;
    expect(unstake.disabled).toBe(false);
    await act(async () => unstake.click());
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      functionName: "cashOutTokensOf",
      args: [
        HOLDER,
        9n,
        2n * 10n ** 18n,
        FUND,
        198n * 10n ** 16n,
        HOLDER,
        "0x",
      ],
    });
    expect(element.textContent).toContain(
      "does not cash out FUND for treasury money",
    );
  });
  it("says how far a stake fell under its minimum when the terminal refuses it", async () => {
    vi.mocked(readStickyProjectState).mockResolvedValue({ ...state, allowance: 10n ** 18n });
    // JBMultiTerminal_UnderMin(0.98 SHARE, 0.99 SHARE) as revert data.
    const underMin = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [98n * 10n ** 16n, 99n * 10n ** 16n],
    ).replace("0x", "0x6b2bb382");
    mocks.send.mockImplementation(async (_request: TxRequest, options: TxSendOptions) => {
      options.onFailure?.(underMin);
      return null;
    });
    await mount();
    const field = [...element.querySelectorAll("label")].find((label) =>
      label.textContent?.startsWith("FUND to stake"),
    )!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "1");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const stake = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Review stake",
    )!;
    await act(async () => stake.click());
    await settle();
    expect(element.textContent).toContain(
      "This stake would return 0.98 SHARE, under its 0.99 SHARE minimum. Refresh the quote and try again.",
    );
  });
});
