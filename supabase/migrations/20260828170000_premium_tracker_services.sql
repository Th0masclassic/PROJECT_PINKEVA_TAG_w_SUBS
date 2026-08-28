-- Subscription access now protects cloud services, not the tag's BLE radio.
-- A provisioned tag keeps advertising its public Finder key even when a paid
-- period ends. Premium state, location retention, alerts, recovery sharing,
-- lost mode, and vehicle protection are enforced by the backend database.

DROP TRIGGER IF EXISTS subscription_queue_device_entitlement_sync
  ON public.subscription;
DROP FUNCTION IF EXISTS public.queue_device_entitlement_sync();

UPDATE public.user_notification
   SET push_status = 'skipped',
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = now()
 WHERE kind = 'tag_sync_required'
   AND push_status IN ('pending', 'retry', 'processing');

UPDATE public.device device
   SET status = 'claimed', updated_at = now()
 WHERE device.status = 'suspended'
   AND EXISTS (
     SELECT 1 FROM public.ownership ownership
      WHERE ownership.device_id = device.id
        AND ownership.ended_at IS NULL
   )
   AND EXISTS (
     SELECT 1 FROM public.provisioning_session session
      WHERE session.id = device.provisioning_session_id
        AND session.status = 'claimed'
   );

CREATE TABLE public.device_location_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE CASCADE,
  provisioning_session_id UUID NOT NULL
    REFERENCES public.provisioning_session(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  confidence SMALLINT CHECK (confidence BETWEEN 0 AND 255),
  status_code SMALLINT CHECK (status_code BETWEEN 0 AND 255),
  place VARCHAR(160) NOT NULL CHECK (
    length(BTRIM(place)) BETWEEN 1 AND 160 AND place !~ '[[:cntrl:]]'
  ),
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_location_report_source_unique UNIQUE (
    device_id, provisioning_session_id, recorded_at
  )
);

CREATE INDEX device_location_report_owner_history
  ON public.device_location_report (user_id, device_id, recorded_at DESC, id DESC);
CREATE INDEX device_location_report_retention
  ON public.device_location_report (recorded_at);

CREATE TABLE public.device_safe_zone (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL CHECK (
    length(BTRIM(name)) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]'
  ),
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_meters INTEGER NOT NULL CHECK (radius_meters BETWEEN 100 AND 100000),
  notify_on_enter BOOLEAN NOT NULL DEFAULT true,
  notify_on_exit BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_inside BOOLEAN,
  last_evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_safe_zone_owner_device_unique UNIQUE (id, user_id, device_id)
);

CREATE INDEX device_safe_zone_enabled_device
  ON public.device_safe_zone (user_id, device_id, created_at)
  WHERE enabled = true;

