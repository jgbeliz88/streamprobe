# Debug add-on: SCTE-35 + multiperiod (DASH / Shaka)

Optional debugging layer added **on top of** the base tool documented in [README.md](README.md).
It targets a specific investigation: **DASH multiperiod + SCTE-35 playback issues in Shaka Player on Smart TVs** (Tizen / webOS / Android TV).

Everything here is self-contained and can be **removed** without affecting the core player/metrics tool — see [How to remove](#how-to-remove).

---

## What it adds

### 1. SCTE-35 / DASH-event tab
A new **SCTE-35** tab in the log panel (next to Events / ABR / Network / Manifest) that captures, at runtime, the DASH events Shaka emits:

- **`emsg`** — in-band event boxes (often carry SCTE-35 splice info): scheme, value, id, time window and a hex dump of the first bytes.
- **`timelineregion` added / enter / exit** — MPD `EventStream` / `Event` regions (SCTE-35 markers, ad breaks, boundaries), including the `<Event>`/`<Signal>` XML (truncated).
- Entries whose `schemeIdUri` matches `urn:scte:scte35:*` are tagged **SCTE-35**. The tab shows a live count: `SCTE-35 (N)`.

Only **Shaka** feeds this tab (it exposes the raw DASH events). Entries are also included in the **JSON export** under `scte35`.

### 2. Per-period breakdown in the Manifest tab
When a captured DASH manifest is expanded, a table lists every `<Period>`:

| Column | Meaning |
|--------|---------|
| `#`      | Period index |
| `id`     | `Period@id` |
| `start`  | `Period@start` (seconds; for live it may be an epoch-relative value) |
| `dur`    | Explicit `Period@duration`, else the **spec duration** (`next Period@start − start`), else `~`/`≈` media available in the SegmentTimeline |
| `video` / `audio` | Codecs per period (`⤳` = codec change vs previous period) |
| `scte35` | Number of SCTE-35 `Event`s in that period's `EventStream` |

Markers:
- **⚠gap Xs** — a *real* gap: an explicit `Period@duration` that leaves a hole before the next `@start`. Periods **without** `@duration` are contiguous by DASH spec (they run until the next `@start`) and are **not** flagged.
- **⤳** — video/audio codec change across a period boundary (a common cause of multiperiod failures on TV MSE).
- **~dur / ≈dur** — duration derived from the SegmentTimeline (live period, no `@duration`); `≈` means an `r<0` (repeat-to-end) entry made it an estimate.
- **(~Xs avail)** — how much media of that period is currently in the live DVR window (may be much less than the real duration).
- A **SCTE-35** badge appears on the manifest entry header when it contains SCTE-35 EventStreams.

### 3. SegmentTimeline duration + spec-correct gap logic
For live/dynamic MPDs where periods have no `@duration`, the tool:
- derives each period's **available media** by summing its `SegmentTimeline` (`Σ d·(r+1) / timescale`, preferring the video AdaptationSet), and
- computes the **real period duration** from the next period's `@start` (per DASH spec), so gaps are only flagged when an explicit `@duration` truly leaves a hole (avoids false positives from DVR-trimmed timelines).

---

## How to use it (multiperiod + SCTE-35 hunt)

1. Engine **Shaka**, pinned to the **same version as the TV** (version selector).
2. Load the problematic MPD.
3. **Manifest → expand → periods table**: look for `⚠gap` (real holes) and `⤳` (codec changes across boundaries). Contiguous same-codec periods are structurally healthy.
4. **SCTE-35 tab**: confirm Shaka emits the events, at what times, and whether they align with the period boundaries.
5. **Events tab**: capture any Shaka `ERROR` (code + message) at the moment playback breaks.
6. **Compare A/B**: same stream on two Shaka versions (e.g. 4.13.25 vs 4.16.39) to isolate version-specific multiperiod behaviour.

> Reminder: a desktop browser can't fully reproduce a TV's older Chromium/MSE/CDM. If it reproduces here, great; if it works here but fails on the TV, the next step is the device's remote inspector (Tizen Studio / webOS Web Inspector) and/or a TV-like profile (UA + buffer/codec limits).

---

## Files touched

| File | Change |
|------|--------|
| [lib/engines/types.ts](lib/engines/types.ts) | Added `"scte"` to the `LogType` union. |
| [lib/engines/shaka.ts](lib/engines/shaka.ts) | Runtime `emsg` + `timelineregion*` listeners (SCTE-35 instrumentation). |
| [lib/manifest.ts](lib/manifest.ts) | `DashPeriod`, `DashInfo`, `parseIsoDuration`, `timelineDuration`, `parseDashInfo`, `SCTE_RE`; `dash?` field on `CapturedManifest`. |
| [hooks/usePlayer.ts](hooks/usePlayer.ts) | `scteLog` stream (+reset/export); `parseDashInfo` wired into `pushManifest` (`dash` on each manifest). |
| [components/LogView.tsx](components/LogView.tsx) | `scte` tab + color; `scteLog` prop. |
| [components/ManifestView.tsx](components/ManifestView.tsx) | `PeriodsTable` component; SCTE-35 badge on entry header. |
| [components/PlayerPanel.tsx](components/PlayerPanel.tsx) | Passes `scteLog` to `LogView`. |

---

## How to remove

To strip this add-on and return to the base tool:

1. **`lib/engines/shaka.ts`** — delete the `// ── SCTE-35 / DASH event instrumentation ──` block (the `secs`/`hex`/`isScte` helpers and the `emsg` + `timelineregion*` `addEventListener` calls). Nothing else in the file depends on it.
2. **`lib/manifest.ts`** — remove `DashPeriod`, `DashInfo`, `parseIsoDuration`, `SCTE_RE`, `timelineDuration`, `parseDashInfo`, and the `dash?: DashInfo` field on `CapturedManifest`. (Keep `countPeriods` — the base single/multiperiod badge uses it.)
3. **`hooks/usePlayer.ts`** — remove the `scteLog` state, its push in `log()`, its resets in `load()`/`reset()`, the `scte35` key in `exportJSON`, and `scteLog` from the returned object + `UsePlayer` interface. Remove the `parseDashInfo` import and the `dash` computation/field in `pushManifest`.
4. **`components/LogView.tsx`** — remove the `scte` tab entry, the `scteLog` prop, the `scte` key in `TYPE_COLOR`, and the `scte` branches in the empty-state text and `logArr` selection.
5. **`components/ManifestView.tsx`** — delete the `PeriodsTable` component and its render (`{open && m.dash && …}`), the SCTE-35 header badge, and the `DashInfo` import. Restore the simple `dur` cell if desired.
6. **`components/PlayerPanel.tsx`** — remove `scteLog={player.scteLog}`.
7. **`lib/engines/types.ts`** — remove `"scte"` from `LogType` (do this last, after the consumers above are gone).

Then `npx tsc --noEmit` to confirm nothing dangling.

> The **CDN header proxy** (Origin/Referer/User-Agent) is **not** part of this add-on — it's documented in the main [README.md](README.md#cdn-headers-origin--referer--user-agent) and stays regardless.
