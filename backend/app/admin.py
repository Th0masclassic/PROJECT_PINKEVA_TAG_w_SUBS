from __future__ import annotations

import asyncio
import os
import re
from typing import Annotated, Any, Literal
from uuid import UUID, uuid4

import stripe
from fastapi import APIRouter, Path, Query, Request, status
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import Field, field_validator

from .auth import AuthenticatedPrincipal, Principal
from .billing import _as_mapping, _billing_terms, _object_id
from .config import Settings
from .crypto import b64url_encode, encrypt_device_bootstrap_key
from .database import Database
from .models import SERIAL_PATTERN, StrictModel


class AdminError(RuntimeError):
    def __init__(self, code: str, status_code: int) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code


class AdminPlanPriceUpdate(StrictModel):
    amount_minor: int = Field(ge=50, le=10_000_000)
    currency: str = Field(min_length=3, max_length=3, pattern=r"^[A-Za-z]{3}$")
    expected_version: int = Field(ge=1)

    @field_validator("currency")
    @classmethod
    def normalize_currency(cls, value: str) -> str:
        return value.upper()


class AdminSubscriptionGrant(StrictModel):
    plan_code: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
    )


class AdminDeviceRegistration(StrictModel):
    serial_number: str = Field(min_length=16, max_length=16)
    name: str = Field(default="Pinkeva Tag", min_length=1, max_length=120)

    @field_validator("serial_number")
    @classmethod
    def normalize_serial(cls, value: str) -> str:
        normalized = value.upper()
        if not SERIAL_PATTERN.fullmatch(normalized):
            raise ValueError("invalid serial")
        return normalized

    @field_validator("name")
    @classmethod
    def safe_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized or re.search(r"[\x00-\x1f\x7f]", normalized):
            raise ValueError("invalid name")
        return normalized


class AdminDeviceUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    firmware_version: str | None = Field(default=None, max_length=64)
    status: Literal["unprovisioned", "claimed", "suspended"] | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    place: str | None = Field(default=None, max_length=160)

    @field_validator("name")
    @classmethod
    def safe_update_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized or re.search(r"[\x00-\x1f\x7f]", normalized):
            raise ValueError("invalid text")
        return normalized

    @field_validator("firmware_version", "place")
    @classmethod
    def safe_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            return None
        if re.search(r"[\x00-\x1f\x7f]", normalized):
            raise ValueError("invalid text")
        return normalized


