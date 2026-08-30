from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.admin import (
    AdminDeviceUpdate,
    AdminDeviceRegistration,
    AdminError,
    AdminPlanPriceUpdate,
    AdminReplacementClaimUpdate,
    AdminService,
)
from app.auth import Principal
from app.config import Settings


class Cursor:
    def __init__(self, row):
        self.row = row

    async def fetchone(self):
        return self.row


class Connection:
    def __init__(self, role_row=None):
        self.role_row = role_row

    async def execute(self, _query, _parameters=()):
        return Cursor(self.role_row)


class Database:
    def __init__(self, role_row=None):
        self.connection = Connection(role_row)

    @asynccontextmanager
    async def transaction(self):
        yield self.connection


class SequenceConnection:
    def __init__(self, rows):
        self.rows = iter(rows)

    async def execute(self, _query, _parameters=()):
        return Cursor(next(self.rows))


class SequenceDatabase:
    def __init__(self, rows):
        self.connection = SequenceConnection(rows)

    @asynccontextmanager
    async def transaction(self):
        yield self.connection


def settings(owner_id) -> Settings:
    return Settings(
        database_url="postgresql://unused",
        supabase_jwks_url="https://example.invalid/jwks.json",
        supabase_jwt_issuer="https://example.invalid/auth/v1",
        supabase_jwt_audience="authenticated",
        supabase_jwt_algorithms=("ES256",),
        key_encryption_key=b"a" * 32,
        bootstrap_key_encryption_key=b"b" * 32,
        claim_token_key=b"c" * 32,
        session_ttl_seconds=600,
        claim_ttl_seconds=86400,
        admin_owner_user_ids=frozenset({owner_id}),
    )


@pytest.mark.asyncio
async def test_environment_owner_still_requires_aal2() -> None:
    owner_id = uuid4()
    service = AdminService(settings(owner_id))

    with pytest.raises(AdminError) as error:
        await service.role_for(
            Database(), Principal(user_id=owner_id, assurance_level="aal1")
        )

    assert error.value.code == "ADMIN_MFA_REQUIRED"
    assert await service.role_for(
        Database(), Principal(user_id=owner_id, assurance_level="aal2")
    ) == "owner"


@pytest.mark.asyncio
async def test_database_admin_cannot_perform_owner_operations() -> None:
    owner_id = uuid4()
    service = AdminService(settings(owner_id))
    principal = Principal(user_id=uuid4(), assurance_level="aal2")

    assert await service.role_for(Database({"?column?": 1}), principal) == "admin"
    with pytest.raises(AdminError) as error:
        await service.role_for(
            Database({"?column?": 1}), principal, require_owner=True
        )
    assert error.value.code == "ADMIN_OWNER_REQUIRED"


@pytest.mark.asyncio
async def test_unassigned_user_is_denied_without_role_detail() -> None:
    service = AdminService(settings(uuid4()))
    with pytest.raises(AdminError) as error:
        await service.role_for(
            Database(None), Principal(user_id=uuid4(), assurance_level="aal2")
        )
    assert error.value.code == "ADMIN_ACCESS_DENIED"


@pytest.mark.asyncio
async def test_integrity_summary_reports_operational_warnings() -> None:
    owner_id = uuid4()
    service = AdminService(settings(owner_id))
    database = SequenceDatabase(
        [
            {
                "checked_at": datetime.now(UTC),
                "devices_missing_bootstrap_credentials": 1,
                "claimed_devices_without_active_owner": 0,
                "active_ownership_device_state_mismatches": 0,
                "current_subscriptions_without_active_account": 0,
                "failed_cancellation_jobs": 2,
                "overdue_provisioning_requests": 0,
                "active_database_admins": 3,
                "last_audit_at": None,
            },
            {"owner_profiles": 1},
        ]
    )

    result = await service.integrity(
        database, Principal(user_id=owner_id, assurance_level="aal2")
    )

    assert result["status"] == "degraded"
    assert result["critical_issues"] == 0
    assert result["warnings"] == 3
    assert result["metrics"] == {
        "configured_owners": 1,
        "active_database_admins": 3,
        "last_audit_at": None,
    }


