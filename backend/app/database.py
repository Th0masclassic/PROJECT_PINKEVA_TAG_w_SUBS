from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from .config import Settings


# Resolve required schema objects without reading any user/location/session data.
READINESS_QUERY = """
SELECT device.last_location_fetched_at, sync.priority, sync.failed_at,
       failure.error_code, budget.request_count, schedule.next_run_at,
       apple.revision, apple_status.phase
  FROM public.device device
  CROSS JOIN public.device_location_sync_state sync
  CROSS JOIN public.location_refresh_failure failure
  CROSS JOIN public.location_rate_limit budget
  CROSS JOIN public.backend_schedule schedule
  CROSS JOIN public.upstream_apple_session apple
  CROSS JOIN public.upstream_apple_session_status apple_status
 WHERE false
"""


class Database:
    def __init__(self, settings: Settings) -> None:
        self.pool = AsyncConnectionPool[AsyncConnection[DictRow]](
            conninfo=settings.database_url,
            min_size=getattr(settings, "database_pool_min_size", 1),
            max_size=getattr(settings, "database_pool_max_size", 10),
            timeout=getattr(settings, "database_pool_timeout_seconds", 5),
            max_waiting=getattr(settings, "database_pool_max_waiting", 100),
            open=False,
            kwargs={
                "row_factory": dict_row,
                "connect_timeout": getattr(settings, "database_connect_timeout_seconds", 5),
                "options": (
                    f"-c statement_timeout={getattr(settings, 'database_statement_timeout_seconds', 30) * 1000} "
                    f"-c lock_timeout={getattr(settings, 'database_lock_timeout_seconds', 5) * 1000}"
                ),
            },
        )

    async def open(self) -> None:
        await self.pool.open(wait=True)

    async def close(self) -> None:
        await self.pool.close()

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[AsyncConnection[DictRow]]:
        async with self.pool.connection() as connection:
            async with connection.transaction():
                yield connection
