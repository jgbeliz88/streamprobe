import type { DrmConfig } from "./types";

/** Shaka key-system id per DRM system. */
const KEY_SYSTEM = {
  widevine: "com.widevine.alpha",
  playready: "com.microsoft.playready",
  // Modern EME FairPlay key system (what Shaka + Safari MSE use, and what the
  // Mediaset app requests). The legacy "com.apple.fps.1_0" is for native HLS
  // only and makes Shaka's MSE key-system negotiation fail with error 6001.
  fairplay: "com.apple.fps",
} as const;

/**
 * Build the `drm` slice of a Shaka config: license server plus, when supplied,
 * the license request headers (Widevine/PlayReady) or the FairPlay server
 * certificate. Shared by the plain Shaka engine and the GAM DAI one.
 * Returns null when DRM is disabled.
 */
export function shakaDrmConfig(drm: DrmConfig): Record<string, unknown> | null {
  if (!drm.enabled) return null;
  const key = KEY_SYSTEM[drm.system];
  const conf: any = { servers: { [key]: drm.licenseUrl } };
  if (drm.system === "fairplay" && drm.certUrl) {
    conf.advanced = { [key]: { serverCertificateUri: drm.certUrl } };
  }
  // License-request headers (auth tokens, etc.) are NOT set here: Shaka's
  // drm.advanced has no `headers` field (it silently ignores it). They are
  // applied via a LICENSE request filter in the engine instead.
  return conf;
}
