"use client";

import {
  Fragment,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fmtBytes, fmtTime } from "@/lib/fmt";
import { pressable } from "@/lib/tv";
import {
  checkContinuity,
  hlsKind,
  type CapturedManifest,
  type DashInfo,
  type TrackTimeline,
} from "@/lib/manifest";

interface Props {
  manifests: CapturedManifest[];
  error: string | null;
  loading: boolean;
}

/** HLS rows are colour-coded so the master doesn't get buried by the media
 *  playlists, which in a live stream refresh every few seconds. Audio/subtitle
 *  renditions come from the engine's note; master vs variant from the body. */
type ManifestKind = { key: "master" | "media"; txt: string; cls: string };
function manifestKind(m: CapturedManifest): ManifestKind | null {
  const k = hlsKind(m.text);
  if (!k) return null; // not HLS — keep the DASH badges
  const note = (m.note || "").toLowerCase();
  if (/audio/.test(note)) return { key: "media", txt: "AUDIO", cls: "bg-warn/20 text-warn" };
  if (/subtitle|subs/.test(note))
    return { key: "media", txt: "SUBS", cls: "bg-[#22d3ee]/20 text-[#22d3ee]" };
  return k === "master"
    ? { key: "master", txt: "MASTER", cls: "bg-gb/20 text-gb" }
    : { key: "media", txt: "VARIANT", cls: "bg-ga/[.12] text-ga" };
}

function highlight(line: string, q: string): React.ReactNode {
  if (!q) return line;
  const idx = line.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return line;
  return (
    <>
      {line.slice(0, idx)}
      <mark className="bg-ga/30 text-tx1">{line.slice(idx, idx + q.length)}</mark>
      {line.slice(idx + q.length)}
    </>
  );
}

function secs(n?: number): string {
  if (n == null) return "—";
  return n.toFixed(2) + "s";
}

/** One track's timeline edges + internal gap/overlap flag (V or A). */
function TrackLine({ tag, t }: { tag: "V" | "A"; t?: TrackTimeline }) {
  if (!t || t.firstSec == null || t.lastSec == null) {
    return (
      <span className="text-tx3">
        <span className="text-tx2">{tag}</span> —
      </span>
    );
  }
  return (
    <span title={`ts=${t.timescale} · pto=${t.pto} · ${t.segments} segs`}>
      <span className="text-tx2">{tag}</span> {t.firstSec.toFixed(2)}→{t.lastSec.toFixed(2)}
      {t.internalBreaks.length > 0 && (
        <span
          className="ml-1 text-err"
          title="Salto en los timestamps dentro del propio timeline (cosido malo: t no continúa)"
        >
          ✗{t.internalBreaks
            .map((b) => ` ${b.deltaSec > 0 ? "+" : ""}${b.deltaSec.toFixed(2)}s`)
            .join("")}
        </span>
      )}
    </span>
  );
}

