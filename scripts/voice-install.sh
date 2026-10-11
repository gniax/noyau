#!/usr/bin/env bash
# Installe les moteurs vocaux locaux de Noyau: Vosk (reconnaissance) et Piper (voix).
# Tout atterrit dans .data/voice, rien n'est installe a l'echelle du systeme.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_DIR="${NOYAU_DATA_DIR:-$ROOT/.data}/voice"
MODEL="vosk-model-small-fr-0.22"
PIPER_RELEASE="2023.11.14-2"
VOICE="fr_FR-siwis-medium"

mkdir -p "$VOICE_DIR/voices"
cd "$VOICE_DIR"

if ! command -v arecord >/dev/null || ! command -v aplay >/dev/null; then
  echo "arecord/aplay manquants: installer alsa-utils." >&2
  exit 1
fi

if [ ! -d "pylibs/vosk" ]; then
  echo "→ Vosk (Python, isolé dans $VOICE_DIR/pylibs)"
  pip3 install -q --break-system-packages --target "$VOICE_DIR/pylibs" vosk
fi

if [ ! -d "$MODEL" ]; then
  echo "→ Modèle de reconnaissance français (~66 Mo)"
  curl -sL -o model.zip "https://alphacephei.com/vosk/models/$MODEL.zip"
  python3 -c "import zipfile; zipfile.ZipFile('model.zip').extractall('.')"
  rm -f model.zip
fi

if [ ! -x "piper/piper" ]; then
  echo "→ Piper (synthèse vocale)"
  curl -sL -o piper.tar.gz "https://github.com/rhasspy/piper/releases/download/$PIPER_RELEASE/piper_linux_x86_64.tar.gz"
  tar xzf piper.tar.gz
  rm -f piper.tar.gz
fi

if [ ! -f "voices/$VOICE.onnx" ]; then
  echo "→ Voix française (~61 Mo)"
  curl -sL -o "voices/$VOICE.onnx" "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/$VOICE.onnx"
  curl -sL -o "voices/$VOICE.onnx.json" "https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/$VOICE.onnx.json"
fi

echo "→ Test de la voix"
echo "Noyau est prêt." | ./piper/piper --model "voices/$VOICE.onnx" --output_raw 2>/dev/null | aplay -q -r 22050 -f S16_LE -t raw - || true

echo
echo "Installé. Périphérique de capture: régler NOYAU_VOICE_DEVICE dans noyau.service si « default » ne capte rien."
echo "Périphériques disponibles:"
arecord -l | sed -n 's/^carte \([0-9]\+\).*périphérique \([0-9]\+\).*/  plughw:\1,\2/p' || arecord -l
