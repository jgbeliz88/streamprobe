# StreamProbe

Multi-engine video playback QA tool, built with **Next.js**. Paste a stream URL, pick an engine and version, and measure client-side playback performance (**join time, buffering, bitrate, live latency, dropped frames**) to compare players and tune the experience. Supports **HLS, DASH and Smooth Streaming** and all three DRMs (**Widevine, PlayReady, FairPlay**).

> Ported from the single-file prototype `streamprobe.html` (kept for reference).

---

## Features

- **Selectable engines**: Shaka Player, dash.js, hls.js, Native `<video>`, AVPlayer (native Safari) and ExoPlayer (stub, Android-native only).
- **Per-engine version selector**: several versions bundled locally; switching is instant (no external CDN).
- **Single and Compare A/B modes**: two players side by side with independent configuration.
- **Live metrics**: join time, rebuffer count + total time, bitrate + estimated bandwidth, live latency and dropped frames.
- **Tabbed logs**: Events · ABR switches · Network · Manifest.
- **Autoplay** on *Load* (falls back to *muted* if the browser blocks autoplay).
- **DRM** Widevine / PlayReady / FairPlay, with license URL, certificate (FairPlay) and custom license headers.
- **Searchable manifest viewer**: lists every MPD/M3U8 received (including live refreshes), collapsible, flagging DASH **single vs multiperiod** (number of `<Period>`).
- **Network traces**: each request (manifest/segment/init/license) with type, media, size and duration.
- **CDN header overrides** (Origin / Referer / User-Agent) via an internal proxy, to test CDN rules.
- **JSON export** per player: metrics + ABR + network + events.
- **Presets** of open streams for quick testing.

---

## Getting started

Requirements: Node.js 18.17+.

```bash
npm install
npm run dev      # http://localhost:3000
```

Other scripts:

```bash
npm run build    # production build
npm run start    # serve the build
```

---

## Usage

1. Pick the **engine** and its **version** in the sidebar.
2. Paste the stream **URL** (or use a preset).
3. (Optional) Enable **DRM**, **CDN headers** or **Advanced** options.
4. Click **▶ Load stream** — playback starts automatically.
5. Review metrics and the **Events / ABR / Network / Manifest** tabs.
6. **Compare A/B** (top) enables a second player for side-by-side comparison.

---

## Engines and versions

Libraries are installed via npm (with aliases for multiple versions) and loaded with dynamic `import()`, so each version is a local chunk that loads instantly.

| Engine     | Bundled versions           | Formats             | DRM                              |
|------------|----------------------------|---------------------|----------------------------------|
| **Shaka**  | 4.16.39, 4.13.25           | DASH · HLS · Smooth | Widevine · PlayReady · FairPlay  |
| **dash.js**| 4.7.4, 4.5.2, 3.2.2        | DASH · Smooth       | Widevine · PlayReady             |
| **hls.js** | 1.5.20, 1.4.14, 1.2.9      | HLS                 | Widevine (EME)                   |
| **Native** | browser                    | HLS · DASH          | browser-dependent                |
| **AVPlayer** | Safari (native)          | HLS                 | FairPlay                         |
| **ExoPlayer** | — (stub)                | DASH · HLS · Smooth | Widevine · PlayReady             |

**Add another version** (Shaka example):

```bash
npm install "shaka_4_x@npm:shaka-player@4.X.Y"
```

Then register the loader in [lib/engines/loaders.ts](lib/engines/loaders.ts) and add the version to the list in [lib/engines/registry.ts](lib/engines/registry.ts).

> **AVPlayer** maps to Apple's native playback (uses AVPlayer + FairPlay under the hood); open it in Safari. **ExoPlayer** has no web runtime: on load it shows an explanatory message.

---

## DRM

In each player's **DRM** section: system, **License server URL**, **Certificate URL** (FairPlay only) and custom **license headers**.

- **Shaka** — full support for all three systems (`com.widevine.alpha`, `com.microsoft.playready`, `com.apple.fps.1_0` with `serverCertificateUri`).
- **dash.js** — Widevine and PlayReady (`httpRequestHeaders`); for FairPlay use Native/AVPlayer in Safari.
- **hls.js** — Widevine via EME.

Real validation requires an encrypted stream with its license server.

