-- Apply after the existing Supabase migrations, as the database administrator.
-- All location scheduling and request coordination lives in durable PostgreSQL.
BEGIN;

ALTER TABLE public.device_location_sync_state
  ADD COLUMN priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority IN (0, 10)),
  ADD COLUMN reason TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (reason IN ('scheduled', 'premium_request', 'retry')),
  ADD COLUMN requested_at TIMESTAMPTZ,
  ADD COLUMN last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN failed_at TIMESTAMPTZ;

DROP INDEX public.device_location_sync_state_due;
CREATE INDEX device_location_sync_state_due
  ON public.device_location_sync_state (priority DESC, next_attempt_at, device_id);
CREATE INDEX device_location_sync_state_expired_lease
  ON public.device_location_sync_state (lease_expires_at)
  WHERE lease_owner IS NOT NULL;

CREATE TABLE public.location_refresh_failure (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provisioning_session_id UUID NOT NULL
    REFERENCES public.provisioning_session(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  error_code VARCHAR(80) NOT NULL CHECK (error_code ~ '^[A-Z0-9_]+$'),
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX location_refresh_failure_retention
  ON public.location_refresh_failure (failed_at);

CREATE TABLE public.location_rate_limit (
  scope TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0)
);
CREATE INDEX location_rate_limit_retention
  ON public.location_rate_limit (window_started_at);

CREATE TABLE public.backend_schedule (
  name TEXT PRIMARY KEY,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Freshness measures a successful upstream check, including an empty response.
-- Existing rows remain NULL: their device timestamps cannot establish fetch age.
ALTER TABLE public.device
  ADD COLUMN last_location_fetched_at TIMESTAMPTZ,
  ADD COLUMN last_location_confidence SMALLINT CHECK (last_location_confidence BETWEEN 0 AND 255),
  ADD COLUMN last_location_status_code SMALLINT CHECK (last_location_status_code BETWEEN 0 AND 255);

CREATE OR REPLACE FUNCTION public.reset_device_location_binding()
RETURNS trigger AS $$
BEGIN
  IF old.provisioning_session_id IS DISTINCT FROM new.provisioning_session_id THEN
    DELETE FROM public.device_location_report WHERE device_id = new.id;
    DELETE FROM public.device_location_sync_state WHERE device_id = new.id;
    DELETE FROM public.location_refresh_failure WHERE device_id = new.id;
    new.last_latitude := NULL;
    new.last_longitude := NULL;
    new.last_location_at := NULL;
    new.last_location_fetched_at := NULL;
    new.last_location_confidence := NULL;
    new.last_location_status_code := NULL;
    new.last_place := NULL;
    new.last_location_finding_network := NULL;
    new.last_location_source_fingerprint := NULL;
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog;
REVOKE EXECUTE ON FUNCTION public.reset_device_location_binding()
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.location_refresh_failure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backend_schedule ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.location_refresh_failure,
  public.location_rate_limit, public.backend_schedule
  FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      public.device_location_sync_state, public.location_refresh_failure,
      public.location_rate_limit, public.backend_schedule TO pinqeva_backend;
    GRANT USAGE ON SEQUENCE public.location_refresh_failure_id_seq TO pinqeva_backend;
    GRANT SELECT, INSERT, UPDATE ON public.device_location_report TO pinqeva_backend;
  END IF;
END $$;

COMMENT ON TABLE public.device_location_sync_state IS
  'Durable per-device location schedule and priority queue; UUID leases fence refresh writes.';
COMMENT ON COLUMN public.device.last_location_fetched_at IS
  'Last successful provider check, separate from last_location_at device report time.';
COMMIT;
