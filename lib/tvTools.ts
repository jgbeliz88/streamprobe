import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";

// Server-side helpers shared by the Deploy TV routes (deploy and diagnosis):
// they look at this machine's network and at the TV toolchains installed on it.

export function lanIp(): string {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "";
}

export function hasTool(name: string): boolean {
  try {
    return spawnSync("which", [name], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Locate the Android SDK. The gradle build needs it, and the dev server may
 * have been started from a shell with no ANDROID_HOME set, so look in the usual
 * install locations too (Homebrew cask and Android Studio).
 */
export function androidSdkDir(): string {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    "/opt/homebrew/share/android-commandlinetools",
    "/usr/local/share/android-commandlinetools",
    process.env.HOME ? path.join(process.env.HOME, "Library/Android/sdk") : undefined,
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "platforms")) || existsSync(path.join(dir, "platform-tools"))) {
      return dir;
    }
  }
  return "";
}

/**
 * The device NAME that `sdb devices` reports for this TV (e.g. TQ55QN90DATXXC).
 * `tizen install -t` matches on that name, so handing it the IP fails with
 * "There is no connected target" even while sdb shows the device attached.
 * Falls back to the IP when the listing can't be read.
 */
export function sdbDeviceName(tvIp: string): string {
  try {
    const out = spawnSync("sdb", ["devices"], { encoding: "utf8" }).stdout || "";
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\S+)\s+device\s+(\S+)$/);
      if (!m) continue;
      if (!tvIp || m[1].startsWith(tvIp)) return m[2];
    }
  } catch {
    /* fall through to the IP */
  }
  return tvIp;
}
