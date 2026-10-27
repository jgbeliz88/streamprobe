"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { fmtBytes, fmtTime } from "@/lib/fmt";
import { pressable } from "@/lib/tv";
import { proxifyUrl } from "@/lib/proxy";
import ManifestView from "./ManifestView";
import BufferView from "./BufferView";
import MetricsChart from "./MetricsChart";
import VerdictView from "./VerdictView";
import type { Diagnosis } from "@/lib/diagnose";
import type { LogEntry, BufferedState } from "@/hooks/usePlayer";
import type { CapturedManifest } from "@/lib/manifest";
import type {
  ChartMarker,
  LogType,
  MetricSample,
  NetOverrides,
  NetworkEntry,
  NetworkKind,
} from "@/lib/engines/types";
import { apiUrl } from "@/lib/apiBase";

const TYPE_COLOR: Record<LogType, string> = {
  info: "text-tx2",
  abr: "text-ga",
  buffer: "text-warn",
  error: "text-err",
  drm: "text-[#a855f7]",
  warn: "text-warn",
  scte: "text-[#22d3ee]",
};

const KIND_COLOR: Record<NetworkKind, string> = {
  manifest: "text-gb",
  segment: "text-ga",
  init: "text-tx2",
  license: "text-[#a855f7]",
  other: "text-tx3",
};

type Tab = "verdict" | "chart" | "events" | "abr" | "scte" | "net" | "manifest" | "buffer";

function shortUrl(u: string): string {
  try {
    const parts = u.split("?")[0].split("/");
    return parts[parts.length - 1] || u;
  } catch {
    return u;
  }
}

/** Expanded Network row: everything known about the request, plus the body for
 *  playlists. The body is served from the proxy's own stash when available, so
 *  opening a GAM DAI manifest does NOT re-request it upstream (that would break
 *  the session); only if it isn't stashed do we fetch it through the proxy. */