@pytest.mark.asyncio
async def test_bound_concurrent_stripe_price_is_not_deactivated(monkeypatch) -> None:
    service = AdminService(settings(uuid4()))
    calls = []
    monkeypatch.setattr(
        "app.admin.stripe.Price.modify",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    await service.deactivate_price_if_unbound(
        Database({"is_bound": True}), "price_CONCURRENT123"
    )

    assert calls == []


@pytest.mark.asyncio
async def test_unbound_stripe_price_is_deactivated(monkeypatch) -> None:
    service = AdminService(settings(uuid4()))
    calls = []
    monkeypatch.setattr(
        "app.admin.stripe.Price.modify",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    await service.deactivate_price_if_unbound(
        Database({"is_bound": False}), "price_ORPHANED12345"
    )

    assert calls[0][0] == ("price_ORPHANED12345",)
    assert calls[0][1]["active"] is False


def test_admin_mutation_models_reject_unsafe_input() -> None:
    valid = AdminDeviceRegistration(
        serial_number="pkv-aabbccddeeff", name="Warehouse tag"
    )
    assert valid.serial_number == "PKV-AABBCCDDEEFF"

    with pytest.raises(ValidationError):
        AdminDeviceRegistration(serial_number="PKV-NOT-A-TAG", name="tag")
    with pytest.raises(ValidationError):
        AdminDeviceRegistration(
            serial_number="PKV-AABBCCDDEEFF", name="bad\nname"
        )
    with pytest.raises(ValidationError):
        AdminPlanPriceUpdate(
            amount_minor=49, currency="EUR", expected_version=1
        )
    assert AdminDeviceUpdate(status="claimed").status == "claimed"
    with pytest.raises(ValidationError):
        AdminDeviceUpdate(status="active")
    with pytest.raises(ValidationError):
        AdminDeviceUpdate(status="suspended")


@pytest.mark.asyncio
async def test_admin_approves_a_submitted_replacement_claim() -> None:
    owner_id = uuid4()
    claim_id = uuid4()
    now = datetime.now(UTC)
    database = SequenceDatabase(
        [
            {"id": claim_id, "status": "submitted"},
            None,
            None,
            {
                "id": claim_id,
                "user_id": uuid4(),
                "device_id": uuid4(),
                "subscription_id": uuid4(),
                "reason": "lost",
                "incident_at": now,
                "status": "approved",
                "notes": None,
                "review_note": "Identity verified",
                "benefit_period_start": now,
                "benefit_period_end": now,
                "submitted_at": now,
                "reviewed_at": now,
                "fulfilled_at": None,
                "reviewed_by": owner_id,
            },
        ]
    )

    result = await AdminService(settings(owner_id)).update_replacement_claim(
        database,
        Principal(user_id=owner_id, assurance_level="aal2"),
        claim_id=claim_id,
        update=AdminReplacementClaimUpdate(
            status="approved", review_note="Identity verified"
        ),
        request_id=uuid4(),
    )

    assert result["status"] == "approved"


@pytest.mark.asyncio
async def test_admin_cannot_reopen_a_rejected_replacement_claim() -> None:
    owner_id = uuid4()
    with pytest.raises(AdminError) as error:
        await AdminService(settings(owner_id)).update_replacement_claim(
            SequenceDatabase([{"id": uuid4(), "status": "rejected"}]),
            Principal(user_id=owner_id, assurance_level="aal2"),
            claim_id=uuid4(),
            update=AdminReplacementClaimUpdate(status="approved"),
            request_id=uuid4(),
        )

    assert error.value.code == "ADMIN_CONFLICT"


@pytest.mark.asyncio
async def test_admin_fulfilment_assigns_a_zero_price_provisioning_request() -> None:
    owner_id = uuid4()
    claim_id = uuid4()
    user_id = uuid4()
    original_device_id = uuid4()
    replacement_device_id = uuid4()
    subscription_id = uuid4()
    provisioning_request_id = uuid4()
    now = datetime.now(UTC)
    database = SequenceDatabase(
        [
            {
                "id": claim_id,
                "user_id": user_id,
                "device_id": original_device_id,
                "subscription_id": subscription_id,
                "status": "approved",
                "replacement_device_id": None,
                "plan_code": "yearly_pro",
            },
            {
                "id": replacement_device_id,
                "serial_number": "PKV-AABBCCDDEEFF",
            },
            None,
            None,
            None,
            {
                "id": claim_id,
                "user_id": user_id,
                "device_id": original_device_id,
                "subscription_id": subscription_id,
                "reason": "stolen",
                "incident_at": now,
                "status": "fulfilled",
                "notes": None,
                "review_note": "Replacement shipped",
                "benefit_period_start": now,
                "benefit_period_end": now,
                "replacement_device_id": replacement_device_id,
                "replacement_serial_number": "PKV-AABBCCDDEEFF",
                "provisioning_request_id": provisioning_request_id,
                "submitted_at": now,
                "reviewed_at": now,
                "fulfilled_at": now,
                "reviewed_by": owner_id,
            },
        ]
    )

    result = await AdminService(settings(owner_id)).update_replacement_claim(
        database,
        Principal(user_id=owner_id, assurance_level="aal2"),
        claim_id=claim_id,
        update=AdminReplacementClaimUpdate(
            status="fulfilled",
            review_note="Replacement shipped",
            replacement_device_id=replacement_device_id,
        ),
        request_id=uuid4(),
    )

    assert result["status"] == "fulfilled"
    assert result["replacement_device_id"] == replacement_device_id
    assert result["provisioning_request_id"] == provisioning_request_id
