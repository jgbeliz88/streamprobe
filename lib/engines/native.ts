import { hasNetOverrides, proxifyAlways, proxifyUrl, unproxifyUrl } from "@/lib/proxy";
import type { EngineCallbacks, EngineController, LoadConfig, NetworkKind } from "./types";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  // Safari's atob throws "The string contains invalid characters" on url-safe
  // base64 (`-`/`_`), stray chars, or missing padding. Normalise all three:
  // map url-safe → standard, strip anything else (incl. old `=`), then re-pad.
  let s = b64
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/[^A-Za-z0-9+/]/g, "");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function releasePidOf(url: string): string {
  try {
    return new URL(url).searchParams.get("releasePid") || "";
  } catch {
    return "";
  }
}

/** Read a Uint8Array as a UTF-16 string (how Safari encodes the skd initData). */
function utf16ToString(bytes: Uint8Array): string {
  return String.fromCharCode.apply(null, Array.from(new Uint16Array(bytes.buffer)));
}

/** The content-id Apple's FPS flow extracts: everything after `skd://`. */
function extractContentId(initData: Uint8Array): string {
  const s = utf16ToString(initData);
  const i = s.indexOf("skd://");
  return i >= 0 ? s.slice(i + 6) : s;
}

/** UTF-16LE bytes of a string. */
function strToUtf16le(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
}

/**
 * Apple FPS legacy init-data layout for `webkitKeys.createSession` (from Apple's
 * FPS Safari sample): [initData][u32 LE idLen][contentId UTF-16][u32 LE certLen]
 * [certificate] — the initData is NOT length-prefixed. WebKit derives the SPC's
 * content-id from this, so we don't guess the encoding — Safari produces the exact
 * assetId thePlatform expects.
 */
function concatInitDataIdAndCertificate(
  initData: Uint8Array,
  contentId: string,
  cert: Uint8Array,
): Uint8Array {
  const id = strToUtf16le(contentId);
  const buffer = new ArrayBuffer(initData.byteLength + 4 + id.byteLength + 4 + cert.byteLength);
  const dv = new DataView(buffer);
  let off = 0;
  new Uint8Array(buffer, off, initData.byteLength).set(initData); off += initData.byteLength;
  dv.setUint32(off, id.byteLength, true); off += 4;
  new Uint8Array(buffer, off, id.byteLength).set(id); off += id.byteLength;
  dv.setUint32(off, cert.byteLength, true); off += 4;
  new Uint8Array(buffer, off, cert.byteLength).set(cert);
  return new Uint8Array(buffer);
}

/**
 * Safari-native FairPlay for native HLS (video.src = m3u8), replicating the app.
 * Native HLS delivers keys via the LEGACY WebKit API (`webkitneedkey` +
 * `WebKitMediaKeys`), not modern EME `encrypted` — so WebKit generates the SPC
 * with its own content-id (the one thePlatform's KSM accepts). We only relay the
 * certificate + license (JSON {getFairplayLicense:{spcMessage,releasePid}}).
 */
