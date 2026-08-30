from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    # UUID and RFC 3339 values arrive as canonical JSON strings. Individual
    # numeric fields remain range constrained and extra keys are rejected.
    model_config = ConfigDict(extra="forbid")


class IdentityRequest(StrictModel):
    version: Literal[1]
    device_id: UUID
    serial_number: str = Field(pattern=r"^PKV-[0-9A-F]{12}$")
    identity_key_base64url: str = Field(min_length=43, max_length=43)
    advertisement_key_sha256_base64url: str = Field(min_length=43, max_length=43)
    requested_at: datetime

    @field_validator("requested_at")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("requested_at must include a timezone")
        return value


class ReportsRequest(IdentityRequest):
    lookback_hours: int = Field(ge=1, le=720)


class RegistrationResponse(StrictModel):
    status: Literal["current", "registered", "refreshed"]


class ReportPoint(StrictModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    confidence: int = Field(ge=0, le=255)
    status: int = Field(ge=0, le=255)
    timestamp: datetime
    source_fingerprint_base64url: str = Field(min_length=43, max_length=43)


class ReportsResponse(StrictModel):
    reports: list[ReportPoint]
