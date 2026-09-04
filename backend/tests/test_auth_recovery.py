from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import requests

from app.apple_auth import (
    AppleAuthManager,
    AppleAuthenticationDeferred,
    AppleAuthenticationError,
    AppleSession,
)
from app.findmy import FindMyClient, FindMyRequestError
from app.findmy_state import SessionStore, StateError


OLD = AppleSession("test-dsid", "expired-test-token")
NEW = AppleSession("test-dsid", "renewed-test-token")
ROOT = b"r" * 32


def manager_at(path: Path, **overrides) -> AppleAuthManager:
    return AppleAuthManager(
        **{
            "apple_id": "test@example.invalid",
            "apple_password": "test-password-only",
            "state_path": str(path / "session.json"),
            "state_key": ROOT,
            "background": True,
            **overrides,
        }
    )


class Response:
    def __init__(self, status=200, payload=None):
        self.status_code = status
        self.payload = payload

    def json(self):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload


def client_for(manager, monkeypatch, responses, *, api="v2"):
    iterator = iter(responses)
    monkeypatch.setattr(
        FindMyClient, "_anisette_headers", lambda self: {"X-Apple-I-MD": "test-otp"}
    )
    monkeypatch.setattr("app.findmy.requests.post", lambda *a, **kw: next(iterator))
    return FindMyClient(auth_manager=manager, report_api=api)


def test_cache_401_is_durable_and_worker_recovers_without_parsing_error_body(
    tmp_path, monkeypatch
):
    path = tmp_path / "auth.json"
    path.write_text(
        json.dumps({"dsid": OLD.dsid, "searchPartyToken": OLD.search_party_token})
    )
    manager = manager_at(tmp_path, auth_file=str(path))
    assert manager.initialize() == OLD
    assert manager.status()["phase"] == "cached_unverified"
    ids = (manager.client_id, manager.device_id)
    client = client_for(
        manager, monkeypatch, [Response(401, AssertionError("Do not parse a 401 body"))]
    )
    with pytest.raises(FindMyRequestError) as error:
        client.probe_reports(b"k" * 32)
    assert error.value.http_status == 401
    assert not manager.status()["session_available"]
    assert manager._store.read()["session"] is None

    restarted = manager_at(tmp_path, auth_file=str(path))
    with pytest.raises(AppleAuthenticationDeferred):
        restarted.initialize(allow_login=False)
    # The unchanged plaintext cache must not resurrect the rejected token.
    assert not restarted.status()["session_available"]
    login_calls = []
    monkeypatch.setattr(
        "app.apple_auth.login_apple_account",
        lambda *a, **kw: login_calls.append(kw) or NEW,
    )
    assert restarted.initialize() == NEW
    assert (restarted.client_id, restarted.device_id) == ids
    assert len(login_calls) == 1
    assert restarted.status()["phase"] == "session_unverified"
    client = client_for(
        restarted,
        monkeypatch,
        [
            Response(
                payload={"acsnLocations": {"statusCode": "200", "locationPayload": []}}
            )
        ],
    )
    assert client.probe_reports(b"k" * 32) == 0
    assert restarted.status()["phase"] == "ready"
    assert manager_at(tmp_path).initialize() == NEW


def test_session_is_encrypted_account_bound_and_private(tmp_path, monkeypatch, caplog):
    caplog.set_level("INFO", logger="pinqeva")
    monkeypatch.setattr("app.apple_auth.login_apple_account", lambda *a, **kw: NEW)
    manager = manager_at(tmp_path)
    manager.initialize()
    assert (
        manager._store.read()["session"]["searchPartyToken"] == NEW.search_party_token
    )
    for path in tmp_path.iterdir():
        contents = path.read_bytes()
        assert NEW.search_party_token.encode() not in contents
        assert b"test-password-only" not in contents
        if os.name != "nt":
            assert path.stat().st_mode & 0o077 == 0
    assert NEW.search_party_token not in caplog.text + repr(NEW) + repr(manager)
    assert "test-password-only" not in caplog.text + repr(manager)
    with pytest.raises(AppleAuthenticationError) as wrong_account:
        manager_at(tmp_path, apple_id="another@example.invalid").initialize()
    assert wrong_account.value.code == "state_unavailable"
    with pytest.raises(AppleAuthenticationError):
        manager_at(tmp_path, state_key=b"s" * 32).initialize()