CREATE TRIGGER device_safe_zone_set_updated_at
  BEFORE UPDATE ON public.device_safe_zone
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.device_protection_profile (
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  lost_mode BOOLEAN NOT NULL DEFAULT false,
  lost_since TIMESTAMPTZ,
  recovery_message VARCHAR(240) CHECK (
    recovery_message IS NULL OR (
      length(BTRIM(recovery_message)) BETWEEN 1 AND 240
      AND recovery_message !~ '[[:cntrl:]]'
    )
  ),
  vehicle_mode BOOLEAN NOT NULL DEFAULT false,
  movement_alerts BOOLEAN NOT NULL DEFAULT false,
  movement_threshold_meters INTEGER NOT NULL DEFAULT 500
    CHECK (movement_threshold_meters BETWEEN 100 AND 10000),
  movement_anchor_latitude DOUBLE PRECISION CHECK (
    movement_anchor_latitude IS NULL
    OR movement_anchor_latitude BETWEEN -90 AND 90
  ),
  movement_anchor_longitude DOUBLE PRECISION CHECK (
    movement_anchor_longitude IS NULL
    OR movement_anchor_longitude BETWEEN -180 AND 180
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_protection_profile_primary
    PRIMARY KEY (user_id, device_id),
  CONSTRAINT device_protection_lost_state CHECK (
    (lost_mode AND lost_since IS NOT NULL)
    OR (NOT lost_mode AND lost_since IS NULL)
  ),
  CONSTRAINT device_protection_anchor_pair CHECK (
    (movement_anchor_latitude IS NULL AND movement_anchor_longitude IS NULL)
    OR (movement_anchor_latitude IS NOT NULL
        AND movement_anchor_longitude IS NOT NULL)
  )
);

CREATE INDEX device_protection_profile_device
  ON public.device_protection_profile (device_id);

CREATE TRIGGER device_protection_profile_set_updated_at
  BEFORE UPDATE ON public.device_protection_profile
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.device_recovery_share (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE CASCADE,
  token_sha256 BYTEA NOT NULL UNIQUE CHECK (octet_length(token_sha256) = 32),
  label VARCHAR(80) NOT NULL CHECK (
    length(BTRIM(label)) BETWEEN 1 AND 80 AND label !~ '[[:cntrl:]]'
  ),
  access_level VARCHAR(16) NOT NULL CHECK (
    access_level IN ('latest', 'history')
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_recovery_share_expiry CHECK (expires_at > created_at),
  CONSTRAINT device_recovery_share_owner_device_unique UNIQUE (
    id, user_id, device_id
  )
);

CREATE INDEX device_recovery_share_active_device
  ON public.device_recovery_share (user_id, device_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TRIGGER device_recovery_share_set_updated_at
  BEFORE UPDATE ON public.device_recovery_share
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.user_notification
  ADD COLUMN event_key VARCHAR(128);

ALTER TABLE public.user_notification
  DROP CONSTRAINT user_notification_kind_check,
  DROP CONSTRAINT user_notification_message_shape,
  ADD CONSTRAINT user_notification_kind_check CHECK (
    kind IN (
      'renewal_7_days',
      'renewal_1_day',
      'expired',
      'tag_sync_required',
      'admin_message',
      'safe_zone_enter',
      'safe_zone_exit',
      'lost_mode_location',
      'movement_detected'
    )
  ),
  ADD CONSTRAINT user_notification_message_shape CHECK (
    (kind = 'admin_message'
      AND device_id IS NULL
      AND subscription_id IS NULL
      AND period_end IS NULL
      AND admin_created_by IS NOT NULL
      AND title IS NOT NULL AND BTRIM(title) <> ''
      AND body IS NOT NULL AND BTRIM(body) <> ''
      AND event_key IS NULL)
    OR (kind IN (
          'renewal_7_days', 'renewal_1_day', 'expired', 'tag_sync_required'
        )
      AND device_id IS NOT NULL
      AND subscription_id IS NOT NULL
      AND period_end IS NOT NULL
      AND admin_created_by IS NULL
      AND title IS NULL
      AND body IS NULL
      AND event_key IS NULL)
    OR (kind IN (
          'safe_zone_enter', 'safe_zone_exit',
          'lost_mode_location', 'movement_detected'
        )
      AND device_id IS NOT NULL
      AND subscription_id IS NOT NULL
      AND period_end IS NULL
      AND admin_created_by IS NULL
      AND title IS NOT NULL AND BTRIM(title) <> ''
      AND body IS NOT NULL AND BTRIM(body) <> ''
      AND event_key IS NOT NULL AND BTRIM(event_key) <> '')
  );

CREATE UNIQUE INDEX user_notification_premium_event_unique
  ON public.user_notification (user_id, kind, event_key)
  WHERE event_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.pinkeva_distance_meters(
  latitude_a DOUBLE PRECISION,
  longitude_a DOUBLE PRECISION,
  latitude_b DOUBLE PRECISION,
  longitude_b DOUBLE PRECISION
)
RETURNS DOUBLE PRECISION AS $$
  SELECT 2.0 * 6371000.0 * asin(
    LEAST(
      1.0,
      sqrt(
        power(sin(radians(latitude_b - latitude_a) / 2.0), 2)
        + cos(radians(latitude_a)) * cos(radians(latitude_b))
          * power(sin(radians(longitude_b - longitude_a) / 2.0), 2)
      )
    )
  );
$$ LANGUAGE sql IMMUTABLE STRICT
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.process_premium_location_report()
RETURNS trigger AS $$
DECLARE
  active_subscription_id UUID;
  tracker_name TEXT;
  zone RECORD;
  is_inside BOOLEAN;
  profile RECORD;
  has_profile BOOLEAN := false;
  moved_meters DOUBLE PRECISION;
BEGIN
  -- The insert itself is ownership/session-bound by the backend. Recheck the
  -- active paid period before creating any premium alert.
  SELECT subscription.id
    INTO active_subscription_id
    FROM public.subscription subscription
   WHERE subscription.user_id = new.user_id
     AND subscription.device_id = new.device_id
     AND subscription.status IN ('active', 'trialing')
     AND subscription.starts_at <= now()
     AND subscription.current_period_end > now()
   ORDER BY subscription.current_period_end DESC,
            subscription.created_at DESC
   LIMIT 1;

  DELETE FROM public.device_location_report
   WHERE device_id = new.device_id
     AND id <> new.id
     AND recorded_at < now() - interval '30 days';

  IF active_subscription_id IS NULL THEN
    RETURN new;
  END IF;

  SELECT COALESCE(NULLIF(BTRIM(device.name), ''), device.serial_number)
    INTO tracker_name
    FROM public.device device
   WHERE device.id = new.device_id;

  FOR zone IN
    SELECT *
      FROM public.device_safe_zone safe_zone
     WHERE safe_zone.user_id = new.user_id
       AND safe_zone.device_id = new.device_id
       AND safe_zone.enabled = true
     FOR UPDATE
  LOOP
    is_inside := public.pinkeva_distance_meters(
      zone.latitude, zone.longitude, new.latitude, new.longitude
    ) <= zone.radius_meters;

    IF zone.last_inside IS NOT NULL AND zone.last_inside <> is_inside THEN
      IF (is_inside AND zone.notify_on_enter)
         OR (NOT is_inside AND zone.notify_on_exit) THEN
        INSERT INTO public.user_notification (
          user_id, device_id, subscription_id, kind, period_end,
          due_at, title, body, event_key
        ) VALUES (
          new.user_id,
          new.device_id,
          active_subscription_id,
          CASE WHEN is_inside THEN 'safe_zone_enter'
               ELSE 'safe_zone_exit' END,
          NULL,
          now(),
          LEFT(CASE WHEN is_inside THEN 'Arrived at ' ELSE 'Left ' END
               || zone.name, 120),
          LEFT(tracker_name || CASE WHEN is_inside THEN ' entered '
               ELSE ' left ' END || zone.name || '.', 320),
          new.id::text || ':' || zone.id::text
        )
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;

    UPDATE public.device_safe_zone
       SET last_inside = is_inside,
           last_evaluated_at = new.recorded_at,
           updated_at = now()
     WHERE id = zone.id;
  END LOOP;

  SELECT *
    INTO profile
    FROM public.device_protection_profile protection
   WHERE protection.user_id = new.user_id
     AND protection.device_id = new.device_id
   FOR UPDATE;
  has_profile := FOUND;

  IF has_profile AND profile.lost_mode THEN
    INSERT INTO public.user_notification (
      user_id, device_id, subscription_id, kind, period_end,
      due_at, title, body, event_key
    ) VALUES (
      new.user_id, new.device_id, active_subscription_id,
      'lost_mode_location', NULL, now(),
      'Lost tracker location updated',
      LEFT(tracker_name || ' has a new recovery location.', 320),
      new.id::text || ':lost'
    )
    ON CONFLICT DO NOTHING;
  END IF;

  IF has_profile AND profile.movement_alerts THEN
    IF profile.movement_anchor_latitude IS NULL THEN
      UPDATE public.device_protection_profile
         SET movement_anchor_latitude = new.latitude,
             movement_anchor_longitude = new.longitude,
             updated_at = now()
       WHERE user_id = new.user_id AND device_id = new.device_id;
    ELSE
      moved_meters := public.pinkeva_distance_meters(
        profile.movement_anchor_latitude,
        profile.movement_anchor_longitude,
        new.latitude,
        new.longitude
      );
      IF moved_meters >= profile.movement_threshold_meters THEN
        INSERT INTO public.user_notification (
          user_id, device_id, subscription_id, kind, period_end,
          due_at, title, body, event_key
        ) VALUES (
          new.user_id, new.device_id, active_subscription_id,
          'movement_detected', NULL, now(),
          CASE WHEN profile.vehicle_mode THEN 'Vehicle movement detected'
               ELSE 'Tracker movement detected' END,
          LEFT(tracker_name || ' moved about '
               || round(moved_meters)::text || ' metres.', 320),
          new.id::text || ':movement'
        )
        ON CONFLICT DO NOTHING;

        UPDATE public.device_protection_profile
           SET movement_anchor_latitude = new.latitude,
               movement_anchor_longitude = new.longitude,
               updated_at = now()
         WHERE user_id = new.user_id AND device_id = new.device_id;
      END IF;
    END IF;
  END IF;

  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.pinkeva_distance_meters(
  DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_premium_location_report()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER device_location_report_process_premium
  AFTER INSERT ON public.device_location_report
  FOR EACH ROW EXECUTE FUNCTION public.process_premium_location_report();

ALTER TABLE public.device_location_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_safe_zone ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_protection_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_recovery_share ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.device_location_report,
  public.device_safe_zone,
  public.device_protection_profile,
  public.device_recovery_share
FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE '
      || 'public.device_location_report, public.device_safe_zone, '
      || 'public.device_protection_profile, public.device_recovery_share '
      || 'TO pinqeva_backend';
  END IF;
END;
$$;

COMMENT ON TABLE public.device_location_report IS
  'Backend-only 30-day premium location history, bound to owner and provisioning session.';
COMMENT ON TABLE public.device_safe_zone IS
  'Premium geofence definitions evaluated whenever a new Finder report is accepted.';
COMMENT ON TABLE public.device_protection_profile IS
  'Premium lost mode, recovery message, and movement/vehicle alert settings.';
COMMENT ON TABLE public.device_recovery_share IS
  'Hashed, expiring, revocable recovery links; plaintext tokens are returned only once.';
COMMENT ON COLUMN public.user_notification.event_key IS
  'Idempotency key for one premium tracker event; null for billing and admin notifications.';
