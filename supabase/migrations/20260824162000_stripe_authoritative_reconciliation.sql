-- Provider catalog bindings and deterministic event ordering. Product IDs are
-- deliberately backend-only: clients continue to receive the safe plan
-- projection defined in the production RLS migration.

ALTER TABLE public.plan
  ADD COLUMN provider_product_id VARCHAR;

ALTER TABLE public.plan
  ADD CONSTRAINT plan_provider_product_id_shape
  CHECK (
    provider_product_id IS NULL
    OR provider_product_id ~ '^prod_[A-Za-z0-9]{8,}$'
  ) NOT VALID;

ALTER TABLE public.plan
  VALIDATE CONSTRAINT plan_provider_product_id_shape;

ALTER TABLE public.plan
  ADD CONSTRAINT plan_code_shape CHECK (
    code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'
  ) NOT VALID,
  ADD CONSTRAINT plan_name_shape CHECK (
    length(BTRIM(name)) BETWEEN 1 AND 120
  ) NOT VALID,
  ADD CONSTRAINT plan_supported_duration CHECK (
    duration_months IN (1, 12)
  ) NOT VALID,
  ADD CONSTRAINT plan_nonnegative_price CHECK (
    price_cents >= 0
  ) NOT VALID,
  ADD CONSTRAINT plan_currency_shape CHECK (
    currency ~ '^[A-Z]{3}$'
  ) NOT VALID;

ALTER TABLE public.plan
  VALIDATE CONSTRAINT plan_code_shape,
  VALIDATE CONSTRAINT plan_name_shape,
  VALIDATE CONSTRAINT plan_supported_duration,
  VALIDATE CONSTRAINT plan_nonnegative_price,
  VALIDATE CONSTRAINT plan_currency_shape;

ALTER TABLE public.subscription
  ADD COLUMN provider_event_id VARCHAR;

ALTER TABLE public.invoice
  ADD COLUMN provider_event_id VARCHAR;

ALTER TABLE public.subscription
  ADD CONSTRAINT subscription_provider_event_id_shape
  CHECK (
    provider_event_id IS NULL
    OR provider_event_id ~ '^evt_[A-Za-z0-9]{8,}$'
  ) NOT VALID;

ALTER TABLE public.invoice
  ADD CONSTRAINT invoice_provider_event_id_shape
  CHECK (
    provider_event_id IS NULL
    OR provider_event_id ~ '^evt_[A-Za-z0-9]{8,}$'
  ) NOT VALID;

ALTER TABLE public.subscription
  VALIDATE CONSTRAINT subscription_provider_event_id_shape;

ALTER TABLE public.invoice
  VALIDATE CONSTRAINT invoice_provider_event_id_shape;

COMMENT ON COLUMN public.plan.provider_product_id IS
  'Backend-only Stripe Product binding checked against the configured Price and live provider catalog.';
COMMENT ON COLUMN public.subscription.provider_event_id IS
  'Deterministic tie-breaker for Stripe events created in the same second.';
COMMENT ON COLUMN public.invoice.provider_event_id IS
  'Deterministic tie-breaker for Stripe events created in the same second.';
