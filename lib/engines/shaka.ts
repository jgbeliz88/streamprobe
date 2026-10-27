import { loadLib } from "./loaders";
import { autoplay } from "./autoplay";
import { hasNetOverrides, proxifyUrl, unproxifyUrl } from "@/lib/proxy";
import { hasAuthToken, makeTokenPropagator } from "@/lib/cdnToken";
import { detectFormat } from "@/lib/format";
import { detectShakaPlatform, setDeviceUserAgent } from "@/lib/deviceEmu";
import { shakaDrmConfig } from "./drm";
import type { EngineCallbacks, EngineController, LoadConfig } from "./types";

// Common Shaka error codes (surfaced by name so a bare number isn't a mystery).
const SHAKA_CODE: Record<number, string> = {
  1001: "BAD_HTTP_STATUS",
  1002: "HTTP_ERROR",
  1003: "TIMEOUT",
  1000: "UNSUPPORTED_SCHEME",
  3016: "VIDEO_ERROR",
  // Manifest (category 4) — names verified against shaka-player/lib/util/error.js
  4032: "CONTENT_UNSUPPORTED_BY_BROWSER",
  4036: "NO_VARIANTS",
  4037: "PERIOD_FLATTENING_FAILED",
  4038: "INCONSISTENT_DRM_ACROSS_PERIODS",
  4040: "HLS_MSE_ENCRYPTED_MP2T_NOT_SUPPORTED",
  4041: "HLS_MSE_ENCRYPTED_LEGACY_APPLE_MEDIA_KEYS_NOT_SUPPORTED",
  // DRM (category 6)
  6000: "DRM_UNSUPPORTED_SCHEME",
  6003: "LICENSE_REQUEST_FAILED",
  6004: "LICENSE_RESPONSE_REJECTED",
  6006: "FAILED_TO_CREATE_SESSION",
  6007: "FAILED_TO_GENERATE_LICENSE_REQUEST",
  6008: "REQUESTED_KEY_SYSTEM_CONFIG_UNAVAILABLE",
  6010: "NO_LICENSE_SERVER_GIVEN",
  6012: "SERVER_CERTIFICATE_REQUIRED",
};
// Shaka RequestType enum → readable name (what failed).
const REQUEST_TYPE: Record<number, string> = {
  0: "manifest",
  1: "segmento",
  2: "licencia",
  3: "app",
  4: "timing",
  5: "cert",
  6: "clave",
  7: "ads",
};

/** Filename (or host) of a URL, for a compact log line. Unwraps the proxy
 *  URL (/api/proxy?u=<encoded>) so the real CDN path shows, not "proxy". */
function urlTail(u: string): string {
  let real = u;
  const m = u.match(/[?&]u=([^&]+)/);
  if (m) {
    try {
      real = decodeURIComponent(m[1]);
    } catch {
      /* keep original */
    }
  }
  try {
    const url = new URL(real);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] || url.hostname;
  } catch {
    return real.slice(0, 60);
  }
}

/** Decode a network error's response body (string / ArrayBuffer / typed array)
 *  to text — license servers put the rejection reason (missing token…) here. */
function decodeBody(d: any): string {
  if (!d) return "";
  try {
    if (typeof d === "string") return d.replace(/\s+/g, " ").trim();
    if (d instanceof ArrayBuffer || d?.buffer)
      return new TextDecoder().decode(d).replace(/\s+/g, " ").trim();
  } catch {
    /* binary / undecodable */
  }
  return "";
}

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

function releasePidOf(url: string): string {
  try {
    return new URL(url).searchParams.get("releasePid") || "";
  } catch {
    return "";
  }
}

/**
 * Why "CONTENT_UNSUPPORTED_BY_BROWSER" (4032) / "NO_VARIANTS" (4036): Shaka drops
 * every variant whose codec the browser can't decode, then reports a bare code.
 * Pull the codec strings out of the manifest (DASH `codecs="…"`, HLS `CODECS="…"`)
 * and test each against MSE, so the log names the culprit — essential on a phone
 * or TV where there is no console to probe from.
 */
