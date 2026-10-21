"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { createEngine } from "@/lib/engines";
import { fmtBps, fmtMs } from "@/lib/fmt";
import { buildSessionReport, type ReportData } from "@/lib/report";
import { isTv } from "@/lib/tv";
import { diagnoseSession } from "@/lib/diagnose";
import { ENGINES } from "@/lib/engines/registry";
import {
  checkContinuity,
  countPeriods,
  detectFormatFromText,
  parseDashInfo,
  type CapturedManifest,
} from "@/lib/manifest";
import type { EngineManifest, NetOverrides } from "@/lib/engines/types";
import { proxifyUrl } from "@/lib/proxy";
import type {
  ChartMarker,
  EngineController,
  EngineId,
  LoadConfig,
  LogType,
  MetricSample,
  Metrics,
  NetworkEntry,
  PlayerState,
  TrackInfo,
} from "@/lib/engines/types";

export interface LogEntry {
  time: Date;
  type: LogType;
  msg: string;
}

export interface BufferedState {
  ranges: { start: number; end: number }[];
  current: number;
  duration: number; // 0 when live / unknown
  seekableStart: number | null;
  seekableEnd: number | null; // live edge for live streams
}

const EMPTY_BUFFERED: BufferedState = {
  ranges: [],
  current: 0,
  duration: 0,
  seekableStart: null,
  seekableEnd: null,
};

const EMPTY_METRICS: Metrics = {
  join: null,
  bufN: 0,
  bufMs: 0,
  bitrate: 0,
  bw: 0,
  latency: null,
  dropped: 0,
  state: "idle",
};

// Rolling-window caps: on a long live session every log grows unbounded (netLog
// gets an entry per segment request), which eventually freezes the UI and makes
// it look like capture "stopped". Keep the newest N and drop the rest.
const LOG_LIMIT = 2000; // events / abr / scte / network
const MANIFEST_LIMIT = 2000; // captured MPDs (each holds full text) — newest kept

/** Rough device name from the UA, used to label exported traces. */
function deviceLabel(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/Web0S|webOS/i.test(ua)) return "LG-webOS";
  if (/Tizen/i.test(ua)) return "Samsung-Tizen";
  if (/iPhone|iPad/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  return "desktop";
}

export interface UsePlayer {
  metrics: Metrics;
  state: PlayerState;
  evLog: LogEntry[];
  abrLog: LogEntry[];
  scteLog: LogEntry[];
  netLog: NetworkEntry[];
  manifests: CapturedManifest[];
  manifestError: string | null;
  manifestLoading: boolean;
  buffered: BufferedState;
  running: boolean;
  overlayHidden: boolean;
  audioTracks: TrackInfo[];
  textTracks: TrackInfo[];
  qualities: TrackInfo[];
  /** Playback timeline: bitrate / bandwidth / buffer sampled over time. */
  metricSamples: MetricSample[];
  /** Stall / error points to mark on the timeline. */
  chartMarkers: ChartMarker[];
  load: (engine: EngineId, cfg: LoadConfig) => Promise<void>;
  stop: () => void;
  reset: () => void;
  clear: (kind: "events" | "abr" | "scte" | "net" | "manifest") => void;
  selectAudio: (id: string) => void;
  selectText: (id: string | null) => void;
  selectQuality: (id: string | null) => void;
  exportJSON: (engine: EngineId, url: string) => void;
  /** Downloads the report, or on a TV sends it to the Mac. Resolves to success. */
  exportReport: (engine: EngineId, url: string, version: string) => Promise<boolean>;
  /**
   * Resolves to whether the Mac saved them. `live` overwrites one fixed file per
   * device/engine/panel and logs nothing on success (it runs on a timer).
   */
  sendTraces: (engine: EngineId, url: string, opts?: { live?: boolean }) => Promise<boolean>;
}

