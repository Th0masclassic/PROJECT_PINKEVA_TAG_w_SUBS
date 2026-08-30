-- Keep PINQEVA's premium location history independently of either finding
-- network's short and undocumented report window. Every report is tied to its
-- provider and to the provisioning session active on the physical tag.

ALTER TABLE public.device_location_report
  ADD COLUMN finding_network TEXT,
  ADD COLUMN source_fingerprint BYTEA;

UPDATE public.device_location_report report
   SET finding_network = COALESCE(session.finding_network, 'apple'),
       -- Existing rows were already unique by session and timestamp. Give each
       -- one a stable 32-byte migration fingerprint without depending on an
       -- optional database extension; new rows use SHA-256 in the backend.
       source_fingerprint = decode(
         md5(report.id::text) || md5('pinqeva-location:' || report.id::text),
         'hex'
       )
  FROM public.provisioning_session session
 WHERE session.id = report.provisioning_session_id;

UPDATE public.device_location_report report
   SET finding_network = COALESCE(report.finding_network, 'apple'),
       source_fingerprint = COALESCE(
         report.source_fingerprint,
         decode(
           md5(report.id::text) || md5('pinqeva-location:' || report.id::text),
           'hex'
         )
       );

ALTER TABLE public.device_location_report
  ALTER COLUMN finding_network SET NOT NULL,
  ALTER COLUMN source_fingerprint SET NOT NULL,
  ADD CONSTRAINT device_location_report_finding_network_valid
    CHECK (finding_network IN ('apple', 'google')),
  ADD CONSTRAINT device_location_report_source_fingerprint_size
    CHECK (octet_length(source_fingerprint) = 32),
  DROP CONSTRAINT device_location_report_source_unique,
  ADD CONSTRAINT device_location_report_source_unique UNIQUE (
    device_id, provisioning_session_id, finding_network, source_fingerprint
  );

CREATE INDEX device_location_report_active_provider_history
  ON public.device_location_report (
    device_id, provisioning_session_id, finding_network,
    recorded_at DESC, received_at DESC, id DESC
  );

-- One row per currently eligible tracker lets multiple backend replicas poll
-- safely. Expiring leases recover work if a process dies mid-provider call.
CREATE TABLE public.device_location_sync_state (
  device_id UUID PRIMARY KEY REFERENCES public.device(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provisioning_session_id UUID NOT NULL
    REFERENCES public.provisioning_session(id) ON DELETE CASCADE,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_provider_report_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures BETWEEN 0 AND 1000000),
  last_error_code VARCHAR(80) CHECK (
    last_error_code IS NULL OR (
      length(BTRIM(last_error_code)) BETWEEN 1 AND 80
      AND last_error_code ~ '^[A-Z0-9_]+$'
    )
  ),
  lease_owner UUID,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_location_sync_state_session_unique
    UNIQUE (provisioning_session_id),
  CONSTRAINT device_location_sync_state_lease_complete CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX device_location_sync_state_due
  ON public.device_location_sync_state (next_attempt_at, device_id)
  WHERE lease_owner IS NULL;

ALTER TABLE public.device_location_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.device_location_sync_state
  FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE '
      || 'public.device_location_sync_state TO pinqeva_backend';
  END IF;
END;
$$;

-- Track enough provenance on the latest projection to make provider changes
-- deterministic. The raw fingerprint remains backend/admin diagnostics only.
ALTER TABLE public.device
  ADD COLUMN last_location_finding_network TEXT,
  ADD COLUMN last_location_source_fingerprint BYTEA;

ALTER TABLE public.device
  ADD CONSTRAINT device_last_location_finding_network_valid CHECK (
    last_location_finding_network IS NULL
    OR last_location_finding_network IN ('apple', 'google', 'admin')
  ),
  ADD CONSTRAINT device_last_location_source_fingerprint_size CHECK (
    last_location_source_fingerprint IS NULL
    OR octet_length(last_location_source_fingerprint) = 32
  );

UPDATE public.device device
   SET last_location_finding_network = device.finding_network
 WHERE device.last_location_at IS NOT NULL
   AND device.finding_network IS NOT NULL;

-- Releasing or reprovisioning a tag must never expose the previous owner's
-- projection or let a report from the previous ecosystem win later.
CREATE OR REPLACE FUNCTION public.reset_device_location_binding()
RETURNS trigger AS $$
BEGIN
  IF old.provisioning_session_id IS DISTINCT FROM new.provisioning_session_id THEN
    DELETE FROM public.device_location_report
     WHERE device_id = new.id;
    DELETE FROM public.device_location_sync_state
     WHERE device_id = new.id;

    new.last_latitude := NULL;
    new.last_longitude := NULL;
    new.last_location_at := NULL;
    new.last_place := NULL;
    new.last_location_finding_network := NULL;
    new.last_location_source_fingerprint := NULL;
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.reset_device_location_binding()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER device_reset_location_binding
  BEFORE UPDATE OF provisioning_session_id ON public.device
  FOR EACH ROW EXECUTE FUNCTION public.reset_device_location_binding();

-- Remove any development data already detached from its owner/session and
-- clear detached projections before this privacy invariant becomes active.
DELETE FROM public.device_location_report report
 WHERE NOT EXISTS (
   SELECT 1
     FROM public.device device
     JOIN public.ownership ownership
       ON ownership.device_id = device.id
      AND ownership.user_id = report.user_id
      AND ownership.ended_at IS NULL
    WHERE device.id = report.device_id
      AND device.provisioning_session_id = report.provisioning_session_id
 );

UPDATE public.device device
   SET last_latitude = NULL,
       last_longitude = NULL,
       last_location_at = NULL,
       last_place = NULL,
       last_location_finding_network = NULL,
       last_location_source_fingerprint = NULL,
       updated_at = now()
 WHERE device.provisioning_session_id IS NULL
    OR device.finding_network IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.ownership ownership
       WHERE ownership.device_id = device.id
         AND ownership.ended_at IS NULL
    );

COMMENT ON COLUMN public.device_location_report.finding_network IS
  'Finding network that produced this report; both providers may report for one bound session.';
COMMENT ON COLUMN public.device_location_report.source_fingerprint IS
  'Backend-computed SHA-256 identity used to deduplicate overlapping provider fetches.';
COMMENT ON TABLE public.device_location_sync_state IS
  'Backend-only leased schedule for collecting every configured provider for active premium tags.';
COMMENT ON FUNCTION public.reset_device_location_binding() IS
  'Deletes history and clears the latest projection whenever a physical tag changes provisioning session.';
