"""Worker-only upstream providers isolated by a hard process deadline.

Requests' socket timeout is not an end-to-end timeout (a peer can continually
send small chunks). Each call therefore runs in a disposable process. A timed
out call is killed and reaped before a job can be retried.
"""
from __future__ import annotations

import ctypes
import multiprocessing
import os
import signal
import sys
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .config import Settings
from .apple_auth import AppleAuthenticationError, AppleSession, _session_from_mapping
from .findmy import FindMyClient, FindMyConfigurationError, FindMyRequestError, FinderReport
from .google_findhub import GoogleFindHubBridgeClient, GoogleFindHubRequestError
from .location import LocationService
from .shared_apple_auth import SharedAppleAuthManager


def available_location_networks(settings: Settings) -> frozenset[str]:
    networks: set[str] = set()
    if settings.findmy_session_encryption_key is not None or (
        settings.findmy_dsid and settings.findmy_search_party_token
    ):
        networks.add("apple")
    if settings.google_findhub_bridge_url and settings.google_findhub_bridge_token:
        networks.add("google")
    return frozenset(networks)


@dataclass(frozen=True)
class _EnvironmentAppleSession:
    credentials: AppleSession = field(repr=False)
    client_id: uuid.UUID
    device_id: uuid.UUID

    def session(self) -> AppleSession:
        return self.credentials

    def refresh_if_expired(
        self, expired_session: AppleSession, *, status_code: int = 401
    ) -> AppleSession:
        raise AppleAuthenticationError(
            "An operator must rotate the configured Apple session",
            code="operator_session_refresh_required",
        )

    def reject_session(self, expired_session: AppleSession, *, status_code: int = 401) -> None:
        pass

    def mark_verified(self, session: AppleSession) -> None:
        pass

    def note_request_failure(
        self, session: AppleSession, *, code: str, http_status: int | None = None
    ) -> None:
        pass


def _provider_call(config: dict[str, Any], kwargs: dict[str, Any]) -> list[FinderReport]:
    client: FindMyClient | GoogleFindHubBridgeClient
    if config["provider"] == "apple":
        manager = None
        if config["encryption_key"] is not None:
            manager = SharedAppleAuthManager(
                database_url=config["database_url"],
                encryption_key=config["encryption_key"],
                account_key=config["account_key"],
                anisette_url=config["anisette_url"],
                retry_initial_seconds=config["retry_initial_seconds"],
                retry_max_seconds=config["retry_max_seconds"],
            )
        else:
            # Direct secret-manager credentials remain supported. Derive one
            # stable client identity for the configured account and endpoint,
            # so adding a worker does not randomize those headers.
            identity = f"pinqeva:{config['account_key']}:{config['anisette_url']}"
            manager = _EnvironmentAppleSession(
                credentials=_session_from_mapping({
                    "dsid": config["dsid"], "searchPartyToken": config["token"]
                }),
                client_id=uuid.uuid5(uuid.NAMESPACE_URL, identity + ":client"),
                device_id=uuid.uuid5(uuid.NAMESPACE_URL, identity + ":device"),
            )
        client = FindMyClient(
            dsid=config["dsid"],
            search_party_token=config["token"],
            auth_manager=manager,
            anisette_url=config["anisette_url"],
            timeout_seconds=config["request_timeout"],
            lookback_hours=config["lookback_hours"],
            report_api=config["report_api"],
        )
    else:
        client = GoogleFindHubBridgeClient(
            base_url=config["base_url"],
            service_token=config["service_token"],
            timeout_seconds=config["request_timeout"],
            lookback_hours=config["lookback_hours"],
        )
    return client.fetch_reports(**kwargs)


def _child_entry(
    parent_pid: int,
    sender: Any,
    operation: Callable[[dict[str, Any], dict[str, Any]], Any],
    config: dict[str, Any],
    kwargs: dict[str, Any],
) -> None:
    if sys.platform == "linux":
        # Ensure SIGKILL/container worker loss also terminates outstanding
        # upstream calls. Validate the parent after prctl to close its race.
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent_pid:
            sender.close()
            return
    try:
        sender.send((True, operation(config, kwargs)))
    except BaseException:
        # Sending exception text or chained errors could expose provider
        # credentials and connection strings. Parent gets one safe failure.
        sender.send((False, None))
    finally:
        sender.close()


