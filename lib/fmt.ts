// Formatting helpers ported from streamprobe.html

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function fmtBps(bps: number | null | undefined): string {
  if (!bps) return "—";
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mb/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} Kb/s`;
  return `${bps} b/s`;
}

/** Clock time in the machine's LOCAL timezone as HH:MM:SS.mmm.
 *  (toISOString would print UTC — off by the local offset, e.g. −2h in CEST.) */
export function fmtTime(d?: Date): string {
  const dt = d || new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}.${p(dt.getMilliseconds(), 3)}`;
}

export function fmtBytes(b?: number | null, empty = "—"): string {
  if (b == null) return empty;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)}MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)}KB`;
  return `${b}B`;
}
