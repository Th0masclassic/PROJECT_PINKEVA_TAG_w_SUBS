from __future__ import annotations

from contextlib import asynccontextmanager
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.admin import (
    AdminDeviceUpdate,
    AdminDeviceRegistration,
    AdminError,
    AdminPlanPriceUpdate,
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
