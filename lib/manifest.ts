import { detectFormat, type StreamFormat } from "./format";

/** Refine the stream format using the manifest body when the URL was ambiguous. */
/** HLS: a master playlist lists variants (`#EXT-X-STREAM-INF`); a media playlist
 *  lists segments instead. Detecting from the body is engine-independent and
 *  survives whatever `note` each engine happens to set. */
export function hlsKind(text: string): "master" | "media" | null {
  if (!text || !/#EXTM3U/i.test(text)) return null;
  return /#EXT-X-STREAM-INF/i.test(text) ? "master" : "media";
}

export function detectFormatFromText(
  text: string,
  url: string,
  hint?: StreamFormat
): StreamFormat {
  let format = hint ?? detectFormat(url);
  if (format === "unknown" || format === "smooth") {
    if (/<MPD[\s>]/.test(text)) format = "dash";
    else if (/#EXTM3U/.test(text)) format = "hls";
    else if (/<SmoothStreamingMedia/.test(text)) format = "smooth";
  }
  return format;
}

/**
 * One track's (video or audio) SegmentTimeline within a period, reduced to what
 * a continuity/consistency check needs: media-time edges and any internal
 * gap/overlap. *Ticks values are in `timescale` units; *Sec are presentation
 * seconds. Used to verify the multiperiod→one-period stitch is clean.
 */
export interface TrackTimeline {
  timescale: number;
  pto: number; // presentationTimeOffset (ticks)
  firstTick: number; // first S@t
  lastEndTick: number; // last segment end = t + Σ d
  segments: number;
  estimatedToEnd: boolean; // an r<0 (repeat-to-end) entry was present
  // Presentation-time edges: Period@start + (tick − pto)/timescale.
  firstSec?: number;
  lastSec?: number;
  // Gaps/overlaps between consecutive S entries, in presentation seconds
  // (positive = hole, negative = overlap). Empty when the timeline is clean —
  // this is where a bad stitch (t jumps instead of continuing) shows up.
  internalBreaks: { afterSeg: number; deltaSec: number }[];
  // The raw <S> rows, as written in the MPD. `startTick` is the resolved start
  // (an implicit S continues from the previous one); `r` is the @r repeat count
  // (0 when absent, −1 for repeat-to-end); `explicitT` = @t was present.
  entries: { startTick: number; d: number; r: number; explicitT: boolean }[];
}

/** Per-period breakdown of a DASH MPD. */
export interface DashPeriod {
  index: number;
  id?: string;
  start?: number; // seconds
  duration?: number; // seconds, from Period@duration
  derivedDuration?: number; // seconds = next Period@start − this @start (DASH spec)
  mediaDuration?: number; // seconds of media currently in the SegmentTimeline (live: DVR window)
  durationEstimated?: boolean; // true if a SegmentTimeline used r<0 (repeat-to-end)
  videoCodecs: string[];
  audioCodecs: string[];
  eventStreams: number;
  scte35Events: number;
  hasScte35: boolean;
  gapBefore?: number; // seconds gap from previous period's end
  timeline?: TrackTimeline; // video SegmentTimeline edges (for continuity checks)
  audioTimeline?: TrackTimeline; // audio SegmentTimeline edges
  // Video/audio presentation-start skew (audioFirstSec − videoFirstSec), and
  // end skew. A large skew = the two tracks don't line up after a stitch.
  vaStartSkewSec?: number;
  vaEndSkewSec?: number;
}

/** Result of checking whether two adjacent content segments/periods line up. */
export interface Continuity {
  continuous: boolean;
  gapSec: number; // video presentation-time gap at the seam (+hole / −overlap), 0 = perfect
  reasons: string[]; // human-readable notes on what breaks (empty if continuous)
}

export interface DashInfo {
  periods: DashPeriod[];
  scte35EventStreams: number;
  scte35Events: number;
  hasScte35: boolean;
}

/** A single manifest captured during a session (initial fetch or live refresh). */
export interface CapturedManifest {
  id: number;
  time: Date;
  format: StreamFormat;
  periodCount?: number;
  isMultiperiod: boolean;
  text: string;
  bytes?: number;
  note?: string;
  source: "fetch" | "engine";
  dash?: DashInfo;
}

/** Parse an ISO-8601 duration (e.g. "PT1M30.5S", "PT0H0M12.000S") to seconds. */
function parseIsoDuration(v?: string | null): number | undefined {
  if (!v) return undefined;
  const m = v.match(
    /^-?P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/
  );
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  return (
    (parseFloat(y || "0") * 365 * 86400) +
    (parseFloat(mo || "0") * 30 * 86400) +
    (parseFloat(d || "0") * 86400) +
    (parseFloat(h || "0") * 3600) +
    (parseFloat(mi || "0") * 60) +
    parseFloat(s || "0")
  );
}

const SCTE_RE = /scte(?:[-_:]?35)/i;

/**
 * Extract the SegmentTimeline of one track (video or audio) in a period:
 * media-time edges, timescale / presentationTimeOffset, and any internal
 * gap/overlap between consecutive S entries. `periodStart` (Period@start
 * seconds) anchors the presentation-time edges. Returns undefined when the
 * period has no matching SegmentTimeline.
 */
function extractTimeline(
  periodEl: Element,
  kind: "video" | "audio",
  periodStart?: number
): TrackTimeline | undefined {
  const trackOf = (el: Element): "video" | "audio" | "other" => {
    let n: Element | null = el;
    while (n) {
      if (n.localName === "AdaptationSet") {
        const m = n.getAttribute("mimeType") || n.getAttribute("contentType") || "";
        if (/video/i.test(m)) return "video";
        if (/audio/i.test(m)) return "audio";
        return "other";
      }
      n = n.parentElement;
    }
    return "other";
  };

  const templates = Array.from(periodEl.getElementsByTagName("*")).filter(
    (el) =>
      el.localName === "SegmentTemplate" &&
      Array.from(el.children).some((c) => c.localName === "SegmentTimeline") &&
      trackOf(el) === kind
  );
  if (!templates.length) return undefined;

  const tmpl = templates[0];
  const timescale = parseInt(tmpl.getAttribute("timescale") || "1", 10) || 1;
  const pto = parseFloat(tmpl.getAttribute("presentationTimeOffset") || "0") || 0;
  const timeline = Array.from(tmpl.children).find(
    (c) => c.localName === "SegmentTimeline"
  );
  if (!timeline) return undefined;

  const base = periodStart ?? 0;
  const toSec = (tick: number) => base + (tick - pto) / timescale;

  let cursor: number | null = null; // running media tick position
  let firstTick: number | null = null;
  let estimatedToEnd = false;
  let segments = 0;
  const internalBreaks: { afterSeg: number; deltaSec: number }[] = [];
  const entries: { startTick: number; d: number; r: number; explicitT: boolean }[] = [];

  for (const s of Array.from(timeline.children)) {
    if (s.localName !== "S") continue;
    const tAttr = s.getAttribute("t");
    const d = parseFloat(s.getAttribute("d") || "0");
    const rAttr = s.getAttribute("r");
    const r = rAttr != null ? parseInt(rAttr, 10) : 0;
    let count = 1;
    if (rAttr != null) {
      if (r >= 0) count = r + 1;
      else estimatedToEnd = true; // repeat-to-end: exact count unknown
    }
    // An explicit @t that doesn't match the running cursor is a gap/overlap.
    if (tAttr != null) {
      const t = parseFloat(tAttr);
      if (cursor != null && Math.abs(t - cursor) > 1) {
        internalBreaks.push({ afterSeg: segments, deltaSec: (t - cursor) / timescale });
      }
      cursor = t;
    }
    if (cursor == null) cursor = 0;
    if (firstTick == null) firstTick = cursor;
    entries.push({ startTick: cursor, d, r, explicitT: tAttr != null });
    cursor += d * (count < 1 ? 1 : count);
    segments += count;
  }

  if (firstTick == null || cursor == null) return undefined;
  return {
    timescale,
    pto,
    firstTick,
    lastEndTick: cursor,
    segments,
    estimatedToEnd,
    firstSec: toSec(firstTick),
    lastSec: toSec(cursor),
    internalBreaks,
    entries,
  };
}

/**
 * Check whether the content resuming after an ad lines up with the content
 * before it — the "does the SegmentTimeline concord?" test. `prev` is the
 * timeline captured at/just before SCTE-OUT, `next` the one after SCTE-IN.
 * A non-zero gap, a timescale change or a codec change at the seam is exactly
 * where an old TV MSE (no gap-jumping) stalls.
 */
export function checkContinuity(
  prev: { timeline?: TrackTimeline; audioTimeline?: TrackTimeline; videoCodecs: string[] },
  next: { timeline?: TrackTimeline; audioTimeline?: TrackTimeline; videoCodecs: string[] }
): Continuity | null {
  const a = prev.timeline;
  const b = next.timeline;
  if (!a || !b) return null;

  const gapSec = (b.firstSec ?? 0) - (a.lastSec ?? 0);
  const aa = prev.audioTimeline;
  const ab = next.audioTimeline;
  const audioGapSec =
    aa?.lastSec != null && ab?.firstSec != null ? ab.firstSec - aa.lastSec : undefined;
  const timescaleChanged = a.timescale !== b.timescale;
  // Only a codec *family* change (e.g. avc1→hvc1) forces an MSE SourceBuffer
  // codec switch (the thing old TVs stall on). A profile/level bump within the
  // same fourcc (avc1.4D401E→avc1.4D401F) is normal ABR, not a discontinuity.
  const family = (list: string[]) =>
    [...new Set(list.map((c) => c.split(".")[0].toLowerCase()))].sort().join(",");
  const famPrev = family(prev.videoCodecs);
  const famNext = family(next.videoCodecs);
  const codecChanged = !!famPrev && !!famNext && famPrev !== famNext;

  const reasons: string[] = [];
  if (Math.abs(gapSec) > 0.05)
    reasons.push(
      `${gapSec > 0 ? "hueco" : "solape"} de vídeo de ${Math.abs(gapSec).toFixed(3)}s en la costura`
    );
  if (audioGapSec != null && Math.abs(audioGapSec) > 0.05)
    reasons.push(
      `${audioGapSec > 0 ? "hueco" : "solape"} de audio de ${Math.abs(audioGapSec).toFixed(3)}s`
    );
  if (timescaleChanged)
    reasons.push(`timescale cambia ${a.timescale} → ${b.timescale}`);
  if (codecChanged)
    reasons.push(`familia de codec de vídeo cambia ${famPrev} → ${famNext}`);

  return { continuous: reasons.length === 0, gapSec, reasons };
}

/** Extract period structure and SCTE-35 markers from a DASH MPD. */
export function parseDashInfo(xml: string): DashInfo | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return null;
  } catch {
    return null;
  }
  const all = Array.from(doc.getElementsByTagName("*"));
  const periodEls = all.filter((el) => el.localName === "Period");
  if (!periodEls.length) return null;

  let totalStreams = 0;
  let totalEvents = 0;

  const periods: DashPeriod[] = periodEls.map((p, index) => {
    const kids = Array.from(p.getElementsByTagName("*"));
    const adapts = kids.filter((el) => el.localName === "AdaptationSet");
    const videoCodecs = new Set<string>();
    const audioCodecs = new Set<string>();
    for (const a of adapts) {
      const mime =
        a.getAttribute("mimeType") ||
        a.getAttribute("contentType") ||
        "";
      const reps = Array.from(a.getElementsByTagName("*")).filter(
        (el) => el.localName === "Representation"
      );
      const codecs = [
        a.getAttribute("codecs"),
        ...reps.map((r) => r.getAttribute("codecs")),
      ].filter(Boolean) as string[];
      const bucket = /audio/i.test(mime) ? audioCodecs : videoCodecs;
      codecs.forEach((c) => bucket.add(c));
    }

    const eventStreamEls = kids.filter((el) => el.localName === "EventStream");
    let scte35Events = 0;
    let scteStreams = 0;
    for (const es of eventStreamEls) {
      const scheme = es.getAttribute("schemeIdUri") || "";
      const evs = Array.from(es.getElementsByTagName("*")).filter(
        (el) => el.localName === "Event"
      ).length;
      if (SCTE_RE.test(scheme)) {
        scteStreams++;
        scte35Events += evs;
      }
    }
    totalStreams += scteStreams;
    totalEvents += scte35Events;

    const periodStart = parseIsoDuration(p.getAttribute("start"));
    const timeline = extractTimeline(p, "video", periodStart);
    const audioTimeline = extractTimeline(p, "audio", periodStart);
    const explicitDur = parseIsoDuration(p.getAttribute("duration"));
    let mediaDuration: number | undefined;
    let durationEstimated: boolean | undefined;
    if (explicitDur == null && timeline) {
      mediaDuration = (timeline.lastEndTick - timeline.firstTick) / timeline.timescale;
      durationEstimated = timeline.estimatedToEnd;
    }

    // Video/audio skew: how far apart the two tracks start and end. After a
    // clean stitch they should line up (≈0); a big skew stalls playback.
    let vaStartSkewSec: number | undefined;
    let vaEndSkewSec: number | undefined;
    if (timeline?.firstSec != null && audioTimeline?.firstSec != null)
      vaStartSkewSec = audioTimeline.firstSec - timeline.firstSec;
    if (timeline?.lastSec != null && audioTimeline?.lastSec != null)
      vaEndSkewSec = audioTimeline.lastSec - timeline.lastSec;

    return {
      index,
      id: p.getAttribute("id") || undefined,
      start: periodStart,
      duration: explicitDur,
      mediaDuration,
      durationEstimated,
      videoCodecs: [...videoCodecs],
      audioCodecs: [...audioCodecs],
      eventStreams: eventStreamEls.length,
      scte35Events,
      hasScte35: scteStreams > 0,
      timeline,
      audioTimeline,
      vaStartSkewSec,
      vaEndSkewSec,
    };
  });

  // Per the DASH spec, a period without @duration lasts until the next
  // period's @start, so those boundaries are contiguous by definition.
  // Record that spec duration for display...
  for (let i = 0; i < periods.length - 1; i++) {
    const cur = periods[i];
    const next = periods[i + 1];
    if (cur.start != null && next.start != null) {
      cur.derivedDuration = next.start - cur.start;
    }
  }
  // ...and only flag a REAL gap when an explicit @duration leaves a hole
  // (or overlap) versus the next period's start.
  for (let i = 1; i < periods.length; i++) {
    const prev = periods[i - 1];
    const cur = periods[i];
    if (prev.start != null && prev.duration != null && cur.start != null) {
      const gap = cur.start - (prev.start + prev.duration);
      if (Math.abs(gap) > 0.05) cur.gapBefore = gap;
    }
  }

  return {
    periods,
    scte35EventStreams: totalStreams,
    scte35Events: totalEvents,
    hasScte35: totalStreams > 0,
  };
}

/** Count DASH <Period> elements (namespace-prefix aware). */
export function countPeriods(xml: string): number {
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (!doc.querySelector("parsererror")) {
      const periods = Array.from(doc.getElementsByTagName("*")).filter(
        (el) => el.localName === "Period"
      );
      if (periods.length) return periods.length;
    }
  } catch {
    /* fall through to regex */
  }
  return (xml.match(/<([\w-]+:)?Period[\s>/]/g) || []).length;
}
