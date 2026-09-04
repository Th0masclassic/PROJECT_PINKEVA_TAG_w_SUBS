-- Run once as the Supabase `postgres` administrator with psql.
-- Supply PINQEVA_BACKEND_ROLE_PASSWORD from the deployment secret manager so
-- the password is never committed or written into this SQL file:
--   psql "$ADMIN_DATABASE_URL" --file=backend/sql/create_runtime_role.sql

\set ON_ERROR_STOP on

\getenv pinqeva_backend_password PINQEVA_BACKEND_ROLE_PASSWORD
\if :{?pinqeva_backend_password}
\else
  \echo 'Missing required environment variable: PINQEVA_BACKEND_ROLE_PASSWORD'
  \quit
\endif

-- Intentionally fails if the role already exists. Rotate an existing password
-- with an explicit ALTER ROLE command rather than silently replacing access.
CREATE ROLE pinqeva_backend
  WITH LOGIN
  PASSWORD :'pinqeva_backend_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  BYPASSRLS;

GRANT CONNECT ON DATABASE postgres TO pinqeva_backend;
GRANT USAGE ON SCHEMA public TO pinqeva_backend;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM pinqeva_backend;

GRANT SELECT, INSERT, UPDATE ON TABLE public.device TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.device_bootstrap_credential
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.provisioning_request
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.provisioning_session TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ownership TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.device_release TO pinqeva_backend;
GRANT SELECT (id, display_name, email, stripe_customer_id, created_at, updated_at),
  UPDATE (stripe_customer_id)
  ON TABLE public.profiles TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.plan TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.plan_price_history
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.invoice TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_event TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.billing_checkout_session TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.subscription_cancellation_outbox TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.mobile_push_token TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.user_notification TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_role_assignment
  TO pinqeva_backend;
GRANT SELECT, INSERT ON TABLE public.admin_audit_log TO pinqeva_backend;

REVOKE DELETE ON TABLE
  public.admin_role_assignment,
  public.admin_audit_log
FROM pinqeva_backend;

ALTER ROLE pinqeva_backend SET search_path = public, pg_catalog;
ALTER ROLE pinqeva_backend SET statement_timeout = '15s';
ALTER ROLE pinqeva_backend SET idle_in_transaction_session_timeout = '30s';

COMMENT ON ROLE pinqeva_backend IS
  'Least-privilege runtime login for the Pinqeva provisioning API; secret outside Git';

-- Schema migrations also grant these privileges when the role already exists.
-- Role creation after the distributed upgrade must not erase those grants.
DO $$
BEGIN
  IF to_regclass('public.upstream_apple_session') IS NOT NULL THEN
    GRANT SELECT ON public.upstream_apple_session TO pinqeva_backend;
  END IF;
  IF to_regclass('public.upstream_apple_session_status') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE ON public.upstream_apple_session_status TO pinqeva_backend;
    REVOKE DELETE ON public.upstream_apple_session_status FROM pinqeva_backend;
  END IF;
  IF to_regclass('public.location_refresh_failure') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.device_location_report, public.device_location_sync_state,
      public.device_safe_zone, public.device_protection_profile,
      public.device_recovery_share, public.device_primary_companion,
      public.device_companion_observation, public.device_separation_state,
      public.device_replacement_claim, public.location_refresh_failure,
      public.location_rate_limit, public.backend_schedule TO pinqeva_backend;
    GRANT USAGE ON SEQUENCE public.location_refresh_failure_id_seq TO pinqeva_backend;
    GRANT SELECT (account_status, banned_at, banned_by, ban_reason)
      ON public.profiles TO pinqeva_backend;
  END IF;
END $$;
