"use client";

import { useEffect, useRef, useState } from "react";
import Header from "./Header";
import ConfigPanel from "./ConfigPanel";
import PlayerPanel from "./PlayerPanel";
import DeployPanel from "./DeployPanel";
import { usePlayer } from "@/hooks/usePlayer";
import { applyDeepLink } from "@/lib/deepLink";
import { useTvViewport } from "@/hooks/useTvViewport";
import { useTvKeyboard } from "@/hooks/useTvKeyboard";
import { ENGINES, DEFAULT_URL } from "@/lib/engines/registry";
import {
  toLoadConfig,
  toNetOverrides,
  type EngineId,
  type PanelConfig,
} from "@/lib/engines/types";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Whether spatial navigation can still move from `el` towards `dir` inside
 * `pane`: some visible focusable element lies on that side and shares part of
 * `el`'s row (the same overlap rule Chromium's spatial navigation uses).
 */
function hasNeighbour(pane: Element, el: HTMLElement, dir: "left" | "right"): boolean {
  const r = el.getBoundingClientRect();
  for (const c of pane.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (c === el) continue;
    const cr = c.getBoundingClientRect();
    if (!cr.width || !cr.height) continue;
    const sameRow = cr.bottom > r.top && cr.top < r.bottom;
    const onSide = dir === "left" ? cr.right <= r.left + 1 : cr.left >= r.right - 1;
    if (sameRow && onSide) return true;
  }
  return false;
}

function makeConfig(engine: EngineId): PanelConfig {
  return {
    engine,
    version: ENGINES[engine].versions[0],
    url: DEFAULT_URL,
    drm: {
      enabled: false,
      system: "widevine",
      licenseUrl: "",
      certUrl: "",
      headers: [],
      contentId: "",
    },
    advanced: {
      matchTv: true,
      bufferGoal: 10,
      rebufferGoal: 2,
      audioLang: "",
      returnToLiveWindow: true,
      stalledMinDuration: 1,
      lockMaxQuality: false,
    },
    // App-faithful CDN headers: Akamai now denies (403) manifest/segment
    // requests without a proper Origin. Send the same Origin+Referer the real
    // Mediaset app sends, with scheme, so requests aren't WAF-blocked.
    net: {
      origin: "https://www.mediasetinfinity.es",
      referer: "https://www.mediasetinfinity.es/",
      userAgent: "",
      headers: [],
    },
    deviceUserAgent: "",
    dai: { assetKey: "", apiKey: "", format: "hls" },
  };
}

