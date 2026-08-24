-- Production administration, map projections, and flexible per-tag plans.
-- Administrative tables remain backend-only. No browser or mobile client is
-- granted direct access; all privileged actions pass through the authenticated
-- backend where role, MFA, input, and audit checks are enforced.

ALTER TABLE public.profiles
  ADD COLUMN email VARCHAR(320);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'users'
       AND column_name = 'email'
  ) THEN
    EXECUTE $sql$
      UPDATE public.profiles profile
         SET email = LOWER(auth_user.email)
        FROM auth.users auth_user
       WHERE auth_user.id = profile.id
         AND auth_user.email IS NOT NULL
    $sql$;
  END IF;
END;
$$;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_email_shape CHECK (
    email IS NULL
    OR (
      length(email) BETWEEN 3 AND 320
      AND email !~ '[[:cntrl:]]'
      AND email LIKE '%_@_%._%'
    )
  ) NOT VALID;

ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_email_shape;

CREATE UNIQUE INDEX profiles_email_lower_unique
  ON public.profiles (LOWER(email))
  WHERE email IS NOT NULL;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  requested_name text;
BEGIN
  requested_name := COALESCE(
    NULLIF(BTRIM(new.raw_user_meta_data->>'display_name'), ''),
    NULLIF(BTRIM(new.raw_user_meta_data->>'full_name'), ''),
    NULLIF(BTRIM(new.raw_user_meta_data->>'name'), '')
  );

  INSERT INTO public.profiles (id, display_name, email)
  VALUES (new.id, requested_name, LOWER(to_jsonb(new)->>'email'))
  ON CONFLICT (id) DO UPDATE
    SET email = EXCLUDED.email;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.device
  ADD COLUMN last_latitude DOUBLE PRECISION,
  ADD COLUMN last_longitude DOUBLE PRECISION,
  ADD COLUMN last_location_at TIMESTAMPTZ,
  ADD COLUMN last_place VARCHAR(160);

