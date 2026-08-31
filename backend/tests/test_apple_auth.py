from __future__ import annotations

import hashlib
import json
import plistlib
import uuid
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding

from app.apple_auth import (
    APPLE_GSA_CA_BUNDLE,
    AppleAuthManager,
    AppleAuthenticationError,
    AppleSession,
    _complete_two_factor,
    _gsa_request,
    _gsa_authenticate,
    _anisette_headers,
)
from app.findmy import FindMyClient


class _Response:
    def __init__(
        self,
        payload: object = None,
        *,
        status_code: int = 200,
        content: bytes = b"",
    ) -> None:
        self.payload = payload
        self.status_code = status_code
        self.ok = status_code < 400
        self.content = content

    def raise_for_status(self) -> None:
        if not self.ok:
            raise RuntimeError("unexpected test response")

    def json(self) -> object:
        return self.payload


def test_bundled_apple_root_ca_matches_apples_published_certificate() -> None:
    certificate = x509.load_pem_x509_certificate(Path(APPLE_GSA_CA_BUNDLE).read_bytes())

    assert hashlib.sha256(certificate.public_bytes(Encoding.DER)).hexdigest() == (
        "b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024"
    )


def test_native_anisette_identity_is_preserved_with_fresh_server_time(monkeypatch):
    values = {
        "X-Apple-I-MD": "otp",
        "X-Apple-I-MD-M": "machine",
        "X-Apple-I-MD-LU": "native-user",
        "X-Mme-Device-Id": "native-device",
        "X-Apple-I-Client-Time": "stale-provider-time",
        "Authorization": "must-not-be-forwarded",
    }
    monkeypatch.setattr(
        "app.apple_auth.requests.get", lambda *a, **kw: _Response(values)
    )
    headers = _anisette_headers(
        "http://127.0.0.1:6970",
        timeout_seconds=5,
        client_id=uuid.uuid4(),
        device_id=uuid.uuid4(),
    )
    assert headers["X-Apple-I-MD-LU"] == "native-user"
    assert headers["X-Mme-Device-Id"] == "native-device"
    assert headers["X-Apple-I-Client-Time"] != "stale-provider-time"
    assert "Authorization" not in headers


def test_repeated_gsa_two_factor_challenges_are_bounded(monkeypatch):
    class User:
        def __init__(self, *args, **kwargs):
            pass

        def start_authentication(self):
            return "test", b"a"

        def process_challenge(self, *args):
            return b"proof"

        def verify_session(self, *args):
            pass

        def authenticated(self):
            return True

    challenge = {
        "Status": {"ec": 0},
        "sp": "s2k",
        "s": b"salt",
        "i": 1,
        "B": b"b",
        "c": "challenge",
    }
    completed = {
        "Status": {"ec": 0, "au": "secondaryAuth"},
        "M2": b"m2",
        "spd": b"encrypted",
    }
    responses = iter([challenge, completed, challenge, completed])
    rounds = []
    monkeypatch.setattr("app.apple_auth.srp.User", User)
    monkeypatch.setattr("app.apple_auth._gsa_request", lambda *a, **kw: next(responses))
    monkeypatch.setattr(
        "app.apple_auth._decrypt_session_data",
        lambda *a: b'<plist version="1.0"><dict></dict></plist>',
    )
    monkeypatch.setattr(
        "app.apple_auth._complete_two_factor", lambda *a, **kw: rounds.append(1)
    )
    with pytest.raises(AppleAuthenticationError) as error:
        _gsa_authenticate(
            "test@example.invalid",
            "test-password",
            second_factor="sms",
            anisette_url="http://127.0.0.1:6970",
            timeout_seconds=5,
            client_id=uuid.uuid4(),
            device_id=uuid.uuid4(),
            two_factor_code_provider=lambda prompt: "123456",
        )
    assert error.value.code == "two_factor_repeated"
    assert rounds == [1]


def test_gsa_request_uses_anisette_and_the_bundled_apple_ca(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.apple_auth._generate_cpd",
        lambda *_args, **_kwargs: {"X-Apple-I-MD": "otp"},
    )
    calls: list[dict[str, object]] = []

    def fake_post(_url: str, **kwargs: object) -> _Response:
        calls.append(kwargs)
        return _Response(content=plistlib.dumps({"Response": {"Status": {"ec": 0}}}))

    monkeypatch.setattr("app.apple_auth.requests.post", fake_post)

    result = _gsa_request(
        {"o": "init"},
        anisette_url="http://anisette.test",
        timeout_seconds=5,
        client_id=uuid.uuid4(),
        device_id=uuid.uuid4(),
    )

    assert result == {"Status": {"ec": 0}}
    assert calls[0]["verify"] == APPLE_GSA_CA_BUNDLE
    request = plistlib.loads(calls[0]["data"])
    assert request["Request"]["cpd"] == {"X-Apple-I-MD": "otp"}


