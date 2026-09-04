-- Run after all existing Supabase and backend/sql/migrations migrations.
-- This also restores grants if create_runtime_role.sql ran after migrations.
\set ON_ERROR_STOP on

GRANT SELECT (account_status, banned_at, banned_by, ban_reason)
  ON TABLE public.profiles TO pinqeva_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.device_location_report,
  public.device_location_sync_state,
  public.device_safe_zone,
  public.device_protection_profile,
  public.device_recovery_share,
  public.device_primary_companion,
  public.device_companion_observation,
  public.device_separation_state,
  public.device_replacement_claim,
  public.location_refresh_failure,
  public.location_rate_limit,
  public.backend_schedule
TO pinqeva_backend;
GRANT USAGE ON SEQUENCE public.location_refresh_failure_id_seq TO pinqeva_backend;
GRANT SELECT ON TABLE public.upstream_apple_session TO pinqeva_backend;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.upstream_apple_session FROM pinqeva_backend;
GRANT SELECT, INSERT, UPDATE ON TABLE public.upstream_apple_session_status TO pinqeva_backend;
REVOKE DELETE ON TABLE public.upstream_apple_session_status FROM pinqeva_backend;
