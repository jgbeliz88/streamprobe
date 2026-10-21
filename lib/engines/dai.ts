/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadLib } from "./loaders";
import { autoplay } from "./autoplay";
import { detectFormat } from "@/lib/format";
import { hasNetOverrides, proxifyUrl, unproxifyUrl } from "@/lib/proxy";
import { hasAuthToken, makeTokenPropagator } from "@/lib/cdnToken";
import { shakaDrmConfig } from "./drm";
import { setupFairPlay } from "./native";
import { describeToken, getTestToken, tokenMinutesLeft } from "./testToken";
import type { EngineCallbacks, EngineController, LoadConfig } from "./types";

// Google IMA DAI SDK — loaded from Google's CDN (not bundleable via npm).
const IMA_SDK = "https://imasdk.googleapis.com/js/sdkloader/ima3_dai.js";

function loadImaSdk(): Promise<any> {
  return new Promise((resolve, reject) => {
    const g = (window as any).google;
    if (g?.ima?.dai) return resolve(g.ima.dai);
    const done = () => {
      const dai = (window as any).google?.ima?.dai;
      dai ? resolve(dai) : reject(new Error("IMA DAI SDK cargó pero no expone google.ima.dai"));
    };
    const existing = document.querySelector(`script[src="${IMA_SDK}"]`);
    if (existing) {
      existing.addEventListener("load", done);
      existing.addEventListener("error", () => reject(new Error("no se pudo cargar el IMA DAI SDK")));
      return;
    }
    const s = document.createElement("script");
    s.src = IMA_SDK;
    s.async = true;
    s.onload = done;
    s.onerror = () =>
      reject(new Error("no se pudo cargar el IMA DAI SDK (¿red/CSP bloqueando imasdk.googleapis.com?)"));
    document.head.appendChild(s);
  });
}

// ── [TOKEN-TEST] Manual Akamai token injection ──────────────────────────────
// The front-end appends a CDN token to media requests that the IMA DAI SDK's own
// manifest URL may not carry, so the first manifest GET can 403. These helpers let
// a hand-pasted token be added to CDN requests and logged safely.
const LOC = "[TOKEN-TEST]";

/** Query params whose value is an auth token we must not print in full. */
const AUTH_PARAM = /^(hdnts|hdnea|hdntl|token|auth|__hdnea__)$/i;

/** Mask token values but keep `exp` readable (and spell out its date), so the log
 *  is safe to paste while still answering "does the token outlive the session?". */
function maskTokenUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const parts: string[] = [];
    u.searchParams.forEach((v, k) => {
      if (!AUTH_PARAM.test(k)) {
        parts.push(`${k}=${v}`);
        return;
      }
      const masked = v
        .split("~")
        .map((seg) => {
          const [name, val] = seg.split("=");
          if (!/^exp$/i.test(name)) return val === undefined ? seg : `${name}=***`;
          const secs = Number(val);
          const when = Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : "?";
          return `${name}=${val} (${when})`;
        })
        .join("~");
      parts.push(`${k}=${masked}`);
    });
    return u.origin + u.pathname + (parts.length ? `?${parts.join("&")}` : "");
  } catch {
    return raw;
  }
}


