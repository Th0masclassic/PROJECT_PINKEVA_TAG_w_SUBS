-- Stripe Checkout requires its expires_at timestamp to be at least 30 minutes
-- in the future. Allow an unpaid provisioning request to be renewed once while
-- preserving a bounded lifetime from its original creation.

ALTER TABLE public.provisioning_request
    DROP CONSTRAINT provisioning_request_expires_within_thirty_minutes;

ALTER TABLE public.provisioning_request
    ADD CONSTRAINT provisioning_request_expires_within_ninety_minutes
        CHECK (expires_at > created_at
               AND expires_at <= created_at + interval '90 minutes');

COMMENT ON TABLE public.provisioning_request IS
    'Backend-only, short-lived payment gate for a physical tag. No finder key material is stored here.';

COMMENT ON COLUMN public.provisioning_request.expires_at IS
    'Checkout/request deadline. Unpaid requests may be renewed within the bounded ninety-minute lifetime.';
