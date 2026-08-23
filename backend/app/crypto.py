from __future__ import annotations

import base64
import hashlib
import hmac
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


ADVERTISEMENT_KEY_SIZE = 28
PRIVATE_KEY_SIZE = 28
P224_PUBLIC_KEY_SIZE = 57
BOOTSTRAP_KEY_SIZE = 32
ENVELOPE_VERSION = 1


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def b64url_decode_exact(value: str, expected_size: int) -> bytes:
    """Decode one canonical, unpadded Base64url value of an exact size."""

    if not value or any(
        character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        for character in value
    ):
        raise ValueError("Value must be unpadded Base64url")
    try:
        decoded = base64.b64decode(
            value.replace("-", "+").replace("_", "/")
            + "=" * ((4 - len(value) % 4) % 4),
            validate=True,
        )
    except ValueError as exc:
        raise ValueError("Value must be unpadded Base64url") from exc
    if len(decoded) != expected_size or b64url_encode(decoded) != value:
        raise ValueError(f"Value must encode exactly {expected_size} bytes")
    return decoded


def claim_completion_token(
    key: bytes,
    *,
    session_id: bytes,
    user_id: bytes,
    device_id: bytes,
    advertisement_key_sha256: bytes,
) -> bytes:
    """Create a session/user/device-bound completion capability.

    This is deliberately independent from connection authorization and key-encryption
    key. It prevents a leaked session UUID or public key hash from being enough
    to complete a claim.
    """

    if len(key) != 32:
        raise ValueError("The claim-token key must be exactly 32 bytes")
    if any(len(identifier) != 16 for identifier in (session_id, user_id, device_id)):
        raise ValueError("Claim-token identifiers must be UUID bytes")
    if len(advertisement_key_sha256) != 32:
        raise ValueError("Advertisement-key digest must be exactly 32 bytes")
    message = (
        b"pinqeva:claim-complete:v1\x00"
        + session_id
        + user_id
        + device_id
        + advertisement_key_sha256
    )
    return hmac.new(key, message, hashlib.sha256).digest()


def tag_control_key(
    key: bytes,
    *,
    session_id: bytes,
    user_id: bytes,
    device_id: bytes,
    advertisement_key_sha256: bytes,
) -> bytes:
    """Derive the per-allocation secret used only for authenticated tag reset."""

    if len(key) != 32:
        raise ValueError("The claim-token key must be exactly 32 bytes")
    if any(len(identifier) != 16 for identifier in (session_id, user_id, device_id)):
        raise ValueError("Tag-control identifiers must be UUID bytes")
    if len(advertisement_key_sha256) != 32:
        raise ValueError("Advertisement-key digest must be exactly 32 bytes")
    message = (
        b"pinqeva:tag-control:v1\x00"
        + session_id
        + user_id
        + device_id
        + advertisement_key_sha256
    )
    return hmac.new(key, message, hashlib.sha256).digest()


def tag_reset_command(control_key: bytes, serial_number: str, nonce: bytes) -> bytes:
    """Build nonce || HMAC for the tag's destructive reset characteristic."""

    if len(control_key) != 32 or len(nonce) != 32:
        raise ValueError("Control keys and reset nonces must be exactly 32 bytes")
    serial = serial_number.encode("ascii")
    if len(serial) != 16:
        raise ValueError("Serial number must contain exactly 16 ASCII bytes")
    mac = hmac.new(
        control_key,
        b"pinqeva:factory-reset:v1\x00" + serial + nonce,
        hashlib.sha256,
    ).digest()
    return nonce + mac


def tag_authorization_proof(
    bootstrap_key: bytes, serial_number: str, challenge: bytes
) -> bytes:
    """Create the one-connection proof accepted by a factory-provisioned tag.

    The long-lived bootstrap key remains on the tag and backend. The mobile app
    relays only this challenge-bound HMAC, so extracting the app does not expose
    a reusable key that unlocks every Pinqeva tag.
    """

    if len(bootstrap_key) != BOOTSTRAP_KEY_SIZE or len(challenge) != 32:
        raise ValueError("Bootstrap key and tag challenge must be exactly 32 bytes")
    serial = serial_number.encode("ascii")
    if len(serial) != 16:
        raise ValueError("Serial number must contain exactly 16 ASCII bytes")
    return hmac.new(
        bootstrap_key,
        b"pinqeva:bootstrap-auth:v1\x00" + serial + challenge,
        hashlib.sha256,
    ).digest()


