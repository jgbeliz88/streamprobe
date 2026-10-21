import { ENGINES } from "./engines/registry";
import type { EngineId, PanelConfig } from "./engines/types";

/**
 * Config carried in the query string, so a launcher (or a bookmark) can open
 * StreamProbe already set up. This is what lets several TVs run off the same dev
 * server with a different stream each.
 *
 *   ?url=…&engine=shaka&version=4.13.25&origin=…&referer=…&ua=…&autoplay=1&autotrace=30
 */
export interface DeepLink {
  config: PanelConfig;
  /** Start playback on its own, without waiting for a Load press. */
  autoplay: boolean;
  /** Send traces to the server every N seconds from the start; 0 = off. */
  autotrace: number;
  /** True when the query actually carried something. */
  present: boolean;
}

const BOOL = (v: string | null): boolean | undefined =>
  v == null ? undefined : v !== "0" && v !== "false";

/** Overlay any recognised query parameters onto a base panel config. */
export function applyDeepLink(base: PanelConfig, search: string): DeepLink {
  const q = new URLSearchParams(search);
  if ([...q.keys()].length === 0) {
    return { config: base, autoplay: false, autotrace: 0, present: false };
  }

  const cfg: PanelConfig = {
    ...base,
    drm: { ...base.drm },
    advanced: { ...base.advanced },
    net: { ...base.net, headers: [...base.net.headers] },
    dai: { ...base.dai },
  };
  let present = false;
  const took = <T>(v: T | undefined | null): boolean => {
    if (v == null) return false;
    present = true;
    return true;
  };

  const engine = q.get("engine") as EngineId | null;
  if (took(engine) && engine && ENGINES[engine]) {
    cfg.engine = engine;
    cfg.version = ENGINES[engine].versions[0];
  }
  const version = q.get("version");
  if (took(version) && version && ENGINES[cfg.engine].versions.includes(version)) {
    cfg.version = version;
  }

  const url = q.get("url");
  if (took(url) && url) cfg.url = url;

  // CDN header overrides. `noproxy` clears them, for streams that must go direct.
  const origin = q.get("origin");
  if (took(origin) && origin != null) cfg.net.origin = origin;
  const referer = q.get("referer");
  if (took(referer) && referer != null) cfg.net.referer = referer;
  const ua = q.get("ua");
  if (took(ua) && ua != null) cfg.net.userAgent = ua;
  if (BOOL(q.get("noproxy"))) {
    present = true;
    cfg.net = { origin: "", referer: "", userAgent: "", headers: [] };
  }

  const deviceUa = q.get("deviceUa");
  if (took(deviceUa) && deviceUa != null) cfg.deviceUserAgent = deviceUa;

  const matchTv = BOOL(q.get("matchTv"));
  if (took(matchTv) && matchTv !== undefined) cfg.advanced.matchTv = matchTv;
  const lockMax = BOOL(q.get("lockMax"));
  if (took(lockMax) && lockMax !== undefined) cfg.advanced.lockMaxQuality = lockMax;

  // GAM DAI (live asset key).
  const assetKey = q.get("assetKey");
  if (took(assetKey) && assetKey) {
    cfg.dai.assetKey = assetKey;
    cfg.engine = "gamdai";
  }
  const daiFormat = q.get("daiFormat");
  if (took(daiFormat) && (daiFormat === "hls" || daiFormat === "dash")) {
    cfg.dai.format = daiFormat;
  }

  // DRM: a license URL is enough to switch it on.
  const licenseUrl = q.get("license");
  if (took(licenseUrl) && licenseUrl) {
    cfg.drm.enabled = true;
    cfg.drm.licenseUrl = licenseUrl;
  }
  const drmSystem = q.get("drm");
  if (
    took(drmSystem) &&
    (drmSystem === "widevine" || drmSystem === "playready" || drmSystem === "fairplay")
  ) {
    cfg.drm.enabled = true;
    cfg.drm.system = drmSystem;
  }

  const autoplay = BOOL(q.get("autoplay")) ?? false;
  if (q.get("autoplay") != null) present = true;

  const autotrace = parseAutotrace(q.get("autotrace"));
  if (q.get("autotrace") != null) present = true;

  return { config: cfg, autoplay, autotrace, present };
}

/** Auto-trace intervals the UI offers, in seconds. */
export const AUTOTRACE_STEPS = [10, 30, 60];

/** `autotrace=30` → 30 s; a bare `1`/`true` → 30 s; anything else → off. */
function parseAutotrace(v: string | null): number {
  if (v == null || v === "0" || v === "false") return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 5) return Math.min(Math.round(n), 600);
  return 30;
}

/** Build a launch URL for a device: the dev server plus the config to preload. */
export function buildLaunchUrl(
  macHost: string,
  opts: { streamUrl?: string; engine?: EngineId; autoplay?: boolean; autotrace?: number } = {}
): string {
  const q = new URLSearchParams();
  if (opts.streamUrl?.trim()) q.set("url", opts.streamUrl.trim());
  if (opts.engine) q.set("engine", opts.engine);
  if (opts.autoplay) q.set("autoplay", "1");
  if (opts.autotrace) q.set("autotrace", String(opts.autotrace));
  const qs = q.toString();
  return `http://${macHost}${qs ? `/?${qs}` : ""}`;
}
