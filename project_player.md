# project_player — StreamProbe: contexto completo del proyecto

Documento maestro para retomar el proyecto sin perder nada: qué es, por qué existe, cómo
está construido, qué se ha investigado y qué queda abierto.

> Complementa a `codigo_stv.md` (contexto original) y a `tv-launchers/README.md` (runbook de TV).

---

## 0. Quién / qué / para qué

- **Usuario**: AgileTV, trabaja en **players de Smart TV para Mediaset** (mitele / Infinity OTT).
- **Foco**: problemas de **DASH multiperiod + SCTE-35 con Shaka Player** en Smart TVs (LG webOS, Samsung Tizen).
- **StreamProbe** = herramienta Next.js construida en `~/Documents/Javi/Multiplayer` para
  **probar y depurar reproducción** entre engines y versiones, y así **reproducir el bug de
  multiperiod** de la app Infinity.
- **Repo**: `github.com/JaviergomezMst/streamprobe` (se commitea directo a `main`).

---

## 1. La herramienta

Next.js 14 (App Router, TypeScript, Tailwind). Dark-only. Paleta en `tailwind.config.ts`
(`bg #0B0E16`, verde `ga #1DB953`, azul `gb #3B82F6`), tipografías Inter + JetBrains Mono.

**Arranque**: `npm run dev -- -p 3001`
⚠ Editar código con `next dev` corriendo puede dejar el server en 404 (Fast Refresh), y un
`.next` obsoleto también → **`rm -rf .next && npm run dev -- -p 3001`**.

### Engines

Bundleados por npm con alias e `import()` dinámico, con selector de versión:

| Engine | Versiones | Formatos |
|---|---|---|
| **Shaka** | **4.13.25** (default), 4.16.39 | DASH, HLS, Smooth |
| dash.js | 4.7.4, 4.5.2, 3.2.2 | DASH, Smooth |
| hls.js | 1.5.20, 1.4.14, 1.2.9 | HLS |
| Native / AVPlayer | del navegador | HLS, DASH |
| ExoPlayer | stub explicativo | — |
| **GAM DAI** | usa hls.js/Shaka | HLS, DASH (SSAI) |

### Funcionalidades

- **Single** y **Compare A/B**. En Compare cada panel tiene **su propia URL, cabeceras y
  botón Load**, más un botón único **Load A + B** y **Stop Both**.
  (A/B **no funciona en la TV**: un solo decoder por hardware.)
- **Métricas en vivo**: join time, buffering, bitrate, ancho de banda, live latency, dropped frames.
- **Logs por pestañas**: Events / ABR / SCTE-35 / Buffer / Network / Manifest, con Clear por pestaña.
  Ventana rodante: 2000 entradas por log y 2000 manifests (se descartan los antiguos), con filas
  memoizadas para que la lista no se atasque en sesiones largas.
- **HUD de trazas en vivo** (`◉ HUD`): panel translúcido con blur **sobre el vídeo**, con feed
  cronológico combinado (eventos + red + manifests), filtros, auto-scroll congelable y métricas.
  Pensado para la TV, donde no hay DevTools. Limitado a 400 filas por rendimiento.
- **Volcado de trazas al Mac** (`📡 Trazas → Mac`): POST a `/api/traces`, que guarda en `./traces/`
  un JSON con **manifests completos**, red (con las cabeceras inyectadas), eventos, ABR, SCTE-35,
  métricas y datos del dispositivo. Resuelve el no poder depurar en la tele.
- **DRM**: Widevine / PlayReady / FairPlay.
- **Selección de audio y subtítulos** por engine (con opción Off).
- **Fijar calidad máxima (sin ABR)**: desactiva el ABR y clava la rendición top.
- **Match TV mode**: Shaka con **defaults** y solo `drm.servers`, como hace la app de mitele.
- **Device emulation**: spoofea `navigator.userAgent` para que la detección de plataforma de Shaka
  entre por el camino de la TV. ⚠ **Solo cambia lo que ve el JS, no la cabecera HTTP** (ver §4).
