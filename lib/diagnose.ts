import { fmtBps } from "./fmt";
import type { ChartMarker, MetricSample } from "./engines/types";

export type Level = "ok" | "info" | "warn" | "fail";
export type Verdict = "pass" | "warn" | "fail" | "none";

export interface Finding {
  level: Level;
  title: string;
  detail: string;
}

export interface Diagnosis {
  verdict: Verdict;
  findings: Finding[];
}

export interface DiagnoseInput {
  running: boolean;
  metrics: {
    join: number | null;
    bufN: number;
    bufMs: number;
    dropped: number;
    latency: number | null;
  };
  samples: MetricSample[];
  markers: ChartMarker[];
  events: { type: string; msg: string }[];
  manifests: { isMultiperiod?: boolean }[];
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Turn a session's raw signals into a PASS/WARN/FAIL verdict + findings.
 *  Rules encode the failure patterns this tool is built to catch. */
export function diagnoseSession(d: DiagnoseInput): Diagnosis {
  const f: Finding[] = [];

  if (!d.running && d.samples.length === 0) {
    return { verdict: "none", findings: [{ level: "info", title: "Sin sesión", detail: "Carga un stream para obtener el diagnóstico." }] };
  }

  // 1 — Startup / join time.
  const j = d.metrics.join;
  if (j == null) {
    f.push({ level: "warn", title: "Arranque sin medir", detail: "Aún no se ha renderizado el primer frame." });
  } else if (j < 1000) {
    f.push({ level: "ok", title: "Arranque rápido", detail: `${j} ms hasta el primer frame.` });
  } else if (j < 3000) {
    f.push({ level: "warn", title: "Arranque lento", detail: `${j} ms hasta el primer frame (objetivo < 1000 ms).` });
  } else {
    f.push({ level: "fail", title: "Arranque muy lento", detail: `${j} ms hasta el primer frame.` });
  }

  // 2 — Errors in the log.
  const errs = d.events.filter((e) => e.type === "error");
  if (errs.length) {
    f.push({ level: "fail", title: "Errores de reproducción", detail: `${errs.length} error(es): ${errs[0].msg.slice(0, 120)}` });
  }

  // 3 — Token / CDN auth (403, Shaka 1001, BAD_HTTP_STATUS).
  const authHit = d.events.find((e) => /\b403\b|BAD_HTTP_STATUS|error 1001|\b1001\b/i.test(e.msg));
  if (authHit) {
    f.push({
      level: "fail",
      title: "Posible fallo de token / CDN",
      detail: "Respuestas 403 / BAD_HTTP_STATUS: el token no se propaga a los hijos/segmentos, o falta Origin/Referer. Revisa la propagación de token y el proxy.",
    });
  }

  // 4 — Stalls / rebuffers.
  const stalls = d.markers.filter((m) => m.kind === "stall").length || d.metrics.bufN;
  if (stalls === 0) {
    f.push({ level: "ok", title: "Sin stalls", detail: "No hubo rebuffers durante la reproducción." });
  } else if (stalls <= 2) {
    f.push({ level: "warn", title: `${stalls} rebuffer(s)`, detail: `${d.metrics.bufMs} ms parado en total.` });
  } else {
    f.push({ level: "fail", title: `${stalls} rebuffers`, detail: `${d.metrics.bufMs} ms parado en total — experiencia degradada.` });
  }

  // 5 — ABR pinned low despite headroom.
  if (d.samples.length >= 8) {
    const brs = d.samples.map((s) => s.bitrate).filter((b) => b > 0);
    const bws = d.samples.map((s) => s.bw).filter((b) => b > 0);
    if (brs.length >= 6 && bws.length >= 6) {
      const medBr = median(brs);
      const medBw = median(bws);
      const ramped = Math.max(...brs) > Math.min(...brs) * 1.2;
      // Only flag genuinely low bitrate with headroom (the 528 kbps case), not a
      // high-but-flat bitrate that is simply the stream's top rendition.
      if (!ramped && medBr < 1_500_000 && medBw > medBr * 3) {
        f.push({
          level: "warn",
          title: "ABR clavado en calidad baja",
          detail: `Bitrate en ${fmtBps(medBr)} con ${fmtBps(medBw)} de ancho de banda disponible. Sospecha de latencia del proxy o de la región del CDN (p.ej. función serverless lejos del origen).`,
        });
      }
    }
  }

  // 6 — Multiperiod / period-boundary gaps.
  const multi = d.manifests.some((m) => m.isMultiperiod) || d.events.some((e) => /multiperiod/i.test(e.msg));
  const gapJump = d.events.some((e) => /gap jumped|gap[_ ]jump|salto de gap/i.test(e.msg));
  if (multi) {
    if (stalls > 0) {
      f.push({ level: "fail", title: "Stall en frontera de periodo", detail: "Parón en un cambio de periodo del multiperiodo — el fallo que estás persiguiendo." });
    } else {
      f.push({ level: "info", title: "Stream multiperiodo", detail: "El manifest tiene varios periodos; vigila las fronteras (buffer y bitrate) en la gráfica." });
    }
  } else if (gapJump) {
    f.push({ level: "warn", title: "Salto de gap (gap-jumping)", detail: "El player saltó un hueco en el buffer. Un player sin gap-jumping (una TV antigua) se quedaría parado aquí." });
  }

  // 7 — Dropped frames.
  if (d.metrics.dropped > 50) {
    f.push({ level: "warn", title: "Frames perdidos", detail: `${d.metrics.dropped} frames descartados — posible cuello de decodificación/rendimiento.` });
  }

  // Overall verdict = worst finding.
  const worst = f.reduce<Level>((acc, x) => {
    const rank = { ok: 0, info: 0, warn: 1, fail: 2 } as const;
    return rank[x.level] > rank[acc] ? x.level : acc;
  }, "ok");
  const verdict: Verdict = worst === "fail" ? "fail" : worst === "warn" ? "warn" : "pass";

  return { verdict, findings: f };
}
