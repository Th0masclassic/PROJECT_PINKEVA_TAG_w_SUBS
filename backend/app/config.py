from __future__ import annotations

import base64
import ipaddress
import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import parse_qsl, urlparse
from uuid import UUID


class ConfigurationError(RuntimeError):
    pass


PLAN_CODE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
STRIPE_PRICE_ID_PATTERN = re.compile(r"^price_[A-Za-z0-9]{8,}$")
STRIPE_PRODUCT_ID_PATTERN = re.compile(r"^prod_[A-Za-z0-9]{8,}$")
STRIPE_API_VERSION_PATTERN = re.compile(
    r"^20[0-9]{2}-[0-9]{2}-[0-9]{2}(?:\.[a-z]+)?$"
)


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


def validate_database_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
        raise ConfigurationError("DATABASE_URL must be a PostgreSQL connection URL")

    hostname = parsed.hostname.lower()
    is_local = hostname == "localhost"
    if not is_local:
        try:
            is_local = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            is_local = False

    if not is_local:
        ssl_modes = [
            option_value
            for option_name, option_value in parse_qsl(
                parsed.query, keep_blank_values=True
            )
            if option_name == "sslmode"
        ]
        if len(ssl_modes) != 1 or ssl_modes[0] not in {
            "require",
            "verify-ca",
            "verify-full",
        }:
            raise ConfigurationError(
                "Remote DATABASE_URL connections must use exactly one TLS-required sslmode"
            )
    return value


def validate_https_url(name: str, value: str) -> str:
    parsed = urlparse(value)
    if not parsed.hostname:
        raise ConfigurationError(f"{name} must be an absolute URL")
    hostname = parsed.hostname.lower()
    is_local = hostname == "localhost"
    if not is_local:
        try:
            is_local = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            is_local = False
    if parsed.scheme != "https" and not (parsed.scheme == "http" and is_local):
        raise ConfigurationError(f"{name} must use HTTPS outside local development")
    return value.rstrip("/")


def parse_stripe_price_map(value: str) -> tuple[tuple[str, str, str], ...]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ConfigurationError("STRIPE_PRICE_MAP_JSON must be valid JSON") from exc
    if not isinstance(parsed, dict) or not parsed:
        raise ConfigurationError(
            "STRIPE_PRICE_MAP_JSON must map plan codes to Price and Product IDs"
        )

    result: list[tuple[str, str, str]] = []
    seen_price_ids: set[str] = set()
    for plan_code, provider_mapping in parsed.items():
        if not isinstance(plan_code, str) or not PLAN_CODE_PATTERN.fullmatch(plan_code):
            raise ConfigurationError(
                "STRIPE_PRICE_MAP_JSON contains an invalid plan code"
            )
        if not isinstance(provider_mapping, dict) or set(provider_mapping) != {
            "price_id",
            "product_id",
        }:
            raise ConfigurationError(
                "Each Stripe plan mapping must contain only price_id and product_id"
            )
        price_id = provider_mapping["price_id"]
        product_id = provider_mapping["product_id"]
        if not isinstance(price_id, str) or not STRIPE_PRICE_ID_PATTERN.fullmatch(
            price_id
        ):
            raise ConfigurationError(
                "STRIPE_PRICE_MAP_JSON contains an invalid Stripe Price ID"
            )
        if not isinstance(
            product_id, str
        ) or not STRIPE_PRODUCT_ID_PATTERN.fullmatch(product_id):
            raise ConfigurationError(
                "STRIPE_PRICE_MAP_JSON contains an invalid Stripe Product ID"
            )
        if price_id in seen_price_ids:
            raise ConfigurationError(
                "STRIPE_PRICE_MAP_JSON must map each plan to a different Price ID"
            )
        seen_price_ids.add(price_id)
        result.append((plan_code, price_id, product_id))
    return tuple(sorted(result))


def validate_stripe_secret(
    name: str, value: str, prefixes: str | tuple[str, ...]
) -> str:
    allowed_prefixes = (prefixes,) if isinstance(prefixes, str) else prefixes
    if not value.startswith(allowed_prefixes) or len(value) < 24:
        raise ConfigurationError(f"{name} does not have the expected format")
    return value


