-- Payment-gated tag provisioning.
-- A request identifies one authenticated user, one physical tag, and one
-- short-lived checkout attempt. It intentionally contains no finder key
-- material and no raw BLE challenge.

CREATE TABLE public.provisioning_request (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
    device_id UUID NOT NULL REFERENCES public.device(id) ON DELETE RESTRICT,
    serial_number VARCHAR(16) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    plan_code VARCHAR REFERENCES public.plan(code) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL
        CHECK (status IN (
            'pending', 'creating', 'open', 'paid', 'claiming',
            'completed', 'expired', 'failed'
        )),
    expires_at TIMESTAMPTZ NOT NULL,
    claim_deadline TIMESTAMPTZ,
    provider_session_id VARCHAR UNIQUE,
    provider_customer_id VARCHAR,
    provider_subscription_id VARCHAR UNIQUE,
    subscription_id UUID UNIQUE REFERENCES public.subscription(id) ON DELETE RESTRICT,
    paid_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT provisioning_request_idempotency
        UNIQUE (user_id, idempotency_key),
    CONSTRAINT provisioning_request_device_serial
        FOREIGN KEY (device_id, serial_number)
        REFERENCES public.device(id, serial_number),
    CONSTRAINT provisioning_request_expires_within_thirty_minutes
        CHECK (expires_at > created_at
               AND expires_at <= created_at + interval '30 minutes'),
    CONSTRAINT provisioning_request_provider_session_shape CHECK (
        provider_session_id IS NULL
        OR provider_session_id ~ '^cs_[A-Za-z0-9_]{8,}$'
    ),
    CONSTRAINT provisioning_request_provider_customer_shape CHECK (
        provider_customer_id IS NULL
        OR provider_customer_id ~ '^cus_[A-Za-z0-9]{8,}$'
    ),
    CONSTRAINT provisioning_request_provider_subscription_shape CHECK (
        provider_subscription_id IS NULL
        OR provider_subscription_id ~ '^sub_[A-Za-z0-9]{8,}$'
    ),
    CONSTRAINT provisioning_request_completion_state CHECK (
        (status = 'completed' AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND completed_at IS NULL)
    )
);

CREATE UNIQUE INDEX provisioning_request_one_open_per_device
    ON public.provisioning_request(device_id)
    WHERE status IN ('pending', 'creating', 'open', 'paid', 'claiming');

CREATE INDEX provisioning_request_user_created_at
    ON public.provisioning_request(user_id, created_at DESC);

CREATE INDEX provisioning_request_expiry
    ON public.provisioning_request(expires_at)
    WHERE status IN ('pending', 'creating', 'open');

ALTER TABLE public.provisioning_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.provisioning_request
    FROM anon, authenticated;

ALTER TABLE public.provisioning_session
    ADD COLUMN provisioning_request_id UUID
        REFERENCES public.provisioning_request(id) ON DELETE RESTRICT;

CREATE INDEX provisioning_session_request_id
    ON public.provisioning_session(provisioning_request_id)
    WHERE provisioning_request_id IS NOT NULL;

COMMENT ON TABLE public.provisioning_request IS
    'Backend-only, 30-minute payment gate for a physical tag. No finder key material is stored here.';
COMMENT ON COLUMN public.provisioning_request.expires_at IS
    'Checkout/request deadline. It is never extended beyond thirty minutes.';
COMMENT ON COLUMN public.provisioning_request.claim_deadline IS
    'Post-payment deadline for completing BLE key delivery and ownership claim.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.provisioning_request TO pinqeva_backend';
  END IF;
END;
$$;
