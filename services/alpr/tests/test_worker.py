import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.engines import Candidate, ReadResult, parse_vlm_json, vote


def img_b64() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (64, 32), "white").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class Fake:
    def __init__(self, name, cands, vehicle=None):
        self.name, self.cands, self.vehicle = name, cands, vehicle

    def read(self, image, region):
        return ReadResult(list(self.cands), b"crop" if self.name == "onnx" else None, self.vehicle, 5)


def with_engines(monkeypatch, p, f):
    monkeypatch.setattr(main, "primary", lambda: p)
    monkeypatch.setattr(main, "fallback", lambda: f)


def test_confident_onnx_read_skips_the_vlm(monkeypatch):
    called = []
    f = Fake("vlm", [Candidate("ZZZ999", 0.9, None, "vlm")])
    f.read = lambda *a: called.append(1)  # type: ignore[method-assign]
    with_engines(monkeypatch, Fake("onnx", [Candidate("ABC123", 0.97, "MX", "onnx")]), f)
    r = TestClient(main.app).post("/read", json={"image": img_b64()}).json()
    assert r["candidates"][0]["text"] == "ABC123" and not called


def test_low_confidence_falls_back_to_vlm_and_adds_vehicle(monkeypatch):
    with_engines(
        monkeypatch,
        Fake("onnx", [Candidate("A8C123", 0.6, "MX", "onnx")]),
        Fake("vlm", [Candidate("ABC123", 0.92, "MX", "vlm")], {"make": "Nissan"}),
    )
    r = TestClient(main.app).post("/read", json={"image": img_b64()}).json()
    assert [c["text"] for c in r["candidates"]] == ["ABC123", "A8C123"]
    assert r["vehicle"] == {"make": "Nissan"} and r["crop"]


def test_vlm_failure_keeps_the_onnx_read(monkeypatch):
    class Boom(Fake):
        def read(self, *a):
            raise RuntimeError("down")

    with_engines(monkeypatch, Fake("onnx", [Candidate("ABC123", 0.5, None, "onnx")]), Boom("vlm", []))
    r = TestClient(main.app).post("/read", json={"image": img_b64()}).json()
    assert r["candidates"][0]["text"] == "ABC123" and "vlm failed" in r["notes"][0]


def test_no_engine_is_503(monkeypatch):
    with_engines(monkeypatch, None, None)
    assert TestClient(main.app).post("/read", json={"image": img_b64()}).status_code == 503


def test_bad_image_is_422(monkeypatch):
    with_engines(monkeypatch, Fake("onnx", []), None)
    assert TestClient(main.app).post("/read", json={"image": "not-an-image"}).status_code == 422


def test_vote_requires_agreement():
    same = [[Candidate("ABC123", 0.9)]] * 3
    assert vote(same).text == "ABC123" and vote(same).confidence == 0.9
    mixed = [[Candidate("ABC123", 0.9)], [Candidate("ABC123", 0.9)], [Candidate("ABC128", 0.9)]]
    v = vote(mixed)
    assert v.text == "ABC123" and v.confidence < 0.9


def test_parse_vlm_json_tolerates_fences():
    assert parse_vlm_json('```json\n{"plate": "X1"}\n```') == {"plate": "X1"}
    assert parse_vlm_json("no json") is None
