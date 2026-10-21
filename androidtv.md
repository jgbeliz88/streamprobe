# StreamProbe en Android TV / Google TV / Fire TV

Guía completa para instalar StreamProbe como **app** en una tele o un dispositivo Android y
manejarlo con el mando: desde instalar las herramientas en el Mac hasta activar la depuración en la
tele.

Probado en una **Xiaomi Mi TV** desde un Mac.

Un mismo APK sirve para **Android TV y Google TV** (Sony, Philips nuevas, TCL, Xiaomi, Nvidia
Shield, Chromecast con Google TV…) y para **Amazon Fire TV**, que por dentro es Android. También se
instala en móviles y tablets Android.

> **¿Solo quieres probar rápido?** Abre un navegador en la tele (si tiene; muchas Android TV no
> traen ninguno) y ve a `http://<IP-del-Mac>:3001`.

---

## Cómo funciona

La app (`.apk`) es un **WebView a pantalla completa** que abre tu servidor de StreamProbe en el Mac
(`http://<IP-del-Mac>:3001`). Por eso:

- **El Mac tiene que tener StreamProbe arrancado** y estar en la **misma red** que la tele.
- Cualquier cambio en el código se ve en la tele con solo cerrar la app y volver a abrirla. **No hace
  falta reinstalar**, salvo que cambie la IP del Mac.

En Android **no hace falta certificado ni cuenta**: la app se firma sola con la clave de depuración
del Mac y se instala por red con `adb`. Lo único que hay que hacer en la tele es activar la
depuración.

Detalles del wrapper (`tv-launchers/androidtv/`) que conviene conocer:

- **Reproducción automática sin gesto**: con un mando no hay forma de dar el "clic" que el WebView
  pediría.
