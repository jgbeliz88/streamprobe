"use client";

import { useState } from "react";
import EngineSelector from "./EngineSelector";
import DrmConfig from "./DrmConfig";
import Toggle from "./Toggle";
import { ENGINES, PRESETS, type Preset } from "@/lib/engines/registry";
import { DEVICE_PRESETS } from "@/lib/deviceEmu";
import { pressable } from "@/lib/tv";
import type {
  AdvancedConfig,
  EngineId,
  UiNetConfig,
  PanelConfig,
  UiDrmConfig,
} from "@/lib/engines/types";
import { apiUrl } from "@/lib/apiBase";

interface Props {
  panel: "A" | "B";
  config: PanelConfig;
  running: boolean;
  onChange: (patch: Partial<PanelConfig>) => void;
  onLoad: () => void;
  onStop: () => void;
}

// presets shown per panel (A gets shaka/apple/akamai, B gets dashjs/apple)
const PRESET_KEYS: Record<"A" | "B", string[]> = {
  A: ["shaka-demo", "apple-hls", "akamai-live"],
  B: ["dashjs-demo", "apple-hls"],
};

export default function ConfigPanel({
  panel,
  config,
  running,
  onChange,
  onLoad,
  onStop,
}: Props) {
  const [advOpen, setAdvOpen] = useState(false);
  const [verify, setVerify] = useState<Record<string, string> | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [netStash, setNetStash] = useState<UiNetConfig | null>(null);
  const isA = panel === "A";
  const btnLoad = isA ? "bg-ga" : "bg-gb";
  const focusCls = isA ? "focus:border-ga" : "focus:border-gb";
  const meta = ENGINES[config.engine];
  const showShaka = config.engine === "shaka";

  const setAdvanced = (patch: Partial<AdvancedConfig>) =>
    onChange({ advanced: { ...config.advanced, ...patch } });
  const setDrm = (patch: Partial<UiDrmConfig>) =>
    onChange({ drm: { ...config.drm, ...patch } });
  const setNet = (patch: Partial<UiNetConfig>) =>
    onChange({ net: { ...config.net, ...patch } });
  const setDai = (patch: Partial<PanelConfig["dai"]>) =>
    onChange({ dai: { ...config.dai, ...patch } });
  const isDai = config.engine === "gamdai";
  const netActive =
    !!config.net.origin.trim() ||
    !!config.net.referer.trim() ||
    !!config.net.userAgent.trim() ||
    config.net.headers.some((h) => h.key.trim());

  // One-click proxy off/on: clears Origin/Referer/UA (proxy off) stashing them,
  // and restores them on re-enable. Use "off" for non-Mediaset / CORS streams.
  const toggleProxy = () => {
    if (netActive) {
      setNetStash({ ...config.net });
      setNet({ origin: "", referer: "", userAgent: "", headers: [] });
    } else {
      setNet(
        netStash ?? {
          origin: "https://www.mediasetinfinity.es",
          referer: "https://www.mediasetinfinity.es/",
          userAgent: "",
          headers: [],
        }
      );
    }
  };

  const verifyHeaders = async () => {
    setVerifying(true);
    setVerify(null);
    try {
      const qs = new URLSearchParams({ debug: "1" });
      if (config.net.origin.trim()) qs.set("o", config.net.origin.trim());
      if (config.net.referer.trim()) qs.set("r", config.net.referer.trim());
      if (config.net.userAgent.trim()) qs.set("ua", config.net.userAgent.trim());
      const extra: Record<string, string> = {};
      for (const h of config.net.headers) {
        const k = h.key.trim();
        if (k) extra[k] = h.value.trim();
      }
      if (Object.keys(extra).length) qs.set("h", JSON.stringify(extra));
      const res = await fetch(apiUrl(`/api/proxy?${qs.toString()}`));
      const j = await res.json();
      setVerify(j.injected || {});
    } catch (e: any) {
      setVerify({ error: e?.message || String(e) });
    } finally {
      setVerifying(false);
    }
  };

  const applyPreset = (p: Preset) => {
    const nextVersion = ENGINES[p.engine].versions[0];
    onChange({ engine: p.engine, url: p.url, version: nextVersion });
  };

  const pickEngine = (id: EngineId) =>
    onChange({ engine: id, version: ENGINES[id].versions[0] });

  const presets: Preset[] = PRESET_KEYS[panel]
    .map((k) => PRESETS.find((p) => p.key === k))
    .filter(Boolean) as Preset[];

  return (
    <div>
      {/* Engine */}
      <div className="border-b border-bd px-4 py-[14px]">
        <div className="mb-[10px] text-[10px] font-semibold uppercase tracking-[.08em] text-tx3">
          Engine
        </div>
        <EngineSelector
          panel={panel}
          engine={config.engine}
          version={config.version}
          onEngine={pickEngine}
          onVersion={(v) => onChange({ version: v })}
        />
        <div className="mt-2 text-[10px] text-tx3">
          {meta.formats.map((f) => f.toUpperCase()).join(" · ")} · DRM:{" "}
          {meta.drm.join(", ")}
        </div>
      </div>

      {/* Device emulation (Shaka platform detection) */}
      {showShaka && (
        <div className="border-b border-bd px-4 py-[14px]">
          <div className="mb-[8px] flex items-center gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-tx3">
              Device emulation
            </div>
            {config.deviceUserAgent.trim() && (
              <span className="rounded bg-warn/20 px-[6px] py-[1px] font-mono text-[9px] font-semibold text-warn">
                TV UA
              </span>
            )}
          </div>
          <div className="mb-[9px]">
            <select
              className="fsel w-full cursor-pointer rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] text-xs text-tx1 outline-none focus:border-ga"
              value={
                DEVICE_PRESETS.some((p) => p.ua === config.deviceUserAgent)
                  ? config.deviceUserAgent
                  : "__custom__"
              }
              onChange={(e) => {
                if (e.target.value !== "__custom__")
                  onChange({ deviceUserAgent: e.target.value });
              }}
            >
              {DEVICE_PRESETS.map((p) => (
                <option key={p.label} value={p.ua}>
                  {p.label}
                </option>
              ))}
              <option value="__custom__">Custom (below)</option>
            </select>
          </div>
          <div className="mb-[7px]">
            <label className="mb-[3px] block text-[11px] text-tx2">
              User-Agent (exact)
            </label>
            <textarea
              rows={3}
              placeholder="Paste your device's exact User-Agent…"
              className={`w-full resize-y rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[10px] leading-[1.4] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
              value={config.deviceUserAgent}
              onChange={(e) => onChange({ deviceUserAgent: e.target.value })}
            />
          </div>
          <div className="text-[9px] leading-[1.5] text-tx3">
            Overrides <span className="text-tx2">navigator.userAgent</span> so Shaka&apos;s
            platform detection (Tizen/webOS) takes the TV code paths. <b>Reload the
            page after changing</b> for a clean switch. Paste the device&apos;s exact UA
            (mitele logs it: &quot;User Agent: …&quot;) for best fidelity. The engine log
            shows the platform Shaka detected.
          </div>
        </div>
      )}

      {/* Stream URL / GAM DAI request */}
      <div className="border-b border-bd px-4 py-[14px]">
        <div className="mb-[10px] text-[10px] font-semibold uppercase tracking-[.08em] text-tx3">
          {isDai ? "GAM DAI (SSAI)" : "Stream URL"}
        </div>
        {isDai ? (
          <div className="mb-[9px] flex flex-col gap-[8px]">
            <label className="block">
              <span className="mb-[3px] block text-[11px] text-tx2">Asset key (live)</span>
              <input
                type="text"
                placeholder="asset key de GAM"
                className={`w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
                value={config.dai.assetKey}
                onChange={(e) => setDai({ assetKey: e.target.value })}
              />
            </label>
            <div className="flex gap-2">
              <label className="flex-1">
                <span className="mb-[3px] block text-[11px] text-tx2">API key (opcional)</span>
                <input
                  type="text"
                  placeholder="vacío si no aplica"
                  className={`w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
                  value={config.dai.apiKey}
                  onChange={(e) => setDai({ apiKey: e.target.value })}
                />
              </label>
              <label>
                <span className="mb-[3px] block text-[11px] text-tx2">Formato</span>
                <select
                  className="fsel cursor-pointer rounded-[5px] border border-bd bg-sf2 px-[9px] py-[7px] text-[11px] text-tx1 outline-none focus:border-gb"
                  value={config.dai.format}
                  onChange={(e) => setDai({ format: e.target.value as "hls" | "dash" })}
                >
                  <option value="hls">HLS</option>
                  <option value="dash">DASH</option>
                </select>
              </label>
            </div>
            <div className="text-[9px] leading-[1.5] text-tx3">
              Pide el stream cosido a GAM vía IMA DAI SDK, lo reproduce y loguea los eventos de anuncio
              (ad breaks, cuartiles, cuepoints) en la pestaña <span className="text-tx2">SCTE-35</span>.
              Si el stream lleva <b className="text-tx2">DRM</b> (típico en live/MPD), actívalo en la
              sección <b className="text-tx2">DRM</b> de abajo (system + license URL).
            </div>
          </div>
        ) : (
          <div className="mb-[9px]">
            <input
              type="text"
              placeholder="https://…"
              className={`w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
              value={config.url}
              onChange={(e) => onChange({ url: e.target.value })}
            />
          </div>
        )}
        {!running ? (
          <button
            onClick={onLoad}
            className={`w-full rounded-md py-2 text-[13px] font-semibold text-white transition hover:brightness-110 ${btnLoad}`}
          >
            {isDai ? "▶ Pedir stream a GAM" : "▶ Load stream"}
          </button>
        ) : (
          <button
            onClick={onStop}
            className="w-full rounded-md border border-bd bg-sf2 py-2 text-[13px] font-semibold text-tx2 transition hover:border-bd2 hover:text-tx1"
          >
            ■ Stop
          </button>
        )}
      </div>

      {/* DRM */}
      <DrmConfig panel={panel} drm={config.drm} onChange={setDrm} />

      {/* Network / CDN headers */}
      <div className="border-b border-bd px-4 py-[14px]">
        <div className="mb-[8px] flex items-center gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-tx3">
            Network / CDN headers
          </div>
          {netActive && (
            <span className="rounded bg-warn/20 px-[6px] py-[1px] font-mono text-[9px] font-semibold text-warn">
              PROXY ON
            </span>
          )}
          <button
            onClick={toggleProxy}
            className={`ml-auto rounded-[4px] border px-[8px] py-[2px] font-mono text-[10px] transition ${
              netActive
                ? "border-warn/40 bg-warn/10 text-warn hover:bg-warn/20"
                : "border-bd bg-sf2 text-tx2 hover:border-ga hover:text-ga"
            }`}
            title={
              netActive
                ? "Vaciar Origin/Referer/UA → proxy OFF (para streams no-Mediaset / con CORS)"
                : "Restaurar Origin/Referer → proxy ON (necesario para Mediaset)"
            }
          >
            {netActive ? "Desactivar proxy" : "Activar proxy"}
          </button>
        </div>
        <div className="mb-[9px]">
          <label className="mb-[3px] block text-[11px] text-tx2">Origin</label>
          <input
            type="text"
            placeholder="https://app.example.com"
            className={`w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
            value={config.net.origin}
            onChange={(e) => setNet({ origin: e.target.value })}
          />
        </div>
        <div className="mb-[9px]">
          <label className="mb-[3px] block text-[11px] text-tx2">Referer</label>
          <input
            type="text"
            placeholder="https://app.example.com/player"
            className={`w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
            value={config.net.referer}
            onChange={(e) => setNet({ referer: e.target.value })}
          />
        </div>
        <div className="mb-[7px]">
          <label className="mb-[3px] block text-[11px] text-tx2">User-Agent</label>
          <input
            type="text"
            placeholder="MyDevice/1.0 (Model; OS 1.0)"
            className={`w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
            value={config.net.userAgent}
            onChange={(e) => setNet({ userAgent: e.target.value })}
          />
        </div>
        <div className="mb-[7px] mt-2 text-[10px] font-semibold uppercase tracking-[.08em] text-tx3">
          Cabeceras extra
        </div>
        <div className="mb-[7px] flex flex-col gap-[5px]">
          {config.net.headers.map((h) => (
            <div
              key={h.id}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_22px] items-center gap-1"
            >
              <input
                type="text"
                placeholder="X-Header"
                className="w-full min-w-0 rounded-[4px] border border-bd bg-sf2 px-[7px] py-1 font-mono text-[10px] text-tx1 outline-none"
                value={h.key}
                onChange={(e) =>
                  setNet({
                    headers: config.net.headers.map((x) =>
                      x.id === h.id ? { ...x, key: e.target.value } : x
                    ),
                  })
                }
              />
              <input
                type="text"
                placeholder="valor"
                className="w-full min-w-0 rounded-[4px] border border-bd bg-sf2 px-[7px] py-1 font-mono text-[10px] text-tx1 outline-none"
                value={h.value}
                onChange={(e) =>
                  setNet({
                    headers: config.net.headers.map((x) =>
                      x.id === h.id ? { ...x, value: e.target.value } : x
                    ),
                  })
                }
              />
              <button
                onClick={() =>
                  setNet({ headers: config.net.headers.filter((x) => x.id !== h.id) })
                }
                className="flex h-[22px] w-[22px] items-center justify-center rounded-[4px] border border-bd text-tx2 hover:border-err hover:text-err"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={() =>
            setNet({
              headers: [
                ...config.net.headers,
                { id: Date.now(), key: "", value: "" },
              ],
            })
          }
          className="mb-[9px] rounded-md border border-bd bg-sf2 px-[10px] py-1 text-[11px] text-tx2 hover:border-bd2 hover:text-tx1"
        >
          + Añadir cabecera
        </button>
        <div className="text-[9px] leading-[1.5] text-tx3">
          The browser forbids setting these from JS, so filled fields route media
          requests through a local proxy that injects them. Adds a hop — affects
          join-time/bandwidth metrics. Leave empty for direct playback.
        </div>
        <button
          onClick={verifyHeaders}
          disabled={verifying}
          className="mt-2 rounded-md border border-bd bg-sf2 px-[10px] py-1 text-[11px] text-tx2 transition hover:border-bd2 hover:text-tx1 disabled:opacity-50"
        >
          {verifying ? "Verifying…" : "Verify headers"}
        </button>
        {verify && (
          <div className="mt-2 rounded-[5px] border border-bd bg-bg px-[9px] py-[6px] font-mono text-[10px] leading-[1.6]">
            {"error" in verify ? (
              <span className="text-err">{verify.error}</span>
            ) : Object.keys(verify).length === 0 ? (
              <span className="text-tx3">No headers injected (all fields empty)</span>
            ) : (
              <>
                <div className="mb-1 text-tx3">Proxy injects on every request:</div>
                {Object.entries(verify).map(([k, v]) => (
                  <div key={k} className="break-all text-tx1">
                    <span className="text-[#22d3ee]">{k}:</span> {v}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Advanced */}
      <div className="border-b border-bd px-4 py-[14px]">
        <div
          className="flex cursor-pointer select-none items-center justify-between"
          {...pressable(() => setAdvOpen((o) => !o))}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[.08em] text-tx3">
            Advanced
          </div>
          <span className="text-[11px] text-tx3">{advOpen ? "▾" : "▸"}</span>
        </div>
        {advOpen && (
          <div className="mt-[10px]">
            {showShaka && (
              <>
                <div className="mb-[8px] flex items-center justify-between rounded-[5px] border border-ga/30 bg-ga/[.06] px-[9px] py-2">
                  <span className="text-[11px] text-tx1">
                    Match TV (Shaka defaults)
                  </span>
                  <Toggle
                    checked={config.advanced.matchTv}
                    onChange={(v) => setAdvanced({ matchTv: v })}
                  />
                </div>
                {config.advanced.matchTv && (
                  <div className="mb-[10px] text-[9px] leading-[1.5] text-tx3">
                    Running Shaka like the SmartTV app: default config + DRM only,
                    no buffer/stall/ABR tuning. Turn off to experiment with settings.
                  </div>
                )}
                {/* Works regardless of Match TV: pins the top rendition. */}
                <div className="mb-[8px] flex items-center justify-between rounded-[5px] border border-gb/30 bg-gb/[.06] px-[9px] py-2">
                  <span className="text-[11px] text-tx1">
                    Fijar calidad máxima (sin ABR)
                  </span>
                  <Toggle
                    checked={config.advanced.lockMaxQuality}
                    onChange={(v) => setAdvanced({ lockMaxQuality: v })}
                  />
                </div>
                {config.advanced.lockMaxQuality && (
                  <div className="mb-[10px] text-[9px] leading-[1.5] text-tx3">
                    Desactiva el ABR y clava la rendición de mayor bitrate — no baja de
                    calidad. Ojo: si la banda no da, provocará rebuffering en vez de bajar.
                  </div>
                )}
              </>
            )}
            <div
              className={
                showShaka && config.advanced.matchTv
                  ? "pointer-events-none opacity-40"
                  : ""
              }
            >
            <div className="mb-[9px]">
              <label className="mb-[3px] block text-[11px] text-tx2">
                Buffer goal (s)
              </label>
              <input
                type="number"
                min={1}
                max={60}
                className="w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none focus:border-ga"
                value={config.advanced.bufferGoal}
                onChange={(e) =>
                  setAdvanced({ bufferGoal: parseFloat(e.target.value) || 10 })
                }
              />
            </div>
            <div className="mb-[9px]">
              <label className="mb-[3px] block text-[11px] text-tx2">
                Rebuffer goal (s)
              </label>
              <input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                className="w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none focus:border-ga"
                value={config.advanced.rebufferGoal}
                onChange={(e) =>
                  setAdvanced({ rebufferGoal: parseFloat(e.target.value) || 2 })
                }
              />
            </div>
            <div className="mb-[9px]">
              <label className="mb-[3px] block text-[11px] text-tx2">
                Preferred audio lang
              </label>
              <input
                type="text"
                placeholder="es, en, it…"
                className={`w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
                value={config.advanced.audioLang}
                onChange={(e) => setAdvanced({ audioLang: e.target.value })}
              />
            </div>
            {showShaka && (
              <div>
                <div className="mt-[6px] flex items-center justify-between">
                  <span className="text-[11px] text-tx2">
                    returnToEndOfLiveWindow
                  </span>
                  <Toggle
                    checked={config.advanced.returnToLiveWindow}
                    onChange={(v) => setAdvanced({ returnToLiveWindow: v })}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-tx2">
                    stalledMinimumDurationSec
                  </span>
                  <input
                    type="number"
                    min={0.1}
                    max={10}
                    step={0.1}
                    className="w-[60px] rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none focus:border-ga"
                    value={config.advanced.stalledMinDuration}
                    onChange={(e) =>
                      setAdvanced({
                        stalledMinDuration: parseFloat(e.target.value) || 1,
                      })
                    }
                  />
                </div>
              </div>
            )}
            </div>
          </div>
        )}
      </div>

      {/* Presets */}
      <div className="border-b border-bd px-4 py-[14px]">
        <div className="mb-[10px] text-[10px] font-semibold uppercase tracking-[.08em] text-tx3">
          Quick presets
        </div>
        <div className="flex flex-col gap-[5px]">
          {presets.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p)}
              className="w-full rounded-[5px] border border-bd bg-sf2 px-[10px] py-[7px] text-left font-mono text-[10px] text-tx2 transition hover:border-ga hover:text-ga"
            >
              <div className="mb-[1px] font-semibold text-tx1">{p.name}</div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[9px] text-tx3">
                {p.urlShort}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