function codecSupportReport(manifestText: string): string {
  if (!manifestText) return "";
  const found = new Set<string>();
  for (const m of manifestText.matchAll(/codecs\s*=\s*"([^"]+)"/gi)) {
    for (const c of m[1].split(",")) {
      const t = c.trim();
      if (t) found.add(t);
    }
  }
  if (!found.size) return "";
  const isVideo = /^(avc|hvc|hev|av01|vp0?9|vp8|dvh|dva)/i;
  const isAudio = /^(mp4a|ec-3|ec3|ac-3|ac3|ac-4|opus|flac|alac|dtsc)/i;
  const supported = (mime: string) => {
    try {
      return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);
    } catch {
      return false;
    }
  };
  const parts: string[] = [];
  for (const c of found) {
    const mimes = isVideo.test(c)
      ? [`video/mp4; codecs="${c}"`]
      : isAudio.test(c)
        ? [`audio/mp4; codecs="${c}"`]
        : [`video/mp4; codecs="${c}"`, `audio/mp4; codecs="${c}"`];
    parts.push(`${c} ${mimes.some(supported) ? "✓" : "✗"}`);
  }
  return parts.join(" · ");
}

/** Turn a Shaka ErrorEvent detail into a human line, incl. HTTP status. */
function describeShakaError(err: any): string {
  const code = err?.code;
  const name = SHAKA_CODE[code] ? ` ${SHAKA_CODE[code]}` : "";
  const data: any[] = Array.isArray(err?.data) ? err.data : [];
  let extra = "";
  if (code === 1001) {
    // BAD_HTTP_STATUS: data = [uri, httpStatus, body, headers, requestType]
    const status = data[1];
    const rt = REQUEST_TYPE[data[4]] ? ` ${REQUEST_TYPE[data[4]]}` : "";
    const body = decodeBody(data[2]);
    extra =
      ` — HTTP ${status ?? "?"}${rt}${data[0] ? ` · ${urlTail(String(data[0]))}` : ""}` +
      (body ? ` · ${body.slice(0, 200)}` : "");
  } else if (code === 1002 || code === 1003) {
    // HTTP_ERROR / TIMEOUT: data[0] = uri
    const rt = REQUEST_TYPE[data[2]] ? ` ${REQUEST_TYPE[data[2]]}` : "";
    extra = `${rt}${data[0] ? ` · ${urlTail(String(data[0]))}` : ""}`;
  } else if (code === 4012) {
    // RESTRICTIONS_CANNOT_BE_MET: data[0] = RestrictionInfo — why no variant is
    // playable (key statuses from the CDM, KIDs missing from the licence…).
    const ri: any = data[0] || {};
    const bits: string[] = [];
    if (ri.hasAppRestrictions) bits.push("restricciones de la app");
    if (ri.missingKeys?.length) bits.push(`KIDs sin licencia: ${ri.missingKeys.join(", ")}`);
    if (ri.restrictedKeyStatuses?.length) bits.push(`key status: ${ri.restrictedKeyStatuses.join(", ")}`);
    if (bits.length) extra = ` — ${bits.join(" · ")}`;
  } else if (code >= 6000 && code < 7000) {
    // DRM errors wrap the real cause in data[0]. Often it's another Shaka error
    // (e.g. the license/cert request failing 1001/1002) — recurse to show its
    // URL/status; otherwise it's an EME/DOMException, so show its message.
    const u: any = data[0];
    if (u && typeof u === "object" && typeof u.code === "number") {
      extra = ` — ${describeShakaError(u)}`;
    } else {
      const detail =
        u && typeof u === "object" ? u.message || u.name || "" : u != null ? String(u) : "";
      if (detail) extra = ` — ${detail}`;
    }
  } else if (typeof data[0] === "string" && /^https?:/i.test(data[0])) {
    extra = ` · ${urlTail(data[0])}`;
  }
  return `Shaka [${code}${name}]: ${err?.message || "error"}${extra}`;
}