---

## CDN headers (Origin / Referer / User-Agent)

**Network / CDN headers** section. The browser forbids setting these headers from JS, so if you fill any field (badge **PROXY ON**), media requests are rewritten to go through an internal Next proxy that injects them when forwarding to the CDN.

- Proxy route: [app/api/proxy/route.ts](app/api/proxy/route.ts) (Node runtime). Forwards `Range` (supports 206) and passes through `content-type/length/range/etag`.
- Per-engine rewriting: Shaka (request filter, excludes license requests), dash.js (`addRequestInterceptor`, v4.5+), hls.js (custom loader), Native (top-level URL only).

> **Note**: the proxy adds a local hop, so it **affects the metrics** for join time and bandwidth. To measure real performance, leave the fields empty (direct playback).

---

## Manifests and Network

- **Manifest**: collapsible list of every manifest received, newest first. For DASH it flags 🟢 **SINGLE PERIOD** / 🟠 **MULTIPERIOD · N** (number of `<Period>`), with in-content **search** and a match counter. Shaka provides the **raw XML** of each refresh; dash.js provides the **parsed model** (JSON) with an exact period count.
- **Network**: trace of every request with time, type, media, size and duration.

---

## Metrics

| Metric        | Description                                            |
|---------------|--------------------------------------------------------|
| Join time     | ms to first frame (first `playing` event).             |
| Buffering     | rebuffer count + total time in `waiting`.              |
| Bitrate / bw  | active representation bitrate + estimated bandwidth.   |
| Live latency  | latency to live edge (or `VOD`) + dropped frames.      |

**Reset** clears metrics and logs; **⬇ JSON** exports everything (metrics + ABR + network + events).

---

## Architecture

```
app/
  layout.tsx            Fonts (Inter / JetBrains Mono), dark theme
  page.tsx              Mounts <StreamProbe> with ssr:false (100% client)
  globals.css           Tailwind + scrollbar / select
  api/proxy/route.ts    Node proxy that injects Origin/Referer/User-Agent
components/
  StreamProbe.tsx       Orchestrator: Single/Compare mode, per-panel config
  Header.tsx            Logo + Single / Compare A/B toggle
  ConfigPanel.tsx       Sidebar: engine+version, URL, DRM, CDN headers, Advanced, presets
  EngineSelector.tsx    Engine grid + version selector
  DrmConfig.tsx         DRM toggle, system, license/cert, headers
  PlayerPanel.tsx       Video + overlay + status + metrics + logs
  MetricsBar.tsx        Row of 4 metrics
  LogView.tsx           Events / ABR / Network / Manifest tabs
  ManifestView.tsx      Collapsible manifest list + search
hooks/
  usePlayer.ts          Per-panel state machine (load/stop, metrics, logs, manifests)
lib/
  fmt.ts                fmtMs / fmtBps / fmtTime
  format.ts             Format detection from URL
  manifest.ts           Manifest analysis and <Period> counting
  proxy.ts              proxifyUrl / hasNetOverrides
  engines/
    types.ts            Common interfaces (EngineController, EngineCallbacks, configs)
    registry.ts         Engine metadata, versions and presets
    loaders.ts          Per-version loading (local dynamic import)
    autoplay.ts         Autoplay with muted fallback
    shaka.ts dashjs.ts hlsjs.ts native.ts exoplayer.ts   Per-engine controllers
```

**Engine abstraction** — each controller implements a common interface:

```ts
interface EngineController { load(video, cfg): Promise<void>; destroy(): void; }
interface EngineCallbacks {
  onLog(type, msg); onAbr(prev, curr, dims); onMetrics(patch);
  onState(state); onNetwork(entry); onManifest(m);
}
```

`usePlayer` holds the per-panel state and translates engine callbacks into metrics, logs, network traces and the manifest list, reusing the same state machine for every engine.

---

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind CSS · React 18. Playback runs entirely client-side; only the header proxy runs on the server.

---

## Known limitations

- **ExoPlayer / AVPlayer** don't truly play back outside their native context (Android / Safari).
- The **header proxy** skews performance metrics (use it only to test CDN rules).
- **dash.js 3.2** is an old API; some metrics or URL rewriting may not apply.
- No backend persistence: everything is client-side + JSON download.