def test_network_backoff_survives_restart_and_is_capped(tmp_path, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr("app.apple_auth.time.time", lambda: clock[0])
    calls = []

    def unavailable(*a, **kw):
        calls.append(1)
        raise AppleAuthenticationError("safe failure", code="anisette_unavailable")

    monkeypatch.setattr("app.apple_auth.login_apple_account", unavailable)
    manager = manager_at(tmp_path, retry_initial_seconds=60, retry_max_seconds=120)
    for index, delay in enumerate([60, 120, 120]):
        with pytest.raises(AppleAuthenticationError):
            manager.initialize()
        assert len(calls) == index + 1
        retry_at = manager.status()["retry_at"]
        assert retry_at == clock[0] + delay
        manager = manager_at(tmp_path, retry_initial_seconds=60, retry_max_seconds=120)
        with pytest.raises(AppleAuthenticationDeferred):
            manager.initialize()
        assert len(calls) == index + 1
        clock[0] = retry_at + 1


def test_401_on_a_fresh_token_does_not_start_another_login_loop(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.apple_auth.login_apple_account", lambda *a, **kw: calls.append(1) or NEW
    )
    manager = manager_at(tmp_path, static_session=OLD, background=False)
    manager.initialize()
    client = client_for(manager, monkeypatch, [Response(401), Response(403)])
    with pytest.raises(FindMyRequestError) as error:
        client.probe_reports(b"k" * 32)
    assert error.value.http_status == 403
    assert calls == [1]
    assert manager._store.read()["session"] is None
    with pytest.raises(AppleAuthenticationDeferred):
        manager.initialize()
    assert manager.status()["retry_at"] > time.time()


@pytest.mark.parametrize(
    "response, reason",
    [
        (Response(429), "apple_rate_limited"),
        (Response(500), "apple_http_error"),
        (Response(302), "apple_http_error"),
        (Response(200, ValueError("sensitive response")), "invalid_json"),
        (Response(200, {"acsnLocations": {"statusCode": "500"}}), "invalid_response"),
    ],
)
def test_non_auth_errors_never_discard_session_or_trigger_login(
    tmp_path, monkeypatch, response, reason, caplog
):
    manager = manager_at(tmp_path, static_session=OLD)
    manager.initialize()
    monkeypatch.setattr(
        "app.apple_auth.login_apple_account",
        lambda *a, **kw: pytest.fail("Unexpected login"),
    )
    client = client_for(manager, monkeypatch, [response])
    with pytest.raises(FindMyRequestError) as error:
        client.probe_reports(b"k" * 32)
    assert error.value.code == reason
    assert manager.session() == OLD
    assert "sensitive response" not in caplog.text
    assert manager.status()["phase"] != "ready"


def test_transport_error_is_safe_and_does_not_expire_token(
    tmp_path, monkeypatch, caplog
):
    manager = manager_at(tmp_path, static_session=OLD)
    manager.initialize()
    monkeypatch.setattr(FindMyClient, "_anisette_headers", lambda self: {})

    def failed(*args, **kwargs):
        raise requests.ConnectionError("secret-token-in-error")

    monkeypatch.setattr("app.findmy.requests.post", failed)
    with pytest.raises(FindMyRequestError) as error:
        FindMyClient(auth_manager=manager).probe_reports(b"k" * 32)
    assert error.value.code == "network_error"
    assert manager.session() == OLD
    assert "secret-token-in-error" not in caplog.text + str(error.value)


def test_login_and_requests_do_not_wait_for_a_concurrent_login(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []

    def slow_login(*args, **kwargs):
        calls.append(1)
        entered.set()
        assert release.wait(5)
        return NEW

    monkeypatch.setattr("app.apple_auth.login_apple_account", slow_login)
    first, second = manager_at(tmp_path), manager_at(tmp_path)
    with ThreadPoolExecutor() as pool:
        future = pool.submit(first.initialize)
        try:
            assert entered.wait(3)
            with pytest.raises(AppleAuthenticationDeferred):
                first.session()
            with pytest.raises(AppleAuthenticationDeferred) as error:
                second.initialize()
            assert error.value.code == "authentication_in_progress"
        finally:
            release.set()
        assert future.result(timeout=3) == NEW
    assert second.initialize() == NEW
    assert calls == [1]


def test_file_lock_excludes_a_separate_cli_process(tmp_path):
    store = SessionStore(str(tmp_path / "state.json"), ROOT, "test")
    script = """
import sys
from app.findmy_state import SessionStore, StateBusy
try:
    with SessionStore(sys.argv[1], b'r' * 32, 'test').lock():
        print('acquired')
except StateBusy:
    print('busy')
"""
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    with store.lock():
        result = subprocess.run(
            [sys.executable, "-c", script, str(store.path)],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
    assert result.stdout.strip() == "busy"


def test_new_token_is_unavailable_until_its_save_succeeds(tmp_path, monkeypatch):
    manager = manager_at(tmp_path)
    monkeypatch.setattr("app.apple_auth.login_apple_account", lambda *a, **kw: NEW)
    original_write = manager._store.write

    def full_disk(data):
        if data["session"]:
            with pytest.raises(AppleAuthenticationDeferred):
                manager.session()
            raise StateError("disk full with sensitive context")
        original_write(data)

    monkeypatch.setattr(manager._store, "write", full_disk)
    with pytest.raises(AppleAuthenticationError) as error:
        manager.initialize()
    assert error.value.code == "state_unavailable"
    assert manager._store.read()["session"] is None
    with pytest.raises(AppleAuthenticationDeferred):
        manager.session()


def test_corrupt_state_is_never_replaced_or_relogged_automatically(
    tmp_path, monkeypatch
):
    path = tmp_path / "session.json"
    path.write_bytes(b"damaged state")
    monkeypatch.setattr(
        "app.apple_auth.login_apple_account",
        lambda *a, **kw: pytest.fail("must preserve state"),
    )
    manager = manager_at(tmp_path)
    with pytest.raises(AppleAuthenticationError):
        manager.initialize()
    assert path.read_bytes() == b"damaged state"
    assert manager.status()["needs_attention"]


def test_unattended_runtime_never_prompts_for_missing_password(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "app.apple_auth.getpass", lambda *a: pytest.fail("No TTY in a daemon")
    )
    with pytest.raises(AppleAuthenticationError) as error:
        manager_at(tmp_path, apple_password="").initialize()
    assert error.value.code == "credentials_required"


def test_two_factor_operator_gate_survives_restart_and_explicit_login_clears_it(
    tmp_path, monkeypatch
):
    from app.apple_2fa import TwoFactorError

    calls = []

    def needs_operator(*args, **kwargs):
        calls.append(1)
        raise TwoFactorError("two_factor_provider_required")

    monkeypatch.setattr("app.apple_auth.login_apple_account", needs_operator)
    with pytest.raises(AppleAuthenticationError):
        manager_at(tmp_path).initialize()
    restarted = manager_at(tmp_path)
    with pytest.raises(AppleAuthenticationDeferred):
        restarted.initialize()
    assert calls == [1]
    monkeypatch.setattr("app.apple_auth.login_apple_account", lambda *a, **kw: NEW)
    assert restarted.initialize(force=True) == NEW
    assert restarted.status()["needs_attention"] is False


def test_late_rejection_of_old_session_cannot_erase_a_new_cli_session(
    tmp_path, monkeypatch
):
    first = manager_at(tmp_path, static_session=OLD)
    first.initialize()
    cli = manager_at(tmp_path)
    monkeypatch.setattr("app.apple_auth.login_apple_account", lambda *a, **kw: NEW)
    cli.initialize(force=True)
    first.reject_session(OLD)
    assert first.session() == NEW
    assert first._store.read()["session"]["searchPartyToken"] == NEW.search_party_token


def test_enabling_credentials_after_cache_only_mode_discards_unbound_token(
    tmp_path, monkeypatch
):
    cache_only = manager_at(
        tmp_path, apple_id="", apple_password="", static_session=OLD
    )
    cache_only.initialize()
    cache_only.mark_verified(OLD)
    calls = []
    monkeypatch.setattr(
        "app.apple_auth.login_apple_account", lambda *a, **kw: calls.append(1) or NEW
    )
    configured = manager_at(tmp_path, static_session=OLD)
    assert configured.initialize() == NEW
    assert calls == [1]
    assert configured.client_id == cache_only.client_id
    assert (
        configured._store.read()["session"]["searchPartyToken"]
        == NEW.search_party_token
    )
    with pytest.raises(AppleAuthenticationError):
        manager_at(tmp_path, apple_id="different@example.invalid").initialize()


@pytest.mark.asyncio
async def test_background_worker_recovers_without_any_request(tmp_path, monkeypatch):
    finished = threading.Event()
    stop = asyncio.Event()
    manager = manager_at(tmp_path)

    def login(*args, **kwargs):
        finished.set()
        return NEW

    monkeypatch.setattr("app.apple_auth.login_apple_account", login)
    task = asyncio.create_task(manager.run(stop))
    try:
        assert await asyncio.to_thread(finished.wait, 3)
    finally:
        stop.set()
        await asyncio.wait_for(task, 3)
    assert manager.session() == NEW
