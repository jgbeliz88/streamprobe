"use client";

import Toggle from "./Toggle";
import type { DrmSystem, UiDrmConfig } from "@/lib/engines/types";

interface Props {
  panel: "A" | "B";
  drm: UiDrmConfig;
  onChange: (patch: Partial<UiDrmConfig>) => void;
}

let hdrSeq = 1;

const SYSTEMS: { value: DrmSystem; label: string }[] = [
  { value: "widevine", label: "Widevine — Chrome / Firefox" },
  { value: "playready", label: "PlayReady — Edge / IE" },
  { value: "fairplay", label: "FairPlay — Safari" },
];

export default function DrmConfig({ panel, drm, onChange }: Props) {
  const focusCls = panel === "A" ? "focus:border-ga" : "focus:border-gb";

  const setHeader = (id: number, field: "key" | "value", val: string) => {
    onChange({
      headers: drm.headers.map((h) => (h.id === id ? { ...h, [field]: val } : h)),
    });
  };
  const addHeader = () =>
    onChange({ headers: [...drm.headers, { id: hdrSeq++, key: "", value: "" }] });
  const removeHeader = (id: number) =>
    onChange({ headers: drm.headers.filter((h) => h.id !== id) });

  return (
    <div className="border-b border-bd px-4 py-[14px]">
      <div className="mb-[10px] text-[10px] font-semibold uppercase tracking-[.08em] text-tx3">
        DRM
      </div>

      <div className="mb-[10px] flex items-center justify-between">
        <span className="text-xs text-tx2">Enable DRM</span>
        <Toggle checked={drm.enabled} onChange={(v) => onChange({ enabled: v })} />
      </div>

      {drm.enabled && (
        <div>
          <div className="mb-[9px]">
            <label className="mb-[3px] block text-[11px] text-tx2">System</label>
            <select
              className={`fsel w-full min-w-0 cursor-pointer rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] text-xs text-tx1 outline-none ${focusCls}`}
              value={drm.system}
              onChange={(e) => onChange({ system: e.target.value as DrmSystem })}
            >
              {SYSTEMS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mb-[9px]">
            <label className="mb-[3px] block text-[11px] text-tx2">
              License server URL
            </label>
            <input
              type="text"
              placeholder="https://license.server/…"
              className={`w-full min-w-0 rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
              value={drm.licenseUrl}
              onChange={(e) => onChange({ licenseUrl: e.target.value })}
            />
          </div>

          {drm.system === "fairplay" && (
            <div className="mb-[9px]">
              <label className="mb-[3px] block text-[11px] text-tx2">
                Certificate URL (FairPlay)
              </label>
              <input
                type="text"
                placeholder="https://…fps.cer"
                className={`w-full min-w-0 rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
                value={drm.certUrl}
                onChange={(e) => onChange({ certUrl: e.target.value })}
              />
            </div>
          )}

          {drm.system === "fairplay" && (
            <div className="mb-[9px]">
              <label className="mb-[3px] block text-[11px] text-tx2">
                Content ID (FairPlay, opcional)
              </label>
              <input
                type="text"
                placeholder="p.ej. free_to_air_channels — vacío = usar el KID del skd"
                className={`w-full min-w-0 rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] font-mono text-[11px] text-tx1 outline-none placeholder:text-tx3 ${focusCls}`}
                value={drm.contentId}
                onChange={(e) => onChange({ contentId: e.target.value })}
              />
            </div>
          )}

          <div className="mb-[7px] mt-2 text-[10px] font-semibold uppercase tracking-[.08em] text-tx3">
            Custom license headers
          </div>
          <div className="mb-[7px] flex flex-col gap-[5px]">
            {drm.headers.map((h) => (
              <div
                key={h.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_22px] items-center gap-1"
              >
                <input
                  type="text"
                  placeholder="X-Header"
                  className="w-full min-w-0 rounded-[4px] border border-bd bg-sf2 px-[7px] py-1 font-mono text-[10px] text-tx1 outline-none"
                  value={h.key}
                  onChange={(e) => setHeader(h.id, "key", e.target.value)}
                />
                <input
                  type="text"
                  placeholder="value"
                  className="w-full min-w-0 rounded-[4px] border border-bd bg-sf2 px-[7px] py-1 font-mono text-[10px] text-tx1 outline-none"
                  value={h.value}
                  onChange={(e) => setHeader(h.id, "value", e.target.value)}
                />
                <button
                  onClick={() => removeHeader(h.id)}
                  className="flex h-[22px] w-[22px] items-center justify-center rounded-[4px] border border-bd text-tx2 hover:border-err hover:text-err"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={addHeader}
            className="rounded-md border border-bd bg-sf2 px-[10px] py-1 text-[11px] text-tx2 hover:border-bd2 hover:text-tx1"
          >
            + Add header
          </button>
        </div>
      )}
    </div>
  );
}
