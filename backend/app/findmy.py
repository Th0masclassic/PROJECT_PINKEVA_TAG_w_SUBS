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
import locale
import struct
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import requests
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


class FindMyConfigurationError(RuntimeError):
    """Raised when the backend has not been configured for Find My reports."""


class FindMyRequestError(RuntimeError):
    """Raised when Apple cannot be queried or returns an unusable response."""


@dataclass(frozen=True)
class FinderReport:
    latitude: float
    longitude: float
    confidence: int
    status: int
    timestamp: datetime


@dataclass(frozen=True)
class FindMyCredentials:
    dsid: str
    search_party_token: str


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
    )


class FindMyClient:
    """Fetch and decrypt one device report without returning key material."""

    def __init__(
        self,
        *,
        auth_file: str = "",
        dsid: str = "",
        search_party_token: str = "",
        anisette_url: str = "http://127.0.0.1:6969",
        timeout_seconds: float = 15.0,
        lookback_hours: int = 24,
    ) -> None:
        self.auth_file = auth_file.strip()
        self.dsid = dsid.strip()
        self.search_party_token = search_party_token.strip()
        self.anisette_url = anisette_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.lookback_hours = lookback_hours

    def _credentials(self) -> FindMyCredentials:
        dsid = self.dsid
        token = self.search_party_token
        if (not dsid or not token) and self.auth_file:
            try:
                data = json.loads(Path(self.auth_file).read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise FindMyConfigurationError("Find My credentials are unavailable") from exc
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
            or any(
                character in dsid + token for character in "\x00\r\n"
            )
        ):
            raise FindMyConfigurationError("Find My credentials are unavailable")
        return FindMyCredentials(dsid=dsid, search_party_token=token)

    def _anisette_headers(self) -> dict[str, str]:
        try:
            response = requests.get(self.anisette_url, timeout=self.timeout_seconds)
            response.raise_for_status()
            data = response.json()
            machine = data["X-Apple-I-MD-M"]
            otp = data["X-Apple-I-MD"]
            if not isinstance(machine, str) or not isinstance(otp, str):
                raise ValueError("invalid anisette response")
        except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
            raise FindMyConfigurationError("Find My report service is unavailable") from exc

        language = locale.getlocale()[0] or "en_US"
        now = datetime.now(UTC)
        return {
            "X-Apple-I-MD": otp,
            "X-Apple-I-MD-M": machine,
            "X-Apple-I-Client-Time": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "X-Apple-I-TimeZone": str(datetime.now().astimezone().tzinfo),
            "loc": language,
            "X-Apple-Locale": language,
            "X-Apple-I-MD-RINFO": "17106176",
            "X-Apple-I-MD-LU": _b64(str(uuid.uuid4()).upper().encode("ascii")),
            "X-Mme-Device-Id": str(uuid.uuid4()).upper(),
            "X-Apple-I-SRL-NO": "0",
        }

    def fetch_latest(
        self,
        *,
        advertisement_key_sha256: bytes,
        private_key: bytes,
        now: datetime | None = None,
    ) -> FinderReport | None:
        if len(advertisement_key_sha256) != 32 or len(private_key) != 28:
            raise FindMyRequestError("finder key material has an invalid size")

        credentials = self._credentials()
        current = now or datetime.now(UTC)
        start = current - timedelta(hours=self.lookback_hours)
        identifier = _b64(advertisement_key_sha256)
        payload = {
            "search": [
                {
                    "startDate": int(start.timestamp() * 1000),
                    "endDate": int(current.timestamp() * 1000),
                    "ids": [identifier],
                }
            ]
        }
        headers = self._anisette_headers()
        headers["Accept"] = "application/json"
        headers["Content-Type"] = "application/json"
        try:
            response = requests.post(
                "https://gateway.icloud.com/acsnservice/fetch",
                auth=(credentials.dsid, credentials.search_party_token),
                headers=headers,
                json=payload,
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            result = response.json()
        except (requests.RequestException, ValueError, TypeError) as exc:
            raise FindMyRequestError("Find My report request failed") from exc

        reports = result.get("results") if isinstance(result, dict) else None
        if not isinstance(reports, list):
            raise FindMyRequestError("Find My report response was invalid")

        expected_ids = {identifier, _normalise_report_id(identifier)}
        newest: FinderReport | None = None
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
                # One malformed report must not prevent a newer valid report
                # from being considered, and details must not reach the client.
                continue
            if report.timestamp < start or report.timestamp > current + timedelta(minutes=5):
                continue
            if newest is None or report.timestamp > newest.timestamp:
                newest = report
        return newest
