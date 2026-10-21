/* eslint-disable @typescript-eslint/no-explicit-any */
// Version loader map. Every entry statically references an npm-bundled version
// of a library, so switching versions loads a local chunk (no external CDN).
import type { EngineId } from "./types";

type Loader = () => Promise<any>;

function norm(m: any): any {
  return m?.default ?? m;
}

const LOADERS: Partial<Record<EngineId, Record<string, Loader>>> = {
  shaka: {
    // @ts-ignore aliased shaka build ships a global-namespace declaration
    "4.13.25": async () => norm(await import("shaka_4_13")),
    // @ts-ignore aliased shaka build ships a global-namespace declaration
    "4.16.39": async () => norm(await import("shaka_4_16")),
  },
  dashjs: {
    "4.7.4": async () => norm(await import("dashjs")),
    "4.5.2": async () => norm(await import("dashjs_4_5")),
    "3.2.2": async () => norm(await import("dashjs_3_2")),
  },
  hlsjs: {
    "1.5.20": async () => norm(await import("hls.js")),
    "1.4.14": async () => norm(await import("hlsjs_1_4")),
    "1.2.9": async () => norm(await import("hlsjs_1_2")),
  },
};

/** Load the bundled library object for an engine + version. */
export async function loadLib(id: EngineId, version: string): Promise<any> {
  const byVersion = LOADERS[id];
  if (!byVersion) throw new Error(`No loader for engine "${id}"`);
  const loader = byVersion[version] ?? Object.values(byVersion)[0];
  if (!loader) throw new Error(`No bundled version for engine "${id}"`);
  return loader();
}
