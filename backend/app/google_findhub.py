from __future__ import annotations

from datetime import UTC, datetime, timedelta
import math
from typing import Any
from uuid import UUID

import requests

from .crypto import b64url_encode
from .findmy import FinderReport


class GoogleFindHubConfigurationError(RuntimeError):
    pass


class GoogleFindHubRequestError(RuntimeError):
    pass


class GoogleFindHubBridgeClient:
    """Client for an isolated, approved Google Find Hub report provider.

    Google does not publish a general-purpose Find Hub report API. This small
    contract keeps any future partner integration outside the public API while
    ensuring the backend never falls back to querying Apple for a Google tag.
    """

    def __init__(
        self,
        *,
        base_url: str,
        service_token: str,
        timeout_seconds: float,
        lookback_hours: int,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.service_token = service_token
        self.timeout_seconds = timeout_seconds
        self.lookback_hours = lookback_hours

    def fetch_latest(
        self,
        *,
        device_id: UUID,
        serial_number: str,
        identity_key: bytes,
        advertisement_key_sha256: bytes,
    ) -> FinderReport | None:
        reports = self.fetch_reports(
            device_id=device_id,
            serial_number=serial_number,
            identity_key=identity_key,
            advertisement_key_sha256=advertisement_key_sha256,
            lookback_hours=self.lookback_hours,
        )
        return reports[0] if reports else None

    def fetch_reports(
        self,
        *,
        device_id: UUID,
        serial_number: str,
        identity_key: bytes,
        advertisement_key_sha256: bytes,
        lookback_hours: int,
        now: datetime | None = None,
    ) -> list[FinderReport]:
        if not self.base_url or not self.service_token:
            raise GoogleFindHubConfigurationError(
                "Google Find Hub report provider is not configured"
            )
        if len(identity_key) != 32 or len(advertisement_key_sha256) != 32:
            raise GoogleFindHubConfigurationError(
                "Google Find Hub key material has an invalid size"
            )
        if not 1 <= lookback_hours <= 30 * 24:
            raise GoogleFindHubConfigurationError(
                "Google Find Hub lookback is outside the supported range"
            )

        request_time = (now or datetime.now(UTC)).astimezone(UTC)
        try:
            response = requests.post(
                f"{self.base_url}/v1/reports",
                headers={
                    "Authorization": f"Bearer {self.service_token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "version": 1,
                    "device_id": str(device_id),
                    "serial_number": serial_number,
                    "identity_key_base64url": b64url_encode(identity_key),
                    "advertisement_key_sha256_base64url": b64url_encode(
                        advertisement_key_sha256
                    ),
                    "lookback_hours": lookback_hours,
                    "requested_at": request_time.isoformat().replace("+00:00", "Z"),
                },
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            raise GoogleFindHubRequestError(
                "Google Find Hub report provider request failed"
            ) from exc

        if not isinstance(payload, dict) or set(payload) != {"reports"}:
            raise GoogleFindHubRequestError(
                "Google Find Hub report provider returned an invalid response"
            )
        raw_reports = payload["reports"]
        if not isinstance(raw_reports, list) or len(raw_reports) > 20_000:
            raise GoogleFindHubRequestError(
                "Google Find Hub report provider returned an invalid report list"
            )
        window_start = request_time - timedelta(hours=lookback_hours)
        window_end = request_time + timedelta(minutes=5)
        reports: list[FinderReport] = []
        seen: set[tuple[datetime, float, float, int, int]] = set()
        for item in raw_reports:
            report = self._parse_report(item)
            if not window_start <= report.timestamp <= window_end:
                continue
            identity = (
                report.timestamp,
                report.latitude,
                report.longitude,
                report.confidence,
                report.status,
            )
            if identity in seen:
                continue
            seen.add(identity)
            reports.append(report)
        reports.sort(key=lambda report: report.timestamp, reverse=True)
        return reports

    @staticmethod
    def _parse_report(value: Any) -> FinderReport:
        if not isinstance(value, dict) or set(value) != {
            "latitude",
            "longitude",
            "confidence",
            "status",
            "timestamp",
        }:
            raise GoogleFindHubRequestError(
                "Google Find Hub report provider returned an invalid report"
            )
        try:
            latitude_value = value["latitude"]
            longitude_value = value["longitude"]
            confidence_value = value["confidence"]
            status_value = value["status"]
            if (
                isinstance(latitude_value, bool)
                or not isinstance(latitude_value, (int, float))
                or isinstance(longitude_value, bool)
                or not isinstance(longitude_value, (int, float))
                or isinstance(confidence_value, bool)
                or not isinstance(confidence_value, int)
                or isinstance(status_value, bool)
                or not isinstance(status_value, int)
            ):
                raise ValueError("report numbers must use JSON number types")
            latitude = float(latitude_value)
            longitude = float(longitude_value)
            confidence = confidence_value
            status = status_value
            timestamp_text = value["timestamp"]
            if not isinstance(timestamp_text, str):
                raise ValueError("timestamp must be a string")
            timestamp = datetime.fromisoformat(timestamp_text.replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                raise ValueError("timestamp must include a timezone")
            timestamp = timestamp.astimezone(UTC)
        except (TypeError, ValueError, OverflowError) as exc:
            raise GoogleFindHubRequestError(
                "Google Find Hub report provider returned invalid report values"
            ) from exc
        if (
            not math.isfinite(latitude)
            or not math.isfinite(longitude)
            or not -90 <= latitude <= 90
            or not -180 <= longitude <= 180
            or not 0 <= confidence <= 255
            or not 0 <= status <= 255
        ):
            raise GoogleFindHubRequestError(
                "Google Find Hub report provider returned out-of-range values"
            )
        return FinderReport(
            latitude=latitude,
            longitude=longitude,
            confidence=confidence,
            status=status,
            timestamp=timestamp,
        )
