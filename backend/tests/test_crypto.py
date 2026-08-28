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
    decrypt_device_bootstrap_key,
    decrypt_google_identity_key,
    decrypt_private_key,
    derive_google_advertisement_key,
    encrypt_device_bootstrap_key,
    encrypt_google_identity_key,
    encrypt_private_key,
    generate_finder_key_bundle,
    generate_google_finder_key_bundle,
    tag_authorization_proof,
    tag_control_key,
    tag_reset_command,
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


def test_google_find_hub_eid_matches_independent_reference_vector() -> None:
    assert derive_google_advertisement_key(bytes(range(32)), 0).hex() == (
        "e6cec9ca5505f86e82781bcbe75984acb3ce5e03"
    )


def test_google_identity_key_envelope_binds_ciphertext_to_session() -> None:
    bundle = generate_google_finder_key_bundle()
    key = os.urandom(32)
    aad = b"pinqeva:google-eik:v1:session:user:device"
    encrypted = encrypt_google_identity_key(bundle.identity_key, key, aad)

    assert len(bundle.identity_key) == 32
    assert len(bundle.advertisement_key) == 20
    assert decrypt_google_identity_key(encrypted, key, aad) == bundle.identity_key
    with pytest.raises(InvalidTag):
        decrypt_google_identity_key(encrypted, key, b"another-session")


def test_bootstrap_key_is_encrypted_and_proof_is_challenge_bound() -> None:
    bootstrap_key = os.urandom(32)
    envelope_key = os.urandom(32)
    associated_data = b"pinqeva:bootstrap:v1:device:PKV-AABBCCDDEEFF"
    encrypted = encrypt_device_bootstrap_key(
        bootstrap_key, envelope_key, associated_data
    )

    assert (
        decrypt_device_bootstrap_key(encrypted, envelope_key, associated_data)
        == bootstrap_key
    )
    with pytest.raises(InvalidTag):
        decrypt_device_bootstrap_key(encrypted, envelope_key, b"another-device")

    challenge = os.urandom(32)
    proof = tag_authorization_proof(
        bootstrap_key, "PKV-AABBCCDDEEFF", challenge
    )
    assert len(proof) == 32
    assert proof != tag_authorization_proof(
        bootstrap_key, "PKV-AABBCCDDEEFF", os.urandom(32)
    )


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
    google_digest = os.urandom(32)
    claim_token = claim_completion_token(
        root,
        session_id=session_id,
        user_id=user_id,
        device_id=device_id,
        advertisement_key_sha256=digest,
        google_advertisement_key_sha256=google_digest,
        finding_network="google",
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