- **Deploy TV**: instalar StreamProbe en una tele desde la propia app (ver §5).
- **Responsive**: usable en iPhone (ver §6).

### Análisis de manifests (el corazón del debug)

- Captura **cada MPD/m3u8** (inicial y refrescos del directo) con badge single/multiperiod.
- **Tabla de periods**: id, start, duración, codecs, ⚠gap, ⤳ cambio de codec.
- **Visor del bloque SegmentTimeline**: al pinchar un period se despliegan las filas crudas
  `<S t d r>` de vídeo y audio, con nº de segmentos (r+1), duración/segmento y el span en tiempo
  de presentación.
- **Consistencia de timestamps** (`lib/manifest.ts`), pensado para validar la conversión
  multiperiod → one-period:
  1. **Salto de timestamps dentro de un period** (`internalBreaks`): el `t` no continúa tras la
     publi — el fallo típico de un cosido malo.
  2. **Continuidad en la costura** entre periods: hueco/solape de vídeo **o audio**, cambio de
     timescale, o cambio de **familia** de codec (avc1→hvc1; ignora cambios de perfil, que son ABR normal).
  3. **Desalineo vídeo/audio** (`vaStartSkewSec` / `vaEndSkewSec`).
  Todo ello con badges resumen y **alerta en vivo** en el log SCTE (de-dupada).
- **Instrumentación SCTE-35** (Shaka: `emsg` + `timelineregion`) y eventos **gap/stall**
  (`gapjumped` / `stalldetected`) con los buffered ranges.

### Dos relojes que no hay que mezclar

- **Token de Akamai** (`hdnts` / `hdnea`): `st`/`exp` en **Unix epoch** (segundos desde 1970).
  Firmado con HMAC, así que no se puede alargar. El `hdnea` de GAM dura **~5 minutos**.
- **SegmentTimeline**: `t` y `presentationTimeOffset` en **ticks de `timescale`**.
  Segundos de presentación = `Period@start + (t − pto) / timescale`.

---

## 2. El bug que se investiga (multiperiod en Infinity)

**Síntoma**: contenido DASH **multiperiod** se **congela** en Smart TVs con la app **Infinity**.
En la LG: la live latency sube a ~30s y la imagen se congela. Stream **en claro**. El player de CTV
**no inserta ads** y **no consume** los SCTE-35 (pero el MPD los lleva y Shaka los parsea igual).

**Confirmado**:
- Infinity usa **Shaka** en webOS (NO dash.js). Versión dicha 4.13.25, pero se vio 4.16.38 →
  **versión exacta sin confirmar**.
- En StreamProbe (misma LG, mismo Shaka, misma versión) **no reproduce en el navegador**.
- Descartados: device, engine, versión. Descartada la hipótesis de ad-break/reload.

**Lo que falta por igualar**:
1. **Runtime de app vs navegador** → por eso se instala StreamProbe como app (§5).
2. **La `player.configure()` de Infinity** — no se tiene. **Mayor incógnita.**
3. **Presión de memoria** — el multiperiod suele romper por `QUOTA_EXCEEDED`.

**Hipótesis de trabajo**: gap/discontinuidad o cambio de codec en la frontera del period que Chrome
de escritorio salta (gap-jumping) pero el MSE viejo de la TV no → stall. El analizador de costuras
de §1 existe precisamente para cazarlo.

**Pistas útiles**: `timeShiftBufferDepth="PT30S"` — ventana DVR de solo 30s. Si el player se atasca
y se queda atrás más de 30s, los segmentos caducan → **404**. Ojo: ese 404 puede ser **consecuencia**
del stall, no la causa.

---

## 3. Proyecto de referencia: goya / mitele

`~/Downloads/euw1-mes-dm-goya-2.25.1` = mitele-react v2.25.1 (app SmartTV de Mediaset).

- Engine por device: **webOS usa dash.js 4.5.2**, Tizen usa AVPlayer + dash.js. **Shaka no está
  cableado ahí.** Pero la app **Infinity real usa Shaka** → build distinta. **No extrapolar de goya.**
