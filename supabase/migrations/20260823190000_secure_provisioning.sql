-- Pinqeva provisioning storage.
-- Private finder keys are encrypted by the backend before insertion. The
-- authenticated/anonymous API roles have no direct access to this table.

ALTER TABLE public.device
    ADD COLUMN IF NOT EXISTS setup_secret_salt BYTEA,
    ADD COLUMN IF NOT EXISTS setup_secret_digest BYTEA,
    ADD COLUMN IF NOT EXISTS provisioning_session_id UUID;

ALTER TABLE public.device
    ADD CONSTRAINT device_id_serial_number_unique UNIQUE (id, serial_number);

ALTER TABLE public.device
    ADD CONSTRAINT device_serial_number_format
    CHECK (serial_number ~ '^PKV-[0-9A-F]{12}$') NOT VALID;

ALTER TABLE public.device
    ADD CONSTRAINT device_setup_secret_shape
    CHECK (
        (setup_secret_salt IS NULL AND setup_secret_digest IS NULL)
        OR (
            octet_length(setup_secret_salt) = 16
            AND octet_length(setup_secret_digest) = 32
        )
    );

CREATE TABLE public.provisioning_session (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE RESTRICT,
    serial_number VARCHAR(16) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    protocol_version SMALLINT NOT NULL CHECK (protocol_version = 1),

    -- AES-256-GCM envelope. The key itself lives in a managed KMS/secret store.
    private_key_ciphertext BYTEA NOT NULL
        CHECK (octet_length(private_key_ciphertext) = 44),
    private_key_nonce BYTEA NOT NULL CHECK (octet_length(private_key_nonce) = 12),
    private_key_envelope_version SMALLINT NOT NULL CHECK (private_key_envelope_version = 1),

    -- Full P-224 public point and the 28-byte X coordinate advertised by the tag.
    public_key BYTEA NOT NULL CHECK (octet_length(public_key) = 57),
    advertisement_key BYTEA NOT NULL CHECK (octet_length(advertisement_key) = 28),
    advertisement_key_sha256 BYTEA NOT NULL UNIQUE
        CHECK (octet_length(advertisement_key_sha256) = 32),

    status VARCHAR(20) NOT NULL
        CHECK (status IN ('pending', 'claimed', 'revoked', 'recovery_required')),
    expires_at TIMESTAMPTZ NOT NULL,
    claim_deadline TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT provisioning_session_idempotency UNIQUE (user_id, idempotency_key),
    CONSTRAINT provisioning_session_id_device_unique UNIQUE (id, device_id),
    CONSTRAINT provisioning_session_serial_matches_device
        FOREIGN KEY (device_id, serial_number)
        REFERENCES public.device(id, serial_number),
    CONSTRAINT provisioning_deadlines_ordered
        CHECK (expires_at <= claim_deadline),
    CONSTRAINT provisioning_completion_state
        CHECK (
            (status = 'claimed' AND completed_at IS NOT NULL)
            OR (status = 'pending' AND completed_at IS NULL AND revoked_at IS NULL)
            OR (status IN ('revoked', 'recovery_required'))
        ),
    CONSTRAINT provisioning_revocation_state
        CHECK (
            (status = 'revoked' AND revoked_at IS NOT NULL)
            OR (status <> 'revoked' AND revoked_at IS NULL)
        )
);

-- One live attempt per physical tag. Ambiguous/expired attempts remain pending
-- and block regeneration until an explicit recovery or completed release.
CREATE UNIQUE INDEX provisioning_one_pending_session_per_device
    ON public.provisioning_session(device_id)
    WHERE status = 'pending';

-- The ownership model permits history but never two simultaneous owners.
CREATE UNIQUE INDEX ownership_one_active_owner_per_device
    ON public.ownership(device_id)
    WHERE ended_at IS NULL;

ALTER TABLE public.device
    ADD CONSTRAINT device_provisioning_session_fk
    FOREIGN KEY (provisioning_session_id, id)
    REFERENCES public.provisioning_session(id, device_id)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX device_one_provisioning_session
    ON public.device(provisioning_session_id)
    WHERE provisioning_session_id IS NOT NULL;

-- Release is deliberately two-phase: the owner first receives an authenticated
-- reset command, and ownership/billing change only after the tag reports empty.
CREATE TABLE public.device_release (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE RESTRICT,
    provisioning_session_id UUID NOT NULL,
    serial_number VARCHAR(16) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    reset_nonce BYTEA NOT NULL CHECK (octet_length(reset_nonce) = 32),
    status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'completed', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    cancelled_subscriptions INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_subscriptions >= 0),
    provider_cancellations_queued INTEGER NOT NULL DEFAULT 0
        CHECK (provider_cancellations_queued >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT device_release_idempotency UNIQUE (user_id, idempotency_key),
    CONSTRAINT device_release_session_matches_device
        FOREIGN KEY (provisioning_session_id, device_id)
        REFERENCES public.provisioning_session(id, device_id)
        ON DELETE RESTRICT,
    CONSTRAINT device_release_serial_matches_device
        FOREIGN KEY (device_id, serial_number)
        REFERENCES public.device(id, serial_number),
    CONSTRAINT device_release_completion_state CHECK (
        (status = 'completed' AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX device_one_pending_release
    ON public.device_release(device_id)
    WHERE status = 'pending';

-- Local access/entitlements stop in the release transaction. Provider billing
-- cancellation is delivered by an idempotent outbox worker and confirmed by
-- the normal signed webhook before operators consider the provider settled.
CREATE TABLE public.subscription_cancellation_outbox (
    id UUID PRIMARY KEY,
    subscription_id UUID NOT NULL REFERENCES public.subscription(id) ON DELETE RESTRICT,
    device_release_id UUID NOT NULL REFERENCES public.device_release(id) ON DELETE RESTRICT,
    provider_subscription_id VARCHAR NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error_code VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT subscription_cancellation_once_per_release
        UNIQUE (subscription_id, device_release_id)
);

ALTER TABLE public.provisioning_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cancellation_outbox ENABLE ROW LEVEL SECURITY;

-- No user-facing RLS policy is intentional. Only the separately deployed
-- backend database role may read encrypted key material. Do not grant this
-- table to anon/authenticated roles through the Supabase Data API.
REVOKE ALL ON TABLE public.provisioning_session FROM anon, authenticated;
REVOKE ALL ON TABLE public.device_release FROM anon, authenticated;
REVOKE ALL ON TABLE public.subscription_cancellation_outbox FROM anon, authenticated;

-- Row-level policy is not column secrecy. Replace the broad device SELECT grant
-- with an explicit public projection so QR digests and internal key bindings
-- cannot leak through PostgREST/Supabase Data API responses.
REVOKE SELECT ON TABLE public.device FROM anon, authenticated;
GRANT SELECT (
    id, serial_number, name, status, firmware_version, created_at, updated_at
) ON TABLE public.device TO authenticated;

COMMENT ON COLUMN public.device.setup_secret_digest IS
    'HMAC-SHA256 of the high-entropy manufacturing QR setup code; never the code itself';
COMMENT ON COLUMN public.provisioning_session.private_key_ciphertext IS
    'AES-256-GCM encrypted raw 28-byte P-224 private scalar';
COMMENT ON COLUMN public.provisioning_session.advertisement_key IS
    'Raw 28-byte P-224 X coordinate transferred to the tag';
