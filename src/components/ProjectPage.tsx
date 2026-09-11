"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import Image from "next/image";
import { Brand } from "./Brand";
import { DEFAULT_NETWORK, projectNetwork } from "../../web/network-model.mjs";
import {
  creationSummary,
  loadCreatedProject,
} from "../../web/create-model.mjs";
import { FIELD_HELP } from "../../web/field-help.mjs";
import { drawAssetSketch } from "../../web/asset-sketch.mjs";
import { payPanelQuote as modelPayPanelQuote } from "../../web/pay-panel.mjs";
import {
  parsePaymentAmount,
  PREVIEW_ETH_USDC_RATE,
  sourceAmountFromUSDC,
} from "../../web/payment-currencies.mjs";
import { demoPaymentResult, fundPaymentLimitError } from "@/lib/demo-payment-result";
import { DemoPaymentResult } from "./DemoPaymentResult";
import { plannedOwnerActionDraft as modelOwnerActionDraft } from "../../web/owner-actions.mjs";
import { SiteIntegration } from "./SiteIntegration";
import { ProjectActionGuide } from "./ProjectActionGuide";
import { HomerunProjectLayout, OwnersTabs } from "./HomerunProjectLayout";
import { DemoProjectShop } from "./DemoProjectShop";
import { DemoActivity } from "./DemoActivity";
import { OperatorProfile } from "./OperatorProfile";
import { FundingProgress } from "./FundingProgress";
import { demoShopStorageKey } from "@/lib/demo-shop";
import {
  BudgetChart,
  CashHistoryChart,
  BorrowingChart,
  OwnershipCharts,
} from "./ProjectCharts";

export type ProjectPhase =
  "raising" | "funded" | "refunding" | "refunded" | "earning" | "liquidated";
type Projection = ReturnType<typeof projectNetwork>;
type NetworkInputs = {
  -readonly [
    Key in keyof typeof DEFAULT_NETWORK
  ]: (typeof DEFAULT_NETWORK)[Key] extends number ? number : string;
};
type CreatedProject = NonNullable<ReturnType<typeof loadCreatedProject>>;
type OwnerDraft = Omit<ReturnType<typeof modelOwnerActionDraft>, "steps"> & {
  steps: { id: string; title: string; description: string }[];
};
const ownerActionDraft = modelOwnerActionDraft as (
  action: string,
  projection: Projection,
) => OwnerDraft;
// The legacy pure JS helpers have no JSDoc for destructured arguments/empty arrays.
// Keep their runtime-validated implementations while declaring the boundary shape.
const payPanelQuote = modelPayPanelQuote as (input: {
  phase: ProjectPhase;
  projection: Projection | null;
  amount: string;
  currency: string;
  contributionError: string;
}) => ReturnType<typeof modelPayPanelQuote>;
const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const tokenNumber = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
const percent = (value: number) => `${number(value)}%`;
const phases: [ProjectPhase, string][] = [
  ["raising", "Raising funds"],
  ["funded", "Raise closed"],
  ["refunding", "Refunding"],
  ["refunded", "Refunds complete"],
  ["earning", "Earning income"],
  ["liquidated", "Asset sold"],
];
const stageNames = ["Fundraise", "Income", "Asset sale"];
const stagePhases: ProjectPhase[] = ["raising", "earning", "liquidated"];
const statusLabels: Record<ProjectPhase, string> = {
  raising: "Fundraising",
  funded: "Raise Closed",
  refunding: "Refunding",
  refunded: "Refunds Complete",
  earning: "Earning Income",
  liquidated: "Asset Sold",
};
const nextStages: Partial<Record<ProjectPhase, [ProjectPhase, string]>> = {
  raising: ["funded", "Preview closed raise"],
  funded: ["earning", "Preview income"],
  earning: ["liquidated", "Preview an asset sale"],
  refunding: ["refunded", "Preview completed refunds"],
};

function demoStateMetadata(
  p: Projection | null,
  phase: ProjectPhase,
): ReactNode[] {
  if (!p) return ["Modeling: Check inputs"];
  const amount = (key: string, value: number, label: string) => (
    <span
      key={key}
      data-header-metric={key}
      title={`${label}: ${money(value)}`}
    >
      {label}:{" "}
      {new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: Math.abs(value) < 1_000 ? 2 : 1,
      }).format(value)}
    </span>
  );
  switch (phase) {
    case "raising":
      return [
        amount("raised", p.raised, "Raised"),
        amount("goal", p.raiseGoal, "Goal"),
        `Funded: ${percent(p.raiseGoal > 0 ? (p.raised / p.raiseGoal) * 100 : 0)}`,
      ];
    case "funded":
      return [
        amount("closing", p.escrowCash, "Ready for closing"),
        amount("raised", p.raised, "Raised"),
      ];
    case "refunding":
      return [
        amount("refundable", p.refundableCash, "Available for refunds"),
        amount("raised", p.raised, "Originally raised"),
      ];
    case "refunded":
      return [
        amount("refunded", p.refundedCash, "Returned"),
        amount("raised", p.raised, "Originally raised"),
      ];
    case "earning":
      return [
        amount("revenue", p.lastMonthRent, "Monthly revenue"),
        amount("income-treasury", p.revCash, "INCOME treasury"),
        `Months earning: ${p.monthsApplied}`,
      ];
    case "liquidated":
      return [
        amount("fund-sale", p.fundSaleCash, "FUND proceeds"),
        amount("income-treasury", p.revCash, "INCOME treasury"),
      ];
  }
}