- Su tech Shaka es **mínima**: `new shaka.Player(video)`, autoplay y solo `drm.servers`, sin config
  de streaming. De ahí nació el modo **Match TV**.
- Sus launchers Tizen/webOS son envoltorios de redirección con `trustLevel: "netcast"` — patrón
  copiado en `tv-launchers/`.

---

## 4. Cabeceras CDN, proxy y la regla de Akamai

El navegador **prohíbe** que el JS fije `Origin`, `Referer` y `User-Agent`. Por eso existe
`app/api/proxy/route.ts`: reenvía la petición desde el servidor inyectando esas cabeceras y
devuelve `x-sp-sent-*` para poder verificarlo (botón **Verify headers** y `hdr✓` en Network).
Añade un salto → **afecta a las métricas**. Botón **Desactivar/Activar proxy** para conmutarlo.

### Propagación del token de CDN (Shaka error 1001 / hls.js levelLoadError)

`lib/cdnToken.ts` (`makeTokenPropagator`): los packagers tipo Unified Streaming listan las hijas
(variantes, subtítulos, segmentos) como **rutas relativas y sin token**, así que el player, al
resolverlas contra la URL del manifest, **pierde el `?hdnts=`** → el CDN responde **403**, que aflora
como **Shaka 1001** (`BAD_HTTP_STATUS`) o `levelLoadError` en hls.js. El helper re-adjunta el token del
manifest a cada petición hija, **solo al host que lo emitió** (nunca cross-domain, donde es inútil y
filtraría una credencial) y **solo los parámetros de auth** (`hdnts`/`hdnea`/`hdntl`/`token`), nunca
los de routing como `originpath`. Es idempotente (no duplica el token si ya está). Compartido por los
engines Shaka, hls.js y GAM DAI (antes solo lo tenía el de DAI). Verificado con la URL live de
`directos.mediaset.es`: hija y segmentos pasan de 403 sin token a 200 con él.

### Los dos User-Agent (fuente de confusión resuelta)

| Campo | Qué hace |
|---|---|
| **Device emulation → User-Agent** | Solo `navigator.userAgent` (JS), para la detección de plataforma de Shaka. **NO viaja por el cable.** |
| **Network / CDN headers → User-Agent** | **Sí** viaja: el proxy lo inyecta en servidor. Es el que ve Akamai. |

**Verificado empíricamente** (servidor eco propio, en local y contra HTTPS remoto real): el UA
forzado en el campo del proxy llega **intacto** al upstream.

**Bug encontrado y corregido**: con el proxy activo pero el campo UA vacío, Node/undici enviaba su
UA por defecto (`user-agent: node`), así que Akamai no veía el UA de la TV y no aplicaba la
transformación multiperiod→one-period. Ahora el proxy reenvía el UA real del navegador si no se
fuerza uno.

**Akamai exige `Origin`**: sin él, manifest y segmentos dan **403**. Por eso la config por defecto
manda `Origin: https://www.mediasetinfinity.es` + `Referer`. (Hubo además un periodo de 403
intermitentes por rate-limiting del WAF que se resolvió solo.)

---

## 5. Ejecutar en la TV

### Pestaña Deploy TV

Dentro de la app: eliges plataforma (**webOS** / **Tizen**; Android TV en gris = fase 2, requiere
Android SDK), metes la **IP de la TV a mano** y la del Mac (autodetectada), y el botón
**empaqueta + instala + lanza** ejecutando `ares-*` o `sdb`/`tizen`, con la salida en vivo.
Reescribe la URL del launcher (única fuente de verdad), guarda dispositivos en localStorage y
detecta qué CLIs hay instalados. Botón **Abrir en navegador** como plan B.

**Verificado**: el empaquetado webOS genera el `.ipk` correctamente. En Tizen el pipeline llega
hasta el `install` en la tele y sólo lo frena el certificado (ver §5 *Samsung Tizen*). El
**registro inicial** del dispositivo (dev key de ares, certificado de Samsung) sigue siendo manual.

### Runbook webOS (LG 55QNED93A6A, webOS SDK 10.3.1)

