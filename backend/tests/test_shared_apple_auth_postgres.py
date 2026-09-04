from __future__ import annotations

import uuid

import psycopg
import pytest

from app.apple_auth import AppleAuthenticationError, AppleSession
from app.shared_apple_auth import SharedAppleAuthManager, StoredAppleSession, encrypt_session
from test_billing_postgres_integration import migrated_postgres_url


KEY = b"s" * 32
ACCOUNT = "shared-auth-test"
ENDPOINT = "https://anisette.example"


def _envelope(token: str) -> bytes:
    return encrypt_session(
        StoredAppleSession(AppleSession("123", token), uuid.uuid4(), uuid.uuid4()),
        KEY,
        account_key=ACCOUNT,
        endpoint=ENDPOINT,
    )


@pytest.fixture(autouse=True)
def empty_shared_auth(migrated_postgres_url: str):
    with psycopg.connect(migrated_postgres_url, autocommit=True) as connection:
        connection.execute("DELETE FROM public.upstream_apple_session_status")
        connection.execute("DELETE FROM public.upstream_apple_session")


def _manager(url: str) -> SharedAppleAuthManager:
    return SharedAppleAuthManager(url, KEY, ACCOUNT, ENDPOINT)


def _install(url: str, token: str, revision: int = 1) -> None:
    with psycopg.connect(url) as connection:
        connection.execute(
            """INSERT INTO public.upstream_apple_session
                 (account_key, anisette_endpoint, encrypted_session, revision)
               VALUES (%s, %s, %s, %s)""",
            (ACCOUNT, ENDPOINT, _envelope(token), revision),
        )
        connection.execute(
            """INSERT INTO public.upstream_apple_session_status
                 (account_key, session_revision, phase)
               VALUES (%s, %s, 'ready')""",
            (ACCOUNT, revision),
        )


def test_stale_worker_cannot_reject_rotated_session(migrated_postgres_url: str) -> None:
    _install(migrated_postgres_url, "old")
    stale = _manager(migrated_postgres_url)
    old = stale.session()
    with psycopg.connect(migrated_postgres_url) as connection:
        connection.execute(
            """UPDATE public.upstream_apple_session
                  SET encrypted_session = %s, revision = 2 WHERE account_key = %s""",
            (_envelope("new"), ACCOUNT),
        )
        connection.execute(
            """UPDATE public.upstream_apple_session_status
                  SET session_revision = 2, phase = 'ready' WHERE account_key = %s""",
            (ACCOUNT,),
        )
    stale.reject_session(old, status_code=401)
    with psycopg.connect(migrated_postgres_url) as connection:
        row = connection.execute(
            "SELECT session_revision, phase FROM public.upstream_apple_session_status"
        ).fetchone()
    assert row == (2, "ready")
    assert _manager(migrated_postgres_url).session().search_party_token == "new"


def test_rejected_revision_blocks_all_workers_until_operator_rotation(
    migrated_postgres_url: str,
) -> None:
    _install(migrated_postgres_url, "rejected")
    first = _manager(migrated_postgres_url)
    session = first.session()
    first.reject_session(session, status_code=403)
    with pytest.raises(AppleAuthenticationError) as error:
        _manager(migrated_postgres_url).session()
    assert error.value.code == "recovery_pending"
    with psycopg.connect(migrated_postgres_url) as connection:
        row = connection.execute(
            "SELECT phase, last_http_status FROM public.upstream_apple_session_status"
        ).fetchone()
    assert row == ("recovering", 403)


def test_transient_outage_uses_shared_cooldown_without_invalidating_token(
    migrated_postgres_url: str,
) -> None:
    _install(migrated_postgres_url, "still-valid")
    first = _manager(migrated_postgres_url)
    session = first.session()
    first.note_request_failure(session, code="anisette_unavailable", http_status=503)
    with pytest.raises(AppleAuthenticationError) as error:
        _manager(migrated_postgres_url).session()
    assert error.value.code == "recovery_pending"
    with psycopg.connect(migrated_postgres_url) as connection:
        connection.execute(
            "UPDATE public.upstream_apple_session_status SET next_attempt_at = now() - interval '1 second'"
        )
    assert _manager(migrated_postgres_url).session() == session
