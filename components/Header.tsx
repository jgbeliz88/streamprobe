"use client";

interface Props {
  mode: "single" | "compare";
  onMode: (m: "single" | "compare") => void;
  view: "player" | "deploy";
  onView: (v: "player" | "deploy") => void;
}

export default function Header({ mode, onMode, view, onView }: Props) {
  return (
    <div className="flex h-[50px] flex-shrink-0 items-center justify-between border-b border-bd bg-sf1 px-[18px]">
      <div className="flex items-center gap-[9px] font-mono text-sm font-semibold tracking-[-0.02em]">
        <div className="h-2 w-2 animate-blink-slow rounded-full bg-ga shadow-[0_0_6px_#1DB953]" />
        StreamProbe
      </div>
      <div className="flex items-center gap-2 md:gap-[14px]">
        <span className="hidden font-mono text-[10px] tracking-[.06em] text-tx3 lg:inline">
          by AgileTV · DASH · HLS · DRM
        </span>
        {view === "player" && (
          <div className="flex rounded-md border border-bd bg-sf2 p-[2px]">
            {(["single", "compare"] as const).map((m) => (
              <button
                key={m}
                onClick={() => onMode(m)}
                className={`rounded px-[9px] py-[5px] text-xs font-medium transition md:px-[14px] ${
                  mode === m ? "bg-ga text-white" : "bg-transparent text-tx2"
                }`}
              >
                {/* Short labels on phones, full ones from md up */}
                <span className="md:hidden">{m === "single" ? "1" : "A/B"}</span>
                <span className="hidden md:inline">
                  {m === "single" ? "Single" : "Compare A/B"}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex rounded-md border border-bd bg-sf2 p-[2px]">
          {(["player", "deploy"] as const).map((v) => (
            <button
              key={v}
              onClick={() => onView(v)}
              className={`rounded px-[9px] py-[5px] text-xs font-medium transition md:px-[14px] ${
                view === v ? "bg-gb text-white" : "bg-transparent text-tx2"
              }`}
            >
              <span className="md:hidden">{v === "player" ? "▶" : "TV"}</span>
              <span className="hidden md:inline">
                {v === "player" ? "Player" : "Deploy TV"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
