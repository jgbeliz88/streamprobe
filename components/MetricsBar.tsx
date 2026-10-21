"use client";

import { fmtBps, fmtMs } from "@/lib/fmt";
import type { Metrics } from "@/lib/engines/types";

function valClass(color: "" | "good" | "warn" | "bad"): string {
  if (color === "good") return "text-ga";
  if (color === "warn") return "text-warn";
  if (color === "bad") return "text-err";
  return "text-tx1";
}

function Cell({
  label,
  value,
  color = "",
  sub,
}: {
  label: string;
  value: string;
  color?: "" | "good" | "warn" | "bad";
  sub: string;
}) {
  return (
    <div className="bg-sf1 px-3 py-[9px]">
      <div className="mb-[2px] text-[9px] font-semibold uppercase tracking-[.08em] text-tx3">
        {label}
      </div>
      <div className={`font-mono text-[17px] font-semibold leading-[1.2] ${valClass(color)}`}>
        {value}
      </div>
      <div className="mt-[1px] font-mono text-[9px] text-tx3">{sub}</div>
    </div>
  );
}

export default function MetricsBar({ m }: { m: Metrics }) {
  // Join time
  const joinColor: "" | "good" | "warn" =
    m.join === null ? "" : m.join < 800 ? "good" : m.join < 3000 ? "" : "warn";

  // Buffering
  const bufColor: "good" | "warn" | "bad" =
    m.bufN === 0 ? "good" : m.bufN < 3 ? "warn" : "bad";

  // Latency
  let latValue = "VOD";
  let latColor: "" | "good" | "warn" | "bad" = "";
  if (m.latency !== null && m.latency > 0) {
    latValue = m.latency.toFixed(1) + "s";
    latColor = m.latency < 5 ? "good" : m.latency < 15 ? "warn" : "bad";
  } else if (m.latency === 0) {
    latValue = "0.0s";
  }

  return (
    <div className="grid flex-shrink-0 grid-cols-4 gap-px border-b border-bd bg-bd">
      <Cell
        label="Join time"
        value={fmtMs(m.join)}
        color={joinColor}
        sub="ms to first frame"
      />
      <Cell
        label="Buffering"
        value={String(m.bufN)}
        color={bufColor}
        sub={m.bufN > 0 ? `${fmtMs(m.bufMs)} total` : "no stalls"}
      />
      <Cell
        label="Bitrate"
        value={fmtBps(m.bitrate)}
        sub={"bw: " + fmtBps(m.bw)}
      />
      <Cell
        label="Live latency"
        value={latValue}
        color={latColor}
        sub={m.dropped + " dropped"}
      />
    </div>
  );
}