export default function StreamProbe() {
  useTvViewport();
  useTvKeyboard();
  // Config can arrive in the query string, so each TV's launcher (or a bookmark)
  // can open StreamProbe already pointed at its own stream. Resolved once, before
  // the first render, so the panel never flashes the defaults.
  const [deepLink] = useState(() =>
    applyDeepLink(makeConfig("shaka"), typeof window === "undefined" ? "" : window.location.search)
  );
  const [mode, setMode] = useState<"single" | "compare">("single");
  const [view, setView] = useState<"player" | "deploy">("player");
  // Which half of the player view is visible on phones (ignored from md up).
  const [mobileTab, setMobileTab] = useState<"config" | "player">("config");
  const [configA, setConfigA] = useState<PanelConfig>(() => deepLink.config);
  const [configB, setConfigB] = useState<PanelConfig>(() => makeConfig("dashjs"));

  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const playerA = usePlayer(videoA, "A");
  const playerB = usePlayer(videoB, "B");

  const players = { A: playerA, B: playerB };
  const configs = { A: configA, B: configB };
  const setConfigs = { A: setConfigA, B: setConfigB };

  const onMode = (m: "single" | "compare") => {
    if (m === "single" && playerB.running) playerB.stop();
    setMode(m);
  };

  const patchConfig = (panel: "A" | "B") => (patch: Partial<PanelConfig>) =>
    setConfigs[panel]((prev) => ({ ...prev, ...patch }));

  const handleLoad = (panel: "A" | "B") => {
    // On a phone the player lives behind a tab — reveal it when loading starts.
    setMobileTab("player");
    return players[panel].load(configs[panel].engine, toLoadConfig(configs[panel]));
  };

  const loadBoth = () => {
    handleLoad("A");
    handleLoad("B");
  };
  const stopBoth = () => {
    playerA.stop();
    playerB.stop();
  };
  const anyRunning = playerA.running || playerB.running;

  // `?autoplay=1` starts playback on its own — the point of a TV launcher, where
  // pressing Load with the remote every time is a chore. Runs once.
  const autoplayed = useRef(false);
  useEffect(() => {
    if (!deepLink.autoplay || autoplayed.current) return;
    autoplayed.current = true;
    setMobileTab("player");
    playerA.load(deepLink.config.engine, toLoadConfig(deepLink.config));
    // playerA.load is stable for the lifetime of the hook; deliberately not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLink]);

  // D-pad support. Chromium's spatial navigation only crosses between elements
  // that overlap on the perpendicular axis, and the sidebar controls sit far
  // above the player-panel buttons — so on a TV the remote could never reach the
  // left column. Left/Right explicitly jump between the two panes instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement as HTMLElement | null;
      if (!el) return;
      // Inside a text field or a select, arrows move the caret / the option —
      // unless it is a field useTvKeyboard has locked, which is just passed over.
      const tag = el.tagName;
      const editable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (editable && !el.hasAttribute("data-tv-locked")) return;
      const pane = el.closest("[data-pane]");
      const from = pane?.getAttribute("data-pane");
      const to = e.key === "ArrowLeft" ? "config" : "player";
      if (!pane || !from || from === to) return;
      // Only jump once there is nothing left to reach on that side within this
      // pane — otherwise Left on a row of tabs would leave the row instead of
      // moving to the previous tab.
      if (hasNeighbour(pane, el, e.key === "ArrowLeft" ? "left" : "right")) return;
      const target = document.querySelector<HTMLElement>(
        `[data-pane="${to}"] button:not([disabled]), [data-pane="${to}"] input, [data-pane="${to}"] select`
      );
      if (target) {
        e.preventDefault();
        setMobileTab(to); // on phones the target pane may be the hidden one
        target.focus();
        target.scrollIntoView({ block: "nearest" });
      }
    };
    // Capture phase: runs before the Tizen spatial-navigation polyfill, which
    // backs off once this has called preventDefault.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="flex min-h-[100dvh] flex-col md:h-[100dvh] md:min-h-0">
      <Header mode={mode} onMode={onMode} view={view} onView={setView} />

      {/* Mobile-only switcher: the sidebar and the player can't share a phone
          screen, so show one at a time. Hidden from md upwards. */}
      {view === "player" && (
        <div className="flex flex-shrink-0 border-b border-bd bg-sf1 md:hidden">
          {(["config", "player"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setMobileTab(t)}
              className={`flex-1 border-b-2 py-[10px] text-[12px] font-semibold uppercase tracking-[.06em] transition ${
                mobileTab === t
                  ? "border-ga text-ga"
                  : "border-transparent text-tx3"
              }`}
            >
              {t === "config" ? "⚙ Configuración" : "▶ Reproductor"}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-1 md:min-h-0 md:overflow-hidden">
        {/* Player view — kept mounted (hidden) so playback survives switching to Deploy */}
        <div
          className={
            view === "deploy"
              ? "hidden"
              : "flex flex-1 flex-col md:min-h-0 md:flex-row md:overflow-hidden"
          }
        >
        {/* Sidebar */}
        <div
          data-pane="config"
          className={`${
            mobileTab === "config" ? "flex" : "hidden"
          } w-full flex-col border-bd bg-sf1 md:flex md:min-h-0 md:w-[290px] md:flex-shrink-0 md:overflow-hidden md:border-r`}
        >
          {mode === "compare" && (
            <div className="flex flex-shrink-0 items-center gap-2 border-b border-bd px-2 py-2">
              <button
                onClick={loadBoth}
                className="flex-1 rounded-md bg-gradient-to-r from-ga to-gb py-2 text-[12px] font-semibold text-white transition hover:brightness-110"
                title="Cargar A y B a la vez"
              >
                ▶ Load A + B
              </button>
              <button
                onClick={stopBoth}
                disabled={!anyRunning}
                className="rounded-md border border-bd bg-sf2 px-3 py-2 text-[12px] font-semibold text-tx2 transition hover:border-bd2 hover:text-tx1 disabled:opacity-40"
                title="Parar ambos"
              >
                ■ Both
              </button>
            </div>
          )}
          <div
            className="md:flex-1 md:overflow-x-hidden md:overflow-y-auto"
            // overflow-x:hidden still allows PROGRAMMATIC scrolling: focusing the
            // long DRM licence field makes the browser scroll this column right to
            // reveal the caret, hiding the left edge with no scrollbar to get back.
            onScroll={(e) => {
              if (e.currentTarget.scrollLeft !== 0) e.currentTarget.scrollLeft = 0;
            }}
          >
            {mode === "compare" && (
              <div className="sticky top-0 z-10 border-b border-bd bg-sf2/95 px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[.06em] text-ga backdrop-blur">
                ● Player A
              </div>
            )}
            <ConfigPanel
              panel="A"
              config={configA}
              running={playerA.running}
              onChange={patchConfig("A")}
              onLoad={() => handleLoad("A")}
              onStop={playerA.stop}
            />
            {mode === "compare" && (
              <>
                <div className="sticky top-0 z-10 border-y border-bd bg-sf2/95 px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[.06em] text-gb backdrop-blur">
                  ● Player B
                </div>
                <ConfigPanel
                  panel="B"
                  config={configB}
                  running={playerB.running}
                  onChange={patchConfig("B")}
                  onLoad={() => handleLoad("B")}
                  onStop={playerB.stop}
                />
              </>
            )}
          </div>
        </div>

        {/* Panels — stacked on phones, side by side from md up */}
        <div
          data-pane="player"
          className={`${
            mobileTab === "player" ? "flex" : "hidden"
          } flex-1 flex-col md:flex md:min-h-0 md:flex-row md:overflow-hidden`}
        >
          <PlayerPanel
            panel="A"
            engine={configA.engine}
            version={configA.version}
            url={configA.url}
            net={toNetOverrides(configA.net)}
            player={playerA}
            videoRef={videoA}
            autotrace={deepLink.autotrace}
          />
          {mode === "compare" && (
            <PlayerPanel
              panel="B"
              engine={configB.engine}
              version={configB.version}
              url={configB.url}
              net={toNetOverrides(configB.net)}
              player={playerB}
              videoRef={videoB}
            />
          )}
        </div>
        </div>

        {view === "deploy" && <DeployPanel />}
      </div>
    </div>
  );
}
