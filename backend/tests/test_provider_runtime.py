from __future__ import annotations

import multiprocessing
import time
from dataclasses import replace

import pytest

from app.findmy import FindMyConfigurationError
from app.config import Settings
from app.provider_runtime import (
    _provider_call,
    _run_isolated,
    available_location_networks,
    create_location_service,
)


def _return_value(config, kwargs):
    return config["value"] + kwargs["value"]


def _wait_forever(config, kwargs):
    time.sleep(30)


def _raise_sensitive_error(config, kwargs):
    raise RuntimeError("sensitive-credential-value")


def test_spawned_provider_result_is_delivered_and_child_reaped() -> None:
    before = {child.pid for child in multiprocessing.active_children()}
    assert _run_isolated(
        _return_value, {"value": 3}, {"value": 4}, timeout_seconds=10
    ) == 7
    assert {child.pid for child in multiprocessing.active_children()} == before


def test_stalled_provider_is_killed_before_returning() -> None:
    before = {child.pid for child in multiprocessing.active_children()}
    started = time.monotonic()
    with pytest.raises((TimeoutError, RuntimeError)):
        _run_isolated(_wait_forever, {}, {}, timeout_seconds=0.2)
    assert time.monotonic() - started < 5
    assert {child.pid for child in multiprocessing.active_children()} == before


def test_provider_exception_does_not_cross_process_boundary() -> None:
    with pytest.raises(RuntimeError) as error:
        _run_isolated(_raise_sensitive_error, {}, {}, timeout_seconds=10)
    assert "sensitive-credential-value" not in str(error.value)


def test_worker_requires_explicit_shared_or_environment_session() -> None:
    settings = Settings(
        database_url="postgresql://unused/unused",
        supabase_jwks_url="https://example.com/jwks",
        supabase_jwt_issuer="https://example.com/auth",
        supabase_jwt_audience="authenticated",
        supabase_jwt_algorithms=("ES256",),
        key_encryption_key=b"a" * 32,
        bootstrap_key_encryption_key=b"b" * 32,
        claim_token_key=b"c" * 32,
        session_ttl_seconds=600,
        claim_ttl_seconds=86400,
    )
    unconfigured = replace(
        settings, findmy_dsid="", findmy_search_party_token="",
        findmy_session_encryption_key=None,
        findmy_apple_id="operator@example.com", findmy_auth_file="local-auth.json",
        google_findhub_bridge_url="", google_findhub_bridge_token="",
    )
    assert available_location_networks(unconfigured) == frozenset()
    assert create_location_service(unconfigured)._apple_configured() is False
    configured = replace(unconfigured, findmy_session_encryption_key=b"s" * 32)
    assert available_location_networks(configured) == frozenset({"apple"})
    assert create_location_service(configured)._apple_configured() is True
    with pytest.raises(FindMyConfigurationError, match="external Anisette"):
        create_location_service(replace(configured, findmy_anisette_provider="native"))


def test_environment_worker_uses_v2_and_a_stable_identity(monkeypatch) -> None:
    class Response:
        status_code = 200

        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            pass

        def json(self):
            return self.payload

    monkeypatch.setattr("app.apple_auth.requests.get", lambda *args, **kwargs: Response({
        "X-Apple-I-MD": "test-otp", "X-Apple-I-MD-M": "test-machine",
    }))
    requests = []

    def post(url, **kwargs):
        requests.append((url, kwargs))
        return Response({"acsnLocations": {"statusCode": "200", "locationPayload": []}})

    monkeypatch.setattr("app.findmy.requests.post", post)
    config = {
        "provider": "apple", "encryption_key": None,
        "account_key": "test-account", "anisette_url": "https://anisette.example",
        "dsid": "test-dsid", "token": "test-token", "request_timeout": 3,
        "lookback_hours": 24, "report_api": "v2",
    }
    for _ in range(2):
        assert _provider_call(config, {
            "advertisement_key_sha256": b"x" * 32, "private_key": b"y" * 28,
        }) == []
    assert all(url.endswith("/findmyservice/v2/fetch") for url, _ in requests)
    for header in ("X-Mme-Device-Id", "X-Apple-I-MD-LU"):
        assert requests[0][1]["headers"][header] == requests[1][1]["headers"][header]
