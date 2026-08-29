-- Phone-aware separation protection and reviewed replacement benefits.
-- Finder-network identities remain independent of subscriptions and are never
-- rewritten when premium access starts or expires.

DROP TRIGGER IF EXISTS device_location_report_process_premium
  ON public.device_location_report;
DROP FUNCTION IF EXISTS public.process_premium_location_report();

DELETE FROM public.user_notification
 WHERE kind IN ('safe_zone_enter', 'safe_zone_exit', 'lost_mode_location');

ALTER TABLE public.device_safe_zone
  DROP CONSTRAINT IF EXISTS device_safe_zone_radius_meters_check;
ALTER TABLE public.device_safe_zone
  RENAME COLUMN last_inside TO last_tracker_inside;
ALTER TABLE public.device_safe_zone
  DROP COLUMN notify_on_enter,
  DROP COLUMN notify_on_exit,
  ADD CONSTRAINT device_safe_zone_radius_meters_check
    CHECK (radius_meters BETWEEN 50 AND 100000);

ALTER TABLE public.device_protection_profile
  DROP CONSTRAINT IF EXISTS device_protection_lost_state,
  DROP COLUMN lost_mode,
  DROP COLUMN lost_since,
  DROP COLUMN recovery_message,
  ADD COLUMN separation_alerts BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN separation_threshold_meters INTEGER NOT NULL DEFAULT 500
    CHECK (separation_threshold_meters BETWEEN 100 AND 5000);

CREATE TABLE public.device_primary_companion (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL,
  platform VARCHAR(16) NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id),
  CONSTRAINT device_primary_companion_identity_unique
    UNIQUE (user_id, device_id, installation_id)
);

CREATE INDEX device_primary_companion_device
  ON public.device_primary_companion (device_id);

CREATE TRIGGER device_primary_companion_set_updated_at
  BEFORE UPDATE ON public.device_primary_companion
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.device_companion_observation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  device_id UUID NOT NULL,
  installation_id UUID NOT NULL,
  platform VARCHAR(16) NOT NULL CHECK (platform IN ('ios', 'android')),
  phone_latitude DOUBLE PRECISION NOT NULL
    CHECK (phone_latitude BETWEEN -90 AND 90),
  phone_longitude DOUBLE PRECISION NOT NULL
    CHECK (phone_longitude BETWEEN -180 AND 180),
  phone_accuracy_meters DOUBLE PRECISION NOT NULL
    CHECK (phone_accuracy_meters BETWEEN 1 AND 1000),
  sampled_at TIMESTAMPTZ NOT NULL,
  tag_proximity VARCHAR(16) NOT NULL
    CHECK (tag_proximity IN ('nearby', 'not_seen', 'unknown')),
  tag_observed_at TIMESTAMPTZ,
  tag_rssi_dbm SMALLINT CHECK (tag_rssi_dbm BETWEEN -127 AND 20),
  scan_duration_seconds SMALLINT
    CHECK (scan_duration_seconds BETWEEN 5 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_companion_observation_primary_fk
    FOREIGN KEY (user_id, device_id, installation_id)
    REFERENCES public.device_primary_companion (
      user_id, device_id, installation_id
    ) ON DELETE CASCADE,
  CONSTRAINT device_companion_observation_unique
    UNIQUE (user_id, device_id, installation_id, sampled_at),
  CONSTRAINT device_companion_observation_evidence CHECK (
    (tag_proximity = 'nearby' AND tag_observed_at IS NOT NULL)
    OR (tag_proximity <> 'nearby'
        AND tag_observed_at IS NULL AND tag_rssi_dbm IS NULL)
  ),
  CONSTRAINT device_companion_observation_scan CHECK (
    tag_proximity <> 'not_seen' OR scan_duration_seconds IS NOT NULL
  ),
  CONSTRAINT device_companion_observation_clock CHECK (
    sampled_at <= created_at + interval '5 minutes'
  )
);

CREATE INDEX device_companion_observation_match
  ON public.device_companion_observation (
    user_id, device_id, sampled_at DESC, created_at DESC
  );
CREATE INDEX device_companion_observation_retention
  ON public.device_companion_observation (sampled_at);

