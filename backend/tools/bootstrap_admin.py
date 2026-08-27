#!/usr/bin/env python3
"""Create the first Supabase administrator without persisting its password.

This is an operator-only bootstrap utility. It uses a short-lived Supabase
secret/service-role key from the process environment, creates one confirmed
Auth user through the supported Auth Admin API, verifies the public profile
trigger when DATABASE_URL is available, and prints the owner UUID to place in
the backend secret manager. The Supabase secret is never written to disk.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import string
import sys
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import psycopg
import requests


DEFAULT_EMAIL = "admin-pinkeva@pinkeva.com"
DEFAULT_USERNAME = "admin-pinkeva"
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$")
PASSWORD_SPECIALS = "!@#$%_-+="


class AdminBootstrapError(RuntimeError):
    """Safe operator-facing bootstrap failure."""


def generate_password(length: int = 24) -> str:
    if length < 16:
        raise ValueError("generated admin passwords must be at least 16 characters")
    required = [
        secrets.choice(string.ascii_lowercase),
        secrets.choice(string.ascii_uppercase),
        secrets.choice(string.digits),
        secrets.choice(PASSWORD_SPECIALS),
    ]
    alphabet = string.ascii_letters + string.digits + PASSWORD_SPECIALS
    required.extend(secrets.choice(alphabet) for _ in range(length - len(required)))
    secrets.SystemRandom().shuffle(required)
    return "".join(required)


def validate_password(password: str) -> str:
    checks = (
        len(password) >= 16,
        any(character.islower() for character in password),
        any(character.isupper() for character in password),
        any(character.isdigit() for character in password),
        any(character in PASSWORD_SPECIALS for character in password),
    )
    if not all(checks) or any(character.isspace() for character in password):
        raise AdminBootstrapError(
            "the initial password must contain at least 16 characters, including "
            "upper-case, lower-case, number, and special characters"
        )
    return password


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if len(email) > 320 or not EMAIL_PATTERN.fullmatch(email):
        raise AdminBootstrapError("the administrator email address is invalid")
    return email


def normalize_username(value: str) -> str:
    username = value.strip()
    if not USERNAME_PATTERN.fullmatch(username):
        raise AdminBootstrapError(
            "the administrator username must contain 3-64 letters, numbers, "
            "hyphens, or underscores"
        )
    return username


def normalize_supabase_url(value: str) -> str:
    parsed = urlparse(value.strip())
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback))
    ):
        raise AdminBootstrapError("SUPABASE_URL must be an HTTPS project origin")
    port = f":{parsed.port}" if parsed.port is not None else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}"


def _legacy_service_role(payload: str) -> bool:
    try:
        padded = payload + "=" * (-len(payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(padded))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return False
    return isinstance(decoded, dict) and decoded.get("role") == "service_role"


def validate_admin_secret(value: str) -> str:
    secret = value.strip()
    if secret.startswith("sb_secret_") and len(secret) >= 32:
        return secret
    parts = secret.split(".")
    if len(parts) == 3 and _legacy_service_role(parts[1]):
        return secret
    raise AdminBootstrapError(
        "SUPABASE_SECRET_KEY must be a server secret or legacy service-role key"
    )


def create_admin_user(
    *,
    session: requests.Session,
    supabase_url: str,
    admin_secret: str,
    email: str,
    username: str,
    password: str,
) -> UUID:
    try:
        response = session.post(
            f"{supabase_url}/auth/v1/admin/users",
            headers={
                "Authorization": f"Bearer {admin_secret}",
                "apikey": admin_secret,
                "Content-Type": "application/json",
                "User-Agent": "pinkeva-admin-bootstrap/1",
            },
            json={
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": {
                    "display_name": username,
                    "name": username,
                },
            },
            timeout=20,
        )
    except requests.RequestException as error:
        raise AdminBootstrapError(
            f"Supabase Auth Admin request failed ({type(error).__name__})"
        ) from None
    if response.status_code not in {200, 201}:
        raise AdminBootstrapError(
            f"Supabase Auth Admin rejected user creation (HTTP {response.status_code})"
        )
    try:
        payload: Any = response.json()
        return UUID(str(payload["id"]))
    except (ValueError, KeyError, TypeError):
        raise AdminBootstrapError(
            "Supabase Auth Admin returned an invalid user response"
        ) from None


def verify_profile(database_url: str, user_id: UUID, email: str) -> None:
    try:
        with psycopg.connect(database_url, connect_timeout=15) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT email FROM public.profiles WHERE id = %s
                    """,
                    (user_id,),
                )
                row = cursor.fetchone()
    except psycopg.Error as error:
        raise AdminBootstrapError(
            f"administrator profile verification failed ({type(error).__name__})"
        ) from None
    if row is None or str(row[0] or "").lower() != email:
        raise AdminBootstrapError(
            "Supabase created the Auth user but the public profile trigger "
            "did not verify"
        )


def _required_environment(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise AdminBootstrapError(f"{name} is required")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create the initial confirmed Pinkeva Supabase administrator."
    )
    parser.add_argument("--email", default=DEFAULT_EMAIL)
    parser.add_argument("--username", default=DEFAULT_USERNAME)
    args = parser.parse_args()

    try:
        email = normalize_email(args.email)
        username = normalize_username(args.username)
        supabase_url = normalize_supabase_url(_required_environment("SUPABASE_URL"))
        raw_secret = os.getenv("SUPABASE_SECRET_KEY", "").strip() or os.getenv(
            "SUPABASE_SERVICE_ROLE_KEY", ""
        ).strip()
        if not raw_secret:
            raise AdminBootstrapError(
                "SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is required"
            )
        admin_secret = validate_admin_secret(raw_secret)
        password = validate_password(
            os.getenv("PINQEVA_ADMIN_INITIAL_PASSWORD", "").strip()
            or generate_password()
        )
        with requests.Session() as session:
            user_id = create_admin_user(
                session=session,
                supabase_url=supabase_url,
                admin_secret=admin_secret,
                email=email,
                username=username,
                password=password,
            )
    except AdminBootstrapError as error:
        parser.exit(1, f"error: {error}\n")

    verification_error: AdminBootstrapError | None = None
    database_url = os.getenv("DATABASE_URL", "").strip()
    if database_url:
        try:
            verify_profile(database_url, user_id, email)
        except AdminBootstrapError as error:
            # The Auth account already exists and its generated password cannot
            # be recovered. Always show the credentials before reporting the
            # profile-trigger failure so the operator can repair or remove it.
            verification_error = error

    print("Administrator created and email-confirmed.")
    print(f"Login email: {email}")
    print(f"Username: {username}")
    print(f"User ID: {user_id}")
    print(f"PINQEVA_ADMIN_OWNER_USER_IDS={user_id}")
    print(f"Temporary password (shown once): {password}")
    print("Enroll TOTP MFA on first sign-in, then rotate the temporary password.")
    if verification_error is not None:
        print(f"warning: {verification_error}", file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
