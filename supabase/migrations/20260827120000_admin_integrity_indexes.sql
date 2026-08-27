-- Index the bounded administrator queries and recurring integrity checks.
-- These are backend-only access paths; no Data API grants are added.

CREATE INDEX IF NOT EXISTS profiles_admin_created_at
  ON public.profiles (created_at DESC, id);

CREATE INDEX IF NOT EXISTS ownership_active_user_started
  ON public.ownership (user_id, started_at DESC, device_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS subscription_current_user_created
  ON public.subscription (user_id, created_at DESC, device_id)
  WHERE status NOT IN ('cancelled', 'ended');

CREATE INDEX IF NOT EXISTS device_admin_status
  ON public.device (status, id);

CREATE INDEX IF NOT EXISTS provisioning_request_claim_deadline
  ON public.provisioning_request (claim_deadline, id)
  WHERE status IN ('paid', 'claiming');

CREATE INDEX IF NOT EXISTS subscription_cancellation_failed
  ON public.subscription_cancellation_outbox (updated_at DESC, id)
  WHERE status = 'failed';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.provisioning_request TO pinqeva_backend';
  END IF;
END;
$$;

COMMENT ON INDEX public.ownership_active_user_started IS
  'Supports bounded administrator user/tracker projections and active-owner checks.';
COMMENT ON INDEX public.subscription_current_user_created IS
  'Supports bounded administrator subscription counts without cross-product aggregation.';
