import { fmtBps, fmtMs } from "./fmt";
import type { Diagnosis, Level } from "./diagnose";
import type { ChartMarker, MetricSample } from "./engines/types";

export interface ReportData {
  timestamp: string;
  panel: string;
  engine: string;
  version: string;
  url: string;
  device: { label: string; userAgent: string; screen: string };
  metrics: {
    join: number | null;
    bufN: number;
    bufMs: number;
    dropped: number;
    latency: number | null;
    bitrate: number;
  };
  diagnosis: Diagnosis;
  samples: MetricSample[];
  markers: ChartMarker[];
  events: { time: string; type: string; msg: string }[];
  manifests: {
    time: string;
    format: string;
    periodCount: number;
    isMultiperiod?: boolean;
    note?: string;
  }[];
}

const COL = {
  bitrate: "#3987e5",
  bw: "#d95926",
  buffer: "#199e70",
  stall: "#F59E0B",
  error: "#EF4444",
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
/** ISO (UTC) → HH:MM:SS in the local timezone of the machine generating this. */
function clock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** ISO (UTC) → "YYYY-MM-DD HH:MM:SS" in local time. */
function localDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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
function fmtT(s: number): string {
  if (s < 90) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}:${Math.round(s % 60).toString().padStart(2, "0")}`;
}

/** Static two-panel SVG (bitrate/bw + buffer) mirroring the in-app chart. */
function chartSvg(samples: MetricSample[], markers: ChartMarker[]): string {
  if (samples.length < 2) {
    return `<div class="empty">Sin muestras de reproducción en esta sesión.</div>`;
  }
  const W = 900, H = 260, PL = 48, PR = 16, PT = 14, PB = 22, GAP = 26;
  const X0 = PL, X1 = W - PR;
  const plotH = H - PT - PB - GAP;
  const topH = plotH * 0.62;
  const TOP0 = PT, TOP1 = PT + topH;
  const BUF0 = TOP1 + GAP, BUF1 = BUF0 + (plotH - topH);
  const maxT = Math.max(samples[samples.length - 1].t, 10);
  const topMax = niceMax(p95(samples.map((s) => Math.max(s.bitrate, s.bw))) * 1.05, 1_000_000);
  const bufMax = niceMax(Math.max(...samples.map((s) => s.buffer)), 8);
  const xs = (t: number) => X0 + (t / maxT) * (X1 - X0);
  const yT = (v: number) => TOP1 - Math.min(v / topMax, 1) * (TOP1 - TOP0);
  const yB = (v: number) => BUF1 - Math.min(v / bufMax, 1) * (BUF1 - BUF0);

  let step = `M ${xs(samples[0].t)} ${yT(samples[0].bitrate)}`;
  for (let i = 1; i < samples.length; i++) {
    step += ` L ${xs(samples[i].t)} ${yT(samples[i - 1].bitrate)} L ${xs(samples[i].t)} ${yT(samples[i].bitrate)}`;
  }
  const last = samples[samples.length - 1];
  const stepArea = `${step} L ${xs(last.t)} ${TOP1} L ${xs(samples[0].t)} ${TOP1} Z`;
  const bw = samples.map((s, i) => `${i ? "L" : "M"} ${xs(s.t)} ${yT(s.bw)}`).join(" ");
  const buf = samples.map((s, i) => `${i ? "L" : "M"} ${xs(s.t)} ${yB(s.buffer)}`).join(" ");
  const bufArea = `${buf} L ${xs(last.t)} ${BUF1} L ${xs(samples[0].t)} ${BUF1} Z`;

  const gl = (y: number, label: string) =>
    `<line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}" stroke="#232B3A"/>` +
    `<text x="${X0 - 8}" y="${y + 3}" text-anchor="end" class="ax">${label}</text>`;

  const mk = markers
    .map(
      (m) =>
        `<line x1="${xs(m.t)}" y1="${TOP0}" x2="${xs(m.t)}" y2="${TOP1}" stroke="${
          m.kind === "error" ? COL.error : COL.stall
        }" stroke-width="1" stroke-dasharray="3 3" opacity="0.85"/>`
    )
    .join("");

  const xlab = [0, 0.5, 1]
    .map(
      (f) =>
        `<text x="${X0 + f * (X1 - X0)}" y="${H - 6}" text-anchor="${
          f === 0 ? "start" : f === 1 ? "end" : "middle"
        }" class="ax">${fmtT(maxT * f)}</text>`
    )
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="xMidYMid meet">
    <text x="${X0}" y="${TOP0 - 3}" class="ax">Mb/s</text>
    ${[0, 0.5, 1].map((f) => gl(TOP1 - f * (TOP1 - TOP0), axisBps(topMax * f))).join("")}
    ${mk}
    <path d="${stepArea}" fill="${COL.bitrate}" opacity="0.13"/>
    <path d="${step}" fill="none" stroke="${COL.bitrate}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${bw}" fill="none" stroke="${COL.bw}" stroke-width="2" stroke-linejoin="round"/>
    <text x="${X0}" y="${BUF0 - 5}" class="ax">buffer</text>
    ${gl(BUF1, "0")}${gl(BUF0, `${bufMax}s`)}
    <path d="${bufArea}" fill="${COL.buffer}" opacity="0.15"/>
    <path d="${buf}" fill="none" stroke="${COL.buffer}" stroke-width="2" stroke-linejoin="round"/>
    ${xlab}
  </svg>`;
}

function tile(label: string, value: string, tone = ""): string {
  return `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv ${tone}">${esc(
    value
  )}</div></div>`;
}

const LEVEL_DOT: Record<Level, string> = {
  ok: "#1DB953",
  info: "#8C99B0",
  warn: "#F59E0B",
  fail: "#EF4444",
};

function verdictBlock(dg: Diagnosis): string {
  const map = {
    pass: { t: "PASS", c: "#1DB953" },
    warn: { t: "WARN", c: "#F59E0B" },
    fail: { t: "FAIL", c: "#EF4444" },
    none: { t: "—", c: "#5A6785" },
  } as const;
  const v = map[dg.verdict];
  const findings = dg.findings
    .map(
      (fn) =>
        `<div class="find"><span class="fdot" style="background:${LEVEL_DOT[fn.level]}"></span>` +
        `<div><div class="ft">${esc(fn.title)}</div><div class="fd">${esc(fn.detail)}</div></div></div>`
    )
    .join("");
  return `<div class="verdict" style="--vc:${v.c}">
    <div class="vbadge">${v.t}</div>
    <div class="vfind">${findings}</div>
  </div>`;
}

export function buildSessionReport(d: ReportData): string {
  const bitrates = d.samples.map((s) => s.bitrate).filter((b) => b > 0);
  const avgBitrate = bitrates.length ? bitrates.reduce((a, b) => a + b, 0) / bitrates.length : 0;
  const maxBitrate = bitrates.length ? Math.max(...bitrates) : 0;
  const stalls = d.markers.filter((m) => m.kind === "stall").length;
  const errs = d.events.filter((e) => e.type === "error");
  const warns = d.events.filter((e) => e.type === "warn");

  const joinTone = d.metrics.join == null ? "" : d.metrics.join < 800 ? "good" : d.metrics.join < 3000 ? "" : "warn";
  const stallTone = stalls === 0 ? "good" : "warn";
  const errTone = errs.length === 0 ? "good" : "bad";

  const tiles = [
    tile("Arranque (join)", d.metrics.join == null ? "—" : fmtMs(d.metrics.join), joinTone),
    tile("Rebuffers", `${d.metrics.bufN} · ${fmtMs(d.metrics.bufMs)}`, d.metrics.bufN ? "warn" : "good"),
    tile("Bitrate medio", fmtBps(avgBitrate)),
    tile("Bitrate máx", fmtBps(maxBitrate)),
    tile("Stalls", String(stalls), stallTone),
    tile("Errores", String(errs.length), errTone),
    tile("Frames perdidos", String(d.metrics.dropped)),
    tile("Latencia live", d.metrics.latency == null ? "VOD" : `${d.metrics.latency.toFixed(1)}s`),
  ].join("");

  const errRows =
    errs.length + warns.length === 0
      ? `<tr><td colspan="3" class="ok">Sin errores ni avisos.</td></tr>`
      : [...errs, ...warns]
          .map(
            (e) =>
              `<tr><td class="mono">${clock(e.time)}</td><td><span class="badge ${
                e.type
              }">${e.type}</span></td><td>${esc(e.msg)}</td></tr>`
          )
          .join("");

  const evtRows = d.events
    .slice(-250)
    .map(
      (e) =>
        `<tr><td class="mono">${clock(e.time)}</td><td class="mono t-${e.type}">${esc(
          e.type
        )}</td><td>${esc(e.msg)}</td></tr>`
    )
    .join("");

  const manRows = d.manifests.length
    ? d.manifests
        .map(
          (m) =>
            `<tr><td class="mono">${clock(m.time)}</td><td>${esc(
              m.format.toUpperCase()
            )}</td><td>${m.periodCount} periodo${m.periodCount === 1 ? "" : "s"}${
              m.isMultiperiod ? ' <span class="badge warn">multiperiodo</span>' : ""
            }</td><td>${esc(m.note || "")}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="ok">Sin manifests capturados.</td></tr>`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StreamProbe · Informe ${esc(d.engine)} · ${esc(localDateTime(d.timestamp))}</title>
<style>
  :root{--bg:#0B0E16;--sf:#141820;--sf2:#1C2030;--bd:#252D3D;--tx1:#E2E8F2;--tx2:#8C99B0;--tx3:#5A6785;
    --good:#1DB953;--warn:#F59E0B;--bad:#EF4444;--blue:#3987e5;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx1);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px;}
  .wrap{max-width:960px;margin:0 auto}
  .mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
  header{border-bottom:1px solid var(--bd);padding-bottom:16px;margin-bottom:20px}
  .eyebrow{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;color:var(--good)}
  h1{margin:8px 0 4px;font-size:24px;letter-spacing:-.02em}
  h1 .v{color:var(--tx3);font-weight:500;font-size:16px}
  .sub{color:var(--tx2);font-size:12.5px;word-break:break-all}
  .sub b{color:var(--tx1);font-weight:600}
  h2{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--tx3);margin:26px 0 12px}
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--bd);border:1px solid var(--bd);border-radius:10px;overflow:hidden}
  .tile{background:var(--sf);padding:12px 14px}
  .tl{font:600 9.5px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--tx3);margin-bottom:6px}
  .tv{font-family:ui-monospace,Menlo,monospace;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
  .tv.good{color:var(--good)}.tv.warn{color:var(--warn)}.tv.bad{color:var(--bad)}
  .card{background:var(--sf);border:1px solid var(--bd);border-radius:10px;padding:14px}
  .legend{display:flex;gap:16px;flex-wrap:wrap;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--tx2);margin-bottom:8px}
  .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:middle}
  svg.chart{width:100%;height:auto;display:block}
  svg .ax{fill:var(--tx3);font:10px ui-monospace,Menlo,monospace}
  .empty,.ok{color:var(--tx3);padding:14px;text-align:center}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  .tablewrap{border:1px solid var(--bd);border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--bd);vertical-align:top}
  tr:last-child td{border-bottom:0}
  th{font:600 9.5px/1 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--tx3);background:var(--sf2)}
  td.mono{white-space:nowrap;color:var(--tx2)}
  .badge{font:600 10px/1 ui-monospace,Menlo,monospace;padding:3px 6px;border-radius:5px;text-transform:uppercase}
  .badge.error{background:rgba(239,68,68,.16);color:#fca5a5}
  .badge.warn{background:rgba(245,158,11,.16);color:#fcd34d}
  .t-error{color:#f87171}.t-warn{color:#fbbf24}.t-abr{color:#34d399}.t-drm{color:#c084fc}.t-scte{color:#22d3ee}
  .maxh{max-height:420px;overflow:auto}
  .verdict{display:flex;gap:16px;align-items:flex-start;background:var(--sf);border:1px solid var(--bd);border-left:3px solid var(--vc);border-radius:10px;padding:16px}
  .vbadge{flex-shrink:0;font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:20px;letter-spacing:.08em;color:var(--vc);border:1px solid var(--vc);border-radius:7px;padding:8px 14px}
  .vfind{display:flex;flex-direction:column;gap:10px;min-width:0}
  .find{display:flex;gap:9px}
  .fdot{flex-shrink:0;width:8px;height:8px;border-radius:50%;margin-top:6px}
  .ft{font-weight:600;font-size:13px;color:var(--tx1)}
  .fd{font-size:12.5px;color:var(--tx2);line-height:1.5}
  footer{margin-top:28px;padding-top:14px;border-top:1px solid var(--bd);color:var(--tx3);font-size:11px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  @media(max-width:640px){.tiles{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
  <header>
    <div class="eyebrow">StreamProbe · Informe de sesión</div>
    <h1>${esc(d.engine)} <span class="v">v${esc(d.version)}</span></h1>
    <div class="sub"><b>URL:</b> ${esc(d.url) || "—"}</div>
    <div class="sub" style="margin-top:3px">
      <b>${esc(localDateTime(d.timestamp))}</b> ·
      Panel ${esc(d.panel)} · ${esc(d.device.label)}${d.device.screen ? " · " + esc(d.device.screen) : ""}
    </div>
  </header>

  <h2>Veredicto</h2>
  ${verdictBlock(d.diagnosis)}

  <h2>Resumen de calidad (QoE)</h2>
  <div class="tiles">${tiles}</div>

  <h2>Línea temporal</h2>
  <div class="card">
    <div class="legend">
      <span><i style="background:${COL.bitrate}"></i>Bitrate</span>
      <span><i style="background:${COL.bw}"></i>Ancho de banda</span>
      <span><i style="background:${COL.buffer}"></i>Buffer</span>
      <span style="color:var(--tx3)">${d.samples.length} muestras</span>
    </div>
    ${chartSvg(d.samples, d.markers)}
  </div>

  <h2>Errores y avisos</h2>
  <div class="tablewrap"><table><thead><tr><th>Hora</th><th>Tipo</th><th>Mensaje</th></tr></thead>
    <tbody>${errRows}</tbody></table></div>

  <h2>Manifests</h2>
  <div class="tablewrap"><table><thead><tr><th>Hora</th><th>Formato</th><th>Periodos</th><th>Nota</th></tr></thead>
    <tbody>${manRows}</tbody></table></div>

  <h2>Eventos (${Math.min(d.events.length, 250)} últimos)</h2>
  <div class="tablewrap maxh"><table><thead><tr><th>Hora</th><th>Tipo</th><th>Mensaje</th></tr></thead>
    <tbody>${evtRows}</tbody></table></div>

  <footer>
    <span>Generado por StreamProbe · AgileTV</span>
    <span class="mono">${esc(d.device.userAgent)}</span>
  </footer>
</div></body></html>`;
}
