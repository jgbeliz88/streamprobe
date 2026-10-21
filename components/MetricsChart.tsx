"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtBps } from "@/lib/fmt";
import type { ChartMarker, MetricSample } from "@/lib/engines/types";

// Series colours, validated (dataviz skill) against the app's dark surface.
const C = { grid: "#232B3A", axis: "#46536B", ink: "#E2E8F2", mut: "#7A879C", stall: "#F59E0B", error: "#EF4444" };

const PAD_L = 44;
const PAD_R = 10;
const PAD_T = 8;
const PAD_B = 16;

function niceMax(v: number, floor: number): number {
  const x = Math.max(v, floor);
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / pow;
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((k) => k >= n - 1e-9) ?? 10;
  return step * pow;
}
function p95(vals: number[]): number {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
function axisBps(bps: number): string {
  if (bps <= 0) return "0";
  if (bps >= 1e6) return `${+(bps / 1e6).toFixed(bps < 1e7 ? 1 : 0)}M`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)}k`;
  return `${Math.round(bps)}`;
}
function fmtTime(s: number): string {
  if (s < 90) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}:${Math.round(s % 60).toString().padStart(2, "0")}`;
}

interface Metric {
  key: string;
  label: string;
  color: string;
  step?: boolean; // draw as a step (bitrate holds until the next ABR switch)
  floor: number;
  valueOf: (s: MetricSample) => number;
  axisFmt: (v: number) => string;
  valueFmt: (v: number) => string;
}

const METRICS: Metric[] = [
  { key: "bitrate", label: "Bitrate", color: "#3987e5", step: true, floor: 1e6, valueOf: (s) => s.bitrate, axisFmt: axisBps, valueFmt: (v) => fmtBps(v) },
  { key: "bw", label: "Ancho de banda", color: "#d95926", floor: 1e6, valueOf: (s) => s.bw, axisFmt: axisBps, valueFmt: (v) => fmtBps(v) },
  { key: "buffer", label: "Buffer", color: "#199e70", floor: 8, valueOf: (s) => s.buffer, axisFmt: (v) => `${Math.round(v)}s`, valueFmt: (v) => `${v.toFixed(1)}s` },
];

