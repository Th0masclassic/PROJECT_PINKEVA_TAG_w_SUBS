from __future__ import annotations

"""Apple account authentication for the server-side Find My client.

Apple's Find My fetch endpoint accepts a short-lived search-party token, not an
Apple ID password.  This module obtains that token through the legacy GSA/SRP
flow used by the checked-in experimental utility, prompts for 2FA only when
Apple requires it, and keeps the resulting session in memory.

The password and 2FA code are never logged or persisted.  A future SMS provider
can replace ``two_factor_code_provider`` without changing the report client.
"""

import base64
import hashlib
import hmac
import json
import locale
import plistlib
import re
import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from getpass import getpass
from pathlib import Path
from typing import Any, Callable, Literal

import requests
import srp._pysrp as srp
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


srp.rfc5054_enable()
srp.no_username_in_x()


# biemster/FindMy disables TLS verification for the legacy GSA endpoint because
# its chain terminates at the older Apple Root CA, which is absent from
# requests/certifi. Keep verification enabled by explicitly trusting the root
# published by Apple instead. The setup.icloud.com request uses normal certifi.
APPLE_GSA_CA_BUNDLE = str(Path(__file__).with_name("apple_root_ca.pem"))


SecondFactor = Literal["sms", "trusted_device"]
TwoFactorCodeProvider = Callable[[str], str]


class AppleAuthenticationError(RuntimeError):
    """Raised when Apple credentials or the 2FA flow cannot produce a session."""


@dataclass(frozen=True)
class AppleSession:
    dsid: str
    search_party_token: str


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _text(value: Any, field_name: str) -> str:
    if isinstance(value, bytes):
        value = _b64(value)
    if not isinstance(value, str):
        raise AppleAuthenticationError(f"Apple authentication response missing {field_name}")
    normalized = value.strip()
    if not normalized or len(normalized) > 4096 or any(
        character in normalized for character in "\x00\r\n"
    ):
        raise AppleAuthenticationError(f"Apple authentication response has invalid {field_name}")
    return normalized


def _session_from_mapping(value: Any) -> AppleSession:
    if not isinstance(value, dict):
        raise AppleAuthenticationError("Apple authentication data is invalid")
    return AppleSession(
        dsid=_text(value.get("dsid"), "dsid"),
        search_party_token=_text(value.get("searchPartyToken"), "searchPartyToken"),
    )


def load_cached_session(path: str) -> AppleSession:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AppleAuthenticationError("Find My cached credentials are unavailable") from exc
    return _session_from_mapping(data)


def _anisette_headers(
    anisette_url: str,
    *,
    timeout_seconds: float,
    client_id: uuid.UUID,
    device_id: uuid.UUID,
) -> dict[str, str]:
    try:
        response = requests.get(anisette_url.rstrip("/"), timeout=timeout_seconds)
        response.raise_for_status()
        data = response.json()
        machine = data["X-Apple-I-MD-M"]
        otp = data["X-Apple-I-MD"]
        if not isinstance(machine, str) or not isinstance(otp, str):
            raise ValueError("anisette values are invalid")
    except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
        raise AppleAuthenticationError("The Anisette service is unavailable") from exc

    language = locale.getlocale()[0] or "en_US"
    now = datetime.now(UTC)
    return {
        "X-Apple-I-MD": otp,
        "X-Apple-I-MD-M": machine,
        "X-Apple-I-Client-Time": now.replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "X-Apple-I-TimeZone": str(datetime.now().astimezone().tzinfo),
        "loc": language,
        "X-Apple-Locale": language,
        "X-Apple-I-MD-RINFO": "17106176",
        "X-Apple-I-MD-LU": _b64(str(client_id).upper().encode("ascii")),
        "X-Mme-Device-Id": str(device_id).upper(),
        "X-Apple-I-SRL-NO": "0",
    }


def _parse_plist_response(response: requests.Response, *, operation: str) -> dict[str, Any]:
    try:
        response.raise_for_status()
        value = plistlib.loads(response.content)
    except (requests.RequestException, ValueError, plistlib.InvalidFileException) as exc:
        raise AppleAuthenticationError(f"Apple {operation} failed") from exc
    if not isinstance(value, dict):
        raise AppleAuthenticationError(f"Apple {operation} returned an invalid response")
    return value


