# TV launchers — run StreamProbe on a real Smart TV

Thin "hosted app" wrappers that open StreamProbe (served from your PC) inside the
TV's native web runtime — so Shaka runs on the **real device MSE / Chromium**, the
highest-fidelity way to reproduce multiperiod bugs. Same pattern the Mitele (goya)
app uses.

Two targets: **LG webOS** (`webos/`) and **Samsung Tizen** (`tizen/`).

> **Nuevo — pestaña «Deploy TV» en la app.** No hace falta usar los comandos a mano: abre StreamProbe,
> pulsa **Deploy TV** en la cabecera, elige plataforma, mete la IP de la TV y dale a **Deploy**. La app
> reescribe la URL del launcher, empaqueta, instala y lanza, y te enseña la salida en vivo. Los pasos de
> abajo son la referencia / el fallback (y siguen siendo necesarios para el **registro inicial** del
> dispositivo: `ares-setup-device` + dev key en webOS, perfil de certificado en Tizen). Android TV llegará
> en una fase 2 (aparece en gris).

## 0. Reach StreamProbe on your LAN (both targets)

The **dev server you already run** listens on all interfaces, so the TV can use it
directly — **no build, no second server**, and it does NOT disturb the browser session
you already have open. (Do **not** run `npm run build`: it overwrites `.next` and would
kill the running dev server.)

The launchers already point at this machine's dev server:
`http://192.168.0.135:3001`. Make sure the TV is on the same Wi-Fi. If your PC IP or
port change, edit the redirect URL in both `webos/index.html` and `tizen/index.html`.

> The desktop tab and the TV are independent clients of the same server — they don't
> interfere with each other.

---

## LG webOS (slightly easier — no manual certificate)

1. **CLI**: `npm i -g @webosose/ares-cli`
2. **Developer Mode on the TV**: install the *Developer Mode* app from the LG Content
   Store, turn it on, note the IP + passphrase.
3. **Register the TV**: `ares-setup-device` (add the TV IP), then get the dev key:
   `ares-novacom --device <name> --getkey` (enter the passphrase).
4. **Package**: `ares-package tv-launchers/webos`
   → produces `com.streamprobe.app_1.0.0_all.ipk`
5. **Install**: `ares-install --device <name> com.streamprobe.app_1.0.0_all.ipk`
6. **Launch**: `ares-launch --device <name> com.streamprobe.app`

## Samsung Tizen (needs a certificate profile)

1. Install **Tizen Studio** (with the TV extension) or the `tizen` CLI.
2. **Certificate**: in Certificate Manager create a Samsung profile (Author +
   Distributor — needs a Samsung account). This is the fiddly part vs webOS.
3. **Developer Mode on the TV**: Smart Hub → Apps → scroll down to **App Settings** →
   type `12345` (not in the apps grid) → Developer Mode ON → enter your PC's IP. Then
   **cold power-cycle the TV**, or port 26101 stays shut.
4. **Connect**: `sdb connect <TV-IP>`
5. **Package**: `tizen package -t wgt -s <your-profile> -o <abs-out> -- <abs-src>` →
   `StreamProbe.wgt`. Paths must be **absolute** (the CLI resolves them against its own
   install dir), and point it at a copy, not the working tree — it signs in place. Skip
   `tizen build-web`: it exits non-zero on an Eclipse class it can't load outside the IDE.
6. **Install / run**: `tizen install -n StreamProbe.wgt -t <device-name>` — the name from
   `sdb devices`, not the IP.

A self-signed profile is **not** enough: the TV rejects it with `Invalid certificate chain
with certificate in signature`. The Samsung certificate in step 2 is unavoidable. Until you
have it, open `http://<your-ip>:3001` in the TV's own browser — same Tizen Chromium.

---

## Difficulty

Comparable. **webOS is a touch easier** — `ares` handles signing with the dev key, no
manual certificate. **Tizen** needs a Samsung Author+Distributor certificate profile.
Both require Developer Mode enabled on the TV and the PC on the same network.

## Matching the Infinity app runtime (webOS)

`webos/appinfo.json` uses `"trustLevel": "netcast"` — the same value the Mitele/Infinity
webOS app uses — so StreamProbe runs in a container as close as possible to the real
app (privileges/capabilities), not just the more capable Internet browser. Running it as
an **installed app** (not the browser) is what exercises the constrained app-runtime
media pipeline (memory / MSE) where multiperiod issues actually appear.

## Caveats

- **Cleartext HTTP**: newer webOS/Tizen may block an app loading `http://`. If the
  redirect fails, either serve StreamProbe over **HTTPS** (a self-signed cert is
  enough), or just open the URL in the TV's built-in **browser** (zero packaging).
- **Old Chromium**: on very old TVs the Next bundle may use unsupported syntax — lower
  the `browserslist` target if the page is blank.
- The header **proxy** (`/api/proxy`) runs on your PC, so the TV can use it too.
- Once open, everything works on the device: SCTE-35, periods, Buffer, gap/stall — and
  Shaka reports the real platform in the Events log.
