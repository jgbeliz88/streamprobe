"use client";

import type { BufferedState } from "@/hooks/usePlayer";

interface Gap {
  at: number;
  size: number;
}

export default function BufferView({ buffered }: { buffered: BufferedState }) {
  const { ranges, current, duration, seekableEnd } = buffered;
  const isLive = !duration && seekableEnd != null;
  const liveEdgeDistance = seekableEnd != null ? seekableEnd - current : null;

  if (!ranges.length) {
    return (
      <div className="p-5 text-center text-tx3">No buffered data yet</div>
    );
  }

  // Gaps between consecutive buffered ranges.
  const gaps: Gap[] = [];
  for (let i = 1; i < ranges.length; i++) {
    const g = ranges[i].start - ranges[i - 1].end;
    if (g > 0.01) gaps.push({ at: ranges[i - 1].end, size: g });
  }

  // Range currently containing playhead → how much buffer is ahead.
  const cur = ranges.find((r) => current >= r.start - 0.25 && current <= r.end + 0.25);
  const ahead = cur ? cur.end - current : 0;
  const inGap = !cur; // playhead sits in a hole
  const nextGap = gaps.find((g) => g.at >= current - 0.25);
  const gapAhead = cur && nextGap ? nextGap.at - current : null;

  // Visual domain.
  const spanStart = Math.min(ranges[0].start, current);
  const spanEnd = Math.max(ranges[ranges.length - 1].end, current, duration || 0);
  const span = Math.max(spanEnd - spanStart, 0.001);
  const pct = (t: number) => ((t - spanStart) / span) * 100;

  const aheadColor =
    ahead < 2 ? "text-err" : ahead < 5 ? "text-warn" : "text-ga";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-2 font-mono text-[10px]">
      {/* Summary */}
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
        <span className="text-tx3">
          time <span className="text-tx1">{current.toFixed(2)}s</span>
        </span>
        <span className="text-tx3">
          {duration ? (
            <>
              duration <span className="text-tx1">{duration.toFixed(2)}s</span>
            </>
          ) : (
            <span className="text-gb">LIVE</span>
          )}
        </span>
        {isLive && liveEdgeDistance != null && (
          <span className="text-tx3">
            behind live edge{" "}
            <span className="text-tx1">{liveEdgeDistance.toFixed(2)}s</span>
          </span>
        )}
        <span className="text-tx3">
          buffer ahead{" "}
          <span className={aheadColor}>{inGap ? "IN GAP" : ahead.toFixed(2) + "s"}</span>
        </span>
        <span className="text-tx3">
          ranges <span className="text-tx1">{ranges.length}</span>
        </span>
        {gaps.length > 0 && (
          <span className="text-err">
            {gaps.length} gap{gaps.length === 1 ? "" : "s"}
          </span>
        )}
        {gapAhead != null && gapAhead >= 0 && (
          <span className="text-warn">next gap in {gapAhead.toFixed(2)}s</span>
        )}
      </div>

      {/* Timeline bar */}
      <div className="relative mb-3 h-[16px] w-full rounded bg-sf3">
        {ranges.map((r, i) => (
          <div
            key={i}
            className="absolute top-0 h-full rounded-sm bg-ga/70"
            style={{ left: `${pct(r.start)}%`, width: `${Math.max(pct(r.end) - pct(r.start), 0.3)}%` }}
            title={`[${r.start.toFixed(2)}–${r.end.toFixed(2)}]`}
          />
        ))}
        {gaps.map((g, i) => (
          <div
            key={`g${i}`}
            className="absolute top-0 h-full w-[2px] bg-err"
            style={{ left: `${pct(g.at)}%` }}
            title={`gap ${g.size.toFixed(2)}s @ ${g.at.toFixed(2)}s`}
          />
        ))}
        {/* Playhead */}
        <div
          className="absolute top-[-2px] h-[20px] w-[2px] bg-white"
          style={{ left: `${pct(current)}%` }}
          title={`playhead ${current.toFixed(2)}s`}
        />
      </div>

      {/* Ranges + gaps list */}
      <div className="flex flex-col gap-[2px]">
        {ranges.map((r, i) => (
          <div key={i}>
            <div className="flex gap-2">
              <span className="w-[54px] text-tx3">range {i}</span>
              <span className="text-tx1">
                [{r.start.toFixed(2)} – {r.end.toFixed(2)}]
              </span>
              <span className="text-tx3">({(r.end - r.start).toFixed(2)}s)</span>
              {current >= r.start - 0.25 && current <= r.end + 0.25 && (
                <span className="text-white">◀ playhead</span>
              )}
            </div>
            {gaps
              .filter((g) => Math.abs(g.at - r.end) < 0.001)
              .map((g, gi) => (
                <div key={gi} className="flex gap-2 pl-[54px] text-err">
                  ⚠ GAP {g.size.toFixed(3)}s @ {g.at.toFixed(2)}s
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
