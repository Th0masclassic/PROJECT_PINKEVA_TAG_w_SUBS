-- The claim endpoint marks a device as provisioning while the BLE setup
-- session is in progress. Keep that transient state in the same allow-list as
-- the other device lifecycle states.

ALTER TABLE public.device
  DROP CONSTRAINT IF EXISTS device_status_supported;

ALTER TABLE public.device
  ADD CONSTRAINT device_status_supported CHECK (
    status IN ('unprovisioned', 'provisioning', 'claimed', 'suspended')
  );

ALTER TABLE public.device
  VALIDATE CONSTRAINT device_status_supported;
