from __future__ import annotations

import asyncio
import base64
import json
import os
import threading
from dataclasses import replace
from uuid import UUID

import pytest
from fastapi import FastAPI

from app.apple_auth import AppleSession
from app.config import ConfigurationError, Settings, get_settings, read_optional_secret
from app.findmy_admin import main as admin_main
from app.findmy_runtime import create_auth_manager


@pytest.fixture
def settings(tmp_path):
    return Settings(
        database_url="postgresql://test:test@127.0.0.1:5432/test",
        supabase_jwks_url="http://127.0.0.1:54321/auth/v1/.well-known/jwks.json",
        supabase_jwt_issuer="http://127.0.0.1:54321/auth/v1",
        supabase_jwt_audience="authenticated",
        supabase_jwt_algorithms=("ES256",),
        key_encryption_key=b"a" * 32,
        bootstrap_key_encryption_key=b"b" * 32,
        claim_token_key=b"c" * 32,
        session_ttl_seconds=600,
        claim_ttl_seconds=86400,
        findmy_apple_id="test@example.invalid",
        findmy_apple_password="fixture-password",
        findmy_state_path=str(tmp_path / "session.json"),
        findmy_anisette_url="http://127.0.0.1:6970",
        location_sync_worker_enabled=False,
    )


@pytest.fixture
def environment(monkeypatch):
    values = {
        "DATABASE_URL": "postgresql://test:test@127.0.0.1:5432/test",
        "SUPABASE_URL": "http://127.0.0.1:54321",
        "PINQEVA_KEY_ENCRYPTION_KEY": base64.b64encode(b"a" * 32).decode(),
        "PINQEVA_BOOTSTRAP_KEY_ENCRYPTION_KEY": base64.b64encode(b"b" * 32).decode(),
        "PINQEVA_CLAIM_TOKEN_KEY": base64.b64encode(b"c" * 32).decode(),
    }
    values.update(
        {
            name: "HERE_" + name
            for name in (
                "STRIPE_SECRET_KEY",
                "STRIPE_WEBHOOK_SECRET",
                "STRIPE_PRICE_MAP_JSON",
                "STRIPE_CHECKOUT_SUCCESS_URL",
                "STRIPE_CHECKOUT_CANCEL_URL",
                "STRIPE_PORTAL_RETURN_URL",
            )
        }
    )
    monkeypatch.setattr(os, "environ", values)
    get_settings.cache_clear()
    yield values
    get_settings.cache_clear()


def test_secret_files_preserve_password_spaces_and_never_echo_values(
    tmp_path, environment
):
    password = "  example $`password  "
    file = tmp_path / "password"
    file.write_text(password + "\n")
    environment["PINQEVA_FINDMY_APPLE_ID"] = "test@example.invalid"
    environment["PINQEVA_FINDMY_APPLE_PASSWORD_FILE"] = str(file)
    settings = get_settings()
    assert settings.findmy_apple_password == password
    assert password not in repr(settings)
    environment["PINQEVA_FINDMY_APPLE_PASSWORD"] = "not-to-be-echoed"
    with pytest.raises(ConfigurationError) as error:
        read_optional_secret("PINQEVA_FINDMY_APPLE_PASSWORD")
    assert "not-to-be-echoed" not in str(error.value)


@pytest.mark.parametrize(
    "field, value",
    [
        ("PINQEVA_FINDMY_2FA_PROVIDER", "unknown"),
        ("PINQEVA_FINDMY_RETRY_INITIAL_SECONDS", "0"),
        ("PINQEVA_FINDMY_RETRY_MAX_SECONDS", "5"),
        ("PINQEVA_FINDMY_TWILIO_POLL_SECONDS", "0"),
        ("PINQEVA_FINDMY_TWILIO_TIMEOUT_SECONDS", "9999"),
        ("PINQEVA_FINDMY_SMS_PHONE_ID", "-1"),
        ("PINQEVA_FINDMY_REPORT_API", "https://untrusted.invalid"),
        ("PINQEVA_FINDMY_STATE_PATH", ""),
    ],
)
def test_invalid_auth_configuration_fails_safely(environment, field, value):
    environment[field] = value
    with pytest.raises(ConfigurationError):
        get_settings()


