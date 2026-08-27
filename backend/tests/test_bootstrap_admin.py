from __future__ import annotations

import base64
import json
from uuid import UUID

import pytest

from tools.bootstrap_admin import (
    AdminBootstrapError,
    create_admin_user,
    generate_password,
    normalize_supabase_url,
    validate_admin_secret,
    validate_password,
)


class Response:
    def __init__(self, status_code: int, payload: dict[str, str], text: str = ""):
        self.status_code = status_code
        self.payload = payload
        self.text = text

    def json(self):
        return self.payload


class Session:
    def __init__(self, response: Response):
        self.response = response
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


def legacy_service_key() -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps({"role": "service_role"}).encode()
    ).decode().rstrip("=")
    return f"header.{payload}.signature"


def test_generated_admin_password_meets_strong_policy() -> None:
    for _ in range(20):
        password = generate_password()
        assert len(password) == 24
        assert validate_password(password) == password


def test_admin_secret_rejects_publishable_key() -> None:
    with pytest.raises(AdminBootstrapError):
        validate_admin_secret("sb_publishable_not-an-admin-secret")
    assert validate_admin_secret(legacy_service_key()) == legacy_service_key()


def test_supabase_url_requires_origin_only() -> None:
    assert (
        normalize_supabase_url("https://project.supabase.co/")
        == "https://project.supabase.co"
    )
    with pytest.raises(AdminBootstrapError):
        normalize_supabase_url("https://project.supabase.co/auth/v1")


def test_create_admin_user_uses_confirmed_server_side_flow() -> None:
    user_id = UUID("32c55047-60d0-46c5-8b05-a6f2fee9dde7")
    session = Session(Response(200, {"id": str(user_id)}))

    result = create_admin_user(
        session=session,
        supabase_url="https://project.supabase.co",
        admin_secret=legacy_service_key(),
        email="admin-pinkeva@pinkeva.com",
        username="admin-pinkeva",
        password="Strong-Admin-Password-123!",
    )

    assert result == user_id
    url, request = session.calls[0]
    assert url == "https://project.supabase.co/auth/v1/admin/users"
    assert request["json"]["email_confirm"] is True
    assert request["json"]["user_metadata"]["display_name"] == "admin-pinkeva"
    assert request["headers"]["Authorization"].startswith("Bearer ")


def test_admin_api_error_never_echoes_response_body() -> None:
    session = Session(Response(403, {}, text="sensitive provider response"))

    with pytest.raises(AdminBootstrapError) as error:
        create_admin_user(
            session=session,
            supabase_url="https://project.supabase.co",
            admin_secret=legacy_service_key(),
            email="admin-pinkeva@pinkeva.com",
            username="admin-pinkeva",
            password="Strong-Admin-Password-123!",
        )

    assert "sensitive provider response" not in str(error.value)
