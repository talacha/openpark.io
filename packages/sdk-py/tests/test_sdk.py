import hashlib
import hmac
import json

import httpx
import pytest

from openpark import OpenPark, OpenParkError, verify_webhook


def make(handler):
    return OpenPark("https://app.example.com/", "op_abc", transport=httpx.MockTransport(handler))


def test_writes_carry_idempotency_key_and_reads_do_not():
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        return httpx.Response(200, json={"ok": True})

    api = make(handler)
    api.check_in("S1", "ABC123", "MX")
    api.occupancy("S1")
    assert seen[0].headers["x-api-key"] == "op_abc" and len(seen[0].headers["idempotency-key"]) == 36
    assert json.loads(seen[0].content) == {"site": "S1", "plate": {"display": "ABC123", "region": "MX"}}
    assert "idempotency-key" not in seen[1].headers and seen[1].url.params["site"] == "S1"


def test_caller_supplied_key_is_reused():
    seen = []
    api = make(lambda r: (seen.append(r), httpx.Response(200, json={}))[1])
    api.check_out("S1", plate="ABC123", idempotency_key="order-42")
    assert seen[0].headers["idempotency-key"] == "order-42"


def test_errors_carry_code_and_details():
    api = make(lambda r: httpx.Response(409, json={"error": {"code": "already_inside", "message": "Inside", "details": {"slot": "B2-014"}}}))
    with pytest.raises(OpenParkError) as e:
        api.check_in("S1", "X")
    assert (e.value.status, e.value.code, e.value.details) == (409, "already_inside", {"slot": "B2-014"})


def test_booleans_are_lowercased_in_query_strings():
    seen = []
    api = make(lambda r: (seen.append(r), httpx.Response(200, json={}))[1])
    api.preview_inventory({"schemaVersion": 1}, dry_run=True)
    assert seen[0].url.params["dryRun"] == "true"


def test_verify_webhook():
    body = b'{"event":"session.opened"}'
    sig = "sha256=" + hmac.new(b"whsec_x", body, hashlib.sha256).hexdigest()
    assert verify_webhook(body, sig, "whsec_x")
    assert not verify_webhook(body + b" ", sig, "whsec_x")
    assert not verify_webhook(body, None, "whsec_x") and not verify_webhook(body, "md5=zz", "whsec_x")
