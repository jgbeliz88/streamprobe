"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import MetricsBar from "./MetricsBar";
import LogView from "./LogView";
import TraceOverlay from "./TraceOverlay";
import { diagnoseSession } from "@/lib/diagnose";
import { isTv } from "@/lib/tv";
import { AUTOTRACE_STEPS } from "@/lib/deepLink";
import { ENGINES } from "@/lib/engines/registry";
import { setTestToken, type TokenScope } from "@/lib/engines/testToken";
import type { UsePlayer } from "@/hooks/usePlayer";
import type { EngineId, NetOverrides, PlayerState } from "@/lib/engines/types";

const DOT_CLASS: Record<PlayerState, string> = {
  idle: "bg-tx3",
  loading: "bg-ga animate-blink-load",
  playing: "bg-ga animate-blink-med",
  buffering: "bg-warn animate-blink-fast",
  paused: "bg-tx3",
  error: "bg-err",
};

interface Props {
  panel: "A" | "B";
  engine: EngineId;
  /** Requested/bundled version — shown until the engine reports the real one. */
  version: string;
  url: string;
  /** CDN header overrides — the Network panel needs them to fetch a body. */
  net: NetOverrides;
  player: UsePlayer;
  videoRef: RefObject<HTMLVideoElement>;
  /** Start with auto-trace on, every N seconds (from `?autotrace=`). 0 = off. */
  autotrace?: number;
}

/** Audio + subtitle track pickers (shown once the engine reports tracks). */
/** [LOC-TEST] DAI test bench: paste the Akamai token the front-end normally adds,
 * . The token is held in memory only
 *  (see lib/engines/testToken.ts) — never persisted, never in a URL. */
