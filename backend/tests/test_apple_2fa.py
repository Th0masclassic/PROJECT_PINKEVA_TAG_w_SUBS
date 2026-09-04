from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import pytest

from app.apple_2fa import TwilioSMSCodeProvider, TwoFactorError, UnattendedTwoFactor
from app.apple_auth import APPLE_GSA_CA_BUNDLE, _complete_two_factor
from app.apple_sms import parse_phone_numbers, select_twilio_phone


SID = "AC" + "1" * 32
NUMBER = "+15555550123"


def provider(**kwargs):
    return TwilioSMSCodeProvider(
        **{
            "account_sid": SID,
            "auth_token": "test-auth-token",
            "phone_number": NUMBER,
            "allowed_senders": ("12345",),
            **kwargs,
        }
    )


def sms(**changes):
    return {
        "sid": "SM" + "2" * 32,
        "account_sid": SID,
        "direction": "inbound",
        "status": "received",
        "to": NUMBER,
        "from": "12345",
        "body": "Your Apple ID verification code is 123456. Do not share it.",
        "date_created": format_datetime(datetime.now(UTC)),
        **changes,
    }


def started(monkeypatch, **kwargs):
    receiver = provider(**kwargs)
    monkeypatch.setattr(receiver, "_messages", lambda: [])
    receiver.begin()
    return receiver


@pytest.mark.parametrize(
    "changes",
    [
        {"sid": "invalid"},
        {"account_sid": "AC" + "3" * 32},
        {"direction": "outbound-api"},
        {"status": "sent"},
        {"to": "+15555559999"},
        {"from": "unexpected"},
        {"from": []},
        {"date_created": "invalid"},
        {"date_created": False},
        {"date_created": format_datetime(datetime.now(UTC) - timedelta(minutes=2))},
        {"date_created": format_datetime(datetime.now(UTC) + timedelta(minutes=2))},
        {"date_created": "Mon, 31 Aug 2026 12:00:00"},
        {"body": "A different service code is 123456"},
        {"body": "Apple 123456 654321"},
        {"body": "Apple 1234567"},
        {"body": "Apple 12345"},
        {"body": None},
        {"body": "Apple 123456" + "x" * 1600},
    ],
)
def test_receiver_rejects_unrelated_stale_or_ambiguous_codes(monkeypatch, changes):
    receiver = started(monkeypatch)
    assert receiver._code(sms(**changes)) is None


def test_receiver_accepts_only_a_fresh_message_once(monkeypatch):
    receiver = started(monkeypatch)
    message = sms()
    assert receiver._code(message) == "123456"
    assert receiver._code(message) is None


def test_preexisting_same_second_message_is_never_replayed(monkeypatch):
    receiver = provider()
    old = sms()
    monkeypatch.setattr(receiver, "_messages", lambda: [old])
    receiver.begin()
    assert receiver._code(old) is None


def test_sms_wait_times_out_and_can_be_stopped(monkeypatch):
    receiver = started(monkeypatch, timeout_seconds=0)
    with pytest.raises(TwoFactorError) as error:
        receiver("prompt")
    assert error.value.code == "two_factor_sms_timeout"
    receiver = started(monkeypatch)
    receiver.stop.set()
    with pytest.raises(TwoFactorError) as error:
        receiver("prompt")
    assert error.value.code == "authentication_stopped"


class Response:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code, self.payload, self.text = status, payload, text
        self.ok = 200 <= status < 300

    def json(self):
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload

    def raise_for_status(self):
        assert self.ok


@pytest.mark.parametrize(
    "status, reason",
    [
        (401, "twilio_credentials_rejected"),
        (429, "twilio_rate_limited"),
        (302, "twilio_unavailable"),
    ],
)
def test_twilio_uses_fixed_account_endpoint_without_redirects_and_safe_errors(
    monkeypatch, status, reason
):
    calls = []

    def get(url, **kwargs):
        calls.append((url, kwargs))
        return Response(status, AssertionError("Error bodies must not be parsed"))

    monkeypatch.setattr("app.apple_2fa.requests.get", get)
    receiver = provider()
    with pytest.raises(TwoFactorError) as error:
        receiver.begin()
    assert error.value.code == reason
    url, params = calls[0]
    assert url == f"https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json"
    assert params["allow_redirects"] is False
    assert params["params"] == {"To": NUMBER, "PageSize": 100}


