#!/usr/bin/env python3
"""Local text embedder — fastembed / onnxruntime, no API key, no torch. Model runs on CPU and
is cached after first load. stdin: JSON list of strings. stdout: JSON list of float vectors.
Used by brainsearch.js for semantic recall (complements the lexical FTS)."""
import sys, json

_M = None
MODEL = "BAAI/bge-small-en-v1.5"   # 384-dim, ~130MB, strong small English/multilingual-ish model


def model():
    global _M
    if _M is None:
        from fastembed import TextEmbedding
        _M = TextEmbedding(model_name=MODEL)
    return _M


if __name__ == "__main__":
    try:
        texts = json.load(sys.stdin)
    except Exception:
        texts = []
    if not isinstance(texts, list):
        texts = [str(texts)]
    texts = [str(t)[:2000] for t in texts]
    if not texts:
        json.dump([], sys.stdout); sys.exit(0)
    vecs = [[round(float(x), 6) for x in v] for v in model().embed(texts)]
    json.dump(vecs, sys.stdout)
