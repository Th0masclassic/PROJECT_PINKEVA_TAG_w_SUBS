"""Select an enrolled Apple SMS number without guessing or logging the number."""

from __future__ import annotations

import json
import re
from getpass import getpass
from html.parser import HTMLParser

from .apple_2fa import TwoFactorError


class _BootArguments(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.collecting = False
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "script" and "boot_args" in (dict(attrs).get("class") or "").split():
            self.collecting = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "script":
            self.collecting = False

    def handle_data(self, data: str) -> None:
        if self.collecting:
            self.parts.append(data)


def parse_phone_numbers(page: str) -> list[dict]:
    try:
        if len(page) > 1_000_000:
            raise ValueError("oversized")
        parser = _BootArguments()
        parser.feed(page)
        data = json.loads("".join(parser.parts))
        numbers = data["direct"]["phoneNumberVerification"]["trustedPhoneNumbers"]
        if not isinstance(numbers, list) or not numbers:
            raise ValueError("missing")
        if any(
            not isinstance(n, dict)
            or type(n.get("id")) is not int
            or n["id"] <= 0
            or not isinstance(n.get("numberWithDialCode"), str)
            for n in numbers
        ):
            raise ValueError("invalid")
        return numbers
    except (ValueError, TypeError, KeyError) as exc:
        raise TwoFactorError("two_factor_methods_unavailable") from exc


def phone_suffix(number: dict) -> str:
    match = re.search(r"([0-9]{2,})\D*$", number["numberWithDialCode"])
    return match[1][-4:] if match else ""


def select_twilio_phone(numbers: list[dict], target: str, configured_id: int) -> int:
    def matches_target(number: dict) -> bool:
        display = number["numberWithDialCode"]
        digits = "".join(re.findall(r"[0-9]", display))
        if re.fullmatch(r"[0-9+() .-]+", display) and len(digits) >= 8:
            return target == "+" + digits
        return bool(phone_suffix(number)) and target.endswith(phone_suffix(number))

    matches = [n for n in numbers if matches_target(n)]
    if configured_id:
        matches = [n for n in matches if n["id"] == configured_id]
    if len(matches) != 1:
        raise TwoFactorError("two_factor_phone_selection_required")
    return matches[0]["id"]


class InteractiveTwoFactor:
    def __call__(self, prompt: str) -> str:
        return getpass(prompt)

    def select_phone_id(self, numbers: list[dict], configured_id: int) -> int:
        if configured_id and any(n["id"] == configured_id for n in numbers):
            return configured_id
        if not configured_id and len(numbers) == 1:
            return numbers[0]["id"]
        print("Trusted Apple SMS numbers (masked):")
        for number in numbers:
            print(f"  ID {number['id']}: ends in {phone_suffix(number) or 'unknown'}")
        selected = getpass("Apple SMS phone ID: ").strip()
        if not selected.isdecimal() or not any(
            n["id"] == int(selected) for n in numbers
        ):
            raise TwoFactorError("two_factor_phone_selection_required")
        return int(selected)
