#!/usr/bin/env bash
# Conecta con un Android TV / Fire TV y comprueba que está listo para el deploy.
#
#   ./tv-launchers/androidtv/connect.sh 192.168.0.42
#
# Requiere que en la tele estén activadas las Opciones para desarrolladores y
# la depuración por red (Ajustes → Información → pulsar 7 veces en Compilación).
set -uo pipefail

IP="${1:-}"
if [ -z "$IP" ]; then
  echo "uso: $0 <ip-de-la-tele>   (la ves en Ajustes → Red e Internet)" >&2
  exit 1
fi
TARGET="$IP:5555"

if ! command -v adb >/dev/null 2>&1; then
  echo "✗ adb no está instalado → brew install --cask android-platform-tools" >&2
  exit 1
fi

echo "▸ conectando con $TARGET…"
adb connect "$TARGET" >/dev/null 2>&1
sleep 2

state=$(adb devices | awk -v t="$TARGET" '$1==t {print $2}')
case "$state" in
  device)
    echo "✓ conectado y autorizado"
    model=$(adb -s "$TARGET" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
    rel=$(adb -s "$TARGET" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
    sdk=$(adb -s "$TARGET" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')
    echo "  modelo : $model"
    echo "  Android: $rel (API $sdk)"
    if [ -n "${sdk:-}" ] && [ "$sdk" -lt 21 ] 2>/dev/null; then
      echo "  ⚠ API < 21: por debajo del minSdk del launcher"
    fi
    echo
    echo "Listo. Lanza el deploy desde la pestaña Deploy TV, o a mano:"
    echo "  gradle -p tv-launchers/androidtv assembleDebug"
    echo "  adb -s $TARGET install -r tv-launchers/androidtv/app/build/outputs/apk/debug/app-debug.apk"
    ;;
  unauthorized)
    echo "✗ sin autorizar: la tele está mostrando el aviso «¿Permitir la depuración?»." >&2
    echo "  Acéptalo con el mando (marca «Permitir siempre») y vuelve a ejecutar esto." >&2
    exit 1
    ;;
  "")
    echo "✗ no responde en $TARGET." >&2
    echo "  Comprueba: misma WiFi, IP correcta, y depuración por red activada en la tele." >&2
    exit 1
    ;;
  *)
    echo "✗ estado inesperado: $state" >&2
    exit 1
    ;;
esac
