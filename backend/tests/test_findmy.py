from __future__ import annotations

import base64
import hashlib
import struct
from datetime import UTC, datetime, timedelta

import pytest
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app.findmy import FindMyClient


class _Response:
    def __init__(self, payload: object):
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self.payload


def _encoded_report(private_key: bytes, timestamp: int) -> str:
    tag_private = ec.derive_private_key(
        int.from_bytes(private_key, "big"), ec.SECP224R1(), default_backend()
    )
    ephemeral_private = ec.generate_private_key(ec.SECP224R1())
    ephemeral_public = ephemeral_private.public_key().public_bytes(
        encoding=Encoding.X962,
        format=PublicFormat.UncompressedPoint,
    )
    shared = tag_private.exchange(ec.ECDH(), ephemeral_private.public_key())
    digest = hashlib.sha256(shared + b"\x00\x00\x00\x01" + ephemeral_public).digest()
    clear = struct.pack(">iiBB", 38_722_300, -9_139_300, 3, 1)
    encryptor = Cipher(
        algorithms.AES(digest[:16]), modes.GCM(digest[16:]), default_backend()
    ).encryptor()
    encrypted = encryptor.update(clear) + encryptor.finalize()
    payload = (
        timestamp.to_bytes(4, "big")
        + b"\x00"
        + ephemeral_public
        + encrypted
        + encryptor.tag
    )
    return base64.b64encode(payload).decode("ascii")


def test_fetch_latest_uses_hash_and_decrypts_the_report(monkeypatch: pytest.MonkeyPatch) -> None:
    private = ec.generate_private_key(ec.SECP224R1()).private_numbers().private_value.to_bytes(28, "big")
    advertisement_hash = hashlib.sha256(b"advertisement-key").digest()
    now = datetime(2026, 8, 24, 12, 0, tzinfo=UTC)
    timestamp = int(now.timestamp())
    identifier = base64.b64encode(advertisement_hash).decode("ascii")

    def fake_get(url: str, **_: object) -> _Response:
        assert url == "http://anisette.test"
        return _Response({"X-Apple-I-MD": "otp", "X-Apple-I-MD-M": "machine"})

    def fake_post(url: str, **kwargs: object) -> _Response:
        assert url == "https://gateway.icloud.com/acsnservice/fetch"
        assert kwargs["auth"] == ("123", "search-token")
        body = kwargs["json"]
        assert body["search"][0]["ids"] == [identifier]
        return _Response(
            {
                "results": [
                    {
                        "id": identifier,
                        "payload": _encoded_report(private, timestamp - 978_307_200),
                    }
                ]
            }
        )

    monkeypatch.setattr("app.findmy.requests.get", fake_get)
    monkeypatch.setattr("app.findmy.requests.post", fake_post)

    report = FindMyClient(
        dsid="123",
        search_party_token="search-token",
        anisette_url="http://anisette.test",
    ).fetch_latest(
        advertisement_key_sha256=advertisement_hash,
        private_key=private,
        now=now,
    )

    assert report is not None
    assert report.latitude == pytest.approx(3.87223)
    assert report.longitude == pytest.approx(-0.91393)
    assert report.confidence == 3
    assert report.status == 1
    assert report.timestamp == now


def test_fetch_latest_ignores_reports_for_a_different_hashed_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private = ec.generate_private_key(ec.SECP224R1()).private_numbers().private_value.to_bytes(28, "big")
    advertisement_hash = hashlib.sha256(b"advertisement-key").digest()

    monkeypatch.setattr(
        "app.findmy.requests.get",
        lambda *_args, **_kwargs: _Response(
            {"X-Apple-I-MD": "otp", "X-Apple-I-MD-M": "machine"}
        ),
    )


def test_fetch_reports_returns_deduplicated_24h_history_newest_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private = ec.generate_private_key(ec.SECP224R1()).private_numbers().private_value.to_bytes(28, "big")
    advertisement_hash = hashlib.sha256(b"advertisement-key").digest()
    identifier = base64.b64encode(advertisement_hash).decode("ascii")
    now = datetime(2026, 8, 25, 20, 0, tzinfo=UTC)
    older = now.replace(hour=18)
    newer = now.replace(hour=19)

    monkeypatch.setattr(
        "app.findmy.requests.get",
        lambda *_args, **_kwargs: _Response(
            {"X-Apple-I-MD": "otp", "X-Apple-I-MD-M": "machine"}
        ),
    )
    monkeypatch.setattr(
        "app.findmy.requests.post",
        lambda *_args, **_kwargs: _Response(
            {
                "results": [
                    {
                        "id": base64.b64encode(b"wrong" * 7).decode("ascii"),
                        "payload": "not-used",
                    }
                ]
            }
        ),
    )

    assert (
        FindMyClient(dsid="123", search_party_token="search-token").fetch_latest(
            advertisement_key_sha256=advertisement_hash,
            private_key=private,
            now=datetime.now(UTC),
        )
        is None
    )

    def fake_post(_url: str, **kwargs: object) -> _Response:
        search = kwargs["json"]["search"][0]
        assert search["startDate"] == int((now - timedelta(hours=24)).timestamp() * 1000)
        encoded_older = _encoded_report(private, int(older.timestamp()) - 978_307_200)
        return _Response(
            {
                "results": [
                    {"id": identifier, "payload": encoded_older},
                    {
                        "id": identifier,
                        "payload": _encoded_report(
                            private, int(newer.timestamp()) - 978_307_200
                        ),
                    },
                    {"id": identifier, "payload": encoded_older},
                ]
            }
        )

    monkeypatch.setattr("app.findmy.requests.post", fake_post)
    reports = FindMyClient(
        dsid="123", search_party_token="search-token"
    ).fetch_reports(
        advertisement_key_sha256=advertisement_hash,
        private_key=private,
        now=now,
        lookback_hours=24,
    )

    assert [report.timestamp for report in reports] == [newer, older]