def parse_boolean(name: str, value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes"}:
        return True
    if normalized in {"0", "false", "no"}:
        return False
    raise ConfigurationError(f"{name} must be true or false")


def parse_uuid_set(name: str, value: str) -> frozenset[UUID]:
    result: set[UUID] = set()
    for item in value.split(","):
        normalized = item.strip()
        if not normalized:
            continue
        try:
            result.add(UUID(normalized))
        except ValueError:
            raise ConfigurationError(f"{name} contains an invalid UUID") from None
    return frozenset(result)


def parse_allowed_origins(value: str) -> tuple[str, ...]:
    result: set[str] = set()
    for item in value.split(","):
        normalized = item.strip()
        if not normalized:
            continue
        validated = validate_https_url("PINQEVA_ADMIN_ALLOWED_ORIGINS", normalized)
        parsed = urlparse(validated)
        if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ConfigurationError(
                "PINQEVA_ADMIN_ALLOWED_ORIGINS entries must contain only an origin"
            )
        port = f":{parsed.port}" if parsed.port is not None else ""
        result.add(f"{parsed.scheme}://{parsed.hostname}{port}")
    return tuple(sorted(result))


@dataclass(frozen=True)
class Settings:
    database_url: str
    supabase_jwks_url: str
    supabase_jwt_issuer: str
    supabase_jwt_audience: str
    supabase_jwt_algorithms: tuple[str, ...]
    key_encryption_key: bytes
    bootstrap_key_encryption_key: bytes
    claim_token_key: bytes
    session_ttl_seconds: int
    claim_ttl_seconds: int
    # Find My report credentials are deliberately optional at process startup:
    # provisioning and authentication must still work on a server before the
    # operator has completed the one-time Apple token setup. Location requests
    # fail closed with a short safe error until these values are configured.
    findmy_auth_file: str = ""
    findmy_dsid: str = ""
    findmy_search_party_token: str = ""
    findmy_anisette_url: str = "http://127.0.0.1:6969"
    findmy_request_timeout_seconds: float = 15.0
    findmy_lookback_hours: int = 24
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_price_map: tuple[tuple[str, str, str], ...] = ()
    stripe_checkout_success_url: str = ""
    stripe_checkout_cancel_url: str = ""
    stripe_portal_return_url: str = ""
    stripe_portal_configuration_id: str | None = None
    stripe_api_version: str = "2025-08-27.basil"
    admin_owner_user_ids: frozenset[UUID] = frozenset()
    admin_allowed_origins: tuple[str, ...] = ()
    admin_require_aal2: bool = True

    def __post_init__(self) -> None:
        if len(
            {
                self.key_encryption_key,
                self.bootstrap_key_encryption_key,
                self.claim_token_key,
            }
        ) != 3:
            raise ConfigurationError(
                "Finder-key, bootstrap-key, and claim-token secrets must be independent"
            )

    def stripe_price_for(self, plan_code: str) -> str | None:
        mapping = next(
            (entry for entry in self.stripe_price_map if entry[0] == plan_code),
            None,
        )
        return mapping[1] if mapping else None

    def stripe_product_for(self, plan_code: str) -> str | None:
        mapping = next(
            (entry for entry in self.stripe_price_map if entry[0] == plan_code),
            None,
        )
        return mapping[2] if mapping else None


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

    try:
        findmy_timeout = float(
            os.getenv("PINQEVA_FINDMY_REQUEST_TIMEOUT_SECONDS", "15")
        )
        findmy_lookback = int(os.getenv("PINQEVA_FINDMY_LOOKBACK_HOURS", "24"))
    except ValueError:
        raise ConfigurationError("Find My report timing settings are invalid") from None
    if not 3 <= findmy_timeout <= 60:
        raise ConfigurationError(
            "PINQEVA_FINDMY_REQUEST_TIMEOUT_SECONDS must be between 3 and 60"
        )
    if not 1 <= findmy_lookback <= 168:
        raise ConfigurationError(
            "PINQEVA_FINDMY_LOOKBACK_HOURS must be between 1 and 168"
        )

    findmy_anisette_url = validate_https_url(
        "PINQEVA_FINDMY_ANISETTE_URL",
        os.getenv("PINQEVA_FINDMY_ANISETTE_URL", "http://127.0.0.1:6969").strip(),
    )

    project_url_value = os.getenv("SUPABASE_URL", "").strip()
    if project_url_value:
        project_url = validate_https_url("SUPABASE_URL", project_url_value)
        jwks_url = validate_https_url(
            "SUPABASE_JWKS_URL",
            os.getenv(
                "SUPABASE_JWKS_URL",
                f"{project_url}/auth/v1/.well-known/jwks.json",
            ).strip(),
        )
        jwt_issuer = validate_https_url(
            "SUPABASE_JWT_ISSUER",
            os.getenv("SUPABASE_JWT_ISSUER", f"{project_url}/auth/v1").strip(),
        )
    else:
        jwks_url = validate_https_url(
            "SUPABASE_JWKS_URL", _required("SUPABASE_JWKS_URL")
        )
        jwt_issuer = validate_https_url(
            "SUPABASE_JWT_ISSUER", _required("SUPABASE_JWT_ISSUER")
        )

    stripe_api_version = os.getenv(
        "STRIPE_API_VERSION", "2025-08-27.basil"
    ).strip()
    if not STRIPE_API_VERSION_PATTERN.fullmatch(stripe_api_version):
        raise ConfigurationError("STRIPE_API_VERSION has an invalid format")

    portal_configuration = os.getenv(
        "STRIPE_PORTAL_CONFIGURATION_ID", ""
    ).strip()
    if portal_configuration and not re.fullmatch(
        r"^bpc_[A-Za-z0-9]{8,}$", portal_configuration
    ):
        raise ConfigurationError(
            "STRIPE_PORTAL_CONFIGURATION_ID has an invalid format"
        )

    return Settings(
        database_url=validate_database_url(_required("DATABASE_URL")),
        supabase_jwks_url=jwks_url,
        supabase_jwt_issuer=jwt_issuer,
        supabase_jwt_audience=os.getenv(
            "SUPABASE_JWT_AUDIENCE", "authenticated"
        ).strip(),
        supabase_jwt_algorithms=algorithms,
        key_encryption_key=decode_32_byte_secret(
            "PINQEVA_KEY_ENCRYPTION_KEY", _required("PINQEVA_KEY_ENCRYPTION_KEY")
        ),
        bootstrap_key_encryption_key=decode_32_byte_secret(
            "PINQEVA_BOOTSTRAP_KEY_ENCRYPTION_KEY",
            _required("PINQEVA_BOOTSTRAP_KEY_ENCRYPTION_KEY"),
        ),
        claim_token_key=decode_32_byte_secret(
            "PINQEVA_CLAIM_TOKEN_KEY", _required("PINQEVA_CLAIM_TOKEN_KEY")
        ),
        session_ttl_seconds=session_ttl,
        claim_ttl_seconds=claim_ttl,
        findmy_auth_file=os.getenv("PINQEVA_FINDMY_AUTH_FILE", "").strip(),
        findmy_dsid=os.getenv("PINQEVA_FINDMY_DSID", "").strip(),
        findmy_search_party_token=os.getenv(
            "PINQEVA_FINDMY_SEARCH_PARTY_TOKEN", ""
        ).strip(),
        findmy_anisette_url=findmy_anisette_url,
        findmy_request_timeout_seconds=findmy_timeout,
        findmy_lookback_hours=findmy_lookback,
        stripe_secret_key=validate_stripe_secret(
            "STRIPE_SECRET_KEY",
            _required("STRIPE_SECRET_KEY"),
            ("sk_test_", "sk_live_"),
        ),
        stripe_webhook_secret=validate_stripe_secret(
            "STRIPE_WEBHOOK_SECRET", _required("STRIPE_WEBHOOK_SECRET"), "whsec_"
        ),
        stripe_price_map=parse_stripe_price_map(_required("STRIPE_PRICE_MAP_JSON")),
        stripe_checkout_success_url=validate_https_url(
            "STRIPE_CHECKOUT_SUCCESS_URL", _required("STRIPE_CHECKOUT_SUCCESS_URL")
        ),
        stripe_checkout_cancel_url=validate_https_url(
            "STRIPE_CHECKOUT_CANCEL_URL", _required("STRIPE_CHECKOUT_CANCEL_URL")
        ),
        stripe_portal_return_url=validate_https_url(
            "STRIPE_PORTAL_RETURN_URL", _required("STRIPE_PORTAL_RETURN_URL")
        ),
        stripe_portal_configuration_id=portal_configuration or None,
        stripe_api_version=stripe_api_version,
        admin_owner_user_ids=parse_uuid_set(
            "PINQEVA_ADMIN_OWNER_USER_IDS",
            os.getenv("PINQEVA_ADMIN_OWNER_USER_IDS", ""),
        ),
        admin_allowed_origins=parse_allowed_origins(
            os.getenv("PINQEVA_ADMIN_ALLOWED_ORIGINS", "")
        ),
        admin_require_aal2=parse_boolean(
            "PINQEVA_ADMIN_REQUIRE_AAL2",
            os.getenv("PINQEVA_ADMIN_REQUIRE_AAL2", "true"),
        ),
    )
