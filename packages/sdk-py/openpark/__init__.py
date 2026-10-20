"""OpenPark Python SDK (Apache-2.0)."""
from __future__ import annotations

import hashlib
import hmac
import uuid
from typing import Any

import httpx

__all__ = ["OpenPark", "OpenParkError", "verify_webhook"]


class OpenParkError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status, self.code, self.details = status, code, details


class OpenPark:
    def __init__(self, base_url: str, api_key: str, tenant: str | None = None, transport: httpx.BaseTransport | None = None) -> None:
        self._http = httpx.Client(base_url=base_url.rstrip("/"), transport=transport, timeout=30)
        self._headers = {"x-api-key": api_key} if api_key.startswith("op_") else {"authorization": f"Bearer {api_key}"}
        if tenant:
            self._headers["x-tenant"] = tenant

    def request(self, method: str, path: str, *, body: Any = None, query: dict | None = None, idempotency_key: str | None = None) -> Any:
        """Writes always carry an Idempotency-Key; pass your own to make retries safe across restarts."""
        headers = dict(self._headers)
        if method != "GET":
            headers["idempotency-key"] = idempotency_key or str(uuid.uuid4())
        params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in (query or {}).items() if v is not None}
        res = self._http.request(method, path, json=body, params=params, headers=headers)
        data = res.json() if res.content else None
        if res.is_error:
            err = (data or {}).get("error", {})
            raise OpenParkError(res.status_code, err.get("code", "error"), err.get("message", res.reason_phrase), err.get("details"))
        return data

    def check_in(self, site: str, plate: str, region: str | None = None, *, idempotency_key: str | None = None, **extra: Any) -> Any:
        return self.request("POST", "/v1/sessions", idempotency_key=idempotency_key,
                            body={"site": site, "plate": {"display": plate, **({"region": region} if region else {})}, **extra})

    def check_out(self, site: str, *, plate: str | None = None, ticket: str | None = None, idempotency_key: str | None = None, **extra: Any) -> Any:
        return self.request("POST", "/v1/checkout", idempotency_key=idempotency_key,
                            body={"site": site, **({"plate": plate} if plate else {}), **({"ticket": ticket} if ticket else {}), **extra})

    def occupancy(self, site: str | None = None) -> Any:
        return self.request("GET", "/v1/occupancy", query={"site": site})

    def sessions(self, **query: Any) -> Any:
        return self.request("GET", "/v1/sessions", query=query)

    def slots(self, site: str, **query: Any) -> Any:
        return self.request("GET", "/v1/slots", query={"site": site, **query})

    def export_inventory(self, site: str | None = None, zone: str | None = None) -> Any:
        return self.request("GET", "/v1/inventory/export", query={"site": site, "zone": zone})

    def preview_inventory(self, doc: dict, mode: str = "merge", dry_run: bool = False) -> Any:
        return self.request("POST", "/v1/inventory/import", body=doc, query={"mode": mode, "dryRun": dry_run})

    def apply_inventory(self, job: str) -> Any:
        return self.request("POST", f"/v1/inventory/import/{job}/apply")


def verify_webhook(raw_body: bytes | str, signature_header: str | None, secret: str) -> bool:
    """`X-OpenPark-Signature: sha256=<hex>` is HMAC-SHA256 of the raw body. Pass the exact bytes received."""
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    body = raw_body.encode() if isinstance(raw_body, str) else raw_body
    want = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, signature_header[7:])