function SeriesChart({
  m,
  samples,
  markers,
  hover,
  onHover,
  expanded,
  onToggle,
}: {
  m: Metric;
  samples: MetricSample[];
  markers: ChartMarker[];
  hover: number | null;
  onHover: (i: number | null) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [dim, setDim] = useState({ w: 0, h: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => {
      const r = e[0].contentRect;
      setDim({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => {
    const { w, h } = dim;
    if (samples.length < 2 || w < 40 || h < 30) return null;
    const X0 = PAD_L, X1 = w - PAD_R, Y0 = PAD_T, Y1 = h - PAD_B;
    const maxT = Math.max(samples[samples.length - 1].t, 10);
    const yMax = niceMax(p95(samples.map(m.valueOf)) * 1.05, m.floor);
    const xs = (t: number) => X0 + (t / maxT) * (X1 - X0);
    const ys = (v: number) => Y1 - Math.min(v / yMax, 1) * (Y1 - Y0);
    const last = samples[samples.length - 1];

    let line: string;
    if (m.step) {
      line = `M ${xs(samples[0].t)} ${ys(m.valueOf(samples[0]))}`;
      for (let i = 1; i < samples.length; i++) {
        line += ` L ${xs(samples[i].t)} ${ys(m.valueOf(samples[i - 1]))} L ${xs(samples[i].t)} ${ys(m.valueOf(samples[i]))}`;
      }
    } else {
      line = samples.map((s, i) => `${i ? "L" : "M"} ${xs(s.t)} ${ys(m.valueOf(s))}`).join(" ");
    }
    const area = `${line} L ${xs(last.t)} ${Y1} L ${xs(samples[0].t)} ${Y1} Z`;
    return { w, h, X0, X1, Y0, Y1, maxT, yMax, xs, ys, line, area };
  }, [dim, samples, m]);

  const onMove = (e: React.MouseEvent) => {
    if (!g || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = ((x - g.X0) / (g.X1 - g.X0)) * g.maxT;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const d = Math.abs(samples[i].t - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    onHover(best);
  };

  const hv = hover != null && samples[hover] ? samples[hover] : null;
  const read = hv ?? (samples.length ? samples[samples.length - 1] : null);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r border-bd last:border-r-0">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center gap-[6px] border-b border-bd bg-sf1 px-2 py-[5px] font-mono text-[10px]">
        <i className="h-[8px] w-[8px] flex-shrink-0 rounded-[2px]" style={{ background: m.color }} />
        <span className="text-tx2">{m.label}</span>
        <b className="tabular-nums text-tx1">{read ? m.valueFmt(m.valueOf(read)) : "—"}</b>
        <button
          onClick={onToggle}
          title={expanded ? "Reducir" : "Ampliar"}
          className="ml-auto flex-shrink-0 rounded border border-bd px-[6px] py-[1px] text-[11px] text-tx2 transition hover:border-ga hover:text-ga"
        >
          {expanded ? "⤡" : "⛶"}
        </button>
      </div>

      {/* Plot */}
      <div ref={wrapRef} className="relative min-h-0 flex-1 bg-sf1">
        {g && (
          <svg
            ref={svgRef}
            width={g.w}
            height={g.h}
            viewBox={`0 0 ${g.w} ${g.h}`}
            className="block"
            onMouseMove={onMove}
            onMouseLeave={() => onHover(null)}
          >
            {[0, 0.5, 1].map((f) => {
              const y = g.Y1 - f * (g.Y1 - g.Y0);
              return (
                <g key={f}>
                  <line x1={g.X0} y1={y} x2={g.X1} y2={y} stroke={C.grid} strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={g.X0 - 6} y={y + 3} textAnchor="end" fontSize={10} fill={C.mut} fontFamily="monospace">
                    {f === 0 ? "0" : m.axisFmt(g.yMax * f)}
                  </text>
                </g>
              );
            })}

            {markers.map((mk, i) => (
              <line
                key={i}
                x1={g.xs(mk.t)} y1={g.Y0} x2={g.xs(mk.t)} y2={g.Y1}
                stroke={mk.kind === "error" ? C.error : C.stall}
                strokeWidth={1} strokeDasharray="3 3" opacity={0.8}
              />
            ))}

            <path d={g.area} fill={m.color} opacity={0.14} />
            <path d={g.line} fill="none" stroke={m.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

            {[0, 0.5, 1].map((f) => (
              <text
                key={`x${f}`}
                x={g.X0 + f * (g.X1 - g.X0)} y={g.h - 4}
                textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
                fontSize={10} fill={C.mut} fontFamily="monospace"
              >
                {fmtTime(g.maxT * f)}
              </text>
            ))}

            {hv && (
              <g>
                <line x1={g.xs(hv.t)} y1={g.Y0} x2={g.xs(hv.t)} y2={g.Y1} stroke={C.axis} strokeWidth={1} />
                <circle cx={g.xs(hv.t)} cy={g.ys(m.valueOf(hv))} r={3.5} fill={m.color} stroke={C.ink} strokeWidth={1} />
              </g>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}

export default function MetricsChart({
  samples,
  markers,
}: {
  samples: MetricSample[];
  markers: ChartMarker[];
}) {
  // Shared crosshair: hovering any chart highlights the same instant in all.
  const [hover, setHover] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (samples.length < 2) {
    return (
      <div className="flex h-full items-center justify-center bg-sf1 p-6 text-center font-mono text-[11px] text-tx3">
        Las gráficas de bitrate / ancho de banda / buffer irán apareciendo aquí en cuanto reproduzcas.
      </div>
    );
  }

  const shown = expanded ? METRICS.filter((m) => m.key === expanded) : METRICS;

  return (
    <div className="flex h-full min-h-0 bg-sf1">
      {shown.map((m) => (
        <SeriesChart
          key={m.key}
          m={m}
          samples={samples}
          markers={markers}
          hover={hover}
          onHover={setHover}
          expanded={expanded === m.key}
          onToggle={() => setExpanded((e) => (e === m.key ? null : m.key))}
        />
      ))}
    </div>
  );
}
