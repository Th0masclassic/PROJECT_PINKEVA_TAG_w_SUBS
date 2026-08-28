-- Replace the development-only subscription entitlement transport with
-- switchable Apple Find My / Google Find Hub key material. Subscriptions gate
-- cloud services only; neither radio identity is tied to billing state.

DROP TRIGGER IF EXISTS subscription_queue_device_entitlement_sync
  ON public.subscription;
DROP FUNCTION IF EXISTS public.queue_device_entitlement_sync();
DROP TABLE IF EXISTS public.device_entitlement_sync CASCADE;

DELETE FROM public.user_notification
 WHERE kind = 'tag_sync_required';

ALTER TABLE public.user_notification
  DROP CONSTRAINT user_notification_kind_check,
  DROP CONSTRAINT user_notification_message_shape,
  ADD CONSTRAINT user_notification_kind_check CHECK (
    kind IN (
      'renewal_7_days',
      'renewal_1_day',
      'expired',
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
    OR (kind IN ('renewal_7_days', 'renewal_1_day', 'expired')
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

ALTER TABLE public.device
  DROP CONSTRAINT IF EXISTS device_entitlement_counter_nonnegative;
ALTER TABLE public.device
  DROP COLUMN IF EXISTS entitlement_counter;

-- `suspended` existed only so an expired tag entitlement could stop the radio.
-- Preserve development allocations while collapsing that obsolete state back
-- to the lifecycle implied by their provisioning binding.
UPDATE public.device device
   SET status = CASE
         WHEN device.provisioning_session_id IS NULL THEN 'unprovisioned'
         WHEN EXISTS (
           SELECT 1
             FROM public.provisioning_session session
            WHERE session.id = device.provisioning_session_id
              AND session.status = 'pending'
         ) THEN 'provisioning'
         ELSE 'claimed'
       END,
       updated_at = now()
 WHERE device.status = 'suspended';

ALTER TABLE public.device
  DROP CONSTRAINT IF EXISTS device_status_supported;
ALTER TABLE public.device
  ADD CONSTRAINT device_status_supported CHECK (
    status IN ('unprovisioned', 'provisioning', 'claimed')
  );
ALTER TABLE public.device
  VALIDATE CONSTRAINT device_status_supported;

ALTER TABLE public.device
  ADD COLUMN finding_network TEXT;

ALTER TABLE public.device
  ADD CONSTRAINT device_finding_network_valid
  CHECK (finding_network IN ('apple', 'google'));

COMMENT ON COLUMN public.device.finding_network IS
  'The one finding network currently selected on a provisioned physical tag; null while unprovisioned. The tag never advertises Apple and Google frames simultaneously.';

ALTER TABLE public.provisioning_session
  ADD COLUMN google_identity_key_ciphertext BYTEA,
  ADD COLUMN google_identity_key_nonce BYTEA,
  ADD COLUMN google_identity_key_envelope_version SMALLINT,
  ADD COLUMN google_advertisement_key BYTEA,
  ADD COLUMN google_advertisement_key_sha256 BYTEA,
  ADD COLUMN finding_network TEXT NOT NULL DEFAULT 'apple';

ALTER TABLE public.provisioning_session
  ADD CONSTRAINT provisioning_session_google_key_bundle_complete
  CHECK (
    (
      google_identity_key_ciphertext IS NULL
      AND google_identity_key_nonce IS NULL
      AND google_identity_key_envelope_version IS NULL
      AND google_advertisement_key IS NULL
      AND google_advertisement_key_sha256 IS NULL
    )
    OR
    (
      octet_length(google_identity_key_ciphertext) = 48
      AND octet_length(google_identity_key_nonce) = 12
      AND google_identity_key_envelope_version = 1
      AND octet_length(google_advertisement_key) = 20
      AND octet_length(google_advertisement_key_sha256) = 32
    )
  ),
  ADD CONSTRAINT provisioning_session_finding_network_valid
  CHECK (finding_network IN ('apple', 'google'));

CREATE UNIQUE INDEX provisioning_session_google_advertisement_key_unique
  ON public.provisioning_session (google_advertisement_key_sha256)
  WHERE google_advertisement_key_sha256 IS NOT NULL;

COMMENT ON COLUMN public.provisioning_session.advertisement_key IS
  'Apple Find My 28-byte P-224 advertisement key (public X coordinate).';
COMMENT ON COLUMN public.provisioning_session.google_identity_key_ciphertext IS
  'AES-256-GCM encrypted 32-byte Google Find Hub development identity key. Never returned by the public API.';
COMMENT ON COLUMN public.provisioning_session.google_advertisement_key IS
  'Google Find Hub 20-byte SECP160R1 development EID sent to the tag.';
COMMENT ON COLUMN public.provisioning_session.finding_network IS
  'Write-once network selected during tag provisioning: apple or google.';

-- Existing development allocations predate dual-network provisioning. They
-- remain Apple-selected and receive Google material lazily if setup is resumed.
UPDATE public.device d
   SET finding_network = COALESCE(ps.finding_network, 'apple')
  FROM public.provisioning_session ps
 WHERE ps.id = d.provisioning_session_id;

REVOKE ALL ON TABLE public.provisioning_session FROM anon, authenticated;
