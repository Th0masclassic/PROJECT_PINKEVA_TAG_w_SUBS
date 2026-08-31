from __future__ import annotations

import base64
import hashlib
import hmac
import os
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


ADVERTISEMENT_KEY_SIZE = 28
PRIVATE_KEY_SIZE = 28
P224_PUBLIC_KEY_SIZE = 57
GOOGLE_IDENTITY_KEY_SIZE = 32
GOOGLE_ADVERTISEMENT_KEY_SIZE = 20
BOOTSTRAP_KEY_SIZE = 32
ENVELOPE_VERSION = 1

# SEC 2 secp160r1 domain parameters used by Google's 20-byte Find Hub
# advertisement. This small point-multiplication routine is based on the
# published curve and protocol specifications, not the GPL research project.
_SECP160R1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFF
_SECP160R1_A = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF7FFFFFFC
_SECP160R1_G = (
    0x4A96B5688EF573284664698968C38BB913CBFC82,
    0x23A628553168947D59DCC912042351377AC5FB32,
)
_SECP160R1_N = 0x0100000000000000000001F4C8F927AED3CA752257
_GOOGLE_ROTATION_EXPONENT = 10


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
    google_advertisement_key_sha256: bytes,
    finding_network: str,
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
        raise ValueError("Apple advertisement-key digest must be exactly 32 bytes")
    if len(google_advertisement_key_sha256) != 32:
        raise ValueError("Google advertisement-key digest must be exactly 32 bytes")
    if finding_network not in {"apple", "google"}:
        raise ValueError("Finding network must be apple or google")
    message = (
        b"pinqeva:claim-complete:v2\x00"
        + session_id
        + user_id
        + device_id
        + advertisement_key_sha256
        + google_advertisement_key_sha256
        + finding_network.encode("ascii")
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
    """Derive the per-allocation secret for domain-separated tag controls."""

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


def tag_ring_authorization_proof(
    control_key: bytes, serial_number: str, challenge: bytes
) -> bytes:
    """Authorize owner ringing for one tracker-generated connection challenge.

    The existing per-allocation control key never leaves the backend in this
    flow. The domain is distinct from bootstrap authorization and factory reset.
    """

    if len(control_key) != 32 or len(challenge) != 32:
        raise ValueError("Control key and tag challenge must be exactly 32 bytes")
    serial = serial_number.encode("ascii")
    if len(serial) != 16:
        raise ValueError("Serial number must contain exactly 16 ASCII bytes")
    return hmac.new(
        control_key,
        b"pinqeva:ring-auth:v1\x00" + serial + challenge,
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


def _secp160r1_add(
    left: tuple[int, int] | None, right: tuple[int, int] | None
) -> tuple[int, int] | None:
    if left is None:
        return right
    if right is None:
        return left
    x1, y1 = left
    x2, y2 = right
    if x1 == x2 and (y1 + y2) % _SECP160R1_P == 0:
        return None
    if left == right:
        slope = (
            (3 * x1 * x1 + _SECP160R1_A)
            * pow(2 * y1, -1, _SECP160R1_P)
        ) % _SECP160R1_P
    else:
        slope = ((y2 - y1) * pow(x2 - x1, -1, _SECP160R1_P)) % _SECP160R1_P
    x3 = (slope * slope - x1 - x2) % _SECP160R1_P
    y3 = (slope * (x1 - x3) - y1) % _SECP160R1_P
    return x3, y3


def _secp160r1_multiply(scalar: int) -> tuple[int, int]:
    if not 1 <= scalar < _SECP160R1_N:
        raise ValueError("Google Find Hub scalar is outside secp160r1")
    result: tuple[int, int] | None = None
    addend: tuple[int, int] | None = _SECP160R1_G
    remaining = scalar
    while remaining:
        if remaining & 1:
            result = _secp160r1_add(result, addend)
        addend = _secp160r1_add(addend, addend)
        remaining >>= 1
    if result is None:
        raise ValueError("Google Find Hub scalar produced infinity")
    return result


def derive_google_advertisement_key(
    identity_key: bytes, beacon_time_counter: int = 0
) -> bytes:
    """Derive one 20-byte Find Hub EID from Google's published algorithm.

    The development firmware initially uses counter zero as a stable EID
    because the classic ESP32 has no battery-backed wall clock. The encrypted
    32-byte identity key is retained for certified rotating-EID firmware.
    """

    if len(identity_key) != GOOGLE_IDENTITY_KEY_SIZE:
        raise ValueError("Google identity key must be exactly 32 bytes")
    if not 0 <= beacon_time_counter <= 0xFFFFFFFF:
        raise ValueError("Google beacon time counter must be uint32")
    masked_counter = beacon_time_counter & ~(
        (1 << _GOOGLE_ROTATION_EXPONENT) - 1
    )
    timestamp = masked_counter.to_bytes(4, "big")
    block = (
        b"\xff" * 11
        + bytes((_GOOGLE_ROTATION_EXPONENT,))
        + timestamp
        + b"\x00" * 11
        + bytes((_GOOGLE_ROTATION_EXPONENT,))
        + timestamp
    )
    encryptor = Cipher(algorithms.AES(identity_key), modes.ECB()).encryptor()
    random_value = encryptor.update(block) + encryptor.finalize()
    scalar = int.from_bytes(random_value, "big") % _SECP160R1_N
    if scalar == 0:
        raise ValueError("Google identity key produced an invalid scalar")
    x_coordinate, _ = _secp160r1_multiply(scalar)
    return x_coordinate.to_bytes(GOOGLE_ADVERTISEMENT_KEY_SIZE, "big")


@dataclass(frozen=True)
class GoogleFinderKeyBundle:
    identity_key: bytes
    advertisement_key: bytes
    advertisement_key_sha256: bytes


def generate_google_finder_key_bundle() -> GoogleFinderKeyBundle:
    identity_key = os.urandom(GOOGLE_IDENTITY_KEY_SIZE)
    advertisement_key = derive_google_advertisement_key(identity_key)
    return GoogleFinderKeyBundle(
        identity_key=identity_key,
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


def encrypt_google_identity_key(
    identity_key: bytes, key: bytes, associated_data: bytes
) -> EncryptedSecret:
    if len(identity_key) != GOOGLE_IDENTITY_KEY_SIZE:
        raise ValueError("A Google identity key must be exactly 32 bytes")
    if len(key) != 32:
        raise ValueError("The AES-256 key must be exactly 32 bytes")
    nonce = os.urandom(12)
    return EncryptedSecret(
        version=ENVELOPE_VERSION,
        nonce=nonce,
        ciphertext=AESGCM(key).encrypt(nonce, identity_key, associated_data),
    )


def decrypt_private_key(
    encrypted: EncryptedSecret, key: bytes, associated_data: bytes
) -> bytes:
    if encrypted.version != ENVELOPE_VERSION:
        raise ValueError("Unsupported private-key envelope version")
    return AESGCM(key).decrypt(encrypted.nonce, encrypted.ciphertext, associated_data)


def decrypt_google_identity_key(
    encrypted: EncryptedSecret, key: bytes, associated_data: bytes
) -> bytes:
    if encrypted.version != ENVELOPE_VERSION:
        raise ValueError("Unsupported Google identity-key envelope version")
    identity_key = AESGCM(key).decrypt(
        encrypted.nonce, encrypted.ciphertext, associated_data
    )
    if len(identity_key) != GOOGLE_IDENTITY_KEY_SIZE:
        raise ValueError("Decrypted Google identity key has an invalid size")
    return identity_key


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
