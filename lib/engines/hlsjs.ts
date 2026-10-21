import { loadLib } from "./loaders";
import { autoplay } from "./autoplay";
import { hasNetOverrides, proxifyUrl, unproxifyUrl } from "@/lib/proxy";
import { hasAuthToken, makeTokenPropagator } from "@/lib/cdnToken";
import type { EngineCallbacks, EngineController, LoadConfig } from "./types";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** UTF-16LE bytes of a string — the encoding Safari uses for FairPlay 'skd'
 *  init data (the skd:// URI). Used to bind the SPC's content-id to the skd. */
function strToUtf16le(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
}

/** releasePid query param from the license URL — thePlatform wants it in the body. */
function releasePidOf(url: string): string {
  try {
    return new URL(url).searchParams.get("releasePid") || "";
  } catch {
    return "";
  }
}

function decodeText(d: any): string {
  if (!d) return "";
  try {
    if (typeof d === "string") return d.replace(/\s+/g, " ").trim();
    if (d instanceof ArrayBuffer || d?.buffer)
      return new TextDecoder().decode(d).replace(/\s+/g, " ").trim();
  } catch {
    /* binary */
  }
  return "";
}

/** HTTP status + response body from an hls.js error (license/network failures)
 *  — so keySystemLicenseRequestFailed shows *why* (403/422 + the server text). */
function errDetail(d: any): string {
  const xhr = d?.networkDetails;
  const resp = d?.response;
  let status: number | undefined;
  let body: any;
  // Prefer the XHR's actual response body (arraybuffer/text) over resp.text,
  // which is often just the status line ("Bad Request").
  if (xhr && typeof xhr.status === "number") {
    status = xhr.status;
    try {
      body = xhr.response;
    } catch {
      /* responseType mismatch */
    }
    if (body == null) {
      try {
        body = xhr.responseText;
      } catch {
        /* arraybuffer type */
      }
    }
  }
  if (resp && typeof resp === "object") {
    if (status == null) status = resp.code ?? resp.status;
    if (body == null) body = resp.data ?? resp.text;
  }
  const bodyText = decodeText(body);
  if (status == null && !bodyText) return "";
  return ` — HTTP ${status ?? "?"}${bodyText ? ` · ${bodyText.slice(0, 200)}` : ""}`;
}

export function createHlsjs(cb: EngineCallbacks): EngineController {
  let hls: any = null;
  let Hls: any = null;
  let statsIv: ReturnType<typeof setInterval> | null = null;
  let curBitrate = 0;

  const trackLabel = (t: any, fallback: string) =>
    [t.lang || t.language, t.name].filter(Boolean).join(" · ") || fallback;

  function reportTracks() {
    if (!hls) return;
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

  /** Video renditions from the master playlist. hls.js indexes them by level. */
  function reportQualities() {
    if (!hls) return;
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

  /** Pin a level (ABR off) or -1 to hand control back to ABR. */
  function selectQuality(id: string | null) {
    if (!hls) return;
    if (id === null) {
      hls.currentLevel = -1;
      cb.onLog("abr", "Calidad: Auto (ABR activado)");
    } else {
      const i = parseInt(id, 10);
      hls.currentLevel = i;
      const l = hls.levels?.[i];
      cb.onLog("abr", `Calidad fijada: ${l?.height ? `${l.height}p` : `nivel ${i}`} (ABR desactivado)`);
    }
    reportQualities();
  }

  function selectAudio(id: string) {
    if (hls) hls.audioTrack = parseInt(id, 10);
  }
  function selectText(id: string | null) {
    if (!hls) return;
    if (id === null) {
      hls.subtitleTrack = -1;
      hls.subtitleDisplay = false;
    } else {
      hls.subtitleTrack = parseInt(id, 10);
      hls.subtitleDisplay = true;
    }
    reportTracks();
  }

  async function load(video: HTMLVideoElement, cfg: LoadConfig) {
    cb.onLog("info", `Loading hls.js ${cfg.version} (bundled)…`);
    Hls = await loadLib("hlsjs", cfg.version);

    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        cb.onLog("info", "Using native HLS (Safari)");
        video.src = proxifyUrl(cfg.url, cfg.net);
        video.load();
        await autoplay(video, cb.onLog);
        return;
      }
      cb.onLog("error", "HLS not supported in this browser");
      cb.onState("error");
      throw new Error("HLS not supported");
    }

    const hlsCfg: any = {
      maxBufferLength: cfg.advanced.bufferGoal || 30,
      maxMaxBufferLength: 120,
      startLevel: -1,
      enableWorker: true,
    };

    // Query-token CDNs list children as relative paths, so resolving them drops
    // the manifest's `?hdnts=…` and the CDN answers 403/404.
    const addToken = makeTokenPropagator(cfg.url);
    if (hasAuthToken(cfg.url)) {
      cb.onLog("info", "Token de auth del manifest propagado a las peticiones hijas");
    }

    // Route all requests (playlists, fragments, keys) through the proxy to
    // inject Origin / Referer / User-Agent headers.
    if (hasNetOverrides(cfg.net) || hasAuthToken(cfg.url)) {
      const useProxy = hasNetOverrides(cfg.net);
      const Base = Hls.DefaultConfig.loader;
      class ProxyLoader extends Base {
        load(context: any, config: any, callbacks: any) {
          const realUrl: string | undefined = context?.url && addToken(context.url);
          if (realUrl) context.url = useProxy ? proxifyUrl(realUrl, cfg.net) : realUrl;
          // Restore the real URL on the response so hls.js resolves relative
          // playlist/segment URLs against the real CDN, not /api/proxy (which
          // would 404). Mirrors the Shaka response filter.
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = (response: any, stats: any, ctx: any, net: any) => {
            if (realUrl) {
              if (response) response.url = realUrl;
              if (ctx) ctx.url = realUrl;
            }
            onSuccess(response, stats, ctx, net);
          };
          super.load(context, config, callbacks);
        }
      }
      hlsCfg.loader = ProxyLoader;
      if (useProxy) cb.onLog("info", "Proxy ON — injecting CDN headers on media requests");
    }

    if (cfg.drm.enabled) {
      const { system, licenseUrl } = cfg.drm;
      if (system === "fairplay") {
        // FairPlay only exists in Safari; hls.js uses MSE + modern EME
        // (com.apple.fps). This works when thePlatform's KSM validates the manifest
        // keyId as the SPC content-id (e.g. Mitele) — hls.js's default. When the
        // asset-id is a separate value (a Content ID override, e.g. Infinity's
        // releasePid) modern EME rejects the CKC (`session.update` TypeError), and
        // that stream must use the native engine (legacy WebKitMediaKeys).
        if (!cfg.drm.certUrl) cb.onLog("warn", "FairPlay: falta la URL de certificado (obligatoria)");
        const releasePid = releasePidOf(licenseUrl);
        hlsCfg.emeEnabled = true;
        hlsCfg.drmSystems = {
          "com.apple.fps": {
            licenseUrl: proxifyUrl(licenseUrl, cfg.net),
            serverCertificateUrl: cfg.drm.certUrl ? proxifyUrl(cfg.drm.certUrl, cfg.net) : undefined,
            // Only override the content-id when explicitly set — otherwise use
            // hls.js's default (the manifest keyId), which is what MSE can apply.
            ...(cfg.drm.contentId
              ? {
                  generateRequest: () => {
                    cb.onLog("drm", `FairPlay: content-id override "${cfg.drm.contentId}"`);
                    return { initDataType: "skd", initData: new TextEncoder().encode(cfg.drm.contentId) };
                  },
                }
              : {}),
          },
        };
        hlsCfg.licenseXhrSetup = (xhr: XMLHttpRequest, _url: string, _ctx: any, challenge: any) => {
          for (const [k, v] of Object.entries(cfg.drm.headers)) xhr.setRequestHeader(k, v);
          const spc = challenge instanceof Uint8Array ? challenge : new Uint8Array(challenge);
          cb.onLog("drm", `FairPlay: SPC ${spc.byteLength} B → JSON getFairplayLicense`);
          return JSON.stringify({ getFairplayLicense: { spcMessage: bytesToBase64(spc), releasePid } });
        };
        hlsCfg.licenseResponseCallback = (xhr: XMLHttpRequest): ArrayBuffer => {
          reportLicense(xhr, licenseUrl);
          try {
            const text =
              typeof xhr.response === "string" ? xhr.response : new TextDecoder().decode(xhr.response);
            const m = /"ckcResponse"\s*:\s*"([^"]+)"/.exec(text);
            if (m) return base64ToBytes(m[1]).buffer as ArrayBuffer;
          } catch {
            /* return as-is */
          }
          return xhr.response;
        };
        cb.onLog("drm", "FairPlay via hls.js (EME) — licencia y certificado por el proxy");
      } else if (system === "widevine") {
        hlsCfg.emeEnabled = true;
        hlsCfg.widevineLicenseUrl = licenseUrl;
        hlsCfg.licenseResponseCallback = (xhr: XMLHttpRequest): ArrayBuffer => {
          reportLicense(xhr, licenseUrl);
          return xhr.response;
        };
        cb.onLog("drm", "Widevine via EME enabled");
      } else {
        cb.onLog("warn", "PlayReady is not supported by hls.js");
      }
    }

    hls = new Hls(hlsCfg);
    hls.loadSource(cfg.url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, (_ev: any, d: any) => {
      cb.onLog("info", `Manifest parsed — ${d.levels.length} levels`);
      reportTracks();
      autoplay(video, cb.onLog);
    });
    [
      "AUDIO_TRACKS_UPDATED",
      "AUDIO_TRACK_SWITCHED",
      "SUBTITLE_TRACKS_UPDATED",
      "SUBTITLE_TRACK_SWITCH",
    ].forEach((name) => {
      if (Hls.Events[name]) hls.on(Hls.Events[name], reportTracks);
    });
    // Capture the playlists themselves for the Manifest panel. usePlayer only
    // fetches the master once, so without this a live stream shows a single stale
    // entry and never the media-playlist refreshes.
    const capturePlaylist = (d: any, note: string) => {
      const xhr = d?.networkDetails;
      const raw = xhr?.responseText;
      const rawUrl = xhr?.responseURL || d?.details?.url || d?.url;
      if (rawUrl && note !== "master") {
        // The master is already reported by MANIFEST_LOADED; media playlists were
        // captured for the Manifest tab but never listed in Network.
        cb.onNetwork({
          time: new Date(),
          kind: "manifest",
          url: unproxifyUrl(rawUrl) || rawUrl,
          status: typeof xhr?.status === "number" ? xhr.status : undefined,
          bytes: typeof raw === "string" ? raw.length : undefined,
        });
      }
      if (typeof raw === "string" && raw) {
        cb.onManifest({ text: raw, format: "hls", note, bytes: raw.length });
      }
    };
    // Licence round-trips never showed in Network for hls.js (EME does them
    // internally). licenseResponseCallback sees the XHR for every key system.
    const reportLicense = (xhr: XMLHttpRequest, url: string) =>
      cb.onNetwork({
        time: new Date(),
        kind: "license",
        url,
        status: xhr.status,
        bytes: xhr.response instanceof ArrayBuffer ? xhr.response.byteLength : undefined,
      });
    hls.on(Hls.Events.MANIFEST_LOADED, (_ev: any, d: any) => {
      cb.onNetwork({ time: new Date(), kind: "manifest", url: d?.url || cfg.url });
      capturePlaylist(d, "master");
    });
    if (Hls.Events.LEVEL_LOADED)
      hls.on(Hls.Events.LEVEL_LOADED, (_ev: any, d: any) =>
        capturePlaylist(d, d?.details?.live ? "media playlist (directo)" : "media playlist")
      );
    if (Hls.Events.AUDIO_TRACK_LOADED)
      hls.on(Hls.Events.AUDIO_TRACK_LOADED, (_ev: any, d: any) => capturePlaylist(d, "audio playlist"));
    if (Hls.Events.SUBTITLE_TRACK_LOADED)
      hls.on(Hls.Events.SUBTITLE_TRACK_LOADED, (_ev: any, d: any) =>
        capturePlaylist(d, "subtitle playlist")
      );
    hls.on(Hls.Events.FRAG_LOADED, (_ev: any, d: any) => {
      const frag = d?.frag;
      if (!frag) return;
      const stats = d?.stats || frag.stats;
      const bytes = stats?.total ?? stats?.loaded;
      const dur =
        stats?.loading && stats.loading.end && stats.loading.start
          ? Math.round(stats.loading.end - stats.loading.start)
          : undefined;
      cb.onNetwork({
        time: new Date(),
        kind: "segment",
        mediaType: frag.type,
        url: frag.url,
        bytes,
        durationMs: dur,
      });
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_ev: any, d: any) => {
      const l = hls.levels[d.level];
      cb.onAbr(curBitrate, l.bitrate, { w: l.width, h: l.height });
      curBitrate = l.bitrate;
      cb.onMetrics({ bitrate: l.bitrate });
      reportQualities();
    });
    hls.on(Hls.Events.ERROR, (_ev: any, d: any) => {
      const extra = errDetail(d);
      if (d.fatal) {
        cb.onLog("error", `hls.js fatal: ${d.type}/${d.details}${extra}`);
        cb.onState("error");
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      } else {
        cb.onLog("warn", `hls.js: ${d.details}${extra}`);
      }
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      cb.onMetrics({ bw: hls.bandwidthEstimate || 0 });
    });

    statsIv = setInterval(() => {
      if (!hls) return;
      cb.onMetrics({ bw: hls.bandwidthEstimate || 0 });
    }, 1000);

    cb.onLog("info", "Loading source: " + cfg.url);
  }

  function destroy() {
    if (statsIv) {
      clearInterval(statsIv);
      statsIv = null;
    }
    try {
      if (hls?.destroy) hls.destroy();
    } catch {
      /* noop */
    }
    hls = null;
  }

  return { load, destroy, selectAudio, selectText, selectQuality };
}
