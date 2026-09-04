"""Shared Apple credentials with operator-managed authentication.

Location workers read encrypted credentials and update non-secret status. Login
and 2FA happen in an explicit operator command with a privileged database role.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import uuid
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

import psycopg
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg.rows import DictRow, dict_row

from .apple_auth import (
    AppleAuthenticationError,
    AppleSession,
    _session_from_mapping,
    load_cached_session,
)


logger = logging.getLogger("pinqeva.shared_apple_auth")


def _connect(database_url: str) -> psycopg.Connection[DictRow]:
    return psycopg.Connection[DictRow].connect(
        database_url, connect_timeout=5,
        options="-c statement_timeout=5000 -c lock_timeout=4000", row_factory=dict_row,
    )


@dataclass(frozen=True)
class StoredAppleSession:
    session: AppleSession = field(repr=False)
    client_id: uuid.UUID
    device_id: uuid.UUID


def _aad(account_key: str, endpoint: str) -> bytes:
    return json.dumps(
        ["pinqeva:apple-session:v1", account_key, endpoint.rstrip("/")],
        separators=(",", ":"),
    ).encode("utf-8")


def encrypt_session(
    stored: StoredAppleSession, key: bytes, *, account_key: str, endpoint: str
) -> bytes:
    if len(key) != 32:
        raise AppleAuthenticationError("The Apple session encryption key is invalid")
    clear = json.dumps(
        {
            "dsid": stored.session.dsid,
            "searchPartyToken": stored.session.search_party_token,
            "client_id": str(stored.client_id),
            "device_id": str(stored.device_id),
        },
        separators=(",", ":"),
    ).encode("utf-8")
    nonce = os.urandom(12)
    return b"\x01" + nonce + AESGCM(key).encrypt(nonce, clear, _aad(account_key, endpoint))


def decrypt_session(
    envelope: bytes, key: bytes, *, account_key: str, endpoint: str
) -> StoredAppleSession:
    try:
        if len(key) != 32 or not 30 <= len(envelope) <= 32768 or envelope[0] != 1:
            raise ValueError("invalid envelope")
        clear = AESGCM(key).decrypt(
            envelope[1:13], envelope[13:], _aad(account_key, endpoint)
        )
        data = json.loads(clear)
        return StoredAppleSession(
            session=_session_from_mapping(data),
            client_id=uuid.UUID(data["client_id"]),
            device_id=uuid.UUID(data["device_id"]),
        )
    except (InvalidTag, ValueError, TypeError, KeyError) as exc:
        raise AppleAuthenticationError("The shared Apple session is invalid") from exc


def _stored_from_row(
    row: dict[str, Any] | None, key: bytes, *, account_key: str, endpoint: str
) -> StoredAppleSession:
    if row is None:
        raise AppleAuthenticationError("An operator must initialize the shared Apple session")
    if row["anisette_endpoint"].rstrip("/") != endpoint.rstrip("/"):
        raise AppleAuthenticationError("The Apple session Anisette endpoint does not match")
    return decrypt_session(
        bytes(row["encrypted_session"]), key, account_key=account_key, endpoint=endpoint
    )


@dataclass
class SharedAppleAuthManager:
    database_url: str = field(repr=False)
    encryption_key: bytes = field(repr=False)
    account_key: str
    anisette_url: str
    client_id: uuid.UUID = field(default_factory=uuid.uuid4, init=False)
    device_id: uuid.UUID = field(default_factory=uuid.uuid4, init=False)
    retry_initial_seconds: int = 60
    retry_max_seconds: int = 1800
    _revision: int = field(default=0, init=False, repr=False)
    _loaded_session: AppleSession | None = field(default=None, init=False, repr=False)

    def _load(self) -> AppleSession:
        try:
            with _connect(self.database_url) as connection:
                row = connection.execute(
                    """SELECT s.anisette_endpoint, s.encrypted_session, s.revision,
                              t.session_revision AS status_revision, t.phase,
                              t.next_attempt_at, clock_timestamp() AS database_now
                         FROM public.upstream_apple_session s
                         LEFT JOIN public.upstream_apple_session_status t USING (account_key)
                        WHERE s.account_key = %s""",
                    (self.account_key,),
                ).fetchone()
            if row is not None and row.get("status_revision") == row.get("revision"):
                blocked = row.get("phase") in {"recovering", "needs_attention", "authenticating"}
                if row.get("phase") == "upstream_unavailable" and row.get("next_attempt_at"):
                    blocked = row["next_attempt_at"] > row.get("database_now", datetime.now(UTC))
                if blocked:
                    raise AppleAuthenticationError(
                        "Shared Apple authentication is recovering", code="recovery_pending"
                    )
            stored = _stored_from_row(
                row, self.encryption_key,
                account_key=self.account_key, endpoint=self.anisette_url,
            )
        except psycopg.Error as exc:
            raise AppleAuthenticationError("The shared Apple session is unavailable") from exc
        self.client_id, self.device_id = stored.client_id, stored.device_id
        self._revision = int(row.get("revision", 0)) if row is not None else 0
        self._loaded_session = stored.session
        return stored.session

    def session(self) -> AppleSession:
        return self._load()

    def refresh_if_expired(
        self, expired_session: AppleSession, *, status_code: int = 401
    ) -> AppleSession:
        current = self._load()
        if current == expired_session:
            self.reject_session(expired_session, status_code=status_code)
            raise AppleAuthenticationError(
                "An operator must refresh the shared Apple session",
                code="operator_session_refresh_required",
            )
        return current

    def reject_session(self, expired_session: AppleSession, *, status_code: int = 401) -> None:
        if expired_session != self._loaded_session or self._revision <= 0:
            return
        try:
            with _connect(self.database_url) as connection:
                connection.execute(
                    """
                    INSERT INTO public.upstream_apple_session_status
                        (account_key, session_revision, phase, failures, next_attempt_at,
                         last_error, last_http_status)
                    SELECT account_key, revision, 'recovering', 1,
                           clock_timestamp() + %s * interval '1 second',
                           'apple_session_rejected', %s
                      FROM public.upstream_apple_session
                     WHERE account_key = %s AND revision = %s
                    ON CONFLICT (account_key) DO UPDATE SET
                        phase = CASE WHEN upstream_apple_session_status.failures >= 3
                                     THEN 'needs_attention' ELSE 'recovering' END,
                        failures = LEAST(30, upstream_apple_session_status.failures + 1),
                        next_attempt_at = clock_timestamp() + LEAST(%s,
                            %s * power(2, LEAST(upstream_apple_session_status.failures, 20)))
                            * interval '1 second',
                        last_error = 'apple_session_rejected', last_http_status = EXCLUDED.last_http_status,
                        updated_at = clock_timestamp()
                    WHERE upstream_apple_session_status.session_revision = EXCLUDED.session_revision
                      AND upstream_apple_session_status.phase IN ('ready', 'session_unverified', 'upstream_unavailable')
                    """,
                    (self.retry_initial_seconds, status_code, self.account_key, self._revision,
                     self.retry_max_seconds, self.retry_initial_seconds),
                )
        except psycopg.Error as exc:
            raise AppleAuthenticationError("Shared authentication status is unavailable", code="state_unavailable") from exc
        logger.warning("shared_apple_session_rejected http_status=%s", status_code)

    def mark_verified(self, session: AppleSession) -> None:
        if session != self._loaded_session or self._revision <= 0:
            return
        try:
            with _connect(self.database_url) as connection:
                connection.execute(
                    """UPDATE public.upstream_apple_session_status
                          SET phase = 'ready', failures = 0, next_attempt_at = NULL,
                              last_error = NULL, last_http_status = 200,
                              last_verified_at = clock_timestamp(), updated_at = clock_timestamp()
                        WHERE account_key = %s AND session_revision = %s
                          AND phase IN ('ready', 'session_unverified', 'upstream_unavailable')""",
                    (self.account_key, self._revision),
                )
        except psycopg.Error as exc:
            raise AppleAuthenticationError("Shared authentication status is unavailable", code="state_unavailable") from exc
        logger.info("shared_apple_session_verified")

    def note_request_failure(
        self, session: AppleSession, *, code: str, http_status: int | None = None
    ) -> None:
        if session != self._loaded_session or self._revision <= 0:
            return
        # These failures leave the token intact. The coordinator must not turn
        # an Anisette/network outage into a stream of logins or SMS messages.
        try:
            with _connect(self.database_url) as connection:
                connection.execute(
                    """UPDATE public.upstream_apple_session_status
                          SET phase = 'upstream_unavailable', last_error = %s,
                              last_http_status = %s,
                              next_attempt_at = clock_timestamp() + %s * interval '1 second',
                              updated_at = clock_timestamp()
                        WHERE account_key = %s AND session_revision = %s
                          AND phase IN ('ready', 'session_unverified', 'upstream_unavailable')""",
                    (code, http_status, self.retry_initial_seconds, self.account_key, self._revision),
                )
        except psycopg.Error:
            logger.warning("shared_apple_status_write_failed")
        logger.warning("shared_apple_request_failed reason=%s http_status=%s", code, http_status)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    login = commands.add_parser("login", help="Authenticate and store a shared session")
    login.add_argument("--interactive", action="store_true", help="Read password and 2FA from a TTY")
    importer = commands.add_parser("import", help="Import an existing operator session JSON")
    importer.add_argument("--file", required=True)
    encrypted_importer = commands.add_parser("import-state", help="Import a legacy encrypted session and stable IDs")
    encrypted_importer.add_argument("--file", required=True)
    args = parser.parse_args()
    from .config import get_settings

    settings = get_settings()
    key = settings.findmy_session_encryption_key
    if key is None:
        parser.error("PINQEVA_FINDMY_SESSION_ENCRYPTION_KEY is required")
    if settings.findmy_anisette_provider != "http":
        parser.error("Use the stable external Anisette endpoint for shared sessions")
    if args.command == "login" and not settings.findmy_apple_id:
        parser.error("PINQEVA_FINDMY_APPLE_ID is required for login")
    if getattr(args, "interactive", False) and not sys.stdin.isatty():
        parser.error("Interactive authentication requires a TTY")
    account_key = settings.location_account_key
    endpoint = settings.findmy_anisette_url.rstrip("/")
    try:
        with psycopg.Connection[DictRow].connect(
            settings.database_url, connect_timeout=5, row_factory=dict_row
        ) as connection:
            # Only operator commands write credentials. Serialize them so two
            # consoles cannot overwrite one another or run simultaneous 2FA.
            connection.execute("SET LOCAL lock_timeout = '5s'")
            stored_cursor = connection.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"pinqeva:apple-session:{account_key}",),
            )
            row = connection.execute(
                "SELECT anisette_endpoint, encrypted_session "
                "FROM public.upstream_apple_session WHERE account_key = %s FOR UPDATE",
                (account_key,),
            ).fetchone()
            previous = (
                _stored_from_row(row, key, account_key=account_key, endpoint=endpoint)
                if row is not None else None
            )
            client_id = previous.client_id if previous else uuid.uuid4()
            device_id = previous.device_id if previous else uuid.uuid4()
            if args.command == "import":
                session = load_cached_session(args.file)
            elif args.command == "import-state":
                from .findmy_state import SessionStore

                state = SessionStore(
                    args.file, settings.key_encryption_key, settings.findmy_apple_id
                ).read()
                if state is None or state.get("bind_account") or not state.get("session"):
                    raise AppleAuthenticationError("The legacy session is not available for this account")
                imported_client_id = uuid.UUID(state["client_id"])
                imported_device_id = uuid.UUID(state["device_id"])
                if previous is not None and (
                    client_id != imported_client_id or device_id != imported_device_id
                ):
                    raise AppleAuthenticationError("The legacy session identity does not match shared state")
                client_id, device_id = imported_client_id, imported_device_id
                session = _session_from_mapping(state["session"])
            else:
                from .findmy_runtime import create_auth_manager

                # Reuse the enrolled-phone selection, Twilio receiver, and
                # authentication safeguards. The operator's DB transaction
                # provides serialization and durability, with no local cache.
                operator_settings = replace(
                    settings, findmy_state_path="", findmy_auth_file="",
                    findmy_dsid="", findmy_search_party_token="",
                )
                manager = create_auth_manager(
                    operator_settings, background=False, interactive=args.interactive
                )
                if manager is None:
                    raise AppleAuthenticationError("Apple authentication is not configured")
                manager.client_id, manager.device_id = client_id, device_id
                session = manager.initialize()
            encrypted = encrypt_session(
                StoredAppleSession(session, client_id, device_id), key,
                account_key=account_key, endpoint=endpoint,
            )
            connection.execute(
                """
                INSERT INTO public.upstream_apple_session
                    (account_key, anisette_endpoint, encrypted_session)
                VALUES (%s, %s, %s)
                ON CONFLICT (account_key) DO UPDATE SET
                    encrypted_session = EXCLUDED.encrypted_session,
                    revision = upstream_apple_session.revision + 1,
                    updated_at = clock_timestamp()
                RETURNING revision
                """,
                (account_key, endpoint, encrypted),
            )
            revision = stored_cursor.fetchone()
            if revision is None:
                raise AppleAuthenticationError("The shared session could not be stored")
            connection.execute(
                """INSERT INTO public.upstream_apple_session_status
                       (account_key, session_revision, phase, failures,
                        next_attempt_at, last_error, last_http_status,
                        last_login_at, lease_token, lease_expires_at)
                     VALUES (%s, %s, 'session_unverified', 0, NULL, NULL, NULL,
                             clock_timestamp(), NULL, NULL)
                     ON CONFLICT (account_key) DO UPDATE SET
                       session_revision = EXCLUDED.session_revision,
                       phase = 'session_unverified', failures = 0,
                       next_attempt_at = NULL, last_error = NULL,
                       last_http_status = NULL,
                       last_login_at = clock_timestamp(),
                       lease_token = NULL, lease_expires_at = NULL,
                       updated_at = clock_timestamp()""",
                (account_key, revision["revision"]),
            )
    except Exception as exc:
        # Database exceptions can contain SQL/connection details. Do not print
        # exception text, session material, account identity, or passwords.
        code = exc.code if isinstance(exc, AppleAuthenticationError) else type(exc).__name__
        parser.exit(1, f"Shared Apple session operation failed ({code}).\n")
    print("Shared Apple session saved. Workers will read it on their next fetch.")


if __name__ == "__main__":
    main()