class AdminService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def role_for(
        self,
        database: Database,
        principal: Principal,
        *,
        require_mfa: bool = True,
        require_owner: bool = False,
    ) -> Literal["owner", "admin"]:
        if principal.user_id in self.settings.admin_owner_user_ids:
            role: Literal["owner", "admin"] = "owner"
        else:
            async with database.transaction() as connection:
                cursor = await connection.execute(
                    """
                    SELECT 1
                      FROM public.admin_role_assignment
                     WHERE user_id = %s AND revoked_at IS NULL
                     LIMIT 1
                    """,
                    (principal.user_id,),
                )
                if await cursor.fetchone() is None:
                    raise AdminError("ADMIN_ACCESS_DENIED", 403)
            role = "admin"

        if require_owner and role != "owner":
            raise AdminError("ADMIN_OWNER_REQUIRED", 403)
        if (
            require_mfa
            and self.settings.admin_require_aal2
            and principal.assurance_level != "aal2"
        ):
            raise AdminError("ADMIN_MFA_REQUIRED", 403)
        return role

    @staticmethod
    async def audit(
        connection: Any,
        *,
        actor_user_id: UUID,
        action: str,
        target_type: str,
        target_id: str | None,
        request_id: UUID,
        details: dict[str, Any] | None = None,
    ) -> None:
        await connection.execute(
            """
            INSERT INTO public.admin_audit_log (
                actor_user_id, action, target_type, target_id,
                request_id, details
            ) VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                actor_user_id,
                action,
                target_type,
                target_id,
                request_id,
                Jsonb(details or {}),
            ),
        )

    async def deactivate_price_if_unbound(
        self, database: Database, price_id: str
    ) -> None:
        """Deactivate a failed Stripe price only when no plan adopted it.

        Identical concurrent updates intentionally share a Stripe idempotency
        key. The losing database transaction can therefore receive the same
        Price object as the winner and must not deactivate the winner's price.
        """

        try:
            async with database.transaction() as connection:
                cursor = await connection.execute(
                    """
                    SELECT EXISTS (
                      SELECT 1 FROM public.plan WHERE provider_price_id = %s
                    ) AS is_bound
                    """,
                    (price_id,),
                )
                row = await cursor.fetchone()
        except Exception:
            # Leaving an unreachable Price active is safer than disabling a
            # potentially current price when the database cannot confirm it.
            return
        if row is None or bool(row["is_bound"]):
            return
        try:
            await asyncio.to_thread(
                stripe.Price.modify,
                price_id,
                api_key=self.settings.stripe_secret_key,
                stripe_version=self.settings.stripe_api_version,
                active=False,
            )
        except Exception:
            return

    async def me(self, database: Database, principal: Principal) -> dict[str, Any]:
        role = await self.role_for(database, principal, require_mfa=False)
        return {
            "user_id": principal.user_id,
            "role": role,
            "assurance_level": principal.assurance_level,
            "mfa_required": self.settings.admin_require_aal2,
            "mfa_satisfied": (
                not self.settings.admin_require_aal2
                or principal.assurance_level == "aal2"
            ),
        }

    async def overview(self, database: Database, principal: Principal) -> dict[str, int]:
        await self.role_for(database, principal)
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT
                  (SELECT count(*) FROM public.profiles) AS users,
                  (SELECT count(*) FROM public.device) AS devices,
                  (SELECT count(*) FROM public.ownership WHERE ended_at IS NULL)
                    AS owned_devices,
                  (SELECT count(*) FROM public.subscription
                    WHERE status NOT IN ('cancelled', 'ended'))
                    AS current_subscriptions,
                  (SELECT count(*) FROM public.device
                    WHERE status = 'unprovisioned') AS available_devices
                """
            )
            return dict(await cursor.fetchone())

    async def integrity(
        self, database: Database, principal: Principal
    ) -> dict[str, Any]:
        """Return non-sensitive operational invariants for administrator review."""

        await self.role_for(database, principal)
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT now() AS checked_at,
                  (
                    SELECT count(*)
                      FROM public.device device
                      LEFT JOIN public.device_bootstrap_credential credential
                        ON credential.device_id = device.id
                     WHERE credential.device_id IS NULL
                  ) AS devices_missing_bootstrap_credentials,
                  (
                    SELECT count(*)
                      FROM public.device device
                     WHERE device.status = 'claimed'
                       AND NOT EXISTS (
                         SELECT 1 FROM public.ownership ownership
                          WHERE ownership.device_id = device.id
                            AND ownership.ended_at IS NULL
                       )
                  ) AS claimed_devices_without_active_owner,
                  (
                    SELECT count(*)
                      FROM public.ownership ownership
                      JOIN public.device device ON device.id = ownership.device_id
                     WHERE ownership.ended_at IS NULL
                       AND device.status NOT IN ('claimed', 'suspended')
                  ) AS active_ownership_device_state_mismatches,
                  (
                    SELECT count(*)
                      FROM public.subscription subscription
                     WHERE subscription.status NOT IN ('cancelled', 'ended')
                       AND NOT EXISTS (
                         SELECT 1 FROM public.ownership ownership
                          WHERE ownership.user_id = subscription.user_id
                            AND ownership.device_id = subscription.device_id
                            AND ownership.ended_at IS NULL
                       )
                  ) AS current_subscriptions_without_active_ownership,
                  (
                    SELECT count(*)
                      FROM public.subscription_cancellation_outbox cancellation
                     WHERE cancellation.status = 'failed'
                  ) AS failed_cancellation_jobs,
                  (
                    SELECT count(*)
                      FROM public.provisioning_request request
                     WHERE (
                       request.status IN ('pending', 'creating', 'open')
                       AND request.expires_at < now()
                     ) OR (
                       request.status IN ('paid', 'claiming')
                       AND COALESCE(request.claim_deadline, request.expires_at) < now()
                     )
                  ) AS overdue_provisioning_requests,
                  (
                    SELECT count(*) FROM public.admin_role_assignment assignment
                     WHERE assignment.revoked_at IS NULL
                  ) AS active_database_admins,
                  (
                    SELECT audit.created_at FROM public.admin_audit_log audit
                     ORDER BY audit.created_at DESC, audit.id DESC
                     LIMIT 1
                  ) AS last_audit_at
                """
            )
            result = dict(await cursor.fetchone())

            configured_owners = self.settings.admin_owner_user_ids
            configured_owner_profiles = 0
            if configured_owners:
                owner_cursor = await connection.execute(
                    """
                    SELECT count(*) AS owner_profiles FROM public.profiles
                     WHERE id = ANY(%s::uuid[])
                    """,
                    (list(configured_owners),),
                )
                configured_owner_profiles = int(
                    (await owner_cursor.fetchone())["owner_profiles"]
                )

        checks = {
            "configured_owners_missing_profiles": max(
                0, len(configured_owners) - configured_owner_profiles
            ),
            "devices_missing_bootstrap_credentials": int(
                result["devices_missing_bootstrap_credentials"]
            ),
            "claimed_devices_without_active_owner": int(
                result["claimed_devices_without_active_owner"]
            ),
            "active_ownership_device_state_mismatches": int(
                result["active_ownership_device_state_mismatches"]
            ),
            "current_subscriptions_without_active_ownership": int(
                result["current_subscriptions_without_active_ownership"]
            ),
            "failed_cancellation_jobs": int(result["failed_cancellation_jobs"]),
            "overdue_provisioning_requests": int(
                result["overdue_provisioning_requests"]
            ),
        }
        critical_names = {
            "configured_owners_missing_profiles",
            "claimed_devices_without_active_owner",
            "active_ownership_device_state_mismatches",
            "current_subscriptions_without_active_ownership",
        }
        critical_issues = sum(checks[name] for name in critical_names)
        warnings = sum(
            count for name, count in checks.items() if name not in critical_names
        )
        return {
            "status": (
                "healthy" if critical_issues == 0 and warnings == 0 else "degraded"
            ),
            "checked_at": result["checked_at"],
            "critical_issues": critical_issues,
            "warnings": warnings,
            "checks": checks,
            "metrics": {
                "configured_owners": len(configured_owners),
                "active_database_admins": int(result["active_database_admins"]),
                "last_audit_at": result["last_audit_at"],
            },
        }

    async def users(
        self,
        database: Database,
        principal: Principal,
        *,
        search: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        await self.role_for(database, principal)
        needle = search.strip().lower()[:160]
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                WITH selected_profile AS (
                  SELECT profile.id, profile.display_name, profile.email,
                         profile.created_at
                    FROM public.profiles profile
                   WHERE %s = ''
                      OR position(%s in lower(COALESCE(profile.email, ''))) > 0
                      OR position(%s in lower(COALESCE(profile.display_name, ''))) > 0
                      OR profile.id::text = %s
                   ORDER BY profile.created_at DESC, profile.id
                   LIMIT %s
                )
                SELECT profile.id, profile.display_name, profile.email,
                       profile.created_at,
                       (
                         SELECT count(*) FROM public.ownership ownership
                          WHERE ownership.user_id = profile.id
                            AND ownership.ended_at IS NULL
                       ) AS tracker_count,
                       (
                         SELECT count(*) FROM public.subscription subscription
                          WHERE subscription.user_id = profile.id
                            AND subscription.status NOT IN ('cancelled', 'ended')
                       ) AS subscription_count,
                       EXISTS (
                         SELECT 1 FROM public.admin_role_assignment role
                           WHERE role.user_id = profile.id AND role.revoked_at IS NULL
                       ) AS is_admin
                  FROM selected_profile profile
                 ORDER BY profile.created_at DESC, profile.id
                """,
                (needle, needle, needle, needle, limit),
            )
            rows = [dict(row) for row in await cursor.fetchall()]
            for row in rows:
                row["is_admin"] = bool(row["is_admin"]) or (
                    row["id"] in self.settings.admin_owner_user_ids
                )
            return rows

    async def user_trackers(
        self, database: Database, principal: Principal, user_id: UUID
    ) -> dict[str, Any]:
        await self.role_for(database, principal)
        async with database.transaction() as connection:
            profile_cursor = await connection.execute(
                """
                SELECT id, display_name, email, created_at
                  FROM public.profiles WHERE id = %s
                """,
                (user_id,),
            )
            profile = await profile_cursor.fetchone()
            if profile is None:
                raise AdminError("ADMIN_RESOURCE_NOT_FOUND", 404)
            cursor = await connection.execute(
                """
                SELECT device.id, device.serial_number, device.name,
                       device.status, device.firmware_version,
                       device.last_latitude, device.last_longitude,
                       device.last_location_at, device.last_place,
                       ownership.started_at,
                       subscription.id AS subscription_id,
                       subscription.status AS subscription_status,
                       subscription.plan_code,
                       subscription.current_period_end,
                       subscription.source AS subscription_source
                  FROM public.ownership ownership
                  JOIN public.device device ON device.id = ownership.device_id
                  LEFT JOIN LATERAL (
                    SELECT current_subscription.*
                      FROM public.subscription current_subscription
                     WHERE current_subscription.device_id = device.id
                       AND current_subscription.status NOT IN ('cancelled', 'ended')
                     ORDER BY current_subscription.created_at DESC
                     LIMIT 1
                  ) subscription ON true
                 WHERE ownership.user_id = %s AND ownership.ended_at IS NULL
                 ORDER BY ownership.started_at DESC
                """,
                (user_id,),
            )
            return {
                "user": dict(profile),
                "trackers": [dict(row) for row in await cursor.fetchall()],
            }

    async def plans(self, database: Database, principal: Principal) -> list[dict[str, Any]]:
        await self.role_for(database, principal)
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT code, name, duration_months, price_cents, currency,
                       active, provider_price_id, provider_product_id,
                       price_version, updated_at
                  FROM public.plan
                 ORDER BY duration_months, code
                """
            )
            return [dict(row) for row in await cursor.fetchall()]

    async def update_plan_price(
        self,
        database: Database,
        principal: Principal,
        *,
        plan_code: str,
        update: AdminPlanPriceUpdate,
        request_id: UUID,
    ) -> dict[str, Any]:
        await self.role_for(database, principal)
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT code, duration_months, price_cents, currency, active,
                       provider_price_id, provider_product_id, price_version
                  FROM public.plan WHERE code = %s
                """,
                (plan_code,),
            )
            plan = await cursor.fetchone()
        if plan is None or plan["provider_product_id"] is None:
            raise AdminError("ADMIN_RESOURCE_NOT_FOUND", 404)
        if int(plan["price_version"]) != update.expected_version:
            raise AdminError("ADMIN_CONFLICT", 409)

        interval, interval_count = _billing_terms(int(plan["duration_months"]))
        try:
            created = await asyncio.to_thread(
                stripe.Price.create,
                api_key=self.settings.stripe_secret_key,
                stripe_version=self.settings.stripe_api_version,
                idempotency_key=(
                    "pinqeva-admin-price-v1:"
                    f"{plan_code}:{update.expected_version + 1}:"
                    f"{update.amount_minor}:{update.currency}"
                ),
                product=plan["provider_product_id"],
                unit_amount=update.amount_minor,
                currency=update.currency.lower(),
                recurring={
                    "interval": interval,
                    "interval_count": interval_count,
                    "usage_type": "licensed",
                },
                metadata={
                    "plan_code": plan_code,
                    "price_version": str(update.expected_version + 1),
                },
            )
            price = _as_mapping(created)
            price_id = _object_id(price.get("id"))
        except Exception:
            raise AdminError("ADMIN_PROVIDER_UNAVAILABLE", 503) from None
        if price_id is None or not price_id.startswith("price_"):
            raise AdminError("ADMIN_PROVIDER_UNAVAILABLE", 503)

        try:
            async with database.transaction() as connection:
                updated = await connection.execute(
                    """
                    UPDATE public.plan
                       SET price_cents = %s, currency = %s,
                           provider_price_id = %s,
                           price_version = price_version + 1,
                           updated_at = now()
                     WHERE code = %s AND price_version = %s
                    RETURNING code, name, duration_months, price_cents, currency,
                              active, provider_price_id, provider_product_id,
                              price_version, updated_at
                    """,
                    (
                        update.amount_minor,
                        update.currency,
                        price_id,
                        plan_code,
                        update.expected_version,
                    ),
                )
                result = await updated.fetchone()
                if result is None:
                    raise AdminError("ADMIN_CONFLICT", 409)
                await connection.execute(
                    """
                    UPDATE public.plan_price_history
                       SET active_for_new = false
                     WHERE plan_code = %s AND active_for_new = true
                    """,
                    (plan_code,),
                )
                await connection.execute(
                    """
                    INSERT INTO public.plan_price_history (
                        plan_code, provider_price_id, provider_product_id,
                        amount_cents, currency, duration_months, price_version,
                        active_for_new, created_by_admin_user_id
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, true, %s)
                    """,
                    (
                        plan_code,
                        price_id,
                        plan["provider_product_id"],
                        update.amount_minor,
                        update.currency,
                        plan["duration_months"],
                        update.expected_version + 1,
                        principal.user_id,
                    ),
                )
                await self.audit(
                    connection,
                    actor_user_id=principal.user_id,
                    action="plan.price_changed",
                    target_type="plan",
                    target_id=plan_code,
                    request_id=request_id,
                    details={
                        "old_amount_minor": int(plan["price_cents"]),
                        "new_amount_minor": update.amount_minor,
                        "old_currency": str(plan["currency"]),
                        "new_currency": update.currency,
                        "price_version": update.expected_version + 1,
                    },
                )
            return dict(result)
        except Exception:
            # A Stripe Price is immutable. If the optimistic database update
            # loses a race (or the transaction fails), disable it only if no
            # concurrent winner adopted the same idempotent Price object.
            await self.deactivate_price_if_unbound(database, price_id)
            raise

    async def grant_subscription(
        self,
        database: Database,
        principal: Principal,
        *,
        user_id: UUID,
        device_id: UUID,
        grant: AdminSubscriptionGrant,
        request_id: UUID,
    ) -> dict[str, Any]:
        await self.role_for(database, principal)
        subscription_id = uuid4()
        async with database.transaction() as connection:
            ownership = await connection.execute(
                """
                SELECT 1 FROM public.ownership
                 WHERE user_id = %s AND device_id = %s AND ended_at IS NULL
                 FOR UPDATE
                """,
                (user_id, device_id),
            )
            if await ownership.fetchone() is None:
                raise AdminError("ADMIN_RESOURCE_NOT_FOUND", 404)
            plan_cursor = await connection.execute(
                """
                SELECT code, duration_months FROM public.plan
                 WHERE code = %s AND active = true
                """,
                (grant.plan_code,),
            )
            plan = await plan_cursor.fetchone()
            if plan is None:
                raise AdminError("ADMIN_RESOURCE_NOT_FOUND", 404)
            try:
                inserted = await connection.execute(
                    """
                    INSERT INTO public.subscription (
                        id, user_id, device_id, plan_code, status, starts_at,
                        current_period_end, cancel_at_period_end, source,
                        created_by_admin_user_id
                    ) VALUES (
                        %s, %s, %s, %s, 'active', now(),
                        now() + (%s * interval '1 month'), false,
                        'admin_grant', %s
                    )
                    RETURNING id, user_id, device_id, plan_code, status,
                              starts_at, current_period_end, source
                    """,
                    (
                        subscription_id,
                        user_id,
                        device_id,
                        grant.plan_code,
                        plan["duration_months"],
                        principal.user_id,
                    ),
                )
            except UniqueViolation:
                raise AdminError("ADMIN_CONFLICT", 409) from None
            result = await inserted.fetchone()
            await self.audit(
                connection,
                actor_user_id=principal.user_id,
                action="subscription.granted",
                target_type="subscription",
                target_id=str(subscription_id),
                request_id=request_id,
                details={
                    "user_id": str(user_id),
                    "device_id": str(device_id),
                    "plan_code": grant.plan_code,
                },
            )
            return dict(result)

    async def revoke_subscription(
        self,
        database: Database,
        principal: Principal,
        *,
        subscription_id: UUID,
        request_id: UUID,
    ) -> dict[str, Any]:
        await self.role_for(database, principal)
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT id, source, provider_subscription_id, status
                  FROM public.subscription
                 WHERE id = %s
                 FOR UPDATE
                """,
                (subscription_id,),
            )
            subscription = await cursor.fetchone()
            if subscription is None:
                raise AdminError("ADMIN_RESOURCE_NOT_FOUND", 404)
            if subscription["status"] in {"cancelled", "ended"}:
                return {"id": subscription_id, "status": "ended", "queued": False}
            await connection.execute(
                """
                UPDATE public.subscription
                   SET status = 'ended', ended_reason = 'admin_revoked',
                       cancel_at_period_end = false, updated_at = now()
                 WHERE id = %s
                """,
                (subscription_id,),
            )
            queued = subscription["provider_subscription_id"] is not None
            if queued:
                await connection.execute(
                    """
                    INSERT INTO public.subscription_cancellation_outbox (
                        id, subscription_id, device_release_id,
                        provider_subscription_id, cancellation_reason, status,
                        next_attempt_at
                    ) VALUES (%s, %s, NULL, %s, 'admin_revoked', 'pending', now())
                    ON CONFLICT DO NOTHING
                    """,
                    (
                        uuid4(),
                        subscription_id,
                        subscription["provider_subscription_id"],
                    ),
                )
            await self.audit(
                connection,
                actor_user_id=principal.user_id,
                action="subscription.revoked",
                target_type="subscription",
                target_id=str(subscription_id),
                request_id=request_id,
                details={"provider_cancellation_queued": queued},
            )
            return {"id": subscription_id, "status": "ended", "queued": queued}

    async def register_device(
        self,
        database: Database,
        principal: Principal,
        *,
        registration: AdminDeviceRegistration,
        request_id: UUID,
    ) -> dict[str, Any]:
        await self.role_for(database, principal)
        device_id = uuid4()
        bootstrap_key = os.urandom(32)
        associated_data = (
            f"pinqeva:bootstrap:v1:{device_id}:{registration.serial_number}"
        ).encode("ascii")
        encrypted = encrypt_device_bootstrap_key(
            bootstrap_key,
            self.settings.bootstrap_key_encryption_key,
            associated_data,
        )
        async with database.transaction() as connection:
            try:
                await connection.execute(
                    """
                    INSERT INTO public.device (id, serial_number, name, status)
                    VALUES (%s, %s, %s, 'unprovisioned')
                    """,
                    (device_id, registration.serial_number, registration.name),
                )
                await connection.execute(
                    """
                    INSERT INTO public.device_bootstrap_credential (
                        device_id, key_ciphertext, key_nonce, envelope_version
                    ) VALUES (%s, %s, %s, %s)
                    """,
                    (
                        device_id,
                        encrypted.ciphertext,
                        encrypted.nonce,
                        encrypted.version,
                    ),
                )
            except UniqueViolation:
                raise AdminError("ADMIN_CONFLICT", 409) from None
            await self.audit(
                connection,
                actor_user_id=principal.user_id,
                action="device.registered",
                target_type="device",
                target_id=str(device_id),
                request_id=request_id,
                details={"serial_number": registration.serial_number},
            )
        return {
            "device_id": device_id,
            "factory_payload": {
                "version": 2,
                "serial_number": registration.serial_number,
                "nvs_namespace": "pinqeva",
                "nvs_key": "boot_key",
                "bootstrap_key_base64url": b64url_encode(bootstrap_key),
            },
            "warning": "This factory secret is displayed once. Store it only in the controlled manufacturing flow.",
        }

    async def update_device(
        self,
        database: Database,
        principal: Principal,
        *,
        device_id: UUID,
        update: AdminDeviceUpdate,
        request_id: UUID,
    ) -> dict[str, Any]:
        await self.role_for(database, principal)
        values = update.model_dump(exclude_unset=True)
        if not values:
            raise AdminError("ADMIN_INVALID_REQUEST", 422)
        if ("latitude" in values) != ("longitude" in values):
            raise AdminError("ADMIN_INVALID_REQUEST", 422)
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                UPDATE public.device
                   SET name = COALESCE(%s, name),
                       firmware_version = COALESCE(%s, firmware_version),
                       status = COALESCE(%s, status),
                       last_latitude = COALESCE(%s, last_latitude),
                       last_longitude = COALESCE(%s, last_longitude),
                       last_location_at = CASE
                         WHEN %s::double precision IS NOT NULL THEN now()
                         ELSE last_location_at END,
                       last_place = COALESCE(%s, last_place),
                       updated_at = now()
                 WHERE id = %s
                RETURNING id, serial_number, name, status, firmware_version,
                          last_latitude, last_longitude, last_location_at,
                          last_place, updated_at
                """,
                (
                    values.get("name"),
                    values.get("firmware_version"),
                    values.get("status"),
                    values.get("latitude"),
                    values.get("longitude"),
                    values.get("latitude"),
                    values.get("place"),
                    device_id,
                ),
            )
            result = await cursor.fetchone()
            if result is None:
                raise AdminError("ADMIN_RESOURCE_NOT_FOUND", 404)
            await self.audit(
                connection,
                actor_user_id=principal.user_id,
                action="device.updated",
                target_type="device",
                target_id=str(device_id),
                request_id=request_id,
                details={"fields": sorted(values)},
            )
            return dict(result)

    async def admins(self, database: Database, principal: Principal) -> list[dict[str, Any]]:
        await self.role_for(database, principal, require_owner=True)
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT assignment.id, assignment.user_id, profile.email,
                       profile.display_name, assignment.granted_by,
                       assignment.granted_at
                  FROM public.admin_role_assignment assignment
                  JOIN public.profiles profile ON profile.id = assignment.user_id
                 WHERE assignment.revoked_at IS NULL
                 ORDER BY assignment.granted_at DESC
                """
            )
            return [dict(row) for row in await cursor.fetchall()]

    async def grant_admin(
        self,
        database: Database,
        principal: Principal,
        *,
        user_id: UUID,
        request_id: UUID,
    ) -> dict[str, Any]:
        await self.role_for(database, principal, require_owner=True)
        if user_id in self.settings.admin_owner_user_ids:
            raise AdminError("ADMIN_CONFLICT", 409)
        async with database.transaction() as connection:
            exists = await connection.execute(
                "SELECT 1 FROM public.profiles WHERE id = %s",
                (user_id,),
            )
            if await exists.fetchone() is None:
                raise AdminError("ADMIN_RESOURCE_NOT_FOUND", 404)
            try:
                cursor = await connection.execute(
                    """
                    INSERT INTO public.admin_role_assignment (
                        user_id, role, granted_by
                    ) VALUES (%s, 'admin', %s)
                    RETURNING id, user_id, role, granted_by, granted_at
                    """,
                    (user_id, principal.user_id),
                )
            except UniqueViolation:
                raise AdminError("ADMIN_CONFLICT", 409) from None
            result = await cursor.fetchone()
            await self.audit(
                connection,
                actor_user_id=principal.user_id,
                action="admin.granted",
                target_type="user",
                target_id=str(user_id),
                request_id=request_id,
            )
            return dict(result)

    async def revoke_admin(
        self,
        database: Database,
        principal: Principal,
        *,
        user_id: UUID,
        request_id: UUID,
    ) -> dict[str, Any]:
        await self.role_for(database, principal, require_owner=True)
        if user_id in self.settings.admin_owner_user_ids:
            raise AdminError("ADMIN_OWNER_IMMUTABLE", 409)
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                UPDATE public.admin_role_assignment
                   SET revoked_by = %s, revoked_at = now()
                 WHERE user_id = %s AND revoked_at IS NULL
                RETURNING id, user_id, revoked_by, revoked_at
                """,
                (principal.user_id, user_id),
            )
            result = await cursor.fetchone()
            if result is None:
                raise AdminError("ADMIN_RESOURCE_NOT_FOUND", 404)
            await self.audit(
                connection,
                actor_user_id=principal.user_id,
                action="admin.revoked",
                target_type="user",
                target_id=str(user_id),
                request_id=request_id,
            )
            return dict(result)

    async def audits(
        self, database: Database, principal: Principal, limit: int
    ) -> list[dict[str, Any]]:
        await self.role_for(database, principal)
        async with database.transaction() as connection:
            cursor = await connection.execute(
                """
                SELECT audit.id, audit.actor_user_id, profile.email AS actor_email,
                       audit.action, audit.target_type, audit.target_id,
                       audit.request_id, audit.details, audit.created_at
                  FROM public.admin_audit_log audit
                  JOIN public.profiles profile ON profile.id = audit.actor_user_id
                 ORDER BY audit.created_at DESC, audit.id DESC
                 LIMIT %s
                """,
                (limit,),
            )
            return [dict(row) for row in await cursor.fetchall()]


