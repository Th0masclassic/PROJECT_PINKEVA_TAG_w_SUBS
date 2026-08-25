from datetime import UTC, datetime, timedelta
from uuid import uuid4

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from app.crypto import b64url_encode
from app.entitlement import (
    ENTITLEMENT_BODY_SIZE,
    ENTITLEMENT_PACKET_SIZE,
    ENTITLEMENT_SIGNATURE_MAX_SIZE,
    build_entitlement,
)


def test_entitlement_packet_is_fixed_size_and_signed() -> None:
    private_key = ec.generate_private_key(ec.SECP256R1())
    issued_at = datetime(2026, 8, 25, 9, 0, tzinfo=UTC)
    packet = build_entitlement(
        serial_number="PKV-AABBCCDDEEFF",
        subscription_id=uuid4(),
        issued_at=issued_at,
        expires_at=issued_at + timedelta(days=30),
        counter=7,
        private_key=private_key,
    )

    assert len(packet) == ENTITLEMENT_PACKET_SIZE
    signature_length = packet[ENTITLEMENT_BODY_SIZE]
    assert 1 <= signature_length <= ENTITLEMENT_SIGNATURE_MAX_SIZE
    private_key.public_key().verify(
        packet[ENTITLEMENT_BODY_SIZE + 1 : ENTITLEMENT_BODY_SIZE + 1 + signature_length],
        packet[:ENTITLEMENT_BODY_SIZE],
        ec.ECDSA(hashes.SHA256()),
    )
    assert len(b64url_encode(packet)) == 180
