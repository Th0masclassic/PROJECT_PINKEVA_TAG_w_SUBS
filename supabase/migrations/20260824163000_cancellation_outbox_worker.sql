-- Reliable provider cancellation delivery for completed device releases.
-- Provider calls are made by a separately deployed worker. A successful API
-- request moves the row to awaiting_webhook; only a later signed Stripe
-- subscription webhook may mark it completed.

ALTER TABLE public.subscription
  ADD COLUMN IF NOT EXISTS provider_terminal_event_at TIMESTAMPTZ;

ALTER TABLE public.subscription_cancellation_outbox
  ALTER COLUMN device_release_id DROP NOT NULL;

ALTER TABLE public.subscription_cancellation_outbox
  ADD COLUMN IF NOT EXISTS cancellation_reason VARCHAR(32)
    NOT NULL DEFAULT 'device_release',
  ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(128),
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS webhook_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS webhook_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.subscription_cancellation_outbox
  ADD CONSTRAINT subscription_cancellation_reason_check
  CHECK (
    cancellation_reason IN ('device_release', 'ownership_lost_checkout')
  ) NOT VALID;

ALTER TABLE public.subscription_cancellation_outbox
  VALIDATE CONSTRAINT subscription_cancellation_reason_check;

ALTER TABLE public.subscription_cancellation_outbox
  ADD CONSTRAINT subscription_cancellation_reason_binding
  CHECK (
    (
      cancellation_reason = 'device_release'
      AND device_release_id IS NOT NULL
    )
    OR
    (
      cancellation_reason = 'ownership_lost_checkout'
      AND device_release_id IS NULL
    )
  ) NOT VALID;

ALTER TABLE public.subscription_cancellation_outbox
  VALIDATE CONSTRAINT subscription_cancellation_reason_binding;

CREATE UNIQUE INDEX IF NOT EXISTS
  subscription_cancellation_one_ownership_lost_checkout
  ON public.subscription_cancellation_outbox (subscription_id)
  WHERE cancellation_reason = 'ownership_lost_checkout';

ALTER TABLE public.subscription_cancellation_outbox
  DROP CONSTRAINT IF EXISTS subscription_cancellation_outbox_status_check;

ALTER TABLE public.subscription_cancellation_outbox
  ADD CONSTRAINT subscription_cancellation_outbox_status_check
  CHECK (
    status IN (
      'pending', 'processing', 'awaiting_webhook', 'completed', 'failed'
    )
  );

-- The prototype schema allowed processing rows without a recoverable lease and
-- completed rows without proof of webhook confirmation. Recover the former for
-- retry and quarantine the latter for an audited reconciliation rather than
-- manufacturing confirmation evidence during migration.
UPDATE public.subscription_cancellation_outbox
   SET status = 'pending',
       next_attempt_at = LEAST(next_attempt_at, now()),
       last_error_code = 'LEASE_RECOVERED_DURING_MIGRATION',
       completed_at = NULL,
       updated_at = now()
 WHERE status = 'processing';

UPDATE public.subscription_cancellation_outbox
   SET status = 'failed',
       last_error_code = 'LEGACY_COMPLETION_REQUIRES_RECONCILIATION',
       completed_at = NULL,
       updated_at = now()
 WHERE status = 'completed';

UPDATE public.subscription_cancellation_outbox
   SET completed_at = NULL,
       updated_at = now()
 WHERE status <> 'completed'
   AND completed_at IS NOT NULL;