Los `.ipk` son **envoltorios finos**: un `index.html` que redirige a la URL del dev server, para
que Shaka corra en el **MSE real** de la tele.

```bash
npm i -g @webos-tools/cli      # NO @webosose/ares-cli (OSE, chocan)
ares-setup-device -a lgtv -i "host=<IP-TV>" -i "port=9922" -i "username=prisoner"
ares-novacom -d lgtv --getkey  # teclea el passphrase
ares-device -i -d lgtv         # verificar conexión

ares-package tv-launchers/webos -o tv-launchers/dist
ares-install -d lgtv tv-launchers/dist/com.streamprobe.app_1.0.0_all.ipk
ares-launch  -d lgtv com.streamprobe.app
ares-inspect -d lgtv -a com.streamprobe.app   # DevTools remoto
```

**Caveats**: la sesión de Dev Mode caduca ~50h y el passphrase rota; hace falta **cuenta LG**;
las apps de Dev Mode no salen en el Home (se abren con `ares-launch`); si cambia la IP del Mac
(DHCP) hay que re-empaquetar. `ares` y el SDK hacen exactamente lo mismo.

### Varias teles a la vez, cada una con su stream

**Deep links** (`lib/deepLink.ts`): la configuración viaja en la query string, así que un
launcher —o un marcador del navegador— abre StreamProbe ya preparado:

```
http://192.168.0.138:3001/?url=<stream>&engine=shaka&autoplay=1
```

Parámetros: `url`, `engine`, `version`, `origin`, `referer`, `ua`, `noproxy`, `deviceUa`,
`matchTv`, `lockMax`, `assetKey`, `daiFormat`, `drm`, `license`, `autoplay`. Se resuelven **antes
del primer render**, así que el panel nunca parpadea con los valores por defecto.

En **Deploy TV**, cada tele guardada lleva **su propio stream** y su flag de autoplay; se marcan
varias con casillas y se despliegan **en secuencia** (`▶ Deploy a N teles`), con cabecera y salida
por dispositivo. Así puedes tener LG, Samsung y Android TV corriendo con tres streams distintos.

Detalle que juega a favor: **la URL se hornea en cada app al instalarla**, de modo que cada tele
conserva la suya y un despliegue posterior a otra tele no le pisa la configuración.

Dos trampas encontradas al montarlo (ambas resueltas):
- En Android la URL vive en `strings.xml`, donde un `&` **crudo es XML inválido** y rompe el build
  (`The reference to entity "autoplay" must end with the ';' delimiter`). Se escapa a `&amp;` solo
  en esa plataforma; en los `index.html` de webOS/Tizen va dentro de una cadena JS y no se escapa.
- Cada tele necesita **su propio build** (la URL va embebida), así que un despliegue a 3 teles son
  3 ciclos de compilar+instalar: es secuencial y tarda unos minutos.

**Verificado** en la Xiaomi Mi TV: la app arrancó sola con el stream de la query y empezó a
reproducir sin tocar el mando (join 2.59 s).

### Cobertura por plataforma

StreamProbe es una **herramienta de uso diario**, no un apaño para un bug concreto, así que la
cobertura de dispositivos es valor en sí misma.

| Plataforma | Cómo | Marcas | Estado |
|---|---|---|---|
| **LG webOS** | `.ipk` · ares | LG | ✅ verificado |
| **Android TV / Google TV** | `.apk` WebView · gradle + adb | Sony, Philips nuevos, TCL, Xiaomi, Shield, **Fire TV** | ⚠️ escrito, sin verificar (falta SDK) |
| **Samsung Tizen** | `.wgt` · tizen + sdb | Samsung | ✅ instala y arranca como app (cert Samsung, perfil `StreamProbe`) |
| Xbox | navegador Edge, se escribe la URL | Xbox | ✅ coste cero |
| Chromecast (sin Google TV) | Cast Receiver (requiere HTTPS) | — | ⬜ posible, no hecho |
| Hisense-VIDAA, Roku, Apple TV, Vizio | — | — | ❌ sin sideload de web apps |