export function createDai(cb: EngineCallbacks): EngineController {
  let streamManager: any = null;
  let hls: any = null;
  let shakaPlayer: any = null;
  let statsIv: ReturnType<typeof setInterval> | null = null;
  let traceIv: ReturnType<typeof setInterval> | null = null;
  const reportedRes = new Set<string>();
  let curBitrate = 0;
  let pinnedQuality: string | null = null;
  // [LOC-TEST] CDN host taken from the SDK's manifest URL — the only host we touch.
  let akamaiHost = "";
  let lastManifestSeq = 0;
  let manifestPollBusy = false;

  // Native-HLS tracing (used by the FairPlay path): Safari fetches the manifest
  // and segments itself, so there are no hls.js events. But everything is routed
  // through /api/proxy, so the Resource Timing API sees it — poll it and surface
  // each fetch in the Network panel, re-reading playlists into the Manifest panel.
  function classifyRes(u: string): "manifest" | "init" | "segment" | "other" {
    const s = u.toLowerCase();
    if (/\.m3u8($|\?)/.test(s)) return "manifest";
    if (/(^|\/)[^/?]*init[^/?]*|\.mp4($|\?)/.test(s)) return "init";
    if (/\.(m4s|ts|aac|mp3|vtt|webvtt|cmfv|cmfa)($|\?)/.test(s)) return "segment";
    return "other";
  }
  // Read the Resource Timing buffer for the Network panel, and read manifests back
  // from the proxy's own stash for the Manifest panel. It must NEVER re-fetch an
  // upstream manifest: GAM DAI manifest URLs are session-bound / single-use and an
  // out-of-band fetch breaks the stream (black screen, no error). Both reads here
  // are local/same-origin, so they add no upstream traffic. NB: this only sees
  // anything while media actually goes through the proxy (i.e. header overrides set).
  function startNativeTracing() {
    stopNativeTracing();
    reportedRes.clear();
    lastManifestSeq = 0;
    try {
      performance.clearResourceTimings?.();
    } catch {
      /* noop */
    }
    traceIv = setInterval(() => {
      let entries: PerformanceEntryList = [];
      try {
        entries = performance.getEntriesByType("resource");
      } catch {
        return;
      }
      for (const e of entries as PerformanceResourceTiming[]) {
        // Proxied loads OR direct CDN media (when no header override is set the
        // media never touches the proxy — without this the panel stayed empty).
        const looksLikeMedia = (u: string) =>
          /\.(m3u8|mpd|m4s|ts|mp4|cmfv|cmfa|aac|mp3|vtt|webvtt)($|\?)/i.test(u.split("#")[0]);
        if (!e.name.includes("/api/proxy?") && !looksLikeMedia(e.name)) continue;
        const k = `${e.startTime}|${e.name}`;
        if (reportedRes.has(k)) continue;
        reportedRes.add(k);
        const real = unproxifyUrl(e.name) || e.name;
        // Safari 16.4+/Chrome expose the HTTP status for same-origin resources
        // (our requests go through /api/proxy, so it's available) — surface it so
        // failed content segments (403/404) are visible right in the panel.
        const status = (e as any).responseStatus as number | undefined;
        cb.onNetwork({
          time: new Date(),
          kind: classifyRes(real),
          url: real,
          bytes: e.transferSize || e.encodedBodySize || undefined,
          durationMs: e.duration ? Math.round(e.duration) : undefined,
          status: status || undefined,
        });
      }
      // Manifests: read back what the proxy already fetched while rewriting, rather
      // than re-fetching them ourselves (a GAM DAI manifest URL is session-bound and
      // an out-of-band fetch breaks the stream). Same-origin, no upstream traffic.
      if (!manifestPollBusy) {
        manifestPollBusy = true;
        fetch(`/api/proxy?manifests=${lastManifestSeq}`)
          .then((r) => r.json())
          .then((d: any) => {
            for (const m of d?.items || []) {
              lastManifestSeq = Math.max(lastManifestSeq, m.seq);
              cb.onManifest({
                text: m.text,
                format: "hls",
                bytes: m.text.length,
                note: /\.m3u8($|\?)/i.test(m.url) && /master|dai\.m3u8/i.test(m.url)
                  ? "master (proxy)"
                  : "media playlist (proxy)",
              });
            }
          })
          .catch(() => {})
          .finally(() => {
            manifestPollBusy = false;
          });
      }
    }, 1000);
  }
  function stopNativeTracing() {
    if (traceIv) {
      clearInterval(traceIv);
      traceIv = null;
    }
  }

  // Audio-track resolver for the Shaka (DASH) path: TrackInfo.id → selection args.
  const audioSel = new Map<
    string,
    { language: string; role?: string; channelsCount?: number; label?: string }
  >();

  // Audio + subtitle tracks. The stitched stream can be either DASH (Shaka) or
  // HLS (hls.js), so dispatch to whichever player is live. Without this the DAI
  // engine never surfaced multi-audio / subtitles in either format.
  function reportTracks() {
    try {
      if (shakaPlayer) {
        audioSel.clear();
        const audio: any[] = [];
        for (const v of shakaPlayer.getVariantTracks()) {
          const roles = (v.audioRoles || []).join(",");
          const id = `${v.language}|${roles}|${v.channelsCount ?? ""}|${v.label ?? ""}`;
          let t = audio.find((a) => a.id === id);
          if (!t) {
            audioSel.set(id, {
              language: v.language,
              role: v.audioRoles?.[0],
              channelsCount: v.channelsCount,
              label: v.label,
            });
            const parts = [v.language || "und"];
            if (v.channelsCount) parts.push(`${v.channelsCount}ch`);
            if (v.label) parts.push(v.label);
            t = { id, lang: v.language, label: parts.join(" · "), active: false };
            audio.push(t);
          }
          if (v.active) t.active = true;
        }
        const visible = shakaPlayer.isTextTrackVisible();
        const text = shakaPlayer.getTextTracks().map((t: any) => ({
          id: String(t.id),
          lang: t.language,
          label: [t.language || "und", t.label, t.forced ? "forced" : ""]
            .filter(Boolean)
            .join(" · "),
          active: !!t.active && visible,
        }));
        cb.onTracks(audio, text);
      } else if (hls) {
        const trackLabel = (t: any, fb: string) =>
          [t.lang || t.language, t.name].filter(Boolean).join(" · ") || fb;
        const audio = (hls.audioTracks || []).map((t: any) => ({
          id: String(t.id),
          lang: t.lang || t.language,
          label: trackLabel(t, `Audio ${t.id}`),
          active: t.id === hls.audioTrack,
        }));
        const cur = hls.subtitleTrack; // -1 = off
        const text = (hls.subtitleTracks || []).map((t: any) => ({
          id: String(t.id),
          lang: t.lang || t.language,
          label: trackLabel(t, `Sub ${t.id}`),
          active: t.id === cur,
        }));
        cb.onTracks(audio, text);
      }
      reportQualities();
    } catch {
      /* tracks not available yet */
    }
  }

  // Video renditions. Same dispatch as reportTracks: the stitched stream is played
  // by Shaka (DASH) or hls.js (HLS). The native FairPlay path can't pin a
  // rendition (Safari decides), so it reports none and the selector stays hidden.
  const shakaQualityId = (v: any) =>
    String(v.videoId ?? `${v.height}|${v.videoBandwidth ?? v.bandwidth}`);

  function reportQualities() {
    try {
      if (shakaPlayer) {
        const seen = new Map<string, any>();
        for (const v of shakaPlayer.getVariantTracks()) {
          if (!v.height) continue;
          const id = shakaQualityId(v);
          if (!seen.has(id)) seen.set(id, v);
        }
        cb.onQualities(
          [...seen.entries()]
            .sort((a, b) => (b[1].height || 0) - (a[1].height || 0))
            .map(([id, v]) => {
              const bps = v.videoBandwidth || v.bandwidth || 0;
              return {
                id,
                label: `${v.height}p${bps ? ` · ${(bps / 1e6).toFixed(1)} Mbps` : ""}`,
                active: pinnedQuality === id,
              };
            })
        );
      } else if (hls) {
        const levels: any[] = hls.levels || [];
        const cur = hls.autoLevelEnabled ? -1 : hls.currentLevel;
        cb.onQualities(
          levels.map((l: any, i: number) => ({
            id: String(i),
            label: `${l.height ? `${l.height}p` : `nivel ${i}`}${
              l.bitrate ? ` · ${(l.bitrate / 1e6).toFixed(1)} Mbps` : ""
            }`,
            active: cur === i,
          }))
        );
      }
    } catch {
      /* not ready yet */
    }
  }

  function selectQuality(id: string | null) {
    if (shakaPlayer) {
      if (id === null) {
        pinnedQuality = null;
        shakaPlayer.configure({ abr: { enabled: true } });
        cb.onLog("abr", "Calidad: Auto (ABR activado)");
      } else {
        const t = shakaPlayer.getVariantTracks().find((v: any) => shakaQualityId(v) === id);
        if (t) {
          pinnedQuality = id;
          shakaPlayer.configure({ abr: { enabled: false } });
          shakaPlayer.selectVariantTrack(t, true);
          cb.onLog("abr", `Calidad fijada: ${t.height}p (ABR desactivado)`);
        }
      }
    } else if (hls) {
      if (id === null) {
        hls.currentLevel = -1;
        cb.onLog("abr", "Calidad: Auto (ABR activado)");
      } else {
        const i = parseInt(id, 10);
        hls.currentLevel = i;
        const l = hls.levels?.[i];
        cb.onLog("abr", `Calidad fijada: ${l?.height ? `${l.height}p` : `nivel ${i}`} (ABR desactivado)`);
      }
    }
    reportQualities();
  }

  function selectAudio(id: string) {
    if (shakaPlayer) {
      const sel = audioSel.get(id);
      if (sel) {
        try {
          shakaPlayer.selectAudioLanguage(sel.language, sel.role, sel.channelsCount, sel.label);
        } catch {
          shakaPlayer.selectAudioLanguage(sel.language, sel.role);
        }
      }
    } else if (hls) {
      hls.audioTrack = parseInt(id, 10);
    }
  }

  function selectText(id: string | null) {
    if (shakaPlayer) {
      if (id === null) {
        shakaPlayer.setTextTrackVisibility(false);
      } else {
        const t = shakaPlayer.getTextTracks().find((x: any) => String(x.id) === id);
        if (t) {
          shakaPlayer.selectTextTrack(t);
          shakaPlayer.setTextTrackVisibility(true);
        }
      }
    } else if (hls) {
      if (id === null) {
        hls.subtitleTrack = -1;
        hls.subtitleDisplay = false;
      } else {
        hls.subtitleTrack = parseInt(id, 10);
        hls.subtitleDisplay = true;
      }
    }
    reportTracks();
  }

  async function load(video: HTMLVideoElement, cfg: LoadConfig) {
    const dai = cfg.dai;
    if (!dai.assetKey.trim()) {
      cb.onLog("error", "Falta el asset key de GAM");
      cb.onState("error");
      return;
    }
    // CDN header overrides apply to media requests only. The IMA SDK issues the
    // DAI stream request itself, so that call can't be proxied from here.
    const useProxy = hasNetOverrides(cfg.net);
    if (useProxy) {
      cb.onLog(
        "warn",
        "Origin/Referer/UA se aplican al media (master/variants/segmentos), no a la petición DAI del SDK."
      );
    }

    cb.onLog("info", "Cargando IMA DAI SDK…");
    let ima: any;
    try {
      ima = await loadImaSdk();
    } catch (e: any) {
      cb.onLog("error", e?.message || String(e));
      cb.onState("error");
      return;
    }
    const api = ima.api;
    const T = api.StreamEvent.Type;

    streamManager = new api.StreamManager(video);

    // ── Play the stitched stream once GAM returns its URL ──
    const playStitched = async (url: string) => {
      // Play whatever GAM actually returned — the returned URL is the source of
      // truth (the SDK may serve a different format than requested). Fall back to
      // the requested format only when the URL has no clear extension.
      const detected = detectFormat(url);
      const fmt = detected === "hls" || detected === "dash" ? detected : dai.format;
      cb.onLog("info", `GAM devolvió: ${url}`);
      // [LOC-TEST] initial manifest URL from the SDK — this is the one that carries
      // the token every CDN request must carry.
      console.log(
        `${LOC} URL inicial del manifest (SDK): ${maskTokenUrl(url)}`,
      );
      // The CDN host we are allowed to touch: whatever the SDK's own manifest URL
      // points at. Anything else (dai.google.com, pubads…) is left alone.
      try {
        akamaiHost = new URL(url).host;
      } catch {
        akamaiHost = "";
      }
      const tk0 = getTestToken();
      console.log(
        `${LOC} host CDN objetivo: ${akamaiHost || "(desconocido)"}` +
          `\n${LOC} token manual: ${tk0 ? `${tk0.name} · ámbito ${tk0.scope} · ${describeToken(tk0)}` : "(vacío — sin inyección)"}`
      );
      if (tk0) {
        const left = tokenMinutesLeft(tk0);
        if (left != null && left <= 0) {
          console.warn(`${LOC} ⚠ el token ya ha CADUCADO (exp hace ${-left} min) — esperas 403`);
        } else if (left != null && left < 5) {
          console.warn(`${LOC} ⚠ el token caduca en ${left} min — la sesión se caerá pronto`);
        }
      }
      cb.onLog("info", `Formato detectado: ${fmt.toUpperCase()} → ${fmt === "dash" ? "Shaka" : "hls.js"}`);
      cb.onNetwork({ time: new Date(), kind: "manifest", url });
      if (fmt === "dash") {
        const shaka: any = await loadLib("shaka", "4.13.25");
        shaka.polyfill.installAll();
        shakaPlayer = new shaka.Player();
        await shakaPlayer.attach(video);
        // Send the GAM session cookie with every request (same reason as hls.js),
        // and route media through the proxy when CDN header overrides are set.
        const RT = shaka.net.NetworkingEngine.RequestType;
        shakaPlayer.getNetworkingEngine().registerRequestFilter((type: number, req: any) => {
          req.allowCrossSiteCredentials = true;
          // [LOC-TEST] Append the hand-pasted Akamai token, mimicking the front-end.
          // Runs before the proxify below so the token ends up in the REAL upstream
          // URL, not wrapped around the proxy one.
          const tk = getTestToken();
          if (tk && Array.isArray(req.uris) && req.uris.length) {
            const inScope =
              type === RT.MANIFEST ||
              (tk.scope === "all" && (type === RT.SEGMENT || type === RT.INIT_SEGMENT));
            req.uris = req.uris.map((u: string) => {
              if (!inScope) return u;
              let host = "";
              try {
                host = new URL(u).host;
              } catch {
                return u;
              }
              // Never touch Google's own ad/stitching endpoints.
              if (/(^|\.)(dai\.google\.com|pubads\.g\.doubleclick\.net|doubleclick\.net)$/i.test(host)) {
                console.log(`${LOC} token: no (host de Google) ${host}`);
                return u;
              }
              if (akamaiHost && host !== akamaiHost) {
                console.log(`${LOC} token: no (otro host) ${host} ≠ ${akamaiHost}`);
                return u;
              }
              if (new RegExp(`[?&]${tk.name}=`).test(u)) {
                console.log(`${LOC} token: ya lo traía (${tk.name}) · ${maskTokenUrl(u)}`);
                return u;
              }
              const out = u + (u.includes("?") ? "&" : "?") + tk.raw;
              console.log(
                `${LOC} token: INYECTADO en ${type === RT.MANIFEST ? "manifest" : "segmento"}` +
                  ` · ${tk.name} · ${describeToken(tk)}`
              );
              return out;
            });
          }
          if (type === RT.LICENSE) {
            // Attach the DRM license headers (auth token, etc.). Shaka has no
            // drm.advanced.headers, so the request filter is the only way — the
            // main Shaka engine does the same. Without this, Widevine DAI streams
            // whose licence needs an auth header fail with 6003/6007.
            const drmHeaders = cfg.drm.headers;
            if (drmHeaders && Object.keys(drmHeaders).length) {
              req.headers = { ...req.headers, ...drmHeaders };
            }
          } else if (useProxy && Array.isArray(req.uris)) {
            req.uris = req.uris.map((u: string) => proxifyUrl(u, cfg.net));
          }
        });
        if (useProxy) {
          cb.onLog("info", "Proxy ON — inyectando cabeceras CDN en las peticiones de media");
        }
        // Report network traces (manifest / segment / init / license) — same as the
        // main Shaka engine — and restore the real URI when proxying. Without this
        // the DASH+DRM path showed no traces (only the initial manifest); the hls.js
        // path reports them via FRAG_LOADED, so no-DRM HLS looked fine.
        shakaPlayer.getNetworkingEngine().registerResponseFilter((type: number, res: any) => {
          if (useProxy) {
            const real = unproxifyUrl(res.uri);
            if (real) res.uri = real;
          }
          const kind =
            type === RT.MANIFEST
              ? "manifest"
              : type === RT.SEGMENT
                ? "segment"
                : type === RT.INIT_SEGMENT
                  ? "init"
                  : type === RT.LICENSE
                    ? "license"
                    : "other";
          const bytes = res.data ? res.data.byteLength : undefined;
          cb.onNetwork({ time: new Date(), kind, url: res.uri, bytes });
          // Capture the DASH manifest (initial + live refreshes) as raw text so it
          // shows in the Manifest panel — the hls.js path already does this.
          if (type === RT.MANIFEST && res.data) {
            try {
              const text = new TextDecoder().decode(new Uint8Array(res.data));
              cb.onManifest({ text, format: "dash", bytes });
            } catch {
              /* non-text manifest */
            }
          }
        });
        // [LOC-TEST] Surface manifest load/update failures — the bug shows up as a
        // 4xx on the refresh (network category 1xxx) or a manifest error (4xxx).
        shakaPlayer.addEventListener("error", (e: any) => {
          const code = e?.detail?.code;
          const cat = Math.floor((code ?? 0) / 1000);
          if (cat !== 1 && cat !== 4) return;
          // BAD_HTTP_STATUS(1001) data = [uri, status, body, headers, reqType, finalUri].
          const d: any[] = Array.isArray(e?.detail?.data) ? e.detail.data : [];
          if (code === 1001 && d[1] === 403) {
            const uri = unproxifyUrl(String(d[0] || "")) || String(d[0] || "");
            const headers = d[3] || {};
            const body = typeof d[2] === "string" ? d[2] : "";
            const ref = /Reference\s*#\s*([\w.\-]+)/i.exec(body);
            console.error(
              `${LOC} 403 ← ${maskTokenUrl(uri)}` +
                `\n${LOC}   Server: ${headers["server"] || headers["Server"] || "(sin cabecera)"}` +
                `\n${LOC}   Reference #: ${ref ? ref[1] : "(no encontrado en el body)"}`
            );
            return;
          }
          console.error(`${LOC} error de manifest/red — Shaka ${code}`, d);
        });
        // DRM: GAM live streams are usually DASH + Widevine/PlayReady.
        const drmConf = shakaDrmConfig(cfg.drm);
        if (drmConf) {
          shakaPlayer.configure({ drm: drmConf });
          cb.onLog("drm", `DRM: ${cfg.drm.system.toUpperCase()} → ${cfg.drm.licenseUrl}`);
        }
        // Forward in-band emsg metadata to the SDK for ad tracking.
        shakaPlayer.addEventListener("emsg", (e: any) => {
          const d = e.detail || {};
          try {
            streamManager.processMetadata(d.schemeIdUri, d.messageData, d.startTime);
          } catch {
            /* ignore */
          }
        });
        // Audio/subtitle track list — report on load and whenever it changes.
        ["trackschanged", "adaptation", "variantchanged", "textchanged", "texttrackvisibility"].forEach(
          (ev) => shakaPlayer.addEventListener(ev, reportTracks)
        );
        // ABR switches: the DAI engine reported none on this branch, so the ABR tab
        // stayed empty even though Shaka was adapting. Same pattern as shaka.ts.
        ["adaptation", "variantchanged"].forEach((ev) =>
          shakaPlayer.addEventListener(ev, () => {
            const t = shakaPlayer.getVariantTracks().find((v: any) => v.active);
            if (!t) return;
            cb.onAbr(curBitrate, t.bandwidth, { w: t.width, h: t.height });
            curBitrate = t.bandwidth;
            cb.onMetrics({ bitrate: t.bandwidth });
          })
        );
        await shakaPlayer.load(url);
        reportTracks();
        await autoplay(video, cb.onLog);
      } else if (cfg.drm.enabled && cfg.drm.system === "fairplay") {
        // FairPlay only works through Safari's LEGACY native path (webkitneedkey).
        // hls.js/MSE uses modern EME (com.apple.fps), which for these streams fails
        // at key-system access (keySystemNoAccess) or CKC apply. So for FairPlay we
        // bypass hls.js entirely: native <video> + the legacy FairPlay setup, with
        // the stitched manifest routed through the rewriting proxy (rw=1) so the
        // injected Origin reaches the child playlists/segments. Google's clear ad
        // segments play as-is; the encrypted content gets its key via webkitneedkey.
        if (!cfg.drm.certUrl) cb.onLog("warn", "FairPlay: falta la URL de certificado (obligatoria)");
        setupFairPlay(video, cfg, cb);
        const src = proxifyUrl(url, cfg.net);
        const proxiedSrc = src.startsWith("/api/proxy?") ? `${src}&rw=1` : src;
        // Report what is ACTUALLY happening: media only goes through the rewriting
        // proxy when header overrides are set (proxifyUrl is a no-op otherwise);
        // the licence/cert always do (proxifyAlways, to dodge the CORS preflight).
        cb.onLog(
          "drm",
          proxiedSrc.startsWith("/api/proxy?")
            ? "FairPlay nativo (DAI) — manifest/segmentos por el proxy (rw); licencia/cert por el proxy"
            : "FairPlay nativo (DAI) — manifest/segmentos DIRECTOS al CDN (sin overrides de cabeceras); licencia/cert por el proxy"
        );
        // Passive Resource-Timing tracing only (Network panel). Must not fetch.
        startNativeTracing();
        // Surface the real media error (code 4 = source/manifest not supported)
        // instead of only the play() rejection, and retry play once the source is
        // actually ready — an immediate play() can throw "not supported" before the
        // native HLS manifest has loaded.
        const MEDIA_ERR: Record<number, string> = {
          1: "ABORTED",
          2: "NETWORK",
          3: "DECODE",
          4: "SRC_NOT_SUPPORTED",
        };
        video.addEventListener("error", () => {
          const err = video.error;
          cb.onLog(
            "error",
            `Vídeo nativo: error ${err?.code ?? "?"} (${
              err ? MEDIA_ERR[err.code] || "?" : "?"
            })${err?.message ? " — " + err.message : ""}`
          );
        });
        // Native HLS gives Safari full control of ABR with no JS event, so the ABR
        // tab stays empty. The element does fire `resize` when the intrinsic video
        // size changes — i.e. on a rendition switch — so report that. Bitrate isn't
        // exposed, hence dimensions only.
        let lastW = 0;
        let lastH = 0;
        video.addEventListener("resize", () => {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (!w || !h || (w === lastW && h === lastH)) return;
          if (lastW) {
            const dir = w * h > lastW * lastH ? "↑" : "↓";
            cb.onLog("abr", `Variant switch ${dir} ${lastW}×${lastH} → ${w}×${h}`);
          } else {
            cb.onLog("abr", `Initial variant ${w}×${h}`);
          }
          lastW = w;
          lastH = h;
        });
        // "Playing but black" diagnosis: if the video track never decodes, videoWidth
        // stays 0 while currentTime advances (effectively audio-only). Sample at the
        // first `playing` and again a few seconds in, so we can tell a non-decoding
        // video track from a stalled/!advancing element.
        const reportVideoState = (tag: string) => {
          const v = video as any;
          cb.onLog(
            "info",
            `Vídeo [${tag}]: ${video.videoWidth}x${video.videoHeight} · readyState=${video.readyState}` +
              ` · t=${video.currentTime.toFixed(2)}s · paused=${video.paused}` +
              ` · vTracks=${v.videoTracks?.length ?? "?"} · aTracks=${v.audioTracks?.length ?? "?"}`
          );
        };
        video.addEventListener(
          "playing",
          () => {
            reportVideoState("playing");
            setTimeout(() => reportVideoState("+4s"), 4000);
          },
          { once: true }
        );
        // Start as soon as the source is ready. If the browser blocks autoplay,
        // fall back to muted (always allowed) so we don't sit idle until a manual
        // Play — that idle time would otherwise inflate the measured join time.
        let started = false;
        const tryPlay = async () => {
          if (started) return;
          try {
            await video.play();
            started = true;
          } catch {
            try {
              video.muted = true;
              await video.play();
              started = true;
              cb.onLog("warn", "Autoplay: iniciado en muted — quita el silencio en los controles.");
            } catch {
              /* needs a user gesture — press Play */
            }
          }
        };
        video.addEventListener("loadedmetadata", tryPlay);
        video.addEventListener("canplay", tryPlay);
        // Forward native-HLS ID3 timed metadata to the SDK so it fires ad events /
        // tracking beacons to Google. The hls.js path does this via
        // FRAG_PARSING_METADATA; native HLS surfaces the same ID3 as cues on a
        // "metadata" text track (the IMA DAI SDK's documented Safari pattern).
        let metaSeen = false;
        const hookMeta = () => {
          const tracks = video.textTracks;
          for (let i = 0; i < tracks.length; i++) {
            const tr: any = tracks[i];
            if (tr.kind === "metadata" && !tr.__daiHooked) {
              tr.__daiHooked = true;
              tr.mode = "hidden";
              tr.addEventListener("cuechange", () => {
                const cues = tr.activeCues;
                for (let j = 0; cues && j < cues.length; j++) {
                  const cue: any = cues[j];
                  const data = cue?.value?.data ?? cue?.value;
                  if (data == null) continue;
                  try {
                    streamManager.processMetadata("ID3", data, cue.startTime);
                    if (!metaSeen) {
                      metaSeen = true;
                      cb.onLog("info", "Metadatos ID3 → SDK DAI (tracking de ads activo)");
                    }
                  } catch {
                    /* malformed cue */
                  }
                }
              });
            }
          }
        };
        (video.textTracks as any).addEventListener?.("addtrack", hookMeta);
        video.addEventListener("loadedmetadata", hookMeta);
        video.src = proxiedSrc;
        video.load?.();
      } else {
        const Hls: any = await loadLib("hlsjs", cfg.version);
        // GAM DAI authorises child playlists/segments with a session COOKIE
        // (CORS replies with allow-credentials:true), so requests must be
        // credentialed or they 404 even with the URL token present.
        const hlsCfg: any = {
          xhrSetup: (xhr: XMLHttpRequest) => {
            xhr.withCredentials = true;
          },
        };
        if (cfg.drm.enabled) {
          if (cfg.drm.system === "widevine") {
            hlsCfg.emeEnabled = true;
            hlsCfg.widevineLicenseUrl = cfg.drm.licenseUrl;
            hlsCfg.licenseResponseCallback = (xhr: XMLHttpRequest): ArrayBuffer => {
              cb.onNetwork({
                time: new Date(),
                kind: "license",
                url: cfg.drm.licenseUrl,
                status: xhr.status,
                bytes: xhr.response instanceof ArrayBuffer ? xhr.response.byteLength : undefined,
              });
              return xhr.response;
            };
            cb.onLog("drm", `DRM: WIDEVINE → ${cfg.drm.licenseUrl}`);
          } else if (cfg.drm.system === "playready") {
            cb.onLog("warn", "hls.js no soporta PlayReady — usa formato DASH");
          }
          // FairPlay is handled by the native path above (returns before here).
        }
        // Cross-domain SSAI chain (verified on the Mediaset/GAM setup):
        //   master   → CDN, carries the `hdnea` token
        //   variants → dai.google.com, public (no token needed)
        //   segments → back on the CDN, listed WITHOUT the token → 403
        const addToken = makeTokenPropagator(url);
        if (hasAuthToken(url)) {
          cb.onLog("info", "Token de auth del master propagado a las peticiones hijas");
        }
        if (hasAuthToken(url) || useProxy) {
          const Base = Hls.DefaultConfig.loader;
          class DaiLoader extends Base {
            load(context: any, config: any, callbacks: any) {
              let u: string = context?.url;
              if (u && /^https?:/.test(u)) {
                // 1) re-add the auth token, only on the host that issued it
                u = addToken(u);
                // 2) route through the local proxy so it can inject
                //    Origin/Referer/User-Agent (the browser forbids setting them)
                const real = u;
                if (useProxy) u = proxifyUrl(u, cfg.net);
                context.url = u;
                // 3) hand hls.js back the real URL so relative resolution and
                //    the logs point at the CDN, not at /api/proxy
                if (useProxy) {
                  const onSuccess = callbacks.onSuccess;
                  callbacks.onSuccess = (resp: any, stats: any, ctx: any, net: any) => {
                    if (resp) resp.url = real;
                    if (ctx) ctx.url = real;
                    onSuccess(resp, stats, ctx, net);
                  };
                }
              }
              super.load(context, config, callbacks);
            }
          }
          hlsCfg.loader = DaiLoader;
          if (useProxy)
            cb.onLog("info", "Proxy ON — inyectando cabeceras CDN en las peticiones de media");
        }
        if (Hls.isSupported()) {
          hls = new Hls(hlsCfg);
          // Surface errors (otherwise a failed load just hangs on "buffering").
          hls.on(Hls.Events.ERROR, (_e: any, d: any) => {
            const failed = d.context?.url || d.frag?.url || d.url || "";
            const http = d.response?.code ? ` HTTP ${d.response.code}` : "";
            if (d.fatal) {
              cb.onLog("error", `hls.js fatal: ${d.type}/${d.details}${http}${failed ? ` — ${failed}` : ""}`);
              cb.onState("error");
              if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
              else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
            } else {
              cb.onLog("warn", `hls.js: ${d.details}${http}${failed ? ` — ${failed}` : ""}`);
            }
          });
          hls.on(Hls.Events.LEVEL_SWITCHED, (_e: any, d: any) => {
            const l = hls.levels?.[d.level];
            if (!l) return;
            cb.onAbr(curBitrate, l.bitrate, { w: l.width, h: l.height });
            curBitrate = l.bitrate;
            cb.onMetrics({ bitrate: l.bitrate });
            reportQualities();
          });
          hls.on(Hls.Events.MANIFEST_PARSED, (_e: any, d: any) => {
            cb.onLog("info", `Manifest HLS parseado — ${d.levels.length} niveles`);
            reportTracks();
            autoplay(video, cb.onLog);
          });
          // Audio/subtitle track list — report when it's parsed or switched.
          [
            "AUDIO_TRACKS_UPDATED",
            "AUDIO_TRACK_SWITCHED",
            "SUBTITLE_TRACKS_UPDATED",
            "SUBTITLE_TRACK_SWITCH",
          ].forEach((name) => {
            if (Hls.Events[name]) hls.on(Hls.Events[name], reportTracks);
          });
          hls.on(Hls.Events.MANIFEST_LOADED, (_e: any, d: any) => {
            // Capture the raw stitched master + report which host(s) serve the
            // variants — to confirm whether the manifest points at dai.google.com
            // (cross-domain) or stays on the same CDN.
            const raw = d?.networkDetails?.responseText;
            if (raw) cb.onManifest({ text: raw, format: "hls", note: "master DAI (cosido)" });
            cb.onNetwork({
              time: new Date(),
              kind: "manifest",
              url: unproxifyUrl(d?.url) || d?.url || url,
              bytes: raw ? raw.length : undefined,
            });
            const hostOf = (u: any) => {
              try {
                return new URL(Array.isArray(u) ? u[0] : u, d.url).host;
              } catch {
                return String(u);
              }
            };
            const hosts = [
              ...new Set([
                ...(d.levels || []).map((l: any) => hostOf(l.url)),
                ...(d.audioTracks || []).map((a: any) => hostOf(a.url)),
              ]),
            ].filter(Boolean);
            cb.onLog("info", `Variants/audio servidos desde: ${hosts.join(", ") || "?"}`);
          });
          // Media / audio / subtitle playlists (and, in live, every refresh) — hls.js
          // fetches them itself, so without hooking these events the Manifest panel
          // only ever showed the master and the Network panel missed the playlist
          // loads entirely.
          const capturePlaylist = (d: any, note: string) => {
            const xhr = d?.networkDetails;
            const rawUrl = xhr?.responseURL || d?.details?.url || d?.url;
            const plUrl = rawUrl ? unproxifyUrl(rawUrl) || rawUrl : undefined;
            const raw = typeof xhr?.responseText === "string" ? xhr.responseText : null;
            if (plUrl) {
              cb.onNetwork({
                time: new Date(),
                kind: "manifest",
                url: plUrl,
                bytes: raw ? raw.length : undefined,
              });
            }
            if (raw) cb.onManifest({ text: raw, format: "hls", note });
          };
          if (Hls.Events.LEVEL_LOADED)
            hls.on(Hls.Events.LEVEL_LOADED, (_e: any, d: any) =>
              capturePlaylist(d, d?.details?.live ? "media playlist (directo)" : "media playlist")
            );
          if (Hls.Events.AUDIO_TRACK_LOADED)
            hls.on(Hls.Events.AUDIO_TRACK_LOADED, (_e: any, d: any) =>
              capturePlaylist(d, "audio playlist")
            );
          if (Hls.Events.SUBTITLE_TRACK_LOADED)
            hls.on(Hls.Events.SUBTITLE_TRACK_LOADED, (_e: any, d: any) =>
              capturePlaylist(d, "subtitle playlist")
            );
          hls.on(Hls.Events.FRAG_LOADED, (_e: any, d: any) => {
            const f = d?.frag;
            if (!f) return;
            const stats = d?.stats || f.stats;
            const bytes = stats?.total ?? stats?.loaded;
            const dur =
              stats?.loading?.end && stats?.loading?.start
                ? Math.round(stats.loading.end - stats.loading.start)
                : undefined;
            cb.onNetwork({
              time: new Date(),
              kind: f.sn === "initSegment" ? "init" : "segment",
              mediaType: f.type,
              url: unproxifyUrl(f.url) || f.url,
              bytes,
              durationMs: dur,
            });
          });
          // Forward ID3 timed metadata to the SDK for ad tracking.
          hls.on(Hls.Events.FRAG_PARSING_METADATA, (_e: any, data: any) => {
            for (const s of data?.samples || []) {
              try {
                streamManager.processMetadata("ID3", s.data, s.pts);
              } catch {
                /* ignore */
              }
            }
          });
          hls.loadSource(url);
          hls.attachMedia(video);
          statsIv = setInterval(() => {
            if (hls) cb.onMetrics({ bw: hls.bandwidthEstimate || 0 });
          }, 1000);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = url; // native HLS (Safari)
          await autoplay(video, cb.onLog);
        }
      }
    };

    // ── Ad + stream events → logs ──
    streamManager.addEventListener(T.LOADED, (e: any) => {
      playStitched(e.getStreamData().url);
    });
    streamManager.addEventListener(T.ERROR, (e: any) => {
      const msg = e.getStreamData?.()?.errorMessage || "error desconocido";
      cb.onLog("error", "GAM DAI error: " + msg);
      cb.onState("error");
    });
    streamManager.addEventListener(T.CUEPOINTS_CHANGED, (e: any) => {
      const cps = e.getStreamData?.().cuepoints || [];
      cb.onLog(
        "scte",
        `GAM cuepoints — ${cps.length} ad break(s): ${cps
          .map((c: any) => `@${(c.start ?? 0).toFixed(0)}s${c.played ? "✓" : ""}`)
          .join(", ")}`
      );
    });

    const adEvent = (e: any) => {
      const ad = e.getAd?.();
      let info = "";
      if (ad) {
        const pod = ad.getAdPodInfo?.();
        const pos = pod ? `${pod.getAdPosition?.()}/${pod.getTotalAds?.()}` : "?";
        const dur = ad.getDuration?.();
        info = ` — ad ${pos}${dur ? `, ${dur.toFixed(1)}s` : ""}${
          ad.getTitle?.() ? `, "${ad.getTitle()}"` : ""
        }`;
      }
      // Name the splice direction up front: an ad break opening is the SCTE-OUT,
      // closing it is the SCTE-IN. The quartile/click events aren't splices.
      const splice =
        e.type === T.AD_BREAK_STARTED
          ? "SCTE OUT · "
          : e.type === T.AD_BREAK_ENDED
            ? "SCTE IN · "
            : "";
      cb.onLog("scte", `${splice}GAM ${e.type}${info}`);
    };
    [
      T.AD_BREAK_STARTED,
      T.AD_BREAK_ENDED,
      T.STARTED,
      T.FIRST_QUARTILE,
      T.MIDPOINT,
      T.THIRD_QUARTILE,
      T.COMPLETE,
      T.SKIPPED,
      T.CLICK,
    ].forEach((type) => type && streamManager.addEventListener(type, adEvent));

    // ── Build + fire the GAM live stream request ──
    const req: any = new api.LiveStreamRequest();
    req.assetKey = dai.assetKey.trim();
    if (dai.apiKey.trim()) req.apiKey = dai.apiKey.trim();
    // Prefer the SDK's StreamFormat enum if present, else the plain string.
    // NB: on Chrome the SDK/GAM may still serve DASH when the event offers both;
    // we play whatever URL actually comes back (detected below), not the request.
    const SF = api.StreamRequest?.StreamFormat;
    req.format = SF ? (dai.format === "dash" ? SF.DASH : SF.HLS) : dai.format;

    cb.onLog("info", `Petición DAI LIVE — formato pedido: ${dai.format}`);
    streamManager.requestStream(req);
  }

  function destroy() {
    if (statsIv) {
      clearInterval(statsIv);
      statsIv = null;
    }
    stopNativeTracing();
    try {
      hls?.destroy?.();
    } catch {
      /* noop */
    }
    try {
      shakaPlayer?.destroy?.();
    } catch {
      /* noop */
    }
    try {
      streamManager?.reset?.();
    } catch {
      /* noop */
    }
    hls = shakaPlayer = streamManager = null;
    audioSel.clear();
  }

  return { load, destroy, selectAudio, selectText, selectQuality };
}
