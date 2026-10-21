# codigo_stv — Contexto completo (StreamProbe + bug multiperiod Infinity + testing en Smart TV)

Documento único con **todo el contexto** del proyecto, para retomarlo en el futuro sin perder nada.

---

## 0. Quién / qué / para qué

- **Usuario**: AgileTV, trabaja en **players de Smart TV para Mediaset (mitele / Infinity OTT)**.
  Foco: problemas de **DASH multiperiod + SCTE-35 con Shaka Player** en Smart TVs (LG webOS, Samsung Tizen).
- **StreamProbe** = herramienta Next.js que construimos en `~/Documents/Javi/Multiplayer` para
  **probar/depurar reproducción** entre engines y versiones, y así **reproducir el bug de multiperiod**
  de la app Infinity.

---

## 1. StreamProbe (la herramienta)

Next.js 14 (App Router, TypeScript, Tailwind), portada desde un `streamprobe.html` de un archivo.

**Engines** (bundleados por npm con alias, `import()` dinámico, selector de versión):
- **Shaka**: **4.13.25** (default), 4.16.39
- **dash.js**: 4.7.4, 4.5.2, 3.2.2
- **hls.js**: 1.5.20, 1.4.14, 1.2.9
- Native, AVPlayer (Safari nativo), ExoPlayer (stub)

**Features construidas**:
- Single + Compare A/B (A/B no funciona en la TV: un solo decoder por hardware).
- Métricas en vivo: join time, buffering, bitrate, **live latency**, dropped frames.
- Logs por pestañas: **Events / ABR / SCTE-35 / Buffer / Network / Manifest**, con botón **Clear** por pestaña.
- Autoplay con fallback muted.
- **Selección de audio y subtítulos** (bajo el vídeo, `components/PlayerPanel.tsx` `TrackBar`): desplegables de
  pista de **Audio** (idioma/canales) y **Subtítulos** (con opción **Off**). Por engine vía
  `EngineController.selectAudio/selectText` + callback `onTracks`: Shaka (`selectAudioLanguage` /
  `selectTextTrack`+`setTextTrackVisibility`), hls.js (`audioTrack`/`subtitleTrack`), dash.js
  (`setCurrentTrack`/`enableText`), native (`video.audioTracks`/`textTracks`; audio solo en Safari).
- **DRM** Widevine / PlayReady / FairPlay.
- **Engine GAM DAI (SSAI)** (`lib/engines/dai.ts`, engine `gamdai`): integra el **IMA DAI SDK** de Google
  (cargado de `imasdk.googleapis.com`). En ConfigPanel, con el engine `gamdai`, se mete **asset key** (live) o
  **content source + video ID** (VOD) + formato (HLS/DASH); pide el stream cosido a GAM, lo reproduce
  (hls.js para HLS / Shaka para DASH), **reenvía la metadata temporizada** (ID3 en HLS, emsg en DASH) al
  `StreamManager`, y loguea los **eventos de anuncio** (ad breaks, cuartiles, cuepoints) en la pestaña SCTE-35.
  Default prellenado con el sample VOD público de Google (contentSourceId 2528370 / tears-of-steel).
  ⚠ Sin verificar en navegador con un asset real de GAM (el SDK no corre headless).
- **Proxy de cabeceras CDN** (`app/api/proxy/route.ts`): el navegador prohíbe fijar Origin/Referer/User-Agent,
  así que el proxy los inyecta en servidor y los devuelve como `x-sp-sent-*` (botón **Verify** + `hdr✓` en Network).
  **Añade un salto → afecta a las métricas** (opt-in: solo si rellenas algún campo).
- **Lista de manifests**: captura cada MPD (single/multiperiod badge) + **tabla de periods** (id/start/dur/codecs,
  ⚠gap, ⤳ cambio de codec, duración derivada del SegmentTimeline).
