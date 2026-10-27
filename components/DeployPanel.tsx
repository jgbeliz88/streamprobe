"use client";

import { useEffect, useRef, useState } from "react";
import { buildLaunchUrl, type LaunchDrm } from "@/lib/deepLink";
import type { DrmSystem } from "@/lib/engines/types";

/** Interval baked into a TV's launch URL when auto-trace is ticked. */
const AUTOTRACE_DEFAULT = 30;

type Platform = "webos" | "tizen" | "androidtv";
type Action = "deploy" | "package" | "browser";

interface SavedDevice {
  id: string;
  name: string;
  platform: Platform;
  tvIp: string;
  /** Stream this TV should open on launch. Empty = just open StreamProbe. */
  streamUrl?: string;
  /** Start playing on its own, without a Load press on the remote. */
  autoplay?: boolean;
  /** Start with auto-trace on: the TV keeps its live trace on the Mac current. */
  autotrace?: boolean;
  /** DRM to preload, so the license never has to be typed with the remote. */
  drmSystem?: DrmSystem;
  licenseUrl?: string;
  certUrl?: string;
  /** License headers, one `Name: value` per line. */
  drmHeaders?: string;
}

/** The DRM fields a launch URL is built from (form or saved device). */
interface DrmFields {
  drmSystem?: DrmSystem;
  licenseUrl?: string;
  certUrl?: string;
  drmHeaders?: string;
}

const DRM_SYSTEMS: { id: DrmSystem; label: string }[] = [
  { id: "widevine", label: "Widevine" },
  { id: "playready", label: "PlayReady" },
  { id: "fairplay", label: "FairPlay" },
];

