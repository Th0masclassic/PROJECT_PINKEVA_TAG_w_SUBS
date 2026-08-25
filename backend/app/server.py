from __future__ import annotations

"""Local Uvicorn launcher with a Psycopg-compatible Windows event loop."""

import asyncio
import sys
from collections.abc import Callable

import uvicorn


def _loop_factory() -> str | Callable[[], asyncio.AbstractEventLoop]:
    # Python 3.14 defaults to ProactorEventLoop on Windows. Psycopg's async
    # connection pool requires a selector loop, and Uvicorn accepts a direct
    # loop factory without changing global/deprecated event-loop policy.
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop
    return "auto"


def main() -> None:
    uvicorn.run(
        "app.main:app",
        env_file=".env",
        host="127.0.0.1",
        port=8080,
        loop=_loop_factory(),
    )


if __name__ == "__main__":
    main()
