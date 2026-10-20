"""OpenPark ALPR worker. POST /read: image in, ranked plate candidates out.

Flow: ONNX detector+OCR first; when its best read is below VLM_THRESHOLD (or there is
none) and a VLM is configured, ask the VLM and merge. The VLM also supplies vehicle attributes.
"""
from __future__ import annotations

import base64
import os
from functools import lru_cache

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .engines import Candidate, Engine, OnnxEngine, ReadResult, VlmEngine, decode_image

app = FastAPI(title="OpenPark ALPR worker", version="0.1.0")


class ReadRequest(BaseModel):
    image: str
    region: str | None = None


@lru_cache
def primary() -> Engine | None:
    if os.environ.get("OPENPARK_ONNX", "1") == "0":
        return None
    try:
        return OnnxEngine()
    except ImportError:
        return None  # install the `onnx` extra to enable


@lru_cache
def fallback() -> VlmEngine | None:
    url = os.environ.get("VLM_URL")
    if not url:
        return None
    return VlmEngine(url, os.environ.get("VLM_MODEL", "Qwen/Qwen3.5-4B"), os.environ.get("VLM_API_KEY"))


def merge(a: ReadResult, b: ReadResult) -> ReadResult:
    cands = sorted(a.candidates + b.candidates, key=lambda c: c.confidence, reverse=True)
    seen, uniq = set(), []
    for c in cands:
        key = c.text.upper().replace(" ", "").replace("-", "")
        if key not in seen:
            seen.add(key)
            uniq.append(c)
    return ReadResult(uniq, a.crop or b.crop, b.vehicle or a.vehicle, a.latency_ms + b.latency_ms, a.notes + b.notes)


def run(image_b64: str, region: str | None) -> ReadResult:
    img = decode_image(image_b64)
    threshold = float(os.environ.get("VLM_THRESHOLD", "0.9"))
    p, f = primary(), fallback()
    if p is None and f is None:
        raise HTTPException(503, "no engine available: install the onnx extra or set VLM_URL")
    result = p.read(img, region) if p else ReadResult([])
    best = result.candidates[0].confidence if result.candidates else 0.0
    if f and best < threshold:
        try:
            result = merge(result, f.read(img, region))
        except Exception as e:  # the VLM is optional; keep whatever the ONNX pair produced
            result.notes.append(f"vlm failed: {e}")
    return result


@app.get("/healthz")
def healthz():
    return {"ok": True, "onnx": primary() is not None, "vlm": fallback() is not None}


@app.post("/read")
def read(req: ReadRequest):
    try:
        r = run(req.image, req.region)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(422, f"could not read image: {e}") from e
    return {
        "candidates": [c.__dict__ for c in r.candidates],
        "crop": base64.b64encode(r.crop).decode() if r.crop else None,
        "vehicle": r.vehicle,
        "latencyMs": r.latency_ms,
        "notes": r.notes,
    }
