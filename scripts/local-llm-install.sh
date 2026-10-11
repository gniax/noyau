#!/usr/bin/env bash
# Installe le petit modele local utilise pour la relecture des to-do et commentaires.
# Aucun quota IA n'est consomme: llama.cpp sert le modele sur la machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${NOYAU_DATA_DIR:-$ROOT/.data}/llm"
LLAMA_RELEASE="b6280"
MODEL_SMALL_URL="https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
MODEL_LARGE_URL="https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"

mkdir -p "$DIR"
cd "$DIR"

if [ ! -x "build/bin/llama-server" ]; then
  echo "→ llama.cpp ($LLAMA_RELEASE)"
  curl -sL -o llama.zip "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_RELEASE/llama-$LLAMA_RELEASE-bin-ubuntu-x64.zip"
  python3 -c "import zipfile; zipfile.ZipFile('llama.zip').extractall('.')"
  rm -f llama.zip
  chmod +x build/bin/*
fi

if [ ! -f "qwen.gguf" ]; then
  echo "→ Modèle Qwen2.5 1.5B quantifié (~1,1 Go) — relecture, repli mémoire"
  curl -L -o qwen.gguf "$MODEL_SMALL_URL"
fi

if [ ! -f "qwen3b.gguf" ]; then
  echo "→ Modèle Qwen2.5 3B quantifié (~2,0 Go) — analyse et classement"
  curl -L -o qwen3b.gguf "$MODEL_LARGE_URL"
fi

echo "→ Test"
"$DIR/build/bin/llama-server" -m "$DIR/qwen.gguf" -t 4 -c 512 --port 8119 --host 127.0.0.1 >/dev/null 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  sleep 1
  if curl -s -m 2 http://127.0.0.1:8119/health >/dev/null 2>&1; then break; fi
done
curl -s -m 2 http://127.0.0.1:8119/health && echo " → modèle prêt"
kill "$PID" 2>/dev/null || true

echo
echo "Installé. Noyau démarre le modèle à la demande et l'arrête après 5 minutes sans usage."
echo "3B (~1,9 Go de RAM) si la machine a plus de 2,2 Go libres, 1.5B (~1,0 Go) sinon."
