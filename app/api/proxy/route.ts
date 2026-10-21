import { type NextRequest } from "next/server";

// Node runtime so we can set otherwise-forbidden request headers
// (Origin / Referer / User-Agent) when fetching upstream.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PASS_THROUGH = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "date",
];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
};

/**
 * Rewrite an HLS playlist so every child URI (variant playlists, segments, init
 * maps, alternate renditions) is fetched back through this proxy with the same
 * injected headers — used by native Safari playback, which otherwise loads
 * children directly and gets 403 on CDNs that require an Origin. `skd://` keys are
 * left untouched (handled natively by FairPlay). Requested via `&rw=1`, which is
 * propagated to the rewritten children so nested playlists get rewritten too.
 */
function rewriteM3u8(
  body: string,
  baseUrl: string,
  params: {
    o: string | null;
    r: string | null;
    ua: string | null;
    tk: string | null;
    th: string | null;
    h: string | null;
  },
): string {
  const proxied = (child: string) => {
    let abs: string;
    try {
      abs = new URL(child, baseUrl).toString();
    } catch {
      return child;
    }
    // Re-attach the CDN auth token to same-host children that lack it (Google DAI
    // lists content segments back on the origin CDN without the token → 403).
    if (params.tk && params.th) {
      try {
        const firstParam = params.tk.split("=")[0] + "=";
        if (new URL(abs).host === params.th && !abs.includes(firstParam)) {
          abs += (abs.includes("?") ? "&" : "?") + params.tk;
        }
      } catch {
        /* leave abs as-is */
      }
    }
    const qs = new URLSearchParams();
    qs.set("u", abs);
    if (params.o) qs.set("o", params.o);
    if (params.r) qs.set("r", params.r);
    if (params.ua) qs.set("ua", params.ua);
    if (params.tk) qs.set("tk", params.tk);
    if (params.th) qs.set("th", params.th);
    if (params.h) qs.set("h", params.h);
    qs.set("rw", "1");
    return `/api/proxy?${qs.toString()}`;
  };
  return body
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        // Rewrite URI="…" attributes (EXT-X-MEDIA / KEY / MAP / SESSION-KEY / …),
        // but leave FairPlay skd:// key URIs for native handling.
        return line.replace(/URI="([^"]+)"/g, (m, uri) =>
          /^skd:\/\//i.test(uri) ? m : `URI="${proxied(uri)}"`,
        );
      }
      return proxied(t); // bare variant-playlist or segment URI
    })
    .join("\n");
}

// Manifests the proxy has already fetched while rewriting (rw=1). Native HLS gives
// us no JS hook on the playlists, and re-fetching a GAM DAI manifest out-of-band
// breaks its session — but the proxy is already holding the exact bytes the player
// got, so stash them here and let the client read them back same-origin (no extra
// upstream traffic). Ring buffer: newest wins, bounded so dev memory can't grow.
type StashedManifest = { seq: number; url: string; text: string; at: number };
const MANIFEST_STASH: StashedManifest[] = [];
const MANIFEST_KEEP = 40;
const MANIFEST_MAX_CHARS = 512_000;
let manifestSeq = 0;

function stashManifest(url: string, text: string) {
  manifestSeq += 1;
  MANIFEST_STASH.push({
    seq: manifestSeq,
    url,
    text: text.length > MANIFEST_MAX_CHARS ? text.slice(0, MANIFEST_MAX_CHARS) : text,
    at: Date.now(),
  });
  if (MANIFEST_STASH.length > MANIFEST_KEEP) MANIFEST_STASH.splice(0, MANIFEST_STASH.length - MANIFEST_KEEP);
}

/** Extra request headers arrive JSON-encoded in `h`. Hop-by-hop and length/encoding
 *  headers are dropped: forwarding them would corrupt the proxied response. */
const HEADER_DENY = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
]);

