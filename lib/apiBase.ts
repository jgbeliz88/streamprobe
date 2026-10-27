/**
 * Where the StreamProbe server (proxy, traces) lives.
 *
 * Served by Next it is the page's own origin, so API paths stay relative. A TV
 * app packaged with the static build runs from file:// instead — the only way
 * its runtime exposes EME (DRM) is a secure origin, and plain http://<mac> is
 * not one — so its launcher passes the Mac as `?api=http://<mac>:<port>`.
 */
let base: string | null = null;

export function apiBase(): string {
  if (base !== null) return base;
  base = "";
  if (typeof window !== "undefined") {
    try {
      const api = new URLSearchParams(window.location.search).get("api");
      if (api && /^https?:\/\//i.test(api)) base = api.replace(/\/+$/, "");
    } catch {
      /* keep same-origin */
    }
  }
  return base;
}

/** `/api/…` → the URL to call, absolute when the app runs off-server. */
export const apiUrl = (path: string): string => apiBase() + path;
