import { type NextRequest } from "next/server";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { androidSdkDir, hasTool, lanIp, sdbDeviceName } from "@/lib/tvTools";

// Diagnosis for one TV: walks through everything a deploy needs (toolchain on
// this machine, the TV reachable, developer mode, pairing/keys/certificate) and
// says, for whatever is missing, how to fix it and where the guide covers it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Platform = "webos" | "tizen" | "androidtv";
type Status = "ok" | "warn" | "fail" | "skip";

interface Check {
  label: string;
  status: Status;
  detail?: string;
  /** What to do about a warn/fail, with the guide section that covers it. */
  fix?: string;
}

interface Body {
  platform: Platform;
  tvIp: string;
  /** "192.168.0.134:3001" — the address the TV should be pointed at. */
  macHost?: string;
  deviceName?: string;
  securityProfile?: string;
}

const GUIDE: Record<Platform, string> = {
  tizen: "samsungtv.md",
  webos: "lgtv.md",
  androidtv: "androidtv.md",
};

function tcpOpen(host: string, port: number, ms = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(ms, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function run(cmd: string, args: string[], timeout = 10000): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout });
  return { code: r.status ?? -1, out: `${r.stdout || ""}${r.stderr || ""}`.trim() };
}

/** A check that needs an earlier one to pass, listed greyed out until it does. */
const pending = (label: string): Check => ({
  label,
  status: "skip",
  detail: "Sin comprobar hasta que se arregle lo de arriba.",
});

const subnet = (ip: string) => ip.split(".").slice(0, 3).join(".");

/** Shared first checks: the toolchain on this machine, and the TV answering. */
async function basics(
  b: Body,
  tools: string[],
  port: number,
  install: string,
  checks: Check[]
): Promise<boolean> {
  const missing = tools.filter((t) => !hasTool(t));
  checks.push(
    missing.length
      ? {
          label: "Herramientas en este PC",
          status: "fail",
          detail: `No encuentro ${missing.join(", ")} en el PATH del servidor.`,
          fix: `${install} y arranca StreamProbe desde una terminal nueva (${GUIDE[b.platform]}, paso 1).`,
        }
      : { label: "Herramientas en este PC", status: "ok", detail: tools.join(" · ") }
  );

  const pc = (b.macHost || "").split(":")[0] || lanIp();
  if (pc && subnet(pc) !== subnet(b.tvIp)) {
    checks.push({
      label: "Misma red",
      status: "warn",
      detail: `Este PC es ${pc} y la tele ${b.tvIp}: parecen redes distintas.`,
      fix: "Pon el PC y la tele en la misma red. Una VPN también lo rompe.",
    });
  }

  const open = await tcpOpen(b.tvIp, port);
  // An LG that is on always answers its control API on 3000, so a closed 9922
  // there means developer mode is off (usually the 50 h session ran out), not
  // that the TV is unreachable.
  if (!open && b.platform === "webos" && (await tcpOpen(b.tvIp, 3000))) {
    checks.push({
      label: "Modo desarrollador",
      status: "fail",
      detail: `La tele está encendida, pero ${b.tvIp}:${port} está cerrado: el modo desarrollador no está activo.`,
      fix: "Abre la app Developer Mode: activa Dev Mode Status (se reinicia) o pulsa Extend Session Time. Si el passphrase ha cambiado, repite ares-novacom --getkey (lgtv.md, pasos 3 y 4).",
    });
    return false;
  }
  checks.push(
    open
      ? { label: "La tele responde", status: "ok", detail: `${b.tvIp}:${port} abierto` }
      : {
          label: "La tele responde",
          status: "fail",
          detail: `${b.tvIp}:${port} no contesta.`,
          fix:
            b.platform === "tizen"
              ? "Comprueba que está encendida y su IP (Ajustes → Conexión → Red → Estado de red), y que está en la misma red (samsungtv.md, paso 4)."
              : b.platform === "webos"
                ? "Comprueba que está encendida, la IP y que Developer Mode sigue activo: la sesión caduca a las ~50 h (lgtv.md, paso 3)."
                : "Comprueba que está encendida, la IP y que la depuración está activada (androidtv.md, paso 2).",
        }
  );
  return missing.length === 0 && open;
}