def test_twilio_configuration_requires_the_complete_sms_receiving_setup(environment):
    environment.update(
        {
            "PINQEVA_FINDMY_APPLE_ID": "test@example.invalid",
            "PINQEVA_FINDMY_APPLE_PASSWORD": "test-password",
            "PINQEVA_FINDMY_2FA_PROVIDER": "twilio",
            "PINQEVA_FINDMY_TWILIO_ACCOUNT_SID": "AC" + "1" * 32,
            "PINQEVA_FINDMY_TWILIO_AUTH_TOKEN": "private-test-twilio-token",
            "PINQEVA_FINDMY_TWILIO_PHONE_NUMBER": "+15555550123",
        }
    )
    with pytest.raises(ConfigurationError):
        get_settings()
    environment["PINQEVA_FINDMY_TWILIO_ALLOWED_SENDERS"] = "12345, Apple"
    settings = get_settings()
    assert settings.findmy_twilio_allowed_senders == ("12345", "Apple")
    assert "private-test-twilio-token" not in repr(settings)
    manager = create_auth_manager(settings)
    assert manager.two_factor_code_provider.stop is manager.stop_event
    get_settings.cache_clear()
    environment["PINQEVA_FINDMY_SECOND_FACTOR"] = "trusted_device"
    with pytest.raises(ConfigurationError):
        get_settings()


def test_state_cannot_overwrite_existing_anisette_identity(environment):
    environment["PINQEVA_FINDMY_STATE_PATH"] = "./state/same.bin"
    environment["PINQEVA_FINDMY_ANISETTE_STATE_PATH"] = "state/same.bin"
    with pytest.raises(ConfigurationError):
        get_settings()


def test_status_does_not_claim_cached_auth_is_verified_or_print_secrets(
    settings, monkeypatch, capsys
):
    settings = replace(
        settings, findmy_dsid="private-dsid", findmy_search_party_token="private-token"
    )
    create_auth_manager(settings).initialize()
    monkeypatch.setattr("app.findmy_admin.get_settings", lambda: settings)

    class Response:
        status_code = 200

        def json(self):
            return {"X-Apple-I-MD": "private-otp", "X-Apple-I-MD-M": "private-machine"}

    monkeypatch.setattr("app.findmy_admin.requests.get", lambda *a, **kw: Response())
    assert admin_main(["status"]) == 1
    text = capsys.readouterr().out
    data = json.loads(text)
    assert data["anisette"]["ok"]
    assert data["authentication"]["phase"] == "cached_unverified"
    for secret in (
        "private-otp",
        "private-machine",
        "private-dsid",
        "private-token",
        settings.findmy_apple_password,
        settings.findmy_apple_id,
    ):
        assert secret not in text


def test_probe_uses_claimed_tracker_and_shared_runtime_without_logging_in(
    settings, monkeypatch, capsys
):
    settings = replace(
        settings, findmy_dsid="test-dsid", findmy_search_party_token="test-token"
    )
    create_auth_manager(settings).initialize()
    monkeypatch.setattr("app.findmy_admin.get_settings", lambda: settings)
    identifier = "3cac57ce-119c-4d22-970d-6ca26f0c427e"

    def lookup(selected_settings, device_id):
        assert selected_settings == settings and device_id == UUID(identifier)
        return b"k" * 32

    monkeypatch.setattr("app.findmy_admin.tracker_report_hash", lookup)
    monkeypatch.setattr("app.findmy.FindMyClient._anisette_headers", lambda self: {})
    monkeypatch.setattr(
        "app.apple_auth.login_apple_account",
        lambda *a, **kw: pytest.fail("Probe must not block on login"),
    )

    class Response:
        status_code = 200

        def json(self):
            return {"acsnLocations": {"statusCode": "200", "locationPayload": []}}

    monkeypatch.setattr("app.findmy.requests.post", lambda *a, **kw: Response())
    assert admin_main(["probe", "--device-id", identifier]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["apple_http_status"] == 200 and data["report_count"] == 0
    manager = create_auth_manager(settings)
    manager.initialize(allow_login=False)
    assert manager.status()["phase"] == "ready"


def test_interactive_login_requires_an_explicit_tty(monkeypatch, capsys):
    monkeypatch.setattr("app.findmy_admin.sys.stdin.isatty", lambda: False)
    assert admin_main(["login", "--interactive", "--force"]) == 1
    assert json.loads(capsys.readouterr().out)["reason"] == "interactive_tty_required"


@pytest.mark.asyncio
async def test_api_startup_and_shutdown_never_start_apple_authentication(
    settings, monkeypatch
):
    from app import main

    entered = threading.Event()
    closed = []

    def forbidden_login(*args, **kwargs):
        entered.set()
        raise AssertionError("API replicas must not authenticate to Apple")

    class Database:
        def __init__(self, *args):
            pass

        async def open(self):
            await asyncio.sleep(0)

        async def close(self):
            closed.append(True)

    class Billing:
        def __init__(self, *args):
            pass

        async def bootstrap_catalog(self, *args):
            pass

    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "Database", Database)
    monkeypatch.setattr(main, "BillingService", Billing)
    monkeypatch.setattr("app.apple_auth.login_apple_account", forbidden_login)
    app = FastAPI()

    async def exercise():
        async with main.lifespan(app):
            assert not entered.is_set()
            assert not hasattr(app.state, "findmy_auth")
            assert app.state.location.auth_manager is None

    await asyncio.wait_for(exercise(), 4)
    assert closed == [True]
