from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
from collections.abc import Coroutine
from typing import Any

from .config import get_settings
from .database import Database, READINESS_QUERY
from .observability import configure_logging


logger = logging.getLogger("pinqeva.worker")


class WorkerHealth:
    """Small private HTTP probe server; contains no operational or user data."""

    def __init__(self, database: Database, stop: asyncio.Event) -> None:
        self.database = database
        self.stop = stop
        self.tasks: list[asyncio.Task] = []

    async def status(self, path: str) -> tuple[int, dict[str, str]]:
        if path not in {"/health", "/ready"}:
            return 404, {"status": "not_found"}
        if self.stop.is_set() or not self.tasks or any(task.done() for task in self.tasks):
            return 503, {"status": "unavailable"}
        if path == "/ready":
            try:
                async with asyncio.timeout(3):
                    async with self.database.transaction() as connection:
                        await connection.execute(READINESS_QUERY)
            except Exception:
                return 503, {"status": "unavailable"}
        return 200, {"status": "ok"}

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            async with asyncio.timeout(5):
                request_line = await reader.readline()
                parts = request_line.decode("ascii", errors="replace").split()
                if len(parts) != 3 or parts[0] != "GET":
                    status, payload = 400, {"status": "invalid_request"}
                else:
                    status, payload = await self.status(parts[1])
                body = json.dumps(payload).encode()
                reason = "OK" if status == 200 else "Unavailable"
                writer.write(
                    f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"
                    f"Content-Length: {len(body)}\r\nConnection: close\r\n"
                    "Cache-Control: no-store\r\n\r\n".encode() + body
                )
                await writer.drain()
        except (TimeoutError, ValueError, OSError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()


async def _run(role: str) -> None:
    settings = get_settings()
    database = Database(settings)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))

    tasks: list[asyncio.Task] = []
    probe: asyncio.Server | None = None
    try:
        await database.open()
        runners: list[tuple[str, Coroutine[Any, Any, None]]] = []
        if role in {"location", "scheduler"}:
            from .location_worker import LocationScheduler, LocationSyncWorker
            from .provider_runtime import available_location_networks, create_location_service

            networks = available_location_networks(settings)
            if not networks:
                raise RuntimeError("No location provider is configured for this worker")
            if role == "scheduler":
                worker = LocationScheduler(database, settings=settings, enabled_networks=networks)
            else:
                worker = LocationSyncWorker(
                    database, create_location_service(settings),
                    settings=settings, enabled_networks=networks,
                )
            runners.append((role, worker.run(stop)))
        if role in {"maintenance", "notification"}:
            from .notifications import ExpoPushGateway, NotificationWorker

            worker = NotificationWorker(
                database, ExpoPushGateway(settings.expo_push_access_token),
                poll_interval_seconds=settings.notification_poll_interval_seconds,
            )
            runners.append(("notification", worker.run(stop)))
        if role in {"maintenance", "retention"}:
            from .premium import PremiumRetentionWorker

            worker = PremiumRetentionWorker(
                database, interval_seconds=settings.premium_retention_interval_seconds,
            )
            runners.append(("retention", worker.run(stop)))
        if role in {"maintenance", "cancellation"}:
            from .cancellation_worker import (
                CancellationWorker, CancellationWorkerSettings,
                PostgresCancellationRepository, StripeCancellationGateway,
            )

            cancel_settings = CancellationWorkerSettings.from_environment()
            worker = CancellationWorker(
                cancel_settings, PostgresCancellationRepository(database),
                StripeCancellationGateway(cancel_settings),
            )
            runners.append(("cancellation", worker.run(stop)))
        tasks = [asyncio.create_task(coro, name=name) for name, coro in runners]
        health = WorkerHealth(database, stop)
        health.tasks = tasks
        probe = await asyncio.start_server(
            health.handle, settings.worker_health_host, settings.worker_health_port,
            limit=4096,
        )
        logger.info("worker_started role=%s queue=%s", role, settings.location_worker_queue)
        stop_waiter = asyncio.create_task(stop.wait())
        try:
            done, _ = await asyncio.wait([*tasks, stop_waiter], return_when=asyncio.FIRST_COMPLETED)
            if stop_waiter not in done:
                for task in done:
                    task.result()
                raise RuntimeError("Worker task stopped unexpectedly")
        finally:
            stop_waiter.cancel()
    finally:
        stop.set()
        if probe is not None:
            probe.close()
            await probe.wait_closed()
        if tasks:
            try:
                async with asyncio.timeout(settings.worker_shutdown_grace_seconds):
                    await asyncio.gather(*tasks, return_exceptions=True)
            except TimeoutError:
                logger.warning("worker_shutdown_deadline role=%s", role)
        await database.close()
        logger.info("worker_stopped role=%s", role)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one independently scalable Pinkeva worker role")
    parser.add_argument("role", choices=("location", "scheduler", "maintenance", "notification", "retention", "cancellation"))
    arguments = parser.parse_args()
    configure_logging()
    try:
        if sys.platform == "win32":
            with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
                runner.run(_run(arguments.role))
        else:
            asyncio.run(_run(arguments.role))
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        logger.error("worker_failed error_type=%s", type(exc).__name__)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
