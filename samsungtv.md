# StreamProbe en una Samsung TV (Tizen)

Guía completa para instalar StreamProbe como **app** en una tele Samsung y manejarlo con el
mando: desde instalar Tizen Studio en el Mac hasta sacar el certificado de Samsung.

Probado en una **Samsung TQ55QN90DATXXC (Tizen 9.0)** desde un Mac con Apple Silicon.

> **¿Solo quieres probar rápido?** Abre el navegador de la propia tele y ve a
> `http://<IP-del-Mac>:3001`. Usa el mismo motor (Chromium de Tizen) que la app instalada, así que
> el comportamiento del player, el ABR y el DRM es el mismo. No hace falta nada de lo que sigue.
> La app instalada solo añade pantalla completa, icono en la tele y apertura directa.

---

## Cómo funciona

La app que se instala en la tele (`.wgt`) es solo un **lanzador**: al abrirse, redirige a tu
servidor de StreamProbe en el Mac (`http://<IP-del-Mac>:3001`). Por eso:

- **El Mac tiene que tener StreamProbe arrancado** y estar en la **misma red** que la tele.
- Cualquier cambio en el código se ve en la tele con solo cerrar la app y volver a abrirla. **No hace
  falta reinstalar**, salvo que cambie la IP del Mac.

A diferencia de LG (webOS), **Samsung solo instala apps firmadas con un certificado emitido por
Samsung** y ligado a esa tele concreta. Con un certificado autofirmado, la tele lo rechaza a mitad
de instalación (ver [Problemas frecuentes](#problemas-frecuentes)). Por eso hay que sacar el
certificado (paso 5). Es gratis y se hace una sola vez por tele.

## Resumen

| Paso | Qué | Se hace |
|---|---|---|
| 1 | Instalar Tizen Studio (con IDE) | Una vez por Mac |
| 2 | Instalar la extensión de certificados de Samsung | Una vez por Mac |
| 3 | Activar el modo desarrollador en la tele | Una vez por tele (y si cambia la IP del Mac) |
| 4 | Conectar el Mac a la tele (`sdb`) | Cada vez que se reinicie el Mac o la tele |
| 5 | Crear el certificado Samsung | Una vez por tele |
| 6 | Apuntar el CLI al certificado | Una vez por Mac |
| 7 | Desplegar desde StreamProbe | Cada vez que quieras reinstalar |

---

## 1. Instalar Tizen Studio en el Mac

Necesitas la versión **con IDE**. La versión CLI sola no trae el Certificate Manager ni la extensión de Samsung.

1. Descarga **`web-ide_Tizen_Studio_6.1_macos-64.dmg`** (unos 650 MB) desde
   <https://download.tizen.org/sdk/Installer/tizen-studio_6.1/>
   (o la página oficial: <https://developer.tizen.org/development/tizen-studio/download>).
   El servidor de Tizen corta a menudo las descargas. Si falla, reanúdala con curl:
   ```bash
   cd ~/Downloads
   curl -L -C - --retry 10 --retry-all-errors -O \
     https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-ide_Tizen_Studio_6.1_macos-64.dmg
   ```
2. Abre el `.dmg` y haz doble clic en el instalador.

### Si el instalador no hace nada al hacer doble clic (Apple Silicon)

El instalador lleva su propio `unzip`, y macOS lo mata en Macs con chip Apple. El fallo es
silencioso: la ventana no llega a abrirse. Arreglo: extraer a mano el Java que necesita con el
`unzip` del sistema y volver a abrir el instalador:

```bash
/usr/bin/unzip -qq -o \
  "/Volumes/Tizen_Studio_6.1/installer.app/Contents/Resources/Java/tizen-sdk.zip" \
  'jdk/*' -d ~/.package-manager
```

### Si dice "Target directory is not valid"

En la pantalla *Installation Settings*, cambia las dos rutas a:

| Campo | Ruta |
|---|---|
| SDK location | `/Users/Shared/tizen-studio` |
| SDK data location | `/Users/Shared/tizen-studio-data` |

El instalador rechaza rutas dentro de tu carpeta personal si el nombre de usuario lleva caracteres
como `@`, o si la carpeta ya existe y no está vacía. `/Users/Shared` evita los dos problemas y no
pide contraseña de administrador.

### Añadir las herramientas al PATH

Añade esto a `~/.zshrc` (ajusta la ruta si instalaste en otro sitio):

```bash
export TIZEN_STUDIO="/Users/Shared/tizen-studio"
export PATH="$TIZEN_STUDIO/tools/ide/bin:$TIZEN_STUDIO/tools:$PATH"
```

Abre una terminal nueva y comprueba:

```bash
which tizen sdb
# /Users/Shared/tizen-studio/tools/ide/bin/tizen
# /Users/Shared/tizen-studio/tools/sdb
```

> **Importante:** el servidor de StreamProbe tiene que arrancarse **desde una terminal que ya tenga
> este PATH**. Si lo tenías arrancado de antes, páralo y vuelve a lanzarlo. Si no, el botón Deploy
> dirá que no encuentra `tizen`.

## 2. Instalar la extensión de certificados de Samsung

Con el Package Manager cerrado, desde la terminal:

```bash
/Users/Shared/tizen-studio/package-manager/package-manager-cli.bin \
  install --accept-license cert-add-on
```

Comprueba que aparece como instalado (`i`):

```bash
/Users/Shared/tizen-studio/package-manager/package-manager-cli.bin show-pkgs | grep cert-add-on
# i    cert-add-on    2.0.75    Samsung Certificate Extension
```

Alternativa gráfica: abre `package-manager.app` → pestaña **Extension SDK** → **Samsung
Certificate Extension** → **Install**.

## 3. Activar el modo desarrollador en la tele

Antes, mira la IP de tu Mac:

```bash
ipconfig getifaddr en0
```

En la tele:

1. Botón **Home** → **Apps**.
2. Baja dentro de Apps hasta **App Settings**.
3. Teclea **`1 2 3 4 5`**. Los mandos SolarCell no tienen números: pulsa el botón **`123`** del mando
   y elige el **teclado numérico** de pantalla. También vale el mando virtual de la app
   **SmartThings** del móvil. Si no responde sobre App Settings, prueba a teclearlo en la propia
   rejilla de Apps.
4. En la ventana **Developer Mode**:
   - Developer mode → **On**
   - **Host PC IP** → la IP de tu Mac
   - **OK**
5. **Apaga la tele del todo**: mantén pulsado el botón de encendido del mando hasta que se reinicie,
   o desenchúfala 30 segundos. Si solo la pasas a reposo, el modo desarrollador no se activa.

Al volver a entrar en Apps debe aparecer **"Developer Mode"** arriba.

> **El campo Host PC IP aparece bloqueado** si el modo ya estaba en On. Para cambiarlo: pon
> Developer Mode en **Off** → OK → apaga del todo → vuelve a entrar con `12345`, pon **On** y ahora sí
> te deja escribir la IP → apaga del todo otra vez.

## 4. Conectar el Mac a la tele

Mira la IP de la tele (Ajustes → Conexión → Red → Estado de red) y conecta:

```bash
sdb connect <IP-de-la-tele>
sdb devices
# List of devices attached
# 192.168.0.133:26101    device    TQ55QN90DATXXC
```

El último valor (`TQ55QN90DATXXC`) es el **nombre del dispositivo**. Lo usa el CLI de Tizen.

Si no sabes la IP de la tele, búscala en la red (cambia `192.168.0` por tu red):

```bash
for i in $(seq 1 254); do (nc -z -G 1 192.168.0.$i 26101 2>/dev/null && echo "Tele en 192.168.0.$i") & done; wait
```

> En tele de venta al público, `sdb shell` está bloqueado (devuelve `closed`). Es normal y no
> hace falta.

## 5. Crear el certificado Samsung

Con la tele **encendida y conectada por `sdb`** (paso 4), así el Certificate Manager detecta
la tele sola:

```bash
open /Users/Shared/tizen-studio/tools/certificate-manager/Certificate-manager.app
```

1. Pulsa **+** (*Create a new certificate profile*).
2. Tipo de certificado: **Samsung** (no *Tizen*).
3. Tipo de dispositivo: **TV**.
4. Nombre del perfil: **`StreamProbe`**.
5. Author certificate: **Create a new author certificate** → un nombre (p. ej. `StreamProbe`) y una
   contraseña.
6. Inicia sesión con tu **cuenta Samsung**. Vale la cuenta normal y gratuita; la cuenta de
   vendedor (*Seller*) solo hace falta para publicar en la tienda.
7. Distributor certificate: privilegio **Public**. En la lista de **DUID** debe aparecer el
   identificador de tu tele (un código tipo `BDCGV…`): déjalo marcado. Si no aparece, la tele no está
   conectada: vuelve al paso 4.
8. **Finish**.

Se guarda en:

| Qué | Dónde |
|---|---|
| Certificados (`author.p12`, `distributor.p12`) | `~/SamsungCertificate/StreamProbe/` |
| Perfil | `/Users/Shared/tizen-studio-data/profile/profiles.xml` |

> **No subas nunca estos ficheros al repositorio.** Son tus claves de firma.
>
> El certificado vale **solo para las teles cuyo DUID incluya**. Para otra Samsung, conéctala y
> vuelve a emitir el distributor añadiendo su DUID.

## 6. Apuntar el CLI de Tizen al certificado

El CLI tiene que leer el perfil que acabas de crear:

```bash
tizen cli-config "profiles.path=/Users/Shared/tizen-studio-data/profile/profiles.xml"
```

> Si en algún momento creaste un perfil autofirmado (por ejemplo en `~/tizen-studio-data`), el CLI
> podría estar leyendo ese. Aunque se llame igual, no vale y la instalación falla con
> *Invalid certificate chain*. Este comando lo deja apuntando al bueno.

## 7. Desplegar desde StreamProbe

1. Arranca StreamProbe en el Mac, accesible desde la red:
   ```bash
   npx next dev -H 0.0.0.0 -p 3001
   ```
2. Abre `http://localhost:3001` → pestaña **Deploy TV**.
3. Rellena:

   | Campo | Valor |
   |---|---|
   | Plataforma | **Samsung Tizen** |
   | IP de la TV | la IP de la tele (p. ej. `192.168.0.133`) |
   | Este Mac (dev server) | `<IP-del-Mac>:3001` (p. ej. `192.168.0.134:3001`) |
   | Perfil de certificado | **`StreamProbe`**. En la interfaz pone "opcional", pero para Samsung es obligatorio |
   | Stream que abrirá esta tele | opcional: una URL que se cargará sola al abrir la app |

4. Pulsa **▶ Deploy**. El log tiene que terminar en:
   ```
   app_id[StrmProbe1.StreamProbe] install completed
   Tizen application is successfully installed.
   ✔ Deploy completado.
   ```

La app aparece en la tele como **StreamProbe** dentro de Apps. También puedes abrirla desde el Mac:

```bash
tizen run -p StrmProbe1.StreamProbe -t <nombre-del-dispositivo>
# p. ej.: tizen run -p StrmProbe1.StreamProbe -t TQ55QN90DATXXC
```

> Si ya estaba abierta, `tizen run` solo la trae al frente sin recargarla. Para ver cambios de
> código, ciérrala en la tele (mantén pulsado **Atrás**) y vuelve a abrirla.

<details>
<summary>Lo mismo sin interfaz (terminal)</summary>

```bash
curl -sN -X POST http://localhost:3001/api/deploy \
  -H 'Content-Type: application/json' \
  -d '{"platform":"tizen","action":"deploy","tvIp":"<IP-de-la-tele>","macHost":"<IP-del-Mac>:3001","securityProfile":"StreamProbe"}'
```

</details>

---

## Uso con el mando

| Tecla | Qué hace |
|---|---|
| **Flechas** | Mueven el foco al control más cercano en esa dirección (borde verde) |
| **Izquierda / derecha** en el borde de un panel | Saltan entre la columna de configuración y el panel del player |
| **OK** | Pulsa el botón que tiene el foco: abre pestañas (Chart, Events, Network, Manifest…), despliega filas, etc. |
| **OK** sobre un campo de texto | Abre el teclado de pantalla |
| **Done** del teclado / **OK** otra vez | Cierra el teclado |

Al pasar por un campo de texto con las flechas **no se abre el teclado**. El campo se marca
con un borde discontinuo y la siguiente flecha te saca de él. El teclado solo aparece al pulsar OK
sobre el campo; entonces el borde pasa a ser continuo.

---

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `install failed[118, -12] … Invalid certificate chain` (se queda en el 28 %) | La app está firmada con un certificado que no es de Samsung, o el CLI lee un perfil viejo | Crea el certificado Samsung (paso 5) y apunta el CLI a él (paso 6) |
| `sdb connect` falla aunque la tele esté en modo desarrollador | La **Host PC IP** de la tele no coincide con la IP actual del Mac. Las IPs por DHCP cambian | Corrige la IP en la tele (paso 3, nota del campo bloqueado). Mejor aún: reserva IPs fijas en el router para el Mac y la tele |
| La tele no responde en su IP de siempre | La tele ha cambiado de IP | Búscala con el bucle de `nc` del paso 4 |
| El puerto 26101 sigue cerrado tras activar el modo | No se apagó del todo | Apágala manteniendo pulsado el botón de encendido o desenchúfala |
| No sale el DUID en el Certificate Manager | La tele no está conectada por `sdb` | `sdb connect <IP-de-la-tele>` y vuelve a abrir el asistente |
| El Deploy dice que no encuentra `tizen` | El servidor se arrancó sin el PATH de Tizen | Para el servidor y arráncalo desde una terminal nueva (paso 1, PATH) |
| `There is no connected target` | El CLI espera el **nombre** del dispositivo, no la IP | El Deploy de StreamProbe ya lo resuelve solo. Si usas el CLI a mano, usa el nombre de `sdb devices` |
| La app abre una pantalla vacía o un error de conexión | Cambió la IP del Mac o el servidor no está arrancado | Arranca el servidor y vuelve a hacer Deploy con la IP nueva del Mac |
| Sigue saliendo el icono antiguo | Caché de iconos de la tele | Apágala y enciéndela |
