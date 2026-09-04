from __future__ import annotations

import uuid

import pytest

from app.apple_auth import AppleAuthenticationError, AppleSession
from app.config import Settings
from app.shared_apple_auth import (
    SharedAppleAuthManager,
    StoredAppleSession,
    _stored_from_row,
    decrypt_session,
    encrypt_session,
    main,
)


def _stored() -> StoredAppleSession:
    return StoredAppleSession(
        AppleSession("test-dsid", "test-search-party-token"), uuid.uuid4(), uuid.uuid4()
    )


def test_shared_session_encryption_binds_account_and_endpoint() -> None:
    stored = _stored()
    key = b"s" * 32
    envelope = encrypt_session(stored, key, account_key="account", endpoint="https://anisette.example")
    assert b"test-search-party-token" not in envelope
    assert decrypt_session(
        envelope, key, account_key="account", endpoint="https://anisette.example"
    ) == stored
    for account, endpoint, candidate_key in (
        ("another-account", "https://anisette.example", key),
        ("account", "https://different.example", key),
        ("account", "https://anisette.example", b"x" * 32),
    ):
        with pytest.raises(AppleAuthenticationError):
            decrypt_session(envelope, candidate_key, account_key=account, endpoint=endpoint)
    corrupted = envelope[:-1] + bytes([envelope[-1] ^ 1])
    with pytest.raises(AppleAuthenticationError):
        decrypt_session(corrupted, key, account_key="account", endpoint="https://anisette.example")


def test_shared_session_refuses_endpoint_failover() -> None:
    stored = _stored()
    row = {
        "anisette_endpoint": "https://primary.example",
        "encrypted_session": encrypt_session(
            stored, b"s" * 32, account_key="account", endpoint="https://primary.example"
        ),
    }
    with pytest.raises(AppleAuthenticationError, match="endpoint does not match"):
        _stored_from_row(row, b"s" * 32, account_key="account", endpoint="https://secondary.example")


def test_expiry_reads_operator_rotation_without_logging_in(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = SharedAppleAuthManager("unused-database", b"s" * 32, "account", "https://anisette.example")
    old = AppleSession("test-dsid", "old-token")
    new = AppleSession("test-dsid", "rotated-token")
    monkeypatch.setattr(manager, "_load", lambda: old)
    with pytest.raises(AppleAuthenticationError, match="operator must refresh"):
        manager.refresh_if_expired(old)
    monkeypatch.setattr(manager, "_load", lambda: new)
    assert manager.refresh_if_expired(old) == new


def test_worker_reads_shared_state_and_stable_ids_for_each_call(monkeypatch: pytest.MonkeyPatch) -> None:
    stored = _stored()
    calls = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, sql, parameters):
            calls.append((sql, parameters))
            return self

        def fetchone(self):
            return {
                "anisette_endpoint": "https://anisette.example",
                "encrypted_session": encrypt_session(
                    stored, b"s" * 32, account_key="account", endpoint="https://anisette.example"
                ),
            }

    monkeypatch.setattr("app.shared_apple_auth.psycopg.Connection.connect", lambda *args, **kwargs: Connection())
    manager = SharedAppleAuthManager("unused-database", b"s" * 32, "account", "https://anisette.example")
    assert manager.session() == stored.session
    assert manager.client_id == stored.client_id
    assert manager.device_id == stored.device_id
    assert manager.session() == stored.session
    assert len(calls) == 2
    assert all(parameters == ("account",) for _, parameters in calls)


def _operator_settings(tmp_path):
    return Settings(
        database_url="postgresql://unused/unused",
        supabase_jwks_url="https://example.com/jwks",
        supabase_jwt_issuer="https://example.com/auth",
        supabase_jwt_audience="authenticated",
        supabase_jwt_algorithms=("ES256",),
        key_encryption_key=b"a" * 32,
        bootstrap_key_encryption_key=b"b" * 32,
        claim_token_key=b"c" * 32,
        session_ttl_seconds=600, claim_ttl_seconds=86400,
        findmy_session_encryption_key=b"s" * 32,
        findmy_apple_id="operator@example.invalid",
        findmy_anisette_url="https://anisette.example",
        findmy_state_path=str(tmp_path / "legacy-state.json"),
    )


class _OperatorConnection:
    def __init__(self):
        self.written = None
        self.return_revision = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, parameters=()):
        if "INSERT INTO public.upstream_apple_session\n" in sql:
            self.written = parameters
            self.return_revision = True
        return self

    def fetchone(self):
        if self.return_revision:
            self.return_revision = False
            return {"revision": 1}
        return None


def test_operator_login_reuses_2fa_with_no_local_session_file(monkeypatch, tmp_path) -> None:
    settings = _operator_settings(tmp_path)
    connection = _OperatorConnection()
    calls = []

    class Manager:
        def initialize(self):
            return AppleSession("test-dsid", "operator-session-token")

    manager = Manager()

    def factory(config, **kwargs):
        calls.append((config, kwargs))
        return manager

    monkeypatch.setattr("app.config.get_settings", lambda: settings)
    monkeypatch.setattr("app.shared_apple_auth.psycopg.Connection.connect", lambda *args, **kwargs: connection)
    monkeypatch.setattr("app.findmy_runtime.create_auth_manager", factory)
    monkeypatch.setattr("app.shared_apple_auth.sys.argv", ["operator", "login", "--interactive"])
    monkeypatch.setattr("app.shared_apple_auth.sys.stdin.isatty", lambda: True)
    main()
    config, flags = calls[0]
    assert flags == {"background": False, "interactive": True}
    assert config.findmy_state_path == "" and config.findmy_auth_file == ""
    assert not list(tmp_path.iterdir())
    account, endpoint, envelope = connection.written
    stored = decrypt_session(envelope, b"s" * 32, account_key=account, endpoint=endpoint)
    assert stored.session.search_party_token == "operator-session-token"
    assert stored.client_id == manager.client_id
    assert stored.device_id == manager.device_id


def test_operator_import_preserves_encrypted_legacy_identity(monkeypatch, tmp_path) -> None:
    from app.findmy_state import SessionStore

    settings = _operator_settings(tmp_path)
    stored = _stored()
    SessionStore(settings.findmy_state_path, settings.key_encryption_key, settings.findmy_apple_id).write({
        "client_id": str(stored.client_id), "device_id": str(stored.device_id),
        "session": {"dsid": stored.session.dsid, "searchPartyToken": stored.session.search_party_token},
    })
    connection = _OperatorConnection()
    monkeypatch.setattr("app.config.get_settings", lambda: settings)
    monkeypatch.setattr("app.shared_apple_auth.psycopg.Connection.connect", lambda *args, **kwargs: connection)
    monkeypatch.setattr("app.shared_apple_auth.sys.argv", ["operator", "import-state", "--file", settings.findmy_state_path])
    main()
    account, endpoint, envelope = connection.written
    assert decrypt_session(envelope, b"s" * 32, account_key=account, endpoint=endpoint) == stored