def test_no_provider_fails_before_sending_an_uncollectable_sms(monkeypatch):
    monkeypatch.setattr("app.apple_auth._anisette_headers", lambda *a, **kw: {})
    monkeypatch.setattr(
        "app.apple_auth.requests.put",
        lambda *a, **kw: pytest.fail("No SMS should be sent"),
    )
    with pytest.raises(TwoFactorError) as error:
        _complete_two_factor(
            {"adsid": "123", "GsIdmsToken": "test-token"},
            second_factor="sms",
            anisette_url="http://127.0.0.1:6970",
            timeout_seconds=5,
            client_id=uuid.uuid4(),
            device_id=uuid.uuid4(),
            two_factor_code_provider=UnattendedTwoFactor(),
        )
    assert error.value.code == "two_factor_provider_required"


def test_sms_flow_discovers_twilio_number_snapshots_then_sends_and_verifies(
    monkeypatch, caplog
):
    receiver = provider()
    events, received = [], []
    boot = {
        "direct": {
            "phoneNumberVerification": {
                "trustedPhoneNumbers": [
                    {"id": 1, "numberWithDialCode": "+1 ••• ••• ••99"},
                    {"id": 7, "numberWithDialCode": "+1 ••• ••• ••23"},
                ]
            }
        }
    }
    monkeypatch.setattr("app.apple_auth._anisette_headers", lambda *a, **kw: {})

    def get(url, **kwargs):
        assert url == "https://gsa.apple.com/auth"
        assert kwargs["verify"] == APPLE_GSA_CA_BUNDLE
        events.append("methods")
        return Response(
            text='<script class="boot_args">' + json.dumps(boot) + "</script>"
        )

    def messages():
        events.append("poll" if received else "snapshot")
        return list(received)

    def send(url, **kwargs):
        events.append("send")
        assert url == "https://gsa.apple.com/auth/verify/phone"
        assert kwargs["json"] == {"phoneNumber": {"id": 7}, "mode": "sms"}
        assert kwargs["verify"] == APPLE_GSA_CA_BUNDLE
        assert kwargs["allow_redirects"] is False
        received.append(sms())  # Delivered before Apple's HTTP response returns.
        return Response()

    def verify(url, **kwargs):
        events.append("verify")
        assert kwargs["json"]["securityCode"]["code"] == "123456"
        assert kwargs["json"]["phoneNumber"]["id"] == 7
        return Response()

    monkeypatch.setattr("app.apple_auth.requests.get", get)
    monkeypatch.setattr(receiver, "_messages", messages)
    monkeypatch.setattr("app.apple_auth.requests.put", send)
    monkeypatch.setattr("app.apple_auth.requests.post", verify)
    _complete_two_factor(
        {"adsid": "123", "GsIdmsToken": "private-test-idms"},
        second_factor="sms",
        anisette_url="http://127.0.0.1:6970",
        timeout_seconds=5,
        client_id=uuid.uuid4(),
        device_id=uuid.uuid4(),
        two_factor_code_provider=receiver,
        sms_phone_id=0,
    )
    assert events == ["methods", "snapshot", "send", "poll", "verify"]
    assert "123456" not in caplog.text
    assert "private-test-idms" not in caplog.text


def test_phone_selection_requires_an_unambiguous_match_or_explicit_id():
    numbers = [
        {"id": 1, "numberWithDialCode": "+1 ••• ••• ••23"},
        {"id": 7, "numberWithDialCode": "+1 ••• ••• ••23"},
    ]
    with pytest.raises(TwoFactorError):
        select_twilio_phone(numbers, NUMBER, 0)
    assert select_twilio_phone(numbers, NUMBER, 7) == 7
    with pytest.raises(TwoFactorError):
        select_twilio_phone(numbers, NUMBER, 9)
    with pytest.raises(TwoFactorError):
        select_twilio_phone(
            [{"id": 1, "numberWithDialCode": "+44 777 555 0123"}], NUMBER, 0
        )


@pytest.mark.parametrize(
    "page", ["", "<script>not json</script>", '<script class="boot_args">{}</script>']
)
def test_changed_apple_phone_page_fails_closed(page):
    with pytest.raises(TwoFactorError):
        parse_phone_numbers(page)
