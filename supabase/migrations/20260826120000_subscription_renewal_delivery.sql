-- Durable delivery state for subscription renewals. Stripe can renew a
-- subscription while the phone and tag are offline, so a paid database period
-- is not considered installed on the physical tag until the mobile app reads
-- the exact entitlement packet back over BLE and acknowledges it.

CREATE TABLE public.device_entitlement_sync (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE RESTRICT,
  subscription_id UUID NOT NULL
    REFERENCES public.subscription(id) ON DELETE CASCADE,
  entitlement_expires_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'issued', 'installed')),
  issued_counter BIGINT CHECK (issued_counter > 0),
  packet_sha256 CHAR(64) CHECK (
    packet_sha256 IS NULL OR packet_sha256 ~ '^[0-9a-f]{64}$'
  ),
  issued_at TIMESTAMPTZ,
  installed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_entitlement_sync_period_unique UNIQUE (
    subscription_id, device_id, entitlement_expires_at
  ),
  CONSTRAINT device_entitlement_sync_issue_state CHECK (
    (status = 'pending'
      AND issued_counter IS NULL
      AND packet_sha256 IS NULL
      AND issued_at IS NULL
      AND installed_at IS NULL)
    OR (status = 'issued'
      AND issued_counter IS NOT NULL
      AND packet_sha256 IS NOT NULL
      AND issued_at IS NOT NULL
      AND installed_at IS NULL)
    OR (status = 'installed'
      AND issued_counter IS NOT NULL
      AND packet_sha256 IS NOT NULL
      AND issued_at IS NOT NULL
      AND installed_at IS NOT NULL)
  )
);

CREATE INDEX device_entitlement_sync_pending_user
  ON public.device_entitlement_sync (user_id, created_at)
  WHERE status <> 'installed';

CREATE INDEX device_entitlement_sync_device_period
  ON public.device_entitlement_sync (device_id, entitlement_expires_at DESC);

CREATE TRIGGER device_entitlement_sync_set_updated_at
  BEFORE UPDATE ON public.device_entitlement_sync
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.queue_device_entitlement_sync()
RETURNS trigger AS $$
BEGIN
  IF new.status IN ('active', 'trialing') AND new.current_period_end > now() THEN
    INSERT INTO public.device_entitlement_sync (
      user_id, device_id, subscription_id, entitlement_expires_at
    ) VALUES (
      new.user_id, new.device_id, new.id, new.current_period_end
    )
    ON CONFLICT (
      subscription_id, device_id, entitlement_expires_at
    ) DO NOTHING;
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.queue_device_entitlement_sync()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER subscription_queue_device_entitlement_sync
  AFTER INSERT OR UPDATE OF
    user_id, device_id, status, current_period_end
  ON public.subscription
  FOR EACH ROW EXECUTE FUNCTION public.queue_device_entitlement_sync();

-- Existing active periods also need an explicit delivery record. The
-- entitlement endpoint will turn the row into `issued`; the read-back
-- acknowledgement turns it into `installed`.
INSERT INTO public.device_entitlement_sync (
  user_id, device_id, subscription_id, entitlement_expires_at
)
SELECT user_id, device_id, id, current_period_end
  FROM public.subscription
 WHERE status IN ('active', 'trialing')
   AND current_period_end > now()
ON CONFLICT (subscription_id, device_id, entitlement_expires_at) DO NOTHING;

-- Push tokens are backend-only. `installation_id` lets one signed-in app
-- installation replace a rotated Expo token without accumulating stale rows.
CREATE TABLE public.mobile_push_token (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL,
  expo_push_token VARCHAR(256) NOT NULL,
  platform VARCHAR(12) NOT NULL CHECK (platform IN ('ios', 'android')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mobile_push_token_installation_unique
    UNIQUE (user_id, installation_id),
  CONSTRAINT mobile_push_token_shape CHECK (
    expo_push_token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'
  ),
  CONSTRAINT mobile_push_token_error_shape CHECK (
    last_error_code IS NULL
    OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  )
);

CREATE INDEX mobile_push_token_enabled_user
  ON public.mobile_push_token (user_id)
  WHERE enabled;

CREATE UNIQUE INDEX mobile_push_token_one_enabled_destination
  ON public.mobile_push_token (expo_push_token)
  WHERE enabled;

CREATE TRIGGER mobile_push_token_set_updated_at
  BEFORE UPDATE ON public.mobile_push_token
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- This table is both a durable notification inbox and a leased push outbox.
-- Unique period/kind rows make the 7-day, 1-day, expired, and tag-sync notices
-- idempotent even when several API processes run the scheduler.
CREATE TABLE public.user_notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL
    REFERENCES public.subscription(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL CHECK (
    kind IN (
      'renewal_7_days',
      'renewal_1_day',
      'expired',
      'tag_sync_required'
    )
  ),
  period_end TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  push_status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (
    push_status IN (
      'pending', 'processing', 'retry', 'sent', 'no_tokens', 'skipped', 'failed'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner VARCHAR(128),
  lease_expires_at TIMESTAMPTZ,
  last_error_code VARCHAR(64),
  pushed_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_notification_period_kind_unique
    UNIQUE (subscription_id, kind, period_end),
  CONSTRAINT user_notification_lease_state CHECK (
    (push_status = 'processing'
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL)
    OR (push_status <> 'processing'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL)
  ),
  CONSTRAINT user_notification_error_shape CHECK (
    last_error_code IS NULL
    OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  )
);

CREATE INDEX user_notification_delivery_due
  ON public.user_notification (next_attempt_at, due_at)
  WHERE push_status IN ('pending', 'retry');

CREATE INDEX user_notification_user_created
  ON public.user_notification (user_id, created_at DESC, id DESC);

CREATE TRIGGER user_notification_set_updated_at
  BEFORE UPDATE ON public.user_notification
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.device_entitlement_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_push_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notification ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.device_entitlement_sync,
  public.mobile_push_token,
  public.user_notification
FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE '
      'public.device_entitlement_sync, public.mobile_push_token, '
      'public.user_notification TO pinqeva_backend';
  END IF;
END;
$$;

COMMENT ON TABLE public.device_entitlement_sync IS
  'Backend-only desired/issued/installed state for each physical tag entitlement period.';
COMMENT ON COLUMN public.device_entitlement_sync.packet_sha256 IS
  'SHA-256 of the exact signed packet; acknowledgement follows a BLE read-back comparison.';
COMMENT ON TABLE public.mobile_push_token IS
  'Backend-only Expo push destinations registered by authenticated app installations.';
COMMENT ON TABLE public.user_notification IS
  'Durable renewal notification inbox and leased Expo push-delivery outbox.';
