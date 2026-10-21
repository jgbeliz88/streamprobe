"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { fmtBytes, fmtTime } from "@/lib/fmt";
import type { UsePlayer } from "@/hooks/usePlayer";
import type { LogType } from "@/lib/engines/types";

type Filter = "all" | "events" | "net" | "scte" | "manifest";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Todo" },
  { id: "events", label: "Eventos" },
  { id: "net", label: "Red" },
  { id: "scte", label: "SCTE" },
  { id: "manifest", label: "Manifests" },
];

const TYPE_COLOR: Record<LogType, string> = {
  info: "text-tx1",
  abr: "text-[#a78bfa]",
  buffer: "text-warn",
  error: "text-err",
  drm: "text-[#22d3ee]",
  warn: "text-warn",
  scte: "text-[#22d3ee]",
};

/** One row in the merged feed. */
interface Row {
  key: string;
  t: Date;
  tag: string;
  cls: string;
  text: string;
}

interface Props {
  player: UsePlayer;
  side: "left" | "right";
  onClose: () => void;
  onSide: () => void;
}

/**
 * Live trace HUD: a translucent panel docked over the video, so traces can be
 * followed while watching playback — the only practical way on a TV, where
 * DevTools aren't reachable.
 */
export default function TraceOverlay({ player, side, onClose, onSide }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [paused, setPaused] = useState(false);
  // Auto-follow the tail only while the user is sitting at the bottom. Scroll up
  // to read an older line and the feed stops yanking you back down.
  const stick = useRef(true);
  function onScroll() {
    const el = boxRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  }
  const boxRef = useRef<HTMLDivElement>(null);

  // Resizable size (px). Dragged from a corner handle; persists across side flips.
  const [size, setSize] = useState(() => ({
    w: 420,
    h: typeof window !== "undefined" ? Math.min(480, Math.round(window.innerHeight * 0.55)) : 460,
  }));

  const onResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const sw = size.w;
    const sh = size.h;
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      // Docked right → widen by dragging left; docked left → by dragging right.
      const dw = side === "right" ? startX - ev.clientX : ev.clientX - startX;
      const dh = ev.clientY - startY;
      setSize({
        w: Math.max(280, Math.min(sw + dw, window.innerWidth - 24)),
        h: Math.max(160, Math.min(sh + dh, window.innerHeight - 48)),
      });
    };
    const up = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (filter === "all" || filter === "events" || filter === "scte") {
      for (const [i, e] of player.evLog.entries()) {
        if (filter === "scte" && e.type !== "scte") continue;
        out.push({
          key: `e${i}`,
          t: e.time,
          tag: e.type.toUpperCase(),
          cls: TYPE_COLOR[e.type] ?? "text-tx1",
          text: e.msg,
        });
      }
    }
    if (filter === "all" || filter === "net") {
      for (const [i, n] of player.netLog.entries()) {
        const size = n.bytes != null ? ` · ${fmtBytes(n.bytes, "")}` : "";
        const ms = n.durationMs != null ? ` · ${n.durationMs}ms` : "";
        const hdr = n.sent ? " · hdr✓" : "";
        out.push({
          key: `n${i}`,
          t: n.time,
          tag: n.kind.toUpperCase(),
          cls: "text-white/80",
          text: `${n.url.split("/").pop() || n.url}${size}${ms}${hdr}`,
        });
      }
    }
    if (filter === "all" || filter === "manifest") {
      for (const m of player.manifests) {
        out.push({
          key: `m${m.id}`,
          t: m.time,
          tag: m.isMultiperiod ? `MPD·${m.periodCount}P` : "MPD",
          cls: m.isMultiperiod ? "text-warn" : "text-ga",
          text: `${m.format.toUpperCase()}${m.bytes ? ` · ${fmtBytes(m.bytes, "")}` : ""}${
            m.note ? ` · ${m.note}` : ""
          }`,
        });
      }
    }
    out.sort((a, b) => a.t.getTime() - b.t.getTime());
    return out.slice(-400); // keep the HUD light on TV hardware
  }, [player.evLog, player.netLog, player.manifests, filter]);

  // Follow the tail unless the user paused the feed or scrolled up to read.
  useLayoutEffect(() => {
    if (!paused && stick.current && boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [rows, paused]);

  const m = player.metrics;

  return (
    <div
      // Floating window docked just under the HUD button, resizable from the
      // inner-bottom corner. Half-transparent so the picture stays visible;
      // every text node inherits a shadow so it never washes out on bright video.
      style={{
        textShadow: "0 1px 2px rgba(0,0,0,.95), 0 0 5px rgba(0,0,0,.7)",
        width: size.w,
        height: size.h,
        maxWidth: "calc(100% - 1rem)",
        maxHeight: "calc(100% - 3rem)",
      }}
      className={`absolute top-11 z-20 flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black/45 backdrop-blur-md ${
        side === "right" ? "right-2" : "left-2"
      }`}
    >
      {/* Header */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-bd2 bg-sf1/70 px-3 py-2">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[.1em] text-ga">
          ◉ Trazas en vivo
        </span>
        <span className="font-mono text-[10px] text-white/60">{rows.length}</span>
        <div className="ml-auto flex gap-1">
          <button
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Reanudar auto-scroll" : "Congelar auto-scroll"}
            className={`rounded border px-2 py-[3px] font-mono text-[11px] transition ${
              paused
                ? "border-warn/50 bg-warn/15 text-warn"
                : "border-bd2 text-white/80 hover:text-tx1"
            }`}
          >
            {paused ? "▶" : "❚❚"}
          </button>
          <button
            onClick={onSide}
            title="Cambiar de lado"
            className="rounded border border-bd2 px-2 py-[3px] font-mono text-[11px] text-white/80 transition hover:text-tx1"
          >
            {side === "right" ? "⇤" : "⇥"}
          </button>
          <button
            onClick={onClose}
            title="Cerrar"
            className="rounded border border-bd2 px-2 py-[3px] font-mono text-[11px] text-white/80 transition hover:border-err hover:text-err"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Live metrics strip */}
      <div className="flex flex-shrink-0 flex-wrap gap-x-3 gap-y-1 border-b border-bd2 bg-sf1/40 px-3 py-[6px] font-mono text-[11px]">
        <span className="text-white/60">
          estado <span className="text-tx1">{m.state}</span>
        </span>
        <span className="text-white/60">
          bitrate <span className="text-tx1">{Math.round(m.bitrate / 1000)}k</span>
        </span>
        <span className="text-white/60">
          bw <span className="text-tx1">{Math.round(m.bw / 1000)}k</span>
        </span>
        {m.latency != null && (
          <span className="text-white/60">
            latencia <span className="text-tx1">{m.latency.toFixed(1)}s</span>
          </span>
        )}
        <span className="text-white/60">
          rebuf <span className={m.bufN > 0 ? "text-warn" : "text-tx1"}>{m.bufN}</span>
        </span>
        {m.dropped > 0 && (
          <span className="text-white/60">
            dropped <span className="text-warn">{m.dropped}</span>
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-bd2 px-2 py-[6px]">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`flex-shrink-0 rounded-full border px-[10px] py-[3px] text-[11px] transition ${
              filter === f.id
                ? "border-ga bg-ga/15 text-ga"
                : "border-bd2 text-white/80 hover:text-tx1"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Feed */}
      <div ref={boxRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {rows.length === 0 ? (
          <div className="p-4 text-center font-mono text-[12px] text-white/60">
            Sin trazas todavía…
          </div>
        ) : (
          rows.map((r) => (
            <div
              key={r.key}
              className="flex gap-2 border-b border-bd/30 py-[3px] font-mono text-[12px] leading-[1.5]"
            >
              <span className="flex-shrink-0 text-white/60">{fmtTime(r.t)}</span>
              <span className={`w-[64px] flex-shrink-0 text-[10px] ${r.cls}`}>{r.tag}</span>
              <span className="min-w-0 flex-1 break-words text-tx1">{r.text}</span>
            </div>
          ))
        )}
      </div>

      {/* Resize handle — inner-bottom corner (opposite the docked edge). */}
      <div
        onPointerDown={onResizeDown}
        title="Arrastra para redimensionar"
        className={`absolute bottom-0 z-30 flex h-5 w-5 items-end justify-start p-[3px] text-white/50 hover:text-white ${
          side === "right" ? "left-0 cursor-nesw-resize" : "right-0 scale-x-[-1] cursor-nwse-resize"
        }`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M9 1 L1 9 M9 5 L5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