**Fallback universal**: cualquier tele con navegador puede abrir la URL (botón *Abrir en
navegador*), aunque se pierde la fidelidad del runtime de app.

### Android TV (`tv-launchers/androidtv/`)

Proyecto Gradle mínimo: una `MainActivity` con un **WebView a pantalla completa** que abre la URL
del dev server (guardada en `res/values/strings.xml`, que la pestaña Deploy reescribe igual que el
`index.html` de webOS/Tizen). Detalles que importan:

- `setMediaPlaybackRequiresUserGesture(false)` — sin esto el WebView bloquea el autoplay y con un
  mando no hay forma cómoda de dar el gesto.
- `usesCleartextTraffic` + `MIXED_CONTENT_ALWAYS_ALLOW` — el dev server es `http://` en la LAN.
- `LEANBACK_LAUNCHER` + `leanback`/`touchscreen` como `required="false"` — así sale en el home de
  Android TV **y** de Fire TV, y el mismo APK instala también en móvil/tablet.
- `minSdk 21` a propósito: interesa poder probar en cajas y sticks viejos.
- La consola web se reenvía a logcat → `adb logcat -s StreamProbe` enseña los logs del player.
- El banner del home es un **vector XML**, para no meter binarios en el repo.

**Requisitos**: `brew install gradle` + Android SDK platform-tools (para `adb`). Java 17 ya está.
En la tele: activar **Opciones de desarrollador** y **depuración por red**, y luego el deploy hace
`adb connect <ip>:5555` → `gradle assembleDebug` → `adb install -r` → lanzar con `monkey`.

**Bonus pendiente**: con un APK nativo se podría exponer un engine **ExoPlayer real** (hoy es solo
un stub explicativo) y comparar Shaka vs ExoPlayer en el mismo dispositivo.

### Samsung Tizen (TQ55QN90DATXXC, Tizen 9.0) — ✅ funciona como app desde 2026-10-13

Estado: **instala y arranca como app**, igual que la LG. Certificado Samsung creado en Certificate
Manager (Samsung → TV, perfil `StreamProbe`; el DUID se rellena solo con la tele conectada por
`sdb`). Ficheros en `~/SamsungCertificate/StreamProbe/`, perfil en
`/Users/Shared/tizen-studio-data/profile/profiles.xml`. El CLI tiene que apuntar ahí:
`tizen cli-config "profiles.path=/Users/Shared/tizen-studio-data/profile/profiles.xml"`
(en `~/tizen-studio-data` queda un perfil autofirmado viejo con el mismo nombre — no sirve).
Abrirla desde el Mac: `tizen run -p StrmProbe1.StreamProbe -t TQ55QN90DATXXC`.
El certificado va atado al DUID de esta tele; otra Samsung necesita reemitirlo con su DUID.

**IPs por DHCP cambian**: el campo *Host PC IP* del modo desarrollador debe ser la del Mac y solo
se puede editar al pasar el modo de Off a On. Si `sdb connect` falla con el 26101 abierto, es eso.

Lo que sigue es el historial de cómo se llegó (2026-10-07):

**El muro: instalar un `.wgt` exige el certificado de distribución de Samsung.** No hay atajo —
probado, no supuesto. Con autor autofirmado + el distributor público de Tizen:

```
install failed[118, -12], reason: Check certificate error :
:Invalid certificate chain with certificate in signature.:<-3>
```

`tools/certificate-generator/certificates/` no trae **ningún** certificado Samsung. Hace falta
Tizen Studio **con IDE** → Package Manager → *Samsung Certificate Extension* (`cert-add-on`) →
Certificate Manager → certificado **Samsung** (no Tizen) con login de cuenta Samsung. Es gratis;
la cuenta de Seller sólo hace falta para publicar en la store. El certificado se ata al **DUID**
de la tele, que el Certificate Manager lee solo si `sdb` ya está conectado.

**Plan B que funciona hoy**: el navegador de la propia tele contra `http://<IP-del-Mac>:3001`. Es
el mismo Chromium de Tizen en el que correría la app empaquetada, así que engine/ABR/DRM sobre el
chipset real se observan igual. Se pierde el arranque con el mando y poco más.

