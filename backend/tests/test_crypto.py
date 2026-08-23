import os
import uuid

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric import ec

from app.crypto import (
    EncryptedSecret,
    b64url_decode_exact,
    b64url_encode,
    claim_completion_token,
    decrypt_private_key,
    encrypt_private_key,
    generate_finder_key_bundle,
    setup_code_digest,
    tag_control_key,
    tag_reset_command,
    verify_setup_code,
)


def test_generated_key_bundle_is_a_consistent_p224_key() -> None:
    bundle = generate_finder_key_bundle()

    assert len(bundle.private_key) == 28
    assert len(bundle.public_key) == 57
    assert bundle.public_key[0] == 0x04
    assert len(bundle.advertisement_key) == 28
    assert bundle.advertisement_key == bundle.public_key[1:29]
    assert len(bundle.advertisement_key_sha256) == 32

    restored = ec.derive_private_key(
        int.from_bytes(bundle.private_key, "big"), ec.SECP224R1()
    )
    assert restored.public_key().public_numbers().x.to_bytes(28, "big") == (
        bundle.advertisement_key
    )


def test_private_key_envelope_binds_ciphertext_to_session() -> None:
    bundle = generate_finder_key_bundle()
    key = os.urandom(32)
    aad = b"pinqeva:v1:session:user:device"
    encrypted = encrypt_private_key(bundle.private_key, key, aad)

    assert decrypt_private_key(encrypted, key, aad) == bundle.private_key

    with pytest.raises(InvalidTag):
        decrypt_private_key(encrypted, key, b"another-session")

    tampered = EncryptedSecret(
        version=encrypted.version,
        nonce=encrypted.nonce,
        ciphertext=encrypted.ciphertext[:-1] + bytes([encrypted.ciphertext[-1] ^ 1]),
    )
    with pytest.raises(InvalidTag):
        decrypt_private_key(tampered, key, aad)


def test_setup_code_is_peppered_and_compared_safely() -> None:
    setup_code = "kXxWmpyHXq6YJf4vJ69EBtCaJq8qJm1h"
    salt = os.urandom(16)
    pepper = os.urandom(32)
    digest = setup_code_digest(setup_code, salt, pepper)

    assert verify_setup_code(setup_code, digest, salt, pepper)
    assert not verify_setup_code(setup_code + "x", digest, salt, pepper)
    assert not verify_setup_code(setup_code, digest, salt, os.urandom(32))


def test_base64url_decoder_requires_canonical_exact_length() -> None:
    value = os.urandom(32)
    encoded = b64url_encode(value)
    assert b64url_decode_exact(encoded, 32) == value
    with pytest.raises(ValueError):
        b64url_decode_exact(encoded + "=", 32)
    with pytest.raises(ValueError):
        b64url_decode_exact(b64url_encode(os.urandom(31)), 32)


def test_claim_and_tag_control_domains_are_separated() -> None:
    root = os.urandom(32)
    session_id = uuid.uuid4().bytes
    user_id = uuid.uuid4().bytes
    device_id = uuid.uuid4().bytes
    digest = os.urandom(32)
    claim_token = claim_completion_token(
        root,
        session_id=session_id,
        user_id=user_id,
        device_id=device_id,
        advertisement_key_sha256=digest,
    )
    control_key = tag_control_key(
        root,
        session_id=session_id,
        user_id=user_id,
        device_id=device_id,
        advertisement_key_sha256=digest,
    )
    assert len(claim_token) == len(control_key) == 32
    assert claim_token != control_key
    command = tag_reset_command(control_key, "PKV-AABBCCDDEEFF", os.urandom(32))
    assert len(command) == 64
    b64url_decode_exact,
    b64url_encode,
    claim_completion_token,
