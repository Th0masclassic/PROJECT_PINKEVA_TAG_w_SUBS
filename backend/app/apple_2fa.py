"""Receive Apple's own SMS through Twilio. This does not generate/bypass 2FA."""

from __future__ import annotations

import re
import threading
import time
from collections import deque
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

import requests


class TwoFactorError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class UnattendedTwoFactor:
    def begin(self) -> None:
        # Fail BEFORE asking Apple to send a code that nobody can collect.
        raise TwoFactorError("two_factor_provider_required")

    def __call__(self, _prompt: str) -> str:
        self.begin()
        return ""


class TwilioSMSCodeProvider:
    def __init__(
        self,
        *,
        account_sid: str,
        auth_token: str,
        phone_number: str,
        allowed_senders: tuple[str, ...],
        timeout_seconds: float = 180,
        poll_seconds: float = 3,
        request_timeout: float = 10,
        stop: threading.Event | None = None,
    ) -> None:
        if not re.fullmatch(r"AC[0-9a-fA-F]{32}", account_sid):
            raise ValueError("Twilio account SID is invalid")
        if not auth_token or not re.fullmatch(r"\+[1-9][0-9]{7,14}", phone_number):
            raise ValueError("Twilio credentials or receiving number are invalid")
        if not allowed_senders or any(
            not re.fullmatch(r"[+A-Za-z0-9][A-Za-z0-9+ _-]{0,31}", s)
            for s in allowed_senders
        ):
            raise ValueError("Configure exact Apple SMS senders from the Twilio log")
        self.account_sid = account_sid
        self.auth_token = auth_token
        self.phone_number = phone_number
        self.allowed_senders = frozenset(allowed_senders)
        self.timeout_seconds = timeout_seconds
        self.poll_seconds = poll_seconds
        self.request_timeout = request_timeout
        self.stop = stop or threading.Event()
        self._started: datetime | None = None
        self._deadline = 0.0
        self._seen: set[str] = set()
        self._consumed: set[str] = set()
        self._recent: deque[str] = deque(maxlen=128)

    def _messages(self) -> list[dict[str, Any]]:
        # Fixed HTTPS origin, exact account/recipient, no attacker-controlled
        # pagination URLs or redirects carrying Twilio credentials.
        try:
            response = requests.get(
                f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages.json",
                auth=(self.account_sid, self.auth_token),
                params={"To": self.phone_number, "PageSize": 100},
                timeout=self.request_timeout,
                allow_redirects=False,
            )
            if response.status_code in {401, 403}:
                raise TwoFactorError("twilio_credentials_rejected")
            if response.status_code == 429:
                raise TwoFactorError("twilio_rate_limited")
            if response.status_code != 200:
                raise TwoFactorError("twilio_unavailable")
            payload = response.json()
            messages = payload.get("messages") if isinstance(payload, dict) else None
            if not isinstance(messages, list):
                raise TwoFactorError("twilio_invalid_response")
            return [item for item in messages if isinstance(item, dict)]
        except (requests.RequestException, ValueError) as exc:
            raise TwoFactorError("twilio_unavailable") from exc

    def begin(self) -> None:
        if self.stop.is_set():
            raise TwoFactorError("authentication_stopped")
        # Snapshot BEFORE Apple dispatches the SMS. Even codes received during
        # its HTTP response are eligible; pre-existing messages never are.
        self._seen = {
            item["sid"] for item in self._messages() if isinstance(item.get("sid"), str)
        }
        self._started = datetime.now(UTC)
        self._deadline = time.monotonic() + self.timeout_seconds

    def select_phone_id(self, numbers: list[dict], configured_id: int) -> int:
        from .apple_sms import select_twilio_phone

        return select_twilio_phone(numbers, self.phone_number, configured_id)

    def _code(self, message: dict[str, Any]) -> str | None:
        sid = message.get("sid")
        if (
            not isinstance(sid, str)
            or not re.fullmatch(r"[MS]M[0-9a-fA-F]{32}", sid)
            or sid in self._seen
            or sid in self._consumed
            or message.get("account_sid") != self.account_sid
            or message.get("direction") != "inbound"
            or message.get("status") != "received"
            or message.get("to") != self.phone_number
            or not isinstance(message.get("from"), str)
            or message.get("from") not in self.allowed_senders
        ):
            return None
        try:
            if not isinstance(message.get("date_created"), str):
                return None
            received = parsedate_to_datetime(message["date_created"])
            if received.tzinfo is None or self._started is None:
                return None
            # Twilio timestamps have second resolution. The snapshot disallows
            # replay from the same second; bound future clock skew as well.
            if (
                received.timestamp() < int(self._started.timestamp())
                or received.timestamp() > time.time() + 5
            ):
                return None
        except (KeyError, TypeError, ValueError, OverflowError):
            return None
        body = message.get("body")
        if (
            not isinstance(body, str)
            or len(body) > 1600
            or not re.search(r"\bApple\b", body, re.I)
        ):
            return None
        codes = re.findall(r"(?<![0-9])[0-9]{6}(?![0-9])", body)
        if len(codes) != 1:
            return None
        if len(self._recent) == self._recent.maxlen:
            self._consumed.discard(self._recent[0])
        self._recent.append(sid)
        self._consumed.add(sid)
        return codes[0]

    def __call__(self, _prompt: str) -> str:
        if self._started is None:
            raise TwoFactorError("two_factor_challenge_not_started")
        try:
            while time.monotonic() < self._deadline:
                if self.stop.is_set():
                    raise TwoFactorError("authentication_stopped")
                for message in self._messages():
                    code = self._code(message)
                    if code is not None:
                        return code
                self.stop.wait(
                    min(self.poll_seconds, max(0, self._deadline - time.monotonic()))
                )
            raise TwoFactorError("two_factor_sms_timeout")
        finally:
            self._started = None
            self._seen.clear()