router = APIRouter(prefix="/v1/admin", tags=["admin"])


def _request_id(request: Request) -> UUID:
    try:
        return UUID(str(request.state.request_id))
    except (ValueError, AttributeError):
        return uuid4()


def _service(request: Request) -> AdminService:
    return request.app.state.admin


def _database(request: Request) -> Database:
    return request.app.state.database


@router.get("/me")
async def admin_me(request: Request, principal: AuthenticatedPrincipal):
    return await _service(request).me(_database(request), principal)


@router.get("/overview")
async def admin_overview(request: Request, principal: AuthenticatedPrincipal):
    return await _service(request).overview(_database(request), principal)


@router.get("/system/integrity")
async def admin_system_integrity(
    request: Request, principal: AuthenticatedPrincipal
):
    return await _service(request).integrity(_database(request), principal)


@router.get("/users")
async def admin_users(
    request: Request,
    principal: AuthenticatedPrincipal,
    search: Annotated[str, Query(max_length=160)] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
):
    return await _service(request).users(
        _database(request), principal, search=search, limit=limit
    )


@router.get("/users/{user_id}/trackers")
async def admin_user_trackers(
    user_id: UUID, request: Request, principal: AuthenticatedPrincipal
):
    return await _service(request).user_trackers(
        _database(request), principal, user_id
    )


