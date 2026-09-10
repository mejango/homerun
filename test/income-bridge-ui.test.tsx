import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Address } from "viem";
import type { IncomeBridgeRoute } from "../src/lib/income-bridge";

const runtime = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111" as Address | undefined,
  route: null as IncomeBridgeRoute | null,
  identityAvailable: true,
  identityError: false,
  routeAvailable: true,
  routeError: false,
  historyError: false,
  mounted: 0,
  unmounted: 0,
  identities: [] as boolean[],
  cache: { invalidateQueries: vi.fn() },
  refetch: vi.fn(),
}));
vi.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    address: runtime.address,
    isConnected: !!runtime.address,
  }),
}));
vi.mock("@/hooks/useSafeTx", () => ({
  txPhaseLabel: (_phase: string, labels: { idle: string }) => labels.idle,
  useSafeTx: () => {
    useEffect(() => {
      runtime.mounted++;
      return () => {
        runtime.unmounted++;
      };
    }, []);
    return {
      phase: "pending",
      busy: true,
      error: null,
      hash: null,
      safeProposalHash: null,
      receipt: null,
      isSafe: false,
      send: vi.fn(),
      reset: vi.fn(),
    };
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => runtime.cache,
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    if (options.queryKey[1] === "identity") {
      runtime.identities.push(!!options.enabled);
      return {
        data:
          options.enabled && runtime.identityAvailable
            ? runtime.route!.source
            : undefined,
        isError: runtime.identityError,
        isFetching: false,
        error: new Error("Finalized graph unavailable"),
        refetch: runtime.refetch,
      };
    }
    if (options.queryKey[1] === "route")
      return {
        data:
          options.enabled && runtime.routeAvailable ? runtime.route : undefined,
        isError: runtime.routeError,
        isFetching: false,
        error: new Error("Route unavailable"),
        refetch: runtime.refetch,
      };
    if (options.queryKey[1] === "movements")
      return {
        data: runtime.historyError
          ? undefined
          : { route: runtime.route, movements: [] },
        isError: runtime.historyError,
        error: new Error("Missing destination root proof"),
        isPending: false,
        isFetching: false,
        refetch: runtime.refetch,
      };
    return { data: undefined, isError: false, isFetching: false };
  },
}));
import { IncomeBridgeActions } from "../src/components/IncomeBridgeActions";
let host: HTMLDivElement;
let root: Root;
function makeRoute(): IncomeBridgeRoute {
  const source = {
    chainId: 8453,
    projectId: 17n,
    account: runtime.address,
    blockNumber: 10n,
    creditBalance: 5n,
    erc20Balance: 0n,
    linkedPeers: [{ chainId: 10 }],
    accountingContexts: [
      {
        token: "0x4444444444444444444444444444444444444444",
        symbol: "USDC",
        decimals: 6,
      },
    ],
  };
  const destination = { ...source, chainId: 10, projectId: 9n };
  return {
    source,
    destination,
    sourceSucker: "0x2222222222222222222222222222222222222222",
    destinationSucker: "0x3333333333333333333333333333333333333333",
    sourceToken: "0x4444444444444444444444444444444444444444",
    destinationToken: "0x5555555555555555555555555555555555555555",
    sourceContext: { symbol: "USDC", decimals: 6 },
    destinationContext: { symbol: "USDC", decimals: 6 },
    canPrepare: false,
    prepareIssue: "Claim INCOME credits as ERC20 tokens before bridging.",
    transport: "ccip",
    baseFee: 1n,
  } as unknown as IncomeBridgeRoute;
}
async function render() {
  await act(async () => {
    root.render(<IncomeBridgeActions state={runtime.route!.source} />);
  });
}
async function discover() {
  await act(async () => {
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Find linked chains")!
      .click();
  });
}
beforeEach(() => {
  runtime.address = "0x1111111111111111111111111111111111111111";
  runtime.route = makeRoute();
  runtime.identityAvailable = true;
  runtime.identityError = false;
  runtime.routeAvailable = true;
  runtime.routeError = false;
  runtime.historyError = false;
  runtime.mounted = 0;
  runtime.unmounted = 0;
  runtime.identities = [];
  runtime.refetch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});
it("defers expensive graph discovery and opens the verified INCOME workflow on demand", async () => {
  await render();
  expect(runtime.identities.every((value) => !value)).toBe(true);
  expect(runtime.mounted).toBe(0);
  await discover();
  expect(runtime.identities.at(-1)).toBe(true);
  expect(runtime.mounted).toBe(6);
  expect(host.textContent).toContain("Incoming INCOME");
  expect(host.textContent).toContain("Outgoing INCOME");
  expect(host.textContent).toContain("local loan accounting");
  expect(host.textContent).not.toContain("FUND");
});
it("retains every pending tracker through wallet changes and disables stale-wallet actions", async () => {
  await render();
  await discover();
  runtime.address = "0x9999999999999999999999999999999999999999";
  runtime.identityAvailable = false;
  runtime.routeAvailable = false;
  await render();
  expect(runtime.mounted).toBe(6);
  expect(runtime.unmounted).toBe(0);
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
});
it("preserves tracking after graph verification fails and leaves an accessible retry outside the disabled controls", async () => {
  await render();
  await discover();
  runtime.identityAvailable = false;
  runtime.identityError = true;
  await render();
  expect(runtime.unmounted).toBe(0);
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  )!;
  expect(retry.closest("fieldset")).toBeNull();
  await act(async () => retry.click());
  expect(runtime.refetch).toHaveBeenCalledOnce();
});
it("keeps incoming proof failures explicit and exposes no claim action", async () => {
  runtime.historyError = true;
  await render();
  await discover();
  expect(host.textContent).toContain(
    "Claims remain unavailable until the destination proof can be verified",
  );
  expect(
    [...host.querySelectorAll("button")].some((button) =>
      /Review destination claim/.test(button.textContent ?? ""),
    ),
  ).toBe(false);
});
it("collapsing a discovered workflow leaves submitted transaction trackers mounted", async () => {
  await render();
  await discover();
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click(),
  );
  expect(runtime.unmounted).toBe(0);
  expect(
    host.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded"),
  ).toBe("false");
});
