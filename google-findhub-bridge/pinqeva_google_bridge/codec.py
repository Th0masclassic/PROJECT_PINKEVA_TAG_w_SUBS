from __future__ import annotations

import base64
import binascii
import hashlib
import hmac


class IdentityValidationError(ValueError):
    pass


def decode_base64url_exact(value: str, length: int) -> bytes:
    try:
        padding = "=" * ((4 - len(value) % 4) % 4)
        decoded = base64.b64decode(
            value + padding,
            altchars=b"-_",
            validate=True,
        )
    except (binascii.Error, ValueError) as exc:
        raise IdentityValidationError("identity encoding is invalid") from exc
    if len(decoded) != length or encode_base64url(decoded) != value:
        raise IdentityValidationError("identity encoding has an invalid size")
    return decoded


def encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def validate_identity_fingerprint(
    identity_key: bytes,
    expected_fingerprint: bytes,
    derive_advertisement_key,
) -> bytes:
    advertisement_key = bytes(derive_advertisement_key(identity_key, 0))
    if len(advertisement_key) != 20:
        raise IdentityValidationError("upstream produced an invalid advertisement key")
    actual = hashlib.sha256(advertisement_key).digest()
    if not hmac.compare_digest(actual, expected_fingerprint):
        raise IdentityValidationError("identity fingerprint does not match")
    return advertisement_key
