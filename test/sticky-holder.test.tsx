import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erc20Abi, type Address } from "viem";
import { jbContractAddress, type JBChainId } from "@bananapus/nana-sdk-core";
import { v6Address } from "@bananapus/nana-sdk-core/v6";
import { StickyHolder } from "../src/components/StickyHolder";
import {
  readStickyProjectState,
  readStickyRewards,
  quoteStickyStake,
  quoteStickyUnstake,
  type StickyProjectState,
} from "../src/lib/sticky-state";
import {
  beginStickySubmission,
  stickySessionKey,
} from "../src/lib/sticky-session";

const mocks = vi.hoisted(() => ({ send: vi.fn(), client: {} }));
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
    phase: "idle",
    busy: false,
    hash: null,
    safeProposalHash: null,
    receipt: null,
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
const registry = jbContractAddress["6"] as Record<
  string,
  Partial<Record<JBChainId, Address>>
>;
const oldFactory = registry.JBStickyDeployer;
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
  registry.JBStickyDeployer = { 1: DEPLOYER };
  vi.clearAllMocks();
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
  if (oldFactory) registry.JBStickyDeployer = oldFactory;
  else delete registry.JBStickyDeployer;
  await act(async () => root.unmount());
  cache.clear();
  element.remove();
  localStorage.clear();
});
describe("Sticky holder recovery and independent loading", () => {
  it("keeps an unknown wallet submission locked after remount", async () => {
    const key = stickySessionKey(1, 9n, HOLDER);
    beginStickySubmission(
      localStorage,
      key,
      {
        chainId: 1,
        address: FUND,
        abi: erc20Abi,
        functionName: "approve",
        args: [TERMINAL, 10n ** 18n],
      },
      9n,
      HOLDER,
      false,
      "Approve FUND",
      99n,
    );
    await mount();
    expect(element.textContent).toContain("Wallet submission may have started");
    const max = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Use available FUND",
    )!;
    expect(max.disabled).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(element);
    await mount();
    expect(element.textContent).toContain("Saved transaction");
    expect(
      [...element.querySelectorAll("button")].find(
        (button) => button.textContent === "Use available FUND",
      )?.disabled,
    ).toBe(true);
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
});
