from __future__ import annotations

"""Apple account authentication for the server-side Find My client.

Apple's Find My fetch endpoint accepts a short-lived search-party token, not an
Apple ID password.  This module obtains that token through the legacy GSA/SRP
flow used by the checked-in experimental utility. The Linux runtime never
prompts on stdin: an optional SMS receiver supplies Apple's own 2FA codes.
Sessions and stable client identifiers survive restarts in encrypted state.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import locale
import logging
import plistlib
import re
import threading
import time
import uuid
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from datetime import UTC, datetime
from getpass import getpass
from pathlib import Path
from typing import Any, Callable, Literal

import requests
import srp._pysrp as srp
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .apple_2fa import TwoFactorError, UnattendedTwoFactor
from .apple_sms import parse_phone_numbers
from .findmy_state import SessionStore, StateBusy, StateError, atomic_json


logger = logging.getLogger("pinqeva.apple_auth")


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

    def __init__(self, message: str, *, code: str = "authentication_failed") -> None:
        super().__init__(message)
        self.code = code


class AppleAuthenticationDeferred(AppleAuthenticationError):
    """A login is already active, cooling down, or needs operator action."""


@dataclass(frozen=True, repr=False)
class AppleSession:
    dsid: str
    search_party_token: str


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _text(value: Any, field_name: str) -> str:
    if isinstance(value, bytes):
        value = _b64(value)
    if not isinstance(value, str):
        raise AppleAuthenticationError(
            f"Apple authentication response missing {field_name}"
        )
    normalized = value.strip()
    if (
        not normalized
        or len(normalized) > 4096
        or any(character in normalized for character in "\x00\r\n")
    ):
        raise AppleAuthenticationError(
            f"Apple authentication response has invalid {field_name}"
        )
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
        raise AppleAuthenticationError(
            "Find My cached credentials are unavailable"
        ) from exc
    return _session_from_mapping(data)


def _anisette_headers(
    anisette_url: str,
    *,
    timeout_seconds: float,
    client_id: uuid.UUID,
    device_id: uuid.UUID,
) -> dict[str, str]:
    try:
        response = requests.get(
            anisette_url.rstrip("/"), timeout=timeout_seconds, allow_redirects=False
        )
        response.raise_for_status()
        if getattr(response, "status_code", 200) != 200:
            raise ValueError("unexpected anisette status")
        data = response.json()
        machine = data["X-Apple-I-MD-M"]
        otp = data["X-Apple-I-MD"]
        if any(
            not isinstance(value, str)
            or not value.strip()
            or len(value) > 16384
            or any(c in value for c in "\x00\r\n")
            for value in (machine, otp)
        ):
            raise ValueError("anisette values are invalid")
    except (requests.RequestException, ValueError, TypeError, KeyError) as exc:
        raise AppleAuthenticationError(
            "The Anisette service is unavailable", code="anisette_unavailable"
        ) from exc

    language = locale.getlocale()[0] or "en_US"
    now = datetime.now(UTC)
    headers = {
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
    # Native providers expose the identity used to provision their OTP device.
    # Preserve it for BOTH login and report requests. Two-header HTTP providers
    # use the stable fallback IDs from the encrypted session state instead.
    for name in (
        "X-Apple-I-MD-LU",
        "X-Mme-Device-Id",
        "X-Apple-I-MD-RINFO",
        "X-Apple-I-SRL-NO",
    ):
        if name not in data:
            continue
        value = data[name]
        if (
            not isinstance(value, str)
            or not value.strip()
            or len(value) > 4096
            or any(c in value for c in "\x00\r\n")
        ):
            raise AppleAuthenticationError(
                "Anisette identity headers are invalid", code="anisette_unavailable"
            )
        headers[name] = value
    return headers


def _parse_plist_response(
    response: requests.Response, *, operation: str
) -> dict[str, Any]:
    try:
        response.raise_for_status()
        value = plistlib.loads(response.content)
    except (
        requests.RequestException,
        ValueError,
        plistlib.InvalidFileException,
    ) as exc:
        raise AppleAuthenticationError(f"Apple {operation} failed") from exc
    if not isinstance(value, dict):
        raise AppleAuthenticationError(
            f"Apple {operation} returned an invalid response"
        )
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
        "Request": {
            "cpd": _generate_cpd(
                anisette_url,
                timeout_seconds=timeout_seconds,
                client_id=client_id,
                device_id=device_id,
            )
        },
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
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        raise AppleAuthenticationError(
            "Apple authentication service is unavailable"
        ) from exc
    parsed = _parse_plist_response(response, operation="GSA authentication")
    result = parsed.get("Response")
    if not isinstance(result, dict):
        raise AppleAuthenticationError(
            "Apple GSA authentication returned an invalid response"
        )
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


def _encrypt_password(
    password: str, salt: bytes, iterations: int, protocol: str
) -> bytes:
    if protocol not in {"s2k", "s2k_fo"}:
        raise AppleAuthenticationError(
            "Apple returned an unsupported password protocol"
        )
    password_hash = hashlib.sha256(password.encode("utf-8")).digest()
    if protocol == "s2k_fo":
        password_hash = password_hash.hex().encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", password_hash, salt, iterations, dklen=32)


def _create_session_key(user: Any, name: str) -> bytes:
    session_key = user.get_session_key()
    if session_key is None:
        raise AppleAuthenticationError(
            "Apple authentication did not create a session key"
        )
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
        raise AppleAuthenticationError(
            "Apple authentication session data is invalid"
        ) from exc


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
    sms_phone_id: int = 1,
    two_factor_round: int = 0,
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
        raise AppleAuthenticationError(
            "Apple rejected authentication", code="apple_auth_rejected"
        )

    protocol = response.get("sp")
    if protocol not in {"s2k", "s2k_fo"}:
        raise AppleAuthenticationError(
            "Apple returned no supported authentication protocol"
        )
    try:
        user.p = _encrypt_password(
            password, response["s"], int(response["i"]), protocol
        )
        proof = user.process_challenge(response["s"], response["B"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AppleAuthenticationError(
            "Apple authentication challenge was invalid"
        ) from exc
    if proof is None:
        raise AppleAuthenticationError("Apple authentication challenge failed")

    response = _gsa_request(
        {"c": response["c"], "M1": proof, "u": username, "o": "complete"},
        anisette_url=anisette_url,
        timeout_seconds=timeout_seconds,
        client_id=client_id,
        device_id=device_id,
    )
    completed_status = response.get("Status")
    completed_status = completed_status if isinstance(completed_status, dict) else {}
    if completed_status.get("ec", 0) != 0:
        raise AppleAuthenticationError(
            "Apple rejected authentication", code="apple_auth_rejected"
        )
    try:
        user.verify_session(response["M2"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AppleAuthenticationError(
            "Apple authentication session verification failed"
        ) from exc
    if not user.authenticated():
        raise AppleAuthenticationError(
            "Apple authentication session verification failed"
        )

    try:
        session_data = plistlib.loads(
            b"<?xml version='1.0' encoding='UTF-8'?>"
            b"<!DOCTYPE plist PUBLIC '-//Apple//DTD PLIST 1.0//EN' "
            b"'http://www.apple.com/DTDs/PropertyList-1.0.dtd'>"
            + _decrypt_session_data(user, response["spd"])
        )
    except (KeyError, TypeError, ValueError, plistlib.InvalidFileException) as exc:
        raise AppleAuthenticationError(
            "Apple authentication session data was invalid"
        ) from exc

    auth_value = completed_status.get("au")
    if auth_value in {"trustedDeviceSecondaryAuth", "secondaryAuth"}:
        if two_factor_round >= 1:
            raise AppleAuthenticationError(
                "Apple repeated the 2FA challenge", code="two_factor_repeated"
            )
        _complete_two_factor(
            session_data,
            second_factor=second_factor,
            anisette_url=anisette_url,
            timeout_seconds=timeout_seconds,
            client_id=client_id,
            device_id=device_id,
            two_factor_code_provider=two_factor_code_provider,
            sms_phone_id=sms_phone_id,
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
            sms_phone_id=sms_phone_id,
            two_factor_round=two_factor_round + 1,
        )
    if auth_value:
        raise AppleAuthenticationError(
            "Apple returned an unsupported authentication challenge"
        )
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
    sms_phone_id: int = 1,
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
    begin = getattr(two_factor_code_provider, "begin", None)
    if isinstance(two_factor_code_provider, UnattendedTwoFactor):
        two_factor_code_provider.begin()
    select_phone = getattr(two_factor_code_provider, "select_phone_id", None)
    if second_factor == "sms" and select_phone is not None:
        try:
            page = requests.get(
                "https://gsa.apple.com/auth",
                headers=headers,
                timeout=timeout_seconds,
                verify=APPLE_GSA_CA_BUNDLE,
                allow_redirects=False,
            )
            page.raise_for_status()
            if page.status_code != 200:
                raise ValueError("unexpected response")
            sms_phone_id = select_phone(parse_phone_numbers(page.text), sms_phone_id)
        except (requests.RequestException, ValueError) as exc:
            raise AppleAuthenticationError(
                "Apple SMS methods are unavailable",
                code="two_factor_methods_unavailable",
            ) from exc
    if second_factor == "sms" and sms_phone_id <= 0:
        raise AppleAuthenticationError(
            "Select a trusted SMS number", code="two_factor_phone_selection_required"
        )
    if begin is not None:
        begin()
    logger.info("findmy_two_factor_challenge method=%s", second_factor)
    try:
        if second_factor == "trusted_device":
            challenge_response = requests.get(
                "https://gsa.apple.com/auth/verify/trusteddevice",
                headers=headers,
                timeout=timeout_seconds,
                verify=APPLE_GSA_CA_BUNDLE,
                allow_redirects=False,
            )
        else:
            challenge_response = requests.put(
                "https://gsa.apple.com/auth/verify/phone",
                json={"phoneNumber": {"id": sms_phone_id}, "mode": "sms"},
                headers=headers,
                timeout=timeout_seconds,
                verify=APPLE_GSA_CA_BUNDLE,
                allow_redirects=False,
            )
        challenge_response.raise_for_status()
        if not 200 <= challenge_response.status_code < 300:
            raise AppleAuthenticationError(
                "Apple 2FA challenge could not be started",
                code="two_factor_challenge_failed",
            )
    except requests.RequestException as exc:
        raise AppleAuthenticationError(
            "Apple 2FA challenge could not be started",
            code="two_factor_challenge_failed",
        ) from exc

    code = two_factor_code_provider(
        "Enter the Apple 2FA code: "
        if second_factor == "trusted_device"
        else "Enter the Apple SMS 2FA code: "
    ).strip()
    if not re.fullmatch(r"[0-9]{4,8}", code):
        raise AppleAuthenticationError(
            "The Apple 2FA code is invalid", code="two_factor_invalid"
        )

    try:
        if second_factor == "trusted_device":
            headers["security-code"] = code
            response = requests.get(
                "https://gsa.apple.com/grandslam/GsService2/validate",
                headers=headers,
                timeout=timeout_seconds,
                verify=APPLE_GSA_CA_BUNDLE,
                allow_redirects=False,
            )
        else:
            response = requests.post(
                "https://gsa.apple.com/auth/verify/phone/securitycode",
                json={
                    "phoneNumber": {"id": sms_phone_id},
                    "mode": "sms",
                    "securityCode": {"code": code},
                },
                headers=headers,
                timeout=timeout_seconds,
                verify=APPLE_GSA_CA_BUNDLE,
                allow_redirects=False,
            )
    except requests.RequestException as exc:
        raise AppleAuthenticationError("Apple 2FA validation failed") from exc
    if not 200 <= response.status_code < 300:
        raise AppleAuthenticationError(
            "Apple 2FA validation failed", code="two_factor_invalid"
        )


def login_apple_account(
    apple_id: str,
    password: str,
    *,
    second_factor: SecondFactor,
    anisette_url: str,
    timeout_seconds: float,
    client_id: uuid.UUID,
    device_id: uuid.UUID,
    two_factor_code_provider: TwoFactorCodeProvider | None = None,
    sms_phone_id: int = 1,
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
            two_factor_code_provider=two_factor_code_provider or UnattendedTwoFactor(),
            sms_phone_id=sms_phone_id,
        )
        token_data = mobileme["t"]["com.apple.gs.idms.pet"]["token"]
        dsid = mobileme["adsid"]
    except (KeyError, TypeError, ValueError) as exc:
        raise AppleAuthenticationError(
            "Apple login did not return a Find My session"
        ) from exc

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
            allow_redirects=False,
        )
    except requests.RequestException as exc:
        raise AppleAuthenticationError("Apple Find My session request failed") from exc
    mobileme = _parse_plist_response(response, operation="Find My session request")
    try:
        delegates = mobileme["delegates"]["com.apple.mobileme"]["service-data"][
            "tokens"
        ]
        return AppleSession(
            dsid=_text(mobileme.get("dsid"), "dsid"),
            search_party_token=_text(delegates["searchPartyToken"], "searchPartyToken"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise AppleAuthenticationError(
            "Apple Find My session response was invalid"
        ) from exc


@dataclass(repr=False)
class AppleAuthManager:
    apple_id: str = ""
    apple_password: str = ""
    second_factor: SecondFactor = "sms"
    anisette_url: str = "http://127.0.0.1:6969"
    timeout_seconds: float = 15.0
    auth_file: str = ""
    login_on_startup: bool = True
    two_factor_code_provider: TwoFactorCodeProvider = field(
        default_factory=UnattendedTwoFactor
    )
    state_path: str = ""
    state_key: bytes = b""
    static_session: AppleSession | None = None
    background: bool = False
    interactive: bool = False
    sms_phone_id: int = 1
    retry_initial_seconds: float = 60
    retry_max_seconds: float = 1800
    two_factor_provider_name: str = "none"
    client_id: uuid.UUID = field(default_factory=uuid.uuid4)
    device_id: uuid.UUID = field(default_factory=uuid.uuid4)
    _session: AppleSession | None = field(default=None, init=False, repr=False)
    _lock: threading.Lock = field(
        default_factory=threading.Lock, init=False, repr=False
    )
    stop_event: threading.Event = field(
        default_factory=threading.Event, init=False, repr=False
    )
    _requested: threading.Event = field(
        default_factory=threading.Event, init=False, repr=False
    )
    _pending_rejection: tuple[AppleSession, int] | None = field(
        default=None, init=False, repr=False
    )
    _store: SessionStore | None = field(default=None, init=False, repr=False)
    _legacy_fingerprint: str = field(default="", init=False)
    _source: str = field(default="none", init=False)
    _phase: str = field(default="not_initialized", init=False)
    _last_error: str | None = field(default=None, init=False)
    _manual_required: bool = field(default=False, init=False)
    _retry_at: float = field(default=0, init=False)
    _failures: int = field(default=0, init=False)
    _verified_at: float | None = field(default=None, init=False)
    _login_at: float | None = field(default=None, init=False)
    _http_status: int | None = field(default=None, init=False)
    _last_status: dict = field(default_factory=dict, init=False, repr=False)
    _publishing: bool = field(default=False, init=False)
    _state_retry_at: float = field(default=0, init=False)
    _pending_lock: threading.Lock = field(
        default_factory=threading.Lock, init=False, repr=False
    )

    def __post_init__(self) -> None:
        if self.state_path:
            self._store = SessionStore(self.state_path, self.state_key, self.apple_id)

    @property
    def configured(self) -> bool:
        return bool(self.apple_id or self.auth_file or self.static_session)

    @property
    def should_login_on_startup(self) -> bool:
        return self.login_on_startup and self.configured

    @contextmanager
    def _operation(self):
        # One login at a time, including a separate `docker exec` login process.
        # Request threads never wait behind SMS delivery or another login.
        if self._state_retry_at > time.monotonic():
            raise AppleAuthenticationDeferred(
                "Authentication state is unavailable", code="state_unavailable"
            )
        if not self._lock.acquire(blocking=False):
            raise AppleAuthenticationDeferred(
                "Authentication is running", code="authentication_in_progress"
            )
        try:
            with self._store.lock() if self._store else nullcontext():
                yield
        except StateBusy as exc:
            raise AppleAuthenticationDeferred(
                "Authentication is running", code="authentication_in_progress"
            ) from exc
        except (StateError, OSError) as exc:
            self._session = None
            self._phase = "needs_attention"
            self._last_error = "state_unavailable"
            self._manual_required = True
            self._state_retry_at = time.monotonic() + 60
            try:
                self._publish_status()
            except (StateError, OSError):
                logger.error("findmy_authentication_state_unavailable")
            raise AppleAuthenticationError(
                "Authentication state is unavailable", code="state_unavailable"
            ) from exc
        finally:
            self._lock.release()

    def _load(self) -> None:
        data = self._store.read() if self._store else None
        if data is None:
            return
        try:
            self.client_id = uuid.UUID(data["client_id"])
            self.device_id = uuid.UUID(data["device_id"])
            self._session = (
                _session_from_mapping(data["session"]) if data["session"] else None
            )
            self._legacy_fingerprint = str(data["legacy_fingerprint"])
            self._source = str(data["source"])
            self._retry_at = float(data["retry_at"])
            self._failures = int(data["failures"])
            self._manual_required = bool(data["manual_required"])
            self._last_error = data["last_error"]
            self._verified_at = data["verified_at"]
            self._login_at = data["login_at"]
            self._http_status = data["http_status"]
            self._phase = str(data["phase"])
            if data.get("bind_account"):
                self._save()
        except (KeyError, ValueError, TypeError, AppleAuthenticationError) as exc:
            raise StateError("state_read_failed") from exc

    def _save(self) -> None:
        if self._store:
            session = self._session
            self._store.write(
                {
                    "client_id": str(self.client_id),
                    "device_id": str(self.device_id),
                    "session": {
                        "dsid": session.dsid,
                        "searchPartyToken": session.search_party_token,
                    }
                    if session
                    else None,
                    "legacy_fingerprint": self._legacy_fingerprint,
                    "source": self._source,
                    "retry_at": self._retry_at,
                    "failures": self._failures,
                    "manual_required": self._manual_required,
                    "last_error": self._last_error,
                    "verified_at": self._verified_at,
                    "login_at": self._login_at,
                    "http_status": self._http_status,
                    "phase": self._phase,
                }
            )
        self._publish_status()

    def _commit_session(self, session: AppleSession) -> None:
        # Do not let concurrent request threads use a token before it is durable.
        self._publishing = True
        self._session = session
        try:
            self._save()
        except Exception:
            self._session = None
            raise
        finally:
            self._publishing = False

    def status(self) -> dict:
        """Safe diagnostic fields only; never expose account, token, code or IDs."""
        return {
            "phase": self._phase,
            "session_available": self._session is not None,
            "auto_relogin_enabled": bool(self.apple_id and self.apple_password),
            "two_factor_provider": self.two_factor_provider_name,
            "last_error": self._last_error,
            "last_apple_http_status": self._http_status,
            "retry_at": self._retry_at or None,
            "needs_attention": self._manual_required,
            "last_verified_at": self._verified_at,
            "last_login_at": self._login_at,
        }

    def _publish_status(self) -> None:
        snapshot = self.status()
        if snapshot == self._last_status:
            return
        if self._store:
            atomic_json(
                self._store.status_path, {**snapshot, "updated_at": time.time()}
            )
        logger.info(
            "findmy_authentication_status phase=%s reason=%s",
            self._phase,
            self._last_error or "none",
        )
        self._last_status = snapshot

    def _import_legacy(self) -> None:
        if self._session is not None:
            return
        legacy = self.static_session
        if legacy is None and self.auth_file:
            try:
                legacy = load_cached_session(self.auth_file)
            except AppleAuthenticationError:
                # A missing old cache must not prevent login with credentials.
                return
        if legacy is None:
            return
        fingerprint = hashlib.sha256(
            (legacy.dsid + "\0" + legacy.search_party_token).encode()
        ).hexdigest()
        if fingerprint == self._legacy_fingerprint:
            return
        self._legacy_fingerprint = fingerprint
        self._source = "cache"
        self._phase = "cached_unverified"
        self._verified_at = None
        self._manual_required = False
        self._retry_at = 0
        self._last_error = None
        self._commit_session(legacy)

    def _failure(self, code: str, *, manual: bool = False) -> None:
        self._last_error = code
        self._failures = min(self._failures + 1, 30)
        self._manual_required = manual
        self._retry_at = time.time() + min(
            self.retry_initial_seconds * 2 ** (self._failures - 1),
            self.retry_max_seconds,
        )
        self._phase = "needs_attention" if manual else "recovering"
        self._save()

    def _apply_rejection(self) -> None:
        with self._pending_lock:
            pending = self._pending_rejection
        if pending is None:
            return
        expired, status = pending
        if self._session == expired:
            fresh_rejected = self._source == "login" and self._verified_at is None
            self._session = None
            self._verified_at = None
            self._http_status = status
            self._last_error = "apple_session_rejected"
            self._phase = "recovering"
            if fresh_rejected:
                # A successful GSA login followed by another fetch rejection
                # is not fixed by an unbounded sequence of logins/SMS messages.
                self._failure("apple_session_rejected", manual=self._failures >= 4)
            else:
                self._retry_at = 0
                self._save()
        # Keep the rejected session pending if its tombstone could not be saved.
        with self._pending_lock:
            if self._pending_rejection == pending:
                self._pending_rejection = None

    def initialize(
        self, *, force: bool = False, allow_login: bool = True
    ) -> AppleSession:
        with self._operation():
            self._load()
            self._import_legacy()
            self._apply_rejection()
            if self._pending_rejection and self._pending_rejection[0] == self._session:
                raise AppleAuthenticationDeferred(
                    "Authentication recovery is pending", code="recovery_pending"
                )
            if self._session is not None and not force:
                self._publish_status()
                return self._session
            if not force and (self._manual_required or self._retry_at > time.time()):
                raise AppleAuthenticationDeferred(
                    "Authentication recovery is pending",
                    code=self._last_error or "recovery_pending",
                )
            if not allow_login or self.stop_event.is_set():
                raise AppleAuthenticationDeferred(
                    "Authentication recovery is pending", code="recovery_pending"
                )
            if not self.apple_id or not (self.apple_password or self.interactive):
                self._failure("credentials_required", manual=True)
                raise AppleAuthenticationError(
                    "Configure Apple ID and password for re-login",
                    code="credentials_required",
                )
            password = self.apple_password
            if not password and self.interactive:
                password = getpass("Apple ID password (input hidden): ")
            if not password:
                raise AppleAuthenticationError(
                    "Apple password is required", code="credentials_required"
                )
            # Persist stable client IDs BEFORE the first network request. Forced
            # logins do not leave the previous token available to other workers.
            self._session = None
            self._phase = "authenticating"
            self._last_error = None
            self._manual_required = False
            self._verified_at = None
            self._retry_at = time.time() + self.retry_initial_seconds
            self._save()
            logger.info("findmy_authentication_starting")
            try:
                session = login_apple_account(
                    self.apple_id,
                    password,
                    second_factor=self.second_factor,
                    anisette_url=self.anisette_url,
                    timeout_seconds=self.timeout_seconds,
                    client_id=self.client_id,
                    device_id=self.device_id,
                    two_factor_code_provider=self.two_factor_code_provider,
                    sms_phone_id=self.sms_phone_id,
                )
            except (AppleAuthenticationError, TwoFactorError) as exc:
                code = exc.code
                self._failure(
                    code,
                    manual=(
                        code in {"apple_auth_rejected", "two_factor_sms_timeout"}
                        and self._failures >= 4
                    )
                    or code
                    in {
                        "credentials_rejected",
                        "credentials_required",
                        "two_factor_provider_required",
                        "twilio_credentials_rejected",
                        "two_factor_repeated",
                        "two_factor_invalid",
                        "two_factor_phone_selection_required",
                    },
                )
                raise AppleAuthenticationError(
                    "Apple authentication failed", code=code
                ) from exc
            except Exception as exc:
                # Network libraries must not leak response bodies/credentials
                # through a traceback or terminate the recovery worker.
                self._failure("authentication_failed")
                raise AppleAuthenticationError("Apple authentication failed") from exc
            self._source = "login"
            self._phase = "session_unverified"
            self._login_at = time.time()
            self._http_status = None
            self._retry_at = 0
            self._commit_session(session)
            logger.info("findmy_session_obtained verification=pending")
            return session

    def session(self) -> AppleSession:
        self._requested.set()
        current = self._session
        if (
            current is not None
            and not self._publishing
            and not (self._pending_rejection and self._pending_rejection[0] == current)
        ):
            return current
        if self.background:
            raise AppleAuthenticationDeferred(
                "Authentication recovery is pending", code="recovery_pending"
            )
        return self.initialize()

    def refresh_if_expired(
        self, expired_session: AppleSession, *, status_code: int = 401
    ) -> AppleSession:
        with self._pending_lock:
            self._pending_rejection = (expired_session, status_code)
        self._requested.set()
        return self.initialize(allow_login=not self.background)

    def reject_session(
        self, expired_session: AppleSession, *, status_code: int = 401
    ) -> None:
        """Invalidate even the final retry, without starting a second login."""
        with self._pending_lock:
            self._pending_rejection = (expired_session, status_code)
        self._requested.set()
        try:
            self.initialize(allow_login=False)
        except AppleAuthenticationError:
            pass

    def mark_verified(self, session: AppleSession) -> None:
        try:
            with self._operation():
                self._load()
                self._apply_rejection()
                if self._session != session:
                    return
                if (
                    self._phase == "ready"
                    and self._verified_at
                    and time.time() - self._verified_at < 60
                ):
                    return
                self._verified_at = time.time()
                self._http_status = 200
                self._phase = "ready"
                self._last_error = None
                self._manual_required = False
                self._failures = 0
                self._retry_at = 0
                self._save()
                logger.info("findmy_authenticated verification=apple_report_response")
        except AppleAuthenticationDeferred:
            pass

    def note_request_failure(
        self, session: AppleSession, *, code: str, http_status: int | None = None
    ) -> None:
        """Reflect an outage without discarding credentials or scheduling login."""
        try:
            with self._operation():
                self._load()
                self._apply_rejection()
                if self._session != session:
                    return
                if (
                    self._phase == "upstream_unavailable"
                    and self._last_error == code
                    and self._http_status == http_status
                ):
                    return
                self._phase = "upstream_unavailable"
                self._last_error = code
                self._http_status = http_status
                self._save()
        except AppleAuthenticationError:
            pass

    async def run(self, stop: asyncio.Event) -> None:
        """Retry outside request handlers; never prompt on the container stdin."""
        logger.info("findmy_authentication_worker_started")
        while not stop.is_set():
            try:
                await asyncio.to_thread(
                    self.initialize,
                    allow_login=self.login_on_startup or self._requested.is_set(),
                )
            except AppleAuthenticationError:
                pass  # State changes already have safe, finite log messages.
            try:
                await asyncio.wait_for(stop.wait(), timeout=5)
            except TimeoutError:
                pass
        logger.info("findmy_authentication_worker_stopped")