/** The raw <S t d r> rows of one track's SegmentTimeline + derived times. */
function SegmentTimelineView({ label, t }: { label: string; t?: TrackTimeline }) {
  if (!t || !t.entries.length) return null;
  const breakAt = new Set(t.internalBreaks.map((b) => b.afterSeg));
  let segsBefore = 0;
  const th =
    "px-3 py-[5px] text-[12px] font-semibold uppercase tracking-[.05em] text-tx2";
  const td = "px-3 py-[5px] text-[13px] tabular-nums whitespace-nowrap";
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-bd2 bg-bg">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-bd2 bg-sf2 px-3 py-2">
        <span className="font-mono text-[13px] font-bold uppercase tracking-[.06em] text-tx1">
          SegmentTimeline · {label}
        </span>
        <span className="font-mono text-[12px] text-tx2">
          timescale=<span className="text-tx1">{t.timescale}</span> · pto=
          <span className="text-tx1">{t.pto}</span> ·{" "}
          <span className="text-tx1">{t.segments}</span> segs
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono">
          <thead>
            <tr className="border-b border-bd2 text-left">
              <th className={th}>#</th>
              <th className={`${th} text-right`}>t (inicio)</th>
              <th className={`${th} text-right`}>d</th>
              <th className={`${th} text-right`}>r</th>
              <th className={`${th} text-right`}>segs</th>
              <th className={`${th} text-right`}>dur/seg</th>
              <th className={`${th} text-right`}>span (s)</th>
            </tr>
          </thead>
          <tbody>
            {t.entries.map((e, i) => {
              const count = e.r >= 0 ? e.r + 1 : null; // null = repeat-to-end
              const durSeg = e.d / t.timescale;
              const startSec = (t.firstSec ?? 0) + (e.startTick - t.firstTick) / t.timescale;
              const endSec =
                count != null ? startSec + (e.d * count) / t.timescale : undefined;
              const isBreak = breakAt.has(segsBefore) && e.explicitT;
              segsBefore += count ?? 1;
              return (
                <tr
                  key={i}
                  className={`border-t border-bd/60 ${
                    isBreak ? "bg-err/10 text-err" : i % 2 ? "bg-sf1/40 text-tx1" : "text-tx1"
                  }`}
                  title={isBreak ? "Aquí el t salta: no continúa del segmento anterior" : undefined}
                >
                  <td className={`${td} text-tx2`}>{i}</td>
                  <td className={`${td} text-right`}>
                    {isBreak && <span className="mr-1">⚠</span>}
                    {e.startTick.toLocaleString("es-ES")}
                    {!e.explicitT && (
                      <span className="text-tx3" title="t implícito: continúa del segmento anterior">
                        {" *"}
                      </span>
                    )}
                  </td>
                  <td className={`${td} text-right`}>{e.d.toLocaleString("es-ES")}</td>
                  <td className={`${td} text-right`}>{e.r}</td>
                  <td className={`${td} text-right text-tx2`}>{count ?? "→fin"}</td>
                  <td className={`${td} text-right text-tx2`}>{durSeg.toFixed(3)}s</td>
                  <td className={`${td} text-right text-tx2`}>
                    <span className="text-tx1">{startSec.toFixed(2)}</span>
                    {endSec != null ? `→${endSec.toFixed(2)}` : "…"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-bd2 px-3 py-2 text-[11px] leading-[1.6] text-tx2">
        <span className="font-mono text-tx1">t</span> = inicio (ticks) ·{" "}
        <span className="font-mono text-tx1">d</span> = duración por segmento ·{" "}
        <span className="font-mono text-tx1">r</span> = repeticiones (segs = r+1) ·{" "}
        <span className="font-mono text-tx1">*</span> = t implícito (continúa del anterior) · span =
        tiempo de presentación en segundos.
      </div>
    </div>
  );
}

function PeriodsTable({ dash }: { dash: DashInfo }) {
  const [openSeg, setOpenSeg] = useState<Set<number>>(new Set());
  const toggleSeg = (i: number) =>
    setOpenSeg((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  // Continuity across every seam (the "does the SegmentTimeline concord across
  // the ad break?" check). A discontinuity is exactly where an old TV MSE stalls.
  const seams = dash.periods.slice(1).map((p, i) => ({
    at: i + 1,
    c: checkContinuity(dash.periods[i], p),
  }));
  const broken = seams.filter((s) => s.c && !s.c.continuous);
  const internalBroken = dash.periods.filter(
    (p) =>
      (p.timeline?.internalBreaks.length ?? 0) > 0 ||
      (p.audioTimeline?.internalBreaks.length ?? 0) > 0
  );
  const skewed = dash.periods.filter(
    (p) =>
      Math.abs(p.vaStartSkewSec ?? 0) > 0.05 || Math.abs(p.vaEndSkewSec ?? 0) > 0.05
  );

  return (
    <div className="border-t border-bd bg-sf1 px-2 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] font-semibold text-tx1">
          {dash.periods.length} period{dash.periods.length === 1 ? "" : "s"}
        </span>
        {dash.hasScte35 && (
          <span className="rounded bg-[#22d3ee]/20 px-[6px] py-[1px] font-mono text-[9px] font-semibold text-[#22d3ee]">
            SCTE-35 · {dash.scte35Events} event{dash.scte35Events === 1 ? "" : "s"}
          </span>
        )}
        {dash.periods.length > 1 && (
          <span
            className={`rounded px-[6px] py-[1px] font-mono text-[9px] font-semibold ${
              broken.length
                ? "bg-err/20 text-err"
                : "bg-ga/[.12] text-ga"
            }`}
          >
            {broken.length
              ? `✗ ${broken.length} costura${broken.length === 1 ? "" : "s"} discontinua${broken.length === 1 ? "" : "s"}`
              : "✓ costuras concuerdan"}
          </span>
        )}
        {internalBroken.length > 0 && (
          <span className="rounded bg-err/20 px-[6px] py-[1px] font-mono text-[9px] font-semibold text-err">
            ✗ salto de timestamps en el timeline
          </span>
        )}
        {skewed.length > 0 && (
          <span className="rounded bg-err/20 px-[6px] py-[1px] font-mono text-[9px] font-semibold text-err">
            ✗ vídeo/audio desalineados
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[9px]">
          <thead>
            <tr className="text-tx3">
              <th className="px-1 py-[2px] text-left font-semibold">#</th>
              <th className="px-1 py-[2px] text-left font-semibold">id</th>
              <th className="px-1 py-[2px] text-right font-semibold">start</th>
              <th className="px-1 py-[2px] text-right font-semibold">dur</th>
              <th className="px-1 py-[2px] text-right font-semibold" title="Bordes del SegmentTimeline de vídeo en tiempo de presentación">
                timeline (media)
              </th>
              <th className="px-1 py-[2px] text-left font-semibold">video</th>
              <th className="px-1 py-[2px] text-left font-semibold">audio</th>
              <th className="px-1 py-[2px] text-left font-semibold">scte35</th>
            </tr>
          </thead>
          <tbody>
            {dash.periods.map((p, i) => {
              const prev = i > 0 ? dash.periods[i - 1] : undefined;
              const vChanged =
                !!prev &&
                prev.videoCodecs.join() !== p.videoCodecs.join() &&
                p.videoCodecs.length > 0;
              const aChanged =
                !!prev &&
                prev.audioCodecs.join() !== p.audioCodecs.join() &&
                p.audioCodecs.length > 0;
              const seam = i > 0 ? seams[i - 1].c : null;
              const tl = p.timeline;
              return (
                <Fragment key={i}>
                  {i > 0 && seam && (
                    <tr
                      className={seam.continuous ? "text-ga" : "text-err"}
                      title="Continuidad del timeline de contenido a través de esta frontera (costura de publi)"
                    >
                      <td />
                      <td colSpan={7} className="px-1 py-[2px]">
                        {seam.continuous
                          ? `↳ costura P${i - 1}→P${i}: ✓ concuerda (gap ${seam.gapSec.toFixed(3)}s)`
                          : `↳ costura P${i - 1}→P${i}: ✗ ${seam.reasons.join("; ")}`}
                      </td>
                    </tr>
                  )}
                  <tr
                    {...pressable(() => toggleSeg(i))}
                    className="cursor-pointer border-t border-bd/50 text-tx2 hover:bg-sf2"
                    title="Ver el SegmentTimeline (bloque <S t d r>)"
                  >
                    <td className="px-1 py-[2px] text-tx3">
                      {p.timeline?.entries.length || p.audioTimeline?.entries.length
                        ? openSeg.has(i)
                          ? "▾ "
                          : "▸ "
                        : ""}
                      {p.index}
                    </td>
                    <td className="px-1 py-[2px] text-tx1">{p.id ?? "—"}</td>
                    <td className="px-1 py-[2px] text-right">
                      {secs(p.start)}
                      {p.gapBefore != null && (
                        <span
                          className="ml-1 text-warn"
                          title={`Gap of ${p.gapBefore.toFixed(2)}s before this period`}
                        >
                          ⚠gap {p.gapBefore.toFixed(2)}s
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-[2px] text-right">
                      {p.duration != null ? (
                        <span title="Period@duration (explicit)">{secs(p.duration)}</span>
                      ) : p.derivedDuration != null ? (
                        <span
                          className="text-tx2"
                          title={
                            "Period duration = next Period@start − start (DASH spec)" +
                            (p.mediaDuration != null
                              ? ` · ${p.mediaDuration.toFixed(2)}s available in timeline`
                              : "")
                          }
                        >
                          {secs(p.derivedDuration)}
                          {p.mediaDuration != null &&
                            p.mediaDuration < p.derivedDuration - 0.5 && (
                              <span className="ml-1 text-tx3">
                                (~{p.mediaDuration.toFixed(0)}s avail)
                              </span>
                            )}
                        </span>
                      ) : p.mediaDuration != null ? (
                        <span
                          className="text-tx3"
                          title="Media available in SegmentTimeline (current live period)"
                        >
                          {p.durationEstimated ? "≈" : "~"}
                          {secs(p.mediaDuration)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-1 py-[2px] text-right align-top text-tx3">
                      {tl || p.audioTimeline ? (
                        <div className="flex flex-col items-end leading-[1.4]">
                          <TrackLine tag="V" t={tl} />
                          <TrackLine tag="A" t={p.audioTimeline} />
                          {p.vaStartSkewSec != null &&
                            (Math.abs(p.vaStartSkewSec) > 0.05 ||
                              Math.abs(p.vaEndSkewSec ?? 0) > 0.05) && (
                              <span
                                className="text-err"
                                title="Desfase entre el inicio/fin de vídeo y audio (deberían coincidir tras un cosido limpio)"
                              >
                                skew V/A {p.vaStartSkewSec > 0 ? "+" : ""}
                                {p.vaStartSkewSec.toFixed(2)}s
                              </span>
                            )}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={`px-1 py-[2px] ${vChanged ? "text-warn" : "text-tx2"}`}>
                      {p.videoCodecs.join(", ") || "—"}
                      {vChanged && " ⤳"}
                    </td>
                    <td className={`px-1 py-[2px] ${aChanged ? "text-warn" : "text-tx2"}`}>
                      {p.audioCodecs.join(", ") || "—"}
                      {aChanged && " ⤳"}
                    </td>
                    <td className="px-1 py-[2px]">
                      {p.hasScte35 ? (
                        <span className="text-[#22d3ee]">{p.scte35Events}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                  {openSeg.has(i) && (p.timeline || p.audioTimeline) && (
                    <tr className="bg-bg/60">
                      <td />
                      <td colSpan={7} className="px-1 pb-2">
                        <SegmentTimelineView label="vídeo" t={p.timeline} />
                        <SegmentTimelineView label="audio" t={p.audioTimeline} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-1 text-[9px] leading-[1.5] text-tx3">
        <b className="text-tx2">▸ pincha un period</b> para ver su bloque{" "}
        <span className="font-mono">SegmentTimeline</span> (las filas{" "}
        <span className="font-mono">&lt;S t d r&gt;</span>) de vídeo y audio.{" "}
        <b className="text-tx2">timeline (media)</b> = bordes del SegmentTimeline en tiempo de
        presentación, por pista: <span className="text-tx2">V</span> vídeo /{" "}
        <span className="text-tx2">A</span> audio. <b className="text-tx2">✗ en una pista</b> = los
        timestamps <b>saltan</b> dentro del period (cosido malo: al aplanar multiperiod→one-period,
        el <span className="font-mono">t</span> no continúa). <b className="text-tx2">skew V/A</b> =
        vídeo y audio no arrancan/terminan juntos. <b className="text-tx2">costura</b> = ¿el contenido
        tras la frontera concuerda con el de antes (hueco/solape de vídeo o audio, cambio de timescale
        o de familia de codec)? — justo donde el MSE viejo de la TV haría stall. ⚠ = gap por
        @duration · ⤳ = cambio de codec.
      </div>
    </div>
  );
}

function ManifestBody({ text, q }: { text: string; q: string }) {
  const rows = useMemo(() => {
    const lines = text.split("\n").map((t, i) => ({ n: i + 1, text: t }));
    if (!q.trim()) return lines;
    const needle = q.toLowerCase();
    return lines.filter((r) => r.text.toLowerCase().includes(needle));
  }, [text, q]);

  if (rows.length === 0) {
    return <div className="p-3 text-center text-tx3">No matches</div>;
  }
  return (
    <div className="max-h-[40vh] overflow-auto border-t border-bd bg-bg px-2 py-1 font-mono text-[10px] leading-[1.7]">
      {rows.map((r) => (
        <div key={r.n} className="flex gap-2 hover:bg-sf2">
          <span className="w-[38px] flex-shrink-0 select-none text-right text-tx3">
            {r.n}
          </span>
          <span className="whitespace-pre-wrap break-all text-tx1">
            {highlight(r.text, q.trim())}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * One manifest row. Memoized so that appending a new capture only renders the
 * new row (and any toggled row) — not the whole list. This keeps the list
 * smooth even with a couple thousand captured manifests.
 */
const ManifestRow = memo(function ManifestRow({
  m,
  open,
  query,
  onToggle,
}: {
  m: CapturedManifest;
  open: boolean;
  query: string;
  onToggle: (id: number) => void;
}) {
  const matches = query
    ? m.text.split("\n").filter((l) => l.toLowerCase().includes(query.toLowerCase())).length
    : 0;
  const hls = manifestKind(m);
  const badge = hls
    ? { txt: hls.txt, cls: hls.cls }
    : m.periodCount != null
      ? m.isMultiperiod
        ? { txt: `MULTIPERIOD · ${m.periodCount}`, cls: "bg-warn/20 text-warn" }
        : { txt: "SINGLE PERIOD", cls: "bg-ga/[.12] text-ga" }
      : { txt: m.format.toUpperCase(), cls: "bg-sf2 text-tx2" };

  return (
    <div className="border-b border-bd">
      <div
        {...pressable(() => onToggle(m.id))}
        className="flex cursor-pointer items-center gap-2 px-2 py-[6px] hover:bg-sf2"
      >
        <span className="w-[10px] flex-shrink-0 text-tx3">{open ? "▾" : "▸"}</span>
        <span className="w-[80px] flex-shrink-0 font-mono text-[10px] text-tx3">
          {fmtTime(m.time)}
        </span>
        <span
          className={`flex-shrink-0 rounded px-2 py-[1px] font-mono text-[9px] font-semibold ${badge.cls}`}
        >
          {badge.txt}
        </span>
        {m.dash?.hasScte35 && (
          <span className="flex-shrink-0 rounded bg-[#22d3ee]/20 px-[5px] py-[1px] font-mono text-[9px] font-semibold text-[#22d3ee]">
            SCTE-35
          </span>
        )}
        <span className="flex-shrink-0 font-mono text-[9px] uppercase text-tx3">{m.source}</span>
        {m.bytes != null && (
          <span className="flex-shrink-0 font-mono text-[9px] text-tx3">
            {fmtBytes(m.bytes, "")}
          </span>
        )}
        {query && (
          <span className="ml-auto flex-shrink-0 font-mono text-[9px] text-ga">
            {matches} match{matches === 1 ? "" : "es"}
          </span>
        )}
      </div>
      {m.note && open && (
        <div className="px-2 pb-1 font-mono text-[9px] text-tx3">⚠ {m.note}</div>
      )}
      {open && m.dash && m.dash.periods.length > 0 && <PeriodsTable dash={m.dash} />}
      {open && <ManifestBody text={m.text} q={query} />}
    </div>
  );
});

export default function ManifestView({ manifests, error, loading }: Props) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "master" | "media">("all");
  // Nothing is open until the user clicks a manifest row.
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());

  const toggle = useCallback((id: number) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Scroll anchoring: manifests prepend at the top on every live refresh. If the
  // user is at the top, keep showing the newest; if they scrolled down to inspect
  // an older capture, offset scrollTop by the height the new rows added so their
  // view stays put instead of getting pushed down.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Same as the log panels: don't move anything while the pointer is over the list.
  const hovering = useRef(false);
  const prevHeight = useRef(0);

  function onScroll() {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollTop <= 24;
  }

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current && !hovering.current) el.scrollTop = 0;
    else el.scrollTop += el.scrollHeight - prevHeight.current;
    prevHeight.current = el.scrollHeight;
  }, [manifests.length]);

  // Expanding/collapsing a row changes the height without prepending — resync the
  // baseline so the next live refresh measures only what the prepend added.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) prevHeight.current = el.scrollHeight;
  }, [openIds]);

  if (loading && manifests.length === 0) {
    return <div className="p-5 text-center text-tx3">Fetching manifest…</div>;
  }
  if (manifests.length === 0) {
    return (
      <div className="p-4 text-center">
        {error ? (
          <span className="text-err">{error}</span>
        ) : (
          <span className="text-tx3">No manifests captured yet</span>
        )}
      </div>
    );
  }

  const query = q.trim();
  // Only offer the master/variant filter when there is HLS in the list.
  const hasHls = manifests.some((m) => manifestKind(m) !== null);
  const shown =
    kind === "all" ? manifests : manifests.filter((m) => manifestKind(m)?.key === kind);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Search */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-bd bg-sf1 px-2 py-2">
        <span className="font-mono text-[10px] text-tx3">
          {shown.length}/{manifests.length}
        </span>
        {hasHls && (
          <div className="flex flex-shrink-0 gap-1">
            {([
              ["all", "Todos"],
              ["master", "Master"],
              ["media", "Variants"],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`rounded px-[7px] py-[2px] font-mono text-[9px] font-semibold uppercase tracking-[.05em] transition ${
                  kind === k
                    ? k === "master"
                      ? "bg-gb/20 text-gb"
                      : k === "media"
                        ? "bg-ga/[.12] text-ga"
                        : "bg-sf3 text-tx1"
                    : "bg-sf2 text-tx3 hover:text-tx2"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <input
          type="text"
          placeholder="Search inside manifests…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1 rounded-[5px] border border-bd bg-sf2 px-[9px] py-[5px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 focus:border-ga"
        />
      </div>

      {/* List (newest first) */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onPointerEnter={() => (hovering.current = true)}
        onPointerLeave={() => (hovering.current = false)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {shown.map((m) => (
          <ManifestRow
            key={m.id}
            m={m}
            open={openIds.has(m.id)}
            query={query}
            onToggle={toggle}
          />
        ))}
      </div>
    </div>
  );
}