function parseExtraHeaders(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const name = String(k).trim();
      if (!name || HEADER_DENY.has(name.toLowerCase())) continue;
      out[name] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

async function handle(req: NextRequest, method: "GET" | "HEAD") {
  const { searchParams } = new URL(req.url);
  const o = searchParams.get("o");
  const r = searchParams.get("r");
  const ua = searchParams.get("ua");
  // CDN auth token to re-attach to same-host children (DAI segments 403 without
  // it): `tk` = the raw token query (e.g. "hdnea=…"), `th` = the host it's for.
  const tk = searchParams.get("tk");
  const th = searchParams.get("th");
  const h = searchParams.get("h");

  // Debug mode: report exactly which headers the proxy injects, without
  // fetching upstream. Used by the "Verify headers" button.
  if (searchParams.get("debug") != null) {
    const injected: Record<string, string> = {};
    Object.assign(injected, parseExtraHeaders(h));
    if (o) injected["origin"] = o;
    if (r) injected["referer"] = r;
    if (ua) injected["user-agent"] = ua;
    return new Response(JSON.stringify({ injected }, null, 2), {
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  // Peek at a manifest the proxy already fetched, by URL. Lets the Network panel
  // show a playlist's body without re-requesting it upstream — important for GAM
  // DAI, whose manifest URLs are session-bound and break the stream if re-fetched.
  const peek = searchParams.get("peek");
  if (peek) {
    const hit = [...MANIFEST_STASH].reverse().find((m) => m.url === peek);
    return new Response(JSON.stringify(hit ? { found: true, text: hit.text, at: hit.at } : { found: false }), {
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  // Read back the manifests stashed above: /api/proxy?manifests=<lastSeq>
  const since = searchParams.get("manifests");
  if (since != null) {
    const from = Number(since) || 0;
    const items = MANIFEST_STASH.filter((m) => m.seq > from);
    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  const target = searchParams.get("u");
  if (!target) return new Response("missing 'u' param", { status: 400 });

  let url: string;
  try {
    url = new URL(target).toString();
  } catch {
    return new Response("invalid target url", { status: 400 });
  }

  const headers: Record<string, string> = {};
  // Custom first, so the dedicated Origin/Referer/UA fields win over a duplicate.
  Object.assign(headers, parseExtraHeaders(h));
  if (o) headers["origin"] = o;
  if (r) headers["referer"] = r;
  // Never let undici's default "user-agent: node" leak upstream — it breaks
  // UA-based CDN routing (e.g. Akamai's multiperiod→single-period rule). Use
  // the explicit override if given, else forward the caller's real UA.
  const uaOut = ua || req.headers.get("user-agent") || undefined;
  if (uaOut) headers["user-agent"] = uaOut;
  const range = req.headers.get("range");
  if (range) headers["range"] = range;
  // Ask upstream NOT to compress. undici transparently decompresses gzip/br, which
  // leaves the forwarded content-length (the COMPRESSED size) smaller than the body
  // we stream -> the browser truncates the response (a cut-off certificate, manifest
  // or DRM CKC). With identity, content-length matches and ranges keep working.
  headers["accept-encoding"] = "identity";

  let upstream: Response;
  try {
    upstream = await fetch(url, { method, headers, redirect: "follow" });
  } catch (e: any) {
    return new Response("upstream fetch failed: " + (e?.message || e), {
      status: 502,
      headers: CORS,
    });
  }

  const respHeaders = new Headers(CORS);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  // Echo the headers we injected so the client can verify per request.
  if (o) respHeaders.set("x-sp-sent-origin", o);
  if (r) respHeaders.set("x-sp-sent-referer", r);
  if (ua) respHeaders.set("x-sp-sent-user-agent", ua);

  // Native-HLS rewrite: rewrite playlist children back through the proxy so the
  // injected Origin reaches them too (segments/child playlists 403 otherwise).
  const ct = upstream.headers.get("content-type") || "";
  const isM3u8 =
    searchParams.get("rw") != null &&
    (/mpegurl/i.test(ct) || /\.m3u8($|\?)/i.test(url));
  if (method === "GET" && isM3u8 && upstream.ok) {
    const text = await upstream.text();
    stashManifest(url, text); // keep the original for the Manifest panel
    const rewritten = rewriteM3u8(text, url, { o, r, ua, tk, th, h });
    respHeaders.delete("content-length");
    return new Response(rewritten, { status: upstream.status, headers: respHeaders });
  }

  // Manifests that don't go through the rewriter (hls.js / Shaka fetch them
  // directly through the proxy) are small text — buffer them so the Network panel
  // can show their body later, then hand back the same bytes. Segments keep
  // streaming untouched.
  const isManifestBody =
    method === "GET" &&
    upstream.ok &&
    (/mpegurl|dash\+xml/i.test(ct) || /\.(m3u8|mpd)($|\?)/i.test(url));
  if (isManifestBody) {
    const text = await upstream.text();
    stashManifest(url, text);
    respHeaders.delete("content-length");
    return new Response(text, { status: upstream.status, headers: respHeaders });
  }

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export function GET(req: NextRequest) {
  return handle(req, "GET");
}

export function HEAD(req: NextRequest) {
  return handle(req, "HEAD");
}

// POST is used for DRM license requests (a POST with the challenge body).
// Routing them through the proxy sidesteps CORS — license servers rarely allow
// a cross-origin browser request. The caller's headers (Content-Type, auth) are
// forwarded; Origin/Referer/UA come from the query like the GET path.
const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "origin",
  "referer",
  "user-agent",
  "accept-encoding",
]);

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get("u");
  if (!target) return new Response("missing 'u' param", { status: 400, headers: CORS });
  let url: string;
  try {
    url = new URL(target).toString();
  } catch {
    return new Response("invalid target url", { status: 400, headers: CORS });
  }

  const o = searchParams.get("o");
  const r = searchParams.get("r");
  const ua = searchParams.get("ua");
  const h = searchParams.get("h");

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (!SKIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  });
  if (o) headers["origin"] = o;
  if (r) headers["referer"] = r;
  const uaOut = ua || req.headers.get("user-agent") || undefined;
  if (uaOut) headers["user-agent"] = uaOut;

  headers["accept-encoding"] = "identity"; // see the GET path: keeps content-length truthful

  const body = await req.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: "POST", headers, body, redirect: "follow" });
  } catch (e: any) {
    return new Response("upstream fetch failed: " + (e?.message || e), {
      status: 502,
      headers: CORS,
    });
  }

  const respHeaders = new Headers(CORS);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  // undici transparently decompresses gzip/br, so the upstream content-length is
  // the COMPRESSED size — smaller than the body we stream. Forwarding it makes the
  // browser truncate the response (a cut-off DRM CKC → "respuesta sin ckcResponse").
  respHeaders.delete("content-length");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}
