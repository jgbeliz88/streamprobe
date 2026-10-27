// Static build of the StreamProbe UI for packaging inside a TV app.
//
// The TV runtime only exposes EME (DRM) to a secure origin, and http://<mac>
// is not one — file:// inside an installed app is. So the UI is exported
// (SP_TV_EXPORT=1, see next.config.mjs) and its root-relative /_next/ asset
// paths are rewritten to relative ones, which resolve next to index.html.
//
//   node scripts/tv-export.mjs [--force]
//
// Skips the build when the export is newer than every source file.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, ".next-tv");
const INDEX = path.join(OUT, "index.html");
const SOURCES = ["app", "components", "hooks", "lib", "next.config.mjs", "tailwind.config.ts", "package.json"];

function newest(p) {
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = st.mtimeMs;
  for (const f of readdirSync(p)) t = Math.max(t, newest(path.join(p, f)));
  return t;
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const force = process.argv.includes("--force");
const srcTime = Math.max(...SOURCES.map((s) => path.join(ROOT, s)).filter(existsSync).map(newest));
if (!force && existsSync(INDEX) && statSync(INDEX).mtimeMs > srcTime) {
  console.log("Build TV al día (.next-tv), no hace falta recompilar.");
  process.exit(0);
}

console.log("Compilando la UI estática para la TV…");
const r = spawnSync("npx", ["next", "build"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, SP_TV_EXPORT: "1" },
});
if (r.status !== 0) process.exit(r.status ?? 1);

let patched = 0;
for (const file of walk(OUT)) {
  const ext = path.extname(file);
  if (![".html", ".js", ".css"].includes(ext)) continue;
  const text = readFileSync(file, "utf8");
  let next = text;
  if (ext === ".html") {
    // Tags and the inline RSC payload (where the quotes are escaped).
    next = next.replaceAll('"/_next/', '"./_next/').replaceAll('\\"/_next/', '\\"./_next/');
  } else if (ext === ".css") {
    // Fonts: the stylesheet lives in _next/static/css/, the files in ../media/.
    next = next.replaceAll("url(/_next/static/media/", "url(../media/");
  } else {
    // webpack's public path (chunk loading) and the CSS links built at runtime.
    next = next.replaceAll('"/_next/"', '"./_next/"');
  }
  if (next !== text) {
    writeFileSync(file, next);
    patched++;
  }
}

const left = readFileSync(INDEX, "utf8").match(/[("]\/_next\//g);
if (left) {
  console.error(`✗ Quedan ${left.length} rutas /_next/ absolutas en index.html`);
  process.exit(1);
}
console.log(`✓ UI estática lista en .next-tv (${patched} ficheros con rutas relativas)`);
