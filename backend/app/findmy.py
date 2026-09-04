from __future__ import annotations

"""Small, server-side adapter for the Find My report protocol.

The original ``Test/Apple_FindMy_test/request_reports.py`` utility is useful for
manual experiments, but it reads private keys from local ``.keys`` files and
writes reports to SQLite.  The API cannot do either of those things: the key
material is encrypted in ``provisioning_session`` and the only durable
projection we expose is the device's latest accepted location.  This module
keeps the same request and P-224/AES-GCM decoding schematic while making the
credentials, key material, and network response server-side only.
"""

import base64
import hashlib
import json
import logging
import struct
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

import requests
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .apple_auth import (
    AppleAuthenticationError,
    AppleSession,
    _anisette_headers as apple_anisette_headers,
)


logger = logging.getLogger("pinqeva.findmy")


class FindMyConfigurationError(RuntimeError):
    """Raised when the backend has not been configured for Find My reports."""

    def __init__(self, message: str, *, code: str = "configuration_error") -> None:
        super().__init__(message)
        self.code = code


class FindMyRequestError(RuntimeError):
    """Raised when Apple cannot be queried or returns an unusable response."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "request_failed",
        http_status: int | None = None,
        stage: str = "request",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.stage = stage


class FindMyTokenExpired(RuntimeError):
    """Raised when Apple's report endpoint rejects the current session token."""


@dataclass(frozen=True)
class FinderReport:
    latitude: float
    longitude: float
    confidence: int
    status: int
    timestamp: datetime
    # Stable provider identity for overlapping polling windows. Apple does
    # not expose a separate report id after decryption, so this is SHA-256 of
    # the encrypted report payload. Other providers may supply their own
    # already-hashed source identity.
    source_fingerprint: bytes | None = None


FindMyCredentials = AppleSession


class AppleSessionProvider(Protocol):
    """Authentication contract shared by local and distributed providers."""

    @property
    def client_id(self) -> uuid.UUID: ...

    @property
    def device_id(self) -> uuid.UUID: ...

    def session(self) -> AppleSession: ...

    def refresh_if_expired(
        self, expired_session: AppleSession, *, status_code: int = 401
    ) -> AppleSession: ...

    def reject_session(
        self, expired_session: AppleSession, *, status_code: int = 401
    ) -> None: ...

    def mark_verified(self, session: AppleSession) -> None: ...

    def note_request_failure(
        self, session: AppleSession, *, code: str, http_status: int | None = None
    ) -> None: ...


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _decode_b64(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("invalid base64 value")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid base64 value") from exc


def _normalise_report_id(value: str) -> str:
    # Apple has returned both padded standard Base64 and unpadded/url-safe
    # spellings of the SHA-256 identifier over time. Compare canonical bytes,
    # never an attacker-controlled display string.
    try:
        raw = base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))
    except (ValueError, TypeError):
        return value
    return _b64(raw)


def _decode_tag(payload: bytes) -> tuple[float, float, int, int]:
    if len(payload) < 10:
        raise ValueError("report payload is too short")
    latitude = struct.unpack(">i", payload[0:4])[0] / 10_000_000.0
    longitude = struct.unpack(">i", payload[4:8])[0] / 10_000_000.0
    confidence = payload[8]
    status = payload[9]
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError("report coordinates are outside valid bounds")
    return latitude, longitude, confidence, status