function NetDetail({ entry, net }: { entry: NetworkEntry; net: NetOverrides }) {
  const [body, setBody] = useState<{
    loading: boolean;
    text?: string;
    err?: string;
    from?: string;
  }>({ loading: false });
  const isText =
    entry.kind === "manifest" || /\.(m3u8|mpd|vtt|webvtt|json|xml)($|\?)/i.test(entry.url);

  async function loadBody() {
    setBody({ loading: true });
    try {
      const peek = await fetch(apiUrl(`/api/proxy?peek=${encodeURIComponent(entry.url)}`)).then((r) =>
        r.json()
      );
      if (peek?.found) {
        setBody({ loading: false, text: peek.text, from: "desde la reserva del proxy (sin volver a pedirlo)" });
        return;
      }
      const r = await fetch(proxifyUrl(entry.url, net));
      const t = await r.text();
      setBody({ loading: false, text: t, from: `descargado ahora · HTTP ${r.status}` });
    } catch (e: any) {
      setBody({ loading: false, err: e?.message || String(e) });
    }
  }

  const row = (k: string, v: React.ReactNode) => (
    <div className="flex gap-2">
      <span className="w-[62px] flex-shrink-0 text-tx3">{k}</span>
      <span className="flex-1 break-all text-tx1">{v}</span>
    </div>
  );

  return (
    <div className="border-y border-bd bg-bg px-3 py-2 leading-[1.7]">
      {row("URL", entry.url)}
      {row("Tipo", `${entry.kind}${entry.mediaType ? ` · ${entry.mediaType}` : ""}`)}
      {row("Status", entry.status != null ? `HTTP ${entry.status}` : "desconocido")}
      {row("Tamaño", fmtBytes(entry.bytes))}
      {row("Duración", entry.durationMs != null ? `${entry.durationMs} ms` : "—")}
      {entry.sent &&
        row(
          "Cabeceras",
          [
            entry.sent.origin && `Origin: ${entry.sent.origin}`,
            entry.sent.referer && `Referer: ${entry.sent.referer}`,
            entry.sent.userAgent && `UA: ${entry.sent.userAgent}`,
          ]
            .filter(Boolean)
            .join(" · ")
        )}
      {isText && (
        <div className="mt-2">
          {!body.text && !body.loading && !body.err && (
            <button
              onClick={loadBody}
              className="rounded border border-bd bg-sf2 px-2 py-[3px] text-tx2 transition hover:border-ga hover:text-ga"
            >
              Ver contenido
            </button>
          )}
          {body.loading && <span className="text-tx3">Cargando…</span>}
          {body.err && <span className="text-err">No se pudo leer: {body.err}</span>}
          {body.text != null && (
            <>
              <div className="mb-1 text-tx3">{body.from}</div>
              <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-all rounded border border-bd2 bg-sf1 p-2 text-tx1">
                {body.text}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function LogView({
  evLog,
  abrLog,
  scteLog,
  netLog,
  manifests,
  manifestError,
  manifestLoading,
  buffered,
  metricSamples,
  chartMarkers,
  diagnosis,
  onClear,
  net,
}: {
  evLog: LogEntry[];
  abrLog: LogEntry[];
  scteLog: LogEntry[];
  netLog: NetworkEntry[];
  manifests: CapturedManifest[];
  manifestError: string | null;
  manifestLoading: boolean;
  buffered: BufferedState;
  metricSamples: MetricSample[];
  chartMarkers: ChartMarker[];
  diagnosis: Diagnosis;
  onClear: (kind: "events" | "abr" | "scte" | "net" | "manifest") => void;
  net: NetOverrides;
}) {
  const [tab, setTab] = useState<Tab>("verdict");
  const [openNet, setOpenNet] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll anchoring: only follow the live edge if the user is already sitting on
  // it. If they scrolled away to read an older entry, keep their view put — new
  // traces must not yank the panel back to the edge.
  const stick = useRef(true);
  // Reading with the pointer over the panel must never be interrupted: while it's
  // inside we stop following the live edge entirely (for the newest-at-top Network
  // list we still compensate the prepend offset, so rows don't slide either).
  const hovering = useRef(false);
  const prevHeight = useRef(0);
  const prevTab = useRef(tab);

  const logArr = tab === "abr" ? abrLog : tab === "scte" ? scteLog : evLog;
  const count = tab === "net" ? netLog.length : logArr.length;

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // "net" is newest-at-top, everything else is newest-at-bottom.
    stick.current =
      tab === "net"
        ? el.scrollTop <= 24
        : el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const tabChanged = prevTab.current !== tab;
    prevTab.current = tab;
    if (tabChanged) stick.current = true; // snap to the live edge when switching tabs
    const follow = stick.current && !hovering.current;

    if (tab === "net") {
      // Newest prepends at the top: sitting at the top → stay showing newest;
      // scrolled down → push scrollTop by the height the new rows added so the
      // rows the user is reading don't slide out from under them.
      if (follow) el.scrollTop = 0;
      else el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (follow) {
      el.scrollTop = el.scrollHeight; // newest appends at the bottom
    }
    prevHeight.current = el.scrollHeight;
  }, [count, tab]);

  const verdictLabel =
    diagnosis.verdict === "fail"
      ? "Verdict ✕"
      : diagnosis.verdict === "warn"
        ? "Verdict !"
        : diagnosis.verdict === "pass"
          ? "Verdict ✓"
          : "Verdict";
  const TABS: { id: Tab; label: string }[] = [
    { id: "verdict", label: verdictLabel },
    { id: "chart", label: "Chart" },
    { id: "events", label: "Events" },
    { id: "abr", label: "ABR switches" },
    { id: "scte", label: scteLog.length ? `SCTE-35 (${scteLog.length})` : "SCTE-35" },
    { id: "buffer", label: "Buffer" },
    { id: "net", label: "Network" },
    {
      id: "manifest",
      label: manifests.length ? `Manifest (${manifests.length})` : "Manifest",
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-shrink-0 items-center border-b border-bd bg-sf1">
        {/* Buttons, not divs: on a TV the remote can only reach focusable elements. */}
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`cursor-pointer border-b-2 px-3 py-[5px] text-[10px] font-semibold uppercase tracking-[.05em] transition ${
              tab === t.id
                ? "border-ga text-tx1"
                : "border-transparent text-tx3 hover:text-tx2"
            }`}
          >
            {t.label}
          </button>
        ))}
        {tab !== "buffer" && tab !== "chart" && tab !== "verdict" && (
          <button
            onClick={() => onClear(tab)}
            title={`Clear ${tab}`}
            className="ml-auto mr-2 rounded border border-bd px-2 py-[2px] text-[10px] text-tx2 transition hover:border-err hover:text-err"
          >
            ✕ Clear
          </button>
        )}
      </div>

      {tab === "verdict" ? (
        <VerdictView diagnosis={diagnosis} />
      ) : tab === "chart" ? (
        <div className="min-h-0 flex-1">
          <MetricsChart samples={metricSamples} markers={chartMarkers} />
        </div>
      ) : tab === "manifest" ? (
        <div className="min-h-0 flex-1">
          <ManifestView
            manifests={manifests}
            error={manifestError}
            loading={manifestLoading}
          />
        </div>
      ) : tab === "buffer" ? (
        <div className="min-h-0 flex-1">
          <BufferView buffered={buffered} />
        </div>
      ) : (
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onPointerEnter={() => (hovering.current = true)}
        onPointerLeave={() => (hovering.current = false)}
        className="flex-1 overflow-y-auto px-2 py-[6px] font-mono text-[10px] leading-[1.8]"
      >
        {tab === "net" ? (
          netLog.length === 0 ? (
            <div className="p-5 text-center text-tx3">No network activity yet</div>
          ) : (
            <>
              {netLog.slice(-400).reverse().map((e) => {
                // Key on identity, not index: new entries prepend, so an index
                // would move the expanded row under the user.
                const rowKey = `${e.time.getTime()}|${e.url}`;
                const open = openNet === rowKey;
                return (
                  <div key={rowKey}>
                    <div
                      {...pressable(() => setOpenNet(open ? null : rowKey))}
                      className={`flex cursor-pointer gap-2 py-px hover:bg-sf2 ${open ? "bg-sf2" : ""}`}
                      title="Pulsa para ver el detalle"
                    >
                  <span className="w-[55px] flex-shrink-0 text-tx3">
                    {fmtTime(e.time)}
                  </span>
                  <span
                    className={`w-[58px] flex-shrink-0 ${KIND_COLOR[e.kind]}`}
                  >
                    {e.kind.toUpperCase()}
                  </span>
                  <span className="w-[38px] flex-shrink-0 text-tx2">
                    {e.mediaType ? e.mediaType.slice(0, 3) : "—"}
                  </span>
                  <span
                    className={`w-[30px] flex-shrink-0 text-right ${
                      e.status == null
                        ? "text-tx3"
                        : e.status >= 400
                          ? "font-semibold text-err"
                          : "text-ga"
                    }`}
                    title={e.status != null ? `HTTP ${e.status}` : "status desconocido"}
                  >
                    {e.status ?? "—"}
                  </span>
                  <span className="w-[52px] flex-shrink-0 text-right text-tx1">
                    {fmtBytes(e.bytes)}
                  </span>
                  <span className="w-[46px] flex-shrink-0 text-right text-tx2">
                    {e.durationMs != null ? `${e.durationMs}ms` : "—"}
                  </span>
                  {e.sent ? (
                    <span
                      className="w-[34px] flex-shrink-0 text-center text-[#22d3ee]"
                      title={
                        "Injected headers:\n" +
                        [
                          e.sent.origin && `Origin: ${e.sent.origin}`,
                          e.sent.referer && `Referer: ${e.sent.referer}`,
                          e.sent.userAgent && `User-Agent: ${e.sent.userAgent}`,
                        ]
                          .filter(Boolean)
                          .join("\n")
                      }
                    >
                      hdr✓
                    </span>
                  ) : (
                    <span className="w-[34px] flex-shrink-0 text-center text-tx3">
                      —
                    </span>
                  )}
                  <span className="flex-1 truncate text-tx2">
                    {open ? "▾ " : "▸ "}
                    {shortUrl(e.url)}
                  </span>
                    </div>
                    {open && <NetDetail entry={e} net={net} />}
                  </div>
                );
              })}
            </>
          )
        ) : logArr.length === 0 ? (
          <div className="p-5 text-center text-tx3">
            {tab === "abr"
              ? "No ABR switches yet"
              : tab === "scte"
                ? "No SCTE-35 / DASH events yet"
                : "Waiting for stream…"}
          </div>
        ) : (
          <>
            {logArr.slice(-300).map((e, i) => (
              <div key={i} className="flex gap-2 py-px hover:bg-sf2">
                <span className="w-[55px] flex-shrink-0 text-tx3">
                  {fmtTime(e.time)}
                </span>
                <span className={`w-[62px] flex-shrink-0 ${TYPE_COLOR[e.type]}`}>
                  {e.type.toUpperCase()}
                </span>
                <span className="flex-1 break-all text-tx1">{e.msg}</span>
              </div>
            ))}
          </>
        )}
      </div>
      )}
    </div>
  );
}
