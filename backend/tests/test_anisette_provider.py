import json
import threading
from pathlib import Path
from urllib.request import urlopen

import pytest

from app import anisette_provider
from app.anisette_provider import (
    NativeAnisetteError,
    NativeAnisetteHTTPServer,
    NativeAnisetteProvider,
    NativeAnisetteService,
)


class _FakeSession:
    def __init__(self) -> None:
        self.save_count = 0

    def get_data(self) -> dict[str, str]:
        return {
            "X-Apple-I-MD": "otp",
            "X-Apple-I-MD-M": "machine",
            "X-Apple-I-MD-RINFO": "17106176",
        }

    def save_all(self, path: str | Path) -> None:
        self.save_count += 1
        Path(path).write_bytes(b"persistent-anisette-state")


class _FakeAnisette:
    initialized_from: list[str] = []
    loaded_from: list[Path] = []
    session = _FakeSession()

    @classmethod
    def init(cls, source: str) -> _FakeSession:
        cls.initialized_from.append(source)
        return cls.session

    @classmethod
    def load(cls, path: str | Path) -> _FakeSession:
        cls.loaded_from.append(Path(path))
        return cls.session


@pytest.fixture(autouse=True)
def fake_anisette(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeAnisette.initialized_from = []
    _FakeAnisette.loaded_from = []
    _FakeAnisette.session = _FakeSession()
    monkeypatch.setattr(anisette_provider, "Anisette", _FakeAnisette)


def test_new_native_device_is_provisioned_and_saved_once(tmp_path: Path) -> None:
    state_path = tmp_path / "state" / "anisette.bin"
    provider = NativeAnisetteProvider(state_path, library_source="apple.apk")

    assert provider.headers()["X-Apple-I-MD"] == "otp"
    assert provider.headers()["X-Apple-I-MD-M"] == "machine"

    assert _FakeAnisette.initialized_from == ["apple.apk"]
    assert _FakeAnisette.loaded_from == []
    assert _FakeAnisette.session.save_count == 1
    assert state_path.read_bytes() == b"persistent-anisette-state"


def test_existing_native_device_is_loaded_without_replacement(tmp_path: Path) -> None:
    state_path = tmp_path / "anisette.bin"
    state_path.write_bytes(b"existing-state")
    provider = NativeAnisetteProvider(state_path)

    assert provider.headers()["X-Apple-I-MD"] == "otp"

    assert _FakeAnisette.initialized_from == []
    assert _FakeAnisette.loaded_from == [state_path]
    assert _FakeAnisette.session.save_count == 0
    assert state_path.read_bytes() == b"existing-state"


def test_invalid_existing_state_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_path = tmp_path / "anisette.bin"
    state_path.write_bytes(b"invalid-state")

    def fail_load(_path: str | Path) -> _FakeSession:
        raise ValueError("corrupt")

    monkeypatch.setattr(_FakeAnisette, "load", fail_load)

    with pytest.raises(NativeAnisetteError):
        NativeAnisetteProvider(state_path).headers()

    assert _FakeAnisette.initialized_from == []
    assert state_path.read_bytes() == b"invalid-state"


def test_native_failure_reloads_same_identity_after_backoff(tmp_path, monkeypatch):
    state = tmp_path / "anisette.bin"
    state.write_bytes(b"keep-this-identity")
    provider = NativeAnisetteProvider(state)
    old = _FakeAnisette.session
    monkeypatch.setattr(old, "get_data", lambda: (_ for _ in ()).throw(RuntimeError("temporary outage")))
    with pytest.raises(NativeAnisetteError):
        provider.headers()
    with pytest.raises(NativeAnisetteError):
        provider.headers()
    assert _FakeAnisette.loaded_from == [state]
    _FakeAnisette.session = _FakeSession()
    monkeypatch.setattr("app.anisette_provider.time.monotonic", lambda: provider._retry_at + 1)
    assert provider.headers()["X-Apple-I-MD"] == "otp"
    assert _FakeAnisette.loaded_from == [state, state]
    assert _FakeAnisette.initialized_from == []
    assert state.read_bytes() == b"keep-this-identity"


def test_native_http_start_does_not_wait_for_apple_provisioning(tmp_path, monkeypatch):
    service = NativeAnisetteService("http://127.0.0.1:6970", tmp_path / "state.bin")
    service.port = 0  # OS-selected test port; production validation still forbids zero.
    monkeypatch.setattr(service.provider, "initialize", lambda: pytest.fail("Startup must not block on Apple"))
    try:
        service.start()
        assert service._server is not None
    finally:
        service.stop()


def test_native_save_is_private_before_library_writes(tmp_path, monkeypatch):
    import os
    provider = NativeAnisetteProvider(tmp_path / "state.bin")
    session = _FakeAnisette.session
    save = session.save_all

    def checked_save(path):
        assert Path(path).exists()
        if os.name != "nt":
            assert Path(path).stat().st_mode & 0o077 == 0
        save(path)

    monkeypatch.setattr(session, "save_all", checked_save)
    provider.headers()


def test_loopback_http_compatibility_endpoint_returns_headers(tmp_path: Path) -> None:
    provider = NativeAnisetteProvider(tmp_path / "anisette.bin")
    server = NativeAnisetteHTTPServer(("127.0.0.1", 0), provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with urlopen(
            f"http://127.0.0.1:{server.server_port}/",
            timeout=5,
        ) as response:
            payload = json.load(response)
        assert response.status == 200
        assert payload["X-Apple-I-MD"] == "otp"
        assert payload["X-Apple-I-MD-M"] == "machine"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:6970",
        "http://example.com:6970",
        "http://127.0.0.1:6970/headers",
        "http://user@127.0.0.1:6970",
        "http://127.0.0.1:0",
        "http://127.0.0.1:99999",
    ],
)
def test_native_service_rejects_non_loopback_or_routed_urls(
    url: str,
    tmp_path: Path,
) -> None:
    with pytest.raises(NativeAnisetteError):
        NativeAnisetteService(url, tmp_path / "anisette.bin")