export function setupFairPlay(video: HTMLVideoElement, cfg: LoadConfig, cb: EngineCallbacks) {
  const anyVideo = video as any;
  if (typeof anyVideo.webkitSetMediaKeys !== "function" || typeof (window as any).WebKitMediaKeys === "undefined") {
    cb.onLog("error", "FairPlay: este navegador no expone la API WebKit legacy (usa Safari).");
    return;
  }
  const WebKitMediaKeys = (window as any).WebKitMediaKeys;
  // ALWAYS through the proxy, even with no header overrides: a cross-origin licence
  // POST with an Authorization header trips a CORS preflight the licence server
  // rejects ("Load failed", no HTTP status).
  const certUrl = proxifyAlways(cfg.drm.certUrl, cfg.net);
  const licenseUrl = proxifyAlways(cfg.drm.licenseUrl, cfg.net);
  const releasePid = releasePidOf(cfg.drm.licenseUrl);

  // The cert must be ready before `webkitneedkey` fires (it's part of initData).
  const certT0 = Date.now();
  const certPromise: Promise<Uint8Array> = fetch(certUrl).then(async (r) => {
    const buf = await r.arrayBuffer();
    cb.onNetwork({
      time: new Date(),
      kind: "license",
      url: cfg.drm.certUrl,
      status: r.status,
      bytes: buf.byteLength,
      durationMs: Date.now() - certT0,
    });
    if (!r.ok) throw new Error(`certificado HTTP ${r.status}`);
    return new Uint8Array(buf);
  });
  certPromise.catch((e) => cb.onLog("error", "FairPlay: certificado " + (e?.message || e)));

  // `webkitneedkey` fires per encrypted track (audio + video), often several at once
  // at start-up, and again after each SSAI ad discontinuity. Each event needs its
  // OWN session, but creating them CONCURRENTLY on one WebKitMediaKeys triggers
  // `webkitkeyerror` and btoa errors (and eventually recovers only after Safari
  // retries). So we SERIALIZE: create one session, wait for its key (added/error),
  // then handle the next. No dedup (that left a track keyless → ~20s join stall),
  // no concurrency (that errored). Each session resolves the gate so the chain moves
  // on; a timeout guarantees the chain never wedges if no event fires.
  // Stop→Start reuses the same <video>. A needkey listener + MediaKeys left by the
  // previous load would fire a SECOND handler per needkey → concurrent sessions
  // again ("invalid characters", no playback). Remove/reset before wiring anew.
  if (anyVideo.__fpNeedKey) {
    video.removeEventListener("webkitneedkey", anyVideo.__fpNeedKey);
    anyVideo.__fpNeedKey = null;
  }
  try {
    if (anyVideo.webkitKeys) anyVideo.webkitSetMediaKeys(null);
  } catch {
    /* some builds reject null; the fresh session below still supersedes it */
  }

  let chain: Promise<void> = Promise.resolve();
  const onNeedKey = (event: any) => {
    const rawInit = new Uint8Array(event.initData);
    chain = chain.then(() => handleNeedKey(rawInit)).catch(() => {});
  };
  anyVideo.__fpNeedKey = onNeedKey;
  video.addEventListener("webkitneedkey", onNeedKey);

  function handleNeedKey(rawInit: Uint8Array): Promise<void> {
    let settle!: () => void;
    const gate = new Promise<void>((r) => (settle = r));
    const timer = setTimeout(() => settle(), 8000);
    const finish = () => {
      clearTimeout(timer);
      settle();
    };

    // The SPC's content-id is the licence **releasePid** (thePlatform's KSM
    // validates that, not the skd:// KID). Explicit override still wins.
    const skdId = extractContentId(rawInit);
    const contentId = cfg.drm.contentId || releasePid || skdId;
    // Log BOTH: the KID the media actually advertises (skd://) and the id we put in
    // the SPC. thePlatform validates the releasePid, but the key it returns must
    // still match the media's KID — if it doesn't, the CDM accepts the key
    // ("clave añadida") yet nothing decrypts: black picture AND no audio.
    cb.onLog(
      "drm",
      `FairPlay (WebKit): needkey — enviando content-id "${contentId}"` +
        (skdId && skdId !== contentId ? ` · KID del manifest (skd): "${skdId}"` : "")
    );

    if (!anyVideo.webkitKeys) {
      if (!WebKitMediaKeys.isTypeSupported("com.apple.fps.1_0", "video/mp4")) {
        cb.onLog("error", "FairPlay: com.apple.fps.1_0 no soportado.");
        cb.onState("error");
        finish();
        return gate;
      }
      anyVideo.webkitSetMediaKeys(new WebKitMediaKeys("com.apple.fps.1_0"));
    }

    certPromise
      .then((cert) => {
        const sessionInit = concatInitDataIdAndCertificate(rawInit, contentId, cert);
        const session = anyVideo.webkitKeys.createSession("video/mp4", sessionInit);
        session.addEventListener("webkitkeyadded", () => {
          cb.onLog("drm", "FairPlay (WebKit): clave añadida ✓ — reproduciendo");
          finish();
        });
        session.addEventListener("webkitkeymessage", async (e: any) => {
          let step = "spc";
          try {
            const msg = e.message;
            // `new Uint8Array(msg)` is correct for BOTH an ArrayBuffer (wraps it)
            // and a typed-array VIEW (copies the view's own bytes). Do NOT go via
            // `msg.buffer` — for a view with a byteOffset that grabs the whole
            // underlying buffer → a corrupted SPC → a bad/rejected CKC.
            const spc = msg instanceof Uint8Array ? msg : new Uint8Array(msg ?? new ArrayBuffer(0));
            cb.onLog(
              "drm",
              `FairPlay (WebKit): SPC ${spc.byteLength} B (${msg?.constructor?.name ?? typeof msg}) → licencia`
            );
            step = "spc-encode";
            const spcB64 = bytesToBase64(spc);
            step = "fetch";
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            for (const [k, v] of Object.entries(cfg.drm.headers)) headers[k] = v;
            const t0 = Date.now();
            const resp = await fetch(licenseUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({ getFairplayLicense: { spcMessage: spcB64, releasePid } }),
            });
            const text = await resp.text();
            cb.onNetwork({
              time: new Date(),
              kind: "license",
              url: cfg.drm.licenseUrl,
              status: resp.status,
              bytes: text.length,
              durationMs: Date.now() - t0,
            });
            if (!resp.ok) {
              cb.onLog("error", `FairPlay licencia HTTP ${resp.status} · ${text.slice(0, 220)}`);
              finish();
              return;
            }
            step = "ckc-extract";
            // Capture the base64 run after the opening quote WITHOUT requiring a
            // closing quote — tolerant of a slightly truncated tail. base64ToBytes
            // normalises/pads it.
            const m = /"ckcResponse"\s*:\s*"([A-Za-z0-9+/=_-]+)/.exec(text);
            if (!m || !m[1]) {
              cb.onLog(
                "error",
                `FairPlay: respuesta sin ckcResponse (len=${text.length}) · ${text.slice(0, 160)}`
              );
              finish();
              return;
            }
            const ckc = m[1];
            step = "ckc-decode";
            let ckcBytes: Uint8Array;
            try {
              ckcBytes = base64ToBytes(ckc);
            } catch (e: any) {
              cb.onLog(
                "error",
                `FairPlay: CKC no decodificable (len=${ckc.length}, "${ckc.slice(0, 40)}…") · resp: ${text.slice(0, 160)}`
              );
              finish();
              return;
            }
            step = "update";
            cb.onLog("drm", `FairPlay (WebKit): CKC ${ckcBytes.byteLength} B → session.update`);
            session.update(ckcBytes);
          } catch (err: any) {
            cb.onLog("error", `FairPlay (keymessage/${step}): ${err?.message || err}`);
            finish();
          }
        });
        // Non-fatal: with several tracks another session usually succeeds, so log
        // and move the chain on rather than tearing playback down.
        session.addEventListener("webkitkeyerror", () => {
          cb.onLog("warn", "FairPlay (WebKit): webkitkeyerror — " + (session.error?.code ?? "?"));
          finish();
        });
      })
      .catch((err: any) => {
        cb.onLog("error", "FairPlay (needkey): " + (err?.message || err));
        finish();
      });

    return gate;
  }
}

