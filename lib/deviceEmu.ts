/* eslint-disable @typescript-eslint/no-explicit-any */
// Device emulation: override navigator.userAgent so Shaka Player's platform
// detection (shaka.util.Platform) engages the SmartTV code paths (Tizen /
// webOS), which apply different MSE handling for multiperiod / codec switches.

let currentUA: string | null = null;
let installed = false;

/**
 * Set (or clear, with an empty string) the User-Agent that JS reads from
 * navigator.userAgent. Installs a getter once; later calls just swap the value.
 * NOTE: for a fully clean switch, reload the page — Shaka caches some platform
 * decisions and installs polyfills on first load.
 */
export function setDeviceUserAgent(ua: string): void {
  if (typeof navigator === "undefined") return;
  currentUA = ua.trim() || null;
  if (installed) return;
  try {
    const real = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => currentUA ?? real,
    });
    installed = true;
  } catch {
    /* some environments forbid overriding navigator.userAgent */
  }
}

const PLATFORM_PREDICATES = [
  "isTizen",
  "isTizen3",
  "isTizen4",
  "isTizen5",
  "isTizen55",
  "isWebOS",
  "isWebOS3",
  "isWebOS4",
  "isWebOS5",
  "isWebOS6",
  "isChromecast",
  "isPS4",
  "isPS5",
  "isXboxOne",
  "isApple",
  "isEdge",
  "isChrome",
];

/** Which SmartTV platforms Shaka thinks it is running on (for confirmation). */
export function detectShakaPlatform(shaka: any): string {
  const P = shaka?.util?.Platform;
  if (!P) return "unknown";
  const hits = PLATFORM_PREDICATES.filter((name) => {
    try {
      return typeof P[name] === "function" && P[name]();
    } catch {
      return false;
    }
  });
  return hits.join(", ") || "generic";
}

export interface DevicePreset {
  label: string;
  ua: string;
}

/** Representative TV User-Agents. Paste your device's exact UA for best fidelity. */
export const DEVICE_PRESETS: DevicePreset[] = [
  { label: "None — use device's own UA", ua: "" },
  {
    label: "Samsung Tizen 6.0",
    ua: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.0 TV Safari/537.36",
  },
  {
    label: "Samsung Tizen 5.5",
    ua: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/5.5 TV Safari/537.36",
  },
  {
    label: "Samsung Tizen 3.0",
    ua: "Mozilla/5.0 (SMART-TV; Linux; Tizen 3.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/3.0 TV Safari/538.1",
  },
  {
    label: "LG webOS 6",
    ua: "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36 WebAppManager",
  },
  {
    label: "LG webOS 4",
    ua: "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.34 Safari/537.36 WebAppManager",
  },
];