def release_completion_token(
    key: bytes,
    *,
    release_id: bytes,
    user_id: bytes,
    device_id: bytes,
    nonce: bytes,
) -> bytes:
    if len(key) != 32 or len(nonce) != 32:
        raise ValueError("Release token key and nonce must be exactly 32 bytes")
    if any(len(identifier) != 16 for identifier in (release_id, user_id, device_id)):
        raise ValueError("Release-token identifiers must be UUID bytes")
    return hmac.new(
        key,
        b"pinqeva:release-complete:v1\x00"
        + release_id
        + user_id
        + device_id
        + nonce,
        hashlib.sha256,
    ).digest()


@dataclass(frozen=True)
class FinderKeyBundle:
    """Server-side P-224 key material used by the experimental finder protocol.

    `public_key` is the complete uncompressed P-224 point (04 || X || Y).
    `advertisement_key` is the 28-byte X coordinate expected by the tag.
    Only `advertisement_key` may be returned by the provisioning API.
    """

    private_key: bytes
    public_key: bytes
    advertisement_key: bytes
    advertisement_key_sha256: bytes


def generate_finder_key_bundle() -> FinderKeyBundle:
    private_key = ec.generate_private_key(ec.SECP224R1())
    private_scalar = private_key.private_numbers().private_value.to_bytes(
        PRIVATE_KEY_SIZE, "big"
    )
    public_numbers = private_key.public_key().public_numbers()
    public_key = private_key.public_key().public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    advertisement_key = public_numbers.x.to_bytes(ADVERTISEMENT_KEY_SIZE, "big")

    if len(public_key) != P224_PUBLIC_KEY_SIZE:
        raise RuntimeError("Unexpected P-224 public-key encoding")

    return FinderKeyBundle(
        private_key=private_scalar,
        public_key=public_key,
        advertisement_key=advertisement_key,
        advertisement_key_sha256=hashlib.sha256(advertisement_key).digest(),
    )


@dataclass(frozen=True)
class EncryptedSecret:
    version: int
    nonce: bytes
    ciphertext: bytes


def encrypt_private_key(private_key: bytes, key: bytes, associated_data: bytes) -> EncryptedSecret:
    if len(private_key) != PRIVATE_KEY_SIZE:
        raise ValueError("A P-224 private scalar must be exactly 28 bytes")
    if len(key) != 32:
        raise ValueError("The AES-256 key must be exactly 32 bytes")

    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, private_key, associated_data)
    return EncryptedSecret(
        version=ENVELOPE_VERSION,
        nonce=nonce,
        ciphertext=ciphertext,
    )


def decrypt_private_key(
    encrypted: EncryptedSecret, key: bytes, associated_data: bytes
) -> bytes:
    if encrypted.version != ENVELOPE_VERSION:
        raise ValueError("Unsupported private-key envelope version")
    return AESGCM(key).decrypt(encrypted.nonce, encrypted.ciphertext, associated_data)


def encrypt_device_bootstrap_key(
    bootstrap_key: bytes, key: bytes, associated_data: bytes
) -> EncryptedSecret:
    if len(bootstrap_key) != BOOTSTRAP_KEY_SIZE:
        raise ValueError("A device bootstrap key must be exactly 32 bytes")
    if len(key) != 32:
        raise ValueError("The AES-256 key must be exactly 32 bytes")
    nonce = os.urandom(12)
    return EncryptedSecret(
        version=ENVELOPE_VERSION,
        nonce=nonce,
        ciphertext=AESGCM(key).encrypt(nonce, bootstrap_key, associated_data),
    )


def decrypt_device_bootstrap_key(
    encrypted: EncryptedSecret, key: bytes, associated_data: bytes
) -> bytes:
    if encrypted.version != ENVELOPE_VERSION:
        raise ValueError("Unsupported bootstrap-key envelope version")
    bootstrap_key = AESGCM(key).decrypt(
        encrypted.nonce, encrypted.ciphertext, associated_data
    )
    if len(bootstrap_key) != BOOTSTRAP_KEY_SIZE:
        raise ValueError("Decrypted bootstrap key has an invalid size")
    return bootstrap_key