/**
 * Native <video> playback. Also backs the "avplayer" engine, since on
 * Apple platforms native HLS/FairPlay is handled by AVPlayer under the hood.
 */
export function createNative(cb: EngineCallbacks, isAvPlayer = false): EngineController {
  let el: HTMLVideoElement | null = null;
  let traceIv: ReturnType<typeof setInterval> | null = null;
  let curCfg: LoadConfig | null = null;
  const reported = new Set<string>();

  // Native HLS: Safari fetches manifest/segments itself, so we can't hook them in
  // JS. But when routed through /api/proxy they show up in the Resource Timing API
  // — poll it and surface them in the Network panel.
  function classify(url: string): NetworkKind {
    const u = url.toLowerCase();
    if (/\.m3u8($|\?)/.test(u)) return "manifest";
    if (/(^|\/)[^/?]*init[^/?]*|\.mp4($|\?)/.test(u)) return "init";
    if (/\.(m4s|ts|aac|mp3|vtt|webvtt|cmfv|cmfa)($|\?)/.test(u)) return "segment";
    return "other";
  }
  function startTracing() {
    stopTracing();
    reported.clear();
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
        if (reported.has(k)) continue;
        reported.add(k);
        const real = unproxifyUrl(e.name) || e.name;
        const kind = classify(real);
        const status = (e as any).responseStatus as number | undefined;
        cb.onNetwork({
          time: new Date(),
          kind,
          url: real,
          bytes: e.transferSize || e.encodedBodySize || undefined,
          durationMs: e.duration ? Math.round(e.duration) : undefined,
          status: status || undefined,
        });
        // Live: the media playlist refreshes constantly — surface each fetch in the
        // Manifest panel by re-reading it (through the proxy, unrewritten).
        if (kind === "manifest" && curCfg) {
          fetch(proxifyAlways(real, curCfg.net))
            .then((r) => r.text())
            .then((text) => cb.onManifest({ text, format: "hls", bytes: text.length }))
            .catch(() => {});
        }
      }
    }, 1000);
  }
  function stopTracing() {
    if (traceIv) {
      clearInterval(traceIv);
      traceIv = null;
    }
  }
  // Fetch the master manifest (through the proxy, unrewritten) for the Manifest panel.
  async function reportManifest(cfg: LoadConfig) {
    try {
      const r = await fetch(proxifyAlways(cfg.url, cfg.net)); // proxy even w/o overrides: direct fetch hits CORS
      const text = await r.text();
      cb.onManifest({ text, format: "hls", bytes: text.length });
      cb.onNetwork({ time: new Date(), kind: "manifest", url: cfg.url });
    } catch (e: any) {
      cb.onLog("warn", "No se pudo leer el manifest para el panel: " + (e?.message || e));
    }
  }

  const lbl = (lang: string, label: string, fb: string) =>
    [lang, label].filter(Boolean).join(" · ") || fb;

  function reportTracks() {
    if (!el) return;
    const atl: any = (el as any).audioTracks;
    const audio = atl
      ? Array.from({ length: atl.length }, (_, i) => ({
          id: String(i),
          lang: atl[i].language,
          label: lbl(atl[i].language, atl[i].label, `Audio ${i + 1}`),
          active: !!atl[i].enabled,
        }))
      : [];
    const ttl = el.textTracks;
    const text = ttl
      ? Array.from({ length: ttl.length }, (_, i) => ({ t: ttl[i], i }))
          .filter(({ t }) => t.kind === "subtitles" || t.kind === "captions")
          .map(({ t, i }) => ({
            id: String(i),
            lang: t.language,
            label: lbl(t.language, t.label, `Sub ${i + 1}`),
            active: t.mode === "showing",
          }))
      : [];
    cb.onTracks(audio, text);
  }

  function selectAudio(id: string) {
    const atl: any = el && (el as any).audioTracks;
    if (!atl) return;
    const i = parseInt(id, 10);
    for (let j = 0; j < atl.length; j++) atl[j].enabled = j === i;
    reportTracks();
  }
  function selectText(id: string | null) {
    if (!el) return;
    const ttl = el.textTracks;
    for (let j = 0; j < ttl.length; j++) ttl[j].mode = "disabled";
    if (id !== null && ttl[parseInt(id, 10)]) ttl[parseInt(id, 10)].mode = "showing";
    reportTracks();
  }

  async function load(video: HTMLVideoElement, cfg: LoadConfig) {
    el = video;
    curCfg = cfg;
    video.addEventListener("loadedmetadata", reportTracks);
    video.textTracks?.addEventListener?.("change", reportTracks);
    video.textTracks?.addEventListener?.("addtrack", reportTracks);
    (video as any).audioTracks?.addEventListener?.("change", reportTracks);
    (video as any).audioTracks?.addEventListener?.("addtrack", reportTracks);
    if (isAvPlayer) {
      const canHls = video.canPlayType("application/vnd.apple.mpegurl");
      if (!canHls) {
        cb.onLog(
          "warn",
          "AVPlayer maps to native Apple playback — open in Safari for HLS/FairPlay."
        );
      } else {
        cb.onLog("info", "AVPlayer (native Apple HLS): " + cfg.url);
      }
      if (cfg.drm.enabled && cfg.drm.system !== "fairplay") {
        cb.onLog("warn", "AVPlayer only supports FairPlay DRM.");
      }
    } else {
      cb.onLog("info", "Native video: " + cfg.url);
    }
    // Native FairPlay: replicate the app — Safari plays the manifest directly
    // (segments load natively, no proxy) and its CDM sets the content-id from the
    // skd key; only the certificate + license are relayed through the proxy.
    if (cfg.drm.enabled && cfg.drm.system === "fairplay") {
      if (!cfg.drm.certUrl) cb.onLog("warn", "FairPlay: falta la URL de certificado (obligatoria)");
      setupFairPlay(video, cfg, cb);
      // Native Safari plays the manifest, but child playlists/segments need the
      // injected Origin (they 403 otherwise) — so route the manifest through the
      // rewriting proxy (rw=1), which points every child back at the proxy.
      const src = proxifyUrl(cfg.url, cfg.net);
      const proxiedSrc = src.includes("/api/proxy?") ? `${src}&rw=1` : src;
      cb.onLog("drm", "FairPlay nativo activado — manifest y segmentos por el proxy (rw), licencia/cert por el proxy");
      startTracing();
      reportManifest(cfg);
      video.src = proxiedSrc;
      video.load();
      video.play().catch((e) => cb.onLog("warn", "Autoplay blocked: " + e.message));
      return;
    }
    if (hasNetOverrides(cfg.net)) {
      cb.onLog(
        "warn",
        "Native playback: only the top-level URL is proxied; segments load directly (headers won't apply to them)."
      );
    }
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
    startTracing();
    reportManifest(cfg);
    video.src = proxifyUrl(cfg.url, cfg.net);
    video.load();
    video.play().catch((e) => cb.onLog("warn", "Autoplay blocked: " + e.message));
  }

  function destroy() {
    stopTracing();
    if (el) {
      el.removeEventListener("loadedmetadata", reportTracks);
      el.removeAttribute("src");
      el.load();
      el = null;
    }
  }

  return { load, destroy, selectAudio, selectText };
}
