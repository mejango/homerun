"use client";
import type { FundProjectState } from "@/lib/fund-state";
import {
  readFundBridgeRoute,
  readFundBridgePrepareQuote,
  buildFundBridgeApproval,
  buildFundBridgePrepare,
} from "@/lib/fund-bridge";
import {
  ProjectBridgeActions,
  type ProjectBridgeAdapter,
} from "./ProjectBridgeActions";
const adapter: ProjectBridgeAdapter<FundProjectState> = {
  tokenLabel: "FUND",
  description:
    "Move FUND and its treasury backing to another linked project. Prepare the move, relay it, then claim on the destination. Your FUND stays unstaked.",
  readRoute: readFundBridgeRoute,
  readQuote: readFundBridgePrepareQuote,
  approval: buildFundBridgeApproval,
  prepare: buildFundBridgePrepare,
};
export function FundBridgeActions({ state }: { state: FundProjectState }) {
  return <ProjectBridgeActions state={state} adapter={adapter} />;
}
