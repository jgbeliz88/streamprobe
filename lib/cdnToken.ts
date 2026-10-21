// Query-token CDN auth (Akamai `hdnts`/`hdnea`, and friends).
//
// Unified Streaming and similar packagers list child playlists and segments as
// RELATIVE paths, so a player resolving them against the manifest URL drops its
// query string — and the CDN answers 403, which surfaces as Shaka 1001
// (BAD_HTTP_STATUS) or an hls.js levelLoadError. Re-attaching the token fixes it.

const AUTH_PARAMS = ["hdnts", "hdnea", "hdntl", "token", "auth"];

/**
 * The auth part of a URL's query, kept verbatim — Akamai tokens contain `~`, `*`
 * and `/`, which re-serialising through URLSearchParams would percent-encode and
 * invalidate. Routing parameters (e.g. `originpath`, which tells a CDN to proxy
 * elsewhere) are deliberately left out: sending those on a segment request makes
 * the CDN answer with the manifest instead of the media.
 */
export function authQuery(url: string): string {
  const q = url.split("?")[1];
  if (!q) return "";
  return q
    .split("&")
    .filter((pair) => AUTH_PARAMS.includes(pair.split("=")[0].toLowerCase()))
    .join("&");
}

/** True when the URL carries a CDN auth token that children will need. */
export function hasAuthToken(url: string): boolean {
  return authQuery(url) !== "";
}

/**
 * Build a function that re-attaches the manifest's auth token to child requests.
 * Only URLs on the host that issued the token are touched — never cross-domain,
 * where the token is useless and would leak a credential. Returns the identity
 * function when the manifest URL carries no token.
 */
export function makeTokenPropagator(manifestUrl: string): (url: string) => string {
  const query = authQuery(manifestUrl);
  if (!query) return (u) => u;

  let host: string;
  try {
    host = new URL(manifestUrl).host;
  } catch {
    return (u) => u;
  }
  const firstParam = query.split("=")[0] + "=";

  return (url: string) => {
    if (!url || !/^https?:/i.test(url) || url.includes(firstParam)) return url;
    try {
      if (new URL(url).host !== host) return url;
    } catch {
      return url;
    }
    return url + (url.includes("?") ? "&" : "?") + query;
  };
}
