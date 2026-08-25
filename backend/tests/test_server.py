from __future__ import annotations

import asyncio
import sys

from app import server
from app import main as app_main


def test_windows_launcher_uses_selector_loop() -> None:
    loop_factory = server._loop_factory()

    if sys.platform == "win32":
        assert loop_factory is asyncio.SelectorEventLoop
    else:
        assert loop_factory == "auto"


def test_direct_uvicorn_loop_factory_is_selector_compatible() -> None:
    assert app_main._selector_loop_factory() is asyncio.SelectorEventLoop

    if sys.platform == "win32":
        import uvicorn.config

        assert uvicorn.config.LOOP_FACTORIES["auto"] == "app.main:_selector_loop_factory"
        assert uvicorn.config.LOOP_FACTORIES["asyncio"] == "app.main:_selector_loop_factory"


def test_server_main_passes_the_compatible_loop_to_uvicorn(monkeypatch) -> None:
    calls: list[tuple[str, dict[str, object]]] = []
    monkeypatch.setattr(
        server.uvicorn,
        "run",
        lambda app, **kwargs: calls.append((app, kwargs)),
    )

    server.main()

    assert calls == [
        (
            "app.main:app",
            {
                "env_file": ".env",
                "host": "127.0.0.1",
                "port": 8080,
                "loop": server._loop_factory(),
            },
        )
    ]