def test_auth_manager_logs_in_once_and_refreshes_only_after_expiry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sessions = [
        AppleSession(dsid="old-dsid", search_party_token="old-token"),
        AppleSession(dsid="new-dsid", search_party_token="new-token"),
    ]
    login_calls: list[tuple[str, str]] = []

    def fake_login(apple_id: str, password: str, **_: object) -> AppleSession:
        login_calls.append((apple_id, password))
        return sessions.pop(0)

    monkeypatch.setattr("app.apple_auth.login_apple_account", fake_login)
    manager = AppleAuthManager(
        apple_id="owner@example.com",
        apple_password="password-from-secret-manager",
    )

    first = manager.initialize()
    assert first == AppleSession(dsid="old-dsid", search_party_token="old-token")
    assert manager.session() == first
    manager.mark_verified(first)

    refreshed = manager.refresh_if_expired(first)
    assert refreshed == AppleSession(dsid="new-dsid", search_party_token="new-token")
    assert manager.refresh_if_expired(first) == refreshed
    assert login_calls == [
        ("owner@example.com", "password-from-secret-manager"),
        ("owner@example.com", "password-from-secret-manager"),
    ]


def test_cached_findmy_session_is_loaded_without_persisting_new_secrets(
    tmp_path: Path,
) -> None:
    path = tmp_path / "auth.json"
    path.write_text(
        json.dumps({"dsid": "123", "searchPartyToken": "token"}),
        encoding="utf-8",
    )
    manager = AppleAuthManager(auth_file=str(path))

    assert manager.initialize() == AppleSession(dsid="123", search_party_token="token")


def test_report_fetch_reauthenticates_once_after_token_expiry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    old = AppleSession(dsid="old-dsid", search_party_token="old-token")
    new = AppleSession(dsid="new-dsid", search_party_token="new-token")

    class Manager:
        client_id = uuid.uuid4()
        device_id = uuid.uuid4()

        def session(self) -> AppleSession:
            return old

        def refresh_if_expired(
            self, expired: AppleSession, *, status_code: int
        ) -> AppleSession:
            assert expired == old
            assert status_code == 401
            return new

        def mark_verified(self, session: AppleSession) -> None:
            assert session == new

    monkeypatch.setattr(
        "app.findmy.requests.get",
        lambda *_args, **_kwargs: _Response(
            {"X-Apple-I-MD": "otp", "X-Apple-I-MD-M": "machine"}
        ),
    )
    auth_values: list[tuple[str, str]] = []
    responses = iter([_Response(status_code=401), _Response({"results": []})])

    def fake_post(_url: str, **kwargs: object) -> _Response:
        auth_values.append(kwargs["auth"])
        return next(responses)

    monkeypatch.setattr("app.findmy.requests.post", fake_post)
    client = FindMyClient(
        report_api="legacy",
        auth_manager=Manager(),
        anisette_url="http://anisette.test",
    )

    assert (
        client.fetch_latest(
            advertisement_key_sha256=b"a" * 32,
            private_key=b"b" * 28,
        )
        is None
    )
    assert auth_values == [
        ("old-dsid", "old-token"),
        ("new-dsid", "new-token"),
    ]


def test_sms_two_factor_provider_receives_only_a_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.apple_auth._anisette_headers",
        lambda *_args, **_kwargs: {"X-Apple-I-MD": "otp"},
    )
    sent_sms: list[dict[str, object]] = []
    submitted: list[dict[str, object]] = []
    verification_bundles: list[object] = []

    def fake_put(_url: str, **kwargs: object) -> _Response:
        sent_sms.append(kwargs["json"])
        verification_bundles.append(kwargs["verify"])
        return _Response()

    def fake_post(_url: str, **kwargs: object) -> _Response:
        submitted.append(kwargs["json"])
        verification_bundles.append(kwargs["verify"])
        return _Response()

    monkeypatch.setattr("app.apple_auth.requests.put", fake_put)
    monkeypatch.setattr("app.apple_auth.requests.post", fake_post)
    prompts: list[str] = []

    _complete_two_factor(
        {"adsid": "123", "GsIdmsToken": "idms-token"},
        second_factor="sms",
        anisette_url="http://anisette.test",
        timeout_seconds=5,
        client_id=uuid.uuid4(),
        device_id=uuid.uuid4(),
        two_factor_code_provider=lambda prompt: prompts.append(prompt) or "123456",
    )

    assert sent_sms == [{"phoneNumber": {"id": 1}, "mode": "sms"}]
    assert submitted == [
        {
            "phoneNumber": {"id": 1},
            "mode": "sms",
            "securityCode": {"code": "123456"},
        }
    ]
    assert prompts == ["Enter the Apple SMS 2FA code: "]
    assert verification_bundles == [APPLE_GSA_CA_BUNDLE, APPLE_GSA_CA_BUNDLE]