**Modo desarrollador**: Smart Hub → Apps → bajar hasta **App Settings** → teclear **12345** (no en
la rejilla de apps, que es donde todo el mundo lo intenta). Después hace falta un **apagado y
encendido en frío** o el puerto 26101 sigue cerrado. Luego `sdb connect <IP-TV>`. Al contrario que
en LG, en la tele se mete la **IP del Mac**.

`sdb shell` está **bloqueado** en firmware retail (devuelve `closed`), así que no hay DUID ni
`app_launcher` por CLI. `sdb capability` sí responde.

**Trampas del CLI de Tizen** (todas costaron tiempo real, y las cuatro estaban en `deploy/route.ts`):

- `tizen install -t` quiere el **nombre** del dispositivo que lista `sdb devices`
  (`TQ55QN90DATXXC`), no la IP. Con IP: *"There is no connected target"* aunque `sdb` lo muestre.
- Todas las rutas que se le pasan deben ser **absolutas**: las resuelve contra su propio directorio
  de instalación, no contra el cwd, así que `-o` deja el `.wgt` en `tools/ide/bin`.
- `tizen package` firma **in situ** y deja `author-signature.xml`, `signature1.xml` y
  `.manifest.tmp` junto a los fuentes → se empaqueta una copia de staging, nunca el árbol de trabajo.
- `tizen build-web` copia bien los ficheros y **luego** muere con
  `NoClassDefFoundError: org/eclipse/core/runtime/Plugin`, saliendo con código 1. Para un launcher
  estático no aporta nada: se le pasa el directorio a `package` y listo. (Corrige lo que decía
  antes esta sección: su ausencia no es la causa de que no se genere el `.wgt`.)

**Trampas del instalador en Apple Silicon**:

- El instalador trae su propio `unzip` para extraer el JDK; macOS lo **mata con SIGKILL** porque
  elige su slice `arm64e` y la firma no valida. Como lo llama con `-qq`, falla en silencio: deja
  `~/.package-manager/jdk` vacío y el doble clic no hace nada. Solución: extraer el JDK a mano con
  el `unzip` del sistema (`unzip -qq -o tizen-sdk.zip 'jdk/*' -d ~/.package-manager`).
- *"Target directory is not valid"* con `$HOME` = `/Users/javier.gomez@agiletv.com`. Instalado en
  **`/Users/Shared/tizen-studio`** (+ `tizen-studio-data`), que evita a la vez la `@` del home y el
  directorio no vacío de la instalación CLI previa. El `PATH` de `~/.zshrc` apunta ahí.
- No hace falta `sudo` ni registrar JDKs: Tizen trae Corretto 8 x86_64 y Rosetta lo ejecuta.

---

## 6. Uso en móvil (iPhone)

Basta con abrir `http://<IP-del-Mac>:3001` en Safari (misma WiFi, sin VPN).

- **Meta viewport** imprescindible: sin él iOS maqueta a 980px y todo sale diminuto.
- En **<768px** scrollea la página entera; el app-shell de altura fija queda solo para escritorio
  (los contenedores con scroll anidados dentro de un body bloqueado son inusables en iOS).
- Pestañas **Configuración / Reproductor** en móvil (no caben a la vez); al pulsar Load salta al
  reproductor. Compare A/B se apila en vertical.
- Inputs a 16px en pantallas táctiles, para que iOS no haga zoom al enfocarlos. Safe areas del notch.

⚠ **Limitación de iOS**: Safari en iPhone **no tiene MSE** (hasta iOS 17.1 con Managed Media
Source). Por tanto **DASH no funciona** en iPhone → el bug de multiperiod no se puede reproducir ahí.
Usa **HLS con Native/AVPlayer**, que es lo que usa un iPhone de verdad.

---

## 7. GAM DAI (SSAI)

Engine `gamdai` (`lib/engines/dai.ts`) que integra el **IMA DAI SDK** de Google. **Solo live**
(asset key; VOD se quitó a propósito). Pide el stream cosido a GAM, lo reproduce (hls.js para HLS,
Shaka para DASH), reenvía la metadata temporizada al `StreamManager` y loguea los **eventos de
anuncio** (ad breaks, cuartiles, cuepoints) en la pestaña SCTE-35.

