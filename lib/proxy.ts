import type { NetOverrides } from "./engines/types";
import { apiBase } from "./apiBase";

export function hasNetOverrides(net?: NetOverrides): boolean {
  if (!net) return false;
  return !!(
    net.origin.trim() ||
    net.referer.trim() ||
    net.userAgent.trim() ||
    Object.keys(net.headers || {}).length
  );
}

/** Extra headers travel in the query (not as real request headers) so they also
 *  apply to native HLS, where JS can't touch the request at all. */
function extraHeaderParam(net: NetOverrides): string {
  const h = net.headers || {};
  return Object.keys(h).length ? JSON.stringify(h) : "";
}

/**
 * Rewrite an absolute http(s) URL so it is fetched through the local proxy,
 * which injects Origin / Referer / User-Agent (headers the browser forbids
 * JS from setting). Returns the original URL if no override applies.
 */
export function proxifyUrl(url: string, net?: NetOverrides): string {
  if (!hasNetOverrides(net) || !net) return url;
  if (!/^https?:\/\//i.test(url)) return url; // skip blob:, data:, relative
  const qs = new URLSearchParams();
  qs.set("u", url);
  if (net.origin.trim()) qs.set("o", net.origin.trim());
  if (net.referer.trim()) qs.set("r", net.referer.trim());
  if (net.userAgent.trim()) qs.set("ua", net.userAgent.trim());
  const h = extraHeaderParam(net);
  if (h) qs.set("h", h);
  return `${apiBase()}/api/proxy?${qs.toString()}`;
}

/**
 * Like proxifyUrl, but proxies even when no header override is set. DRM licence
 * and certificate requests must ALWAYS go through the proxy: they are cross-origin
 * requests carrying custom headers (Authorization, Content-Type), so the browser
 * fires a CORS preflight that licence servers reject — surfacing as a bare
 * "Load failed" with no HTTP status. Same-origin via the proxy avoids it.
 */
export function proxifyAlways(url: string, net?: NetOverrides): string {
  if (!/^https?:\/\//i.test(url)) return url; // skip blob:, data:, relative, empty
  const qs = new URLSearchParams();
  qs.set("u", url);
  if (net?.origin.trim()) qs.set("o", net.origin.trim());
  if (net?.referer.trim()) qs.set("r", net.referer.trim());
  if (net?.userAgent.trim()) qs.set("ua", net.userAgent.trim());
  const h = net ? extraHeaderParam(net) : "";
  if (h) qs.set("h", h);
  return `${apiBase()}/api/proxy?${qs.toString()}`;
}

/**
 * Reverse of proxifyUrl: given a proxied URL (absolute or relative), return the
 * real target URL, or null if it is not a proxy URL. Used to keep the player's
 * base-URL resolution pointing at the real CDN (not the local proxy).
 */
export function unproxifyUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  const marker = "/api/proxy?";
  const i = url.indexOf(marker);
  if (i < 0) return null;
  try {
    const qs = url.slice(i + marker.length);
    return new URLSearchParams(qs).get("u");
  } catch {
    return null;
  }
}
