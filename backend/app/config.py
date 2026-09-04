from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import math
import os
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qsl, urlparse
from uuid import UUID

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import load_der_private_key


class ConfigurationError(RuntimeError):
    pass


PLAN_CODE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
STRIPE_PRICE_ID_PATTERN = re.compile(r"^price_[A-Za-z0-9]{8,}$")
STRIPE_PRODUCT_ID_PATTERN = re.compile(r"^prod_[A-Za-z0-9]{8,}$")
STRIPE_API_VERSION_PATTERN = re.compile(r"^20[0-9]{2}-[0-9]{2}-[0-9]{2}(?:\.[a-z]+)?$")
FIRMWARE_VERSION_PATTERN = re.compile(
    r"^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$"
)


def _required(name: str) -> str:
    value = os.getenv(name)
    if value is None or not value.strip():
        raise ConfigurationError(f"Missing required environment variable: {name}")
    return value.strip()


def _is_here_placeholder(value: str) -> bool:
    return value.strip().startswith("HERE_")


def decode_32_byte_secret(name: str, value: str) -> bytes:
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be valid standard Base64") from exc
    if len(decoded) != 32:
        raise ConfigurationError(f"{name} must decode to exactly 32 bytes")
    return decoded


def decode_optional_firmware_signing_private_key(
    name: str, value: str | None
) -> ec.EllipticCurvePrivateKey | None:
    """Decode the firmware manifest signer without making startup depend on it.

    The local .env intentionally uses a HERE_* placeholder until the operator
    installs the matching key. The API can still start while firmware update
    issuance fails closed until a real P-256 key is present.
    """

    normalized = (value or "").strip()
    if not normalized or normalized.startswith("HERE_"):
        return None
    try:
        der = base64.b64decode(normalized, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ConfigurationError(
            f"{name} must be standard Base64-encoded PKCS#8 DER"
        ) from exc
    try:
        private_key = load_der_private_key(der, password=None)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError(f"{name} must contain a valid private key") from exc
    if not isinstance(private_key, ec.EllipticCurvePrivateKey):
        raise ConfigurationError(f"{name} must contain an EC private key")
    if private_key.curve.name != "secp256r1":
        raise ConfigurationError(f"{name} must use the P-256 curve")
    return private_key


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
    if _is_here_placeholder(value):
        # Keep the local backend bootable with the explicit placeholders in the
        # ignored .env. Billing stays unavailable until real catalog bindings
        # are installed, so no checkout can be created with this map.
        return ()
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
        if not isinstance(product_id, str) or not STRIPE_PRODUCT_ID_PATTERN.fullmatch(
            product_id
        ):
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
    if _is_here_placeholder(value):
        return value
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


def parse_findmy_second_factor(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"sms", "trusted_device"}:
        return normalized
    raise ConfigurationError(
        "PINQEVA_FINDMY_SECOND_FACTOR must be sms or trusted_device"
    )


def parse_findmy_anisette_provider(value: str) -> str:
    normalized = value.strip().lower()
    if normalized in {"http", "native"}:
        return normalized
    raise ConfigurationError("PINQEVA_FINDMY_ANISETTE_PROVIDER must be http or native")


def parse_firmware_release(image_path: str, version: str) -> tuple[str, str]:
    normalized_path = image_path.strip()
    normalized_version = version.strip()
    if bool(normalized_path) != bool(normalized_version):
        raise ConfigurationError(
            "PINQEVA_FIRMWARE_IMAGE_PATH and PINQEVA_FIRMWARE_VERSION must be configured together"
        )
    if normalized_version and (
        not FIRMWARE_VERSION_PATTERN.fullmatch(normalized_version)
        or any(int(component) > 255 for component in normalized_version.split("."))
    ):
        raise ConfigurationError(
            "PINQEVA_FIRMWARE_VERSION must be major.minor.patch with components from 0 to 255"
        )
    return normalized_path, normalized_version


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


def parse_admin_owner_user_ids(value: str) -> frozenset[UUID]:
    owners = parse_uuid_set("PINQEVA_ADMIN_OWNER_USER_IDS", value)
    if UUID("00000000-0000-4000-8000-000000000000") in owners:
        raise ConfigurationError(
            "PINQEVA_ADMIN_OWNER_USER_IDS still contains the example UUID"
        )
    return owners


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
    database_url: str = field(repr=False)
    supabase_jwks_url: str
    supabase_jwt_issuer: str
    supabase_jwt_audience: str
    supabase_jwt_algorithms: tuple[str, ...]
    key_encryption_key: bytes = field(repr=False)
    bootstrap_key_encryption_key: bytes = field(repr=False)
    claim_token_key: bytes = field(repr=False)
    session_ttl_seconds: int
    claim_ttl_seconds: int
    firmware_signing_private_key: ec.EllipticCurvePrivateKey | None = None
    # Find My report credentials are deliberately optional at process startup:
    # provisioning and authentication must still work on a server before the
    # operator has completed the one-time Apple token setup. Location requests
    # fail closed with a short safe error until these values are configured.
    findmy_auth_file: str = ""
    findmy_apple_id: str = ""
    findmy_apple_password: str = field(default="", repr=False)
    findmy_second_factor: str = "sms"
    findmy_login_on_startup: bool = True
    findmy_dsid: str = ""
    findmy_search_party_token: str = field(default="", repr=False)
    findmy_anisette_provider: str = "http"
    findmy_anisette_state_path: str = ""
    findmy_anisette_url: str = "http://127.0.0.1:6969"
    findmy_request_timeout_seconds: float = 15.0
    findmy_lookback_hours: int = 24
    findmy_report_api: str = "v2"
    findmy_state_path: str = ""
    findmy_retry_initial_seconds: int = 60
    findmy_retry_max_seconds: int = 1800
    findmy_two_factor_provider: str = "none"
    findmy_sms_phone_id: int = 0
    findmy_twilio_account_sid: str = ""
    findmy_twilio_auth_token: str = field(default="", repr=False)
    findmy_twilio_phone_number: str = ""
    findmy_twilio_allowed_senders: tuple[str, ...] = ()
    findmy_twilio_timeout_seconds: int = 180
    findmy_twilio_poll_seconds: int = 3
    google_findhub_bridge_url: str = ""
    google_findhub_bridge_token: str = field(default="", repr=False)
    location_sync_worker_enabled: bool = True
    location_sync_interval_seconds: int = 900
    location_sync_batch_size: int = 8
    stripe_secret_key: str = field(default="", repr=False)
    stripe_webhook_secret: str = field(default="", repr=False)
    stripe_price_map: tuple[tuple[str, str, str], ...] = ()
    stripe_checkout_success_url: str = ""
    stripe_checkout_cancel_url: str = ""
    stripe_portal_return_url: str = ""
    stripe_portal_configuration_id: str | None = None
    stripe_api_version: str = "2025-08-27.basil"
    admin_owner_user_ids: frozenset[UUID] = frozenset()
    admin_allowed_origins: tuple[str, ...] = ()
    admin_require_aal2: bool = True
    dev_bypass_bootstrap_auth: bool = False
    notification_worker_enabled: bool = False
    notification_poll_interval_seconds: int = 60
    expo_push_access_token: str = field(default="", repr=False)
    firmware_image_path: str = ""
    firmware_version: str = ""
    database_pool_min_size: int = 1
    database_pool_max_size: int = 10
    database_pool_timeout_seconds: float = 5.0
    database_pool_max_waiting: int = 100
    database_statement_timeout_seconds: int = 30
    database_lock_timeout_seconds: int = 5
    database_connect_timeout_seconds: int = 5
    premium_location_freshness_seconds: int = 30
    location_refresh_wait_seconds: float = 8.0
    location_job_timeout_seconds: float = 60.0
    location_refresh_lease_seconds: int = 120
    location_max_attempts: int = 5
    location_retry_base_seconds: int = 30
    location_premium_user_limit_per_minute: int = 30
    location_account_limit_per_minute: int = 60
    location_account_key: str = "default"
    location_worker_queue: str = "all"
    location_scheduler_interval_seconds: int = 60
    location_inactive_after_days: int = 30
    location_inactive_interval_seconds: int = 21600
    findmy_session_encryption_key: bytes | None = field(default=None, repr=False)
    worker_health_host: str = "0.0.0.0"
    worker_health_port: int = 8081
    worker_shutdown_grace_seconds: int = 75
    premium_retention_interval_seconds: int = 3600

    def __post_init__(self) -> None:
        bounds = {
            "database_pool_min_size": (0, 100),
            "database_pool_max_size": (1, 100),
            "database_pool_timeout_seconds": (0.1, 60),
            "database_pool_max_waiting": (1, 10000),
            "database_statement_timeout_seconds": (1, 300),
            "database_lock_timeout_seconds": (1, 60),
            "database_connect_timeout_seconds": (1, 60),
            "premium_location_freshness_seconds": (10, 900),
            "location_refresh_wait_seconds": (0, 30),
            "location_job_timeout_seconds": (1, 300),
            "location_refresh_lease_seconds": (10, 900),
            "location_max_attempts": (1, 20),
            "location_retry_base_seconds": (1, 3600),
            "location_premium_user_limit_per_minute": (1, 1000),
            "location_account_limit_per_minute": (1, 10000),
            "location_scheduler_interval_seconds": (1, 3600),
            "location_inactive_after_days": (1, 3650),
            "location_inactive_interval_seconds": (900, 604800),
            "worker_health_port": (1, 65535),
            "worker_shutdown_grace_seconds": (1, 600),
            "premium_retention_interval_seconds": (60, 86400),
        }
        for name, (minimum, maximum) in bounds.items():
            value = getattr(self, name)
            if not math.isfinite(value) or not minimum <= value <= maximum:
                raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
        if self.database_pool_min_size > self.database_pool_max_size:
            raise ConfigurationError("Database pool minimum exceeds maximum")
        if self.location_refresh_lease_seconds < self.location_job_timeout_seconds + 10:
            raise ConfigurationError("Location lease must exceed job timeout by at least 10 seconds")
        if self.location_worker_queue not in {"all", "realtime", "scheduled"}:
            raise ConfigurationError("Location worker queue must be all, realtime, or scheduled")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", self.location_account_key):
            raise ConfigurationError("Location account key must be a short identifier")
        if self.findmy_session_encryption_key is not None and (
            len(self.findmy_session_encryption_key) != 32
            or self.findmy_session_encryption_key in {
                self.key_encryption_key, self.bootstrap_key_encryption_key, self.claim_token_key
            }
        ):
            raise ConfigurationError("Find My session encryption requires an independent 32-byte key")
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


def _distributed_settings() -> dict:
    """Keep cloud infrastructure configuration out of business logic."""
    names = (
        "database_pool_min_size", "database_pool_max_size", "database_pool_timeout_seconds",
        "database_pool_max_waiting", "premium_location_freshness_seconds",
        "database_statement_timeout_seconds", "database_lock_timeout_seconds",
        "database_connect_timeout_seconds",
        "location_refresh_wait_seconds", "location_job_timeout_seconds",
        "location_refresh_lease_seconds", "location_max_attempts", "location_retry_base_seconds",
        "location_premium_user_limit_per_minute", "location_account_limit_per_minute",
        "location_account_key", "location_worker_queue", "location_scheduler_interval_seconds",
        "location_inactive_after_days", "location_inactive_interval_seconds",
        "worker_health_host", "worker_health_port", "worker_shutdown_grace_seconds",
        "premium_retention_interval_seconds",
    )
    result = {}
    for name in names:
        default = Settings.__dataclass_fields__[name].default
        env_name = f"PINQEVA_{name.upper()}"
        raw = os.getenv(env_name)
        if raw is not None:
            try:
                result[name] = type(default)(raw.strip())
            except ValueError:
                raise ConfigurationError(f"{env_name} has an invalid value") from None
    secret = os.getenv("PINQEVA_FINDMY_SESSION_ENCRYPTION_KEY", "").strip()
    if secret:
        result["findmy_session_encryption_key"] = decode_32_byte_secret(
            "PINQEVA_FINDMY_SESSION_ENCRYPTION_KEY", secret
        )
    return result


def read_optional_secret(name: str) -> str:
    """Support mounted secrets without putting their contents in diagnostics."""
    value = os.getenv(name, "")
    path = os.getenv(name + "_FILE", "").strip()
    if value and path:
        raise ConfigurationError(f"Use only one of {name} and {name}_FILE")
    if path:
        try:
            if Path(path).stat().st_size > 4096:
                raise ValueError("oversized")
            value = Path(path).read_text(encoding="utf-8").rstrip("\r\n")
        except (OSError, UnicodeError, ValueError):
            raise ConfigurationError(f"{name}_FILE could not be read") from None
    if len(value) > 4096 or any(c in value for c in "\x00\r\n"):
        raise ConfigurationError(f"{name} has an invalid format")
    return value


def _auth_integer(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        raise ConfigurationError(f"{name} must be an integer") from None
    if not minimum <= value <= maximum:
        raise ConfigurationError(f"{name} must be between {minimum} and {maximum}")
    return value


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
        raise ConfigurationError(
            "PINQEVA_SESSION_TTL_SECONDS must be between 60 and 3600"
        )
    if not session_ttl <= claim_ttl <= 172800:
        raise ConfigurationError(
            "PINQEVA_CLAIM_TTL_SECONDS must be >= the session TTL and <= 172800"
        )

    try:
        notification_poll_interval = int(
            os.getenv("PINQEVA_NOTIFICATION_POLL_INTERVAL_SECONDS", "60")
        )
    except ValueError:
        raise ConfigurationError(
            "PINQEVA_NOTIFICATION_POLL_INTERVAL_SECONDS must be an integer"
        ) from None
    if not 15 <= notification_poll_interval <= 3600:
        raise ConfigurationError(
            "PINQEVA_NOTIFICATION_POLL_INTERVAL_SECONDS must be between 15 and 3600"
        )

    try:
        findmy_timeout = float(
            os.getenv("PINQEVA_FINDMY_REQUEST_TIMEOUT_SECONDS", "15")
        )
        findmy_lookback = int(os.getenv("PINQEVA_FINDMY_LOOKBACK_HOURS", "24"))
        location_sync_interval = int(
            os.getenv("PINQEVA_LOCATION_SYNC_INTERVAL_SECONDS", "900")
        )
        location_sync_batch_size = int(
            os.getenv("PINQEVA_LOCATION_SYNC_BATCH_SIZE", "8")
        )
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
    if not 60 <= location_sync_interval <= 86_400:
        raise ConfigurationError(
            "PINQEVA_LOCATION_SYNC_INTERVAL_SECONDS must be between 60 and 86400"
        )
    if not 1 <= location_sync_batch_size <= 64:
        raise ConfigurationError(
            "PINQEVA_LOCATION_SYNC_BATCH_SIZE must be between 1 and 64"
        )

    findmy_anisette_provider = parse_findmy_anisette_provider(
        os.getenv("PINQEVA_FINDMY_ANISETTE_PROVIDER", "http")
    )
    findmy_anisette_state_path = os.getenv(
        "PINQEVA_FINDMY_ANISETTE_STATE_PATH", ""
    ).strip()
    if findmy_anisette_provider == "native" and not findmy_anisette_state_path:
        raise ConfigurationError(
            "PINQEVA_FINDMY_ANISETTE_STATE_PATH is required for native Anisette"
        )
    findmy_anisette_url = validate_https_url(
        "PINQEVA_FINDMY_ANISETTE_URL",
        os.getenv("PINQEVA_FINDMY_ANISETTE_URL", "http://127.0.0.1:6969").strip(),
    )
    google_findhub_bridge_url = os.getenv(
        "PINQEVA_GOOGLE_FINDHUB_BRIDGE_URL", ""
    ).strip()
    google_findhub_bridge_token = os.getenv(
        "PINQEVA_GOOGLE_FINDHUB_BRIDGE_TOKEN", ""
    ).strip()
    if bool(google_findhub_bridge_url) != bool(google_findhub_bridge_token):
        raise ConfigurationError(
            "PINQEVA_GOOGLE_FINDHUB_BRIDGE_URL and "
            "PINQEVA_GOOGLE_FINDHUB_BRIDGE_TOKEN must be configured together"
        )
    if google_findhub_bridge_url:
        google_findhub_bridge_url = validate_https_url(
            "PINQEVA_GOOGLE_FINDHUB_BRIDGE_URL", google_findhub_bridge_url
        )
        if len(google_findhub_bridge_token) > 4096 or any(
            ord(character) < 0x21 for character in google_findhub_bridge_token
        ):
            raise ConfigurationError(
                "PINQEVA_GOOGLE_FINDHUB_BRIDGE_TOKEN has an invalid format"
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

    stripe_api_version = os.getenv("STRIPE_API_VERSION", "2025-08-27.basil").strip()
    if not STRIPE_API_VERSION_PATTERN.fullmatch(stripe_api_version):
        raise ConfigurationError("STRIPE_API_VERSION has an invalid format")

    portal_configuration = os.getenv("STRIPE_PORTAL_CONFIGURATION_ID", "").strip()
    if (
        portal_configuration
        and not _is_here_placeholder(portal_configuration)
        and not re.fullmatch(r"^bpc_[A-Za-z0-9]{8,}$", portal_configuration)
    ):
        raise ConfigurationError("STRIPE_PORTAL_CONFIGURATION_ID has an invalid format")

    findmy_apple_id = os.getenv("PINQEVA_FINDMY_APPLE_ID", "").strip()
    findmy_apple_password = read_optional_secret("PINQEVA_FINDMY_APPLE_PASSWORD")
    if findmy_apple_password and not findmy_apple_id:
        raise ConfigurationError(
            "PINQEVA_FINDMY_APPLE_ID is required when an Apple password is configured"
        )

    findmy_state_path = os.getenv(
        "PINQEVA_FINDMY_STATE_PATH", "state/apple-auth-state.json"
    ).strip()
    if not findmy_state_path:
        raise ConfigurationError(
            "PINQEVA_FINDMY_STATE_PATH must name a durable, private file"
        )
    if Path(findmy_state_path).absolute() in {
        Path(value).absolute()
        for value in (
            findmy_anisette_state_path,
            os.getenv("PINQEVA_FINDMY_AUTH_FILE", "").strip(),
        )
        if value
    }:
        raise ConfigurationError(
            "Find My session state must not overwrite the Anisette or legacy auth file"
        )
    retry_initial = _auth_integer("PINQEVA_FINDMY_RETRY_INITIAL_SECONDS", 60, 30, 3600)
    retry_max = _auth_integer(
        "PINQEVA_FINDMY_RETRY_MAX_SECONDS", 1800, retry_initial, 86400
    )
    sms_phone_id = _auth_integer("PINQEVA_FINDMY_SMS_PHONE_ID", 0, 0, 10000)
    report_api = os.getenv("PINQEVA_FINDMY_REPORT_API", "v2").strip().lower()
    if report_api not in {"v2", "legacy"}:
        raise ConfigurationError("PINQEVA_FINDMY_REPORT_API must be v2 or legacy")
    twilio_timeout = _auth_integer(
        "PINQEVA_FINDMY_TWILIO_TIMEOUT_SECONDS", 180, 30, 300
    )
    twilio_poll = _auth_integer("PINQEVA_FINDMY_TWILIO_POLL_SECONDS", 3, 1, 15)
    two_factor_provider = (
        os.getenv("PINQEVA_FINDMY_2FA_PROVIDER", "none").strip().lower()
    )
    if two_factor_provider not in {"none", "twilio"}:
        raise ConfigurationError("PINQEVA_FINDMY_2FA_PROVIDER must be none or twilio")
    second_factor = parse_findmy_second_factor(
        os.getenv("PINQEVA_FINDMY_SECOND_FACTOR", "sms")
    )
    twilio_sid = os.getenv("PINQEVA_FINDMY_TWILIO_ACCOUNT_SID", "").strip()
    twilio_token = read_optional_secret("PINQEVA_FINDMY_TWILIO_AUTH_TOKEN")
    twilio_number = os.getenv("PINQEVA_FINDMY_TWILIO_PHONE_NUMBER", "").strip()
    twilio_senders = tuple(
        s.strip()
        for s in os.getenv("PINQEVA_FINDMY_TWILIO_ALLOWED_SENDERS", "").split(",")
        if s.strip()
    )
    if two_factor_provider == "twilio":
        if not findmy_apple_id or not findmy_apple_password or second_factor != "sms":
            raise ConfigurationError(
                "Twilio 2FA requires Apple ID, password, and PINQEVA_FINDMY_SECOND_FACTOR=sms"
            )
        if not re.fullmatch(r"AC[0-9a-fA-F]{32}", twilio_sid) or not twilio_token:
            raise ConfigurationError("Configure the Twilio account SID and auth token")
        if not re.fullmatch(r"\+[1-9][0-9]{7,14}", twilio_number):
            raise ConfigurationError(
                "Configure the Twilio receiving number in E.164 format"
            )
        if not twilio_senders or any(
            not re.fullmatch(r"[+A-Za-z0-9][A-Za-z0-9+ _-]{0,31}", s)
            for s in twilio_senders
        ):
            raise ConfigurationError(
                "Configure exact Apple SMS senders in PINQEVA_FINDMY_TWILIO_ALLOWED_SENDERS"
            )

    firmware_image_path, firmware_version = parse_firmware_release(
        os.getenv("PINQEVA_FIRMWARE_IMAGE_PATH", ""),
        os.getenv("PINQEVA_FIRMWARE_VERSION", ""),
    )

    return Settings(
        **_distributed_settings(),
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
        firmware_signing_private_key=decode_optional_firmware_signing_private_key(
            "PINQEVA_FIRMWARE_SIGNING_PRIVATE_KEY",
            os.getenv("PINQEVA_FIRMWARE_SIGNING_PRIVATE_KEY"),
        ),
        findmy_auth_file=os.getenv("PINQEVA_FINDMY_AUTH_FILE", "").strip(),
        findmy_apple_id=findmy_apple_id,
        findmy_apple_password=findmy_apple_password,
        findmy_second_factor=second_factor,
        findmy_login_on_startup=parse_boolean(
            "PINQEVA_FINDMY_LOGIN_ON_STARTUP",
            os.getenv("PINQEVA_FINDMY_LOGIN_ON_STARTUP", "true"),
        ),
        findmy_dsid=os.getenv("PINQEVA_FINDMY_DSID", "").strip(),
        findmy_search_party_token=os.getenv(
            "PINQEVA_FINDMY_SEARCH_PARTY_TOKEN", ""
        ).strip(),
        findmy_anisette_provider=findmy_anisette_provider,
        findmy_anisette_state_path=findmy_anisette_state_path,
        findmy_anisette_url=findmy_anisette_url,
        findmy_request_timeout_seconds=findmy_timeout,
        findmy_lookback_hours=findmy_lookback,
        findmy_report_api=report_api,
        findmy_state_path=findmy_state_path,
        findmy_retry_initial_seconds=retry_initial,
        findmy_retry_max_seconds=retry_max,
        findmy_two_factor_provider=two_factor_provider,
        findmy_sms_phone_id=sms_phone_id,
        findmy_twilio_account_sid=twilio_sid,
        findmy_twilio_auth_token=twilio_token,
        findmy_twilio_phone_number=twilio_number,
        findmy_twilio_allowed_senders=twilio_senders,
        findmy_twilio_timeout_seconds=twilio_timeout,
        findmy_twilio_poll_seconds=twilio_poll,
        google_findhub_bridge_url=google_findhub_bridge_url,
        google_findhub_bridge_token=google_findhub_bridge_token,
        location_sync_worker_enabled=parse_boolean(
            "PINQEVA_LOCATION_SYNC_WORKER_ENABLED",
            os.getenv("PINQEVA_LOCATION_SYNC_WORKER_ENABLED", "true"),
        ),
        location_sync_interval_seconds=location_sync_interval,
        location_sync_batch_size=location_sync_batch_size,
        stripe_secret_key=validate_stripe_secret(
            "STRIPE_SECRET_KEY",
            _required("STRIPE_SECRET_KEY"),
            ("sk_test_", "sk_live_"),
        ),
        stripe_webhook_secret=validate_stripe_secret(
            "STRIPE_WEBHOOK_SECRET", _required("STRIPE_WEBHOOK_SECRET"), "whsec_"
        ),
        stripe_price_map=parse_stripe_price_map(_required("STRIPE_PRICE_MAP_JSON")),
        stripe_checkout_success_url=(
            "https://example.invalid/pinqeva/checkout-success"
            if _is_here_placeholder(_required("STRIPE_CHECKOUT_SUCCESS_URL"))
            else validate_https_url(
                "STRIPE_CHECKOUT_SUCCESS_URL",
                _required("STRIPE_CHECKOUT_SUCCESS_URL"),
            )
        ),
        stripe_checkout_cancel_url=(
            "https://example.invalid/pinqeva/checkout-cancel"
            if _is_here_placeholder(_required("STRIPE_CHECKOUT_CANCEL_URL"))
            else validate_https_url(
                "STRIPE_CHECKOUT_CANCEL_URL",
                _required("STRIPE_CHECKOUT_CANCEL_URL"),
            )
        ),
        stripe_portal_return_url=(
            "https://example.invalid/pinqeva/portal-return"
            if _is_here_placeholder(_required("STRIPE_PORTAL_RETURN_URL"))
            else validate_https_url(
                "STRIPE_PORTAL_RETURN_URL",
                _required("STRIPE_PORTAL_RETURN_URL"),
            )
        ),
        stripe_portal_configuration_id=(
            None
            if _is_here_placeholder(portal_configuration)
            else portal_configuration or None
        ),
        stripe_api_version=stripe_api_version,
        admin_owner_user_ids=parse_admin_owner_user_ids(
            os.getenv("PINQEVA_ADMIN_OWNER_USER_IDS", "")
        ),
        admin_allowed_origins=parse_allowed_origins(
            os.getenv("PINQEVA_ADMIN_ALLOWED_ORIGINS", "")
        ),
        admin_require_aal2=parse_boolean(
            "PINQEVA_ADMIN_REQUIRE_AAL2",
            os.getenv("PINQEVA_ADMIN_REQUIRE_AAL2", "true"),
        ),
        dev_bypass_bootstrap_auth=parse_boolean(
            "PINQEVA_DEV_BYPASS_BOOTSTRAP_AUTH",
            os.getenv("PINQEVA_DEV_BYPASS_BOOTSTRAP_AUTH", "false"),
        ),
        notification_worker_enabled=parse_boolean(
            "PINQEVA_NOTIFICATION_WORKER_ENABLED",
            os.getenv("PINQEVA_NOTIFICATION_WORKER_ENABLED", "true"),
        ),
        notification_poll_interval_seconds=notification_poll_interval,
        expo_push_access_token=os.getenv("EXPO_PUSH_ACCESS_TOKEN", "").strip(),
        firmware_image_path=firmware_image_path,
        firmware_version=firmware_version,
    )
