from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from functools import lru_cache


class ConfigurationError(RuntimeError):
    pass


def _required(name: str) -> str:
    value = os.getenv(name)
    if value is None or not value.strip():
        raise ConfigurationError(f"Missing required environment variable: {name}")
    return value.strip()


def decode_32_byte_secret(name: str, value: str) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be valid standard Base64") from exc
    if len(decoded) != 32:
        raise ConfigurationError(f"{name} must decode to exactly 32 bytes")
    return decoded


@dataclass(frozen=True)
class Settings:
    database_url: str
    supabase_jwks_url: str
    supabase_jwt_issuer: str
    supabase_jwt_audience: str
    supabase_jwt_algorithms: tuple[str, ...]
    key_encryption_key: bytes
    claim_token_key: bytes
    setup_code_pepper: bytes
    session_ttl_seconds: int
    claim_ttl_seconds: int

    def __post_init__(self) -> None:
        if len(
            {
                self.key_encryption_key,
                self.claim_token_key,
                self.setup_code_pepper,
            }
        ) != 3:
            raise ConfigurationError(
                "Envelope, claim-token, and setup-code secrets must be independent"
            )


@lru_cache
def get_settings() -> Settings:
    algorithms = tuple(
        item.strip()
        for item in os.getenv("SUPABASE_JWT_ALGORITHMS", "ES256,RS256").split(",")
        if item.strip()
    )
    if not algorithms or any(item not in {"ES256", "RS256"} for item in algorithms):
        raise ConfigurationError("Only ES256 and RS256 Supabase JWTs are accepted")

    session_ttl = int(os.getenv("PINQEVA_SESSION_TTL_SECONDS", "600"))
    claim_ttl = int(os.getenv("PINQEVA_CLAIM_TTL_SECONDS", "86400"))
    if not 60 <= session_ttl <= 3600:
        raise ConfigurationError("PINQEVA_SESSION_TTL_SECONDS must be between 60 and 3600")
    if not session_ttl <= claim_ttl <= 172800:
        raise ConfigurationError(
            "PINQEVA_CLAIM_TTL_SECONDS must be >= the session TTL and <= 172800"
        )

    return Settings(
        database_url=_required("DATABASE_URL"),
        supabase_jwks_url=_required("SUPABASE_JWKS_URL"),
        supabase_jwt_issuer=_required("SUPABASE_JWT_ISSUER"),
        supabase_jwt_audience=os.getenv(
            "SUPABASE_JWT_AUDIENCE", "authenticated"
        ).strip(),
        supabase_jwt_algorithms=algorithms,
        key_encryption_key=decode_32_byte_secret(
            "PINQEVA_KEY_ENCRYPTION_KEY", _required("PINQEVA_KEY_ENCRYPTION_KEY")
        ),
        claim_token_key=decode_32_byte_secret(
            "PINQEVA_CLAIM_TOKEN_KEY", _required("PINQEVA_CLAIM_TOKEN_KEY")
        ),
        setup_code_pepper=decode_32_byte_secret(
            "PINQEVA_SETUP_CODE_PEPPER", _required("PINQEVA_SETUP_CODE_PEPPER")
        ),
        session_ttl_seconds=session_ttl,
        claim_ttl_seconds=claim_ttl,
    )
