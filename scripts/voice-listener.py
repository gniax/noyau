#!/usr/bin/env python3
"""Transcription continue pour Noyau: lit du PCM 16 kHz mono sur stdin, ecrit du JSON par ligne.

Le micro est fourni par arecord cote Node: aucune dependance audio native ici.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".data", "voice", "pylibs"))

from vosk import KaldiRecognizer, Model, SetLogLevel  # noqa: E402

SetLogLevel(-1)

MODEL_PATH = os.environ.get("NOYAU_VOICE_MODEL")
SAMPLE_RATE = int(os.environ.get("NOYAU_VOICE_RATE", "16000"))
BLOCK = int(os.environ.get("NOYAU_VOICE_BLOCK", "4000"))


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    if not MODEL_PATH or not os.path.isdir(MODEL_PATH):
        emit({"type": "error", "message": f"Modèle vocal introuvable: {MODEL_PATH}"})
        return 1

    recognizer = KaldiRecognizer(Model(MODEL_PATH), SAMPLE_RATE)
    recognizer.SetWords(False)
    emit({"type": "ready", "rate": SAMPLE_RATE})

    stream = sys.stdin.buffer
    last_partial = ""
    while True:
        data = stream.read(BLOCK)
        if not data:
            break
        if recognizer.AcceptWaveform(data):
            text = json.loads(recognizer.Result()).get("text", "").strip()
            last_partial = ""
            if text:
                emit({"type": "final", "text": text})
        else:
            partial = json.loads(recognizer.PartialResult()).get("partial", "").strip()
            # On ne repete pas un partiel identique: le flux reste lisible cote Node.
            if partial and partial != last_partial:
                last_partial = partial
                emit({"type": "partial", "text": partial})

    text = json.loads(recognizer.FinalResult()).get("text", "").strip()
    if text:
        emit({"type": "final", "text": text})
    return 0


if __name__ == "__main__":
    sys.exit(main())