**Clave**: el player se elige por la **URL que devuelve GAM**, no por el formato pedido (el SDK
puede servir otro distinto).

### La cadena real de Mediaset (trazada a mano) — y sus trampas

| Nivel | Host | Auth |
|---|---|---|
| master | `directos.mediasetinfinity.es` (Akamai) | `?hdnea=<token>&originpath=…` — **requerido** |
| variantes | **`dai.google.com`** | ninguna — **públicas** |
| segmentos | vuelven al CDN de Mediaset | listados **sin token** → **403** |

Dos trampas resueltas:
1. El token del master hay que re-añadirlo a los segmentos, **solo al host que lo emitió** (nunca
   cross-domain a Google: allí es inútil y filtra una credencial).
2. **Solo se propaga el parámetro de auth.** La query del master lleva también
   `originpath=…master.m3u8`, que es una directiva de **routing**: si se cuela en un `.ts`, el CDN
   responde con **el manifest en lugar del segmento** y hls.js muere con `fragParsingError`.

**Estado: funcionando** (confirmado 2026-07-28).

**Cabo suelto**: el tracking de anuncios viaja como `#EXT-X-DATERANGE` con
`CLASS="https://aomedia.org/emsg/ID3"` y `X-MESSAGE-DATA` en base64, **no** como ID3 in-band; el
reenvío actual escucha `FRAG_PARSING_METADATA`, así que puede que los eventos de anuncio no
aparezcan aunque la reproducción vaya. Pendiente de parsear DATERANGE si hace falta.

---

## 8. Mapa del código

```
app/
  layout.tsx            metadata + viewport (crítico para iOS)
  globals.css           paleta, scroll móvil vs app-shell escritorio
  api/proxy/route.ts    inyecta Origin/Referer/UA en servidor
  api/deploy/route.ts   empaqueta/instala/lanza en la TV (ares, tizen/sdb)
  api/traces/route.ts   recibe y guarda los volcados en ./traces
components/
  StreamProbe.tsx       shell: modo single/compare, vista player/deploy, tabs móvil
  Header.tsx            cabecera + conmutadores
  ConfigPanel.tsx       config por panel (engine, URL, DRM, red, DAI, avanzado)
  PlayerPanel.tsx       vídeo + métricas + pistas + logs + HUD
  TraceOverlay.tsx      HUD translúcido de trazas en vivo
  ManifestView.tsx      lista de manifests, tabla de periods, SegmentTimeline
  LogView.tsx BufferView.tsx MetricsBar.tsx DrmConfig.tsx EngineSelector.tsx Toggle.tsx
  DeployPanel.tsx       pestaña Deploy TV
hooks/usePlayer.ts      estado del player, logs, manifests, dump de trazas
lib/
  manifest.ts           parser DASH, SegmentTimeline, continuidad de costuras
  proxy.ts format.ts fmt.ts deviceEmu.ts
  engines/  shaka dashjs hlsjs native exoplayer dai | drm registry types loaders index
tv-launchers/           webos/ tizen/ goya/ (+ dist/, ignorado en git)
traces/                 volcados desde TV/móvil (ignorado en git)
```

---

## 9. Próximos pasos

1. Confirmar la **versión exacta de Shaka** de Infinity (4.13.25 vs 4.16.38).
2. Conseguir la **`player.configure()`** de Infinity — sigue siendo la mayor incógnita.
3. Con el stream SSAI de GAM (que es la **fuente real del multiperiod**), cazar la costura de la
   publi con el analizador y ver si hay hueco / cambio de timescale / cambio de familia de codec.
4. Contrastar el MPD **con UA de TV** (one-period) contra el **sin UA** (multiperiod) para
   caracterizar qué hace exactamente la transformación de Akamai.
5. Si hacen falta los eventos de anuncio de GAM: parsear `EXT-X-DATERANGE` y alimentarlos al
   `StreamManager`.
