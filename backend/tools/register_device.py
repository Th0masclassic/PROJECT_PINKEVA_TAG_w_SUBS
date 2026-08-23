#!/usr/bin/env python3
"""Register a factory tag and emit its private NVS-injection payload.

Run this only inside the controlled manufacturing environment. The emitted
bootstrap key goes into the tag's NVS partition and must never be printed on a
label, embedded in the mobile app, or retained in ordinary logs. Production
tags must additionally enable secure boot and flash/NVS encryption.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import uuid

import psycopg

from app.config import decode_32_byte_secret
from app.crypto import b64url_encode, encrypt_device_bootstrap_key


SERIAL_PATTERN = re.compile(r"^PKV-[0-9A-F]{12}$")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("serial_number", help="PKV- followed by 12 hex digits")
    parser.add_argument("--name", default="Pinqeva Tag")
    args = parser.parse_args()

    serial_number = args.serial_number.upper()
    if not SERIAL_PATTERN.fullmatch(serial_number):
        parser.error("serial_number must match PKV-[0-9A-F]{12}")

    database_url = os.environ["DATABASE_URL"]
    bootstrap_envelope_key = decode_32_byte_secret(
        "PINQEVA_BOOTSTRAP_KEY_ENCRYPTION_KEY",
        os.environ["PINQEVA_BOOTSTRAP_KEY_ENCRYPTION_KEY"],
    )
    device_id = uuid.uuid4()
    bootstrap_key = os.urandom(32)
    associated_data = (
        f"pinqeva:bootstrap:v1:{device_id}:{serial_number}"
    ).encode("ascii")
    encrypted = encrypt_device_bootstrap_key(
        bootstrap_key, bootstrap_envelope_key, associated_data
    )

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO public.device (
                    id, serial_number, name, status
                ) VALUES (%s, %s, %s, 'unprovisioned')
                """,
                (device_id, serial_number, args.name),
            )
            cursor.execute(
                """
                INSERT INTO public.device_bootstrap_credential (
                    device_id, key_ciphertext, key_nonce, envelope_version
                ) VALUES (%s, %s, %s, %s)
                """,
                (
                    device_id,
                    encrypted.ciphertext,
                    encrypted.nonce,
                    encrypted.version,
                ),
            )

    factory_payload = {
        "version": 2,
        "serial_number": serial_number,
        "nvs_namespace": "pinqeva",
        "nvs_key": "boot_key",
        "bootstrap_key_base64url": b64url_encode(bootstrap_key),
    }
    print(json.dumps(factory_payload, separators=(",", ":")))


if __name__ == "__main__":
    main()