export function createShaka(cb: EngineCallbacks): EngineController {
  let lastManifestText = "";
  let pinnedQuality: string | null = null;
  let player: any = null;
  let statsIv: ReturnType<typeof setInterval> | null = null;
  let curBitrate = 0;
  const audioSel = new Map<
    string,
    { language: string; role?: string; channelsCount?: number; label?: string }
  >();

  /** 4032/4036 mean "nothing here is playable" — name the codecs that failed. */
  function reportUnsupportedCodecs(code: unknown) {
    if (code !== 4032 && code !== 4036) return;
    const rep = codecSupportReport(lastManifestText);
    if (rep) {
      cb.onLog("error", `Códecs del manifest vs soporte del navegador: ${rep}`);
      cb.onLog("info", "Los marcados ✗ no los puede decodificar este dispositivo (típico: HEVC/AV1/Dolby en Android).");
    } else {
      cb.onLog("info", "No se pudieron leer los códecs del manifest para diagnosticar.");
    }
  }

  function reportTracks() {
    if (!player) return;
    try {
      audioSel.clear();
      const audio: any[] = [];
      for (const v of player.getVariantTracks()) {
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
      const visible = player.isTextTrackVisible();
      const text = player.getTextTracks().map((t: any) => ({
        id: String(t.id),
        lang: t.language,
        label: [t.language || "und", t.label, t.forced ? "forced" : ""]
          .filter(Boolean)
          .join(" · "),
        active: !!t.active && visible,
      }));
      cb.onTracks(audio, text);
      reportQualities();
    } catch {
      /* networking/tracks unavailable */
    }
  }

  /** Video renditions the user can pin. Shaka exposes them as variant tracks;
   *  dedupe by video stream so audio permutations don't multiply the list. */
  function qualityId(v: any): string {
    return String(v.videoId ?? `${v.height}|${v.videoBandwidth ?? v.bandwidth}`);
  }
  function reportQualities() {
    if (!player) return;
    try {
      const seen = new Map<string, any>();
      for (const v of player.getVariantTracks()) {
        if (!v.height) continue;
        const id = qualityId(v);
        if (!seen.has(id)) seen.set(id, v);
      }
      const list = [...seen.entries()]
        .sort((a, b) => (b[1].height || 0) - (a[1].height || 0))
        .map(([id, v]) => {
          const bps = v.videoBandwidth || v.bandwidth || 0;
          return {
            id,
            label: `${v.height}p${bps ? ` · ${(bps / 1e6).toFixed(1)} Mbps` : ""}`,
            active: pinnedQuality === id,
          };
        });
      cb.onQualities(list);
    } catch {
      /* tracks not available yet */
    }
  }

  /** Pin a rendition (ABR off) or hand control back to ABR with null. */
  function selectQuality(id: string | null) {
    if (!player) return;
    if (id === null) {
      pinnedQuality = null;
      player.configure({ abr: { enabled: true } });
      cb.onLog("abr", "Calidad: Auto (ABR activado)");
    } else {
      const t = player.getVariantTracks().find((v: any) => qualityId(v) === id);
      if (t) {
        pinnedQuality = id;
        player.configure({ abr: { enabled: false } });
        player.selectVariantTrack(t, true);
        cb.onLog("abr", `Calidad fijada: ${t.height}p (ABR desactivado)`);
      }
    }
    reportQualities();
  }

  function selectAudio(id: string) {
    const sel = audioSel.get(id);
    if (sel && player) {
      try {
        player.selectAudioLanguage(sel.language, sel.role, sel.channelsCount, sel.label);
      } catch {
        player.selectAudioLanguage(sel.language, sel.role);
      }
    }
  }

  function selectText(id: string | null) {
    if (!player) return;
    if (id === null) {
      player.setTextTrackVisibility(false);
    } else {
      const t = player.getTextTracks().find((x: any) => String(x.id) === id);
      if (t) {
        player.selectTextTrack(t);
        player.setTextTrackVisibility(true);
      }
    }
    reportTracks();
  }

  async function load(video: HTMLVideoElement, cfg: LoadConfig) {
    // Emulate a SmartTV UA before Shaka loads so its platform detection engages
    // the TV code paths. With no override, the device's own UA is used as-is.
    setDeviceUserAgent(cfg.deviceUserAgent);
    cb.onLog(
      "info",
      `${cfg.deviceUserAgent ? "Emulated" : "Device"} User-Agent: ${navigator.userAgent}`
    );

    cb.onLog("info", `Loading Shaka Player ${cfg.version} (bundled)…`);
    const shaka: any = await loadLib("shaka", cfg.version);

    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      cb.onLog("error", "Browser not supported by Shaka Player");
      cb.onState("error");
      return;
    }

    player = new shaka.Player();
    await player.attach(video);

    const platform = detectShakaPlatform(shaka);
    cb.onLog(
      "info",
      `Shaka platform: ${platform} · smoothCodecSwitch=${
        (() => {
          try {
            return shaka.util.Platform.supportsSmoothCodecSwitching();
          } catch {
            return "?";
          }
        })()
      }`
    );

    const {
      matchTv,
      bufferGoal,
      rebufferGoal,
      audioLang,
      returnToLiveWindow,
      stalledMinDuration,
    } = cfg.advanced;

    // TV-faithful mode: mirror the SmartTV app (mitele), which runs Shaka with
    // default config and only sets drm.servers — no streaming/buffer tuning.
    const conf: any = {};
    if (matchTv) {
      cb.onLog("info", "Shaka config: TV-faithful (defaults, no streaming tuning)");
    } else {
      conf.streaming = {
        bufferingGoal: bufferGoal,
        rebufferingGoal: rebufferGoal,
        returnToEndOfLiveWindowWhenOutside: returnToLiveWindow,
        stallEnabled: true,
        stallThreshold: stalledMinDuration || 1,
      };
      if (audioLang) conf.preferredAudioLanguage = audioLang;
    }

    const drmConf = shakaDrmConfig(cfg.drm);
    if (drmConf) {
      conf.drm = drmConf;
      cb.onLog("drm", `DRM: ${cfg.drm.system.toUpperCase()} → ${cfg.drm.licenseUrl}`);
    }

    // FairPlay content-id = the licence's **releasePid** (proven: thePlatform's
    // KSM validates the SPC's asset-id against the releasePid, not the skd:// KID).
    // Native HLS uses the init data AS the content-id, so return the releasePid
    // bytes; the session is then created for the releasePid, so the returned CKC
    // (also keyed to the releasePid) applies cleanly.
    if (cfg.drm.enabled && cfg.drm.system === "fairplay") {
      const conf2: any = conf.drm as any;
      const releasePid = releasePidOf(cfg.drm.licenseUrl);
      conf2.initDataTransform = (initData: Uint8Array, initDataType: string) => {
        if (initDataType !== "skd" || !releasePid) return initData;
        cb.onLog("drm", `FairPlay: content-id = releasePid "${releasePid}" (UTF-8, nativo)`);
        return new TextEncoder().encode(releasePid);
      };
    }

    // FairPlay: use Safari's native HLS, exactly like the Mediaset app (MSE
    // FairPlay in Safari fails with a 3016 video error). Native HLS fetches
    // segments itself, bypassing the proxy → the CDN 403s them; so the manifest
    // is loaded through the rewriting proxy (rw=1, see below), which points every
    // child playlist/segment back through the proxy with the injected Origin.
    // Shaka's Apple MediaKeys polyfill still routes the licence + certificate
    // through its NetworkingEngine (our filters), producing the same SPC the app
    // does (its uh init-data layout → the assetId thePlatform accepts).
    if (cfg.drm.enabled && cfg.drm.system === "fairplay") {
      // Match the Mediaset app exactly: `useNativeHlsForFairPlay` engages Shaka's
      // Apple MediaKeys polyfill, which applies the `uh` init-data transform
      // (stripping skd:// → contentId). Plain `useNativeHlsOnSafari` leaves the
      // raw skd URI as the content-id (we sent `skd://cb795e2e…` → 422).
      conf.streaming = {
        ...(conf.streaming || {}),
        useNativeHlsOnSafari: true,
        useNativeHlsForFairPlay: true,
      };
      cb.onLog("info", "FairPlay: HLS nativo + polyfill Apple (como la app) — segmentos por el proxy (rw)");
    }

    // Pin the highest rendition: turn off ABR so it can't drop the quality.
    if (cfg.advanced.lockMaxQuality) {
      conf.abr = { enabled: false };
      cb.onLog("info", "Calidad fijada al máximo (ABR desactivado)");
    }

    player.configure(conf);

    const RT = shaka.net.NetworkingEngine.RequestType;

    // Query-token CDNs list children as relative paths, so resolving them drops
    // the manifest's `?hdnts=…` and the CDN answers 403 (surfacing as error 1001).
    const addToken = makeTokenPropagator(cfg.url);
    const useProxy = hasNetOverrides(cfg.net);
    if (hasAuthToken(cfg.url)) {
      cb.onLog("info", "Token de auth del manifest propagado a las peticiones hijas");
    }
    if (useProxy) cb.onLog("info", "Proxy ON — injecting CDN headers on media requests");
    if (useProxy && cfg.drm.enabled) {
      cb.onLog("drm", "Petición de licencia enrutada por el proxy (evita CORS)");
    }

    player.getNetworkingEngine().registerRequestFilter((type: number, request: any) => {
      if (!Array.isArray(request.uris)) return;
      if (type === RT.LICENSE) {
        // Attach the DRM license headers (auth token, etc.). Shaka has no
        // drm.advanced.headers, so the request filter is the only way.
        const drmHeaders = cfg.drm.headers;
        if (drmHeaders && Object.keys(drmHeaders).length) {
          request.headers = { ...request.headers, ...drmHeaders };
        }
        // thePlatform FairPlay wants the SPC base64-wrapped in JSON:
        // {"getFairplayLicense":{"spcMessage":"<base64>","releasePid":…}}.
        if (cfg.drm.system === "fairplay") {
          const raw = request.body;
          const spc = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
          request.body = JSON.stringify({
            getFairplayLicense: {
              spcMessage: bytesToBase64(spc),
              releasePid: releasePidOf(cfg.drm.licenseUrl),
            },
          });
          cb.onLog("drm", `FairPlay: SPC ${spc.byteLength} B → JSON getFairplayLicense`);
        }
        // A license POST straight from the browser hits CORS (license servers
        // rarely allow it). Route it through the proxy (server-side) when on.
        // No token propagation here — the license server is a different host.
        if (useProxy) request.uris = request.uris.map((u: string) => proxifyUrl(u, cfg.net));
        return;
      }
      // Token first, then proxying — the proxy has to wrap the final CDN URL.
      request.uris = request.uris.map((u: string) => {
        const withToken = addToken(u);
        return useProxy ? proxifyUrl(withToken, cfg.net) : withToken;
      });
    });

    // Network traces via a response filter.
    try {
      const kindOf = (type: number): any => {
        if (type === RT.MANIFEST) return "manifest";
        if (type === RT.SEGMENT) return "segment";
        if (type === RT.LICENSE) return "license";
        if (type === RT.INIT_SEGMENT) return "init";
        return "other";
      };
      player.getNetworkingEngine().registerResponseFilter((type: number, response: any) => {
        // Restore the real URI so relative segment/BaseURL resolution targets
        // the real CDN, not the local proxy (which would 404).
        const real = unproxifyUrl(response.uri);
        if (real) response.uri = real;

        // thePlatform FairPlay wraps the CKC in JSON; Shaka needs the raw CKC.
        // Extract with a regex (JSON.parse can choke on trailing bytes/encoding,
        // which would leave the JSON as the "CKC" → Safari error 6008).
        if (type === RT.LICENSE && cfg.drm.system === "fairplay" && response.data) {
          try {
            const text = new TextDecoder().decode(response.data);
            const key = '"ckcResponse":"';
            const i = text.indexOf(key);
            let ckc = "";
            if (i >= 0) {
              const rest = text.slice(i + key.length);
              const j = rest.indexOf('"');
              ckc = j >= 0 ? rest.slice(0, j) : rest;
            }
            if (ckc) {
              response.data = base64ToBytes(ckc).buffer;
              cb.onLog("drm", `FairPlay: CKC ${response.data.byteLength} B (resp ${text.length} B) — aplicando`);
            } else {
              // No CKC — an error body (expired token, etc.). Log it and let the
              // update fail cleanly rather than throwing a RESPONSE_FILTER_ERROR.
              cb.onLog("error", `FairPlay: licencia sin CKC (resp ${text.length} B) · ${text.slice(0, 220)}`);
            }
          } catch (e: any) {
            cb.onLog("error", `FairPlay: fallo procesando la licencia — ${e?.message || e}`);
          }
        }

        const bytes = response.data ? response.data.byteLength : undefined;
        // Read the headers the proxy echoed back to confirm what was injected.
        const h = response.headers || {};
        const sentOrigin = h["x-sp-sent-origin"];
        const sentReferer = h["x-sp-sent-referer"];
        const sentUa = h["x-sp-sent-user-agent"];
        const sent =
          sentOrigin || sentReferer || sentUa
            ? { origin: sentOrigin, referer: sentReferer, userAgent: sentUa }
            : undefined;
        cb.onNetwork({
          time: new Date(),
          kind: kindOf(type),
          url:
            unproxifyUrl(response.originalUri || "") ||
            response.uri ||
            response.originalUri ||
            "",
          bytes,
          durationMs: typeof response.timeMs === "number" ? response.timeMs : undefined,
          sent,
        });
        // Capture every manifest (initial + live refreshes) as raw text.
        if (type === RT.MANIFEST && response.data) {
          try {
            const text = new TextDecoder().decode(new Uint8Array(response.data));
            lastManifestText = text;
            cb.onManifest({ text, bytes });
          } catch {
            /* non-text manifest */
          }
        }
      });
    } catch {
      /* networking engine unavailable */
    }

    player.addEventListener("error", (e: any) => {
      cb.onLog("error", describeShakaError(e.detail));
      reportUnsupportedCodecs(e.detail?.code);
      cb.onState("error");
    });

    // ── Playback-health instrumentation (period-boundary stalls / gaps) ──
    // A gap Shaka jumps on desktop is exactly where an old TV MSE (no gap
    // jumping) would freeze. Report gaps, stalls and buffered ranges so the
    // period boundary can be inspected.
    const bufferedRanges = (): string => {
      try {
        const b = video.buffered;
        const parts: string[] = [];
        for (let i = 0; i < b.length; i++) {
          parts.push(`[${b.start(i).toFixed(2)}–${b.end(i).toFixed(2)}]`);
        }
        return parts.join(" ") || "empty";
      } catch {
        return "?";
      }
    };
    player.addEventListener("gapjumped", () => {
      cb.onLog(
        "warn",
        `GAP JUMPED @${video.currentTime.toFixed(2)}s — buffered ${bufferedRanges()} ` +
          `(a player without gap-jumping, e.g. an old TV, would stall here)`
      );
    });
    player.addEventListener("stalldetected", () => {
      cb.onLog(
        "buffer",
        `STALL detected @${video.currentTime.toFixed(2)}s — buffered ${bufferedRanges()}`
      );
    });

    // ── SCTE-35 / DASH event instrumentation ──
    const secs = (n: number | undefined) =>
      typeof n === "number" ? n.toFixed(2) + "s" : "?";
    const hex = (data: any): string => {
      try {
        const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        if (!arr || !arr.length) return "";
        return Array.from(arr.slice(0, 48) as Uint8Array)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      } catch {
        return "";
      }
    };
    const isScte = (uri: string) => /scte(35|_35|:35)?/i.test(uri || "");

    // In-band emsg boxes (often carry SCTE-35 splice info).
    player.addEventListener("emsg", (e: any) => {
      const d = e.detail || {};
      const data = hex(d.messageData);
      const tag = isScte(d.schemeIdUri) ? "SCTE-35 emsg" : "emsg";
      cb.onLog(
        "scte",
        `${tag} scheme=${d.schemeIdUri || "?"} value=${d.value ?? ""} id=${d.id ?? ""} ` +
          `@${secs(d.startTime)}→${secs(d.endTime)}${data ? " data=" + data : ""}`
      );
    });

    // MPD EventStream / Event regions (SCTE-35 markers, ad breaks, boundaries).
    ["timelineregionadded", "timelineregionenter", "timelineregionexit"].forEach(
      (evName) => {
        player.addEventListener(evName, (e: any) => {
          const r = e.detail || {};
          const phase = evName.replace("timelineregion", "");
          // Crossing into a marked region is the SCTE-OUT, leaving it the SCTE-IN;
          // "added" only registers the marker, so it names no direction.
          const dir = phase === "enter" ? "SCTE OUT · " : phase === "exit" ? "SCTE IN · " : "";
          const tag = (isScte(r.schemeIdUri) ? "SCTE-35 region" : "region");
          let xml = "";
          try {
            if (r.eventElement && (r.eventElement as Element).outerHTML) {
              xml = (r.eventElement as Element).outerHTML.replace(/\s+/g, " ").slice(0, 160);
            }
          } catch {
            /* no element */
          }
          cb.onLog(
            "scte",
            `${dir}${tag} ${phase} scheme=${r.schemeIdUri || "?"} value=${r.value ?? ""} ` +
              `id=${r.id ?? ""} @${secs(r.startTime)}→${secs(r.endTime)}${xml ? " " + xml : ""}`
          );
        });
      }
    );

    player.addEventListener("adaptation", () => {
      const t = player.getVariantTracks().find((v: any) => v.active);
      if (t) {
        cb.onAbr(curBitrate, t.bandwidth, { w: t.width, h: t.height });
        curBitrate = t.bandwidth;
        cb.onMetrics({ bitrate: t.bandwidth });
      }
    });

    statsIv = setInterval(() => {
      if (!player) return;
      const st = player.getStats();
      const patch: any = { bw: st.estimatedBandwidth || 0 };
      if (st.streamBandwidth) {
        patch.bitrate = st.streamBandwidth;
        curBitrate = st.streamBandwidth;
      }
      if (st.liveLatency !== undefined) patch.latency = st.liveLatency;
      if (st.droppedFrames) patch.dropped = st.droppedFrames;
      cb.onMetrics(patch);
    }, 1000);

    // Audio/subtitle track list — report on load and whenever it changes.
    ["trackschanged", "adaptation", "variantchanged", "textchanged", "texttrackvisibility"].forEach(
      (ev) => player.addEventListener(ev, reportTracks)
    );

    // Tell Shaka the manifest type explicitly. Its own guessing fails on URLs
    // with no basename before the extension (e.g. Unified Streaming's ".../.m3u8"
    // or ".../.mpd") → UNABLE_TO_GUESS_MANIFEST_TYPE. Our URL detection handles it.
    const MIME: Record<string, string> = {
      dash: "application/dash+xml",
      hls: "application/x-mpegurl",
      smooth: "application/vnd.ms-sstr+xml",
    };
    const mime = MIME[detectFormat(cfg.url)];

    // FairPlay: load through the rewriting proxy so Shaka does native-HLS-WITH-the
    // Apple-polyfill (segments proxied, and the polyfill runs our initDataTransform)
    // rather than pure native HLS (where Safari handles keys and the transform
    // never runs).
    let loadUrl = cfg.url;
    if (cfg.drm.enabled && cfg.drm.system === "fairplay" && useProxy) {
      const p = proxifyUrl(cfg.url, cfg.net);
      loadUrl = p.includes("/api/proxy?") ? `${p}&rw=1` : p;
    }

    cb.onLog("info", `Loading manifest: ${cfg.url}${mime ? ` (${mime})` : ""}`);
    try {
      await player.load(loadUrl, null, mime);
      const tracks = player.getVariantTracks();
      cb.onLog("info", `Manifest loaded — ${tracks.length} variants`);
      // The key system Shaka actually picked (the manifest may signal several).
      if (cfg.drm.enabled) {
        const ks = player.keySystem?.() || "";
        cb.onLog("drm", `DRM activo: ${ks || "ninguno (¿contenido en claro?)"}`);
      }
      reportTracks();

      // With ABR off, pin the highest-bandwidth variant and re-assert it on
      // every track change (live period boundaries can otherwise reset it).
      if (cfg.advanced.lockMaxQuality) {
        const highest = (vs: any[]) =>
          vs.reduce((a: any, b: any) => (b.bandwidth > a.bandwidth ? b : a));
        const pinTop = () => {
          const vs = player.getVariantTracks();
          if (vs.length && !highest(vs).active)
            player.selectVariantTrack(highest(vs), /* clearBuffer */ true);
        };
        pinTop();
        player.addEventListener("trackschanged", pinTop);
        const top = highest(tracks);
        cb.onLog("info", `Fijado a ${Math.round(top.bandwidth / 1000)} kbps (${top.width || "?"}×${top.height || "?"})`);
      }

      const active = tracks.find((t: any) => t.active);
      if (active) {
        curBitrate = active.bandwidth;
        cb.onMetrics({ bitrate: active.bandwidth });
      }
      await autoplay(video, cb.onLog);
    } catch (e: any) {
      // A shaka.util.Error carries a numeric code (+ HTTP status for 1001);
      // describe it the same as a playback-time error. Fall back for plain JS.
      cb.onLog(
        "error",
        typeof e?.code === "number" ? describeShakaError(e) : "Load failed: " + (e?.message || e)
      );
      reportUnsupportedCodecs(e?.code);
      cb.onState("error");
      throw e;
    }
  }

  function destroy() {
    if (statsIv) {
      clearInterval(statsIv);
      statsIv = null;
    }
    try {
      if (player?.destroy) player.destroy();
    } catch {
      /* noop */
    }
    player = null;
    audioSel.clear();
  }

  return { load, destroy, selectAudio, selectText, selectQuality };
}