async function checkTizen(b: Body, checks: Check[]): Promise<string | undefined> {
  // The Samsung REST API answers on 8001 whenever the TV is on; 26101 only
  // with developer mode active, so probe the API first for a clearer verdict.
  const ok = await basics(b, ["tizen", "sdb"], 8001, "Instala Tizen Studio", checks);
  let model: string | undefined;

  if (checks.at(-1)?.status === "ok") {
    try {
      const res = await fetch(`http://${b.tvIp}:8001/api/v2/`, {
        signal: AbortSignal.timeout(3000),
      });
      const dev = (await res.json()).device ?? {};
      model = dev.modelName;
      const pc = (b.macHost || "").split(":")[0] || lanIp();
      if (String(dev.developerMode) !== "1") {
        checks.push({
          label: "Modo desarrollador",
          status: "fail",
          detail: "Desactivado.",
          fix: "Apps → App Settings → 12345 → On, con la IP de este PC → apágala del todo (samsungtv.md, paso 3).",
        });
      } else if (pc && dev.developerIP && dev.developerIP !== pc) {
        checks.push({
          label: "Modo desarrollador",
          status: "fail",
          detail: `Activo, pero la tele espera el PC ${dev.developerIP} y este PC es ${pc}.`,
          fix: `Cambia la Host PC IP a ${pc}: pon el modo en Off, apágala, vuelve a On con la IP nueva y apágala otra vez (samsungtv.md, paso 3).`,
        });
      } else {
        checks.push({
          label: "Modo desarrollador",
          status: "ok",
          detail: `Activo, apuntando a ${dev.developerIP || pc}`,
        });
      }
    } catch {
      checks.push({
        label: "Modo desarrollador",
        status: "warn",
        detail: "No he podido leer la configuración de la tele (API en el puerto 8001).",
      });
    }
  } else {
    checks.push(pending("Modo desarrollador"));
  }

  if (ok) {
    const dev = await tcpOpen(b.tvIp, 26101);
    if (!dev) {
      checks.push({
        label: "Conexión sdb",
        status: "fail",
        detail: "El puerto 26101 está cerrado.",
        fix: "Apaga la tele del todo (mantén pulsado el botón de encendido) para que se active el modo desarrollador.",
      });
    } else {
      run("sdb", ["connect", b.tvIp]);
      const name = sdbDeviceName(b.tvIp);
      checks.push(
        name !== b.tvIp
          ? { label: "Conexión sdb", status: "ok", detail: `Conectada como ${name}` }
          : {
              label: "Conexión sdb",
              status: "fail",
              detail: "El puerto responde pero sdb no conecta.",
              fix: "Suele ser la Host PC IP de la tele: tiene que ser la de este PC (samsungtv.md, paso 3).",
            }
      );
    }
  } else {
    checks.push(pending("Conexión sdb"));
  }

  checks.push(tizenCertificate(b.securityProfile));
  return model;
}

/** The signing profile the CLI will use, and whether Samsung would accept it. */
function tizenCertificate(wanted?: string): Check {
  const label = "Certificado Samsung";
  if (!hasTool("tizen")) return { label, status: "skip" };
  const cfg = run("tizen", ["cli-config", "-l"]).out;
  const file = cfg.match(/^profiles\.path=(.+)$/m)?.[1]?.trim();
  if (!file || !existsSync(file)) {
    return {
      label,
      status: "fail",
      detail: "El CLI de Tizen no tiene ningún perfil de certificado.",
      fix: "Crea el certificado Samsung en Certificate Manager y apunta el CLI a él (samsungtv.md, pasos 5 y 6).",
    };
  }
  const xml = readFileSync(file, "utf8");
  const name = wanted?.trim() || xml.match(/<profiles[^>]*\bactive="([^"]*)"/)?.[1] || "";
  const prof = xml.match(new RegExp(`<profile name="${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">([\\s\\S]*?)</profile>`))?.[1];
  if (!prof) {
    return {
      label,
      status: "fail",
      detail: `No hay ningún perfil "${name}" en ${file}.`,
      fix: "Escribe en «Perfil de certificado» el nombre del perfil que creaste (samsungtv.md, paso 5).",
    };
  }
  const distributor = prof.match(/distributor="1"[^>]*\bkey="([^"]*)"/)?.[1] || "";
  if (/tizen-distributor-signer/.test(distributor)) {
    return {
      label,
      status: "fail",
      detail: `El perfil "${name}" es autofirmado: la tele lo rechazará al 28 % (Invalid certificate chain).`,
      fix: "Crea uno de tipo Samsung en Certificate Manager y apunta el CLI a él (samsungtv.md, pasos 5 y 6).",
    };
  }
  if (!distributor || !existsSync(distributor)) {
    return {
      label,
      status: "fail",
      detail: `Al perfil "${name}" le falta el certificado de distribuidor.`,
      fix: "Vuelve a crearlo en Certificate Manager (samsungtv.md, paso 5).",
    };
  }
  // Certificate Manager leaves the list of TVs (DUIDs) the cert is valid for
  // next to the distributor key.
  const profileXml = path.join(path.dirname(distributor), "device-profile.xml");
  const duids = existsSync(profileXml)
    ? [...readFileSync(profileXml, "utf8").matchAll(/<TestDevice>([^<]+)<\/TestDevice>/g)].length
    : 0;
  return {
    label,
    status: "ok",
    detail: `Perfil "${name}"${duids ? ` · válido para ${duids} tele${duids > 1 ? "s" : ""} (DUID)` : ""}`,
  };
}