function DaiTestBench({ focusCls }: { focusCls: string }) {
  const [token, setToken] = useState("");
  const [scope, setScope] = useState<TokenScope>("manifest");

  // Push straight into the in-memory holder so the engine picks it up on its very
  // next request — including the first manifest GET after pressing Load.
  const push = (t: string, sc: TokenScope) => {
    setToken(t);
    setScope(sc);
    setTestToken(t, sc);
  };

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-warn/25 bg-warn/[.05] px-3 py-[7px]">
      <span className="text-[10px] font-semibold uppercase tracking-[.06em] text-warn">
        [LOC-TEST] DAI
      </span>
      <input
        type="text"
        value={token}
        onChange={(e) => push(e.target.value, scope)}
        placeholder="hdnts=exp=…~acl=…~hmac=…  (token de Akamai, con o sin ? &)"
        title="Se guarda solo en memoria. Vacío = comportamiento actual."
        className={`min-w-0 flex-1 rounded-[5px] border border-bd bg-sf2 px-[9px] py-[4px] font-mono text-[10px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
      />
      <select
        value={scope}
        onChange={(e) => push(token, e.target.value as TokenScope)}
        title="A qué peticiones se le añade el token"
        className={`fsel cursor-pointer rounded-[5px] border border-bd bg-sf2 px-[7px] py-[4px] font-mono text-[10px] text-tx1 outline-none ${focusCls}`}
      >
        <option value="manifest">Solo manifest</option>
        <option value="all">Manifest + segmentos</option>
      </select>
    </div>
  );
}

function TrackBar({ player, focusCls }: { player: UsePlayer; focusCls: string }) {
  const { audioTracks, textTracks, qualities } = player;
  if (audioTracks.length === 0 && textTracks.length === 0 && qualities.length === 0)
    return null;
  const activeAudio = audioTracks.find((t) => t.active)?.id ?? "";
  const activeText = textTracks.find((t) => t.active)?.id ?? "__off__";
  // No pinned rendition => ABR is driving.
  const activeQuality = qualities.find((t) => t.active)?.id ?? "__auto__";
  const sel =
    "fsel cursor-pointer rounded-[5px] border border-bd bg-sf2 px-[9px] py-[4px] font-mono text-[11px] text-tx1 outline-none " +
    focusCls;
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-bd bg-sf1 px-3 py-[7px]">
      {qualities.length > 0 && (
        <label className="flex items-center gap-[7px] text-[10px] font-semibold uppercase tracking-[.06em] text-tx3">
          🎞 Calidad
          <select
            className={sel}
            value={activeQuality}
            onChange={(e) =>
              player.selectQuality(e.target.value === "__auto__" ? null : e.target.value)
            }
            title="Fija una calidad concreta (desactiva el ABR) o deja que decida el ABR"
          >
            <option value="__auto__">Auto (ABR)</option>
            {qualities.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {audioTracks.length > 0 && (
        <label className="flex items-center gap-[7px] text-[10px] font-semibold uppercase tracking-[.06em] text-tx3">
          🔊 Audio
          <select
            className={sel}
            value={activeAudio}
            onChange={(e) => player.selectAudio(e.target.value)}
          >
            {audioTracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {textTracks.length > 0 && (
        <label className="flex items-center gap-[7px] text-[10px] font-semibold uppercase tracking-[.06em] text-tx3">
          💬 Subtítulos
          <select
            className={sel}
            value={activeText}
            onChange={(e) =>
              player.selectText(e.target.value === "__off__" ? null : e.target.value)
            }
          >
            <option value="__off__">Off</option>
            {textTracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export default function PlayerPanel({
  panel,
  engine,
  version,
  url,
  net,
  player,
  videoRef,
  autotrace,
}: Props) {
  const isA = panel === "A";
  // Version shown in the header + watermark. Bundled libraries ship the exact
  // version selected in the config, so that string is the real one.
  const shownVersion = version;
  const pidCls = isA
    ? "bg-ga/[.12] text-ga border-ga/30"
    : "bg-gb/[.12] text-gb border-gb/30";
  const btnHover = isA ? "hover:border-ga hover:text-ga" : "hover:border-gb hover:text-gb";
  const tagColor = isA ? "text-ga" : "text-gb";
  const [hud, setHud] = useState(false);
  const [hudSide, setHudSide] = useState<"left" | "right">("right");
  const [fullscreen, setFullscreen] = useState(false);
  // On a TV a download goes nowhere: JSON is hidden (Trazas → Mac sends the same
  // dump) and Report is sent to the Mac. Read after mount to keep SSR stable.
  const [onTv, setOnTv] = useState(false);
  useEffect(() => setOnTv(isTv()), []);
  // Feedback on the button itself — on a TV the Events log is often out of view.
  const [sending, setSending] = useState<Record<string, "busy" | "ok" | "err">>({});
  const sendWith = async (key: string, task: () => Promise<boolean>) => {
    setSending((s) => ({ ...s, [key]: "busy" }));
    const ok = await task();
    setSending((s) => ({ ...s, [key]: ok ? "ok" : "err" }));
    setTimeout(
      () => setSending(({ [key]: _done, ...rest }) => rest),
      4000
    );
  };
  // Auto-trace: opt-in, off by default. While on, the capture is re-sent every
  // N seconds and overwrites one "_live.json" file on the Mac, so it is always
  // current. The button cycles off → 10 s → 30 s → 60 s → off — OK on a remote.
  const [autoEvery, setAutoEvery] = useState(autotrace ?? 0);
  const [autoState, setAutoState] = useState<"ok" | "err" | null>(null);
  // Latest engine/url without restarting the timer whenever they change.
  const sendLive = useRef(() => player.sendTraces(engine, url, { live: true }));
  sendLive.current = () => player.sendTraces(engine, url, { live: true });
  useEffect(() => {
    if (!autoEvery) {
      setAutoState(null);
      return;
    }
    let busy = false;
    const tick = async () => {
      if (busy) return; // a slow send must not stack up behind the next one
      busy = true;
      const ok = await sendLive.current();
      busy = false;
      setAutoState(ok ? "ok" : "err");
    };
    tick();
    const id = setInterval(tick, autoEvery * 1000);
    return () => clearInterval(id);
  }, [autoEvery]);
  const cycleAuto = () =>
    setAutoEvery((s) => {
      const i = AUTOTRACE_STEPS.indexOf(s);
      return i === -1 ? AUTOTRACE_STEPS[0] : AUTOTRACE_STEPS[i + 1] ?? 0;
    });

  const sendLabel = (key: string, idle: string) =>
    ({ busy: "Enviando…", ok: "✓ En el Mac", err: "✕ Error" })[sending[key] ?? ""] ?? idle;
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fullscreen the video *container* (not the <video>), so overlays — the HUD,
  // the watermark — stay painted on top. Native <video> fullscreen would hide
  // them. The HUD is a fullscreen-only tool, so leaving fullscreen closes it.
  useEffect(() => {
    const onFsChange = () => {
      const fs = document.fullscreenElement === wrapRef.current;
      setFullscreen(fs);
      if (!fs) setHud(false);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrapRef.current?.requestFullscreen?.();
  };

  const diagnosis = useMemo(
    () =>
      diagnoseSession({
        running: player.running,
        metrics: player.metrics,
        samples: player.metricSamples,
        markers: player.chartMarkers,
        events: player.evLog.map((e) => ({ type: e.type, msg: e.msg })),
        manifests: player.manifests.map((m) => ({ isMultiperiod: m.isMultiperiod })),
      }),
    [player.running, player.metrics, player.metricSamples, player.chartMarkers, player.evLog, player.manifests]
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col border-b border-bd last:border-b-0 md:min-h-0 md:overflow-hidden md:border-b-0 md:border-r md:last:border-r-0">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between gap-[10px] border-b border-bd bg-sf1 px-3 py-[7px]">
        <div
          className={`flex-shrink-0 rounded-[4px] border px-2 py-[2px] font-mono text-[10px] font-semibold tracking-[.1em] ${pidCls}`}
        >
          {panel}
        </div>
        <div className="flex flex-1 items-center gap-[6px]">
          <div className={`h-[7px] w-[7px] flex-shrink-0 rounded-full ${DOT_CLASS[player.state]}`} />
          <span className="font-mono text-[10px] text-tx2">
            {player.state.toUpperCase()}
          </span>
          <span className={`font-mono text-[10px] font-semibold ${tagColor}`}>
            {ENGINES[engine].tag}
          </span>
          <span className="font-mono text-[10px] text-tx3">v{shownVersion}</span>
        </div>
        <div className="flex gap-[5px]">
          <button
            onClick={player.reset}
            className={`flex items-center gap-1 rounded-[4px] border border-bd px-2 py-[3px] text-[10px] text-tx2 transition ${btnHover}`}
          >
            ↺ Reset
          </button>
          {!onTv && (
            <button
              onClick={() => player.exportJSON(engine, url)}
              className={`flex items-center gap-1 rounded-[4px] border border-bd px-2 py-[3px] text-[10px] text-tx2 transition ${btnHover}`}
            >
              ⬇ JSON
            </button>
          )}
          <button
            onClick={() =>
              onTv
                ? sendWith("report", () => player.exportReport(engine, url, shownVersion))
                : player.exportReport(engine, url, shownVersion)
            }
            disabled={sending.report === "busy"}
            title={
              onTv
                ? "Envía al Mac un informe HTML de la sesión (carpeta ./traces)"
                : "Descarga un informe HTML de la sesión (QoE, gráfica, errores, manifests) para compartir"
            }
            className={`flex items-center gap-1 rounded-[4px] border border-bd px-2 py-[3px] text-[10px] text-tx2 transition ${btnHover}`}
          >
            {onTv ? sendLabel("report", "▤ Report → Mac") : "▤ Report"}
          </button>
          <button
            onClick={() => sendWith("traces", () => player.sendTraces(engine, url))}
            disabled={sending.traces === "busy"}
            title="Envía manifests, segmentos, cabeceras y eventos al Mac (carpeta ./traces). Pensado para la TV, donde descargar un fichero no sirve."
            className={`flex items-center gap-1 rounded-[4px] border border-bd px-2 py-[3px] text-[10px] text-tx2 transition ${btnHover}`}
          >
            {sendLabel("traces", "📡 Trazas → Mac")}
          </button>
          <button
            onClick={cycleAuto}
            title={
              autoEvery
                ? `Enviando las trazas al Mac cada ${autoEvery} s (traces/…_live.json, siempre la última). Pulsa para cambiar el intervalo o apagarlo.`
                : "Activa el envío automático de trazas al Mac: un único fichero traces/…_live.json que se actualiza solo."
            }
            className={`flex items-center gap-1 rounded-[4px] border px-2 py-[3px] text-[10px] transition ${
              autoEvery ? "border-ga/60 bg-ga/10 text-ga" : `border-bd text-tx2 ${btnHover}`
            }`}
          >
            {autoEvery
              ? `⟳ Auto ${autoEvery}s ${autoState === "err" ? "✕" : autoState === "ok" ? "✓" : "…"}`
              : "⟳ Auto"}
          </button>
        </div>
      </div>

      {/* Video */}
      <div
        ref={wrapRef}
        className={`relative flex-shrink-0 bg-black ${
          fullscreen ? "flex h-full w-full items-center justify-center" : ""
        }`}
      >
        <video
          ref={videoRef}
          controls
          // Declutter the native controls (download / cast / PiP). The native
          // fullscreen button is hidden via CSS instead — it only fullscreens the
          // <video>, where overlays like the HUD aren't painted; the ⛶ button
          // fullscreens the container so they stay on top.
          controlsList="nodownload noremoteplayback"
          disablePictureInPicture
          playsInline
          // tabIndex -1 keeps the D-pad out of the native media controls: on a TV
          // they swallow every remote press and focus can't get back out.
          // Playback is driven from Load/Stop anyway.
          tabIndex={-1}
          className={
            fullscreen
              ? "block h-full max-h-none w-full bg-black object-contain"
              : "block aspect-video max-h-[38vh] w-full bg-black"
          }
        />

        {/* HUD toggle — top-right, only in fullscreen (the HUD window docks just
            under it). The native fullscreen button is hidden via CSS. */}
        {player.running && fullscreen && (
          <button
            onClick={() => setHud((h) => !h)}
            title="Trazas en vivo superpuestas sobre el vídeo"
            className={`absolute right-2 top-2 z-30 flex items-center gap-1 rounded-[5px] border px-[9px] py-[4px] font-mono text-[11px] backdrop-blur-sm transition ${
              hud
                ? "border-ga bg-ga/25 text-ga"
                : "border-white/20 bg-black/50 text-white/90 hover:bg-black/70"
            }`}
          >
            ◉ HUD
          </button>
        )}

        {/* Fullscreen toggle — bottom-right corner, exactly where the native
            button used to sit (now removed), so there's a single one. */}
        {player.running && (
          <button
            onClick={toggleFullscreen}
            title={fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
            className="absolute bottom-2 right-2 z-30 flex items-center rounded-[5px] border border-white/20 bg-black/50 px-[9px] py-[5px] font-mono text-[13px] text-white/90 backdrop-blur-sm transition hover:bg-black/70"
          >
            {fullscreen ? "⤢" : "⛶"}
          </button>
        )}
        {/* Engine + version watermark, top-left over the picture. */}
        {player.running && (
          <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-[6px] rounded-[4px] border border-white/10 bg-black/55 px-[7px] py-[3px] font-mono text-[10px] leading-none backdrop-blur-sm">
            <span className={`font-semibold ${tagColor}`}>{ENGINES[engine].tag}</span>
            <span className="text-white/80">v{shownVersion}</span>
          </div>
        )}
        {!player.overlayHidden && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/[.88] font-mono text-xs text-tx2">
            <div className="text-center">
              <div className="mb-[6px] text-[32px] text-tx3">▶</div>
              <div>Configure a stream and click Load</div>
            </div>
          </div>
        )}
        {hud && (
          <TraceOverlay
            player={player}
            side={hudSide}
            onClose={() => setHud(false)}
            onSide={() => setHudSide((s) => (s === "right" ? "left" : "right"))}
          />
        )}
      </div>

      {/* Audio / subtitle tracks */}
      {engine === "gamdai" && (
        <DaiTestBench
          focusCls={isA ? "focus:border-ga" : "focus:border-gb"}
        />
      )}
      <TrackBar player={player} focusCls={isA ? "focus:border-ga" : "focus:border-gb"} />

      {/* Metrics */}
      <MetricsBar m={player.metrics} />

      {/* Logs — bounded box on phones (the page itself scrolls), fills the
          panel from md up */}
      <div className="flex h-[60vh] flex-col overflow-hidden md:h-auto md:min-h-0 md:flex-1">
        <LogView
          evLog={player.evLog}
          abrLog={player.abrLog}
          scteLog={player.scteLog}
          netLog={player.netLog}
          manifests={player.manifests}
          manifestError={player.manifestError}
          manifestLoading={player.manifestLoading}
          buffered={player.buffered}
          metricSamples={player.metricSamples}
          chartMarkers={player.chartMarkers}
          diagnosis={diagnosis}
          onClear={player.clear}
          net={net}
        />
      </div>
    </div>
  );
}
