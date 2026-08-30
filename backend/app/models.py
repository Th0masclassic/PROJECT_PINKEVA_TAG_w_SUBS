from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .crypto import b64url_decode_exact


SERIAL_PATTERN = re.compile(r"^PKV-[0-9A-F]{12}$")
IDEMPOTENCY_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{16,128}$")
FindingNetwork = Literal["apple", "google"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class DeviceClaimStart(StrictModel):
    provisioning_request_id: UUID
    serial_number: str = Field(min_length=16, max_length=16)
    tag_challenge_base64url: str = Field(min_length=43, max_length=43)
    tag_advertisement_key_sha256_base64url: str | None = Field(
        default=None, min_length=43, max_length=43
    )
    tag_google_advertisement_key_sha256_base64url: str | None = Field(
        default=None, min_length=43, max_length=43
    )
    finding_network: FindingNetwork = "apple"
    tag_finding_network: FindingNetwork | None = None

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
        "tag_google_advertisement_key_sha256_base64url",
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
    google_advertisement_key_base64url: str = Field(min_length=27, max_length=27)
    google_advertisement_key_sha256_base64url: str = Field(
        min_length=43, max_length=43
    )
    finding_network: FindingNetwork
    tag_authorization_proof_base64url: str
    claim_completion_token_base64url: str
    tag_control_key_base64url: str | None
    expires_at: datetime
    claim_deadline: datetime


class DeviceClaimComplete(StrictModel):
    session_id: UUID
    serial_number: str = Field(min_length=16, max_length=16)
    tag_advertisement_key_sha256_base64url: str = Field(min_length=43, max_length=43)
    tag_google_advertisement_key_sha256_base64url: str = Field(
        min_length=43, max_length=43
    )
    finding_network: FindingNetwork
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
        "tag_google_advertisement_key_sha256_base64url",
        "claim_completion_token_base64url",
    )
    @classmethod
    def valid_32_byte_base64url(cls, value: str) -> str:
        b64url_decode_exact(value, 32)
        return value


class DeviceClaimResponse(StrictModel):
    device_id: UUID
    serial_number: str
    status: Literal["claimed"]
    claimed_at: datetime
    next_action: Literal["ready"]
    finding_network: FindingNetwork


FIRMWARE_VERSION_PATTERN = r"^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$"


class FirmwareAvailabilityResponse(StrictModel):
    device_id: UUID
    current_version: str | None
    update_available: bool
    latest_version: str | None
    image_size: int | None = Field(default=None, ge=1, le=917_504)
    image_sha256_base64url: str | None = Field(
        default=None, min_length=43, max_length=43
    )


class FirmwareUpdateSessionRequest(StrictModel):
    serial_number: str = Field(min_length=16, max_length=16)
    current_version: str = Field(pattern=FIRMWARE_VERSION_PATTERN)
    tag_challenge_base64url: str = Field(min_length=43, max_length=43)

    @field_validator("serial_number")
    @classmethod
    def valid_serial(cls, value: str) -> str:
        normalized = value.upper()
        if not SERIAL_PATTERN.fullmatch(normalized):
            raise ValueError("serial_number must be PKV- followed by 12 hexadecimal digits")
        return normalized

    @field_validator("tag_challenge_base64url")
    @classmethod
    def valid_challenge(cls, value: str) -> str:
        b64url_decode_exact(value, 32)
        return value


class FirmwareUpdateSessionResponse(StrictModel):
    device_id: UUID
    serial_number: str
    version: str = Field(pattern=FIRMWARE_VERSION_PATTERN)
    install_required: bool
    image_size: int = Field(ge=1, le=917_504)
    image_sha256_base64url: str = Field(min_length=43, max_length=43)
    manifest_base64url: str = Field(min_length=154, max_length=154)
    tag_authorization_proof_base64url: str = Field(min_length=43, max_length=43)
    image_url: str = Field(min_length=1, max_length=512)


class FirmwareUpdateAcknowledge(StrictModel):
    version: str = Field(pattern=FIRMWARE_VERSION_PATTERN)
    image_sha256_base64url: str = Field(min_length=43, max_length=43)

    @field_validator("image_sha256_base64url")
    @classmethod
    def valid_digest(cls, value: str) -> str:
        b64url_decode_exact(value, 32)
        return value


class FirmwareUpdateAcknowledgeResponse(StrictModel):
    device_id: UUID
    version: str = Field(pattern=FIRMWARE_VERSION_PATTERN)
    status: Literal["installed"]