def _decrypt_report(private_key: bytes, payload: bytes) -> FinderReport:
    # This is the same OpenHaystack/P-224 report format used by the checked-in
    # request_reports.py. Apple may prepend one byte to the report, so preserve
    # the timestamp and remove only that documented byte before decoding.
    data = payload
    if len(data) > 88:
        data = data[:4] + data[5:]
    if len(data) < 82:
        raise ValueError("report payload is too short")

    timestamp = int.from_bytes(data[0:4], "big") + 978_307_200
    if timestamp <= 0:
        raise ValueError("report timestamp is invalid")
    report_time = datetime.fromtimestamp(timestamp, UTC)
    if len(private_key) != 28:
        raise ValueError("finder private key has an invalid size")

    ephemeral_key = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP224R1(), data[5:62]
    )
    private = ec.derive_private_key(
        int.from_bytes(private_key, "big"), ec.SECP224R1(), default_backend()
    )
    shared_key = private.exchange(ec.ECDH(), ephemeral_key)

    # Keep this byte-level KDF identical to the original utility. It is not a
    # general-purpose KDF; changing the inputs would make existing tags unreadable.
    digest = hashlib.sha256(shared_key + b"\x00\x00\x00\x01" + data[5:62]).digest()
    decryption_key = digest[:16]
    iv = digest[16:]
    encrypted = data[62:72]
    tag = data[72:]
    if len(encrypted) != 10 or len(tag) != 16:
        raise ValueError("report encryption envelope is invalid")

    decryptor = Cipher(
        algorithms.AES(decryption_key), modes.GCM(iv, tag), default_backend()
    ).decryptor()
    clear = decryptor.update(encrypted) + decryptor.finalize()
    latitude, longitude, confidence, status = _decode_tag(clear)
    return FinderReport(
        latitude=latitude,
        longitude=longitude,
        confidence=confidence,
        status=status,
        timestamp=report_time,
        source_fingerprint=hashlib.sha256(payload).digest(),
    )


