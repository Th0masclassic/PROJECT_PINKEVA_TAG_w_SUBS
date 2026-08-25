import pytest

from app.config import (
    ConfigurationError,
    parse_stripe_price_map,
    validate_database_url,
    validate_https_url,
    validate_stripe_secret,
)


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
