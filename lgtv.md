# StreamProbe en una LG TV (webOS)

Guía completa para instalar StreamProbe como **app** en una tele LG y manejarlo con el mando:
desde instalar las herramientas en el Mac hasta registrar la tele con su clave de desarrollador.

Probado en una **LG 55QNED93A6A (webOS, SDK 10.3.1)** desde un Mac.

> **¿Solo quieres probar rápido?** Abre el navegador de la propia tele y ve a
> `http://<IP-del-Mac>:3001`. No hace falta nada de lo que sigue. Pero ojo: en LG el navegador es
> **más capaz que el runtime de las apps**. Si estás reproduciendo un fallo de una app real (p. ej.
> Infinity), instala StreamProbe como app: así corre en el mismo entorno que ella, con menos memoria
> y el MSE propio de las apps.

---

## Cómo funciona

La app que se instala en la tele (`.ipk`) es solo un **lanzador**: al abrirse, redirige a tu
servidor de StreamProbe en el Mac (`http://<IP-del-Mac>:3001`). Por eso:

- **El Mac tiene que tener StreamProbe arrancado** y estar en la **misma red** que la tele.
- Cualquier cambio en el código se ve en la tele con solo cerrar la app y volver a abrirla. **No hace
  falta reinstalar**, salvo que cambie la IP del Mac.
- Por defecto la app corre en el **modo normal** de webOS. En el Deploy hay una casilla **Modo
  NetCast (como Infinity)** que la instala con `trustLevel: "netcast"`, el mismo contenedor que la
  app de Mitele/Infinity, para reproducir sus fallos con sus mismos permisos. **Ojo: en modo
  NetCast la tele bloquea toda la entrada de texto**: no sale el teclado y ni siquiera un teclado
  USB escribe. Úsalo solo cuando necesites esa fidelidad y lleva la URL ya puesta desde el Deploy.

A diferencia de Samsung, **LG no pide certificado**: basta con la clave de desarrollador que se
descarga de la propia tele (paso 4). Lo único que necesitas es una **cuenta LG**.

## Resumen

| Paso | Qué | Se hace |
|---|---|---|
| 1 | Instalar el CLI de webOS (`ares`) | Una vez por Mac |
| 2 | Crear una cuenta LG | Una vez |
| 3 | Activar el modo desarrollador en la tele | Una vez por tele (y renovar la sesión cada ~50 h) |
| 4 | Registrar la tele y descargar su clave | Una vez por tele (y al renovar la sesión) |
| 5 | Desplegar desde StreamProbe | Cada vez que quieras reinstalar |

---

## 1. Instalar el CLI de webOS en el Mac

Necesitas Node.js. Instala el CLI **de webOS TV**:

```bash
npm i -g @webos-tools/cli
```

> **No instales `@webosose/ares-cli`.** Es el de webOS OSE (otra variante), no trae `ares-novacom`
> (imprescindible para el paso 4) y choca con el bueno si tienes los dos.

Comprueba:

```bash
which ares-package ares-setup-device ares-novacom
```

> **Importante:** el servidor de StreamProbe tiene que arrancarse **desde una terminal que ya tenga
> `ares` en el PATH**. Si no, el botón Deploy dirá que no encuentra `ares-package`.

## 2. Crear una cuenta LG

Crea una cuenta en <https://www.lg.com/developer> (o desde la propia tele) y **verifica el email**.
Tiene que ser una **cuenta LG**: iniciar sesión con Google **no vale** para el modo desarrollador.

## 3. Activar el modo desarrollador en la tele

1. En la tele, abre la tienda de apps (**LG Content Store** / *Apps*), busca **Developer Mode** e
   instálala.
2. Ábrela e inicia sesión con tu **cuenta LG**.
3. Activa **Dev Mode Status** → la tele se reinicia.
4. Vuelve a abrir **Developer Mode** y activa **Key Server**.
5. Apunta los dos datos que muestra: la **IP** de la tele y el **Passphrase** (6 caracteres).

> **La sesión caduca a las ~50 horas.** La app muestra el tiempo que queda; pulsa **Extend Session
> Time** antes de que llegue a cero. Si caduca, el modo desarrollador se desactiva y las apps
> instaladas por ti desaparecen. Cuando cambia el passphrase, repite el paso 4.

## 4. Registrar la tele y descargar su clave

Con la IP y el passphrase del paso 3:

```bash
# 1) Dar de alta la tele con el nombre "lgtv"
ares-setup-device -a lgtv -i "host=<IP-de-la-tele>" -i "port=9922" -i "username=prisoner"

# 2) Descargar la clave de desarrollador (pide el passphrase)
ares-novacom -d lgtv --getkey

# 3) Decirle a ares que use esa clave
ares-setup-device -m lgtv -i "privatekey=lgtv_webos" -i "passphrase=<PASSPHRASE>"

# 4) Comprobar la conexión: debe mostrar el modelo y la versión de webOS
ares-device -i -d lgtv
```