- **Check de consistencia de timestamps (conversión multiperiod→one-period)** (`lib/manifest.ts`:
  `extractTimeline` vídeo+audio, `checkContinuity`; columna "timeline (media)" con líneas V/A + filas de costura
  en la tabla de periods): extrae los bordes del SegmentTimeline de **vídeo y audio** (timescale, PTO, primer `t`,
  fin del último segmento en tiempo de presentación) y verifica que los `t`/`d` sean **monótonos y sin
  huecos/solapes**. Detecta: (1) **salto de timestamps dentro de un period** (`internalBreaks`) — el fallo típico
  al aplanar multiperiod→one-period cuando el `t` no continúa tras la publi; (2) **discontinuidad en la costura**
  entre periods (hueco/solape de vídeo o audio, cambio de timescale, o cambio de **familia** de codec avc1→hvc1
  —ignora cambios de perfil dentro de avc1); (3) **desalineo vídeo/audio** (`vaStartSkewSec`/`vaEndSkewSec`).
  Badges resumen + alerta **en vivo** en el log SCTE (de-dupada). Validado con jsdom contra el MPD real +
  sintéticos (cosido limpio, cosido malo con salto de 71.68s, audio desalineado 0.5s).
- **Visor del bloque SegmentTimeline**: en la tabla de periods, **pinchar un period** despliega su bloque
  `SegmentTimeline` de vídeo y audio — las filas crudas `<S t d r>` (el parser guarda `timeline.entries`) con
  los derivados: nº de segmentos (r+1), duración/seg, y el span en tiempo de presentación (inicio→fin). Marca
  en rojo la fila donde el `t` **salta** (no continúa del segmento anterior). `t` implícito se señala con `*`.
- **Instrumentación SCTE-35** (Shaka: `emsg` + `timelineregion`).
- **Eventos gap/stall** de Shaka (`gapjumped` / `stalldetected`) con buffered ranges.
- **Panel Buffer en vivo** (rangos, gaps, buffer-ahead, behind-live-edge).
- **Match TV mode** (Shaka con **defaults**, solo `drm.servers`, como mitele; toggle ON por defecto).
- **Device emulation** (spoof de `navigator.userAgent` a Tizen/webOS para que la detección de plataforma de
  Shaka entre por el camino de la TV — **solo escritorio**; en la TV real dejar **None**, usa el UA real).
- **Pestaña Deploy TV** (`components/DeployPanel.tsx` + `app/api/deploy/route.ts`): menú dentro de la app para
  instalar StreamProbe en una tele. Eliges **plataforma** (webOS / Tizen; **Android TV en gris, fase 2**),
  metes la **IP de la TV a mano** + la del Mac (auto-detectada por `os.networkInterfaces`), y el botón
  **empaqueta + instala + lanza** ejecutando en servidor `ares-*` (webOS) o `sdb`/`tizen` (Samsung), con la
  salida **en vivo** en una consola. Reescribe la URL del launcher (`tv-launchers/<plat>/index.html`) → única
  fuente de verdad (antes webos y tizen tenían IPs distintas hardcodeadas). Guarda dispositivos en localStorage.
  El GET de la route detecta qué CLIs hay instalados y avisa (badge "sin CLI"). Botón **Abrir en navegador**
  como plan B para teles sin sideload. **Verificado**: webOS empaqueta el `.ipk` OK (ares instalado);
  Tizen sin verificar en local (no hay `tizen` CLI en el Mac).

**Dev server**: `npm run dev -- -p 3001`.
⚠ **Editar código con `next dev` corriendo puede dejar el server en 404** (Fast Refresh) → reiniciarlo.

**Defaults actuales**: engine Shaka 4.13.25, Match TV ON, URL de Mediaset (clear DASH, token que caduca
~2026-08-05) `https://fast.mediasetinfinity.es/mitele-comedia.isml/ctv.mpd?hdnts=...`, Origin `www.mediasetinfinity.es`.

**Docs del repo**:
- `README.md` — herramienta base.
- `DEBUG-SCTE35-MULTIPERIOD.md` — add-on SCTE-35 + periods (incluye "cómo quitarlo").
- `config-tv-mitele.md` — modo Match TV + análisis de goya.
- `codigo_stv.md` — este documento.
- `tv-launchers/` — launchers webOS/Tizen + `dist/*.ipk`.

---

## 2. El bug que investigamos (multiperiod en Infinity)

**Síntoma**: contenido DASH **multiperiod** se **congela** en Smart TVs con la app **Infinity** (Mediaset).
Observado en la LG: **live latency sube a ~30s y la imagen se congela**. Stream **en claro (sin DRM)**.
El player de CTV **no inserta ads** y **no consume** los SCTE-35 (pero el MPD los lleva, y Shaka los parsea igual).