/** `Name: value` lines → header map (blank or colon-less lines are skipped). */
function parseHeaderLines(text?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

function toLaunchDrm(d: DrmFields): LaunchDrm | undefined {
  if (!d.drmSystem || !d.licenseUrl?.trim()) return undefined;
  return {
    system: d.drmSystem,
    licenseUrl: d.licenseUrl,
    certUrl: d.certUrl,
    headers: parseHeaderLines(d.drmHeaders),
  };
}

interface Tools {
  ares: boolean;
  tizen: boolean;
  sdb: boolean;
  adb: boolean;
  gradle: boolean;
}

interface Check {
  label: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail?: string;
  fix?: string;
}

interface Diagnosis {
  platform: Platform;
  tvIp: string;
  model?: string;
  checks: Check[];
}

const STATUS: Record<Check["status"], { mark: string; cls: string }> = {
  ok: { mark: "✓", cls: "border-ga/40 bg-ga/10 text-ga" },
  warn: { mark: "!", cls: "border-warn/40 bg-warn/10 text-warn" },
  fail: { mark: "✕", cls: "border-err/40 bg-err/10 text-err" },
  skip: { mark: "–", cls: "border-bd2 bg-sf2 text-tx3" },
};

const STORAGE_KEY = "sp-tv-devices";

const PLATFORMS: {
  id: Platform;
  os: string;
  glyph: string;
  brands: string;
  pkg: string;
  tool: keyof Tools | null;
}[] = [
  { id: "webos", os: "LG webOS", glyph: "wOS", brands: "LG", pkg: ".ipk · ares-cli", tool: "ares" },
  { id: "tizen", os: "Samsung Tizen", glyph: "Tz", brands: "Samsung", pkg: ".wgt · tizen/sdb", tool: "tizen" },
  {
    id: "androidtv",
    os: "Android TV / Google TV",
    glyph: "A",
    brands: "Sony · Philips · TCL · Xiaomi · Shield · Fire TV",
    pkg: ".apk WebView · gradle/adb",
    tool: "adb",
  },
];

function loadDevices(): SavedDevice[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export default function DeployPanel() {
  const [platform, setPlatform] = useState<Platform>("webos");
  const [tvIp, setTvIp] = useState("");
  const [macHost, setMacHost] = useState("");
  const [deviceName, setDeviceName] = useState("lgtv");
  const [webosNetcast, setWebosNetcast] = useState(false);
  // Off = the UI is packaged inside the app (file://), the only way the TV gives
  // DRM. On = old launcher that redirects to http://<mac>: reload picks up UI
  // changes, but no DRM.
  const [webosHosted, setWebosHosted] = useState(false);
  const [securityProfile, setSecurityProfile] = useState("");
  const [tools, setTools] = useState<Tools | null>(null);
  const [devices, setDevices] = useState<SavedDevice[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [streamUrl, setStreamUrl] = useState("");
  const [autoplay, setAutoplay] = useState(true);
  const [autotrace, setAutotrace] = useState(false);
  const [drmSystem, setDrmSystem] = useState<DrmSystem | "">("");
  const [licenseUrl, setLicenseUrl] = useState("");
  const [certUrl, setCertUrl] = useState("");
  const [drmHeaders, setDrmHeaders] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState("");
  const [browserUrl, setBrowserUrl] = useState("");
  const [diags, setDiags] = useState<Diagnosis[]>([]);
  const [checking, setChecking] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setDevices(loadDevices());
    fetch("/api/deploy")
      .then((r) => r.json())
      .then((j) => {
        setTools(j.tools);
        if (j.macHost) setMacHost(j.macHost);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const meta = PLATFORMS.find((p) => p.id === platform)!;
  const toolMissing =
    tools && meta.tool && !tools[meta.tool] ? meta.tool : null;

  const persist = (next: SavedDevice[]) => {
    setDevices(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  /** The URL to bake into a device's wrapper: dev server + its own config. */
  const launchUrlFor = (
    d: { streamUrl?: string; autoplay?: boolean; autotrace?: boolean } & DrmFields
  ) =>
    macHost
      ? buildLaunchUrl(macHost, {
          streamUrl: d.streamUrl,
          autoplay: d.autoplay,
          autotrace: d.autotrace ? AUTOTRACE_DEFAULT : undefined,
          drm: toLaunchDrm(d),
        })
      : "";

  /** The form's own settings, as a launch-URL source. */
  const formFields = {
    streamUrl,
    autoplay,
    autotrace,
    drmSystem: drmSystem || undefined,
    licenseUrl,
    certUrl,
    drmHeaders,
  };

  const saveDevice = () => {
    if (!tvIp.trim()) return;
    const name = prompt("Nombre para este dispositivo:", `${meta.os} · ${tvIp}`);
    if (!name) return;
    persist([
      ...devices.filter((d) => !(d.tvIp === tvIp && d.platform === platform)),
      {
        id: crypto.randomUUID(),
        name,
        platform,
        tvIp: tvIp.trim(),
        streamUrl: streamUrl.trim() || undefined,
        autoplay,
        autotrace,
        drmSystem: drmSystem || undefined,
        licenseUrl: licenseUrl.trim() || undefined,
        certUrl: certUrl.trim() || undefined,
        drmHeaders: drmHeaders.trim() || undefined,
      },
    ]);
  };

  const loadDevice = (d: SavedDevice) => {
    setPlatform(d.platform);
    setTvIp(d.tvIp);
    setStreamUrl(d.streamUrl ?? "");
    setAutoplay(!!d.autoplay);
    setAutotrace(!!d.autotrace);
    setDrmSystem(d.drmSystem ?? "");
    setLicenseUrl(d.licenseUrl ?? "");
    setCertUrl(d.certUrl ?? "");
    setDrmHeaders(d.drmHeaders ?? "");
  };

  const deleteDevice = (id: string) => {
    persist(devices.filter((d) => d.id !== id));
    setSelected((s) => s.filter((x) => x !== id));
  };

  const patchDevice = (id: string, patch: Partial<SavedDevice>) =>
    persist(devices.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  /** Run one deploy, streaming its output into the console. */
  const runOne = async (
    body: Record<string, unknown>,
    ctrl: AbortController,
    header?: string
  ): Promise<boolean> => {
    if (header) setLog((p) => p + header);
    const res = await fetch("/api/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const msg = await res.text();
      setLog((p) => p + `✗ ${res.status}: ${msg}\n`);
      return false;
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let ok = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      if (chunk.includes("✗ FALLÓ")) ok = false;
      setLog((prev) => prev + chunk);
    }
    return ok;
  };

  const run = async (action: Action) => {
    if (action === "browser") {
      setBrowserUrl(launchUrlFor(formFields));
      return;
    }
    if (running) return;
    setLog("");
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      // With devices ticked, deploy to each in turn — every TV needs its own
      // build, because the launch URL is embedded at package time.
      const targets = devices.filter((d) => selected.includes(d.id));
      if (targets.length && action === "deploy") {
        let okCount = 0;
        for (const [i, d] of targets.entries()) {
          const ok = await runOne(
            {
              platform: d.platform,
              action,
              tvIp: d.tvIp,
              macHost,
              launchUrl: launchUrlFor(d),
              deviceName,
              webosNetcast,
              webosHosted,
              securityProfile,
            },
            ctrl,
            `\n━━━ [${i + 1}/${targets.length}] ${d.name} · ${d.platform} · ${d.tvIp} ━━━\n`
          );
          if (ok) okCount++;
        }
        setLog((p) => p + `\n══ ${okCount}/${targets.length} despliegues correctos ══\n`);
      } else {
        await runOne({
          platform,
          action,
          tvIp,
          macHost,
          launchUrl: launchUrlFor(formFields),
          deviceName,
          webosNetcast,
          webosHosted,
          securityProfile,
        }, ctrl);
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setLog((p) => p + `\n✗ ${e?.message || e}\n`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  /** Ask the server what each TV still needs before a deploy can work. */
  const check = async (targets: { platform: Platform; tvIp: string }[]) => {
    const list = targets.filter((t) => t.tvIp.trim());
    if (!list.length || checking) return;
    setChecking(true);
    setDiags([]);
    for (const target of list) {
      let result: Diagnosis;
      try {
        const res = await fetch("/api/deploy/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...target, macHost, deviceName, securityProfile }),
        });
        if (!res.ok) throw new Error(await res.text());
        result = await res.json();
      } catch (e: any) {
        result = {
          ...target,
          checks: [{ label: "Diagnóstico", status: "fail", detail: e?.message || String(e) }],
        };
      }
      setDiags((d) => [...d, result]);
    }
    setChecking(false);
  };

  // Same targets as Deploy: the ticked TVs, or else the one in the form.
  const checkTargets = () => {
    const ticked = devices.filter((d) => selected.includes(d.id));
    return ticked.length ? ticked : [{ platform, tvIp }];
  };

  const label = "mb-[10px] text-[10px] font-semibold uppercase tracking-[.08em] text-tx3";
  const input =
    "w-full rounded-[5px] border border-bd bg-sf2 px-[9px] py-[7px] font-mono text-[12px] text-tx1 outline-none placeholder:text-tx3 focus:border-gb";

  return (
    <div className="flex-1 bg-bg md:overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-4 py-6 md:px-6 md:py-7">
        <div className="mb-6">
          <div className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.16em] text-ga">
            Deploy TV
          </div>
          <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-tx1">
            Instalar StreamProbe en una Smart TV
          </h1>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-[1.5] text-tx2">
            La app es una URL: el launcher es un envoltorio que la abre en el runtime real
            de la tele. Elige plataforma, mete la IP y el botón empaqueta, instala y lanza.
          </p>
        </div>

        {/* 1 · Platform */}
        <div className="mb-6">
          <div className={label}>1 · Plataforma de la TV</div>
          <div className="grid grid-cols-2 gap-[10px]">
            {PLATFORMS.map((p, i) => {
              const sel = platform === p.id;
              const missing = tools && p.tool && !tools[p.tool];
              return (
                <button
                  key={p.id}
                  onClick={() => setPlatform(p.id)}
                  className={`relative rounded-[9px] border p-3 text-left transition ${
                    i === 2 ? "col-span-2" : ""
                  } ${
                    sel
                      ? "border-ga bg-ga/[.08] shadow-[0_0_0_1px_rgba(29,185,83,.4)]"
                      : "border-bd2 bg-sf2 hover:border-bd"
                  }`}
                >
                  <span
                    className={`absolute right-3 top-3 h-[15px] w-[15px] rounded-full border-[1.5px] ${
                      sel ? "border-ga bg-ga shadow-[inset_0_0_0_3px_#0B0E16]" : "border-bd2 bg-bg"
                    }`}
                  />
                  {missing && (
                    <span className="absolute right-9 top-[11px] rounded border border-warn/40 bg-warn/10 px-[5px] py-[1px] font-mono text-[9px] uppercase tracking-[.08em] text-warn">
                      sin CLI
                    </span>
                  )}
                  <span className="flex items-center gap-2 text-[13.5px] font-semibold text-tx1">
                    <span
                      className={`grid h-[22px] w-[22px] place-items-center rounded-[6px] font-mono text-[11px] font-bold ${
                        sel ? "bg-ga text-bg" : "bg-sf3 text-tx1"
                      }`}
                    >
                      {p.glyph}
                    </span>
                    {p.os}
                  </span>
                  <span className="mt-1 block text-[11.5px] text-tx2">{p.brands}</span>
                  <span className="mt-[2px] block font-mono text-[10.5px] text-tx3">{p.pkg}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 2 · Network */}
        <div className="mb-6">
          <div className={label}>2 · Dirección de red</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-[5px] block text-[11px] text-tx2">IP de la TV</label>
              <input
                className={input}
                placeholder="192.168.1.149"
                value={tvIp}
                onChange={(e) => setTvIp(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-[5px] block text-[11px] text-tx2">Este Mac (dev server)</label>
              <input
                className={input}
                placeholder="192.168.1.176:3001"
                value={macHost}
                onChange={(e) => setMacHost(e.target.value)}
              />
            </div>
          </div>

          {/* Per-platform advanced */}
          <div className="mt-3 grid grid-cols-2 gap-3">
            {platform === "webos" && (
              <div>
                <label className="mb-[5px] block text-[11px] text-tx2">
                  Perfil ares (registrado)
                </label>
                <input
                  className={input}
                  placeholder="lgtv"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                />
              </div>
            )}
            {platform === "webos" && (
              <label className="flex items-start gap-2 self-end pb-[6px] text-[11px] leading-[1.4] text-tx2">
                <input
                  type="checkbox"
                  checked={webosNetcast}
                  onChange={(e) => setWebosNetcast(e.target.checked)}
                  className="mt-[2px] h-[13px] w-[13px] flex-shrink-0 accent-ga"
                />
                <span>
                  Modo NetCast (como Infinity)
                  <span className="block text-[10px] text-warn">
                    La tele no dejará escribir en los campos de texto
                  </span>
                </span>
              </label>
            )}
            {platform === "webos" && (
              <label className="col-span-2 flex items-start gap-2 text-[11px] leading-[1.4] text-tx2">
                <input
                  type="checkbox"
                  checked={webosHosted}
                  onChange={(e) => setWebosHosted(e.target.checked)}
                  className="mt-[2px] h-[13px] w-[13px] flex-shrink-0 accent-ga"
                />
                <span>
                  Cargar la UI desde el Mac (http) en vez de llevarla dentro de la app
                  <span className={`block text-[10px] ${webosHosted ? "text-warn" : "text-tx3"}`}>
                    {webosHosted
                      ? "Sin DRM: la tele solo da EME a un origen seguro, y http://<Mac> no lo es. Los cambios de la UI llegan con recargar."
                      : "La UI va empaquetada (file://, origen seguro → DRM OK). El Mac sigue siendo el servidor del proxy y las trazas, solo por la red local. Tras cambiar código, vuelve a hacer deploy."}
                  </span>
                </span>
              </label>
            )}
            {platform === "tizen" && (
              <div>
                <label className="mb-[5px] block text-[11px] text-tx2">
                  Perfil de certificado (opcional)
                </label>
                <input
                  className={input}
                  placeholder="streamprobe"
                  value={securityProfile}
                  onChange={(e) => setSecurityProfile(e.target.value)}
                />
              </div>
            )}
          </div>

          {/* Stream this device should open — becomes ?url= on its launch URL */}
          <div className="mt-3">
            <label className="mb-[5px] block text-[11px] text-tx2">
              Stream que abrirá esta tele (opcional)
            </label>
            <input
              className={input}
              placeholder="https://… — vacío = abre StreamProbe sin cargar nada"
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
            />
            <label className="mt-2 flex items-center gap-2 text-[11px] text-tx2">
              <input
                type="checkbox"
                checked={autoplay}
                onChange={(e) => setAutoplay(e.target.checked)}
                className="h-[13px] w-[13px] accent-ga"
              />
              Empezar a reproducir solo (sin pulsar Load con el mando)
            </label>
            <label className="mt-1 flex items-center gap-2 text-[11px] text-tx2">
              <input
                type="checkbox"
                checked={autotrace}
                onChange={(e) => setAutotrace(e.target.checked)}
                className="h-[13px] w-[13px] accent-ga"
              />
              Enviar las trazas al Mac solas, cada {AUTOTRACE_DEFAULT} s (traces/…_live.json)
            </label>

            {/* DRM — baked into the launch URL, so nothing is typed on the TV */}
            <div className="mt-3 rounded-[6px] border border-bd2 bg-sf2/50 p-[10px]">
              <div className="mb-[6px] flex items-center gap-2">
                <span className="text-[11px] text-tx2">DRM (opcional)</span>
                <select
                  className="rounded-[4px] border border-bd bg-sf2 px-[6px] py-[3px] font-mono text-[11px] text-tx1 outline-none focus:border-gb"
                  value={drmSystem}
                  onChange={(e) => setDrmSystem(e.target.value as DrmSystem | "")}
                >
                  <option value="">Sin DRM</option>
                  {DRM_SYSTEMS.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              {drmSystem && (
                <div className="flex flex-col gap-[6px]">
                  <input
                    className={input}
                    placeholder="URL de licencia (con su token, si lo lleva)"
                    value={licenseUrl}
                    onChange={(e) => setLicenseUrl(e.target.value)}
                  />
                  {drmSystem === "fairplay" && (
                    <input
                      className={input}
                      placeholder="URL del certificado FairPlay"
                      value={certUrl}
                      onChange={(e) => setCertUrl(e.target.value)}
                    />
                  )}
                  <textarea
                    className={`${input} min-h-[46px] resize-y`}
                    placeholder={"Cabeceras de licencia, una por línea (opcional)\nAuthorization: Bearer …"}
                    value={drmHeaders}
                    onChange={(e) => setDrmHeaders(e.target.value)}
                  />
                  <div className="text-[10px] leading-[1.4] text-warn">
                    Va dentro de la app: si el token caduca, hay que volver a hacer deploy.
                  </div>
                </div>
              )}
            </div>

            {macHost && (
              <div className="mt-2 break-all font-mono text-[10px] text-tx3">
                → {launchUrlFor(formFields)}
              </div>
            )}
          </div>

          {/* Saved devices: tick several to deploy a whole set in one go */}
          <div className="mt-4">
            <div className="mb-[6px] flex items-center gap-2">
              <span className="text-[11px] text-tx2">Mis teles</span>
              {devices.length > 0 && (
                <button
                  onClick={() =>
                    setSelected(selected.length === devices.length ? [] : devices.map((d) => d.id))
                  }
                  className="text-[10px] text-tx3 underline transition hover:text-tx1"
                >
                  {selected.length === devices.length ? "ninguna" : "todas"}
                </button>
              )}
              {tvIp.trim() && (
                <button
                  onClick={saveDevice}
                  className="ml-auto rounded-[20px] border border-dashed border-bd2 px-[10px] py-[3px] text-[11px] text-tx2 transition hover:border-ga hover:text-ga"
                >
                  + guardar la actual
                </button>
              )}
            </div>
            {devices.length === 0 ? (
              <div className="rounded-[6px] border border-dashed border-bd2 px-3 py-2 text-[11px] text-tx3">
                Ninguna guardada. Rellena plataforma, IP y stream, y pulsa «guardar la actual» —
                así puedes tener LG, Samsung y Android TV cada una con su stream y desplegarlas
                de una pasada.
              </div>
            ) : (
              <div className="flex flex-col gap-[6px]">
                {devices.map((d) => {
                  const on = selected.includes(d.id);
                  const pMeta = PLATFORMS.find((p) => p.id === d.platform);
                  return (
                    <div
                      key={d.id}
                      className={`rounded-[6px] border px-[10px] py-2 transition ${
                        on ? "border-ga/50 bg-ga/[.06]" : "border-bd2 bg-sf2"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setSelected((s) =>
                              e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id)
                            )
                          }
                          className="h-[13px] w-[13px] flex-shrink-0 accent-ga"
                        />
                        <button
                          onClick={() => loadDevice(d)}
                          className="min-w-0 flex-1 text-left"
                          title="Cargar esta tele en el formulario"
                        >
                          <span className="text-[12px] font-semibold text-tx1">{d.name}</span>
                          <span className="ml-2 font-mono text-[10px] text-tx3">
                            {pMeta?.glyph} · {d.tvIp}
                          </span>
                        </button>
                        <button
                          onClick={() => {
                            loadDevice(d);
                            check([d]);
                          }}
                          disabled={checking}
                          className="flex-shrink-0 rounded border border-bd2 px-[7px] py-[1px] text-[10px] text-tx2 transition hover:border-ga hover:text-ga disabled:opacity-40"
                          title="Comprobar qué le falta a esta tele"
                        >
                          comprobar
                        </button>
                        <button
                          onClick={() => deleteDevice(d.id)}
                          className="flex-shrink-0 text-tx3 transition hover:text-err"
                          title="Borrar"
                        >
                          ×
                        </button>
                      </div>
                      <input
                        className="mt-[6px] w-full rounded-[4px] border border-bd bg-bg px-[7px] py-[4px] font-mono text-[10px] text-tx2 outline-none placeholder:text-tx3 focus:border-gb"
                        placeholder="stream de esta tele (vacío = ninguno)"
                        value={d.streamUrl ?? ""}
                        onChange={(e) =>
                          patchDevice(d.id, { streamUrl: e.target.value || undefined })
                        }
                      />
                      <div className="mt-[4px] flex gap-[6px]">
                        <select
                          className="flex-shrink-0 rounded-[4px] border border-bd bg-bg px-[5px] py-[4px] font-mono text-[10px] text-tx2 outline-none focus:border-gb"
                          value={d.drmSystem ?? ""}
                          onChange={(e) =>
                            patchDevice(d.id, {
                              drmSystem: (e.target.value as DrmSystem) || undefined,
                            })
                          }
                        >
                          <option value="">sin DRM</option>
                          {DRM_SYSTEMS.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.label}
                            </option>
                          ))}
                        </select>
                        {d.drmSystem && (
                          <input
                            className="min-w-0 flex-1 rounded-[4px] border border-bd bg-bg px-[7px] py-[4px] font-mono text-[10px] text-tx2 outline-none placeholder:text-tx3 focus:border-gb"
                            placeholder="licencia de esta tele"
                            value={d.licenseUrl ?? ""}
                            onChange={(e) =>
                              patchDevice(d.id, { licenseUrl: e.target.value || undefined })
                            }
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="mb-5 flex flex-wrap items-center gap-[10px]">
          {!running ? (
            <button
              onClick={() => run("deploy")}
              className="rounded-md bg-ga px-[18px] py-[10px] text-[13px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(29,185,83,.8)] transition hover:brightness-110"
              title={
                selected.length
                  ? "Despliega en cada tele marcada, en secuencia"
                  : "Despliega en la tele del formulario"
              }
            >
              {selected.length > 1
                ? `▶ Deploy a ${selected.length} teles`
                : selected.length === 1
                  ? "▶ Deploy a la marcada"
                  : "▶ Deploy"}
            </button>
          ) : (
            <button
              onClick={stop}
              className="rounded-md border border-bd bg-sf2 px-[18px] py-[10px] text-[13px] font-semibold text-tx2 transition hover:border-bd2 hover:text-tx1"
            >
              ■ Parar
            </button>
          )}
          <button
            onClick={() => check(checkTargets())}
            disabled={checking || (!selected.length && !tvIp.trim())}
            className="rounded-md border border-bd2 bg-transparent px-[16px] py-[10px] text-[13px] font-medium text-tx2 transition hover:border-ga hover:text-ga disabled:opacity-40"
            title="Comprueba herramientas, red, modo desarrollador y certificado/clave de la tele"
          >
            {checking
              ? "Comprobando…"
              : selected.length > 1
                ? `Comprobar ${selected.length} teles`
                : "Comprobar"}
          </button>
          <button
            onClick={() => run("package")}
            disabled={running}
            className="rounded-md border border-bd2 bg-transparent px-[16px] py-[10px] text-[13px] font-medium text-tx2 transition hover:border-bd hover:text-tx1 disabled:opacity-40"
          >
            Solo empaquetar
          </button>
          <button
            onClick={() => run("browser")}
            className="rounded-md border border-bd2 bg-transparent px-[16px] py-[10px] text-[13px] font-medium text-tx2 transition hover:border-bd hover:text-tx1"
          >
            Abrir en navegador
          </button>
        </div>

        {diags.map((d, i) => (
          <DiagnosisCard
            key={`${d.platform}-${d.tvIp}-${i}`}
            diag={d}
            onClose={() => setDiags((all) => all.filter((_, j) => j !== i))}
          />
        ))}

        {toolMissing && (
          <div className="mb-4 rounded-[6px] border border-warn/30 bg-warn/[.07] px-[11px] py-[8px] text-[11.5px] leading-[1.5] text-warn">
            No encuentro <span className="font-mono">{toolMissing}</span> en el PATH de este Mac.
            Instálalo y arranca el dev server desde una terminal que lo tenga:
            <br />
            webOS → <span className="font-mono">npm i -g @webos-tools/cli</span> · Tizen → Tizen
            Studio (CLI + certificado Samsung) · Android TV →{" "}
            <span className="font-mono">brew install gradle</span> + Android SDK
            (platform-tools para <span className="font-mono">adb</span>).
          </div>
        )}

        {browserUrl && (
          <div className="mb-4 rounded-[6px] border border-bd bg-sf1 px-[11px] py-[9px] text-[12px] leading-[1.6] text-tx2">
            Abre esta URL en el navegador de la tele (cero empaquetado, pero corre en el
            navegador, no en el runtime de app):
            <div className="mt-1 select-all font-mono text-[13px] text-ga">{browserUrl}</div>
          </div>
        )}

        {/* Console */}
        <div className="overflow-hidden rounded-[9px] border border-bd bg-[#070A10]">
          <div className="flex items-center gap-2 border-b border-bd px-3 py-[7px] font-mono text-[10px] uppercase tracking-[.1em] text-tx2">
            <span
              className={`h-[6px] w-[6px] rounded-full ${
                running ? "animate-blink-med bg-ga" : "bg-tx3"
              }`}
            />
            Salida {running ? "· en curso" : ""}
          </div>
          <pre
            ref={logRef}
            className="max-h-[280px] overflow-auto px-[14px] py-3 font-mono text-[11.5px] leading-[1.7] text-tx1"
          >
            {log || <span className="text-tx3">La salida del deploy aparecerá aquí…</span>}
          </pre>
        </div>
      </div>
    </div>
  );
}

function DiagnosisCard({ diag, onClose }: { diag: Diagnosis; onClose: () => void }) {
  const failing = diag.checks.filter((c) => c.status === "fail").length;
  const warning = diag.checks.filter((c) => c.status === "warn").length;
  const meta = PLATFORMS.find((p) => p.id === diag.platform);
  return (
    <div className="mb-4 overflow-hidden rounded-[9px] border border-bd bg-sf1">
      <div className="flex items-center gap-3 border-b border-bd px-3 py-[9px]">
        <span
          className={`rounded-[20px] border px-[9px] py-[2px] text-[11px] font-semibold ${
            failing ? STATUS.fail.cls : warning ? STATUS.warn.cls : STATUS.ok.cls
          }`}
        >
          {failing
            ? `${failing} por arreglar`
            : warning
              ? "Lista, con avisos"
              : "Lista para desplegar"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-tx2">
          {meta?.os} · {diag.tvIp}
          {diag.model ? ` · ${diag.model}` : ""}
        </span>
        <button onClick={onClose} className="text-tx3 transition hover:text-tx1" title="Cerrar">
          ×
        </button>
      </div>
      <ul className="divide-y divide-bd">
        {diag.checks.map((c, i) => (
          <li key={i} className="flex gap-3 px-3 py-[9px]">
            <span
              className={`grid h-[18px] w-[18px] flex-shrink-0 place-items-center rounded-full border text-[10px] font-bold ${STATUS[c.status].cls}`}
            >
              {STATUS[c.status].mark}
            </span>
            <div className="min-w-0 flex-1 text-[12px] leading-[1.5]">
              <div className={c.status === "skip" ? "text-tx3" : "font-medium text-tx1"}>
                {c.label}
              </div>
              {c.detail && <div className="break-words font-mono text-[11px] text-tx2">{c.detail}</div>}
              {c.fix && (
                <div className={c.status === "fail" ? "mt-[2px] text-err" : "mt-[2px] text-warn"}>
                  → {c.fix}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
