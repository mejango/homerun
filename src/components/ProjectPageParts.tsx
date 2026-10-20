"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { Brand } from "./Brand";
import { WalletButton } from '@/components/WalletButton';
import type { projectNetwork } from "../../web/network-model.mjs";
import { drawAssetSketch } from "../../web/asset-sketch.mjs";
import { money } from "@/lib/money";
import { FundingProgress } from "./FundingProgress";

export type ProjectPhase =
  "raising" | "funded" | "refunding" | "refunded" | "earning" | "liquidated";
type Projection = ReturnType<typeof projectNetwork>;
const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const percent = (value: number) => `${number(value)}%`;
const stageNames = ["Fundraise", "Income", "Asset sale"];
const stagePhases: ProjectPhase[] = ["raising", "earning", "liquidated"];

/** Native dialog keeps focus trapping, Escape dismissal and focus return. */
export function Modal({
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

export const photos = [
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

export function ProjectPhoto({
  name,
  photo,
  demo,
}: {
  name: string;
  photo?: string;
  demo?: boolean;
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
          <AssetIllustration type="real-estate" />
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

/** Raised against a goal, as the Overview's Progress section shows it. */
export function ProjectRaiseStats({ raised, goal, historical, raisedLabel = "Raised", goalLabel = "Raise goal", format = money, revenue }: {
  raised: number; goal: number; historical: boolean; raisedLabel?: string; goalLabel?: string
  format?: (value: number) => string; revenue?: [string, ReactNode][]
}) {
  return (
    <div id="project-raise-stats" className="project-raise-stats" aria-label="Fundraising overview">
      <dl>
        <div>
          <dt>{raisedLabel}</dt>
          <dd id="project-raised">{format(raised)}</dd>
        </div>
        <div>
          <dt>{goalLabel}</dt>
          <dd id="project-goal">{format(goal)}</dd>
        </div>
      </dl>
      <FundingProgress raised={raised} goal={goal} historical={historical} />
      <p>
        <strong id="project-funded">{percent(goal > 0 ? (raised / goal) * 100 : 0)}</strong>{" "}
        funded
      </p>
      {revenue && (
        <dl className="demo-revenue-stats">
          {revenue.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      )}
    </div>
  );
}

/** The Overview tab every project page shares; each source supplies its own figures. */
export function ProjectOverviewView({ about, photo, progress, phase, profiles, after }: {
  about: ReactNode; photo?: ReactNode; progress?: ReactNode; phase: ProjectPhase | null; profiles: ReactNode; after?: ReactNode
}) {
  return (
    <div className="demo-overview">
      <section className="demo-section demo-description">
        <h2>About</h2>
        {about}
      </section>
      {photo}
      <section className="demo-section demo-overview-progress">
        <div>
          <h2>Progress</h2>
          {progress}
        </div>
        {phase && <ProjectJourney phase={phase} />}
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
      {profiles}
      {after}
    </div>
  );
}

export function DemoStageHistory({
  p,
  phase,
}: {
  p: Projection | null;
  phase: ProjectPhase;
}) {
  const historyRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const history = historyRef.current;
    const current = history?.querySelector('[data-stage-state="current"]');
    if (history && current) {
      history.scrollLeft += current.getBoundingClientRect().left - history.getBoundingClientRect().left;
    }
  }, [phase]);
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
      <ol ref={historyRef} tabIndex={0} aria-label="Project stages">
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

/** The frame every project page shares: the demo, a planned project and a live one. */
export function ProjectPageShell({ headerActions, ready = true, children }: { headerActions?: ReactNode; ready?: boolean; children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Brand />
        <div className="flex flex-wrap items-center justify-end gap-3">
          {headerActions}
          <WalletButton />
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <div className="simulator" data-ready={ready}>
          {children}
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
