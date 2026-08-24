-- Stripe Billing remains server-side. Mobile clients may read safe subscription
-- projections, but cannot create billing rows, choose Stripe Price IDs, write
-- provider metadata, or read webhook payloads.

ALTER TABLE public.profiles
  ADD COLUMN stripe_customer_id VARCHAR;

CREATE UNIQUE INDEX profiles_stripe_customer_id_unique
  ON public.profiles (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_stripe_customer_id_shape
  CHECK (
    stripe_customer_id IS NULL
    OR stripe_customer_id ~ '^cus_[A-Za-z0-9]{8,}$'
  ) NOT VALID;

ALTER TABLE public.profiles
  VALIDATE CONSTRAINT profiles_stripe_customer_id_shape;

ALTER TABLE public.subscription
  ADD COLUMN provider_price_id VARCHAR,
  ADD COLUMN provider_event_created_at TIMESTAMPTZ;

ALTER TABLE public.subscription
  ADD CONSTRAINT subscription_provider_price_id_shape
  CHECK (
    provider_price_id IS NULL
    OR provider_price_id ~ '^price_[A-Za-z0-9]{8,}$'
  ) NOT VALID;

ALTER TABLE public.subscription
  VALIDATE CONSTRAINT subscription_provider_price_id_shape;

ALTER TABLE public.invoice
  ADD COLUMN provider_event_created_at TIMESTAMPTZ;

-- A reservation is created before contacting Stripe. The partial unique index
-- prevents two concurrent requests from issuing two payable Checkout URLs for
-- one tag. Expired reservations are transitioned before a replacement insert.
CREATE TABLE public.billing_checkout_session (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE RESTRICT,
  plan_code VARCHAR NOT NULL REFERENCES public.plan(code) ON DELETE RESTRICT,
  provider_session_id VARCHAR UNIQUE,
  provider_customer_id VARCHAR,
  provider_subscription_id VARCHAR,
  status VARCHAR(16) NOT NULL
    CHECK (status IN ('creating', 'pending', 'completed', 'expired', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT billing_checkout_session_id_shape CHECK (
    provider_session_id IS NULL
    OR provider_session_id ~ '^cs_[A-Za-z0-9_]{8,}$'
  ),
  CONSTRAINT billing_checkout_customer_id_shape CHECK (
    provider_customer_id IS NULL
    OR provider_customer_id ~ '^cus_[A-Za-z0-9]{8,}$'
  ),
  CONSTRAINT billing_checkout_subscription_id_shape CHECK (
    provider_subscription_id IS NULL
    OR provider_subscription_id ~ '^sub_[A-Za-z0-9]{8,}$'
  ),
  CONSTRAINT billing_checkout_completion_state CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE UNIQUE INDEX billing_checkout_one_pending_per_device
  ON public.billing_checkout_session (device_id)
  WHERE status IN ('creating', 'pending');

CREATE INDEX billing_checkout_user_created_at
  ON public.billing_checkout_session (user_id, created_at DESC);

ALTER TABLE public.billing_checkout_session ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.billing_checkout_session
  FROM anon, authenticated;

-- stripe_customer_id remains backend-only because the earlier grant is a
-- column projection. Re-assert the mobile-facing projections explicitly.
REVOKE ALL PRIVILEGES ON TABLE public.profiles FROM anon, authenticated;
GRANT SELECT (id, display_name, created_at, updated_at)
  ON TABLE public.profiles TO authenticated;
GRANT UPDATE (display_name)
  ON TABLE public.profiles TO authenticated;

COMMENT ON COLUMN public.profiles.stripe_customer_id IS
  'One backend-only Stripe Customer per account; never returned to mobile clients.';
COMMENT ON TABLE public.billing_checkout_session IS
  'Backend-only per-tag Checkout reservations used to prevent duplicate payable sessions.';
COMMENT ON COLUMN public.subscription.provider_event_created_at IS
  'Stripe event creation time used to reject stale out-of-order subscription updates.';
COMMENT ON COLUMN public.invoice.provider_event_created_at IS
  'Stripe event creation time used to reject stale out-of-order invoice updates.';
