import { type NextRequest } from "next/server";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Node runtime: traces are written to disk on the machine running the dev
// server, so a TV (or phone) with no usable DevTools can ship its capture here.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DIR = path.join(process.cwd(), "traces");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Filesystem-safe, still readable: "2026-07-29T10-12-03_LG-webOS_SHAKA_A.json".
 * A live (auto-sent) trace has no timestamp — "LG-webOS_SHAKA_A_live.json" — so
 * each send replaces the last and the file is always the latest capture.
 */
function fileName(dump: any, live: boolean): string {
  const bits = [dump?.device?.label, dump?.engine, dump?.panel]
    .filter(Boolean)
    .join("_")
    .replace(/[^\w.-]+/g, "-")
    .slice(0, 60);
  if (live) return `${bits || "trace"}_live.json`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}${bits ? "_" + bits : ""}.json`;
}

export async function POST(req: NextRequest) {
  // The session report arrives as HTML: a TV can't download it, so it is saved
  // here beside the traces instead.
  if (req.headers.get("content-type")?.startsWith("text/html")) {
    const html = await req.text();
    const label = (new URL(req.url).searchParams.get("label") || "")
      .replace(/[^\w.-]+/g, "-")
      .slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `${stamp}_report${label ? "_" + label : ""}.html`;
    await mkdir(DIR, { recursive: true });
    await writeFile(path.join(DIR, name), html);
    console.log(`[traces] ${name} — informe (${Math.round(html.length / 1024)} KB)`);
    return Response.json(
      { saved: name, path: path.join("traces", name), bytes: html.length },
      { headers: CORS }
    );
  }

  let dump: any;
  try {
    dump = await req.json();
  } catch {
    return new Response("cuerpo JSON inválido", { status: 400, headers: CORS });
  }

  const live = new URL(req.url).searchParams.get("live") === "1";
  await mkdir(DIR, { recursive: true });
  const name = fileName(dump, live);
  const body = JSON.stringify(dump, null, 2);
  // Write then rename, so a live file opened mid-update is never half written.
  const tmp = path.join(DIR, `.${name}.tmp`);
  await writeFile(tmp, body);
  await rename(tmp, path.join(DIR, name));

  const summary = {
    saved: name,
    path: path.join("traces", name),
    bytes: body.length,
    manifests: dump?.manifests?.length ?? 0,
    network: dump?.network?.length ?? 0,
    events: dump?.events?.length ?? 0,
  };
  // Also log it on the dev-server console, so it shows up in the terminal —
  // except the periodic live updates, which would flood it.
  if (!live) console.log(
    `[traces] ${name} — ${summary.manifests} manifests · ${summary.network} peticiones · ${summary.events} eventos (${Math.round(summary.bytes / 1024)} KB)`
  );
  return Response.json(summary, { headers: CORS });
}

/** GET: list saved traces, or return one with ?file=<name>. */
export async function GET(req: NextRequest) {
  const file = new URL(req.url).searchParams.get("file");
  try {
    if (file) {
      // Keep reads inside the traces dir.
      const target = path.join(DIR, path.basename(file));
      const text = await readFile(target, "utf8");
      return new Response(text, {
        headers: { ...CORS, "content-type": "application/json" },
      });
    }
    const names = (await readdir(DIR)).filter((n) => n.endsWith(".json")).sort().reverse();
    return Response.json({ dir: DIR, traces: names }, { headers: CORS });
  } catch {
    return Response.json({ dir: DIR, traces: [] }, { headers: CORS });
  }
}
