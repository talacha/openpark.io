"""Plate-reading engines behind one interface.

Pipeline (see ARCHITECTURE.md, "AI plate reading"):
  1. OnnxEngine  - open-image-models detector + fast-plate-ocr (CPU by default)
  2. VlmEngine   - any OpenAI-compatible vision server, second opinion + vehicle attributes
Models are pinned by SHA-256 when OPENPARK_MODEL_SHA256 is set.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Protocol

import httpx
import numpy as np
from PIL import Image


@dataclass
class Candidate:
    text: str
    confidence: float
    region: str | None = None
    engine: str = ""


@dataclass
class ReadResult:
    candidates: list[Candidate]
    crop: bytes | None = None  # the plate crop only, never the full frame
    vehicle: dict | None = None
    latency_ms: int = 0
    notes: list[str] = field(default_factory=list)


class Engine(Protocol):
    name: str

    def read(self, image: Image.Image, region: str | None) -> ReadResult: ...


def decode_image(b64: str) -> Image.Image:
    raw = base64.b64decode(b64.split(",", 1)[-1], validate=False)
    img = Image.open(io.BytesIO(raw))
    return img.convert("RGB")


def to_jpeg(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def check_model_pin(path: str) -> None:
    """Refuse to load a model file whose hash is not the pinned one."""
    want = os.environ.get("OPENPARK_MODEL_SHA256")
    if not want:
        return
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    if h.hexdigest() != want.lower():
        raise RuntimeError(f"model {path} does not match pinned hash")


def vote(frames: list[list[Candidate]]) -> Candidate | None:
    """Per-character majority vote over 3-5 frames; accept only when frames agree.

    Frames of different lengths vote only among the most common length. The returned
    confidence is scaled by agreement so disagreement lowers it below the site threshold.
    """
    reads = [c[0] for c in frames if c]
    if not reads:
        return None
    lengths = [len(r.text) for r in reads]
    length = max(set(lengths), key=lengths.count)
    same = [r for r in reads if len(r.text) == length]
    out, agree = [], 0.0
    for i in range(length):
        col = [r.text[i] for r in same]
        ch = max(set(col), key=col.count)
        out.append(ch)
        agree += col.count(ch) / len(col)
    agreement = agree / length if length else 0.0
    mean_conf = float(np.mean([r.confidence for r in same]))
    return Candidate(
        text="".join(out),
        confidence=round(mean_conf * agreement * (len(same) / len(reads)), 4),
        region=same[0].region,
        engine=same[0].engine,
    )


class OnnxEngine:
    """fast-alpr: YOLOv9-tiny plate detector + cct-s-v2-global-model OCR."""

    name = "fast-alpr"

    def __init__(self) -> None:
        from fast_alpr import ALPR  # imported lazily: optional dependency

        self._alpr = ALPR(
            detector_model=os.environ.get("OPENPARK_DETECTOR", "yolo-v9-t-384-license-plate-end2end"),
            ocr_model=os.environ.get("OPENPARK_OCR", "cct-s-v2-global-model"),
        )

    def read(self, image: Image.Image, region: str | None) -> ReadResult:
        t0 = time.perf_counter()
        results = self._alpr.predict(np.asarray(image)[:, :, ::-1])  # RGB -> BGR for OpenCV
        cands: list[Candidate] = []
        crop = None
        best = -1.0
        for r in results:
            ocr = r.ocr
            if ocr is None or not ocr.text:
                continue
            conf = ocr.confidence
            conf = float(np.mean(conf)) if isinstance(conf, (list, tuple, np.ndarray)) else float(conf)
            reg = getattr(ocr, "region", None)
            cands.append(Candidate(ocr.text.replace("_", ""), conf, None if reg in (None, "", "Unknown") else reg, self.name))
            if conf > best:
                best = conf
                x1, y1, x2, y2 = (int(v) for v in (r.detection.bounding_box.x1, r.detection.bounding_box.y1,
                                                   r.detection.bounding_box.x2, r.detection.bounding_box.y2))
                crop = to_jpeg(image.crop((x1, y1, x2, y2)))
        cands.sort(key=lambda c: c.confidence, reverse=True)
        return ReadResult(cands, crop, None, int((time.perf_counter() - t0) * 1000))


VLM_PROMPT = (
    "Read the licence plate of the vehicle in the image. Reply with JSON only: "
    '{"plate": string|null, "region": ISO-3166 code|null, "body_type": string|null, '
    '"make": string|null, "model": string|null, "color": string|null, "confidence": number 0-1}. '
    "Keep the plate exactly as printed; use null when unsure."
)


class VlmEngine:
    """Any OpenAI-compatible server (llama.cpp, vLLM, Ollama) running a vision model such as Qwen3.5."""

    name = "vlm"

    def __init__(self, base_url: str, model: str, api_key: str | None = None, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self.timeout = timeout

    def read(self, image: Image.Image, region: str | None) -> ReadResult:
        t0 = time.perf_counter()
        data_url = "data:image/jpeg;base64," + base64.b64encode(to_jpeg(image)).decode()
        body = {
            "model": self.model,
            "temperature": 0,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": VLM_PROMPT + (f" Expected region: {region}." if region else "")},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]}],
        }
        resp = httpx.post(f"{self.base_url}/chat/completions", json=body, headers=self.headers, timeout=self.timeout)
        resp.raise_for_status()
        parsed = parse_vlm_json(resp.json()["choices"][0]["message"]["content"])
        latency = int((time.perf_counter() - t0) * 1000)
        if not parsed or not parsed.get("plate"):
            return ReadResult([], None, None, latency, ["vlm: no plate"])
        conf = float(parsed.get("confidence") or 0.5)
        vehicle = {k: parsed.get(src) for k, src in
                   (("bodyType", "body_type"), ("make", "make"), ("model", "model"), ("color", "color")) if parsed.get(src)}
        return ReadResult([Candidate(str(parsed["plate"]), min(max(conf, 0.0), 1.0), parsed.get("region"), self.name)],
                          None, vehicle or None, latency)


def parse_vlm_json(text: str) -> dict | None:
    """Models wrap JSON in prose or code fences; take the first object."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
