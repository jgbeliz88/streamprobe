// [LOC-TEST] Manual Akamai token injection — test scaffolding.
//
// The IMA DAI SDK hands back a manifest URL that may not carry the CDN token the
// front-end normally appends, so the first manifest GET can 403. This module holds
// a token pasted by hand so the DAI engine can add it to CDN requests, mimicking
// what the real front-end does.
//
// Deliberately IN MEMORY ONLY: no localStorage, no cookies, no query string. It
// dies with the tab, and never reaches a commit.

export type TokenScope = "manifest" | "all";

interface TestToken {
  /** Normalised `name=value` exactly as it must appear in the query. */
  raw: string;
  /** Query-param name (`hdnts`, `hdnea`, …) used to detect an existing token. */
  name: string;
  /** Unix seconds parsed from the token's `exp` subfield, when present. */
  exp: number | null;
  scope: TokenScope;
}

let current: TestToken | null = null;

/** Accepts the token with or without a leading `?`/`&`, and trims whitespace. */
export function setTestToken(input: string, scope: TokenScope): void {
  const raw = input.trim().replace(/^[?&]+/, "").trim();
  if (!raw || !raw.includes("=")) {
    current = null;
    return;
  }
  const name = raw.slice(0, raw.indexOf("="));
  // Akamai packs subfields as `exp=…~acl=…~hmac=…` inside the value.
  const m = /(?:^|[~&])exp=(\d+)/.exec(raw);
  current = { raw, name, exp: m ? Number(m[1]) : null, scope };
}

export function getTestToken(): TestToken | null {
  return current;
}

/** Minutes until the token expires; null when it carries no `exp`. */
export function tokenMinutesLeft(t: TestToken): number | null {
  if (t.exp == null) return null;
  return Math.round((t.exp * 1000 - Date.now()) / 60000);
}

/** Loggable form: everything masked except `exp`, with its date and time left. */
export function describeToken(t: TestToken): string {
  const left = tokenMinutesLeft(t);
  const body = t.raw
    .split("~")
    .map((seg) => {
      const i = seg.indexOf("=");
      if (i < 0) return seg;
      const k = seg.slice(0, i);
      // The first segment is `name=exp=…`, so look at the tail for exp.
      if (/exp$/i.test(k)) {
        const v = seg.slice(i + 1);
        const when = /^\d+$/.test(v) ? new Date(Number(v) * 1000).toISOString() : "?";
        return `${k}=${v} (${when}${left != null ? `, quedan ${left} min` : ""})`;
      }
      return `${k}=***`;
    })
    .join("~");
  return body;
}
