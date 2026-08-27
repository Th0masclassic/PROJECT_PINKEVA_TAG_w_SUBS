import pytest

from app.config import (
    ConfigurationError,
    parse_admin_owner_user_ids,
    parse_findmy_anisette_provider,
    parse_firmware_release,
    parse_stripe_price_map,
    parse_findmy_second_factor,
    validate_database_url,
    validate_https_url,
    validate_stripe_secret,
)


def test_admin_owner_rejects_example_uuid() -> None:
    with pytest.raises(ConfigurationError):
        parse_admin_owner_user_ids("00000000-0000-4000-8000-000000000000")


def test_admin_owner_accepts_real_uuid() -> None:
    value = "32c55047-60d0-46c5-8b05-a6f2fee9dde7"
    assert {str(owner) for owner in parse_admin_owner_user_ids(value)} == {value}


def test_firmware_release_requires_path_and_exact_version_together() -> None:
    assert parse_firmware_release(" /srv/pinkeva.bin ", " 0.3.1 ") == (
        "/srv/pinkeva.bin",
        "0.3.1",
    )
    with pytest.raises(ConfigurationError):
        parse_firmware_release("/srv/pinkeva.bin", "")
    with pytest.raises(ConfigurationError):
        parse_firmware_release("/srv/pinkeva.bin", "0.3")
    with pytest.raises(ConfigurationError):
        parse_firmware_release("/srv/pinkeva.bin", "0.3.256")


def test_remote_database_requires_tls() -> None:
    with pytest.raises(ConfigurationError):
        validate_database_url("postgresql://user:secret@db.example.com/postgres")


def test_remote_database_accepts_required_tls() -> None:
    value = "postgresql://user:secret@db.example.com/postgres?sslmode=require"
    assert validate_database_url(value) == value


@pytest.mark.parametrize(
    "value",
    [
        "postgresql://user:secret@db.example.com/postgres?sslmode=require&sslmode=disable",
        "postgresql://user:secret@db.example.com/postgres?sslmode=disable&sslmode=require",
        "postgresql://user:secret@db.example.com/postgres?sslmode=require&sslmode=require",
    ],
)
def test_remote_database_rejects_duplicate_sslmode(value: str) -> None:
    with pytest.raises(ConfigurationError):
        validate_database_url(value)


def test_local_database_can_use_plain_connection() -> None:
    value = "postgresql://postgres:secret@127.0.0.1:54322/postgres"
    assert validate_database_url(value) == value


def test_remote_supabase_endpoint_requires_https() -> None:
    with pytest.raises(ConfigurationError):
        validate_https_url("SUPABASE_URL", "http://project.supabase.co")


def test_local_supabase_endpoint_can_use_http() -> None:
    assert (
        validate_https_url("SUPABASE_URL", "http://127.0.0.1:54321/")
        == "http://127.0.0.1:54321"
    )


def test_stripe_price_map_is_unambiguous() -> None:
    with pytest.raises(ConfigurationError):
        parse_stripe_price_map(
            '{"monthly_basic":{"price_id":"price_SAME12345678",'
            '"product_id":"prod_MONTH1234567"},'
            '"yearly_pro":{"price_id":"price_SAME12345678",'
            '"product_id":"prod_YEAR12345678"}}'
        )


def test_stripe_price_map_accepts_server_plan_mapping() -> None:
    assert parse_stripe_price_map(
        '{"yearly_pro":{"price_id":"price_YEAR12345678",'
        '"product_id":"prod_YEAR12345678"},'
        '"monthly_basic":{"price_id":"price_MONTH1234567",'
        '"product_id":"prod_MONTH1234567"}}'
    ) == (
        ("monthly_basic", "price_MONTH1234567", "prod_MONTH1234567"),
        ("yearly_pro", "price_YEAR12345678", "prod_YEAR12345678"),
    )


def test_explicit_stripe_placeholders_boot_without_enabling_billing() -> None:
    assert parse_stripe_price_map("HERE_STRIPE_PRICE_MAP_JSON") == ()
    assert (
        validate_stripe_secret("STRIPE_SECRET_KEY", "HERE_STRIPE_SECRET_KEY", "sk_test_")
        == "HERE_STRIPE_SECRET_KEY"
    )


@pytest.mark.parametrize("value", ["sms", "trusted_device", " TRUSTED_DEVICE "])
def test_findmy_second_factor_accepts_supported_modes(value: str) -> None:
    assert parse_findmy_second_factor(value) in {"sms", "trusted_device"}


def test_findmy_second_factor_rejects_unknown_modes() -> None:
    with pytest.raises(ConfigurationError):
        parse_findmy_second_factor("email")


@pytest.mark.parametrize("value", ["http", "native", " NATIVE "])
def test_findmy_anisette_provider_accepts_supported_modes(value: str) -> None:
    assert parse_findmy_anisette_provider(value) in {"http", "native"}


def test_findmy_anisette_provider_rejects_unknown_modes() -> None:
    with pytest.raises(ConfigurationError):
        parse_findmy_anisette_provider("docker")