class FindMyClient:
    """Fetch and decrypt one device report without returning key material."""

    def __init__(
        self,
        *,
        auth_file: str = "",
        dsid: str = "",
        search_party_token: str = "",
        auth_manager: AppleSessionProvider | None = None,
        anisette_url: str = "http://127.0.0.1:6969",
        timeout_seconds: float = 15.0,
        lookback_hours: int = 24,
        report_api: str = "v2",
    ) -> None:
        self.auth_file = auth_file.strip()
        self.dsid = dsid.strip()
        self.search_party_token = search_party_token.strip()
        self.auth_manager = auth_manager
        self.anisette_url = anisette_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.lookback_hours = lookback_hours
        if report_api not in {"v2", "legacy"}:
            raise FindMyConfigurationError("Unsupported Apple report API")
        self.report_api = report_api
        self._client_id = uuid.uuid4()
        self._device_id = uuid.uuid4()

    def _credentials(self) -> FindMyCredentials:
        if self.auth_manager is not None:
            try:
                session = self.auth_manager.session()
            except AppleAuthenticationError as exc:
                raise FindMyConfigurationError(
                    "Find My credentials are unavailable", code=exc.code
                ) from exc
            return FindMyCredentials(
                dsid=session.dsid,
                search_party_token=session.search_party_token,
            )
        dsid = self.dsid
        token = self.search_party_token
        if (not dsid or not token) and self.auth_file:
            try:
                data = json.loads(Path(self.auth_file).read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise FindMyConfigurationError(
                    "Find My credentials are unavailable"
                ) from exc
            if isinstance(data, dict):
                file_dsid = data.get("dsid")
                file_token = data.get("searchPartyToken")
                if not dsid and isinstance(file_dsid, str):
                    dsid = file_dsid.strip()
                if not token and isinstance(file_token, str):
                    token = file_token.strip()
        if (
            not dsid
            or not token
            or len(dsid) > 128
            or len(token) > 4096
            or any(character in dsid + token for character in "\x00\r\n")
        ):
            raise FindMyConfigurationError("Find My credentials are unavailable")
        return FindMyCredentials(dsid=dsid, search_party_token=token)

    def _anisette_headers(self) -> dict[str, str]:
        try:
            return apple_anisette_headers(
                self.anisette_url,
                timeout_seconds=self.timeout_seconds,
                client_id=self.auth_manager.client_id
                if self.auth_manager
                else self._client_id,
                device_id=self.auth_manager.device_id
                if self.auth_manager
                else self._device_id,
            )
        except AppleAuthenticationError as exc:
            logger.warning(
                "findmy_request_failed stage=anisette reason=anisette_unavailable"
            )
            raise FindMyConfigurationError(
                "Find My report service is unavailable", code="anisette_unavailable"
            ) from exc

    def fetch_reports(
        self,
        *,
        advertisement_key_sha256: bytes,
        private_key: bytes,
        now: datetime | None = None,
        lookback_hours: int | None = None,
    ) -> list[FinderReport]:
        if len(advertisement_key_sha256) != 32 or len(private_key) != 28:
            raise FindMyRequestError("finder key material has an invalid size")

        current = now or datetime.now(UTC)
        requested_lookback = (
            self.lookback_hours if lookback_hours is None else lookback_hours
        )
        if not 1 <= requested_lookback <= 168:
            raise FindMyRequestError("finder report lookback is invalid")
        start = current - timedelta(hours=requested_lookback)
        identifier = _b64(advertisement_key_sha256)
        reports = self._request_reports(
            advertisement_key_sha256, start=start, end=current
        )

        expected_ids = {identifier, _normalise_report_id(identifier)}
        usable: list[FinderReport] = []
        seen: set[tuple[datetime, float, float, int, int]] = set()
        for raw_report in reports:
            if not isinstance(raw_report, dict):
                continue
            report_id = raw_report.get("id")
            encoded_payload = raw_report.get("payload")
            if not isinstance(report_id, str) or not isinstance(encoded_payload, str):
                continue
            if _normalise_report_id(report_id) not in expected_ids:
                continue
            try:
                report = _decrypt_report(private_key, _decode_b64(encoded_payload))
            except (ValueError, TypeError, IndexError):
                # One malformed report must not prevent valid reports from
                # being returned, and details must not reach the client.
                continue
            if report.timestamp < start or report.timestamp > current + timedelta(
                minutes=5
            ):
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
            usable.append(report)
        usable.sort(key=lambda report: report.timestamp, reverse=True)
        logger.info(
            "findmy_request_reports_processed requested_ids=1 usable_report_count=%s",
            len(usable),
        )
        return usable

    def probe_reports(self, advertisement_key_sha256: bytes) -> int:
        """Exercise real Apple auth using one registered key; reveal only a count."""
        if len(advertisement_key_sha256) != 32:
            raise FindMyRequestError("finder key material has an invalid size")
        current = datetime.now(UTC)
        return len(
            self._request_reports(
                advertisement_key_sha256,
                start=current - timedelta(hours=self.lookback_hours),
                end=current,
            )
        )

    def _request_reports(
        self, advertisement_key_sha256: bytes, *, start: datetime, end: datetime
    ) -> list[Any]:
        credentials = self._credentials()
        payload = {
            "search": [
                {
                    "startDate": int(start.timestamp() * 1000),
                    "endDate": int(end.timestamp() * 1000),
                    "ids": [_b64(advertisement_key_sha256)],
                }
            ]
        }
        endpoint = "https://gateway.icloud.com/acsnservice/fetch"
        if self.report_api == "v2":
            endpoint = "https://gateway.icloud.com/findmyservice/v2/fetch"
            payload = {
                "clientContext": {
                    "clientBundleIdentifier": "com.apple.icloud.searchpartyuseragent",
                    "policy": "foregroundClient",
                },
                "fetch": [
                    {
                        "ownedDeviceIds": [],
                        "keyType": 1,
                        "startDate": int(start.timestamp() * 1000),
                        "startDateSecondary": int(start.timestamp() * 1000),
                        "endDate": int(end.timestamp() * 1000),
                        "primaryIds": [_b64(advertisement_key_sha256)],
                        "secondaryIds": [],
                    }
                ],
            }
        for attempt in range(2):
            try:
                headers = self._anisette_headers()
            except FindMyConfigurationError:
                if self.auth_manager:
                    self.auth_manager.note_request_failure(
                        credentials, code="anisette_unavailable"
                    )
                raise
            headers["Accept"] = "application/json"
            headers["Content-Type"] = "application/json"
            try:
                response = requests.post(
                    endpoint,
                    auth=(credentials.dsid, credentials.search_party_token),
                    headers=headers,
                    json=payload,
                    timeout=self.timeout_seconds,
                    allow_redirects=False,
                )
            except requests.RequestException as exc:
                logger.warning(
                    "findmy_request_failed stage=apple_http reason=network_error"
                )
                if self.auth_manager:
                    self.auth_manager.note_request_failure(
                        credentials, code="network_error"
                    )
                raise FindMyRequestError(
                    "Apple is unavailable", code="network_error", stage="apple_http"
                ) from exc
            status_code = getattr(response, "status_code", 200)
            if status_code in {401, 403}:
                logger.warning(
                    "findmy_request_failed stage=apple_http apple_http_status=%s reason=apple_session_rejected",
                    status_code,
                )
                if self.auth_manager is None or attempt == 1:
                    if self.auth_manager:
                        self.auth_manager.reject_session(
                            credentials, status_code=status_code
                        )
                    raise FindMyRequestError(
                        "Apple rejected the session",
                        code="apple_session_rejected",
                        http_status=status_code,
                        stage="apple_http",
                    )
                try:
                    credentials = self.auth_manager.refresh_if_expired(
                        credentials, status_code=status_code
                    )
                except AppleAuthenticationError as refresh_error:
                    raise FindMyRequestError(
                        "Apple authentication recovery is pending",
                        code=refresh_error.code,
                        http_status=status_code,
                        stage="authentication",
                    ) from refresh_error
                logger.info("findmy_token_refreshed")
                continue
            if status_code != 200:
                reason = (
                    "apple_rate_limited" if status_code == 429 else "apple_http_error"
                )
                if self.auth_manager:
                    self.auth_manager.note_request_failure(
                        credentials, code=reason, http_status=status_code
                    )
                logger.warning(
                    "findmy_request_failed stage=apple_http apple_http_status=%s reason=%s",
                    status_code,
                    reason,
                )
                raise FindMyRequestError(
                    "Apple is unavailable",
                    code=reason,
                    http_status=status_code,
                    stage="apple_http",
                )
            try:
                result = response.json()
            except (ValueError, TypeError) as exc:
                logger.warning(
                    "findmy_request_failed stage=apple_json apple_http_status=200 reason=invalid_json"
                )
                if self.auth_manager:
                    self.auth_manager.note_request_failure(
                        credentials, code="invalid_json", http_status=200
                    )
                raise FindMyRequestError(
                    "Apple returned invalid JSON",
                    code="invalid_json",
                    http_status=200,
                    stage="apple_json",
                ) from exc
            reports = self._parse_reports(result)
            if not isinstance(reports, list):
                if self.auth_manager:
                    self.auth_manager.note_request_failure(
                        credentials, code="invalid_response", http_status=200
                    )
                logger.warning(
                    "findmy_request_failed stage=apple_json apple_http_status=200 reason=invalid_response"
                )
                raise FindMyRequestError(
                    "Apple returned an invalid report response",
                    code="invalid_response",
                    http_status=200,
                    stage="apple_json",
                )
            if self.auth_manager:
                try:
                    self.auth_manager.mark_verified(credentials)
                except AppleAuthenticationError as exc:
                    raise FindMyConfigurationError(
                        "Authentication state is unavailable", code=exc.code
                    ) from exc
            logger.info(
                "findmy_request_reports_received apple_http_status=200 requested_ids=1 report_count=%s",
                len(reports),
            )
            return reports
        raise FindMyRequestError("Apple authentication recovery is pending")

    def _parse_reports(self, result: Any) -> list[Any] | None:
        if not isinstance(result, dict):
            return None
        if self.report_api == "legacy":
            if str(result.get("statusCode", "200")) != "200":
                return None
            return result.get("results")
        locations = result.get("acsnLocations")
        if not isinstance(locations, dict) or str(locations.get("statusCode")) != "200":
            return None
        groups = locations.get("locationPayload", [])
        if not isinstance(groups, list):
            return None
        reports = []
        for group in groups:
            if (
                not isinstance(group, dict)
                or not isinstance(group.get("id"), str)
                or not isinstance(group.get("locationInfo", []), list)
            ):
                return None
            for payload in group.get("locationInfo", []):
                if not isinstance(payload, str):
                    return None
                reports.append({"id": group["id"], "payload": payload})
        return reports

    def fetch_latest(
        self,
        *,
        advertisement_key_sha256: bytes,
        private_key: bytes,
        now: datetime | None = None,
    ) -> FinderReport | None:
        reports = self.fetch_reports(
            advertisement_key_sha256=advertisement_key_sha256,
            private_key=private_key,
            now=now,
        )
        return reports[0] if reports else None
