# TV-faithful Shaka config (mitele)

Companion doc to [README.md](README.md) and [DEBUG-SCTE35-MULTIPERIOD.md](DEBUG-SCTE35-MULTIPERIOD.md).
Documents the **"Match TV (Shaka defaults)"** mode added to StreamProbe so it reproduces how the
Mitele SmartTV app runs Shaka, for chasing the DASH multiperiod + SCTE-35 bug.

---

## Reference project analysed

`mitele-react` (Mitele SmartTV) **v2.25.1** — a production React/webpack app that builds per device
(Tizen, WebOS, VIDAA, Philips, Foxxum, Movistar, Vewd, Foxxum, HbbTV, Netcast, browser, chromecast).

### Engine per device (this build)
Selected in `src/common/device/info/<device>.js`:

| Device | DASH engine |
|--------|-------------|
| VIDAA, Philips, Foxxum, Movistar, WebOS, Browser | **dash.js 4.5.2** |
| Tizen | **AVPlayer (native)** + dash.js |
| HbbTV | dash.js (variant) |
| Vewd / Netcast | Vewd / OIPF |

> In this build Shaka is **not** wired to any device (only a stand-alone tech in
> `playerpoc/mediaPlayer/shaka-player/index.jsx`). The failing build confirmed by the team uses
> **Shaka Player 4.13.25**, which is already bundled in StreamProbe.

### How mitele instantiates Shaka
`playerpoc/mediaPlayer/shaka-player/index.jsx` — deliberately minimal:

```js
shaka.polyfill.installAll()
if (shaka.Player.isBrowserSupported()) {
  this.shakaPlayer = new shaka.Player(this.video.current)   // video element, autoplay
  if (playbackData.drm) {
    this.shakaPlayer.configure({
      drm: { servers: { [playbackData.drm]: playbackData.license } }
    })
  }
  this.shakaPlayer.load(playbackData.stream)
}
```

Key point: **no `streaming` / buffer / stall / ABR configuration** — Shaka runs on its **defaults**,
and `configure()` is only called (with `drm.servers`) when the stream is protected.

### dash.js config (reference, not used by StreamProbe's TV mode)
For completeness, `playerpoc/mediaPlayer/dashjs/index.jsx` shows the dash.js path: no `updateSettings`
(defaults), `withCredentials: true` on every request type, `setProtectionData` with `priority: 0`, and
SCTE-35 handled via the MPD event scheme `urn:scte:scte35:2014:xml+bin` — **only when there is no DRM**.
Not wired into StreamProbe (the current investigation is Shaka-only) but recorded here for reference.

---

## What "Match TV" does in StreamProbe

A toggle in the **Advanced** section (Shaka only), **ON by default**. When ON, StreamProbe builds Shaka
exactly like the TV app:

| | mitele (TV) | StreamProbe · Match TV ON |
|---|---|---|
| Streaming / buffer / stall / ABR | none → Shaka defaults | none → Shaka defaults |
| `preferredAudioLanguage` | not set | not set |
| DRM | `drm.servers[type] = license` | `drm.servers` (+ headers/cert only if you fill them) |
| Autoplay | yes | yes |

When ON, the Advanced tuning fields (buffer goal, rebuffer goal, stall, audio lang) are **greyed out**
because they don't apply. The log shows `Shaka config: TV-faithful (defaults, no streaming tuning)`.

When **OFF**, the Advanced settings are applied again (StreamProbe's original behaviour), so you can
experiment and see whether a setting (e.g. `bufferingGoal`, `stallThreshold`) fixes the multiperiod bug.

All debugging instrumentation (SCTE-35 tab, Network, Manifest/periods) stays active — it's passive and
does not change playback.

### How to reproduce the TV case
1. Engine **Shaka**, version **4.13.25**.
2. **Match TV** ON (default).
3. DRM only if the stream needs it (license URL only, like the TV).
4. Load the multiperiod MPD; inspect the **SCTE-35** tab, the **periods** table in Manifest, and **Events**.

> Caveat: this is still desktop Chromium, not the TV's older MSE/CDM. If the bug reproduces here, iterate
> here; if it only fails on the device, use the TV's remote inspector (Tizen Studio / webOS Web Inspector).

---

## Files touched

| File | Change |
|------|--------|
| [lib/engines/types.ts](lib/engines/types.ts) | `matchTv: boolean` added to `AdvancedConfig`. |
| [lib/engines/shaka.ts](lib/engines/shaka.ts) | When `matchTv`, skip the `streaming`/`preferredAudioLanguage` config (defaults only); DRM still applied. |
| [components/StreamProbe.tsx](components/StreamProbe.tsx) | Default `advanced.matchTv: true`. |
| [components/ConfigPanel.tsx](components/ConfigPanel.tsx) | "Match TV (Shaka defaults)" toggle + greys out the tuning fields when ON. |

---

## How to remove

1. **`components/ConfigPanel.tsx`** — delete the "Match TV (Shaka defaults)" toggle block and the
   `pointer-events-none opacity-40` wrapper around the tuning fields (keep the fields themselves).
2. **`components/StreamProbe.tsx`** — remove `matchTv: true` from the default `advanced` object.
3. **`lib/engines/shaka.ts`** — restore the unconditional `conf.streaming = {…}` (+ `preferredAudioLanguage`)
   and drop the `matchTv` branch.
4. **`lib/engines/types.ts`** — remove `matchTv` from `AdvancedConfig` (do this last).

Then `npx tsc --noEmit` to confirm nothing dangling.