def _gsa_request(
    parameters: dict[str, Any],
    *,
    anisette_url: str,
    timeout_seconds: float,
    client_id: uuid.UUID,
    device_id: uuid.UUID,
) -> dict[str, Any]:
    body = {
        "Header": {"Version": "1.0.1"},
        "Request": {"cpd": _generate_cpd(
            anisette_url,
            timeout_seconds=timeout_seconds,
            client_id=client_id,
            device_id=device_id,
        )},
    }
    body["Request"].update(parameters)
    headers = {
        "Content-Type": "text/x-xml-plist",
        "Accept": "*/*",
        "User-Agent": "akd/1.0 CFNetwork/978.0.7 Darwin/18.7.0",
        "X-MMe-Client-Info": (
            "<MacBookPro18,3> <Mac OS X;13.4.1;22F8> "
            "<com.apple.AOSKit/282 (com.apple.dt.Xcode/3594.4.19)>"
        ),
    }
    try:
        response = requests.post(
            "https://gsa.apple.com/grandslam/GsService2",
            headers=headers,
            data=plistlib.dumps(body),
            timeout=timeout_seconds,
            verify=APPLE_GSA_CA_BUNDLE,
        )
    except requests.RequestException as exc:
        raise AppleAuthenticationError("Apple authentication service is unavailable") from exc
    parsed = _parse_plist_response(response, operation="GSA authentication")
    result = parsed.get("Response")
    if not isinstance(result, dict):
        raise AppleAuthenticationError("Apple GSA authentication returned an invalid response")
    return result


def _generate_cpd(
    anisette_url: str,
    *,
    timeout_seconds: float,
    client_id: uuid.UUID,
    device_id: uuid.UUID,
) -> dict[str, Any]:
    return {
        "bootstrap": True,
        "icscrec": True,
        "pbe": False,
        "prkgen": True,
        "svct": "iCloud",
        **_anisette_headers(
            anisette_url,
            timeout_seconds=timeout_seconds,
            client_id=client_id,
            device_id=device_id,
        ),
    }


def _encrypt_password(password: str, salt: bytes, iterations: int, protocol: str) -> bytes:
    if protocol not in {"s2k", "s2k_fo"}:
        raise AppleAuthenticationError("Apple returned an unsupported password protocol")
    password_hash = hashlib.sha256(password.encode("utf-8")).digest()
    if protocol == "s2k_fo":
        password_hash = password_hash.hex().encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", password_hash, salt, iterations, dklen=32)


def _create_session_key(user: Any, name: str) -> bytes:
    session_key = user.get_session_key()
    if session_key is None:
        raise AppleAuthenticationError("Apple authentication did not create a session key")
    return hmac.new(session_key, name.encode(), hashlib.sha256).digest()


def _decrypt_session_data(user: Any, data: bytes) -> bytes:
    key = _create_session_key(user, "extra data key:")
    iv = _create_session_key(user, "extra data iv:")[:16]
    try:
        decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
        decrypted = decryptor.update(data) + decryptor.finalize()
        unpadder = padding.PKCS7(128).unpadder()
        return unpadder.update(decrypted) + unpadder.finalize()
    except ValueError as exc:
        raise AppleAuthenticationError("Apple authentication session data is invalid") from exc


