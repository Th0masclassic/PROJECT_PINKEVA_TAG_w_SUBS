-- Monotonic anti-rollback counter for signed, device-bound subscription
-- entitlements. The backend increments it while holding the device row lock;
-- the firmware refuses packets that do not advance the counter.

ALTER TABLE public.device
  ADD COLUMN entitlement_counter BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.device
  ADD CONSTRAINT device_entitlement_counter_nonnegative
  CHECK (entitlement_counter >= 0);

COMMENT ON COLUMN public.device.entitlement_counter IS
  'Monotonic issuance counter for signed subscription entitlements; backend-only.';
