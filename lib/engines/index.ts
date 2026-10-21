import type { EngineCallbacks, EngineController, EngineId } from "./types";
import { createShaka } from "./shaka";
import { createDashjs } from "./dashjs";
import { createHlsjs } from "./hlsjs";
import { createNative } from "./native";
import { createExoplayer } from "./exoplayer";
import { createDai } from "./dai";

export function createEngine(
  id: EngineId,
  cb: EngineCallbacks
): EngineController {
  switch (id) {
    case "shaka":
      return createShaka(cb);
    case "dashjs":
      return createDashjs(cb);
    case "hlsjs":
      return createHlsjs(cb);
    case "native":
      return createNative(cb, false);
    case "avplayer":
      return createNative(cb, true);
    case "exoplayer":
      return createExoplayer(cb);
    case "gamdai":
      return createDai(cb);
  }
}