def _gsa_authenticate(
    username: str,
    password: str,
    *,
    second_factor: SecondFactor,
    anisette_url: str,
    timeout_seconds: float,
    client_id: uuid.UUID,
    device_id: uuid.UUID,
    two_factor_code_provider: TwoFactorCodeProvider,
) -> dict[str, Any]:
    user = srp.User(username, bytes(), hash_alg=srp.SHA256, ng_type=srp.NG_2048)
    _, public_a = user.start_authentication()
    response = _gsa_request(
        {"A2k": public_a, "ps": ["s2k", "s2k_fo"], "u": username, "o": "init"},
        anisette_url=anisette_url,
        timeout_seconds=timeout_seconds,
        client_id=client_id,
        device_id=device_id,
    )
    status = response.get("Status")
    status = status if isinstance(status, dict) else {}
    if status.get("ec", 0) != 0:
        raise AppleAuthenticationError("Apple rejected the configured credentials")

    protocol = response.get("sp")
    if protocol not in {"s2k", "s2k_fo"}:
        raise AppleAuthenticationError("Apple returned no supported authentication protocol")
    try:
        user.p = _encrypt_password(password, response["s"], int(response["i"]), protocol)
        proof = user.process_challenge(response["s"], response["B"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AppleAuthenticationError("Apple authentication challenge was invalid") from exc
    if proof is None:
        raise AppleAuthenticationError("Apple authentication challenge failed")

    response = _gsa_request(
        {"c": response["c"], "M1": proof, "u": username, "o": "complete"},
        anisette_url=anisette_url,
        timeout_seconds=timeout_seconds,
        client_id=client_id,
        device_id=device_id,
    )
    try:
        user.verify_session(response["M2"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AppleAuthenticationError("Apple authentication session verification failed") from exc
    if not user.authenticated():
        raise AppleAuthenticationError("Apple authentication session verification failed")

    try:
        session_data = plistlib.loads(
            b"<?xml version='1.0' encoding='UTF-8'?>"
            b"<!DOCTYPE plist PUBLIC '-//Apple//DTD PLIST 1.0//EN' "
            b"'http://www.apple.com/DTDs/PropertyList-1.0.dtd'>"
            + _decrypt_session_data(user, response["spd"])
        )
    except (KeyError, TypeError, ValueError, plistlib.InvalidFileException) as exc:
        raise AppleAuthenticationError("Apple authentication session data was invalid") from exc

    completed_status = response.get("Status")
    completed_status = completed_status if isinstance(completed_status, dict) else {}
    auth_value = completed_status.get("au")
    if auth_value in {"trustedDeviceSecondaryAuth", "secondaryAuth"}:
        _complete_two_factor(
            session_data,
            second_factor=second_factor,
            anisette_url=anisette_url,
            timeout_seconds=timeout_seconds,
            client_id=client_id,
            device_id=device_id,
            two_factor_code_provider=two_factor_code_provider,
        )
        return _gsa_authenticate(
            username,
            password,
            second_factor=second_factor,
            anisette_url=anisette_url,
            timeout_seconds=timeout_seconds,
            client_id=client_id,
            device_id=device_id,
            two_factor_code_provider=two_factor_code_provider,
        )
    if auth_value:
        raise AppleAuthenticationError("Apple returned an unsupported authentication challenge")
    if not isinstance(session_data, dict):
        raise AppleAuthenticationError("Apple authentication session data was invalid")
    return session_data


def _complete_two_factor(
    session_data: Any,
    *,
    second_factor: SecondFactor,
    anisette_url: str,
    timeout_seconds: float,
    client_id: uuid.UUID,
    device_id: uuid.UUID,
    two_factor_code_provider: TwoFactorCodeProvider,
) -> None:
    if not isinstance(session_data, dict):
        raise AppleAuthenticationError("Apple 2FA session data was invalid")
    adsid = _text(session_data.get("adsid"), "adsid")
    idms_token = _text(session_data.get("GsIdmsToken"), "GsIdmsToken")
    identity_token = _b64(f"{adsid}:{idms_token}".encode("utf-8"))
    headers = {
        "User-Agent": "Xcode",
        "Accept-Language": "en-us",
        "X-Apple-Identity-Token": identity_token,
        "X-Apple-App-Info": "com.apple.gs.xcode.auth",
        "X-Xcode-Version": "11.2 (11B41)",
        "X-Mme-Client-Info": (
            "<MacBookPro18,3> <Mac OS X;13.4.1;22F8> "
            "<com.apple.AOSKit/282 (com.apple.dt.Xcode/3594.4.19)>"
        ),
        **_anisette_headers(
            anisette_url,
            timeout_seconds=timeout_seconds,
            client_id=client_id,
            device_id=device_id,
        ),
    }
    try:
        if second_factor == "trusted_device":
            challenge_response = requests.get(
                "https://gsa.apple.com/auth/verify/trusteddevice",
                headers=headers,
                timeout=timeout_seconds,
                verify=APPLE_GSA_CA_BUNDLE,
            )
        else:
            challenge_response = requests.put(
                "https://gsa.apple.com/auth/verify/phone/",
                json={"phoneNumber": {"id": 1}, "mode": "sms"},
                headers=headers,
                timeout=timeout_seconds,
                verify=APPLE_GSA_CA_BUNDLE,
            )
        challenge_response.raise_for_status()
    except requests.RequestException as exc:
        raise AppleAuthenticationError("Apple 2FA challenge could not be started") from exc

    code = two_factor_code_provider(
        "Enter the Apple 2FA code: " if second_factor == "trusted_device" else "Enter the Apple SMS 2FA code: "
    ).strip()
    if not re.fullmatch(r"[0-9]{4,8}", code):
        raise AppleAuthenticationError("The Apple 2FA code is invalid")

    try:
        if second_factor == "trusted_device":
            headers["security-code"] = code
            response = requests.get(
                "https://gsa.apple.com/grandslam/GsService2/validate",
                headers=headers,
                timeout=timeout_seconds,
                verify=APPLE_GSA_CA_BUNDLE,
            )
        else:
            response = requests.post(
                "https://gsa.apple.com/auth/verify/phone/securitycode",
                json={
                    "phoneNumber": {"id": 1},
                    "mode": "sms",
                    "securityCode": {"code": code},
                },
                headers=headers,
                timeout=timeout_seconds,
                verify=APPLE_GSA_CA_BUNDLE,
            )
    except requests.RequestException as exc:
        raise AppleAuthenticationError("Apple 2FA validation failed") from exc
    if not response.ok:
        raise AppleAuthenticationError("Apple 2FA validation failed")


def login_apple_account(
    apple_id: str,
    password: str,
    *,
    second_factor: SecondFactor,
    anisette_url: str,
    timeout_seconds: float,
    client_id: uuid.UUID,
    device_id: uuid.UUID,
    two_factor_code_provider: TwoFactorCodeProvider = getpass,
) -> AppleSession:
    if not apple_id or not password:
        raise AppleAuthenticationError("Apple ID and password are required")
    try:
        mobileme = _gsa_authenticate(
            apple_id,
            password,
            second_factor=second_factor,
            anisette_url=anisette_url,
            timeout_seconds=timeout_seconds,
            client_id=client_id,
            device_id=device_id,
            two_factor_code_provider=two_factor_code_provider,
        )
        token_data = mobileme["t"]["com.apple.gs.idms.pet"]["token"]
        dsid = mobileme["adsid"]
    except (KeyError, TypeError, ValueError) as exc:
        raise AppleAuthenticationError("Apple login did not return a Find My session") from exc

    payload = plistlib.dumps(
        {
            "apple-id": apple_id,
            "delegates": {"com.apple.mobileme": {}},
            "password": token_data,
            "client-id": str(client_id),
        }
    )
    headers = {
        "X-Apple-ADSID": _text(dsid, "adsid"),
        "User-Agent": "com.apple.iCloudHelper/282 CFNetwork/1408.0.4 Darwin/22.5.0",
        "X-Mme-Client-Info": (
            "<MacBookPro18,3> <Mac OS X;13.4.1;22F8> "
            "<com.apple.AOSKit/282 (com.apple.accountsd/113)>"
        ),
        **_anisette_headers(
            anisette_url,
            timeout_seconds=timeout_seconds,
            client_id=client_id,
            device_id=device_id,
        ),
    }
    try:
        response = requests.post(
            "https://setup.icloud.com/setup/iosbuddy/loginDelegates",
            auth=(apple_id, token_data),
            data=payload,
            headers=headers,
            timeout=timeout_seconds,
        )
    except requests.RequestException as exc:
        raise AppleAuthenticationError("Apple Find My session request failed") from exc
    mobileme = _parse_plist_response(response, operation="Find My session request")
    try:
        delegates = mobileme["delegates"]["com.apple.mobileme"]["service-data"]["tokens"]
        return AppleSession(
            dsid=_text(mobileme.get("dsid"), "dsid"),
            search_party_token=_text(delegates["searchPartyToken"], "searchPartyToken"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise AppleAuthenticationError("Apple Find My session response was invalid") from exc


@dataclass
class AppleAuthManager:
    apple_id: str = ""
    apple_password: str = ""
    second_factor: SecondFactor = "sms"
    anisette_url: str = "http://127.0.0.1:6969"
    timeout_seconds: float = 15.0
    auth_file: str = ""
    login_on_startup: bool = True
    two_factor_code_provider: TwoFactorCodeProvider = getpass
    client_id: uuid.UUID = field(default_factory=uuid.uuid4)
    device_id: uuid.UUID = field(default_factory=uuid.uuid4)
    _session: AppleSession | None = field(default=None, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    @property
    def configured(self) -> bool:
        return bool(self.apple_id or self.auth_file)

    @property
    def should_login_on_startup(self) -> bool:
        return self.login_on_startup and self.configured

    def initialize(self) -> AppleSession:
        with self._lock:
            if self._session is not None:
                return self._session
            if self.apple_id:
                password = self.apple_password or getpass(
                    "Apple ID password (input hidden): "
                )
                if not password:
                    raise AppleAuthenticationError("An Apple ID password is required")
                self.apple_password = password
                self._session = login_apple_account(
                    self.apple_id,
                    password,
                    second_factor=self.second_factor,
                    anisette_url=self.anisette_url,
                    timeout_seconds=self.timeout_seconds,
                    client_id=self.client_id,
                    device_id=self.device_id,
                    two_factor_code_provider=self.two_factor_code_provider,
                )
            elif self.auth_file:
                self._session = load_cached_session(self.auth_file)
            else:
                raise AppleAuthenticationError("Find My Apple credentials are not configured")
            return self._session

    def session(self) -> AppleSession:
        with self._lock:
            current = self._session
        return current if current is not None else self.initialize()

    def refresh_if_expired(self, expired_session: AppleSession) -> AppleSession:
        with self._lock:
            if self._session is not None and self._session != expired_session:
                return self._session
            if not self.apple_id:
                raise AppleAuthenticationError(
                    "Find My token expired and Apple re-authentication is not configured"
                )
            password = self.apple_password or getpass(
                "Apple ID password (input hidden): "
            )
            if not password:
                raise AppleAuthenticationError("An Apple ID password is required")
            self.apple_password = password
            self._session = login_apple_account(
                self.apple_id,
                password,
                second_factor=self.second_factor,
                anisette_url=self.anisette_url,
                timeout_seconds=self.timeout_seconds,
                client_id=self.client_id,
                device_id=self.device_id,
                two_factor_code_provider=self.two_factor_code_provider,
            )
            return self._session