**Hechos confirmados (el usuario me corrigió varias veces):**
- Infinity OTT usa **Shaka** en webOS (NO dash.js). Versión dicha: **4.13.25**, pero luego vio **4.16.38** →
  **la versión exacta de Shaka de Infinity sigue sin confirmar** (pregunta abierta).
- En StreamProbe (misma LG, mismo Shaka, misma versión) **NO reproduce** en el **navegador**.
- Descartado: device (misma LG), engine (ambos Shaka), versión (igual). Descartada la hipótesis del
  ad-break/reload (el player de CTV no mete ads).

**Diferencias que faltan por igualar (por qué no reproduce en StreamProbe):**
1. **Runtime de app vs navegador** — Infinity corre en el **runtime de app** de webOS (menos memoria, MSE/flags
   distintos) vs el navegador Internet (más capaz). → por eso instalamos StreamProbe **como app** (sección 4).
2. **La `configure()` de Shaka de Infinity** — no la tenemos; StreamProbe usa defaults (Match TV). **Mayor incógnita.**
3. **Presión de memoria** — Infinity es una OTT completa; el multiperiod suele romper por `QUOTA_EXCEEDED`.

**Hipótesis de trabajo**: gap/discontinuidad o cambio de codec en la frontera del period que Chrome de
escritorio salta (gap-jumping) pero el MSE viejo de la TV no → stall. Mirar en StreamProbe **Events**
(`GAP JUMPED` / `STALL detected` / código de error de Shaka) y **Buffer** (gap / buffer-ahead 0) al cruzar la frontera.

**Preguntas abiertas / próximos pasos:**
1. Confirmar la **versión exacta de Shaka de Infinity** (¿4.13.25 o 4.16.38?).
2. Conseguir la **`player.configure()` de Infinity** (el usuario dijo que no tiene el código del player).
3. Confirmar si el **30s + congelado** es el bug real o un **artefacto del proxy/LAN** → probar con **Origin vacío**
   (directo a la CDN, sin proxy). Si sin proxy va fluido y con proxy se congela → es el proxy/red.

---

## 3. Proyecto de referencia: goya / mitele

`~/Downloads/euw1-mes-dm-goya-2.25.1` = **mitele-react v2.25.1** (app SmartTV de Mediaset, React/webpack).

- Engine por device en `src/common/device/info/<device>.js`: **webOS usa dash.js 4.5.2** (o HTML5/OIPF),
  Tizen usa **AVPlayer nativo** + dash.js. **Shaka NO está cableado aquí** (solo tech suelto). PERO la app
  **Infinity real usa Shaka** en webOS → build distinta/más nueva que esta goya 2.25.1. **No extrapolar de goya.**
- Su tech Shaka (`playerpoc/mediaPlayer/shaka-player/index.jsx`): **mínima** — `new shaka.Player(video)`, autoplay,
  solo `drm.servers`, **sin config de streaming** (defaults). Inspiró el modo **Match TV**.
- Su dash.js: SCTE-35 por `urn:scte:scte35:2014:xml+bin` (solo sin DRM), `withCredentials` en todos los tipos,
  `setProtectionData` priority 0, sin `updateSettings`.
- Sus launchers Tizen/webOS (`launchers/MiteleTizen/config.xml`, `launchers/MiteleWebos/appinfo.json`) son
  envoltorios de redirección con `trustLevel: "netcast"` — copiamos ese patrón en `tv-launchers/`.

---

## 4. Ejecutar / depurar en la LG webOS (runbook)

Corremos StreamProbe **como app instalada** en la LG (modelo **55QNED93A6A**, webOS SDK 10.3.1) para el runtime real.

### Arquitectura
Los `.ipk` son **envoltorios finos** (`index.html` que redirige a una URL; corre en el WebView del runtime de app).

```
[TV LG]  app instalada (WebView, runtime webOS, trustLevel netcast)
   ├─ com.streamprobe.app  →  http://192.168.1.176:3001   (Next dev server en el Mac)
   │                              Shaka corre en el MSE REAL de la LG
   │                              media por /api/proxy (inyecta Origin) → CDN
   └─ com.goya.acano2      →  https://d26x698ddzee0y.cloudfront.net/goya/acano2/webos/index.html
                                  (build de goya hosteado; NO depende del Mac)
```

