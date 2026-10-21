"use client";

import type { Diagnosis, Level, Verdict } from "@/lib/diagnose";

const DOT: Record<Level, string> = {
  ok: "bg-ga",
  info: "bg-tx2",
  warn: "bg-warn",
  fail: "bg-err",
};

const BADGE: Record<Verdict, { text: string; cls: string }> = {
  pass: { text: "PASS", cls: "bg-ga/15 text-ga border-ga/40" },
  warn: { text: "WARN", cls: "bg-warn/15 text-warn border-warn/40" },
  fail: { text: "FAIL", cls: "bg-err/15 text-err border-err/40" },
  none: { text: "—", cls: "bg-sf2 text-tx3 border-bd" },
};

export default function VerdictView({ diagnosis }: { diagnosis: Diagnosis }) {
  const badge = BADGE[diagnosis.verdict];
  const counts = diagnosis.findings.reduce(
    (a, x) => ((a[x.level] = (a[x.level] || 0) + 1), a),
    {} as Record<Level, number>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Verdict banner */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-bd bg-sf1 px-3 py-[10px]">
        <div
          className={`rounded-[5px] border px-3 py-[5px] font-mono text-[15px] font-bold tracking-[.08em] ${badge.cls}`}
        >
          {badge.text}
        </div>
        <div className="flex flex-col">
          <span className="text-[11px] font-semibold uppercase tracking-[.08em] text-tx2">
            Veredicto de la sesión
          </span>
          <span className="font-mono text-[10px] text-tx3">
            {(counts.fail || 0)} fallos · {(counts.warn || 0)} avisos · {(counts.ok || 0)} correctos
          </span>
        </div>
      </div>

      {/* Findings */}
      <div className="flex flex-col divide-y divide-bd">
        {diagnosis.findings.map((f, i) => (
          <div key={i} className="flex gap-[10px] px-3 py-[9px]">
            <span className={`mt-[5px] h-[8px] w-[8px] flex-shrink-0 rounded-full ${DOT[f.level]}`} />
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-tx1">{f.title}</div>
              <div className="text-[11.5px] leading-[1.5] text-tx2">{f.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
