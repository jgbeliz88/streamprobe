import type { EngineId, DrmSystem } from "./types";
import type { StreamFormat } from "@/lib/format";

export interface EngineMeta {
  id: EngineId;
  label: string; // shown in the engine grid (may contain \n)
  tag: string; // short tag shown in the player header
  /** Bundled versions selectable in the UI. First entry is the default. */
  versions: string[];
  formats: StreamFormat[];
  drm: DrmSystem[];
  /** Marks non-web engines that only render an explanatory stub. */
  stub?: boolean;
}

export const ENGINES: Record<EngineId, EngineMeta> = {
  shaka: {
    id: "shaka",
    label: "Shaka\nPlayer",
    tag: "SHAKA",
    versions: ["4.13.25", "4.16.39"],
    formats: ["dash", "hls", "smooth"],
    drm: ["widevine", "playready", "fairplay"],
  },
  dashjs: {
    id: "dashjs",
    label: "dash.js",
    tag: "DASH.JS",
    versions: ["4.7.4", "4.5.2", "3.2.2"],
    formats: ["dash", "smooth"],
    drm: ["widevine", "playready"],
  },
  hlsjs: {
    id: "hlsjs",
    label: "hls.js",
    tag: "HLS.JS",
    versions: ["1.5.20", "1.4.14", "1.2.9"],
    formats: ["hls"],
    drm: ["widevine", "fairplay"],
  },
  native: {
    id: "native",
    label: "Native\nVideo",
    tag: "NATIVE",
    versions: ["browser"],
    formats: ["hls", "dash"],
    drm: ["widevine", "playready", "fairplay"],
  },
  avplayer: {
    id: "avplayer",
    label: "AVPlayer\n(Safari)",
    tag: "AVPLAYER",
    versions: ["safari"],
    formats: ["hls"],
    drm: ["fairplay"],
  },
  exoplayer: {
    id: "exoplayer",
    label: "ExoPlayer\n(Android)",
    tag: "EXOPLAYER",
    versions: ["native"],
    formats: ["dash", "hls", "smooth"],
    drm: ["widevine", "playready"],
    stub: true,
  },
  gamdai: {
    id: "gamdai",
    label: "GAM DAI\n(IMA SSAI)",
    tag: "GAM DAI",
    versions: ["1.5.20", "1.4.14", "1.2.9"], // hls.js used for HLS output
    formats: ["hls", "dash"],
    drm: [],
  },
};

export const ENGINE_ORDER: EngineId[] = [
  "shaka",
  "dashjs",
  "hlsjs",
  "native",
  "avplayer",
  "exoplayer",
  "gamdai",
];

export interface Preset {
  key: string;
  name: string;
  urlShort: string;
  engine: EngineId;
  url: string;
}

export const PRESETS: Preset[] = [
  {
    key: "shaka-demo",
    name: "Shaka DASH demo (open)",
    urlShort: "storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd",
    engine: "shaka",
    url: "https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd",
  },
  {
    key: "apple-hls",
    name: "Apple HLS Bipbop (open)",
    urlShort: "devstreaming-cdn.apple.com/.../master.m3u8",
    engine: "hlsjs",
    url: "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8",
  },
  {
    key: "akamai-live",
    name: "Akamai live DASH (open)",
    urlShort: "livesim2.dashif.org/vod/...",
    engine: "shaka",
    url: "https://livesim2.dashif.org/vod/testpic_2s/multi_subs.mpd",
  },
  {
    key: "dashjs-demo",
    name: "dash.js reference (open)",
    urlShort: "dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd",
    engine: "dashjs",
    url: "https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd",
  },
];

export const DEFAULT_URL =
  "https://fast.mediasetinfinity.es/mitele-comedia.isml/ctv.mpd?hdnts=st=1783335065~exp=1785927065~acl=/*~hmac=b68c52d63e8ce0417d6c85b11e58958363ee44f54c84e8e1f3e57fd904962d73";