### Entorno actual (valores reales — cambian con DHCP, verificar)
| | |
|---|---|
| Mac (dev server) | **192.168.1.176 : 3001** |
| TV LG | **192.168.1.149** · modelo 55QNED93A6A · webOS SDK 10.3.1 |
| Device ares | **`lgtv`** → `prisoner@192.168.1.149:9922` |
| CLI | **`@webos-tools/cli`** (webOS TV — trae `ares-novacom`). NO `@webosose/ares-cli` (OSE, no lo trae; chocan) |
| Apps | `com.streamprobe.app` (→ Mac :3001) · `com.goya.acano2` (→ CloudFront) |

> Mac y TV en la **misma WiFi/subred** (`192.168.1.x`). VPN corporativa o redes distintas → no se ven.

### Preparar la TV (una vez)
1. LG Content Store → instalar **Developer Mode** (requiere **cuenta LG**, no Google; verificar email).
2. Developer Mode → login → **Dev Mode ON** (reinicia).
3. Reabrir → **Key Server ON**. Apuntar IP + passphrase (rota; sesión caduca ~50h → "Extend").

### Registrar TV + key (una vez / al renovar)
```bash
npm i -g @webos-tools/cli
ares-setup-device -a lgtv -i "host=192.168.1.149" -i "port=9922" -i "username=prisoner"
ares-novacom -d lgtv --getkey            # teclea el passphrase → guarda ~/.ssh/lgtv_webos
ares-setup-device -m lgtv -i "privatekey=lgtv_webos" -i "passphrase=<PASSPHRASE>"
ares-device -i -d lgtv                    # verifica conexión (modelName, sdkVersion…)
```
> `getkey` falla "Failed to get ssh private key" si **Key Server OFF** o passphrase caducado.

### Empaquetar / instalar / lanzar
```bash
ares-package tv-launchers/webos -o tv-launchers/dist   # com.streamprobe.app_1.0.0_all.ipk
ares-package tv-launchers/goya  -o tv-launchers/dist   # com.goya.acano2_1.0.0_all.ipk

ares-install -d lgtv tv-launchers/dist/com.streamprobe.app_1.0.0_all.ipk
ares-launch  -d lgtv com.streamprobe.app
ares-launch  -d lgtv --close com.streamprobe.app
ares-launch  -d lgtv --running
ares-install -d lgtv --list
ares-inspect -d lgtv -a com.streamprobe.app   # Web Inspector remoto (DevTools de la app)
```
> Las apps de Dev Mode **no suelen salir en el Home** → se abren con `ares-launch`.
> Para cambiar la URL (p. ej. si cambia la IP del Mac): editar el `index.html` del launcher + re-`ares-package` + `ares-install`.

### `ares` vs SDK de webOS
**Sin diferencia** en cómo se ejecuta la app. El IDE del SDK solo pone botones que llaman a estos mismos
`ares-*`. El SDK añade emulador/plantillas/debug GUI, pero empaquetado/instalación/lanzamiento son idénticos.

---

## 5. Caveats que nos han mordido

- **El proxy añade latencia** (`Mac → CDN`): puede inflar la live latency y contribuir a stalls. Para
  descartarlo, vaciar el Origin → reproducción directa a la CDN.
- **IP del Mac por DHCP**: si cambia, el launcher de StreamProbe deja de cargar → actualizar `index.html` + re-empaquetar.
- **HMR rompe el dev server**: editar código con `next dev` corriendo puede dar 404 → reiniciar `npm run dev -- -p 3001`.
- **Sesión Dev Mode** caduca ~50h y el passphrase rota → "Extend" + `ares-novacom --getkey`.
- **Cuenta LG** obligatoria para instalar Developer Mode (Google no vale).
- **Compare A/B no funciona en la TV** (un solo decoder de hardware); usar Single.

---

## 6. Estado y próximos pasos (resumen)

- ✅ Igualado: device, runtime de app, motor (Shaka), versión, UA real, trustLevel netcast.
- ❌ Falta: **config de Shaka de Infinity** + presión de memoria/flujo (no tenemos su código).
- 🔎 Pendiente:
  1. Confirmar **versión exacta de Shaka** de Infinity (4.13.25 vs 4.16.38).
  2. Ver en **Events/Buffer** en la LG si el congelado trae `GAP JUMPED` / `STALL` / error de Shaka.
  3. Probar **sin proxy** (Origin vacío) para descartar que el 30s+congelado sea del proxy/LAN.
