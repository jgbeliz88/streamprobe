import { type NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { androidSdkDir, hasTool, lanIp, sdbDeviceName, stageWebosPackaged } from "@/lib/tvTools";

// Node runtime: we shell out to the TV toolchains (ares / tizen / sdb / adb +
// gradle) that live on this machine, and rewrite the launcher's URL on disk.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Platform = "webos" | "tizen" | "androidtv";
// "browser" is handled entirely client-side (just opens the URL) and never
// reaches this route.
type Action = "deploy" | "package";

interface Body {
  platform: Platform;
  action: Action;
  tvIp: string;
  macHost: string; // "192.168.1.176:3001"
  /** Full URL to bake into the wrapper, query included. Falls back to macHost. */
  launchUrl?: string;
  deviceName?: string; // webOS ares profile (default "lgtv")
  /**
   * webOS only: run in the legacy NetCast container, as the Infinity app does.
   * Closer to its runtime, but it blocks all text input — no on-screen keyboard,
   * and not even a USB keyboard can type.
   */
  webosNetcast?: boolean;
  /**
   * webOS only: the old launcher that just redirects to http://<mac>. UI changes
   * show up with a reload, but the TV gets no DRM there (EME needs a secure
   * origin). Default: package the UI inside the app (file://), DRM works.
   */
  webosHosted?: boolean;
  securityProfile?: string; // Tizen signing profile
}

interface Step {
  cmd: string;
  /** Fixed args. Omitted when `lateArgs` supplies them instead. */
  args?: string[];
  // A non-zero exit does not abort the run (e.g. re-pointing a device that
  // may not exist yet, or an sdb that is already connected).
  optional?: boolean;
  /** Extra environment for this step (e.g. ANDROID_HOME for the gradle build). */
  env?: Record<string, string>;
  /**
   * Args computed just before spawn, for when an earlier step is what reveals
   * them. Takes precedence over `args`.
   */
  lateArgs?: () => string[];
  /** In-process step (no child process): `cmd` is then only its label. */
  fn?: () => void;
}

const ROOT = process.cwd();
// File holding the dev-server URL for each platform's wrapper. Android keeps it
// in strings.xml instead of an index.html, but the rewrite is the same.
const LAUNCHERS: Record<Platform, string> = {
  webos: path.join(ROOT, "tv-launchers", "webos", "index.html"),
  tizen: path.join(ROOT, "tv-launchers", "tizen", "index.html"),
  androidtv: path.join(
    ROOT,
    "tv-launchers",
    "androidtv",
    "app",
    "src",
    "main",
    "res",
    "values",
    "strings.xml"
  ),
};
const DIST = path.join(ROOT, "tv-launchers", "dist");
const IPK = path.join(DIST, "com.streamprobe.app_1.0.0_all.ipk");
const ANDROID_DIR = "tv-launchers/androidtv";
const APK = `${ANDROID_DIR}/app/build/outputs/apk/debug/app-debug.apk`;

/**
 * Copy the launcher into a staging directory and return it.
 *
 * `tizen package` signs in place, dropping author-signature.xml, signature1.xml
 * and .manifest.tmp beside the sources, so it is never pointed at the working
 * tree. This is all `tizen build-web` did for a static launcher anyway — and it
 * exits non-zero on an Eclipse class it cannot load outside the IDE, which is
 * why it is not used.
 */
function stageTizen(tizenDir: string): string {
  // Under DIST, not inside the launcher: cpSync refuses to copy a directory
  // into its own subtree, and DIST is already ignored by git.
  const stage = path.join(DIST, "tizen-stage");
  rmSync(stage, { recursive: true, force: true });
  cpSync(tizenDir, stage, {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith("."),
  });
  return stage;
}

// GET: prefill the panel — this machine's LAN address (so the launcher points
// at the dev server, not localhost) and which toolchains are installed.
export function GET(req: NextRequest) {
  const host = req.headers.get("host") || "";
  const port = host.includes(":") ? host.split(":")[1] : "3001";
  const ip = lanIp();
  const isLocal = /^(localhost|127\.|\[?::1)/.test(host);
  const macHost = isLocal ? (ip ? `${ip}:${port}` : "") : host;
  return Response.json({
    macHost,
    lanIp: ip,
    port,
    tools: {
      ares: hasTool("ares-package"),
      tizen: hasTool("tizen"),
      sdb: hasTool("sdb"),
      adb: hasTool("adb"),
      gradle: hasTool("gradle"),
    },
  });
}

// Bake the launch URL into the platform's wrapper, so the packaged app opens the
// right host — and, when a per-device stream is given, the right stream too. The
// URL is embedded at build time, so each TV keeps whatever it was installed with
// and a later deploy to another TV can't disturb it.
/** Set the webOS container: NetCast (Infinity's) or the default one. */
async function writeWebosTrustLevel(netcast: boolean) {
  const file = path.join(ROOT, "tv-launchers", "webos", "appinfo.json");
  const info = JSON.parse(await readFile(file, "utf8"));
  const want = netcast ? "netcast" : "default";
  if (info.trustLevel !== want) {
    info.trustLevel = want;
    await writeFile(file, JSON.stringify(info, null, 2) + "\n");
  }
  return want;
}

async function writeLauncherUrl(platform: Platform, launchUrl: string) {
  const file = LAUNCHERS[platform];
  const text = await readFile(file, "utf8");
  // Android keeps the URL in strings.xml, where a raw `&` between query
  // parameters is invalid XML and fails the build. The webOS/Tizen launchers hold
  // it inside a JS string, which needs no escaping.
  const embedded =
    platform === "androidtv"
      ? launchUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      : launchUrl;
  // Match the whole URL including any query string: stop at the quote (JS/XML
  // string) or at a tag boundary.
  const next = text.replace(/https?:\/\/[^"'<\s]+/, embedded);
  if (next !== text) await writeFile(file, next);
  return launchUrl;
}

function steps(body: Body, launchUrl: string): Step[] {
  const { platform, action, tvIp } = body;
  if (platform === "webos") {
    const dev = body.deviceName?.trim() || "lgtv";
    let stage = "";
    const pkg: Step[] = body.webosHosted
      ? [{ cmd: "ares-package", args: ["tv-launchers/webos", "-o", "tv-launchers/dist"] }]
      : [
          // The UI travels inside the app, so DRM works (see stageWebosPackaged).
          { cmd: "node", args: ["scripts/tv-export.mjs"] },
          {
            cmd: "preparar app con la UI dentro",
            fn: () => {
              stage = stageWebosPackaged(ROOT, launchUrl, body.macHost);
            },
          },
          { cmd: "ares-package", lateArgs: () => [stage, "-o", "tv-launchers/dist"] },
        ];
    if (action === "package") return pkg;
    return [
      // Re-point the registered profile at the IP entered (keeps the dev key).
      { cmd: "ares-setup-device", args: ["-m", dev, "-i", `host=${tvIp}`], optional: true },
      ...pkg,
      { cmd: "ares-install", args: ["-d", dev, IPK] },
      { cmd: "ares-launch", args: ["-d", dev, "com.streamprobe.app"] },
    ];
  }

  if (platform === "androidtv") {
    // One APK covers Android TV / Google TV (Sony, Philips, TCL, Xiaomi,
    // Shield…) and Fire TV, which is Android underneath.
    const sdk = androidSdkDir();
    const pkg: Step[] = [
      {
        cmd: "gradle",
        args: ["-p", ANDROID_DIR, "assembleDebug"],
        env: sdk ? { ANDROID_HOME: sdk } : undefined,
      },
    ];
    if (action === "package") return pkg;
    return [
      // adb over TCP: developer mode + network debugging must be on already.
      { cmd: "adb", args: ["connect", `${tvIp}:5555`], optional: true },
      ...pkg,
      { cmd: "adb", args: ["-s", `${tvIp}:5555`, "install", "-r", APK] },
      // `am start` on the explicit component. NB: don't use `monkey` here — it
      // also injects a random event, which lands on BACK often enough to close
      // the app right after opening it.
      {
        cmd: "adb",
        args: [
          "-s",
          `${tvIp}:5555`,
          "shell",
          "am",
          "start",
          "-n",
          "com.streamprobe.app/.MainActivity",
        ],
      },
    ];
  }

  // Tizen
  const profile = body.securityProfile?.trim();
  // The Tizen CLI resolves its path options against its own install directory,
  // not our cwd, so everything handed to it is absolute — otherwise the .wgt
  // silently lands in ~/tizen-studio/tools/ide/bin and the install can't find it.
  const tizenDir = path.join(ROOT, "tv-launchers", "tizen");
  const wgt = path.join(tizenDir, "StreamProbe.wgt");
  const pkgArgs = [
    "package",
    "-t",
    "wgt",
    ...(profile ? ["-s", profile] : []),
    "-o",
    tizenDir,
    "--",
    stageTizen(tizenDir),
  ];
  const pkg: Step[] = [{ cmd: "tizen", args: pkgArgs }];
  if (action === "package") return pkg;
  return [
    { cmd: "sdb", args: ["connect", tvIp], optional: true },
    ...pkg,
    {
      cmd: "tizen",
      // Late: the device name only becomes visible once `sdb connect` has run.
      lateArgs: () => ["install", "-n", wgt, "-t", sdbDeviceName(tvIp)],
    },
  ];
}

function runStep(step: Step, write: (s: string) => void): Promise<number> {
  if (step.fn) {
    write(`\n▸ ${step.cmd}\n`);
    try {
      step.fn();
      return Promise.resolve(0);
    } catch (e: any) {
      write(`✗ ${e?.message || e}\n`);
      return Promise.resolve(1);
    }
  }
  return new Promise((resolve) => {
    const args = step.lateArgs ? step.lateArgs() : step.args ?? [];
    write(`\n$ ${step.cmd} ${args.join(" ")}\n`);
    let child;
    try {
      child = spawn(step.cmd, args, {
        cwd: ROOT,
        env: { ...process.env, ...(step.env ?? {}) },
      });
    } catch (e: any) {
      write(`✗ no se pudo lanzar: ${e?.message || e}\n`);
      resolve(127);
      return;
    }
    child.stdout.on("data", (d) => write(d.toString()));
    child.stderr.on("data", (d) => write(d.toString()));
    child.on("error", (e: any) => {
      write(`✗ ${e?.code === "ENOENT" ? `'${step.cmd}' no está en el PATH` : e?.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Body;

  if (!body?.tvIp?.trim() && body.action !== "package") {
    return new Response("Falta la IP de la TV", { status: 400 });
  }
  if (!body?.macHost?.trim()) {
    return new Response("Falta la dirección de este Mac (IP:puerto)", { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const write = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* client went away */
        }
      };

      try {
        const launchUrl = body.launchUrl?.trim() || `http://${body.macHost.trim()}`;
        const packaged = body.platform === "webos" && !body.webosHosted;
        // A packaged webOS app gets its own generated launcher (staging dir), so
        // the tracked one is left alone.
        const url = packaged ? launchUrl : await writeLauncherUrl(body.platform, launchUrl);
        write(
          packaged
            ? `▸ App webOS con la UI dentro (DRM OK) · config → ${url}\n`
            : `▸ Launcher ${body.platform} → ${url}\n`
        );
        if (body.platform === "webos") {
          const trust = await writeWebosTrustLevel(!!body.webosNetcast);
          write(
            trust === "netcast"
              ? `▸ Modo NetCast (como Infinity): la tele no dejará escribir en campos de texto\n`
              : `▸ Modo normal (teclado activo)\n`
          );
        }

        const list = steps(body, url);
        for (const step of list) {
          const code = await runStep(step, write);
          if (code === 0) {
            write(`✓ ok\n`);
          } else if (step.optional) {
            write(`… continúo (paso opcional, salió ${code})\n`);
          } else {
            write(`\n✗ FALLÓ en '${step.cmd}' (código ${code}). Paro aquí.\n`);
            controller.close();
            return;
          }
        }
        write(`\n✔ Deploy completado.\n`);
      } catch (e: any) {
        write(`\n✗ Error: ${e?.message || e}\n`);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