`lgtv` es el **nombre** con el que ares conoce a la tele. Puedes usar otro, pero entonces escríbelo
también en el campo *Perfil ares* del paso 5.

> Si `--getkey` falla con *"Failed to get ssh private key"*: el **Key Server está apagado** o el
> passphrase ha caducado. Actívalo en la app Developer Mode y vuelve a probar con el passphrase que
> se muestre en ese momento.

## 5. Desplegar desde StreamProbe

1. Arranca StreamProbe en el Mac, accesible desde la red:
   ```bash
   npx next dev -H 0.0.0.0 -p 3001
   ```
2. Abre `http://localhost:3001` → pestaña **Deploy TV**.
3. Rellena:

   | Campo | Valor |
   |---|---|
   | Plataforma | **LG webOS** |
   | IP de la TV | la IP de la tele |
   | Este Mac (dev server) | `<IP-del-Mac>:3001` (se rellena solo) |
   | Perfil ares (registrado) | `lgtv` (el nombre del paso 4) |
   | Stream que abrirá esta tele | opcional: una URL que se cargará sola al abrir la app |

4. Pulsa **▶ Deploy**. Empaqueta el `.ipk`, lo instala y abre la app en la tele.

Si la IP de la tele ha cambiado, no hace falta repetir el paso 4: el Deploy actualiza la IP del
registro de `lgtv` con la que escribas, y mantiene la clave.

<details>
<summary>Lo mismo a mano (terminal)</summary>

```bash
ares-package tv-launchers/webos -o tv-launchers/dist
ares-install -d lgtv tv-launchers/dist/com.streamprobe.app_1.0.0_all.ipk
ares-launch  -d lgtv com.streamprobe.app
```

A mano, la URL del Mac no se reescribe: edítala en `tv-launchers/webos/index.html` antes de
empaquetar.

</details>

### Comandos útiles

```bash
ares-launch  -d lgtv com.streamprobe.app           # abrir la app
ares-launch  -d lgtv --close com.streamprobe.app   # cerrarla (para recargar cambios)
ares-install -d lgtv --list                        # apps instaladas
ares-inspect -d lgtv -a com.streamprobe.app        # DevTools de la app en el Mac (consola, red…)
```

> Las apps instaladas en modo desarrollador **no siempre aparecen en el inicio** de la tele. Ábrela
> con `ares-launch` o volviendo a darle a Deploy.

`ares-inspect` es la gran ventaja de LG: abre el inspector de Chrome conectado a la app que corre
en la tele, con la consola y la pestaña de red reales.

---

## Uso con el mando

| Tecla | Qué hace |
|---|---|
| **Puntero** (Magic Remote) | Se mueve como un ratón; pulsa con la rueda/OK |
| **Flechas** | Mueven el foco al control más cercano en esa dirección (borde verde) |
| **Izquierda / derecha** en el borde de un panel | Saltan entre la columna de configuración y el panel del player |
| **OK** | Pulsa el botón que tiene el foco: abre pestañas (Chart, Events, Network, Manifest…), despliega filas, etc. |

> **Compare A/B no funciona en la tele**: solo hay un decodificador de vídeo por hardware. Usa el
> modo Single.

---

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `ares-novacom --getkey` → *Failed to get ssh private key* | Key Server apagado o passphrase caducado | Activa **Key Server** en la app Developer Mode y usa el passphrase actual |
| `ares-device -i` no conecta | Sesión de desarrollador caducada, IP cambiada o redes distintas | Revisa la app Developer Mode (sesión y IP). Mac y tele en la **misma Wi-Fi**; la **VPN** corporativa también lo rompe |
| La app instalada ha desaparecido | Caducó la sesión de 50 h y se desactivó el modo desarrollador | Reactívalo, pulsa **Extend Session Time** y vuelve a hacer Deploy |
| No encuentro la app en la tele | Las apps de desarrollo no siempre salen en el inicio | `ares-launch -d lgtv com.streamprobe.app` |
| No se puede instalar Developer Mode / no deja iniciar sesión | Sesión iniciada con Google | Usa una **cuenta LG** con el email verificado |
| `ares-novacom: command not found` | Tienes instalado `@webosose/ares-cli` | Desinstálalo e instala `@webos-tools/cli` |
| El Deploy dice que no encuentra `ares-package` | El servidor se arrancó sin `ares` en el PATH | Para el servidor y arráncalo desde una terminal nueva |
| La app abre una pantalla vacía o un error de conexión | Cambió la IP del Mac o el servidor no está arrancado | Arranca el servidor y vuelve a hacer Deploy con la IP nueva del Mac |
| No sale el teclado y no se puede escribir en ningún campo (tampoco con teclado USB) | La app está instalada en **Modo NetCast** | Vuelve a hacer Deploy con la casilla *Modo NetCast* desmarcada |
| En la tele no se reproduce igual que en la app real | Estás en el **navegador** de la tele, no en la app | Instálala como app: el navegador de LG tiene más recursos que el runtime de las apps |