function download(text: string, filename: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Native dialog keeps focus trapping, Escape dismissal and focus return. */
function Modal({
  children,
  title,
  id,
  onClose,
  className = "",
}: {
  children: ReactNode;
  title: string;
  id: string;
  onClose: () => void;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement as HTMLElement | null;
    element.showModal();
    // React Strict Mode closes and reopens the same dialog during its effect
    // check. Ignore the queued close event from that already-reopened dialog.
    const handleClose = () => {
      if (!element.open) close.current();
    };
    element.addEventListener("close", handleClose);
    return () => {
      element.removeEventListener("close", handleClose);
      element.close();
      trigger?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      id={id}
      ref={dialog}
      className={className}
      aria-labelledby={`${id}-title`}
    >
      <div className="dialog-top">
        <h2 id={`${id}-title`}>{title}</h2>
        <button
          type="button"
          className="quiet-button"
          aria-label={`Close ${title}`}
          onClick={() => dialog.current?.close()}
        >
          Close ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function ProjectJourney({ phase }: { phase: ProjectPhase }) {
  const selected = phase === "earning" ? 1 : phase === "liquidated" ? 2 : 0;
  const failed = phase === "refunding" || phase === "refunded";
  const labels = failed
    ? [phase === "refunding" ? "Refunding" : "Refunded", "Skipped", "Skipped"]
    : phase === "raising"
      ? ["Raising", "Upcoming", "Eventually"]
      : phase === "funded"
        ? ["Raise closed", "Upcoming", "Eventually"]
        : phase === "earning"
          ? ["Complete", "Earning", "Eventually"]
          : ["Complete", "Complete", "Sold"];
  const states = labels.map((label) =>
    label === "Complete" || label === "Sold" || label === "Raise closed"
      ? "complete"
      : label.toLowerCase(),
  );
  states[selected] = failed
    ? phase
    : phase === "funded" || phase === "liquidated"
      ? "complete"
      : "current";
  const description = {
    raising: "Contributions collect before the asset is purchased.",
    funded: "Raise closed. Funds are held until the asset is purchased.",
    earning: "The asset is earning income before an eventual sale.",
    liquidated: "The asset has sold. Net sale proceeds belong to FUND holders.",
    refunding: "The asset was not purchased. Remaining funds can be refunded.",
    refunded: "Refunds are complete. The asset was not purchased.",
  }[phase];
  const points = [
    [110, 151],
    [167.2, 96.76],
    [110, 31.16],
    [52.8, 96.76],
    [110, 151],
  ];
  return (
    <section
      id="project-journey"
      aria-label="Three bases of the project"
      data-journey-phase={phase}
    >
      <div className="pj-journey">
        <div className="pj-scene">
          <svg className="pj-canvas" viewBox="0 0 220 164" aria-hidden="true">
            {points.slice(0, 4).map((point, index) => (
              <line
                key={index}
                x1={point[0]}
                y1={point[1]}
                x2={points[index + 1][0]}
                y2={points[index + 1][1]}
                stroke={
                  failed && index === 0
                    ? "#ab705a"
                    : index <= selected
                      ? "#55764f"
                      : "#cbd0c1"
                }
                strokeWidth={index <= selected ? 1.6 : 1}
                strokeLinecap="round"
              />
            ))}
            <path
              d="M105 147H115V152L110 156L105 152Z"
              fill="#f7f5ef"
              stroke="#a3ae96"
            />
          </svg>
          <div className="pj-stages" role="list" aria-label="Project stages">
            {stageNames.map((label, index) => (
              <div
                key={label}
                role="listitem"
                className="pj-stage"
                data-journey-phase={stagePhases[index]}
                data-journey-status={states[index]}
                aria-current={index === selected ? "step" : undefined}
                aria-label={`${index + 1}. ${label}: ${labels[index]}.`}
              >
                <span className="pj-base" aria-hidden="true">
                  <span className="pj-base-number">
                    {states[index] === "complete"
                      ? "✓"
                      : failed && index === 0
                        ? "×"
                        : index + 1}
                  </span>
                </span>
                <span className="pj-stage-copy">
                  <strong>{label}</strong>
                  <span>{labels[index]}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <p className="pj-description" role="status">
          {description}
        </p>
      </div>
    </section>
  );
}

const photos = [
  {
    src: "/assets/founder-haus/exterior.jpg",
    label: "House & pool",
    alt: "Founder Haus exterior with a pool, garden, palm trees and a covered terrace.",
  },
  {
    src: "/assets/founder-haus/rooftop.jpg",
    label: "Rooftop",
    alt: "A shaded gazebo and seating on the Founder Haus rooftop, overlooking the ocean.",
  },
  {
    src: "/assets/founder-haus/community.jpg",
    label: "Inside the clubhouse",
    alt: "An indoor event at Founder Haus, with people seated for a presentation.",
  },
];

function AssetIllustration({ type }: { type: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const paint = () => drawAssetSketch(element, type);
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(element);
    return () => observer.disconnect();
  }, [type]);
  return <canvas id="created-asset-sketch" ref={canvas} aria-hidden="true" />;
}

function ProjectPhoto({
  name,
  photo,
  demo,
  assetType = "real-estate",
}: {
  name: string;
  photo?: string;
  demo?: boolean;
  assetType?: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  if (!demo)
    return (
      <div className="deal-image created-cover">
        {photo ? (
          <Image
            unoptimized
            src={photo}
            width={1440}
            height={1080}
            alt={`${name} cover photo`}
          />
        ) : (
          <AssetIllustration type={assetType} />
        )}
      </div>
    );
  return (
    <>
      <button
        type="button"
        id="open-house-gallery"
        className="deal-image house-photo-button"
        aria-label="View Founder Haus photos and details"
        aria-haspopup="dialog"
        aria-controls="house-gallery"
        onClick={() => setOpen(true)}
      >
        <Image
          unoptimized
          src={photos[0].src}
          alt={photos[0].alt}
          width={1440}
          height={1080}
        />
        <span>3 photos ↗</span>
      </button>
      {open && (
        <Modal
          id="house-gallery"
          title="Founder Haus"
          className="house-gallery"
          onClose={() => setOpen(false)}
        >
          <p>Jurerê Internacional, Florianópolis, Brazil</p>
          <figure className="house-gallery-photo">
            <Image
              unoptimized
              id="house-gallery-image"
              src={photos[selected].src}
              alt={photos[selected].alt}
              width={1440}
              height={1080}
            />
            <figcaption aria-live="polite">
              {selected + 1} of 3 | {photos[selected].label}
            </figcaption>
          </figure>
          <div
            className="house-photo-picker"
            role="group"
            aria-label="Choose a Founder Haus photo"
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                event.preventDefault();
                const next =
                  (selected + (event.key === "ArrowRight" ? 1 : 2)) % 3;
                setSelected(next);
                (
                  event.currentTarget.children[next] as HTMLButtonElement
                ).focus();
              }
            }}
          >
            {photos.map((item, index) => (
              <button
                type="button"
                key={item.src}
                data-house-photo={index}
                aria-pressed={index === selected}
                onClick={() => setSelected(index)}
              >
                <Image
                  unoptimized
                  src={item.src}
                  alt=""
                  width={144}
                  height={108}
                />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <p>
            A founders’ clubhouse with workspaces, events, a pool and wellness
            activities.
          </p>
          <p className="house-source">
            Photos and venue details from{" "}
            <a
              href="https://founderhaus.club/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Founder Haus ↗
            </a>
            .
          </p>
        </Modal>
      )}
    </>
  );
}

function NumericField({
  name,
  label,
  value,
  onChange,
  onValidityChange,
  min = 0,
  max,
  integer = false,
  currency = false,
  percentage = false,
}: {
  name: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  onValidityChange?: (valid: boolean) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  currency?: boolean;
  percentage?: boolean;
}) {
  const [raw, setRaw] = useState(number(value));
  const [help, setHelp] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!help) return;
    const position = () => {
      if (!root.current || !tip.current) return;
      const box = root.current.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      tip.current.style.width = `${Math.min(288, width - 24)}px`;
      tip.current.style.maxHeight = `${height - 24}px`;
      const size = tip.current.getBoundingClientRect();
      tip.current.style.left = `${Math.max(12, Math.min(box.left, width - size.width - 12))}px`;
      tip.current.style.top = `${Math.max(12, Math.min(box.bottom + size.height + 8 <= height - 12 ? box.bottom + 8 : box.top - size.height - 8, height - size.height - 12))}px`;
    };
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setHelp(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHelp(false);
    };
    position();
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [help]);
  useEffect(() => {
    setRaw(number(value));
    setInvalid(false);
  }, [value]);
  const helpText = (FIELD_HELP as Record<string, string>)[name];
  return (
    <div
      ref={root}
      className="projection-field"
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setHelp(true);
      }}
      onPointerLeave={() => setHelp(false)}
      onFocus={() => setHelp(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHelp(false);
      }}
    >
      <div className="field-label">
        <label htmlFor={`field-${name}`}>{label}</label>
        {helpText && (
          <button
            type="button"
            className="field-help"
            aria-label={`Explain ${label}`}
            aria-expanded={help}
            aria-controls={`help-${name}`}
            onClick={() => setHelp(true)}
          >
            <span aria-hidden="true">?</span>
          </button>
        )}
      </div>
      <div className="field-control">
        {currency && <span aria-hidden="true">$</span>}
        <input
          id={`field-${name}`}
          data-input={name}
          type="text"
          inputMode={integer ? "numeric" : "decimal"}
          value={raw}
          min={min}
          max={max}
          step={integer ? 1 : 0.01}
          aria-invalid={invalid}
          aria-describedby={helpText ? `help-${name}` : undefined}
          onChange={(event) => {
            const text = event.target.value;
            setRaw(text);
            const candidate = Number(text.replaceAll(",", ""));
            const valid =
              /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{0,2})?$/.test(text) &&
              Number.isFinite(candidate) &&
              candidate >= min &&
              (max === undefined || candidate <= max) &&
              (!integer || Number.isInteger(candidate));
            setInvalid(!valid);
            onValidityChange?.(valid);
            if (valid) onChange(candidate);
          }}
          onBlur={() => {
            if (!invalid) setRaw(number(value));
          }}
          required
        />
        {percentage && <span aria-hidden="true">%</span>}
      </div>
      {invalid && (
        <p className="pay-error" role="alert">
          Enter {integer ? "a whole number" : "a number"} from {min}
          {max === undefined ? " or more" : ` to ${max}`}. Fix this value to
          update the preview.
        </p>
      )}
      {helpText && (
        <div
          ref={tip}
          id={`help-${name}`}
          className="field-tooltip"
          role="tooltip"
          hidden={!help}
        >
          {helpText}
        </div>
      )}
    </div>
  );
}

function Metric({
  id,
  label,
  value,
  note,
}: {
  id?: string;
  label: string;
  value: number;
  note?: string;
}) {
  return (
    <div className="state-metric">
      <span>{label}</span>
      <strong id={id}>{money(value)}</strong>
      {note && <p>{note}</p>}
    </div>
  );
}

function Progress({
  current,
  target,
  label,
}: {
  current: number;
  target: number;
  label: string;
}) {
  const value = target > 0 ? Math.min(100, (current / target) * 100) : 100;
  return (
    <div className="scenario-progress">
      <div>
        <span>{label}</span>
        <strong>{percent(value)}</strong>
      </div>
      <div
        id="scenario-progress"
        className="scenario-progress-bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
      >
        <span style={{ width: `${value}%` }} />
      </div>
      <p>
        {money(current)} of {money(target)}
      </p>
    </div>
  );
}

function ReserveStress({
  projection: p,
  inputs,
}: {
  projection: Projection;
  inputs: NetworkInputs;
}) {
  const scenarios = [
    ["Your inputs", {}],
    [
      "Revenue 10% lower",
      { monthlyRent: Math.round(inputs.monthlyRent * 90) / 100 },
    ],
    [
      "Costs 10% higher",
      { monthlyCosts: Math.round(inputs.monthlyCosts * 110) / 100 },
    ],
    [
      "Both, with at least 2.5% fees",
      {
        monthlyRent: Math.round(inputs.monthlyRent * 90) / 100,
        monthlyCosts: Math.round(inputs.monthlyCosts * 110) / 100,
        revCashoutFeePercent: Math.max(2.5, inputs.revCashoutFeePercent),
      },
    ],
  ] as const;
  return (
    <details className="holder-choices" id="reserve-stress">
      <summary>Can the reserve cover operations?</summary>
      <p>
        This tests every month through month {p.diagnosticHorizonMonths}, using
        your asset estimates and token terms.
      </p>
      <div className="stress-table-wrap">
        <table className="stress-table">
          <caption>Operating reserve scenarios</caption>
          <thead>
            <tr>
              <th scope="col">Assumptions</th>
              <th scope="col">Lowest reserve</th>
              <th scope="col">Cost coverage</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map(([label, changes]) => {
              try {
                const result = projectNetwork(
                  { ...inputs, ...changes },
                  "earning",
                );
                return (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td>{money(result.minimumOpsReserveCash)}</td>
                    <td>
                      {result.firstUnfundedMonth === null
                        ? "No unpaid costs"
                        : `Unpaid costs from month ${result.firstUnfundedMonth}`}
                    </td>
                  </tr>
                );
              } catch {
                return (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td colSpan={2}>Outside the supported model range</td>
                  </tr>
                );
              }
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function TokenTerms({ p }: { p: Projection }) {
  return (
    <details className="holder-choices">
      <summary>Modeled token terms</summary>
      <p>
        Each contributed dollar receives 10,000 FUND. After purchase,
        contributors share {percent(100 - p.operatorFundPercent)} of FUND and
        operators hold {percent(p.operatorFundPercent)}. Each FUND has the same
        share of net asset-sale proceeds.
      </p>
      <p>
        At purchase, {number(p.revenuePremint)} INCOME tokens are shared among
        all FUND holders in the same proportions, including inactive ERC20
        balances and unclaimed token credits. This initial claim requires no
        activation, staking or vesting. Ongoing rewards are separate and require
        eligible Sticky staking. Neither token has a promised repayment date.
      </p>
      <dl className="math-values">
        <div>
          <dt>Total asset tokens after purchase</dt>
          <dd id="fund-total-supply">{number(p.fundTotalSupply)}</dd>
        </div>
        <div>
          <dt>Asset tokens for operators</dt>
          <dd id="operator-fund-mint">{number(p.fundOperatorMint)}</dd>
        </div>
        <div>
          <dt>New INCOME per $1 of revenue</dt>
          <dd id="rev-issuance-rate">{number(p.currentIssuanceRate)}</dd>
        </div>
        <div>
          <dt>INCOME currently outstanding</dt>
          <dd id="rev-total-supply">{number(p.revSupply)}</dd>
        </div>
      </dl>
      <p>
        New INCOME per revenue dollar falls {percent(p.issuanceCutPercent)}{" "}
        every {p.issuanceCutMonths} months for {p.issuanceCutYears} years, then
        stays fixed. This model uses the reserve first, then operator cash-outs
        for expenses, and assumes all FUND participates in Sticky with full
        snapshot eligibility and fully vested rewards. Stock Sticky uses
        proportional share-balance snapshots, with four weekly vesting rounds
        starting from the reward-claim round. There is no minimum staking period
        or stake-age bonus. Staying staked longer earns additional rounds. Live
        use requires a verified deployment. Actual loan effects are not
        included.
      </p>
    </details>
  );
}

function Allocation({ p }: { p: Projection }) {
  const items = [
    [p.currentOperatorSplitPercent, "to operators"],
    [p.currentStickySplitPercent, "to FUND stakers"],
    [p.currentRenterSplitPercent, "to customers"],
  ] as const;
  return (
    <figure className="allocation-chart">
      <figcaption>New INCOME tokens are shared</figcaption>
      <div className="allocation-bar" aria-hidden="true">
        {items.map(([value, label]) => (
          <span key={label} style={{ flex: value }} />
        ))}
      </div>
      <div className="issuance-split" id="rev-payment-split">
        {items.map(([value, label]) => (
          <div key={label}>
            <strong>{percent(value)}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <p>
        These percentages divide new tokens. The FUND-staker allocation goes to
        eligible Sticky participants, including operators who stake. Projections
        assume all FUND participates and is eligible at each snapshot with fully
        vested rewards; weekly reward vesting is not modeled.
      </p>
    </figure>
  );
}

function PhasePanel({
  p,
  inputs,
  revenueDescription,
}: {
  p: Projection;
  inputs: NetworkInputs;
  revenueDescription?: string;
}) {
  const phase = p.phase as ProjectPhase;
  const sold = phase === "liquidated";
  const complete = phase === "refunded";
  const titles: Record<ProjectPhase, [string, string]> = {
    raising: [
      "Raise the money.",
      "Buy the asset and set aside cash to run it.",
    ],
    funded: ["Buy the asset.", "The raise is closed. The purchase is next."],
    refunding: [
      "Return the remaining money.",
      "Contributors share the cash left after expenses.",
    ],
    refunded: ["Refunds complete.", "No asset was purchased."],
    earning: [
      "Collect revenue. Pay the bills.",
      "Revenue comes in. Expenses use the cash reserve first, then operator INCOME cash-outs.",
    ],
    liquidated: [
      "Sell the asset. Share the proceeds.",
      "Net sale cash goes to FUND holders.",
    ],
  };
  return (
    <div id="phase-panel" className="phase-panel">
      <div className="phase-copy">
        <h2 id="scenario-title" tabIndex={-1}>
          {titles[phase][0]}
        </h2>
        <p>{titles[phase][1]}</p>
        {phase === "earning" && revenueDescription && (
          <p className="revenue-description">{revenueDescription}</p>
        )}
      </div>
      {phase === "raising" && (
        <>
          <Progress
            label="Fundraising progress"
            current={p.raised}
            target={p.raiseGoal}
          />
          <BudgetChart projection={p} />
        </>
      )}
      {phase === "funded" && (
        <>
          <div className="state-metrics single">
            <Metric
              id="escrow-cash"
              label="Ready for closing"
              value={p.escrowCash}
            />
          </div>
          <BudgetChart projection={p} />
        </>
      )}
      {(phase === "refunding" || phase === "refunded") && (
        <div className="state-metrics single">
          <Metric
            id={complete ? "refunded-cash" : "refundable-cash"}
            label={
              complete ? "Returned to contributors" : "Available for refunds"
            }
            value={complete ? p.refundedCash : p.refundableCash}
          />
        </div>
      )}
      {(phase === "earning" || sold) && (
        <>
          {sold && (
            <div className="state-metrics single">
              <Metric
                id="fund-sale-cash"
                label="For all FUND holders"
                value={p.fundSaleCash}
              />
            </div>
          )}
          <div className="pool-balance">
            <div>
              <span>
                {sold
                  ? "Separate cash for INCOME holders"
                  : "Revenue held for all holders"}
              </span>
              <p>After {p.monthsApplied} months</p>
            </div>
            <strong id="cash-in-pool">{money(p.revCash)}</strong>
          </div>
          {!sold && (
            <div className="reserve-line">
              <span>Reserve left</span>
              <strong id="ops-reserve-cash">{money(p.opsReserveCash)}</strong>
            </div>
          )}
          {p.unpaidOps > 0 && (
            <p className="scenario-caution">
              {money(p.unpaidOps)} of costs remain unpaid. The reserve is
              exhausted.
            </p>
          )}
          <CashHistoryChart projection={p} />
        </>
      )}
      <details id="project-details" className="holder-choices">
        <summary>How the money moves</summary>
        <div>
          {phase === "raising" && (
            <>
              <div className="state-metrics">
                <Metric
                  id="raise-goal"
                  label="Goal, including estimated fees"
                  value={p.raiseGoal}
                />
                <Metric
                  id="escrow-cash"
                  label="Cash still held"
                  value={p.escrowCash}
                />
              </div>
              <p>
                The modeled goal covers the {money(p.purchaseBudget)} purchase,{" "}
                {money(p.opsReserve)} separate operating reserve, purchase
                expenses and an assumed {percent(p.payoutFeePercent)} payout
                fee. These assumptions do not configure withdrawal allowances.
                Failed raises return remaining cash.
              </p>
            </>
          )}
          {phase === "funded" && (
            <>
              <Metric
                id="closing-fee"
                label="Estimated closing fee"
                value={p.closingFeeEstimate}
              />
              <p>
                After purchase, all FUND holders share{" "}
                {number(p.revenuePremint)} initial INCOME, including operators,
                inactive ERC20 balances and unclaimed token credits. Initial
                claims require no activation, staking or vesting. The INCOME
                revnet starts at $0, then receives monthly revenue. FUND remains
                the separate asset claim.
              </p>
            </>
          )}
          {(phase === "refunding" || complete) && (
            <>
              <p>
                Refunds redeem FUND proportionally. There is no cash-out tax,
                operator success mint or INCOME allocation. Expenses can reduce
                recovery; protocol fees may apply. Off-chain contributions are
                refunded off-chain.
              </p>
              <Progress
                label="Refunds completed"
                current={complete ? p.refundedCash : 0}
                target={complete ? p.refundedCash : p.refundableCash}
              />
            </>
          )}
          {phase === "earning" && (
            <>
              <div className="rent-flow">
                <div>
                  <span>Revenue received</span>
                  <strong id="monthly-rent-in">{money(p.lastMonthRent)}</strong>
                </div>
                <span aria-hidden="true">→</span>
                <div>
                  <span>Operator INCOME cash-outs</span>
                  <strong id="ops-rev-cash">
                    {money(p.lastOpsCashFromRevnet)}
                  </strong>
                </div>
                <span aria-hidden="true">+</span>
                <div>
                  <span>Reserve used</span>
                  <strong id="ops-reserve-used">
                    {money(p.lastOpsFromReserve)}
                  </strong>
                </div>
              </div>
              <Allocation p={p} />
              <ReserveStress projection={p} inputs={inputs} />
            </>
          )}
          {sold && (
            <p>
              Assumes {percent(p.saleCostPercent)} selling expenses. Sale cash
              includes {money(p.reserveReturnedToFund)} of unused reserve.
              Unpaid operating expenses are deducted. Existing INCOME remains
              separate.
            </p>
          )}
          <TokenTerms p={p} />
        </div>
      </details>
    </div>
  );
}

function Contribution({
  p,
  onMonthChange,
}: {
  p: Projection;
  onMonthChange: (month: number) => void;
}) {
  const closed = p.phase === "earning" || p.phase === "liquidated";
  const sold = p.phase === "liquidated";
  const share = closed
    ? p.personalFundPercent
    : (p.investment / p.raiseGoal) * (100 - p.operatorFundPercent);
  if (p.phase === "refunding" || p.phase === "refunded")
    return (
      <Metric
        id="your-refund"
        label="Your refund"
        value={p.personalRefund}
        note="Before applicable protocol fees."
      />
    );
  return (
    <>
      {closed && (
        <div className="quote-basis">
          <div className="quote-month-control">
            <label htmlFor="quote-month">Your quote at month</label>
            <input
              id="quote-month"
              className="quote-month-input"
              type="number"
              min={0}
              max={360}
              step={1}
              value={p.monthsApplied}
              onChange={(event) => {
                const value = event.target.valueAsNumber;
                if (Number.isInteger(value) && value >= 0 && value <= 360)
                  onMonthChange(value);
              }}
            />
            <span>Preview, months after purchase</span>
          </div>
          <p>
            Starting revenue {money(p.monthlyRent)}/month; expenses{" "}
            {money(p.monthlyCosts)}/month.
          </p>
          <dl className="math-values">
            <div>
              <dt>Revenue deposited</dt>
              <dd>{money(p.cumulativeRent)}</dd>
            </div>
            <div>
              <dt>Withdrawn for expenses</dt>
              <dd>
                {money(Math.round((p.cumulativeRent - p.revCash) * 100) / 100)}
              </dd>
            </div>
            <div>
              <dt>Cash backing all INCOME</dt>
              <dd>{money(p.revCash)}</dd>
            </div>
          </dl>
        </div>
      )}
      <div className="outcomes">
        <div className="outcome property-outcome">
          <h3>
            {sold
              ? "Your asset-sale cash"
              : closed
                ? "Your asset share"
                : "Asset share after purchase"}
          </h3>
          <strong id={sold ? "your-fund-sale" : "your-fund-percent"}>
            {sold ? money(p.personalFundSaleClaim) : percent(share)}
          </strong>
          <p>
            {sold
              ? "Redeem FUND. Before fees."
              : "FUND gives your share of net sale proceeds."}
          </p>
        </div>
        {closed && (
          <>
            <div className="outcome loan-outcome">
              <h3>Borrow against INCOME</h3>
              <strong id="your-loan-cash">{money(p.personalLoanCash)}</strong>
              <span id="loan-status">
                {p.loanAvailable
                  ? "After estimated upfront fees"
                  : "No cash to borrow yet"}
              </span>
              <p>Repay to recover your INCOME. Default can forfeit it.</p>
            </div>
            <div className="outcome">
              <h3>Or cash out INCOME</h3>
              <strong id="your-cashout">{money(p.personalCashout)}</strong>
              <span>Before fees</span>
              <p>Gives up the INCOME tokens you redeem.</p>
            </div>
          </>
        )}
      </div>
      {closed && (
        <>
          <p className="choice-note">
            Borrow or cash out the same INCOME; these amounts cannot be added
            together.
          </p>
          {sold ? (
            <div className="combined-position">
              <span>If you redeem FUND and INCOME</span>
              <strong id="combined-cashout">
                {money(p.personalFundSaleClaim + p.personalCashout)}
              </strong>
              <p>Before fees; excludes loans.</p>
            </div>
          ) : (
            <div className="loan-growth">
              <p>
                Estimated borrowing next month:{" "}
                <strong id="next-month-loan">
                  {money(p.nextMonthLoanCash)}
                </strong>
              </p>
              <button
                type="button"
                id="add-rent-month"
                disabled={p.revenueMonths >= 360}
                onClick={() => onMonthChange(p.revenueMonths + 1)}
              >
                +1 month
              </button>
            </div>
          )}
          <BorrowingChart projection={p} />
        </>
      )}
      <details id="fund-details" className="holder-choices">
        <summary>
          {closed ? "Token details" : "Your tokens & exit terms"}
        </summary>
        <div>
          <dl className="math-values">
            <div>
              <dt>Your asset tokens</dt>
              <dd id="your-fund-tokens">{number(p.personalFundTokens)} FUND</dd>
            </div>
            {closed && (
              <>
                <div>
                  <dt>From closing</dt>
                  <dd id="your-premint-tokens">
                    {number(p.personalPremintTokens)} INCOME
                  </dd>
                </div>
                <div>
                  <dt>Sticky rewards, assuming full eligibility</dt>
                  <dd id="your-sticky-tokens">
                    {number(
                      p.personalFundRewardTokens ?? p.personalStickyTokens,
                    )}{" "}
                    INCOME
                  </dd>
                </div>
                <div>
                  <dt>Available now</dt>
                  <dd id="your-rev-tokens">
                    {number(p.personalRevTokens)} INCOME
                  </dd>
                </div>
              </>
            )}
          </dl>
          {p.phase === "raising" && (
            <>
              <div className="personal-goal">
                <span>Early cash-out, before protocol fees</span>
                <strong id="your-fund-cashout">
                  {money(p.personalFundCashout)}
                </strong>
              </div>
              <p>
                Leaving during the raise reduces your refund. This estimate
                includes the 10% cash-out tax.
              </p>
            </>
          )}
          {!closed && (
            <p>
              {p.phase === "funded"
                ? "The money is committed to buying the asset. It is not available to withdraw at this stage. "
                : ""}
              After purchase, you would receive{" "}
              {number(p.plannedPersonalRevTokens)} INCOME. The revnet starts
              with $0. This does not guarantee repayment or give priority over
              other INCOME holders.
            </p>
          )}
          {closed && (
            <>
              <p>
                Eligible FUND stakers share{" "}
                {percent(p.currentStickySplitPercent)} of new INCOME through
                Sticky. This projection assumes all FUND participates and
                ongoing rewards are fully vested. Stock Sticky rewards follow
                share balances at each snapshot and unlock in four weekly
                vesting rounds from the reward-claim round; the projection omits
                that vesting schedule. There is no minimum staking period or
                stake-age bonus. Staying staked longer earns additional rounds.
                Live use requires a verified deployment. Initial INCOME claims
                are separate and require no activation, staking or vesting. FUND
                remains your claim on net asset-sale proceeds.
              </p>
              <details className="holder-choices">
                <summary>Loan estimate & terms</summary>
                <dl className="math-values">
                  <div>
                    <dt>Loan principal</dt>
                    <dd id="your-loan-principal">
                      {money(p.personalLoanPrincipal)}
                    </dd>
                  </div>
                  <div>
                    <dt>Assumed upfront fees</dt>
                    <dd id="your-loan-fees">{money(p.personalLoanFees)}</dd>
                  </div>
                </dl>
                <p>
                  This illustrative first loan deducts 6% in upfront fees, not
                  an annual rate. It does not execute a loan. Next-month
                  estimates assume you have not borrowed today. Actual
                  availability, fees and repayment terms require a live contract
                  quote.
                </p>
              </details>
            </>
          )}
        </div>
      </details>
    </>
  );
}

function PayPreview({
  p,
  projectProjection,
  phase,
  contributionError,
  fundAmount,
  onFundAmount,
}: {
  p: Projection | null;
  projectProjection: Projection | null;
  phase: ProjectPhase;
  contributionError: string;
  fundAmount: number;
  onFundAmount: (value: number) => void;
}) {
  const [currency, setCurrency] = useState("USDC");
  const [fundRaw, setFundRaw] = useState(number(fundAmount));
  const [incomeRaw, setIncomeRaw] = useState("100");
  const [review, setReview] = useState(false);
  const income = phase === "earning";
  const raw = income ? incomeRaw : fundRaw;
  const paymentStage = phase === "raising" || income;
  const cashStage = phase === "refunding" || phase === "liquidated";
  const parsed = parsePaymentAmount(raw, currency);
  const fundPaymentError = phase === "raising" && projectProjection && !parsed.error && parsed.amount !== undefined
    ? fundPaymentLimitError(projectProjection, parsed.amount)
    : "";
  const quote = payPanelQuote({
    phase,
    projection: paymentStage ? projectProjection : p,
    amount: raw,
    currency,
    contributionError: phase === "raising" ? fundPaymentError : contributionError,
  });
  let result: ReturnType<typeof demoPaymentResult> | null = null;
  let resultError = "";
  if (
    paymentStage && projectProjection && quote.enabled &&
    quote.amount !== null && quote.tokenOutput !== null
  ) {
    try {
      result = demoPaymentResult(projectProjection, quote.amount, quote.tokenOutput);
    } catch (error) {
      resultError = error instanceof Error ? error.message : "Check the payment amount and project assumptions.";
    }
  }
  const error = quote.error || resultError;
  const signature = JSON.stringify([
    quote,
    p?.monthsApplied,
    p?.personalFundTokens,
  ]);
  useEffect(() => {
    setReview(false);
  }, [signature]);
  return (
    <>
      <div className="pay-panel-heading">
        <h2 id="pay-panel-title">
          {phase === "refunding"
            ? "Refund"
            : phase === "liquidated"
              ? "Cash out"
              : income ? "Pay" : "Fund"}
        </h2>
      </div>
      {income && <p className="pay-context">Revenue payment, month {projectProjection?.monthsApplied ?? 0} preview</p>}
      <form
        id="pay-form"
        style={!income ? { marginTop: 20 } : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (cashStage && quote.enabled) setReview(true);
        }}
      >
        {paymentStage && (
          <div id="pay-amount-wrap">
            <div className="pay-amount-control">
              <input
                id="pay-amount"
                type="text"
                inputMode="decimal"
                value={raw}
                maxLength={24}
                aria-label={`Amount in ${currency}`}
                aria-invalid={Boolean(error)}
                aria-describedby={[
                  currency === "ETH" ? "pay-conversion" : "",
                  currency === "ETH" && !parsed.error && parsed.amount !== undefined ? "pay-settlement" : "",
                  error ? "pay-error" : "",
                  "pay-preview-note",
                ].filter(Boolean).join(" ")}
                onChange={(event) => {
                  const value = event.target.value;
                  if (income) setIncomeRaw(value);
                  else {
                    setFundRaw(value);
                    const amount = parsePaymentAmount(value, currency);
                    if (!amount.error && amount.amount !== undefined)
                      onFundAmount(amount.amount);
                  }
                }}
              />
              <select
                id="pay-currency"
                className="pay-currency"
                aria-label="Payment currency"
                value={currency}
                onChange={(event) => {
                  const next = event.target.value;
                  const fund = parsePaymentAmount(fundRaw, currency);
                  const revenue = parsePaymentAmount(incomeRaw, currency);
                  setFundRaw(
                    fund.error ? "" : sourceAmountFromUSDC(fund.amount, next),
                  );
                  setIncomeRaw(
                    revenue.error
                      ? ""
                      : sourceAmountFromUSDC(revenue.amount, next),
                  );
                  setCurrency(next);
                }}
              >
                <option value="USDC">USDC</option>
                <option value="ETH">ETH</option>
              </select>
            </div>
            {currency === "ETH" && (
              <>
                <p id="pay-conversion" className="pay-conversion">
                  1 ETH ≈ {number(PREVIEW_ETH_USDC_RATE)} USDC | preview rate
                </p>
                {!parsed.error && parsed.amount !== undefined && (
                  <p id="pay-settlement" className="pay-settlement">
                    ≈ {money(parsed.amount)} after conversion
                  </p>
                )}
              </>
            )}
          </div>
        )}
        <div className="pay-receipt" aria-live="polite">
          <span>{cashStage ? "Cash you receive" : "You get"}</span>
          <div>
            <strong id="pay-output">
              {result
                ? tokenNumber(result.tokens)
                : quote.cashOutput !== null
                  ? number(quote.cashOutput)
                  : "—"}
            </strong>
            <span>{cashStage ? "USDC" : quote.route}</span>
          </div>
        </div>
        {result && <DemoPaymentResult result={result} />}
        {!paymentStage && <p id="pay-note" className="pay-note">{quote.reason}</p>}
        {error && (
          <p id="pay-error" className="pay-error" role="alert">
            {error}
          </p>
        )}
        {!paymentStage && <button
          id="pay-review"
          className="pay-review"
          type="submit"
          disabled={!quote.enabled}
          aria-haspopup="dialog"
        >
          {quote.actionLabel}
        </button>}
        <p id="pay-preview-note" className="pay-preview-note">Preview only | no transaction</p>
      </form>
      {review && cashStage && (
        <Modal
          id="pay-dialog"
          title={`Preview ${quote.route} cash-out`}
          className="pay-dialog"
          onClose={() => setReview(false)}
        >
          <dl>
            <div>
              <dt>Estimated cash</dt>
              <dd>{money(quote.cashOutput ?? 0)} USDC</dd>
            </div>
          </dl>
          <p>{quote.reason}</p>
          <p className="pay-dialog-disclaimer">
            Nothing is signed, paid, redeemed, or changed. This review does not
            update balances.
          </p>
          <button
            id="pay-dialog-done"
            className="pay-review"
            type="button"
            onClick={() => setReview(false)}
          >
            Done
          </button>
        </Modal>
      )}
    </>
  );
}

function DemoOwnerTools({
  projection,
  onPhase,
}: {
  projection: Projection;
  onPhase: (phase: ProjectPhase) => void;
}) {
  const [draft, setDraft] = useState<OwnerDraft | null>(null);
  const [draftError, setDraftError] = useState("");
  const toolsRef = useRef<HTMLDetailsElement>(null);
  const actions: Partial<Record<ProjectPhase, [string, string][]>> = {
    raising: [
      ["close_raise", "Prepare closing"],
      ["enable_refunds", "Prepare refunds"],
    ],
    funded: [
      ["complete_purchase", "Prepare purchase & allocation"],
      ["enable_refunds", "Prepare refunds"],
    ],
    earning: [["enable_sale_redemptions", "Prepare sale redemptions"]],
  };
  const available = actions[projection.phase as ProjectPhase] ?? [];
  const prepare = (action: string) => {
    try {
      setDraftError("");
      if (toolsRef.current) toolsRef.current.open = true;
      setDraft(ownerActionDraft(action, projection));
    } catch (error) {
      setDraftError(
        error instanceof Error
          ? error.message
          : "Check the model inputs before reviewing this draft.",
      );
    }
  };
  const reviewActions: Record<string, string> = {
    close: "close_raise",
    fail: "enable_refunds",
    sale: "enable_sale_redemptions",
  };
  const guide = (
    <ProjectActionGuide
      stage={projection.phase as ProjectPhase}
      section="operators"
      actionIds={Object.keys(reviewActions).filter((id) =>
        available.some(([action]) => action === reviewActions[id]),
      )}
      onAction={(id) => prepare(reviewActions[id])}
    />
  );
  if (!available.length) return guide;
  return (
    <>
      <details id="owner-tools" ref={toolsRef}>
        <summary>Owner tools</summary>
        <div id="owner-actions" className="owner-actions">
          <p>Demo review drafts only</p>
          <div>
            {available.map(([action, label]) => (
              <button
                type="button"
                className="outline-button"
                key={action}
                data-owner-action={action}
                onClick={() => prepare(action)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {draftError && (
          <p className="pay-error" role="alert">
            {draftError}
          </p>
        )}
        {["raising", "funded"].includes(projection.phase) && (
          <button
            id="failure-state"
            type="button"
            className="quiet-button"
            onClick={() => onPhase("refunding")}
          >
            Preview a failed raise
          </button>
        )}
        {draft && (
          <Modal
            id="owner-dialog"
            title={draft.title}
            onClose={() => setDraft(null)}
          >
            <p className="draft-only">
              Review only. Nothing is signed, submitted, queued or changed
              on-chain.
            </p>
            <p>{draft.description}</p>
            {draft.blockedReasons.length > 0 && (
              <div className="scenario-caution">
                <strong>Prerequisites not met</strong>
                <ul>
                  {draft.blockedReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            <ol className="draft-steps">
              {draft.steps.map((step) => (
                <li key={step.id}>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                </li>
              ))}
            </ol>
            <details className="holder-choices">
              <summary>Prerequisites & verification</summary>
              <ul>
                {draft.requiresVerification.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
            <details className="holder-choices">
              <summary>Limitations & cautions</summary>
              <ul>
                {draft.warnings.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
            <details className="holder-choices">
              <summary>Review proposed field changes</summary>
              <pre>{JSON.stringify(draft.changes, null, 2)}</pre>
            </details>
            <div className="dialog-actions">
              <button
                id="download-owner-draft"
                className="button"
                type="button"
                onClick={() =>
                  download(
                    JSON.stringify(draft, null, 2),
                    "homerun-owner-draft.json",
                  )
                }
              >
                Download draft
              </button>
              <button
                id="preview-owner-state"
                className="outline-button"
                type="button"
                disabled={!draft.eligible}
                onClick={() => {
                  onPhase(draft.toPhase as ProjectPhase);
                  setDraft(null);
                }}
              >
                Preview state
              </button>
            </div>
          </Modal>
        )}
      </details>
      {guide}
    </>
  );
}

function DemoOverview({
  name,
  project,
  phase,
  p,
}: {
  name: string;
  project?: CreatedProject;
  phase: ProjectPhase;
  p: Projection | null;
}) {
  const description =
    project?.values.description ||
    (project
      ? "An asset funded together, with FUND ownership and a separate INCOME revenue project."
      : "A founders’ clubhouse in Jurerê Internacional, Florianópolis. Workspaces, events, a pool and wellness activities bring people together and give the property a way to earn revenue.");
  return (
    <div className="demo-overview">
      <section className="demo-section demo-description">
        <h2>About</h2>
        <p>{description}</p>
      </section>
      <ProjectPhoto
        name={name}
        photo={project?.values.photo}
        demo={!project}
        assetType={project?.values.assetType}
      />
      <section className="demo-section demo-overview-progress">
        <div>
          <h2>Progress</h2>
          {p && (
            <div
              id="project-raise-stats"
              className="project-raise-stats"
              aria-label="Fundraising overview"
            >
              <dl>
                <div>
                  <dt>
                    {["earning", "liquidated", "refunded"].includes(phase)
                      ? "Originally raised"
                      : "Raised"}
                  </dt>
                  <dd id="project-raised">{money(p.raised)}</dd>
                </div>
                <div>
                  <dt>Raise goal</dt>
                  <dd id="project-goal">{money(p.raiseGoal)}</dd>
                </div>
              </dl>
              <FundingProgress
                raised={p.raised}
                goal={p.raiseGoal}
                historical={phase !== "raising"}
              />
              <p>
                <strong id="project-funded">
                  {percent(
                    p.raiseGoal > 0 ? (p.raised / p.raiseGoal) * 100 : 0,
                  )}
                </strong>{" "}
                funded
              </p>
              {p.purchaseCompleted && (
                <dl className="demo-revenue-stats">
                  <div>
                    <dt>Revenue received</dt>
                    <dd>{money(p.cumulativeRent)}</dd>
                  </div>
                  <div>
                    <dt>INCOME treasury</dt>
                    <dd>{money(p.revCash)}</dd>
                  </div>
                </dl>
              )}
            </div>
          )}
        </div>
        <ProjectJourney phase={phase} />
      </section>
      <section className="demo-section">
        <h2>Representation</h2>
        <div className="demo-token-summary">
          <div>
            <h3>FUND</h3>
            <p>A share of the net proceeds when the asset is sold.</p>
          </div>
          <div>
            <h3>INCOME</h3>
            <p>
              A share of ongoing revenues, owned by FUND holders, operators, and
              customers
            </p>
          </div>
        </div>
      </section>
      <OperatorProfile
        name={project ? project.values.operatorName : "Founder Haus team"}
        introduction={project ? project.values.operatorIntroduction : "We’re a small team of founders and local hosts turning this house into a place to work, gather, and recharge. We handle day-to-day operations, welcome members and guests, and keep the community updated on income and expenses."}
        photoUrl={project?.values.operatorPhoto}
      />
      <div className="demo-model-note">
        <p>
          {project ? "Local project preview." : "Illustrative demo."} Figures
          and actions are modeling previews. Ongoing rewards assume all FUND
          participates in Sticky and rewards are fully vested; weekly reward
          vesting is not modeled.
        </p>
      </div>
    </div>
  );
}

function DemoStageHistory({
  p,
  phase,
}: {
  p: Projection | null;
  phase: ProjectPhase;
}) {
  const failed = phase === "refunding" || phase === "refunded";
  const steps = failed
    ? [
        {
          name: "Fundraise",
          state: "Past",
          detail: p
            ? `${money(p.raised)} contributed`
            : "Contributions collected",
        },
        {
          name: "Refunds",
          state: phase === "refunded" ? "Complete" : "Current",
          detail:
            phase === "refunded"
              ? "Remaining funds returned. No asset was purchased."
              : "Remaining funds become claimable by contributors.",
        },
      ]
    : [
        {
          name: "Fundraise",
          state: phase === "raising" || phase === "funded" ? "Current" : "Past",
          detail:
            phase === "raising"
              ? "Collect contributions toward the purchase."
              : "Close the raise and complete the purchase.",
        },
        {
          name: "Income",
          state:
            phase === "earning"
              ? "Current"
              : phase === "liquidated"
                ? "Past"
                : "Upcoming",
          detail: p?.purchaseCompleted
            ? `${p.monthsApplied} months of revenue modeled.`
            : "Launch INCOME, receive revenue and pay operating costs.",
        },
        {
          name: "Asset sale",
          state: phase === "liquidated" ? "Current" : "Eventually",
          detail:
            "Return net sale proceeds to FUND holders. INCOME remains separate.",
        },
      ];
  return (
    <section className="demo-section demo-stage-history">
      <h2>Progress</h2>
      <ol tabIndex={0} aria-label="Project stages">
        {steps.map((step, index) => (
          <li key={step.name} data-stage-state={step.state.toLowerCase()}>
            <span className="demo-stage-number" aria-hidden="true">
              {index + 1}
            </span>
            <div>
              <div className="demo-stage-label">
                <h3>{step.name}</h3>
                <span>{step.state}</span>
              </div>
              <p>{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DemoOutlook({ p, inputs }: { p: Projection; inputs: NetworkInputs }) {
  const [months, setMonths] = useState(12);
  const start = p.purchaseCompleted ? p.monthsApplied : 0;
  const target = Math.min(360, start + months);
  const future = useMemo(() => {
    try {
      return projectNetwork(
        {
          ...inputs,
          investment: 0,
          revenueMonths: target,
          fundRewardMode: "holders",
        },
        "earning",
      );
    } catch {
      return null;
    }
  }, [inputs, target]);
  if (["refunding", "refunded", "liquidated"].includes(p.phase)) return null;
  return (
    <section className="demo-section demo-outlook">
      <div className="demo-outlook-heading">
        <div>
          <h2>Looking ahead</h2>
          <p>Assuming the asset is purchased and the revenue plan holds.</p>
        </div>
        <div
          className="demo-outlook-range"
          role="group"
          aria-label="Projection horizon"
        >
          {[12, 36, 60].map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={months === value}
              onClick={() => setMonths(value)}
            >
              {value / 12} {value === 12 ? "year" : "years"}
            </button>
          ))}
        </div>
      </div>
      {future ? (
        <>
          <p className="demo-outlook-basis">
            Modeling projection from month {start} to month {target}. The chart
            includes the full modeled path from purchase.
          </p>
          <dl className="demo-outlook-values">
            <div>
              <dt>Revenue through month {target}</dt>
              <dd>{money(future.cumulativeRent)}</dd>
            </div>
            <div>
              <dt>INCOME treasury</dt>
              <dd>{money(future.revCash)}</dd>
            </div>
            <div>
              <dt>Cash reserve left</dt>
              <dd>{money(future.opsReserveCash)}</dd>
            </div>
          </dl>
          <CashHistoryChart projection={future} />
        </>
      ) : (
        <p>Check the inputs before projecting future revenue.</p>
      )}
    </section>
  );
}

function DemoOwners({
  p,
  phase,
  error,
  onMonthChange,
}: {
  p: Projection | null;
  phase: ProjectPhase;
  error: string;
  onMonthChange: (month: number) => void;
}) {
  const unavailable = (
    <section className="demo-section">
      <p>{error || "Check the modeling inputs to see ownership."}</p>
    </section>
  );
  const income = !!p?.purchaseCompleted;
  return (
    <OwnersTabs
      accountsYou={
        p && !error ? (
          <section className="demo-section demo-account">
            <h2>Your position</h2>
            <p>
              Based on a modeled contribution of {money(p.investment)}. This is
              a preview account.
            </p>
            <dl className="demo-account-balances">
              <div>
                <dt>FUND</dt>
                <dd>{tokenNumber(p.personalFundTokens)}</dd>
              </div>
              <div>
                <dt>INCOME</dt>
                <dd>
                  {income ? tokenNumber(p.personalRevTokens) : "Not issued yet"}
                </dd>
              </div>
            </dl>
            <div id="fund-position-preview">
              <Contribution p={p} onMonthChange={onMonthChange} />
            </div>
            <ProjectActionGuide stage={phase} section="accounts" />
          </section>
        ) : (
          unavailable
        )
      }
      accountsAll={
        p ? (
          <section className="demo-section">
            <h2>All owners</h2>
            <p>
              Modeled ownership across contributors, operators and customers.
              This demo represents groups, not indexed wallet accounts.
            </p>
            <div id="fund-ownership-preview">
              <OwnershipCharts projection={p} />
            </div>
          </section>
        ) : (
          unavailable
        )
      }
      market={
        p ? (
          <section className="demo-section">
            <h2>Market</h2>
            <p>
              Preview cash-out values for your modeled position. Live quotes use
              confirmed treasury balances.
            </p>
            <div className="demo-token-summary">
              <div>
                <h3>FUND</h3>
                <strong>{money(p.personalFundCashout)}</strong>
                <p>
                  {p.phase === "funded" || p.phase === "earning"
                    ? "Cash-outs are closed during purchase and operation."
                    : "Estimated cash-out before protocol fees."}
                </p>
              </div>
              <div>
                <h3>INCOME</h3>
                <strong>
                  {income ? money(p.personalCashout) : "Not issued yet"}
                </strong>
                <p>
                  Cash-outs return revenue backing and give up the tokens
                  redeemed.
                </p>
              </div>
            </div>
            <ProjectActionGuide stage={phase} section="market" />
          </section>
        ) : (
          unavailable
        )
      }
      settlement={
        <section className="demo-section">
          <h2>Settlement</h2>
          <p>
            Linked live projects let holders bridge FUND and INCOME between
            supported networks. Transfers are prepared on the source chain,
            relayed, then claimed on the destination.
          </p>
          <p>This demo has no cross-chain transfers to settle.</p>
          <ProjectActionGuide stage={phase} section="settlement" />
        </section>
      }
      splits={
        p ? (
          <section className="demo-section">
            <h2>Splits</h2>
            <p>
              New INCOME is allocated to operators, eligible FUND stakers and
              customers.
            </p>
            <Allocation p={p} />
            <TokenTerms p={p} />
            <ProjectActionGuide stage={phase} section="splits" />
          </section>
        ) : (
          unavailable
        )
      }
      loans={
        p ? (
          <section className="demo-section">
            <h2>Loans</h2>
            <p>
              INCOME can be collateral for a Revnet loan when borrowing is
              available. FUND stays separate.
            </p>
            {income ? (
              <>
                <dl className="demo-account-balances">
                  <div>
                    <dt>Estimated loan proceeds</dt>
                    <dd>{money(p.personalLoanCash)}</dd>
                  </div>
                  <div>
                    <dt>Assumed upfront fees</dt>
                    <dd>{money(p.personalLoanFees)}</dd>
                  </div>
                </dl>
                <BorrowingChart projection={p} />
                <p>
                  Borrowing and cashing out the same INCOME are alternatives.
                  These are modeling estimates; a live loan requires a reviewed
                  contract quote.
                </p>
              </>
            ) : (
              <p>Loan projections become available in the Income stage.</p>
            )}
            <ProjectActionGuide stage={phase} section="loans" />
          </section>
        ) : (
          unavailable
        )
      }
    />
  );
}

export function DemoProjectPage({ project }: { project?: CreatedProject }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
  }, []);
  const initial = useMemo(
    () =>
      project
        ? {
            ...DEFAULT_NETWORK,
            ...creationSummary(project.values).networkInputs,
            investment: Math.min(100, project.values.purchaseBudget),
          }
        : { ...DEFAULT_NETWORK },
    [project],
  );
  const [inputs, setInputs] = useState<NetworkInputs>(initial);
  const [phase, setPhase] = useState<ProjectPhase>("raising");
  const [growth, setGrowth] = useState(false);
  const [reset, setReset] = useState(0);
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>(
    {},
  );
  const change = (key: string, value: number) =>
    setInputs((previous) => ({ ...previous, [key]: value }));
  const derived = useMemo(() => {
    try {
      const invalid = Object.entries(invalidFields).filter(
        ([key, value]) =>
          value &&
          (key !== "raisedPercent" ||
            ["raising", "refunding", "refunded"].includes(phase)) &&
          (key !== "salePrice" || phase === "liquidated") &&
          (key !== "revenueMonths" ||
            ["earning", "liquidated"].includes(phase)),
      );
      if (invalid.length)
        throw new Error(
          "Check the highlighted assumptions before previewing this stage.",
        );
      const property = projectNetwork(
        { ...inputs, investment: 0, fundRewardMode: "holders" },
        phase,
      );
      const prospective = Boolean(project) && phase === "raising";
      const allowed = prospective
        ? Math.max(0, property.raiseGoal - property.raised)
        : property.raised;
      const personalError =
        inputs.investment > allowed
          ? `Your contribution cannot exceed ${money(allowed)} ${prospective ? "left to raise" : "raised in this preview"}.`
          : "";
      const personalInputs = prospective
        ? {
            ...inputs,
            raisedPercent: Math.min(
              100,
              ((Math.round(property.raised * 100) +
                Math.round(inputs.investment * 100)) /
                Math.round(property.raiseGoal * 100)) *
                100,
            ),
          }
        : inputs;
      return {
        property,
        projection: personalError
          ? property
          : projectNetwork(
              { ...personalInputs, fundRewardMode: "holders" },
              phase,
            ),
        personalError,
        error: "",
      };
    } catch (error) {
      return {
        property: null,
        projection: null,
        personalError: "",
        error:
          error instanceof Error ? error.message : "Check your assumptions.",
      };
    }
  }, [inputs, phase, project, invalidFields]);
  const p = derived.projection;
  const overview = derived.property;
  const fundraising = !["earning", "liquidated"].includes(phase);
  const name = project?.values.name || "Founder Haus";
  const location =
    project?.values.location ||
    (project ? "" : "Jurerê Internacional, Florianópolis");
  const next = nextStages[phase];
  const field = (
    key: keyof NetworkInputs,
    label: string,
    options: {
      min?: number;
      max?: number;
      integer?: boolean;
      currency?: boolean;
      percentage?: boolean;
    } = {},
  ) => (
    <NumericField
      name={key}
      label={label}
      value={inputs[key] as number}
      onChange={(value) => change(key, value)}
      onValidityChange={(valid) =>
        setInvalidFields((previous) => ({ ...previous, [key]: !valid }))
      }
      {...options}
    />
  );
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Brand />
        <button
          id="reset-example"
          type="button"
          className="quiet-button"
          onClick={() => {
            try {
              localStorage.removeItem(
                demoShopStorageKey(project?.id ?? "founderhaus"),
              );
            } catch {
              /* The mounted shop still clears its in-memory preview. */
            }
            setInputs(initial);
            setPhase("raising");
            setGrowth(false);
            setInvalidFields({});
            setReset(reset + 1);
          }}
        >
          Reset {project ? "preview" : "example"} ↺
        </button>
      </header>
      <main id="main" tabIndex={-1}>
        <div className="simulator" data-ready={ready}>
          <HomerunProjectLayout
            title={name}
            location={location}
            logo={
              project && !project.values.photo ? (
                <span className="demo-project-initial" aria-hidden="true">
                  {name.slice(0, 1)}
                </span>
              ) : (
                <div className="demo-project-logo">
                  <Image
                    unoptimized
                    src={project?.values.photo || photos[0].src}
                    width={192}
                    height={192}
                    alt=""
                  />
                </div>
              )
            }
            metadata={[
              <span
                key="status"
                id="project-status"
                className="project-status"
                data-project-phase={phase}
                role="status"
              >
                Status: {statusLabels[phase]}
              </span>,
              ...demoStateMetadata(overview, phase),
            ].filter(Boolean)}
            headerProgress={overview && !overview.purchaseCompleted && <FundingProgress raised={overview.raised} goal={overview.raiseGoal} historical={phase !== "raising"} compact />}
            payment={
              <aside
                id="pay-panel"
                className="pay-panel"
                aria-label="Contribution preview"
              >
                <PayPreview
                  key={reset}
                  p={p}
                  projectProjection={overview}
                  phase={phase}
                  contributionError={derived.personalError || derived.error}
                  fundAmount={inputs.investment}
                  onFundAmount={(value) => change("investment", value)}
                />
              </aside>
            }
            activity={<DemoActivity projection={overview} />}
            overview={
              <DemoOverview
                name={name}
                project={project}
                phase={phase}
                p={overview}
              />
            }
            stages={
              <div className="demo-stages">
                <DemoStageHistory p={overview} phase={phase} />
                <ProjectActionGuide stage={phase} section="stages" />
                {p ? (
                  <PhasePanel
                    p={project ? overview! : p}
                    inputs={inputs}
                    revenueDescription={project?.values.revenueDescription}
                  />
                ) : (
                  <div className="phase-panel">
                    <h2>Check the assumptions.</h2>
                    <p role="alert">{derived.error}</p>
                  </div>
                )}
                <div className="process-navigation">
                  <button
                    id="next-state"
                    type="button"
                    className="quiet-button"
                    disabled={!next || !p}
                    onClick={() => next && setPhase(next[0])}
                  >
                    {next ? `${next[1]} →` : "End of this scenario"}
                  </button>
                </div>
                <details className="demo-modeling-controls" open>
                  <summary>Modeling inputs</summary>
                  <section
                    key={reset}
                    className="preview-workbench"
                    aria-label="Preview settings"
                  >
                    <aside className="assumptions" aria-label="Asset numbers">
                      <h2>Asset assumptions</h2>
                      <form
                        id="projection-form"
                        onSubmit={(event) => event.preventDefault()}
                      >
                        <div className="core-inputs">
                          {field("purchaseBudget", "Asset price", {
                            min: 0.01,
                            currency: true,
                          })}
                          {field("opsReserve", "Cash reserve", {
                            currency: true,
                          })}
                          {field("monthlyRent", "Monthly revenue", {
                            currency: true,
                          })}
                          {field("monthlyCosts", "Monthly expenses", {
                            currency: true,
                          })}
                        </div>
                        <button
                          id="toggle-assumptions"
                          type="button"
                          className="quiet-button"
                          aria-expanded={growth}
                          aria-controls="assumptions-body"
                          onClick={() => setGrowth(!growth)}
                        >
                          Annual growth {growth ? "↑" : "↓"}
                        </button>
                        <div id="assumptions-body" hidden={!growth}>
                          <div className="input-pair">
                            {field(
                              "rentGrowthPercent",
                              "Revenue growth / year",
                              {
                                min: -100,
                                max: 100,
                                percentage: true,
                              },
                            )}
                            {field(
                              "costGrowthPercent",
                              "Expense growth / year",
                              {
                                min: -100,
                                max: 100,
                                percentage: true,
                              },
                            )}
                          </div>
                        </div>
                        {derived.error && (
                          <p id="projection-error" role="alert">
                            {derived.error}
                          </p>
                        )}
                      </form>
                    </aside>
                    <section
                      id="preview-controls"
                      className="state-picker"
                      data-base={
                        fundraising
                          ? "fundraise"
                          : phase === "earning"
                            ? "income"
                            : "sale"
                      }
                      aria-labelledby="state-label"
                    >
                      <div className="picker-label">
                        <h2 id="state-label">
                          Preview{" "}
                          {fundraising
                            ? "fundraising"
                            : phase === "earning"
                              ? "income"
                              : "an asset sale"}
                        </h2>
                        <span>Changes the example only</span>
                      </div>
                      <div
                        className="preview-base-buttons"
                        role="group"
                        aria-label="Choose a preview stage"
                      >
                        {stageNames.map((label, index) => (
                          <button
                            type="button"
                            key={label}
                            data-journey-phase={stagePhases[index]}
                            aria-pressed={
                              stagePhases[index] ===
                              (fundraising ? "raising" : phase)
                            }
                            onClick={() => setPhase(stagePhases[index])}
                          >
                            <span aria-hidden="true">{index + 1}</span>
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="phase-buttons" hidden={!fundraising}>
                        {phases.slice(0, 4).map(([id, label]) => (
                          <button
                            type="button"
                            key={id}
                            data-phase={id}
                            aria-pressed={phase === id}
                            onClick={() => setPhase(id)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div
                        className="scenario-controls"
                        hidden={phase === "funded"}
                      >
                        <div
                          id="raise-input"
                          hidden={
                            !["raising", "refunding", "refunded"].includes(
                              phase,
                            )
                          }
                        >
                          {field("raisedPercent", "Fundraising progress", {
                            max: 100,
                            percentage: true,
                          })}
                        </div>
                        <div id="revenue-input" hidden={fundraising}>
                          {field("revenueMonths", "Months of revenue", {
                            max: 360,
                            integer: true,
                          })}
                        </div>
                        <div id="sale-scenario" hidden={phase !== "liquidated"}>
                          {field("salePrice", "Suppose the asset sells for", {
                            currency: true,
                          })}
                        </div>
                      </div>
                    </section>
                  </section>
                </details>
                {overview && <DemoOutlook p={overview} inputs={inputs} />}
              </div>
            }
            owners={
              <DemoOwners
                p={p}
                phase={phase}
                error={derived.personalError || derived.error}
                onMonthChange={(value) => change("revenueMonths", value)}
              />
            }
            shop={
              <DemoProjectShop
                projectKey={project?.id ?? "founderhaus"}
                resetKey={reset}
              />
            }
            extras={
              <div className="demo-extras">
                <section className="demo-section">
                  <h2>Payer addresses</h2>
                  <p>
                    A live project can have dedicated addresses that forward
                    payments to FUND or INCOME. The demo has no payment
                    addresses.
                  </p>
                </section>
                <div className="page-tools">
                  <button
                    id="download-scenario"
                    type="button"
                    className="quiet-button"
                    disabled={!p || Boolean(derived.personalError)}
                    onClick={() =>
                      download(
                        JSON.stringify(
                          {
                            version: 1,
                            projectName: name,
                            mode: "illustrative-preview",
                            phase,
                            inputs,
                            projection: p,
                          },
                          null,
                          2,
                        ),
                        "homerun-scenario.json",
                      )
                    }
                  >
                    Save scenario ↓
                  </button>
                </div>
                <SiteIntegration
                  configuration={{
                    project: {
                      name,
                      location:
                        project?.values.location ||
                        "Jurerê Internacional, Florianópolis",
                    },
                    mode: "illustrative-preview",
                    phase,
                    modelingInputs: inputs,
                    ...(project ? { setupDraft: project.deployment } : {}),
                  }}
                />
              </div>
            }
            operators={
              <section className="demo-section demo-operators">
                <h2>Operators</h2>
                <p>
                  Review the steps for this scenario. These drafts do not sign
                  or send transactions.
                </p>
                {p ? (
                  <DemoOwnerTools
                    projection={project ? overview! : p}
                    onPhase={setPhase}
                  />
                ) : (
                  <p>
                    Check the modeling inputs to prepare an operator action.
                  </p>
                )}
              </section>
            }
          />
        </div>
      </main>
      <footer>
        <span>
          FUND: a share of net asset-sale proceeds. INCOME: a share of revenue.
        </span>
      </footer>
    </>
  );
}

export function LocalProjectPreview() {
  const [project, setProject] = useState<CreatedProject | null | undefined>(
    undefined,
  );
  useEffect(() => {
    setProject(
      loadCreatedProject(new URLSearchParams(window.location.search).get("id")),
    );
  }, []);
  if (project) return <DemoProjectPage project={project} />;
  return (
    <>
      <header className="site-header">
        <Brand />
      </header>
      <main id="main" className="missing-project">
        {project === undefined ? (
          <p role="status">Loading your saved project preview…</p>
        ) : (
          <>
            <h1>Project preview not found</h1>
            <p>
              These older previews are saved in the browser where they were
              created. A deployed project has its own chain and project address.
            </p>
            <Link href="/create">Create a project</Link>
            <Link href="/founderhaus">Explore Founder Haus</Link>
          </>
        )}
      </main>
    </>
  );
}