@router.get("/plans")
async def admin_plans(request: Request, principal: AuthenticatedPrincipal):
    return await _service(request).plans(_database(request), principal)


@router.patch("/plans/{plan_code}/price")
async def admin_update_price(
    plan_code: Annotated[
        str,
        Path(
            min_length=1,
            max_length=64,
            pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
        ),
    ],
    update: AdminPlanPriceUpdate,
    request: Request,
    principal: AuthenticatedPrincipal,
):
    return await _service(request).update_plan_price(
        _database(request),
        principal,
        plan_code=plan_code,
        update=update,
        request_id=_request_id(request),
    )


@router.post(
    "/users/{user_id}/devices/{device_id}/subscriptions",
    status_code=status.HTTP_201_CREATED,
)
async def admin_grant_subscription(
    user_id: UUID,
    device_id: UUID,
    grant: AdminSubscriptionGrant,
    request: Request,
    principal: AuthenticatedPrincipal,
):
    return await _service(request).grant_subscription(
        _database(request),
        principal,
        user_id=user_id,
        device_id=device_id,
        grant=grant,
        request_id=_request_id(request),
    )


@router.delete("/subscriptions/{subscription_id}")
async def admin_revoke_subscription(
    subscription_id: UUID,
    request: Request,
    principal: AuthenticatedPrincipal,
):
    return await _service(request).revoke_subscription(
        _database(request),
        principal,
        subscription_id=subscription_id,
        request_id=_request_id(request),
    )


