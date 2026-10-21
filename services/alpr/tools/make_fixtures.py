"""Generates plate images and records what the reference Python pipeline (fast-alpr) reads from them.

The TypeScript port in apps/web/src/alpr is tested against expected.json: same text, near-identical confidence and box.
Run: .venv/bin/python tools/make_fixtures.py ../../apps/web/test/fixtures/plates
"""
import json
import os
import sys

import numpy as np
from fast_alpr import ALPR
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
FONTS = [p for p in [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Courier New Bold.ttf",
] if os.path.exists(p)]

CASES = [
    # name, text, plate box (x, y, w, h), image size, plate colour, text colour, font idx, font size
    ("mx-abc123", "ABC 123", (180, 300, 300, 90), (640, 480), "white", "black", 0, 60),
    ("mx-xyz789", "XYZ-789", (120, 250, 360, 110), (800, 600), "white", "black", 2, 72),
    ("br-mercosul", "BRA2E19", (220, 330, 340, 100), (800, 600), "white", "black", 2, 64),
    ("us-yellow", "7KLM842", (160, 280, 380, 110), (800, 600), "#f5d04a", "#1a1a1a", 0, 66),
    ("small-far", "QRS456", (330, 380, 150, 46), (800, 600), "white", "black", 0, 32),
    ("de-two", "B MW 4521", (150, 260, 400, 100), (800, 600), "white", "black", 2, 62),
]


def render(text, box, size, plate, ink, fidx, fsize):
    img = Image.new("RGB", size, (88, 92, 96))
    d = ImageDraw.Draw(img)
    # a little scene noise so the detector has something to ignore
    rng = np.random.default_rng(7)
    for _ in range(40):
        x, y = int(rng.integers(0, size[0])), int(rng.integers(0, size[1]))
        d.rectangle((x, y, x + int(rng.integers(5, 40)), y + int(rng.integers(5, 40))), fill=tuple(int(v) for v in rng.integers(60, 130, 3)))
    x, y, w, h = box
    d.rectangle((x, y, x + w, y + h), fill=plate, outline="black", width=4)
    font = ImageFont.truetype(FONTS[fidx % len(FONTS)], fsize)
    tw = d.textlength(text, font=font)
    d.text((x + (w - tw) / 2, y + (h - fsize) / 2 - 4), text, fill=ink, font=font)
    return img


alpr = ALPR(detector_model="yolo-v9-t-384-license-plate-end2end", ocr_model="cct-s-v2-global-model")
expected = {}
os.makedirs(OUT, exist_ok=True)
for name, text, box, size, plate, ink, fidx, fsize in CASES:
    img = render(text, box, size, plate, ink, fidx, fsize)
    path = os.path.join(OUT, f"{name}.jpg")
    img.save(path, quality=95)
    # Read it back from the JPEG, exactly as the TypeScript side will, so both start from identical pixels.
    arr = np.asarray(Image.open(path).convert("RGB"))[:, :, ::-1]
    res = alpr.predict(arr)
    reads = []
    for r in res:
        o = r.ocr
        probs = o.confidence if isinstance(o.confidence, (list, tuple, np.ndarray)) else [o.confidence]
        txt = (o.text or "").replace("_", "")
        reads.append({
            "text": txt,
            "confidence": float(np.mean([float(p) for p in list(probs)[: max(len(txt), 1)]])) if txt else 0.0,
            "box": [int(r.detection.bounding_box.x1), int(r.detection.bounding_box.y1), int(r.detection.bounding_box.x2), int(r.detection.bounding_box.y2)],
            "detection": float(r.detection.confidence),
        })
    expected[name] = {"drawn": text, "reads": reads}
    print(name, "drawn:", text, "->", [(x["text"], round(x["confidence"], 3)) for x in reads])

# A frame with no plate at all must read nothing.
Image.new("RGB", (640, 480), (90, 90, 90)).save(os.path.join(OUT, "empty.jpg"), quality=95)
arr = np.asarray(Image.open(os.path.join(OUT, "empty.jpg")).convert("RGB"))[:, :, ::-1]
expected["empty"] = {"drawn": None, "reads": [{"text": r.ocr.text, "box": [int(r.detection.bounding_box.x1)]} for r in alpr.predict(arr)]}
json.dump(expected, open(os.path.join(OUT, "expected.json"), "w"), indent=2)
print("empty ->", expected["empty"]["reads"])