class DeviceProvisioningRequestStart(StrictModel):
    serial_number: str = Field(min_length=16, max_length=16)
    tag_challenge_base64url: str = Field(min_length=43, max_length=43)
    tag_advertisement_key_sha256_base64url: str | None = Field(
        default=None, min_length=43, max_length=43
    )
    tag_google_advertisement_key_sha256_base64url: str | None = Field(
        default=None, min_length=43, max_length=43
    )
    tag_finding_network: FindingNetwork | None = None

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
        "tag_google_advertisement_key_sha256_base64url",
    )
    @classmethod
    def valid_tag_key_hash(cls, value: str | None) -> str | None:
        if value is not None:
            b64url_decode_exact(value, 32)
        return value


ProvisioningRequestStatus = Literal[
    "pending",
    "creating",
    "open",
    "paid",
    "claiming",
    "completed",
    "expired",
    "failed",
]


class ProvisioningRequestCheckout(StrictModel):
    plan_code: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
    )


class ProvisioningRequestCheckoutResponse(StrictModel):
    request_id: UUID
    url: str
    expires_at: datetime


class DeviceReleaseStart(StrictModel):
    serial_number: str = Field(min_length=16, max_length=16)
    tag_challenge_base64url: str = Field(min_length=43, max_length=43)
    tag_advertisement_key_sha256_base64url: str = Field(min_length=43, max_length=43)
    tag_google_advertisement_key_sha256_base64url: str = Field(
        min_length=43, max_length=43
    )
    finding_network: FindingNetwork

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
        "tag_google_advertisement_key_sha256_base64url",
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
    tag_google_key_state: Literal["empty"]
    tag_finding_network_state: Literal["empty"]
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


