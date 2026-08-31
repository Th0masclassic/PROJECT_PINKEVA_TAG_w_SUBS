"""Private, atomic state files and a non-blocking lock shared by API and CLI."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag


class StateError(RuntimeError):
    pass


class StateBusy(StateError):
    pass


def atomic_json(path: Path, value: dict) -> None:
    """Create private permissions BEFORE writing; never expose a partial file."""
    temporary: str | None = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, separators=(",", ":"), allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        temporary = None
    except (OSError, ValueError, TypeError) as exc:
        raise StateError("state_write_failed") from exc
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


class SessionStore:
    def __init__(self, path: str, key: bytes, account: str) -> None:
        if len(key) != 32:
            raise ValueError("Session state requires a 32-byte encryption root")
        self.path = Path(path)
        self.status_path = Path(path + ".status.json")
        self.key = hmac.new(
            key, b"pinqeva:findmy-state:key:v1", hashlib.sha256
        ).digest()
        self.aad = (
            b"pinqeva:findmy-state:v1:"
            + hashlib.sha256(account.strip().lower().encode()).digest()
        )
        self.unbound_aad = b"pinqeva:findmy-state:v1:" + hashlib.sha256(b"").digest()

    def read(self) -> dict | None:
        if not self.path.exists():
            return None
        try:
            if self.path.stat().st_size > 65536:
                raise ValueError("oversized")
            envelope = json.loads(self.path.read_text(encoding="utf-8"))
            if envelope["version"] != 1:
                raise ValueError("version")
            nonce = base64.b64decode(envelope["nonce"], validate=True)
            ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
            upgrading = False
            try:
                clear = AESGCM(self.key).decrypt(nonce, ciphertext, self.aad)
            except InvalidTag:
                if self.aad == self.unbound_aad:
                    raise
                # Adopting credentials after cache-only mode must discard the
                # unbound token, never assume it belongs to the new account.
                clear = AESGCM(self.key).decrypt(nonce, ciphertext, self.unbound_aad)
                upgrading = True
            result = json.loads(clear)
            if not isinstance(result, dict):
                raise ValueError("mapping")
            if upgrading:
                result.update(
                    session=None,
                    phase="recovering",
                    manual_required=False,
                    retry_at=0,
                    failures=0,
                    last_error=None,
                    verified_at=None,
                    login_at=None,
                    http_status=None,
                    source="none",
                    bind_account=True,
                )
            return result
        except Exception as exc:
            raise StateError("state_read_failed") from exc

    def write(self, value: dict) -> None:
        nonce = os.urandom(12)
        encrypted = AESGCM(self.key).encrypt(
            nonce, json.dumps(value, allow_nan=False).encode(), self.aad
        )
        atomic_json(
            self.path,
            {
                "version": 1,
                "nonce": base64.b64encode(nonce).decode(),
                "ciphertext": base64.b64encode(encrypted).decode(),
            },
        )

    @contextmanager
    def lock(self) -> Iterator[None]:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(str(self.path) + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        with os.fdopen(fd, "r+b") as handle:
            try:
                if os.name == "nt":
                    import msvcrt

                    if os.fstat(handle.fileno()).st_size == 0:
                        handle.write(b"0")
                        handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise StateBusy("authentication_in_progress") from exc
            try:
                yield
            finally:
                if os.name == "nt":
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