ALTER TABLE public.subscription_cancellation_outbox
  ADD CONSTRAINT subscription_cancellation_processing_lease_state
  CHECK (
    (status = 'processing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'processing' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ) NOT VALID;

ALTER TABLE public.subscription_cancellation_outbox
  VALIDATE CONSTRAINT subscription_cancellation_processing_lease_state;

ALTER TABLE public.subscription_cancellation_outbox
  ADD CONSTRAINT subscription_cancellation_awaiting_webhook_state
  CHECK (
    status <> 'awaiting_webhook'
    OR (
      cancellation_requested_at IS NOT NULL
      AND webhook_deadline_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE public.subscription_cancellation_outbox
  VALIDATE CONSTRAINT subscription_cancellation_awaiting_webhook_state;

ALTER TABLE public.subscription_cancellation_outbox
  ADD CONSTRAINT subscription_cancellation_completion_state
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND webhook_confirmed_at IS NOT NULL)
    OR
    (status <> 'completed' AND completed_at IS NULL AND webhook_confirmed_at IS NULL)
  ) NOT VALID;

ALTER TABLE public.subscription_cancellation_outbox
  VALIDATE CONSTRAINT subscription_cancellation_completion_state;

CREATE INDEX IF NOT EXISTS subscription_cancellation_pending_due
  ON public.subscription_cancellation_outbox (next_attempt_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS subscription_cancellation_expired_leases
  ON public.subscription_cancellation_outbox (lease_expires_at, id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS subscription_cancellation_webhook_deadlines
  ON public.subscription_cancellation_outbox (webhook_deadline_at, id)
  WHERE status = 'awaiting_webhook';

CREATE UNIQUE INDEX IF NOT EXISTS
  subscription_cancellation_one_open_job_per_subscription
  ON public.subscription_cancellation_outbox (subscription_id)
  WHERE status IN ('pending', 'processing', 'awaiting_webhook');

-- provider_terminal_event_at is written only when an authenticated,
-- signature-verified Stripe webhook reports a provider-terminal subscription.
-- A locally forced `ended` state for a released tag or ownership-lost Checkout
-- leaves it NULL and therefore cannot acknowledge its own compensation job.
CREATE OR REPLACE FUNCTION public.confirm_subscription_cancellation_from_webhook()
RETURNS trigger AS $$
BEGIN
  IF new.provider_subscription_id IS NOT NULL
     AND new.status IN ('cancelled', 'ended')
     AND new.provider_terminal_event_at IS NOT NULL
     AND old.provider_terminal_event_at IS DISTINCT FROM new.provider_terminal_event_at
  THEN
    UPDATE public.subscription_cancellation_outbox
       SET status = 'completed',
           completed_at = now(),
           webhook_confirmed_at = now(),
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error_code = NULL,
           updated_at = now()
     WHERE subscription_id = new.id
       AND provider_subscription_id = new.provider_subscription_id
       AND (
         status IN ('pending', 'processing', 'awaiting_webhook')
         OR (
           status = 'failed'
           AND last_error_code IN (
             'WEBHOOK_CONFIRMATION_TIMEOUT',
             'PROVIDER_SUBSCRIPTION_NOT_FOUND',
             'LEGACY_COMPLETION_REQUIRES_RECONCILIATION'
           )
         )
       );
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.confirm_subscription_cancellation_from_webhook()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subscription_cancellation_webhook_confirmation
  ON public.subscription;

CREATE TRIGGER subscription_cancellation_webhook_confirmation
  AFTER UPDATE OF status, provider_terminal_event_at ON public.subscription
  FOR EACH ROW
  EXECUTE FUNCTION public.confirm_subscription_cancellation_from_webhook();

-- Close the ordering race where signed terminal evidence is committed before
-- (or earlier in the same transaction as) the compensating outbox insert.
CREATE OR REPLACE FUNCTION public.confirm_new_cancellation_from_prior_webhook()
RETURNS trigger AS $$
BEGIN
  UPDATE public.subscription_cancellation_outbox queue
     SET status = 'completed',
         completed_at = now(),
         webhook_confirmed_at = now(),
         last_error_code = NULL,
         updated_at = now()
    FROM public.subscription subscription
   WHERE queue.id = new.id
     AND queue.subscription_id = subscription.id
     AND queue.provider_subscription_id = subscription.provider_subscription_id
     AND queue.status = 'pending'
     AND subscription.status IN ('cancelled', 'ended')
     AND subscription.provider_terminal_event_at IS NOT NULL;
  RETURN new;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.confirm_new_cancellation_from_prior_webhook()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cancellation_outbox_prior_webhook_confirmation
  ON public.subscription_cancellation_outbox;

CREATE TRIGGER cancellation_outbox_prior_webhook_confirmation
  AFTER INSERT ON public.subscription_cancellation_outbox
  FOR EACH ROW
  EXECUTE FUNCTION public.confirm_new_cancellation_from_prior_webhook();

COMMENT ON TABLE public.subscription_cancellation_outbox IS
  'Backend-only retry queue for cancelling a released or former-owner tag subscription at its billing provider.';
COMMENT ON COLUMN public.subscription.provider_terminal_event_at IS
  'Timestamp of a signed webhook that explicitly reported a provider-terminal subscription; never set for a local compensating end.';
COMMENT ON COLUMN public.subscription_cancellation_outbox.cancellation_reason IS
  'device_release requires a release row; ownership_lost_checkout compensates a late Checkout without fabricating one.';
COMMENT ON COLUMN public.subscription_cancellation_outbox.lease_owner IS
  'Opaque worker instance identifier holding the short processing lease.';
COMMENT ON COLUMN public.subscription_cancellation_outbox.cancellation_requested_at IS
  'Time Stripe accepted the idempotent immediate-cancellation request.';
COMMENT ON COLUMN public.subscription_cancellation_outbox.webhook_confirmed_at IS
  'Time a signed provider webhook confirmed that the provider subscription is terminal.';
