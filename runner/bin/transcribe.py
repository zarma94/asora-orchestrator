#!/usr/bin/env python3
"""Local voice-note transcription — faster-whisper (CTranslate2, CPU, no torch, no API key).
Usage: transcribe.py <audio-file>  → prints the transcript on stdout.
Auto-detects language (EN/DE/SL). Model cached after first load."""
import sys

_M = None
MODEL_SIZE = "base"   # good CPU speed/quality for short voice notes; multilingual


def model():
    global _M
    if _M is None:
        from faster_whisper import WhisperModel
        _M = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    return _M


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: transcribe.py <audio-file>")
    try:
        segments, info = model().transcribe(sys.argv[1], beam_size=1, vad_filter=True)
        text = "".join(s.text for s in segments).strip()
        sys.stdout.write(text)
    except Exception as e:
        sys.stderr.write(f"transcribe error: {e}")
        sys.exit(1)