ALTER TABLE public.device
  ADD CONSTRAINT device_location_pair CHECK (
    (last_latitude IS NULL AND last_longitude IS NULL)
    OR (last_latitude IS NOT NULL AND last_longitude IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT device_latitude_range CHECK (
    last_latitude IS NULL OR last_latitude BETWEEN -90 AND 90
  ) NOT VALID,
  ADD CONSTRAINT device_longitude_range CHECK (
    last_longitude IS NULL OR last_longitude BETWEEN -180 AND 180
  ) NOT VALID,
  ADD CONSTRAINT device_last_place_shape CHECK (
    last_place IS NULL
    OR (
      length(BTRIM(last_place)) BETWEEN 1 AND 160
      AND last_place !~ '[[:cntrl:]]'
    )
  ) NOT VALID,
  ADD CONSTRAINT device_status_supported CHECK (
    status IN ('unprovisioned', 'claimed', 'suspended')
  ) NOT VALID;

ALTER TABLE public.device
  VALIDATE CONSTRAINT device_location_pair,
  VALIDATE CONSTRAINT device_latitude_range,
  VALIDATE CONSTRAINT device_longitude_range,
  VALIDATE CONSTRAINT device_last_place_shape,
  VALIDATE CONSTRAINT device_status_supported;

ALTER TABLE public.plan
  DROP CONSTRAINT plan_supported_duration;

ALTER TABLE public.plan
  ADD CONSTRAINT plan_supported_duration CHECK (
    duration_months IN (1, 3, 6, 12)
  ),
  ADD COLUMN provider_price_id VARCHAR,
  ADD COLUMN price_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.plan
  ADD CONSTRAINT plan_provider_price_id_shape CHECK (
    provider_price_id IS NULL
    OR provider_price_id ~ '^price_[A-Za-z0-9]{8,}$'
  ) NOT VALID,
  ADD CONSTRAINT plan_price_version_positive CHECK (price_version > 0)
    NOT VALID;

ALTER TABLE public.plan
  VALIDATE CONSTRAINT plan_provider_price_id_shape,
  VALIDATE CONSTRAINT plan_price_version_positive;

CREATE TABLE public.plan_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_code VARCHAR NOT NULL REFERENCES public.plan(code) ON DELETE RESTRICT,
  provider_price_id VARCHAR NOT NULL UNIQUE
    CHECK (provider_price_id ~ '^price_[A-Za-z0-9]{8,}$'),
  provider_product_id VARCHAR NOT NULL
    CHECK (provider_product_id ~ '^prod_[A-Za-z0-9]{8,}$'),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  duration_months SMALLINT NOT NULL CHECK (duration_months IN (1, 3, 6, 12)),
  price_version INTEGER NOT NULL CHECK (price_version > 0),
  active_for_new BOOLEAN NOT NULL DEFAULT true,
  created_by_admin_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX plan_price_history_one_current
  ON public.plan_price_history (plan_code)
  WHERE active_for_new;

INSERT INTO public.plan (
  code, name, duration_months, price_cents, currency, active
)
VALUES
  ('monthly_basic', 'Pinkeva 1 Month', 1, 299, 'EUR', true),
  ('quarterly_standard', 'Pinkeva 3 Months', 3, 799, 'EUR', true),
  ('semiannual_plus', 'Pinkeva 6 Months', 6, 1499, 'EUR', true),
  ('yearly_pro', 'Pinkeva 12 Months', 12, 2699, 'EUR', true)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.subscription
  ADD COLUMN source VARCHAR(24) NOT NULL DEFAULT 'stripe',
  ADD COLUMN created_by_admin_user_id UUID
    REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.subscription
  ADD CONSTRAINT subscription_source_check CHECK (
    source IN ('stripe', 'admin_grant')
  ) NOT VALID,
  ADD CONSTRAINT subscription_admin_grant_binding CHECK (
    (source = 'stripe' AND created_by_admin_user_id IS NULL)
    OR (source = 'admin_grant' AND created_by_admin_user_id IS NOT NULL)
  ) NOT VALID;

ALTER TABLE public.subscription
  VALIDATE CONSTRAINT subscription_source_check,
  VALIDATE CONSTRAINT subscription_admin_grant_binding;

ALTER TABLE public.subscription_cancellation_outbox
  DROP CONSTRAINT subscription_cancellation_reason_check,
  DROP CONSTRAINT subscription_cancellation_reason_binding;

ALTER TABLE public.subscription_cancellation_outbox
  ADD CONSTRAINT subscription_cancellation_reason_check CHECK (
    cancellation_reason IN (
      'device_release', 'ownership_lost_checkout', 'admin_revoked'
    )
  ),
  ADD CONSTRAINT subscription_cancellation_reason_binding CHECK (
    (
      cancellation_reason = 'device_release'
      AND device_release_id IS NOT NULL
    )
    OR (
      cancellation_reason IN ('ownership_lost_checkout', 'admin_revoked')
      AND device_release_id IS NULL
    )
  );

CREATE UNIQUE INDEX subscription_cancellation_one_admin_revoked
  ON public.subscription_cancellation_outbox (subscription_id)
  WHERE cancellation_reason = 'admin_revoked';

CREATE TABLE public.admin_role_assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role VARCHAR(24) NOT NULL CHECK (role = 'admin'),
  granted_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT admin_role_revocation_state CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX admin_role_one_active_assignment
  ON public.admin_role_assignment (user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX admin_role_assignment_history
  ON public.admin_role_assignment (user_id, granted_at DESC);

CREATE TABLE public.admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(48) NOT NULL,
  target_id VARCHAR(160),
  request_id UUID NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_action_shape CHECK (
    action ~ '^[a-z][a-z0-9_.-]{2,79}$'
  ),
  CONSTRAINT admin_audit_target_type_shape CHECK (
    target_type ~ '^[a-z][a-z0-9_.-]{1,47}$'
  ),
  CONSTRAINT admin_audit_target_id_shape CHECK (
    target_id IS NULL
    OR (
      length(target_id) BETWEEN 1 AND 160
      AND target_id !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT admin_audit_details_object CHECK (
    jsonb_typeof(details) = 'object'
    AND octet_length(details::text) <= 8192
  )
);

CREATE INDEX admin_audit_created_at
  ON public.admin_audit_log (created_at DESC, id DESC);

CREATE INDEX admin_audit_actor_created_at
  ON public.admin_audit_log (actor_user_id, created_at DESC);

ALTER TABLE public.admin_role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_price_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.admin_role_assignment,
  public.admin_audit_log,
  public.plan_price_history
FROM PUBLIC, anon, authenticated;

-- Add only the safe device location projection to existing authenticated
-- users. RLS still limits these columns to currently owned devices.
GRANT SELECT (
  last_latitude, last_longitude, last_location_at, last_place
) ON TABLE public.device TO authenticated;

COMMENT ON COLUMN public.profiles.email IS
  'Backend-only normalized account email used by the admin console.';
COMMENT ON COLUMN public.plan.provider_price_id IS
  'Current Stripe Price for new purchases. Historical subscriptions retain their original provider price.';
COMMENT ON COLUMN public.plan.price_version IS
  'Monotonic optimistic-lock version for audited admin price changes.';
COMMENT ON TABLE public.plan_price_history IS
  'Backend-only immutable Stripe Price bindings retained for old subscriptions and webhook reconciliation.';
COMMENT ON COLUMN public.device.last_latitude IS
  'Last accepted report latitude; exposed only to the active owner and authenticated admin API.';
COMMENT ON TABLE public.admin_role_assignment IS
  'Backend-only active and historical admin grants. Environment owners are intentionally not stored here.';
COMMENT ON TABLE public.admin_audit_log IS
  'Append-only record of privileged admin mutations. Secret values are forbidden from details.';
