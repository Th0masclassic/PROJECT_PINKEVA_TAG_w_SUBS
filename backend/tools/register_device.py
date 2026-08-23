#!/usr/bin/env python3
"""Register a factory tag and emit its one-time QR payload.

Run this only inside the controlled manufacturing environment. The setup code
is printed once and must go directly to the product label/QR generation step.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import uuid

import psycopg

from app.config import decode_32_byte_secret
from app.crypto import setup_code_digest


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
    pepper = decode_32_byte_secret(
        "PINQEVA_SETUP_CODE_PEPPER", os.environ["PINQEVA_SETUP_CODE_PEPPER"]
    )
    setup_code = secrets.token_urlsafe(24)
    salt = os.urandom(16)
    digest = setup_code_digest(setup_code, salt, pepper)

    with psycopg.connect(database_url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO public.device (
                    id, serial_number, name, status,
                    setup_secret_salt, setup_secret_digest
                ) VALUES (%s, %s, %s, 'unprovisioned', %s, %s)
                """,
                (uuid.uuid4(), serial_number, args.name, salt, digest),
            )

    qr_payload = {
        "version": 1,
        "serial_number": serial_number,
        "setup_code": setup_code,
    }
    print(json.dumps(qr_payload, separators=(",", ":")))


if __name__ == "__main__":
    main()