@router.post("/devices", status_code=status.HTTP_201_CREATED)
async def admin_register_device(
    registration: AdminDeviceRegistration,
    request: Request,
    principal: AuthenticatedPrincipal,
):
    return await _service(request).register_device(
        _database(request),
        principal,
        registration=registration,
        request_id=_request_id(request),
    )


@router.patch("/devices/{device_id}")
async def admin_update_device(
    device_id: UUID,
    update: AdminDeviceUpdate,
    request: Request,
    principal: AuthenticatedPrincipal,
):
    return await _service(request).update_device(
        _database(request),
        principal,
        device_id=device_id,
        update=update,
        request_id=_request_id(request),
    )


@router.get("/admins")
async def admin_list_admins(request: Request, principal: AuthenticatedPrincipal):
    return await _service(request).admins(_database(request), principal)


@router.post("/admins/{user_id}", status_code=status.HTTP_201_CREATED)
async def admin_grant_admin(
    user_id: UUID, request: Request, principal: AuthenticatedPrincipal
):
    return await _service(request).grant_admin(
        _database(request),
        principal,
        user_id=user_id,
        request_id=_request_id(request),
    )


@router.delete("/admins/{user_id}")
async def admin_revoke_admin(
    user_id: UUID, request: Request, principal: AuthenticatedPrincipal
):
    return await _service(request).revoke_admin(
        _database(request),
        principal,
        user_id=user_id,
        request_id=_request_id(request),
    )


@router.get("/audit")
async def admin_audit_log(
    request: Request,
    principal: AuthenticatedPrincipal,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
):
    return await _service(request).audits(_database(request), principal, limit)