class DeviceLocationHistoryPoint(StrictModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    recorded_at: datetime


class DeviceLocationHistoryResponse(StrictModel):
    """Decrypted location points only; Finder keys and payloads stay private."""

    device_id: UUID
    locations: list[DeviceLocationHistoryPoint] = Field(max_length=20_000)


class PremiumFeatureAccessResponse(StrictModel):
    device_id: UUID
    subscription_active: bool
    tier: Literal["premium", "none"]
    cloud_location_reports: bool
    location_history_days: int = Field(ge=0, le=30)
    smart_alerts: bool
    safe_zones: bool
    companion_separation_alerts: bool
    trusted_sharing: bool
    recovery_report: bool
    vehicle_mode: bool
    replacement_benefit: bool


class DeviceSafeZoneCreate(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    radius_meters: int = Field(ge=50, le=100_000)

    @field_validator("name")
    @classmethod
    def safe_name(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized or re.search(r"[\x00-\x1f\x7f]", normalized):
            raise ValueError("invalid safe-zone name")
        return normalized


class DeviceSafeZoneUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    radius_meters: int | None = Field(default=None, ge=50, le=100_000)
    enabled: bool | None = None

    @field_validator("name")
    @classmethod
    def safe_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.split())
        if not normalized or re.search(r"[\x00-\x1f\x7f]", normalized):
            raise ValueError("invalid safe-zone name")
        return normalized


class DeviceSafeZoneResponse(StrictModel):
    id: UUID
    device_id: UUID
    name: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    radius_meters: int = Field(ge=50, le=100_000)
    enabled: bool
    last_tracker_inside: bool | None = None
    last_evaluated_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class DeviceSafeZoneListResponse(StrictModel):
    safe_zones: list[DeviceSafeZoneResponse] = Field(max_length=20)


class DeviceProtectionProfileUpdate(StrictModel):
    separation_alerts: bool | None = None
    separation_threshold_meters: int | None = Field(
        default=None, ge=100, le=5_000
    )
    vehicle_mode: bool | None = None
    movement_alerts: bool | None = None
    movement_threshold_meters: int | None = Field(
        default=None, ge=100, le=10_000
    )


class DeviceProtectionProfileResponse(StrictModel):
    device_id: UUID
    separation_alerts: bool
    separation_threshold_meters: int = Field(ge=100, le=5_000)
    vehicle_mode: bool
    movement_alerts: bool
    movement_threshold_meters: int = Field(ge=100, le=10_000)
    updated_at: datetime


class DeviceCompanionObservationCreate(StrictModel):
    installation_id: UUID
    platform: Literal["ios", "android"]
    phone_latitude: float = Field(ge=-90, le=90)
    phone_longitude: float = Field(ge=-180, le=180)
    phone_accuracy_meters: float = Field(ge=1, le=1_000)
    sampled_at: datetime
    tag_proximity: Literal["nearby", "not_seen", "unknown"] = "unknown"
    tag_observed_at: datetime | None = None
    tag_rssi_dbm: int | None = Field(default=None, ge=-127, le=20)
    scan_duration_seconds: int | None = Field(default=None, ge=5, le=120)

    @model_validator(mode="after")
    def validate_proximity_evidence(self) -> "DeviceCompanionObservationCreate":
        if self.tag_proximity == "nearby" and self.tag_observed_at is None:
            raise ValueError("nearby observations require tag_observed_at")
        if self.tag_proximity != "nearby" and self.tag_observed_at is not None:
            raise ValueError("tag_observed_at is accepted only when nearby")
        if self.tag_proximity != "nearby" and self.tag_rssi_dbm is not None:
            raise ValueError("RSSI is accepted only for nearby observations")
        if self.tag_proximity == "not_seen" and self.scan_duration_seconds is None:
            raise ValueError("not_seen observations require a completed scan duration")
        return self


class DeviceCompanionStatusResponse(StrictModel):
    device_id: UUID
    subscription_active: bool
    configured: bool
    installation_id: UUID | None = None
    platform: Literal["ios", "android"] | None = None
    observation_accepted: bool | None = None
    last_observation_at: datetime | None = None
    phone_accuracy_meters: float | None = Field(default=None, ge=1, le=1_000)
    tag_proximity: Literal["nearby", "not_seen", "unknown"] | None = None
    tag_observed_at: datetime | None = None
    tag_rssi_dbm: int | None = Field(default=None, ge=-127, le=20)


class DeviceCompanionResetResponse(StrictModel):
    device_id: UUID
    status: Literal["removed"] = "removed"


class DeviceRecoveryShareCreate(StrictModel):
    label: str = Field(default="Recovery contact", min_length=1, max_length=80)
    access_level: Literal["latest", "history"] = "latest"
    expires_in_hours: int = Field(default=72, ge=1, le=720)

    @field_validator("label")
    @classmethod
    def safe_label(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized or re.search(r"[\x00-\x1f\x7f]", normalized):
            raise ValueError("invalid share label")
        return normalized


class DeviceRecoveryShareSummary(StrictModel):
    id: UUID
    device_id: UUID
    label: str
    access_level: Literal["latest", "history"]
    expires_at: datetime
    revoked_at: datetime | None = None
    last_accessed_at: datetime | None = None
    created_at: datetime


class DeviceRecoveryShareCreateResponse(DeviceRecoveryShareSummary):
    share_token: str = Field(min_length=43, max_length=43)
    share_path: str = Field(min_length=1, max_length=160)


class DeviceRecoveryShareListResponse(StrictModel):
    shares: list[DeviceRecoveryShareSummary] = Field(max_length=100)


class RecoveryShareResolveRequest(StrictModel):
    token: str = Field(min_length=43, max_length=43)


class SharedTrackerResponse(StrictModel):
    tracker_name: str
    access_level: Literal["latest", "history"]
    expires_at: datetime
    latest_location: DeviceLocationHistoryPoint | None = None
    locations: list[DeviceLocationHistoryPoint] = Field(max_length=20_000)


class DeviceRecoveryReportResponse(StrictModel):
    device_id: UUID
    tracker_name: str
    serial_number: str
    generated_at: datetime
    protection_status: Literal["active"] = "active"
    subscription_period_end: datetime
    last_location: DeviceLocationHistoryPoint | None = None
    location_count_30d: int = Field(ge=0)
    safe_zone_count: int = Field(ge=0)
    active_share_count: int = Field(ge=0)
    recent_alert_count_30d: int = Field(ge=0)
    companion_status: Literal["ready", "stale", "not_configured"]
    replacement_eligible: bool
    replacement_claim_status: Literal[
        "submitted", "approved", "rejected", "fulfilled", "cancelled"
    ] | None = None


class PremiumTrackerOverviewResponse(StrictModel):
    device_id: UUID
    tracker_name: str
    subscription_active: bool
    location_status: Literal["current", "stale", "never"]
    last_location_at: datetime | None = None
    firmware_version: str | None = None
    separation_alerts: bool
    vehicle_mode: bool
    movement_alerts: bool
    safe_zone_count: int = Field(ge=0)
    active_share_count: int = Field(ge=0)
    companion_status: Literal["ready", "stale", "not_configured"]
    replacement_eligible: bool


ReplacementClaimStatus = Literal[
    "submitted", "approved", "rejected", "fulfilled", "cancelled"
]


class DeviceReplacementClaimCreate(StrictModel):
    reason: Literal["lost", "stolen"]
    incident_at: datetime
    notes: str | None = Field(default=None, max_length=500)

    @field_validator("notes")
    @classmethod
    def safe_notes(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.split())
        if not normalized:
            return None
        if re.search(r"[\x00-\x1f\x7f]", normalized):
            raise ValueError("invalid replacement notes")
        return normalized


class DeviceReplacementClaimSummary(StrictModel):
    id: UUID
    device_id: UUID
    subscription_id: UUID
    reason: Literal["lost", "stolen"]
    incident_at: datetime
    status: ReplacementClaimStatus
    notes: str | None = Field(default=None, max_length=500)
    benefit_period_start: datetime
    benefit_period_end: datetime
    replacement_price_minor: Literal[0] = 0
    replacement_device_id: UUID | None = None
    replacement_serial_number: str | None = Field(
        default=None, min_length=16, max_length=16
    )
    provisioning_request_id: UUID | None = None
    submitted_at: datetime
    reviewed_at: datetime | None = None
    fulfilled_at: datetime | None = None


class DeviceReplacementClaimListResponse(StrictModel):
    claims: list[DeviceReplacementClaimSummary] = Field(max_length=100)


class DeviceReplacementEligibilityResponse(StrictModel):
    device_id: UUID
    eligible: bool
    reason: Literal[
        "eligible",
        "subscription_required",
        "paid_subscription_required",
        "plan_not_eligible",
        "already_claimed",
    ]
    minimum_plan_months: Literal[6] = 6
    current_plan_months: Literal[1, 3, 6, 12] | None = None
    benefit_period_start: datetime | None = None
    benefit_period_end: datetime | None = None
    existing_claim_id: UUID | None = None
    existing_claim_status: ReplacementClaimStatus | None = None


class LocationHistoryDeleteResponse(StrictModel):
    device_id: UUID
    deleted_reports: int = Field(ge=0)


class PlanSummary(StrictModel):
    code: str
    name: str
    amount_minor: int = Field(ge=0)
    currency: str = Field(min_length=3, max_length=3)
    billing_interval: Literal["month", "year"]
    billing_interval_count: int = Field(ge=1, le=12)
    duration_months: Literal[1, 3, 6, 12]


class DeviceProvisioningRequestResponse(StrictModel):
    request_id: UUID
    device_id: UUID
    serial_number: str
    status: ProvisioningRequestStatus
    plan_code: str | None = None
    expires_at: datetime
    claim_deadline: datetime | None = None
    available_plans: list[PlanSummary] = Field(default_factory=list)


class AccountSubscriptionResponse(StrictModel):
    """The one subscription shared by every tracker in an account."""

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


class MobilePushTokenRegistration(StrictModel):
    installation_id: UUID
    expo_push_token: str = Field(
        min_length=24,
        max_length=256,
        pattern=r"^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$",
    )
    platform: Literal["ios", "android"]


class MobilePushTokenResponse(StrictModel):
    installation_id: UUID
    status: Literal["active", "removed"]


NotificationKind = Literal[
    "renewal_7_days",
    "renewal_1_day",
    "expired",
    "admin_message",
    "separation_detected",
    "movement_detected",
]


class UserNotificationSummary(StrictModel):
    id: UUID
    device_id: UUID | None = None
    kind: NotificationKind
    period_end: datetime | None = None
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=320)
    created_at: datetime
    read_at: datetime | None = None


class UserNotificationListResponse(StrictModel):
    notifications: list[UserNotificationSummary]


class UserNotificationReadResponse(StrictModel):
    id: UUID
    status: Literal["read"]


IdempotencyKey = Annotated[str, Field(min_length=16, max_length=128)]


def validate_idempotency_key(value: str) -> str:
    if not IDEMPOTENCY_PATTERN.fullmatch(value):
        raise ValueError(
            "Idempotency-Key must contain 16-128 letters, digits, '.', '_', ':', or '-'"
        )
    return value