def _run_isolated(
    operation: Callable[[dict[str, Any], dict[str, Any]], Any],
    config: dict[str, Any],
    kwargs: dict[str, Any],
    *,
    timeout_seconds: float,
) -> Any:
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(
        target=_child_entry,
        args=(os.getpid(), sender, operation, config, kwargs),
        daemon=True,
        name="pinqeva-provider-call",
    )
    timed_out = threading.Event()
    deadline: threading.Timer | None = None

    def kill_at_deadline() -> None:
        timed_out.set()
        if process.is_alive():
            process.kill()

    try:
        process.start()
        sender.close()
        # The watchdog also covers receiving a large pipe message, which can
        # begin before poll() reports ready but finish after its deadline.
        deadline = threading.Timer(timeout_seconds, kill_at_deadline)
        deadline.daemon = True
        deadline.start()
        if not receiver.poll(timeout_seconds):
            raise TimeoutError("The provider operation exceeded its deadline")
        succeeded, value = receiver.recv()
        if timed_out.is_set():
            raise TimeoutError("The provider operation exceeded its deadline")
        if not succeeded:
            raise RuntimeError("The provider operation failed")
        return value
    except (EOFError, BrokenPipeError) as exc:
        raise RuntimeError("The provider operation ended unexpectedly") from exc
    finally:
        if deadline is not None:
            deadline.cancel()
            deadline.join()
        sender.close()
        receiver.close()
        if process.pid is not None:
            if process.is_alive():
                process.kill()
            process.join(timeout=2)
            if process.is_alive():
                # Fail closed: the caller must not interpret an un-reaped
                # process as success and acknowledge the refresh.
                raise RuntimeError("The provider process could not be stopped")
            process.close()


@dataclass(frozen=True)
class _IsolatedProviderClient:
    config: dict[str, Any] = field(repr=False)
    timeout_seconds: float

    def fetch_reports(self, **kwargs: Any) -> list[FinderReport]:
        try:
            return _run_isolated(
                _provider_call, self.config, kwargs,
                timeout_seconds=self.timeout_seconds,
            )
        except (TimeoutError, RuntimeError, OSError) as exc:
            error = (
                FindMyRequestError if self.config["provider"] == "apple"
                else GoogleFindHubRequestError
            )
            raise error("The location provider is temporarily unavailable") from exc


class WorkerLocationService(LocationService):
    def _apple_configured(self) -> bool:
        return "apple" in available_location_networks(self.settings)

    def _client(self) -> _IsolatedProviderClient:
        settings = self.settings
        return _IsolatedProviderClient(
            {
                "provider": "apple",
                "database_url": settings.database_url,
                "encryption_key": settings.findmy_session_encryption_key,
                "account_key": settings.location_account_key,
                "retry_initial_seconds": settings.findmy_retry_initial_seconds,
                "retry_max_seconds": settings.findmy_retry_max_seconds,
                "anisette_url": settings.findmy_anisette_url,
                "dsid": settings.findmy_dsid,
                "token": settings.findmy_search_party_token,
                "request_timeout": settings.findmy_request_timeout_seconds,
                "lookback_hours": settings.findmy_lookback_hours,
                "report_api": settings.findmy_report_api,
            },
            timeout_seconds=max(0.1, settings.location_job_timeout_seconds - 2),
        )

    def _google_client(self) -> _IsolatedProviderClient:
        settings = self.settings
        return _IsolatedProviderClient(
            {
                "provider": "google",
                "base_url": settings.google_findhub_bridge_url,
                "service_token": settings.google_findhub_bridge_token,
                "request_timeout": settings.findmy_request_timeout_seconds,
                "lookback_hours": settings.findmy_lookback_hours,
            },
            timeout_seconds=max(0.1, settings.location_job_timeout_seconds - 2),
        )


def create_location_service(settings: Settings) -> LocationService:
    if "apple" in available_location_networks(settings):
        if settings.findmy_anisette_provider != "http":
            raise FindMyConfigurationError(
                "Distributed workers require a stable external Anisette endpoint"
            )
    return WorkerLocationService(settings)