- **Admite `http://`** (sin HTTPS), porque el servidor del Mac va por HTTP en la red local.
- **Sale en el inicio** de Android TV y de Fire TV como **StreamProbe**.
- **Funciona desde Android 5.0** (API 21), para poder probar en cajas y sticks antiguos.
- **La consola del navegador se envía al log de Android**, así que ves los logs del player desde el
  Mac (ver [Logs](#logs-del-player)).

## Resumen

| Paso | Qué | Se hace |
|---|---|---|
| 1 | Instalar Java, Gradle, el Android SDK y `adb` | Una vez por Mac |
| 2 | Activar las opciones de desarrollador y la depuración en la tele | Una vez por tele |
| 3 | Conectar el Mac a la tele (`adb`) y autorizarlo | La primera vez, y tras reiniciar el Mac o la tele |
| 4 | Desplegar desde StreamProbe | Cada vez que quieras reinstalar |

---

## 1. Instalar las herramientas en el Mac

Con [Homebrew](https://brew.sh):

```bash
# Java 17 y Gradle (compilan el APK)
brew install openjdk@17 gradle

# Android SDK (línea de comandos) y adb
brew install --cask android-commandlinetools android-platform-tools

# Los paquetes del SDK que usa el proyecto
yes | sdkmanager --licenses
sdkmanager "platforms;android-34" "build-tools;34.0.0"
```

Comprueba:

```bash
which gradle adb sdkmanager
java -version      # tiene que ser 17 o superior
```

No hace falta definir `ANDROID_HOME`: el Deploy de StreamProbe busca el SDK solo en las rutas
habituales (Homebrew y Android Studio). Si ya tienes **Android Studio**, su SDK también vale.

> **Importante:** el servidor de StreamProbe tiene que arrancarse **desde una terminal que ya tenga
> `gradle` y `adb` en el PATH**. Si no, el botón Deploy dirá que no los encuentra.

## 2. Activar la depuración en la tele

El menú cambia según la marca. Primero se desbloquean las **opciones para desarrolladores**
pulsando 7 veces en el número de compilación; después se activa la depuración.

| Dispositivo | Desbloquear opciones de desarrollador | Activar depuración |
|---|---|---|
| **Android TV** (Xiaomi, Sony, Philips…) | Ajustes → Preferencias del dispositivo → Información → pulsa **7 veces** en **Compilación** | Preferencias del dispositivo → Opciones para desarrolladores → **Depuración USB** ON |
| **Google TV** (TCL, Sony nuevas, Chromecast con Google TV) | Ajustes → Sistema → Información → pulsa **7 veces** en **Compilación del SO de Android TV** | Sistema → Opciones para desarrolladores → **Depuración USB** ON |
| **Fire TV** | Configuración → Mi Fire TV → Información → pulsa **7 veces** sobre el **nombre del dispositivo** | Mi Fire TV → Opciones para desarrolladores → **Depuración ADB** ON |

Al pulsar 7 veces sale el aviso *"Ya eres desarrollador"*. Si en las opciones también hay
**Depuración por red** o **ADB por red**, actívala.

> Aunque se llame "Depuración **USB**", en las teles activa también la conexión por red en el
> puerto **5555**, que es la que usa StreamProbe.

Apunta la IP de la tele: **Ajustes → Red e Internet** (o *Red* → *Estado*).

## 3. Conectar el Mac a la tele

Con el script del repo, que además te dice qué falla si no conecta:

```bash
./tv-launchers/androidtv/connect.sh <IP-de-la-tele>
```

La **primera vez**, la tele muestra el aviso **"¿Permitir la depuración USB?"** con la huella del
Mac. Marca **Permitir siempre desde este ordenador** y acepta con el mando. Después vuelve a
ejecutar el script. Cuando todo está bien, muestra:

```
✓ conectado y autorizado
  modelo : <modelo de la tele>
  Android: <versión> (API <n>)
```

A mano, sin el script:

```bash
adb connect <IP-de-la-tele>:5555
adb devices
# <IP-de-la-tele>:5555    device        ← "unauthorized" = falta aceptar el aviso en la tele
```

## 4. Desplegar desde StreamProbe

1. Arranca StreamProbe en el Mac, accesible desde la red:
   ```bash
   npx next dev -H 0.0.0.0 -p 3001
   ```
2. Abre `http://localhost:3001` → pestaña **Deploy TV**.
3. Rellena:

   | Campo | Valor |
   |---|---|
   | Plataforma | **Android TV / Google TV** |
   | IP de la TV | la IP de la tele (sin `:5555`) |
   | Este Mac (dev server) | `<IP-del-Mac>:3001` (se rellena solo) |
   | Stream que abrirá esta tele | opcional: una URL que se cargará sola al abrir la app |

4. Pulsa **▶ Deploy**. Conecta por `adb`, compila el APK con Gradle, lo instala y abre la app.

La **primera compilación tarda** (Gradle descarga sus dependencias). Las siguientes van mucho más
rápidas.

La app queda en el inicio de la tele como **StreamProbe**.

<details>
<summary>Lo mismo a mano (terminal)</summary>

```bash
gradle -p tv-launchers/androidtv assembleDebug
adb -s <IP-de-la-tele>:5555 install -r tv-launchers/androidtv/app/build/outputs/apk/debug/app-debug.apk
adb -s <IP-de-la-tele>:5555 shell am start -n com.streamprobe.app/.MainActivity
```

A mano, la URL del Mac no se reescribe: edítala en
`tv-launchers/androidtv/app/src/main/res/values/strings.xml` (`dev_server_url`) antes de compilar.

</details>

### Comandos útiles

```bash
# Abrir / cerrar la app (cerrar = recargar cambios al volver a abrirla)
adb -s <IP>:5555 shell am start -n com.streamprobe.app/.MainActivity
adb -s <IP>:5555 shell am force-stop com.streamprobe.app

# Desinstalarla
adb -s <IP>:5555 uninstall com.streamprobe.app
```

### Logs del player

La consola del navegador de la app se envía al log de Android con la etiqueta `StreamProbe`:

```bash
adb -s <IP-de-la-tele>:5555 logcat -s StreamProbe
```

---

## Uso con el mando

| Tecla | Qué hace |
|---|---|
| **Flechas** | Mueven el foco al control más cercano en esa dirección (borde verde) |
| **Izquierda / derecha** en el borde de un panel | Saltan entre la columna de configuración y el panel del player |
| **OK** | Pulsa el botón que tiene el foco: abre pestañas (Chart, Events, Network, Manifest…), despliega filas, etc. |
| **OK** sobre un campo de texto | Abre el teclado de pantalla |
| **OK** otra vez | Cierra el teclado |
| **Atrás** | Vuelve a la página anterior dentro de la app; si no hay, sale de la app |

Al pasar por un campo de texto con las flechas **no se abre el teclado**. El campo se marca
con un borde discontinuo y la siguiente flecha te saca de él. El teclado solo aparece al pulsar OK
sobre el campo; entonces el borde pasa a ser continuo.

> **Compare A/B no funciona en la tele**: solo hay un decodificador de vídeo por hardware. Usa el
> modo Single.

---

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `adb devices` muestra **unauthorized** | No se ha aceptado el aviso de depuración en la tele | Acepta **¿Permitir la depuración USB?** con el mando, marcando *Permitir siempre* |
| No sale el aviso de autorización | Ya se rechazó, o la tele no lo muestra sobre otra app | Desactiva y vuelve a activar la depuración en la tele, y repite `adb connect` |
| `adb connect` → *failed to connect* / no responde | Depuración desactivada, IP cambiada o redes distintas | Revisa la depuración (paso 2) y la IP. Mac y tele en la **misma Wi-Fi**; la **VPN** corporativa también lo rompe |
| La tele solo ofrece **Depuración inalámbrica** con código de emparejamiento | Algunos Android 11+ usan otro puerto y emparejamiento | Empareja con `adb pair <IP>:<puerto> <código>` y conecta con `adb connect <IP>:<puerto>`. El Deploy de StreamProbe asume el puerto **5555**, así que en ese caso instala a mano |
| `SDK location not found` al compilar | No se encuentra el Android SDK | Instálalo (paso 1). Si está en una ruta propia, arranca el servidor con `ANDROID_HOME` apuntando a ella |
| Error de Java / versión de clase al compilar | Java anterior a 17 | `brew install openjdk@17` y que `java -version` muestre 17+ |
| El Deploy dice que no encuentra `gradle` o `adb` | El servidor se arrancó sin ellos en el PATH | Para el servidor y arráncalo desde una terminal nueva |
| La app abre una pantalla vacía o un error de conexión | Cambió la IP del Mac o el servidor no está arrancado | Arranca el servidor y vuelve a hacer Deploy con la IP nueva del Mac |
| Todo se ve a mitad de tamaño o borroso | Pantalla con densidad 2x | Ya lo corrige la app (ajusta el viewport al tamaño físico). Si pasa, cierra la app y vuelve a abrirla |
