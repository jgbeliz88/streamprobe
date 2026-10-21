"use client";

import { ENGINE_ORDER, ENGINES } from "@/lib/engines/registry";
import type { EngineId } from "@/lib/engines/types";

interface Props {
  panel: "A" | "B";
  engine: EngineId;
  version: string;
  onEngine: (id: EngineId) => void;
  onVersion: (v: string) => void;
}

export default function EngineSelector({
  panel,
  engine,
  version,
  onEngine,
  onVersion,
}: Props) {
  const selCls = panel === "A" ? "border-ga text-ga bg-ga/[.12]" : "border-gb text-gb bg-gb/[.12]";
  const meta = ENGINES[engine];
  const hasVersions = meta.versions.length > 1;

  return (
    <div>
      <div className="grid grid-cols-2 gap-[5px]">
        {ENGINE_ORDER.map((id) => {
          const m = ENGINES[id];
          const on = engine === id;
          return (
            <button
              key={id}
              onClick={() => onEngine(id)}
              className={`rounded-md border px-[5px] py-2 font-mono text-[10px] font-semibold leading-[1.4] transition-colors ${
                on
                  ? selCls
                  : "border-bd bg-sf2 text-tx2 hover:border-bd2 hover:text-tx1"
              }`}
            >
              {m.label.split("\n").map((line, i) => (
                <span key={i}>
                  {line}
                  {i === 0 && m.label.includes("\n") ? <br /> : null}
                </span>
              ))}
            </button>
          );
        })}
      </div>

      {hasVersions && (
        <div className="mt-[10px]">
          <label className="mb-[3px] block text-[11px] text-tx2">
            Version (bundled)
          </label>
          <select
            className="fsel w-full cursor-pointer rounded-[5px] border border-bd bg-sf2 px-[9px] py-[6px] text-xs text-tx1 outline-none focus:border-ga"
            value={version}
            onChange={(e) => onVersion(e.target.value)}
          >
            {meta.versions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
