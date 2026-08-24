from __future__ import annotations

import os
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row

from app.billing import BillingService
from app.config import Settings


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def _free_tcp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


@pytest.fixture(scope="module")
def migrated_postgres_url() -> Iterator[str]:
    initdb = shutil.which("initdb")
    pg_ctl = shutil.which("pg_ctl")
    if initdb is None or pg_ctl is None or getattr(os, "geteuid", lambda: 1)() == 0:
        pytest.skip("local PostgreSQL binaries are unavailable")

    port = _free_tcp_port()
    with tempfile.TemporaryDirectory(prefix="pinqeva-billing-pg-") as temp:
        temporary_root = Path(temp)
        data_directory = temporary_root / "data"
        socket_directory = temporary_root / "socket"
        socket_directory.mkdir()
        subprocess.run(
            [
                initdb,
                "-D",
                str(data_directory),
                "-A",
                "trust",
                "-U",
                "postgres",
                "--no-locale",
                "--encoding=UTF8",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        options = f"-h 127.0.0.1 -p {port} -k {socket_directory}"
        subprocess.run(
            [pg_ctl, "-D", str(data_directory), "-o", options, "-w", "start"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        database_url = (
            f"postgresql://postgres@127.0.0.1:{port}/postgres?sslmode=disable"
        )
        try:
            deadline = time.monotonic() + 10
            while True:
                try:
                    with psycopg.connect(database_url, autocommit=True):
                        break
                except psycopg.OperationalError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.05)

            with psycopg.connect(database_url, autocommit=True) as connection:
                connection.execute("CREATE ROLE anon NOLOGIN")
                connection.execute("CREATE ROLE authenticated NOLOGIN")
                connection.execute("CREATE SCHEMA auth")
                connection.execute("CREATE SCHEMA storage")
                connection.execute(
                    """
                    CREATE TABLE auth.users (
                        id UUID PRIMARY KEY,
                        raw_user_meta_data JSONB NOT NULL DEFAULT '{}'::jsonb
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE TABLE storage.buckets (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        public BOOLEAN NOT NULL DEFAULT FALSE,
                        file_size_limit BIGINT,
                        allowed_mime_types TEXT[]
                    )
                    """
                )
                connection.execute(
                    """
                    CREATE FUNCTION auth.uid() RETURNS UUID
                    LANGUAGE sql STABLE AS $$ SELECT NULL::UUID $$
                    """
                )
                for migration in sorted(
                    (REPOSITORY_ROOT / "supabase" / "migrations").glob("*.sql")
                ):
                    connection.execute(migration.read_text(encoding="utf-8"))
            yield database_url
        finally:
            subprocess.run(
                [pg_ctl, "-D", str(data_directory), "-m", "fast", "-w", "stop"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )


def _settings(database_url: str) -> Settings:
    return Settings(
        database_url=database_url,
        supabase_jwks_url="https://example.invalid/jwks.json",
        supabase_jwt_issuer="https://example.invalid/auth/v1",
        supabase_jwt_audience="authenticated",
        supabase_jwt_algorithms=("ES256",),
        key_encryption_key=os.urandom(32),
        bootstrap_key_encryption_key=os.urandom(32),
        claim_token_key=os.urandom(32),
        session_ttl_seconds=600,
        claim_ttl_seconds=86_400,
        stripe_secret_key="sk_test_12345678901234567890",
        stripe_webhook_secret="whsec_12345678901234567890",
        stripe_price_map=(
            ("monthly_basic", "price_MONTH1234567", "prod_MONTH1234567"),
        ),
        stripe_checkout_success_url="https://app.pinkeva.com/billing/success",
        stripe_checkout_cancel_url="https://app.pinkeva.com/billing/cancelled",
        stripe_portal_return_url="https://app.pinkeva.com/billing/manage/complete",
        stripe_portal_configuration_id="bpc_12345678",
    )


def _subscription_object(
    *, user_id: uuid.UUID, device_id: uuid.UUID, checkout_id: uuid.UUID, status: str
) -> dict[str, Any]:
    return {
        "id": "sub_12345678",
        "customer": "cus_12345678",
        "status": status,
        "cancel_at_period_end": False,
        "metadata": {
            "user_id": str(user_id),
            "device_id": str(device_id),
            "plan_code": "monthly_basic",
            "checkout_id": str(checkout_id),
        },
        "items": {
            "data": [
                {
                    "quantity": 1,
                    "price": {
                        "id": "price_MONTH1234567",
                        "active": True,
                        "type": "recurring",
                        "billing_scheme": "per_unit",
                        "unit_amount": 299,
                        "currency": "eur",
                        "recurring": {
                            "interval": "month",
                            "interval_count": 1,
                            "usage_type": "licensed",
                        },
                        "product": {
                            "id": "prod_MONTH1234567",
                            "active": True,
                        },
                    },
                    "current_period_start": 1_800_000_000,
                    "current_period_end": 1_802_678_400,
                }
            ]
        },
    }


@pytest.mark.asyncio
async def test_former_owner_compensation_is_atomic_and_webhook_confirmed(
    migrated_postgres_url: str,
) -> None:
    user_id = uuid.uuid4()
    device_id = uuid.uuid4()
    checkout_id = uuid.uuid4()
    service = BillingService(_settings(migrated_postgres_url))

    connection = await psycopg.AsyncConnection.connect(
        migrated_postgres_url, row_factory=dict_row
    )
    async with connection:
        async with connection.transaction():
            await connection.execute(
                "INSERT INTO auth.users (id) VALUES (%s)", (user_id,)
            )
            await connection.execute(
                """
                INSERT INTO public.device (id, serial_number, status)
                VALUES (%s, 'PKV-ABCDEF123456', 'claimed')
                """,
                (device_id,),
            )
            await connection.execute(
                """
                INSERT INTO public.plan (
                    code, name, duration_months, price_cents, currency,
                    active, provider_product_id
                ) VALUES (
                    'monthly_basic', 'Monthly', 1, 299, 'EUR', true,
                    'prod_MONTH1234567'
                )
                """
            )
            await connection.execute(
                """
                INSERT INTO public.ownership (
                    user_id, device_id, started_at, ended_at
                ) VALUES (%s, %s, now() - interval '1 day', now())
                """,
                (user_id, device_id),
            )
            await connection.execute(
                """
                UPDATE public.profiles
                   SET stripe_customer_id = 'cus_12345678'
                 WHERE id = %s
                """,
                (user_id,),
            )
            await connection.execute(
                """
                INSERT INTO public.billing_checkout_session (
                    id, user_id, device_id, plan_code,
                    provider_session_id, provider_customer_id,
                    provider_subscription_id, status, expires_at, completed_at
                ) VALUES (
                    %s, %s, %s, 'monthly_basic', 'cs_test_12345678',
                    'cus_12345678', 'sub_12345678', 'completed',
                    now() + interval '1 hour', now()
                )
                """,
                (checkout_id, user_id, device_id),
            )

        active = _subscription_object(
            user_id=user_id,
            device_id=device_id,
            checkout_id=checkout_id,
            status="active",
        )
        async with connection.transaction():
            await service._apply_subscription(
                connection,
                "evt_active123456",
                "customer.subscription.created",
                1_800_000_000,
                active,
            )

        row = await (
            await connection.execute(
                """
                SELECT s.status, s.ended_reason, s.provider_terminal_event_at,
                       queue.status AS queue_status,
                       queue.cancellation_reason, queue.device_release_id
                  FROM public.subscription s
                  JOIN public.subscription_cancellation_outbox queue
                    ON queue.subscription_id = s.id
                 WHERE s.provider_subscription_id = 'sub_12345678'
                """
            )
        ).fetchone()
        assert row == {
            "status": "ended",
            "ended_reason": "ownership_lost_checkout",
            "provider_terminal_event_at": None,
            "queue_status": "pending",
            "cancellation_reason": "ownership_lost_checkout",
            "device_release_id": None,
        }

        async with connection.transaction():
            await service._apply_subscription(
                connection,
                "evt_active234567",
                "customer.subscription.updated",
                1_800_000_001,
                active,
            )
        pending_count = await (
            await connection.execute(
                """
                SELECT count(*)::int AS count
                  FROM public.subscription_cancellation_outbox
                 WHERE status = 'pending'
                """
            )
        ).fetchone()
        assert pending_count["count"] == 1

        terminal = _subscription_object(
            user_id=user_id,
            device_id=device_id,
            checkout_id=checkout_id,
            status="canceled",
        )
        async with connection.transaction():
            await service._apply_subscription(
                connection,
                "evt_cancel123456",
                "customer.subscription.deleted",
                1_800_000_002,
                terminal,
            )
        confirmed = await (
            await connection.execute(
                """
                SELECT queue.status, queue.webhook_confirmed_at,
                       s.provider_terminal_event_at
                  FROM public.subscription_cancellation_outbox queue
                  JOIN public.subscription s ON s.id = queue.subscription_id
                """
            )
        ).fetchone()
        assert confirmed["status"] == "completed"
        assert confirmed["webhook_confirmed_at"] is not None
        assert confirmed["provider_terminal_event_at"] is not None
