// Common engine abstraction

export type EngineId =
  | "shaka"
  | "dashjs"
  | "hlsjs"
  | "native"
  | "avplayer"
  | "exoplayer"
  | "gamdai";

export type LogType =
  | "info"
  | "abr"
  | "buffer"
  | "error"
  | "drm"
  | "warn"
  | "scte";

export type PlayerState =
  | "idle"
  | "loading"
  | "playing"
  | "buffering"
  | "paused"
  | "error";

export type DrmSystem = "widevine" | "playready" | "fairplay";

export interface Metrics {
  join: number | null;
  bufN: number;
  bufMs: number;
  bitrate: number;
  bw: number;
  latency: number | null;
  dropped: number;
  state: PlayerState;
}

/** One point on the playback timeline chart (sampled ~2×/s while running). */
export interface MetricSample {
  /** Seconds since load started. */
  t: number;
  /** Rendition bitrate currently playing, bps (0 if unknown). */
  bitrate: number;
  /** Estimated available bandwidth, bps (0 if unknown). */
  bw: number;
  /** Seconds of media buffered ahead of the playhead. */
  buffer: number;
}

/** A point event drawn as a vertical marker on the timeline chart. */
export interface ChartMarker {
  t: number;
  kind: "stall" | "error";
}

export interface DrmConfig {
  enabled: boolean;
  system: DrmSystem;
  licenseUrl: string;
  certUrl: string;
  headers: Record<string, string>;
  /** FairPlay content-id override — the value the KMS/KSM expects in the SPC
   *  (e.g. a channel id like "free_to_air_channels"), which can differ from the
   *  skd:// KID in the manifest. When empty, the skd content-id is used. */
  contentId: string;
}

/** Google Ad Manager DAI (SSAI) live stream request, via the IMA DAI SDK. */
export interface DaiConfig {
  assetKey: string; // GAM live asset key
  apiKey: string; // optional (GAM API key)
  format: "hls" | "dash"; // stream format GAM should stitch
}

export interface AdvancedConfig {
  /** Shaka: run with default config like the SmartTV app (no streaming tuning). */
  matchTv: boolean;
  bufferGoal: number;
  rebufferGoal: number;
  audioLang: string;
  returnToLiveWindow: boolean;
  stalledMinDuration: number;
  /** Disable ABR and pin the highest-bitrate rendition (don't let it drop). */
  lockMaxQuality: boolean;
}

export interface NetOverrides {
  origin: string;
  referer: string;
  userAgent: string;
  /** Arbitrary extra request headers for manifest/segment requests, injected by the
   *  proxy (the browser forbids setting most of these from JS). Origin/Referer/UA
   *  keep their dedicated fields and win over a same-named entry here. */
  headers: Record<string, string>;
}

/** Editable form state for the network overrides (headers as an ordered list). */
export interface UiNetConfig {
  origin: string;
  referer: string;
  userAgent: string;
  headers: HeaderPair[];
}

export interface LoadConfig {
  url: string;
  version: string; // CDN version string for the engine
  drm: DrmConfig;
  advanced: AdvancedConfig;
  net: NetOverrides;
  /** Emulated navigator.userAgent (Shaka platform detection). "" = no emulation. */
  deviceUserAgent: string;
  dai: DaiConfig; // used by the gamdai engine
}

// ── UI-level types (editable form state) ──

export interface HeaderPair {
  id: number;
  key: string;
  value: string;
}

export interface UiDrmConfig {
  enabled: boolean;
  system: DrmSystem;
  licenseUrl: string;
  certUrl: string;
  headers: HeaderPair[];
  /** FairPlay content-id override (see DrmConfig.contentId). */
  contentId: string;
}

/** Full per-panel configuration held in the UI. */
export interface PanelConfig {
  engine: EngineId;
  version: string;
  url: string;
  drm: UiDrmConfig;
  advanced: AdvancedConfig;
  net: UiNetConfig;
  deviceUserAgent: string;
  dai: DaiConfig;
}

/** Collapse the editable header list into the engine-facing record. */
export function toNetOverrides(n: UiNetConfig): NetOverrides {
  const headers: Record<string, string> = {};
  for (const h of n.headers) {
    const k = h.key.trim();
    if (k) headers[k] = h.value.trim();
  }
  return {
    origin: n.origin.trim(),
    referer: n.referer.trim(),
    userAgent: n.userAgent.trim(),
    headers,
  };
}

/** Convert editable UI config into the engine-facing LoadConfig. */
export function toLoadConfig(cfg: PanelConfig): LoadConfig {
  const headers: Record<string, string> = {};
  for (const h of cfg.drm.headers) {
    const k = h.key.trim();
    if (k) headers[k] = h.value.trim();
  }
  return {
    url: cfg.url.trim(),
    version: cfg.version,
    drm: {
      enabled: cfg.drm.enabled,
      system: cfg.drm.system,
      licenseUrl: cfg.drm.licenseUrl.trim(),
      certUrl: cfg.drm.certUrl.trim(),
      headers,
      contentId: cfg.drm.contentId.trim(),
    },
    advanced: cfg.advanced,
    net: toNetOverrides(cfg.net),
    deviceUserAgent: cfg.deviceUserAgent.trim(),
    dai: cfg.dai,
  };
}

export type NetworkKind =
  | "manifest"
  | "segment"
  | "init"
  | "license"
  | "other";

export interface NetworkEntry {
  time: Date;
  kind: NetworkKind;
  mediaType?: string; // video | audio | text
  url: string;
  bytes?: number;
  durationMs?: number;
  /** HTTP status, when known (e.g. Resource Timing `responseStatus`). 0/undefined
   *  = unknown. ≥400 is surfaced in red so failed segments are visible. */
  status?: number;
  /** Headers the proxy actually injected on this request (echoed back). */
  sent?: { origin?: string; referer?: string; userAgent?: string };
}

/** A manifest received by an engine (raw text, or serialized parsed model). */
export interface EngineManifest {
  text: string;
  format?: "dash" | "hls" | "smooth" | "unknown";
  periodCount?: number;
  note?: string;
  bytes?: number;
}

/** A selectable audio or text (subtitle) track. */
export interface TrackInfo {
  id: string; // engine-specific identifier (stringified)
  label: string; // human-readable
  lang?: string;
  active: boolean;
}

export interface EngineCallbacks {
  onLog(type: LogType, msg: string): void;
  onAbr(
    prevBps: number,
    currBps: number,
    dims?: { w?: number; h?: number }
  ): void;
  onMetrics(patch: Partial<Metrics>): void;
  onState(state: PlayerState): void;
  onNetwork(entry: NetworkEntry): void;
  onManifest(m: EngineManifest): void;
  /** Available audio + text tracks (fired on load and whenever they change). */
  onTracks(audio: TrackInfo[], text: TrackInfo[]): void;
  /** Selectable video renditions, so a quality can be pinned instead of letting
   *  ABR choose. Empty when the engine can't pin one (native HLS). */
  onQualities(list: TrackInfo[]): void;
}

export interface EngineController {
  load(video: HTMLVideoElement, cfg: LoadConfig): Promise<void>;
  destroy(): void;
  /** Switch audio track by TrackInfo.id. */
  selectAudio?(id: string): void;
  /** Switch subtitle track by TrackInfo.id, or null to turn subtitles off. */
  selectText?(id: string | null): void;
  /** Pin a video rendition by TrackInfo.id, or null to hand control back to ABR. */
  selectQuality?(id: string | null): void;
}

export type EngineFactory = (cb: EngineCallbacks) => EngineController;
