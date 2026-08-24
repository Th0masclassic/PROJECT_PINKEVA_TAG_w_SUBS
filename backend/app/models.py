from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .crypto import b64url_decode_exact


SERIAL_PATTERN = re.compile(r"^PKV-[0-9A-F]{12}$")
IDEMPOTENCY_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{16,128}$")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class DeviceClaimStart(StrictModel):
    serial_number: str = Field(min_length=16, max_length=16)
    tag_challenge_base64url: str = Field(min_length=43, max_length=43)
    tag_advertisement_key_sha256_base64url: str | None = Field(
        default=None, min_length=43, max_length=43
    )

    @field_validator("serial_number")
    @classmethod
    def valid_serial(cls, value: str) -> str:
        normalized = value.upper()
        if not SERIAL_PATTERN.fullmatch(normalized):
            raise ValueError("serial_number isnt following the correct format")
        return normalized

    @field_validator(
        "tag_challenge_base64url",
        "tag_advertisement_key_sha256_base64url",
    )
    @classmethod
    def valid_tag_key_hash(cls, value: str | None) -> str | None:
        if value is not None:
            b64url_decode_exact(value, 32)
        return value


class DeviceClaimStartResponse(StrictModel):
    session_id: UUID
    serial_number: str
    protocol_version: Literal[1]
    tag_action: Literal["write_key", "verify_existing_key"]
    advertisement_key_base64url: str
    advertisement_key_sha256_base64url: str
    tag_authorization_proof_base64url: str
    claim_completion_token_base64url: str
    tag_control_key_base64url: str | None
    expires_at: datetime
    claim_deadline: datetime


class DeviceClaimComplete(StrictModel):
    session_id: UUID
    serial_number: str = Field(min_length=16, max_length=16)
    tag_advertisement_key_sha256_base64url: str = Field(min_length=43, max_length=43)
    claim_completion_token_base64url: str = Field(min_length=43, max_length=43)

    @field_validator("serial_number")
    @classmethod
    def valid_serial(cls, value: str) -> str:
        normalized = value.upper()
        if not SERIAL_PATTERN.fullmatch(normalized):
            raise ValueError("serial_number must be PKV- followed by 12 hexadecimal digits")
        return normalized

    @field_validator(
        "tag_advertisement_key_sha256_base64url",
        "claim_completion_token_base64url",
    )
    @classmethod
    def valid_32_byte_base64url(cls, value: str) -> str:
        b64url_decode_exact(value, 32)
        return value


class DeviceClaimResponse(StrictModel):
    device_id: UUID
    serial_number: str
    status: Literal["suspended"]
    claimed_at: datetime
    next_action: Literal["install_signed_entitlement"]


class DeviceReleaseStart(StrictModel):
    serial_number: str = Field(min_length=16, max_length=16)
    tag_challenge_base64url: str = Field(min_length=43, max_length=43)
    tag_advertisement_key_sha256_base64url: str = Field(min_length=43, max_length=43)

    @field_validator("serial_number")
    @classmethod
    def valid_serial(cls, value: str) -> str:
        normalized = value.upper()
        if not SERIAL_PATTERN.fullmatch(normalized):
            raise ValueError("serial_number must be PKV- followed by 12 hexadecimal digits")
        return normalized

    @field_validator(
        "tag_challenge_base64url",
        "tag_advertisement_key_sha256_base64url",
    )
    @classmethod
    def valid_tag_key_hash(cls, value: str) -> str:
        b64url_decode_exact(value, 32)
        return value


class DeviceReleaseStartResponse(StrictModel):
    release_id: UUID
    device_id: UUID
    serial_number: str
    tag_authorization_proof_base64url: str
    reset_command_base64url: str
    release_completion_token_base64url: str
    expires_at: datetime


class DeviceReleaseComplete(StrictModel):
    release_id: UUID
    serial_number: str = Field(min_length=16, max_length=16)
    tag_key_state: Literal["empty"]
    release_completion_token_base64url: str = Field(min_length=43, max_length=43)

    @field_validator("serial_number")
    @classmethod
    def valid_serial(cls, value: str) -> str:
        normalized = value.upper()
        if not SERIAL_PATTERN.fullmatch(normalized):
            raise ValueError("serial_number must be PKV- followed by 12 hexadecimal digits")
        return normalized

    @field_validator("release_completion_token_base64url")
    @classmethod
    def valid_release_token(cls, value: str) -> str:
        b64url_decode_exact(value, 32)
        return value


class DeviceReleaseResponse(StrictModel):
    device_id: UUID
    serial_number: str
    status: Literal["unprovisioned"]
    released_at: datetime
    cancelled_subscriptions: int
    provider_cancellations_queued: int
    next_action: Literal["ready_for_new_owner"]


class DeviceLocationReportResponse(StrictModel):
    """Safe location projection returned after a server-side report request.

    Finder key material, Apple report payloads, and provider credentials are
    intentionally not part of this response.  The mobile app only needs the
    latest accepted coordinates to render its map.
    """

    device_id: UUID
    serial_number: str
    report_status: Literal["updated", "unchanged", "no_report"]
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    last_location_at: datetime | None = None
    last_place: str | None = Field(default=None, min_length=1, max_length=160)
    confidence: int | None = Field(default=None, ge=0, le=255)
    status_code: int | None = Field(default=None, ge=0, le=255)


class PlanSummary(StrictModel):
    code: str
    name: str
    amount_minor: int = Field(ge=0)
    currency: str = Field(min_length=3, max_length=3)
    billing_interval: Literal["month", "year"]
    billing_interval_count: int = Field(ge=1, le=12)
    duration_months: Literal[1, 3, 6, 12]


class DeviceSubscriptionResponse(StrictModel):
    device_id: UUID
    status: str
    plan_code: str | None = None
    plan_name: str | None = None
    amount_minor: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    billing_interval: Literal["month", "year"] | None = None
    billing_interval_count: int | None = Field(default=None, ge=1, le=12)
    duration_months: Literal[1, 3, 6, 12] | None = None
    current_period_start: datetime | None = None
    current_period_end: datetime | None = None
    cancel_at_period_end: bool = False
    available_plans: list[PlanSummary]


class SubscriptionCheckoutRequest(StrictModel):
    plan_code: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
    )


class SubscriptionPortalRequest(StrictModel):
    action: Literal["update", "cancel"] = "update"


class BillingUrlResponse(StrictModel):
    url: str


class StripeWebhookResponse(StrictModel):
    received: Literal[True] = True
    duplicate: bool = False


IdempotencyKey = Annotated[str, Field(min_length=16, max_length=128)]


def validate_idempotency_key(value: str) -> str:
    if not IDEMPOTENCY_PATTERN.fullmatch(value):
        raise ValueError(
            "Idempotency-Key must contain 16-128 letters, digits, '.', '_', ':', or '-'"
        )
    return value