export function usePlayer(
  videoRef: RefObject<HTMLVideoElement>,
  panelId: string
): UsePlayer {
  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [state, setStateVal] = useState<PlayerState>("idle");
  const [evLog, setEvLog] = useState<LogEntry[]>([]);
  const [abrLog, setAbrLog] = useState<LogEntry[]>([]);
  const [scteLog, setScteLog] = useState<LogEntry[]>([]);
  const [netLog, setNetLog] = useState<NetworkEntry[]>([]);
  const [manifests, setManifests] = useState<CapturedManifest[]>([]);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [audioTracks, setAudioTracks] = useState<TrackInfo[]>([]);
  const [textTracks, setTextTracks] = useState<TrackInfo[]>([]);
  const [qualities, setQualities] = useState<TrackInfo[]>([]);
  const [metricSamples, setMetricSamples] = useState<MetricSample[]>([]);
  const [chartMarkers, setChartMarkers] = useState<ChartMarker[]>([]);
  const samplesRef = useRef<MetricSample[]>([]);
  const markersRef = useRef<ChartMarker[]>([]);
  const manifestSeqRef = useRef(0);
  const seamSigRef = useRef("");
  const urlRef = useRef("");
  const [overlayHidden, setOverlayHidden] = useState(false);
  const [buffered, setBuffered] = useState<BufferedState>(EMPTY_BUFFERED);

  const mRef = useRef<Metrics>(EMPTY_METRICS);
  const ctrlRef = useRef<EngineController | null>(null);
  const engineRef = useRef<EngineId>("shaka");
  const loadTRef = useRef<number | null>(null);
  const firstPlayRef = useRef(true);
  const bufTRef = useRef<number | null>(null);
  const framesIvRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const listenersRef = useRef<Record<string, (() => void) | null>>({});

  const patchMetrics = useCallback((patch: Partial<Metrics>) => {
    mRef.current = { ...mRef.current, ...patch };
    setMetrics(mRef.current);
  }, []);

  const setState = useCallback((s: PlayerState) => {
    // Mark stall / error onsets on the timeline chart (transition only, so a
    // sustained buffering state doesn't spam markers).
    const prev = mRef.current.state;
    // Mark real rebuffers (buffering after playback began) and errors — but not
    // the initial startup buffering, which isn't a stall.
    const isStall = s === "buffering" && !firstPlayRef.current;
    if (s !== prev && (isStall || s === "error") && loadTRef.current) {
      const t = (Date.now() - loadTRef.current) / 1000;
      const marker: ChartMarker = { t, kind: s === "error" ? "error" : "stall" };
      markersRef.current = [...markersRef.current, marker].slice(-200);
      setChartMarkers(markersRef.current);
    }
    mRef.current = { ...mRef.current, state: s };
    setStateVal(s);
  }, []);

  const log = useCallback((type: LogType, msg: string) => {
    const e: LogEntry = { time: new Date(), type, msg };
    setEvLog((prev) => [...prev, e].slice(-LOG_LIMIT));
    if (type === "abr") setAbrLog((prev) => [...prev, e].slice(-LOG_LIMIT));
    if (type === "scte") setScteLog((prev) => [...prev, e].slice(-LOG_LIMIT));
  }, []);

  const pushManifest = useCallback(
    (input: EngineManifest, source: "fetch" | "engine") => {
      const { text } = input;
      const format = detectFormatFromText(text, urlRef.current, input.format);
      const dash = format === "dash" ? parseDashInfo(text) ?? undefined : undefined;
      let periodCount = input.periodCount;
      if (periodCount == null && format === "dash")
        periodCount = dash ? dash.periods.length : countPeriods(text);
      const isMultiperiod = (periodCount ?? 0) > 1;
      const entry: CapturedManifest = {
        id: manifestSeqRef.current++,
        time: new Date(),
        format,
        periodCount,
        isMultiperiod,
        text,
        bytes: input.bytes,
        note: input.note,
        source,
        dash,
      };
      // Newest first; keep a large history so long sessions stay reviewable.
      setManifests((prev) => [entry, ...prev].slice(0, MANIFEST_LIMIT));

      // Live timestamp-consistency alert (de-duped). Catches both cases of the
      // multiperiod→one-period conversion going wrong:
      //  - multiperiod: content doesn't concord across an ad-break seam;
      //  - one-period: timestamps jump inside the stitched timeline, or the
      //    video/audio tracks fall out of alignment.
      if (dash) {
        const issues: string[] = [];
        for (let i = 1; i < dash.periods.length; i++) {
          const c = checkContinuity(dash.periods[i - 1], dash.periods[i]);
          if (c && !c.continuous) issues.push(`costura P${i - 1}→P${i}: ${c.reasons.join("; ")}`);
        }
        for (const p of dash.periods) {
          const vb = p.timeline?.internalBreaks ?? [];
          const ab = p.audioTimeline?.internalBreaks ?? [];
          if (vb.length) issues.push(`P${p.index} salto de timestamps en vídeo (${vb.map((b) => b.deltaSec.toFixed(2) + "s").join(",")})`);
          if (ab.length) issues.push(`P${p.index} salto de timestamps en audio (${ab.map((b) => b.deltaSec.toFixed(2) + "s").join(",")})`);
          if (Math.abs(p.vaStartSkewSec ?? 0) > 0.05 || Math.abs(p.vaEndSkewSec ?? 0) > 0.05)
            issues.push(`P${p.index} vídeo/audio desalineados ${(p.vaStartSkewSec ?? 0).toFixed(2)}s`);
        }
        const sig = `${dash.periods.length}|${issues.join(" | ")}`;
        if (sig !== seamSigRef.current) {
          seamSigRef.current = sig;
          if (issues.length)
            log("scte", `⚠ Inconsistencia de timestamps (posible stall en TV): ${issues.join(" · ")}`);
          else if (dash.periods.length > 1)
            log("scte", `Multiperiod (${dash.periods.length}) — timestamps consistentes`);
        }
      }
    },
    [log]
  );

  const fetchManifest = useCallback(
    async (url: string, net?: NetOverrides) => {
      setManifestError(null);
      setManifestLoading(true);
      try {
        const res = await fetch(proxifyUrl(url, net));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        pushManifest({ text }, "fetch");
        const fmt = detectFormatFromText(text, url);
        if (fmt === "dash") {
          const n = countPeriods(text);
          log("info", n > 1 ? `MPD multi-period — ${n} periods` : "MPD single-period");
        }
      } catch (e: any) {
        setManifestError(
          "Could not fetch initial manifest (CORS or network): " + (e?.message || e)
        );
      } finally {
        setManifestLoading(false);
      }
    },
    [log, pushManifest]
  );

  const clearFrames = useCallback(() => {
    if (framesIvRef.current) {
      clearInterval(framesIvRef.current);
      framesIvRef.current = null;
    }
  }, []);

  const detachListeners = useCallback(() => {
    const v = videoRef.current;
    const L = listenersRef.current;
    if (v) {
      (["waiting", "playing", "pause", "ended"] as const).forEach((ev) => {
        if (L[ev]) v.removeEventListener(ev, L[ev]!);
      });
    }
    listenersRef.current = {};
  }, [videoRef]);

  const attachListeners = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    detachListeners();

    const onWaiting = () => {
      if (!bufTRef.current) {
        bufTRef.current = Date.now();
        patchMetrics({ bufN: mRef.current.bufN + 1 });
        setState("buffering");
        log("buffer", `Buffering started — event #${mRef.current.bufN}`);
      }
    };
    const onPlaying = () => {
      if (firstPlayRef.current && loadTRef.current) {
        const join = Date.now() - loadTRef.current;
        patchMetrics({ join });
        firstPlayRef.current = false;
        log("info", `First frame — join time: ${fmtMs(join)}`);
        setOverlayHidden(true);
      }
      if (bufTRef.current) {
        const d = Date.now() - bufTRef.current;
        patchMetrics({ bufMs: mRef.current.bufMs + d });
        bufTRef.current = null;
        log("buffer", `Buffering ended — duration: ${fmtMs(d)}`);
      }
      setState("playing");
    };
    const onPause = () => setState("paused");
    const onEnded = () => {
      setState("idle");
      log("info", "Stream ended");
    };

    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);
    listenersRef.current = {
      waiting: onWaiting,
      playing: onPlaying,
      pause: onPause,
      ended: onEnded,
    };
  }, [videoRef, detachListeners, patchMetrics, setState, log]);

  const startFramePoll = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    clearFrames();
    framesIvRef.current = setInterval(() => {
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      if (q) patchMetrics({ dropped: q.droppedVideoFrames });
      try {
        const b = v.buffered;
        const ranges: { start: number; end: number }[] = [];
        for (let i = 0; i < b.length; i++) {
          ranges.push({ start: b.start(i), end: b.end(i) });
        }
        let seekableStart: number | null = null;
        let seekableEnd: number | null = null;
        try {
          const s = v.seekable;
          if (s.length) {
            seekableStart = s.start(0);
            seekableEnd = s.end(s.length - 1);
          }
        } catch {
          /* seekable unavailable */
        }
        setBuffered({
          ranges,
          current: v.currentTime,
          duration: isFinite(v.duration) ? v.duration : 0,
          seekableStart,
          seekableEnd,
        });

        // Timeline sample: seconds of media buffered ahead of the playhead, plus
        // the current bitrate / bandwidth held in the metrics ref. Only sample
        // once playback has actually begun — sampling (and its 500 ms re-render)
        // during the load window steals the single autoplay gesture from the
        // second <video> in an A/B compare, so it would never start.
        if (!firstPlayRef.current) {
          const ahead = ranges.find(
            (rg) => v.currentTime >= rg.start - 0.5 && v.currentTime <= rg.end
          );
          const buffer = ahead ? Math.max(0, ahead.end - v.currentTime) : 0;
          const t = loadTRef.current ? (Date.now() - loadTRef.current) / 1000 : 0;
          samplesRef.current = [
            ...samplesRef.current,
            { t, bitrate: mRef.current.bitrate, bw: mRef.current.bw, buffer },
          ].slice(-1800); // ~15 min at 500 ms
          setMetricSamples(samplesRef.current);
        }
      } catch {
        /* buffered unavailable */
      }
    }, 500);
  }, [videoRef, clearFrames, patchMetrics]);

  const stop = useCallback(() => {
    clearFrames();
    detachListeners();
    try {
      ctrlRef.current?.destroy();
    } catch {
      /* noop */
    }
    ctrlRef.current = null;
    const v = videoRef.current;
    if (v) {
      v.removeAttribute("src");
      v.load();
    }
    setOverlayHidden(false);
    setRunning(false);
    setState("idle");
    log("info", "Stream stopped");
  }, [videoRef, clearFrames, detachListeners, setState, log]);

  const load = useCallback(
    async (engine: EngineId, cfg: LoadConfig) => {
      const v = videoRef.current;
      if (!v) return;
      // gamdai has no URL — it fetches the stitched URL from GAM at runtime.
      if (!cfg.url && engine !== "gamdai") {
        log("error", "No URL specified");
        return;
      }
      if (ctrlRef.current) stop();

      engineRef.current = engine;
      urlRef.current = cfg.url;
      mRef.current = { ...EMPTY_METRICS };
      setMetrics(mRef.current);
      setNetLog([]);
      setScteLog([]);
      setManifests([]);
      setBuffered(EMPTY_BUFFERED);
      setAudioTracks([]);
      setTextTracks([]);
      setQualities([]);
      samplesRef.current = [];
      markersRef.current = [];
      setMetricSamples([]);
      setChartMarkers([]);
      firstPlayRef.current = true;
      bufTRef.current = null;
      loadTRef.current = Date.now();

      setRunning(true);
      setOverlayHidden(false);
      setState("loading");
      attachListeners();
      startFramePoll();
      // gamdai has no URL of its own; the leftover url field is unrelated, so
      // don't fetch it (it would spuriously capture e.g. the default MPD).
      if (cfg.url && engine !== "gamdai") fetchManifest(cfg.url, cfg.net);

      const ctrl = createEngine(engine, {
        onLog: log,
        onAbr: (prev, curr, dims) => {
          const dir = curr > prev ? "↑" : "↓";
          const dimsTxt = dims ? ` [${dims.w || "?"}×${dims.h || "?"}]` : "";
          log("abr", `ABR ${dir} ${fmtBps(prev)} → ${fmtBps(curr)}${dimsTxt}`);
        },
        onMetrics: patchMetrics,
        onState: setState,
        onNetwork: (entry) => setNetLog((prev) => [...prev, entry].slice(-LOG_LIMIT)),
        onManifest: (m) => pushManifest(m, "engine"),
        onTracks: (a, t) => {
          setAudioTracks(a);
          setTextTracks(t);
        },
        onQualities: setQualities,
      });
      ctrlRef.current = ctrl;

      try {
        await ctrl.load(v, cfg);
      } catch (e: any) {
        log("error", "Init failed: " + (e?.message || e));
        setState("error");
        clearFrames();
        setRunning(false);
      }
    },
    [videoRef, stop, attachListeners, startFramePoll, fetchManifest, pushManifest, log, patchMetrics, setState, clearFrames]
  );

  const reset = useCallback(() => {
    mRef.current = { ...EMPTY_METRICS, state: mRef.current.state };
    setMetrics(mRef.current);
    firstPlayRef.current = true;
    loadTRef.current = null;
    bufTRef.current = null;
    setEvLog([]);
    setAbrLog([]);
    setScteLog([]);
    setNetLog([]);
    setManifests([]);
    log("info", "Metrics reset");
  }, [log]);

  const clear = useCallback(
    (kind: "events" | "abr" | "scte" | "net" | "manifest") => {
      if (kind === "events") setEvLog([]);
      else if (kind === "abr") setAbrLog([]);
      else if (kind === "scte") setScteLog([]);
      else if (kind === "net") setNetLog([]);
      else if (kind === "manifest") setManifests([]);
    },
    []
  );

  const selectAudio = useCallback((id: string) => {
    ctrlRef.current?.selectAudio?.(id);
  }, []);
  const selectQuality = useCallback((id: string | null) => {
    ctrlRef.current?.selectQuality?.(id);
  }, []);
  const selectText = useCallback((id: string | null) => {
    ctrlRef.current?.selectText?.(id);
  }, []);

  /** Everything captured this session — manifests included, so a trace taken on
   *  a TV can be replayed/inspected later on the desktop. */
  const buildDump = useCallback(
    (engine: EngineId, url: string) => ({
      timestamp: new Date().toISOString(),
      panel: panelId,
      engine: ENGINES[engine].tag,
      url,
      device: {
        label: deviceLabel(),
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        screen:
          typeof window !== "undefined"
            ? `${window.screen?.width}x${window.screen?.height}`
            : "",
      },
      metrics: mRef.current,
      abrSwitches: abrLog.map((e) => ({ time: e.time.toISOString(), msg: e.msg })),
      scte35: scteLog.map((e) => ({ time: e.time.toISOString(), msg: e.msg })),
      network: netLog.map((e) => ({
        time: e.time.toISOString(),
        kind: e.kind,
        mediaType: e.mediaType,
        url: e.url,
        bytes: e.bytes,
        durationMs: e.durationMs,
        sentHeaders: e.sent, // headers the proxy injected on this request
      })),
      events: evLog.map((e) => ({
        time: e.time.toISOString(),
        type: e.type,
        msg: e.msg,
      })),
      manifests: manifests.map((m) => ({
        time: m.time.toISOString(),
        format: m.format,
        source: m.source,
        periodCount: m.periodCount,
        isMultiperiod: m.isMultiperiod,
        bytes: m.bytes,
        note: m.note,
        periods: m.dash?.periods,
        text: m.text, // full manifest body
      })),
    }),
    [abrLog, scteLog, evLog, netLog, manifests, panelId]
  );

  const exportJSON = useCallback(
    (engine: EngineId, url: string) => {
      const blob = new Blob([JSON.stringify(buildDump(engine, url), null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `streamprobe_${panelId}_${Date.now()}.json`;
      a.click();
    },
    [buildDump, panelId]
  );

  /** A shareable, self-contained HTML report of the session — QoE summary,
   *  timeline chart, errors and manifests — for sending to devs / the CDN team. */
  const exportReport = useCallback(
    async (engine: EngineId, url: string, version: string) => {
      const m = mRef.current;
      const diagnosis = diagnoseSession({
        running: true,
        metrics: m,
        samples: samplesRef.current,
        markers: markersRef.current,
        events: evLog.map((e) => ({ type: e.type, msg: e.msg })),
        manifests: manifests.map((mn) => ({ isMultiperiod: mn.isMultiperiod })),
      });
      const data: ReportData = {
        timestamp: new Date().toISOString(),
        panel: panelId,
        engine: ENGINES[engine].tag,
        version,
        url,
        diagnosis,
        device: {
          label: deviceLabel(),
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
          screen:
            typeof window !== "undefined"
              ? `${window.screen?.width}x${window.screen?.height}`
              : "",
        },
        metrics: {
          join: m.join,
          bufN: m.bufN,
          bufMs: m.bufMs,
          dropped: m.dropped,
          latency: m.latency,
          bitrate: m.bitrate,
        },
        samples: samplesRef.current,
        markers: markersRef.current,
        events: evLog.map((e) => ({ time: e.time.toISOString(), type: e.type, msg: e.msg })),
        manifests: manifests.map((mn) => ({
          time: mn.time.toISOString(),
          format: mn.format,
          periodCount: mn.periodCount ?? 0,
          isMultiperiod: mn.isMultiperiod,
          note: mn.note,
        })),
      };
      const html = buildSessionReport(data);
      if (!isTv()) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        a.download = `streamprobe_report_${panelId}_${Date.now()}.html`;
        a.click();
        return true;
      }
      // A TV has nowhere to download to: save it on the Mac, beside the traces.
      try {
        const label = `${deviceLabel()}_${ENGINES[engine].tag}_${panelId}`;
        const res = await fetch(`/api/traces?label=${encodeURIComponent(label)}`, {
          method: "POST",
          headers: { "content-type": "text/html" },
          body: html,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log("info", `✓ Informe guardado en el Mac: ${(await res.json()).path}`);
        return true;
      } catch (e: any) {
        log("error", "No se pudo enviar el informe: " + (e?.message || e));
        return false;
      }
    },
    [evLog, manifests, panelId, log]
  );

  /** Ship the capture to the machine serving the app (a TV can't use DevTools
   *  and downloading a file there is useless). Saved under ./traces on the Mac. */
  const sendTraces = useCallback(
    async (engine: EngineId, url: string, opts: { live?: boolean } = {}) => {
      if (!opts.live) log("info", "Enviando trazas al Mac…");
      try {
        const res = await fetch(opts.live ? "/api/traces?live=1" : "/api/traces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildDump(engine, url)),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (opts.live) return true;
        log(
          "info",
          `✓ Trazas guardadas en ${j.path} — ${j.manifests} manifests · ${j.network} peticiones (${Math.round(j.bytes / 1024)} KB)`
        );
        return true;
      } catch (e: any) {
        log("error", "No se pudieron enviar las trazas: " + (e?.message || e));
        return false;
      }
    },
    [buildDump, log]
  );

  return {
    metrics,
    state,
    evLog,
    abrLog,
    scteLog,
    netLog,
    manifests,
    manifestError,
    manifestLoading,
    buffered,
    running,
    overlayHidden,
    audioTracks,
    textTracks,
    qualities,
    metricSamples,
    chartMarkers,
    load,
    stop,
    reset,
    clear,
    selectAudio,
    selectText,
    selectQuality,
    exportJSON,
    exportReport,
    sendTraces,
  };
}
