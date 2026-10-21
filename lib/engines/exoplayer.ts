import type { EngineCallbacks, EngineController } from "./types";

/**
 * ExoPlayer (Android Media3) has no browser runtime. This stub exists so the
 * engine is selectable in the UI but reports why it cannot play on the web.
 */
export function createExoplayer(cb: EngineCallbacks): EngineController {
  async function load() {
    cb.onLog(
      "warn",
      "ExoPlayer only runs on Android native. Not available in a web browser."
    );
    cb.onLog(
      "info",
      "Use this option to document/compare Android ExoPlayer config; playback runs in the native app."
    );
    cb.onState("error");
  }

  function destroy() {
    /* nothing to tear down */
  }

  return { load, destroy };
}
