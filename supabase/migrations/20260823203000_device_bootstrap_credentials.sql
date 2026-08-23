-- Per-device factory credentials for QR-free BLE authorization.
-- The raw 32-byte key is injected into the tag during manufacturing. The
-- backend stores only an AES-256-GCM envelope and returns nonce-bound HMAC
-- proofs to authenticated clients; the mobile application never receives the
-- reusable bootstrap key.

CREATE TABLE public.device_bootstrap_credential (
    device_id UUID PRIMARY KEY REFERENCES public.device(id) ON DELETE RESTRICT,
    key_ciphertext BYTEA NOT NULL CHECK (octet_length(key_ciphertext) = 48),
    key_nonce BYTEA NOT NULL CHECK (octet_length(key_nonce) = 12),
    envelope_version SMALLINT NOT NULL CHECK (envelope_version = 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.device_bootstrap_credential ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.device_bootstrap_credential FROM anon, authenticated;

COMMENT ON TABLE public.device_bootstrap_credential IS
    'Backend-only encrypted copies of per-device keys used for BLE challenge-response';
COMMENT ON COLUMN public.device_bootstrap_credential.key_ciphertext IS
    'AES-256-GCM encrypted raw 32-byte bootstrap key; never returned to the app';

-- These columns belonged to the earlier QR setup-code flow. They remain only
-- so an already-applied prototype database can be migrated without destroying
-- data. Runtime code no longer reads them; remove them in a later cleanup once
-- every device has a device_bootstrap_credential row and matching tag NVS key.
COMMENT ON COLUMN public.device.setup_secret_salt IS
    'Deprecated: unused by protocol v1.2 QR-free bootstrap authorization';
COMMENT ON COLUMN public.device.setup_secret_digest IS
    'Deprecated: unused by protocol v1.2 QR-free bootstrap authorization';
