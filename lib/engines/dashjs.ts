import { loadLib } from "./loaders";
import { autoplay } from "./autoplay";
import { hasNetOverrides, proxifyUrl } from "@/lib/proxy";
import type { EngineCallbacks, EngineController, LoadConfig } from "./types";

export function createDashjs(cb: EngineCallbacks): EngineController {
  let player: any = null;
  let dashjs: any = null;
  let statsIv: ReturnType<typeof setInterval> | null = null;
  const audioMap = new Map<string, any>();
  const textMap = new Map<string, any>();

  const label = (t: any, fallback: string) =>
    [t.lang, (t.roles || []).join(",")].filter(Boolean).join(" · ") || fallback;

  function reportTracks() {
    if (!player) return;
    try {
      audioMap.clear();
      textMap.clear();
      const curA = player.getCurrentTrackFor?.("audio");
      const audio = (player.getTracksFor?.("audio") || []).map((t: any) => {
        const id = String(t.index);
        audioMap.set(id, t);
        return {
          id,
          lang: t.lang,
          label: label(t, `Audio ${t.index}`),
          active: !!curA && curA.index === t.index,
        };
      });
      const textEnabled = player.isTextEnabled?.() ?? false;
      const curT = player.getCurrentTrackFor?.("text");
      const text = (player.getTracksFor?.("text") || []).map((t: any) => {
        const id = String(t.index);
        textMap.set(id, t);
        return {
          id,
          lang: t.lang,
          label: label(t, `Sub ${t.index}`),
          active: textEnabled && !!curT && curT.index === t.index,
        };
      });
      cb.onTracks(audio, text);
      reportQualities();
    } catch {
      /* tracks unavailable */
    }
  }

  /** Video renditions dash.js exposes for the video type, newest API first with a
   *  fallback for the older bundled builds. */
  function videoQualities(): any[] {
    if (!player) return [];
    try {
      return player.getBitrateInfoListFor("video") || [];
    } catch {
      return [];
    }
  }
  function reportQualities() {
    if (!player) return;
    let cur = -1;
    let auto = true;
    try {
      cur = player.getQualityFor("video");
      const st = player.getSettings?.();
      auto = st?.streaming?.abr?.autoSwitchBitrate?.video !== false;
    } catch {
      /* older build */
    }
    cb.onQualities(
      videoQualities().map((b: any, i: number) => ({
        id: String(b.qualityIndex ?? i),
        label: `${b.height ? `${b.height}p` : `nivel ${i}`}${
          b.bitrate ? ` · ${(b.bitrate / 1e6).toFixed(1)} Mbps` : ""
        }`,
        active: !auto && cur === (b.qualityIndex ?? i),
      }))
    );
  }

  /** Pin a rendition (ABR off for video) or null to hand control back to ABR. */
  function selectQuality(id: string | null) {
    if (!player) return;
    const setAuto = (on: boolean) => {
      try {
        player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: on } } } });
      } catch {
        try {
          player.setAutoSwitchQualityFor?.("video", on); // dash.js 3.x
        } catch {
          /* ignore */
        }
      }
    };
    if (id === null) {
      setAuto(true);
      cb.onLog("abr", "Calidad: Auto (ABR activado)");
    } else {
      const i = parseInt(id, 10);
      setAuto(false);
      try {
        player.setQualityFor("video", i, true);
      } catch {
        player.setQualityFor("video", i);
      }
      const b = videoQualities().find((x: any, idx: number) => (x.qualityIndex ?? idx) === i);
      cb.onLog("abr", `Calidad fijada: ${b?.height ? `${b.height}p` : `nivel ${i}`} (ABR desactivado)`);
    }
    reportQualities();
  }

  function selectAudio(id: string) {
    const t = audioMap.get(id);
    if (t && player?.setCurrentTrack) player.setCurrentTrack(t);
  }
  function selectText(id: string | null) {
    if (!player) return;
    if (id === null) {
      player.enableText?.(false);
    } else {
      const t = textMap.get(id);
      if (t) {
        player.setCurrentTrack?.(t);
        player.enableText?.(true);
      }
    }
    reportTracks();
  }

  async function load(video: HTMLVideoElement, cfg: LoadConfig) {
    cb.onLog("info", `Loading dash.js ${cfg.version} (bundled)…`);
    dashjs = await loadLib("dashjs", cfg.version);

    player = dashjs.MediaPlayer().create();
    player.initialize(video, null, false);

    // Route requests through the proxy to inject CDN headers.
    if (hasNetOverrides(cfg.net)) {
      if (typeof player.addRequestInterceptor === "function") {
        player.addRequestInterceptor((request: any) => {
          if (request?.url) request.url = proxifyUrl(request.url, cfg.net);
          return Promise.resolve(request);
        });
        cb.onLog("info", "Proxy ON — injecting CDN headers on media requests");
      } else {
        cb.onLog(
          "warn",
          "This dash.js version can't rewrite request URLs — header overrides not applied."
        );
      }
    }

    const bufG = cfg.advanced.bufferGoal;
    player.updateSettings({
      streaming: {
        delay: { liveDelay: 4 },
        liveCatchup: { enabled: true },
        buffer: { bufferTimeAtTopQuality: bufG, bufferTimeDefault: bufG },
      },
    });

    if (cfg.drm.enabled) {
      const { system, licenseUrl, headers } = cfg.drm;
      const pd: any = {};
      if (system === "widevine")
        pd["com.widevine.alpha"] = { serverURL: licenseUrl, httpRequestHeaders: headers };
      if (system === "playready")
        pd["com.microsoft.playready"] = {
          serverURL: licenseUrl,
          httpRequestHeaders: headers,
        };
      if (system === "fairplay") {
        pd["com.apple.fps"] = { serverURL: licenseUrl };
        cb.onLog("warn", "FairPlay with dash.js: use Native/AVPlayer engine in Safari");
      }
      player.setProtectionData(pd);
      cb.onLog("drm", `DRM: ${system.toUpperCase()} → ${licenseUrl}`);
    }

    const ev = dashjs.MediaPlayer.events;
    player.on(ev.ERROR, (e: any) => {
      cb.onLog("error", `dash.js: ${JSON.stringify(e.error || e.event || "unknown")}`);
      cb.onState("error");
    });
    player.on(ev.QUALITY_CHANGE_RENDERED, (e: any) => {
      if (e.mediaType !== "video") return;
      try {
        const brs = player.getBitrateInfoListFor("video");
        const prev = brs[e.oldQuality];
        const curr = brs[e.newQuality];
        if (prev && curr) {
          cb.onAbr(prev.bitrate, curr.bitrate, { w: curr.width, h: curr.height });
          cb.onMetrics({ bitrate: curr.bitrate });
        }
      } catch {
        /* noop */
      }
    });
    player.on(ev.BUFFER_EMPTY, () => cb.onLog("buffer", "Buffer empty"));
    player.on(ev.BUFFER_LOADED, () => cb.onLog("info", "Buffer loaded"));

    // Autoplay as soon as playback is possible.
    player.on(ev.CAN_PLAY, () => {
      reportTracks();
      autoplay(video, cb.onLog);
    });
    ["STREAM_INITIALIZED", "TRACK_CHANGE_RENDERED", "TEXT_TRACKS_ADDED"].forEach((name) => {
      if (ev[name]) player.on(ev[name], reportTracks);
    });

    // Manifest updates (initial + live refreshes). dash.js exposes a parsed
    // model rather than raw XML, so count periods from it and serialize.
    player.on(ev.MANIFEST_LOADED, (e: any) => {
      cb.onLog("info", "Manifest loaded");
      cb.onNetwork({ time: new Date(), kind: "manifest", url: e?.data?.url || cfg.url });
      const d = e?.data;
      if (!d) return;
      const periods = d.Period_asArray || d.Period;
      const periodCount = Array.isArray(periods) ? periods.length : periods ? 1 : 0;
      let text: string;
      let note: string | undefined;
      try {
        text = JSON.stringify(d, null, 2);
        note = "parsed model (dash.js does not expose raw XML)";
      } catch {
        text = "(parsed manifest could not be serialized)";
        note = "raw XML unavailable";
      }
      cb.onManifest({ text, format: "dash", periodCount, note });
    });
    // Licence round-trips (dash.js 4.x fires this; older bundles simply skip it).
    if (ev.LICENSE_REQUEST_COMPLETE) {
      player.on(ev.LICENSE_REQUEST_COMPLETE, (e: any) => {
        cb.onNetwork({
          time: new Date(),
          kind: "license",
          url: e?.data?.url || cfg.drm.licenseUrl,
          status: e?.data?.statusCode,
        });
      });
    }
    player.on(ev.FRAGMENT_LOADING_COMPLETED, (e: any) => {
      const r = e?.request;
      if (!r) return;
      const dur =
        r.requestStartDate && r.requestEndDate
          ? new Date(r.requestEndDate).getTime() -
            new Date(r.requestStartDate).getTime()
          : undefined;
      cb.onNetwork({
        time: new Date(),
        kind: r.type === "InitializationSegment" ? "init" : "segment",
        mediaType: r.mediaType,
        url: r.url,
        bytes: r.bytesLoaded || undefined,
        durationMs: dur,
      });
    });

    statsIv = setInterval(() => {
      if (!player) return;
      try {
        const q = player.getQualityFor("video");
        const brs = player.getBitrateInfoListFor
          ? player.getBitrateInfoListFor("video")
          : null;
        const patch: any = {};
        if (brs && brs[q]) {
          patch.bitrate = brs[q].bitrate;
        }
        const avg = player.getAverageThroughput
          ? player.getAverageThroughput("video")
          : null;
        if (avg && avg > 0) patch.bw = avg * 1000;
        cb.onMetrics(patch);
      } catch {
        /* noop */
      }
    }, 1000);

    cb.onLog("info", "Attaching source: " + cfg.url);
    player.attachSource(cfg.url);
  }

  function destroy() {
    if (statsIv) {
      clearInterval(statsIv);
      statsIv = null;
    }
    try {
      if (player?.reset) player.reset();
    } catch {
      /* noop */
    }
    player = null;
    audioMap.clear();
    textMap.clear();
  }

  return { load, destroy, selectAudio, selectText, selectQuality };
}