async function checkWebos(b: Body, checks: Check[]): Promise<string | undefined> {
  const ok = await basics(
    b,
    ["ares-package", "ares-install", "ares-setup-device"],
    9922,
    "Instala el CLI con npm i -g @webos-tools/cli",
    checks
  );
  const name = b.deviceName?.trim() || "lgtv";

  let dev: { host?: string; privateKey?: { openSsh?: string } } | undefined;
  try {
    const list = JSON.parse(
      readFileSync(path.join(homedir(), ".webos", "tv", "novacom-devices.json"), "utf8")
    );
    dev = list.find((d: { name?: string }) => d.name === name);
  } catch {
    /* no ares config yet */
  }
  const key = dev?.privateKey?.openSsh;
  if (!dev) {
    checks.push({
      label: "Tele registrada en ares",
      status: "fail",
      detail: `No hay ningún dispositivo "${name}".`,
      fix: "Regístrala y descarga su clave con ares-setup-device y ares-novacom --getkey (lgtv.md, paso 4).",
    });
    return;
  }
  if (!key || !existsSync(path.join(homedir(), ".ssh", key))) {
    checks.push({
      label: "Tele registrada en ares",
      status: "fail",
      detail: `"${name}" está registrada pero sin clave de desarrollador.`,
      fix: "Activa Key Server en la app Developer Mode y ejecuta ares-novacom --getkey (lgtv.md, paso 4).",
    });
    return;
  }
  checks.push({
    label: "Tele registrada en ares",
    status: "ok",
    detail:
      dev.host === b.tvIp
        ? `"${name}" con su clave`
        : `"${name}" con su clave · registrada con ${dev.host}; el Deploy la cambiará a ${b.tvIp}`,
  });

  // Only ask the TV itself when the registration already points at it: the
  // check must not rewrite the ares config behind the user's back.
  if (!ok) {
    checks.push(pending("Conexión con ares"));
    return;
  }
  if (dev.host !== b.tvIp) return;
  const info = run("ares-device", ["-i", "-d", name], 15000);
  if (info.code !== 0) {
    checks.push({
      label: "Conexión con ares",
      status: "fail",
      detail: info.out.split("\n").slice(-2).join(" ") || "ares-device no conecta.",
      fix: "Suele ser la clave caducada: Extend en Developer Mode y repite ares-novacom --getkey (lgtv.md, paso 4).",
    });
    return;
  }
  const model = info.out.match(/modelName\s*:\s*(.+)/)?.[1]?.trim();
  checks.push({ label: "Conexión con ares", status: "ok", detail: model || "Conectada" });
  return model;
}

async function checkAndroid(b: Body, checks: Check[]): Promise<string | undefined> {
  const ok = await basics(
    b,
    ["adb", "gradle"],
    5555,
    "Instala gradle y android-platform-tools con Homebrew",
    checks
  );
  const sdk = androidSdkDir();
  checks.push(
    sdk
      ? { label: "Android SDK", status: "ok", detail: sdk }
      : {
          label: "Android SDK",
          status: "fail",
          detail: "No encuentro el Android SDK.",
          fix: "brew install --cask android-commandlinetools y sdkmanager \"platforms;android-34\" \"build-tools;34.0.0\" (androidtv.md, paso 1).",
        }
  );
  if (!ok) {
    checks.push(pending("Conexión adb"));
    return;
  }

  const target = `${b.tvIp}:5555`;
  run("adb", ["connect", target]);
  const state =
    run("adb", ["devices"])
      .out.split("\n")
      .map((l) => l.trim().split(/\s+/))
      .find((c) => c[0] === target)?.[1] ?? "";
  if (state !== "device") {
    checks.push({
      label: "Conexión adb",
      status: "fail",
      detail: state === "unauthorized" ? "Sin autorizar." : `Estado: ${state || "sin conexión"}.`,
      fix:
        state === "unauthorized"
          ? "Acepta en la tele el aviso «¿Permitir la depuración USB?», marcando Permitir siempre (androidtv.md, paso 3)."
          : "Desactiva y vuelve a activar la depuración en la tele (androidtv.md, paso 2).",
    });
    return;
  }
  const prop = (k: string) => run("adb", ["-s", target, "shell", "getprop", k]).out;
  const model = prop("ro.product.model");
  checks.push({
    label: "Conexión adb",
    status: "ok",
    detail: `Autorizada · Android ${prop("ro.build.version.release")}`,
  });
  return model || undefined;
}

export async function POST(req: NextRequest) {
  const b = (await req.json()) as Body;
  if (!b?.tvIp?.trim() || !GUIDE[b.platform]) {
    return new Response("Falta la plataforma o la IP de la TV", { status: 400 });
  }
  b.tvIp = b.tvIp.trim();
  const checks: Check[] = [];
  const model =
    b.platform === "tizen"
      ? await checkTizen(b, checks)
      : b.platform === "webos"
        ? await checkWebos(b, checks)
        : await checkAndroid(b, checks);
  return Response.json({ platform: b.platform, tvIp: b.tvIp, model, checks });
}