CREATE TABLE public.device_separation_state (
  user_id UUID NOT NULL,
  device_id UUID NOT NULL,
  installation_id UUID NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'unknown'
    CHECK (state IN ('unknown', 'together', 'separated')),
  reason VARCHAR(32) CHECK (
    reason IS NULL OR reason IN (
      'nearby', 'safe_zone', 'safe_zone_departure', 'distance'
    )
  ),
  safe_zone_id UUID REFERENCES public.device_safe_zone(id) ON DELETE SET NULL,
  phone_tag_distance_meters DOUBLE PRECISION CHECK (
    phone_tag_distance_meters IS NULL OR phone_tag_distance_meters >= 0
  ),
  last_report_id UUID,
  last_observation_id UUID,
  last_transition_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id),
  CONSTRAINT device_separation_state_companion_fk
    FOREIGN KEY (user_id, device_id, installation_id)
    REFERENCES public.device_primary_companion (
      user_id, device_id, installation_id
    ) ON DELETE CASCADE
);

CREATE TRIGGER device_separation_state_set_updated_at
  BEFORE UPDATE ON public.device_separation_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.device_replacement_claim (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE RESTRICT,
  subscription_id UUID NOT NULL
    REFERENCES public.subscription(id) ON DELETE RESTRICT,
  reason VARCHAR(16) NOT NULL CHECK (reason IN ('lost', 'stolen')),
  incident_at TIMESTAMPTZ NOT NULL,
  notes VARCHAR(500) CHECK (
    notes IS NULL OR (
      length(BTRIM(notes)) BETWEEN 1 AND 500 AND notes !~ '[[:cntrl:]]'
    )
  ),
  benefit_period_start TIMESTAMPTZ NOT NULL,
  benefit_period_end TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'submitted' CHECK (
    status IN ('submitted', 'approved', 'rejected', 'fulfilled', 'cancelled')
  ),
  replacement_device_id UUID
    REFERENCES public.device(id) ON DELETE RESTRICT,
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  review_note VARCHAR(500) CHECK (
    review_note IS NULL OR (
      length(BTRIM(review_note)) BETWEEN 1 AND 500
      AND review_note !~ '[[:cntrl:]]'
    )
  ),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_replacement_claim_one_per_term
    UNIQUE (subscription_id, benefit_period_start),
  CONSTRAINT device_replacement_claim_period CHECK (
    benefit_period_end > benefit_period_start
    AND incident_at >= benefit_period_start
  ),
  CONSTRAINT device_replacement_claim_review CHECK (
    (status = 'submitted' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (status = 'cancelled')
    OR (status IN ('approved', 'rejected', 'fulfilled')
        AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
  ),
  CONSTRAINT device_replacement_claim_fulfilled CHECK (
    (status = 'fulfilled' AND fulfilled_at IS NOT NULL
      AND replacement_device_id IS NOT NULL)
    OR (status <> 'fulfilled' AND fulfilled_at IS NULL
      AND replacement_device_id IS NULL)
  )
);

CREATE INDEX device_replacement_claim_owner
  ON public.device_replacement_claim (user_id, device_id, submitted_at DESC);
CREATE INDEX device_replacement_claim_review_queue
  ON public.device_replacement_claim (status, submitted_at)
  WHERE status IN ('submitted', 'approved');

CREATE TRIGGER device_replacement_claim_set_updated_at
  BEFORE UPDATE ON public.device_replacement_claim
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.provisioning_request
  DROP CONSTRAINT IF EXISTS provisioning_request_subscription_id_key,
  ADD COLUMN replacement_claim_id UUID UNIQUE
    REFERENCES public.device_replacement_claim(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX provisioning_request_paid_subscription_unique
  ON public.provisioning_request (subscription_id)
  WHERE replacement_claim_id IS NULL;

ALTER TABLE public.user_notification
  DROP CONSTRAINT user_notification_kind_check,
  DROP CONSTRAINT user_notification_message_shape,
  ADD CONSTRAINT user_notification_kind_check CHECK (
    kind IN (
      'renewal_7_days', 'renewal_1_day', 'expired', 'admin_message',
      'separation_detected', 'movement_detected'
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
    OR (kind IN ('renewal_7_days', 'renewal_1_day', 'expired')
      AND device_id IS NOT NULL
      AND subscription_id IS NOT NULL
      AND period_end IS NOT NULL
      AND admin_created_by IS NULL
      AND title IS NULL
      AND body IS NULL
      AND event_key IS NULL)
    OR (kind IN ('separation_detected', 'movement_detected')
      AND device_id IS NOT NULL
      AND subscription_id IS NOT NULL
      AND period_end IS NULL
      AND admin_created_by IS NULL
      AND title IS NOT NULL AND BTRIM(title) <> ''
      AND body IS NOT NULL AND BTRIM(body) <> ''
      AND event_key IS NOT NULL AND BTRIM(event_key) <> '')
  );

CREATE OR REPLACE FUNCTION public.evaluate_tracker_safety(
  target_user_id UUID,
  target_device_id UUID,
  source_event_key TEXT
)
RETURNS VOID AS $$
DECLARE
  active_subscription_id UUID;
  tracker_name TEXT;
  report RECORD;
  observation RECORD;
  profile RECORD;
  zone RECORD;
  phone_zone RECORD;
  previous RECORD;
  has_previous BOOLEAN := false;
  tag_inside BOOLEAN;
  tag_inside_any_zone BOOLEAN := false;
  nearby_now BOOLEAN := false;
  separated_now BOOLEAN := false;
  owner_close BOOLEAN := false;
  separation_reason TEXT := NULL;
  separation_zone_id UUID := NULL;
  phone_tag_distance DOUBLE PRECISION;
  moved_meters DOUBLE PRECISION;
  alert_title TEXT;
  alert_body TEXT;
BEGIN
  SELECT subscription.id
    INTO active_subscription_id
    FROM public.subscription subscription
   WHERE subscription.user_id = target_user_id
     AND subscription.device_id = target_device_id
     AND subscription.status IN ('active', 'trialing')
     AND subscription.starts_at <= now()
     AND subscription.current_period_end > now()
   ORDER BY subscription.current_period_end DESC,
            subscription.created_at DESC
   LIMIT 1;

  IF active_subscription_id IS NULL THEN
    RETURN;
  END IF;

  SELECT location.id, location.latitude, location.longitude,
         location.recorded_at
    INTO report
    FROM public.device_location_report location
   WHERE location.user_id = target_user_id
     AND location.device_id = target_device_id
     AND location.recorded_at >= now() - interval '2 hours'
   ORDER BY location.recorded_at DESC, location.id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT companion.installation_id, context.id, context.phone_latitude,
         context.phone_longitude, context.phone_accuracy_meters,
         context.sampled_at, context.tag_proximity,
         context.tag_observed_at
    INTO observation
    FROM public.device_primary_companion companion
    JOIN public.device_companion_observation context
      ON context.user_id = companion.user_id
     AND context.device_id = companion.device_id
     AND context.installation_id = companion.installation_id
   WHERE companion.user_id = target_user_id
     AND companion.device_id = target_device_id
     AND context.sampled_at BETWEEN
         report.recorded_at - interval '30 minutes'
         AND report.recorded_at + interval '30 minutes'
     AND context.sampled_at >= now() - interval '24 hours'
   ORDER BY abs(extract(epoch FROM context.sampled_at - report.recorded_at)),
            context.sampled_at DESC, context.created_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.device_protection_profile (user_id, device_id)
  VALUES (target_user_id, target_device_id)
  ON CONFLICT (user_id, device_id) DO NOTHING;

  SELECT *
    INTO profile
    FROM public.device_protection_profile protection
   WHERE protection.user_id = target_user_id
     AND protection.device_id = target_device_id
   FOR UPDATE;

  SELECT COALESCE(NULLIF(BTRIM(device.name), ''), device.serial_number)
    INTO tracker_name
    FROM public.device device
   WHERE device.id = target_device_id;

  nearby_now := observation.tag_proximity = 'nearby'
    AND observation.tag_observed_at BETWEEN
      observation.sampled_at - interval '5 minutes'
      AND observation.sampled_at + interval '5 minutes';

  phone_tag_distance := public.pinkeva_distance_meters(
    observation.phone_latitude,
    observation.phone_longitude,
    report.latitude,
    report.longitude
  );

  FOR zone IN
    SELECT *
      FROM public.device_safe_zone safe_zone
     WHERE safe_zone.user_id = target_user_id
       AND safe_zone.device_id = target_device_id
       AND safe_zone.enabled = true
     FOR UPDATE
  LOOP
    tag_inside := public.pinkeva_distance_meters(
      zone.latitude, zone.longitude, report.latitude, report.longitude
    ) <= zone.radius_meters + 25;
    tag_inside_any_zone := tag_inside_any_zone OR tag_inside;
    UPDATE public.device_safe_zone
       SET last_tracker_inside = tag_inside,
           last_evaluated_at = report.recorded_at,
           updated_at = now()
     WHERE id = zone.id;
  END LOOP;

  IF nearby_now THEN
    separation_reason := 'nearby';
  ELSIF tag_inside_any_zone THEN
    separation_reason := 'safe_zone';
  ELSE
    SELECT safe_zone.id, safe_zone.name
      INTO phone_zone
      FROM public.device_safe_zone safe_zone
     WHERE safe_zone.user_id = target_user_id
       AND safe_zone.device_id = target_device_id
       AND safe_zone.enabled = true
       AND public.pinkeva_distance_meters(
             safe_zone.latitude,
             safe_zone.longitude,
             observation.phone_latitude,
             observation.phone_longitude
           ) <= safe_zone.radius_meters
                + LEAST(observation.phone_accuracy_meters, 100)
     ORDER BY public.pinkeva_distance_meters(
                safe_zone.latitude,
                safe_zone.longitude,
                observation.phone_latitude,
                observation.phone_longitude
              ), safe_zone.id
     LIMIT 1;

    IF FOUND THEN
      separated_now := true;
      separation_reason := 'safe_zone_departure';
      separation_zone_id := phone_zone.id;
      alert_title := LEFT(tracker_name || ' left ' || phone_zone.name, 120);
      alert_body := LEFT(
        'Your main phone is still at ' || phone_zone.name
        || ', but ' || tracker_name || ' was reported outside the safe zone.',
        320
      );
    ELSIF phone_tag_distance >= profile.separation_threshold_meters
          + LEAST(observation.phone_accuracy_meters, 100) THEN
      separated_now := true;
      separation_reason := 'distance';
      alert_title := 'Tracker may have been left behind';
      alert_body := LEFT(
        tracker_name || ' was reported about '
        || round(phone_tag_distance)::text
        || ' metres from your main phone.',
        320
      );
    ELSE
      separation_reason := 'nearby';
    END IF;
  END IF;

  SELECT *
    INTO previous
    FROM public.device_separation_state separation
   WHERE separation.user_id = target_user_id
     AND separation.device_id = target_device_id
   FOR UPDATE;
  has_previous := FOUND;

  IF separated_now
     AND profile.separation_alerts
     AND (NOT has_previous OR previous.state <> 'separated') THEN
    INSERT INTO public.user_notification (
      user_id, device_id, subscription_id, kind, period_end,
      due_at, title, body, event_key
    ) VALUES (
      target_user_id, target_device_id, active_subscription_id,
      'separation_detected', NULL, now(), alert_title, alert_body,
      LEFT(source_event_key || ':' || separation_reason, 128)
    )
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.device_separation_state (
    user_id, device_id, installation_id, state, reason, safe_zone_id,
    phone_tag_distance_meters, last_report_id, last_observation_id,
    last_transition_at, last_evaluated_at
  ) VALUES (
    target_user_id, target_device_id, observation.installation_id,
    CASE WHEN separated_now THEN 'separated' ELSE 'together' END,
    separation_reason, separation_zone_id, phone_tag_distance,
    report.id, observation.id, now(), now()
  )
  ON CONFLICT (user_id, device_id) DO UPDATE
     SET installation_id = EXCLUDED.installation_id,
         state = EXCLUDED.state,
         reason = EXCLUDED.reason,
         safe_zone_id = EXCLUDED.safe_zone_id,
         phone_tag_distance_meters = EXCLUDED.phone_tag_distance_meters,
         last_report_id = EXCLUDED.last_report_id,
         last_observation_id = EXCLUDED.last_observation_id,
         last_transition_at = CASE
           WHEN device_separation_state.state <> EXCLUDED.state
             THEN now()
           ELSE device_separation_state.last_transition_at
         END,
         last_evaluated_at = now(),
         updated_at = now();

  IF profile.movement_alerts THEN
    IF profile.movement_anchor_latitude IS NULL THEN
      UPDATE public.device_protection_profile
         SET movement_anchor_latitude = report.latitude,
             movement_anchor_longitude = report.longitude,
             updated_at = now()
       WHERE user_id = target_user_id AND device_id = target_device_id;
    ELSE
      moved_meters := public.pinkeva_distance_meters(
        profile.movement_anchor_latitude,
        profile.movement_anchor_longitude,
        report.latitude,
        report.longitude
      );
      IF moved_meters >= profile.movement_threshold_meters THEN
        owner_close := nearby_now OR tag_inside_any_zone
          OR phone_tag_distance <= GREATEST(
            100, LEAST(observation.phone_accuracy_meters, 100) + 100
          );
        IF NOT owner_close THEN
          INSERT INTO public.user_notification (
            user_id, device_id, subscription_id, kind, period_end,
            due_at, title, body, event_key
          ) VALUES (
            target_user_id, target_device_id, active_subscription_id,
            'movement_detected', NULL, now(),
            CASE WHEN profile.vehicle_mode THEN 'Vehicle movement detected'
                 ELSE 'Tracker movement detected' END,
            LEFT(tracker_name || ' moved about '
                 || round(moved_meters)::text
                 || ' metres away from its previous position.', 320),
            LEFT(source_event_key || ':movement', 128)
          )
          ON CONFLICT DO NOTHING;
        END IF;

        UPDATE public.device_protection_profile
           SET movement_anchor_latitude = report.latitude,
               movement_anchor_longitude = report.longitude,
               updated_at = now()
         WHERE user_id = target_user_id AND device_id = target_device_id;
      END IF;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.process_premium_location_report()
RETURNS trigger AS $$
BEGIN
  DELETE FROM public.device_location_report
   WHERE device_id = new.device_id
     AND id <> new.id
     AND recorded_at < now() - interval '30 days';
  DELETE FROM public.device_companion_observation
   WHERE sampled_at < now() - interval '24 hours';
  PERFORM public.evaluate_tracker_safety(
    new.user_id, new.device_id, 'location:' || new.id::text
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.process_companion_observation()
RETURNS trigger AS $$
BEGIN
  DELETE FROM public.device_companion_observation
   WHERE sampled_at < now() - interval '24 hours';
  PERFORM public.evaluate_tracker_safety(
    new.user_id, new.device_id, 'phone:' || new.id::text
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog;

CREATE TRIGGER device_location_report_process_premium
  AFTER INSERT ON public.device_location_report
  FOR EACH ROW EXECUTE FUNCTION public.process_premium_location_report();

CREATE TRIGGER device_companion_observation_process_premium
  AFTER INSERT ON public.device_companion_observation
  FOR EACH ROW EXECUTE FUNCTION public.process_companion_observation();

ALTER TABLE public.device_primary_companion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_companion_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_separation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_replacement_claim ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.device_primary_companion,
  public.device_companion_observation,
  public.device_separation_state,
  public.device_replacement_claim
FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.evaluate_tracker_safety(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_premium_location_report()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_companion_observation()
  FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE '
      || 'public.device_primary_companion, '
      || 'public.device_companion_observation, '
      || 'public.device_separation_state, '
      || 'public.device_replacement_claim TO pinqeva_backend';
  END IF;
END;
$$;

COMMENT ON TABLE public.device_primary_companion IS
  'One owner-selected main phone per tracker; changing phones requires an explicit reset.';
COMMENT ON TABLE public.device_companion_observation IS
  'Backend-only, 24-hour phone location and BLE-nearby evidence used to suppress false separation alerts.';
COMMENT ON TABLE public.device_separation_state IS
  'Latest together/separated transition state used to make safety notifications idempotent.';
COMMENT ON TABLE public.device_replacement_claim IS
  'One manually reviewed zero-price replacement request per paid 6/12-month subscription term; fulfilment assigns an inventory tag and claim request.';
COMMENT ON COLUMN public.provisioning_request.replacement_claim_id IS
  'Non-null only for an admin-fulfilled, zero-price replacement tag claim.';
COMMENT ON TABLE public.device_safe_zone IS
  'Places where a tracker may remain safely; alerts occur only when the tracker leaves while the main phone stays, or they separate elsewhere.';
COMMENT ON TABLE public.device_protection_profile IS
  'Phone-aware separation plus movement and vehicle alert settings; no display-dependent lost message.';
