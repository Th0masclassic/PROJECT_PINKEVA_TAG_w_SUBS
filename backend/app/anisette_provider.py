from __future__ import annotations

import json
import logging
import os
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from anisette import Anisette


logger = logging.getLogger("pinqeva.anisette")

APPLE_MUSIC_APK_URL = (
    "https://apps.mzstatic.com/content/android-apple-music-apk/applemusic.apk"
)
REQUIRED_HEADERS = ("X-Apple-I-MD", "X-Apple-I-MD-M")


class NativeAnisetteError(RuntimeError):
    """Raised when the local Anisette device cannot be loaded or provisioned."""


class NativeAnisetteProvider:
    """Generate Anisette headers with a persistent, process-local virtual device."""

    def __init__(
        self,
        state_path: str | Path,
        *,
        library_source: str = APPLE_MUSIC_APK_URL,
    ) -> None:
        self.state_path = Path(state_path)
        self.library_source = library_source
        self._session: Anisette | None = None
        self._lock = threading.Lock()

    def initialize(self) -> None:
        """Provision and persist the device before the API starts accepting traffic."""

        self.headers()

    def headers(self) -> dict[str, str]:
        with self._lock:
            created = self._session is None and not self.state_path.is_file()
            session = self._load_session()
            try:
                values = session.get_data()
                headers = self._validate_headers(values)
                if created:
                    self._save_session(session)
                    logger.info("native_anisette_state_created")
                return headers
            except NativeAnisetteError:
                raise
            except Exception as exc:
                raise NativeAnisetteError(
                    "The native Anisette device could not produce headers"
                ) from exc

    def _load_session(self) -> Anisette:
        if self._session is not None:
            return self._session

        try:
            if self.state_path.exists():
                if not self.state_path.is_file():
                    raise NativeAnisetteError(
                        "The native Anisette state path is not a file"
                    )
                self._session = Anisette.load(self.state_path)
                logger.info("native_anisette_state_loaded")
            else:
                self._session = Anisette.init(self.library_source)
        except NativeAnisetteError:
            raise
        except Exception as exc:
            raise NativeAnisetteError(
                "The native Anisette state could not be loaded"
            ) from exc
        return self._session

    @staticmethod
    def _validate_headers(values: Any) -> dict[str, str]:
        if not isinstance(values, dict):
            raise NativeAnisetteError("The native Anisette response is invalid")
        headers: dict[str, str] = {}
        for name, value in values.items():
            if isinstance(name, str) and isinstance(value, str):
                headers[name] = value
        if any(not headers.get(name) for name in REQUIRED_HEADERS):
            raise NativeAnisetteError(
                "The native Anisette response is missing required headers"
            )
        return headers

    def _save_session(self, session: Anisette) -> None:
        parent = self.state_path.parent
        temporary_path = parent / f".{self.state_path.name}.{os.getpid()}.tmp"
        try:
            parent.mkdir(parents=True, exist_ok=True)
            session.save_all(temporary_path)
            temporary_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
            os.replace(temporary_path, self.state_path)
        except Exception as exc:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise NativeAnisetteError(
                "The native Anisette state could not be persisted"
            ) from exc


class _AnisetteRequestHandler(BaseHTTPRequestHandler):
    server: NativeAnisetteHTTPServer

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.rstrip("/"):
            self._write_json(404, {"error": "not_found"})
            return
        try:
            self._write_json(200, self.server.provider.headers())
        except NativeAnisetteError as exc:
            logger.warning(
                "native_anisette_request_failed error_type=%s",
                type(exc).__name__,
            )
            self._write_json(503, {"error": "anisette_unavailable"})

    def _write_json(self, status_code: int, payload: dict[str, str]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *args: object) -> None:
        return


class NativeAnisetteHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        provider: NativeAnisetteProvider,
    ) -> None:
        self.provider = provider
        super().__init__(address, _AnisetteRequestHandler)


class NativeAnisetteService:
    """Own the loopback HTTP compatibility server used by the existing client."""

    def __init__(self, url: str, state_path: str | Path) -> None:
        parsed = urlparse(url)
        try:
            port = parsed.port
        except ValueError as exc:
            raise NativeAnisetteError("Native Anisette has an invalid port") from exc
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"127.0.0.1", "localhost"}
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or port == 0
        ):
            raise NativeAnisetteError(
                "Native Anisette must use a loopback HTTP URL without a path"
            )
        self.host = parsed.hostname
        self.port = port or 80
        self.provider = NativeAnisetteProvider(state_path)
        self._server: NativeAnisetteHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._server is not None:
            return
        self.provider.initialize()
        try:
            server = NativeAnisetteHTTPServer(
                (self.host, self.port),
                self.provider,
            )
        except OSError as exc:
            raise NativeAnisetteError(
                "The native Anisette loopback port is unavailable"
            ) from exc
        thread = threading.Thread(
            target=server.serve_forever,
            name="native-anisette-http",
            daemon=True,
        )
        thread.start()
        self._server = server
        self._thread = thread
        logger.info("native_anisette_ready host=%s port=%s", self.host, self.port)

    def stop(self) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server is None:
            return
        server.shutdown()
        server.server_close()
        if thread is not None:
            thread.join(timeout=5)
        logger.info("native_anisette_stopped")
