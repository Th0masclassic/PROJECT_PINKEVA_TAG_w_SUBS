-- Apply as the Supabase `postgres` administrator after the admin/maps migration.
-- This augments the existing least-privilege runtime role without exposing any
-- admin table through the Supabase Data API.

\set ON_ERROR_STOP on

GRANT SELECT (id, display_name, email, stripe_customer_id, created_at, updated_at,
  account_status, banned_at, banned_by, ban_reason)
  ON TABLE public.profiles TO pinqeva_backend;
GRANT UPDATE (account_status, banned_at, banned_by, ban_reason)
  ON TABLE public.profiles TO pinqeva_backend;

GRANT SELECT, INSERT, UPDATE ON TABLE public.plan TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.plan_price_history
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.provisioning_request
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.device TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.device_bootstrap_credential
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription TO pinqeva_backend;
GRANT SELECT ON TABLE public.ownership TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription_cancellation_outbox
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.device_entitlement_sync
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mobile_push_token
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_notification
  TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_role_assignment
  TO pinqeva_backend;
GRANT SELECT, INSERT ON TABLE public.admin_audit_log TO pinqeva_backend;

REVOKE DELETE ON TABLE
  public.admin_role_assignment,
  public.admin_audit_log
FROM pinqeva_backend;
