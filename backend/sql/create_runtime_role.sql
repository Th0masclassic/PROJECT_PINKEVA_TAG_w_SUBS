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

GRANT SELECT, UPDATE ON TABLE public.device TO pinqeva_backend;
GRANT SELECT ON TABLE public.device_bootstrap_credential TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.provisioning_session TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ownership TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.device_release TO pinqeva_backend;
GRANT SELECT (id, stripe_customer_id), UPDATE (stripe_customer_id)
  ON TABLE public.profiles TO pinqeva_backend;
GRANT SELECT ON TABLE public.plan TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.invoice TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_event TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.billing_checkout_session TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.subscription_cancellation_outbox TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.device_entitlement_sync TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.mobile_push_token TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.user_notification TO pinqeva_backend;

ALTER ROLE pinqeva_backend SET search_path = public, pg_catalog;
ALTER ROLE pinqeva_backend SET statement_timeout = '15s';
ALTER ROLE pinqeva_backend SET idle_in_transaction_session_timeout = '30s';

COMMENT ON ROLE pinqeva_backend IS
  'Least-privilege runtime login for the Pinqeva provisioning API; secret outside Git';
