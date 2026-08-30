-- A Pinkeva subscription belongs to one customer account and unlocks premium
-- services for every tag currently owned by that account. device_id remains a
-- nullable historical checkout origin only; it is never an entitlement key.

ALTER TABLE public.subscription
  ALTER COLUMN device_id DROP NOT NULL;

ALTER TABLE public.subscription
  DROP CONSTRAINT IF EXISTS subscription_device_id_fkey,
  ADD CONSTRAINT subscription_device_id_fkey
    FOREIGN KEY (device_id) REFERENCES public.device(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS public.subscription_one_current_per_device;

-- An old development account may have bought more than one per-tag plan. Keep
-- the strongest/latest row as the account plan and safely queue every other
-- live Stripe subscription for cancellation instead of silently double billing.
ALTER TABLE public.subscription_cancellation_outbox
  DROP CONSTRAINT subscription_cancellation_reason_check,
  DROP CONSTRAINT subscription_cancellation_reason_binding,
  ADD CONSTRAINT subscription_cancellation_reason_check CHECK (
    cancellation_reason IN (
      'device_release', 'ownership_lost_checkout', 'admin_revoked',
      'account_consolidation', 'account_unavailable_checkout'
    )
  ),
  ADD CONSTRAINT subscription_cancellation_reason_binding CHECK (
    (cancellation_reason = 'device_release' AND device_release_id IS NOT NULL)
    OR
    (cancellation_reason IN (
       'ownership_lost_checkout', 'admin_revoked',
       'account_consolidation', 'account_unavailable_checkout'
     ) AND device_release_id IS NULL)
  );

WITH ranked AS (
  SELECT subscription.id,
         row_number() OVER (
           PARTITION BY subscription.user_id
           ORDER BY
             CASE subscription.status
               WHEN 'active' THEN 0 WHEN 'trialing' THEN 1 ELSE 2
             END,
             subscription.current_period_end DESC,
             subscription.created_at DESC,
             subscription.id DESC
         ) AS account_rank
    FROM public.subscription subscription
   WHERE subscription.status NOT IN ('cancelled', 'ended')
), ended AS (
  UPDATE public.subscription subscription
     SET status = 'ended',
         cancel_at_period_end = false,
         current_period_end = LEAST(subscription.current_period_end, now()),
         ended_reason = 'account_subscription_consolidated',
         updated_at = now()
    FROM ranked
   WHERE ranked.id = subscription.id
     AND ranked.account_rank > 1
  RETURNING subscription.id, subscription.provider_subscription_id
)
INSERT INTO public.subscription_cancellation_outbox (
  id, subscription_id, device_release_id, provider_subscription_id,
  cancellation_reason, status, next_attempt_at
)
SELECT gen_random_uuid(), ended.id, NULL, ended.provider_subscription_id,
       'account_consolidation', 'pending', now()
  FROM ended
 WHERE ended.provider_subscription_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX subscription_one_current_per_account
  ON public.subscription (user_id)
  WHERE status NOT IN ('cancelled', 'ended');

-- Checkout reservations are now account-scoped. Preserve an old device_id as
-- audit context, but new account Checkout sessions store NULL.
ALTER TABLE public.billing_checkout_session
  ALTER COLUMN device_id DROP NOT NULL;

DROP INDEX IF EXISTS public.billing_checkout_one_pending_per_device;

WITH ranked AS (
  SELECT checkout.id,
         row_number() OVER (
           PARTITION BY checkout.user_id
           ORDER BY checkout.created_at DESC, checkout.id DESC
         ) AS account_rank
    FROM public.billing_checkout_session checkout
   WHERE checkout.status IN ('creating', 'pending')
)
UPDATE public.billing_checkout_session checkout
   SET status = 'failed', updated_at = now()
  FROM ranked
 WHERE ranked.id = checkout.id AND ranked.account_rank > 1;

CREATE UNIQUE INDEX billing_checkout_one_pending_per_account
  ON public.billing_checkout_session (user_id)
  WHERE status IN ('creating', 'pending');

-- A user may reserve several unclaimed tags, but only one of those requests
-- may own a live Stripe Checkout at a time.
WITH ranked AS (
  SELECT request.id,
         row_number() OVER (
           PARTITION BY request.user_id
           ORDER BY request.updated_at DESC, request.id DESC
         ) AS account_rank
    FROM public.provisioning_request request
   WHERE request.status IN ('creating', 'open')
)
UPDATE public.provisioning_request request
   SET status = 'failed', updated_at = now()
  FROM ranked
 WHERE ranked.id = request.id AND ranked.account_rank > 1;

CREATE UNIQUE INDEX provisioning_checkout_one_open_per_account
  ON public.provisioning_request (user_id)
  WHERE status IN ('creating', 'open');

-- Renewal notices concern the account plan. Premium safety alerts remain tied
-- to the affected tracker but reference that same account subscription.
ALTER TABLE public.user_notification
  DROP CONSTRAINT user_notification_message_shape;

UPDATE public.user_notification notification
   SET device_id = NULL, updated_at = now()
 WHERE notification.kind IN ('renewal_7_days', 'renewal_1_day', 'expired');

ALTER TABLE public.user_notification
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
      AND device_id IS NULL
      AND subscription_id IS NOT NULL
      AND period_end IS NOT NULL
      AND admin_created_by IS NULL
      AND title IS NULL
      AND body IS NULL
      AND event_key IS NULL)
    OR (kind IN ('separation_detected', 'movement_detected')
      AND device_id IS NOT NULL
      AND subscription_id IS NOT NULL
      AND period_end IS NULL
      AND admin_created_by IS NULL
      AND title IS NOT NULL AND BTRIM(title) <> ''
      AND body IS NOT NULL AND BTRIM(body) <> ''
      AND event_key IS NOT NULL AND BTRIM(event_key) <> '')
  );

-- Shared helper used by backend queries and database-side safety evaluation.
CREATE OR REPLACE FUNCTION public.pinkeva_active_subscription_id(
  target_user_id UUID
)
RETURNS UUID AS $$
  SELECT subscription.id
    FROM public.subscription subscription
   WHERE subscription.user_id = target_user_id
     AND subscription.status IN ('active', 'trialing')
     AND subscription.starts_at <= now()
     AND subscription.current_period_end > now()
   ORDER BY subscription.current_period_end DESC,
            subscription.created_at DESC
   LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.pinkeva_active_subscription_id(UUID)
  FROM PUBLIC, anon, authenticated;

-- Keep the mature phone-aware alert algorithm intact while replacing its old
-- per-device entitlement lookup with the account helper above. PostgreSQL's
-- pg_get_functiondef can preserve line-ending/whitespace differences between
-- environments, so match the known SQL tokens while remaining strict about
-- the complete entitlement query being replaced.
DO $migration$
DECLARE
  function_definition TEXT;
  old_pattern TEXT := E'SELECT subscription[.]id[[:space:]]+INTO[[:space:]]+active_subscription_id[[:space:]]+FROM[[:space:]]+public[.]subscription[[:space:]]+subscription[[:space:]]+WHERE[[:space:]]+subscription[.]user_id[[:space:]]*=[[:space:]]*target_user_id[[:space:]]+AND[[:space:]]+subscription[.]device_id[[:space:]]*=[[:space:]]*target_device_id[[:space:]]+AND[[:space:]]+subscription[.]status[[:space:]]+IN[[:space:]]*[(][[:space:]]*(''active''[[:space:]]*,[[:space:]]*''trialing'')[[:space:]]*[)][[:space:]]+AND[[:space:]]+subscription[.]starts_at[[:space:]]*<=[[:space:]]*now[(][)][[:space:]]+AND[[:space:]]+subscription[.]current_period_end[[:space:]]*>[[:space:]]*now[(][)][[:space:]]+ORDER[[:space:]]+BY[[:space:]]+subscription[.]current_period_end[[:space:]]+DESC[[:space:]]*,[[:space:]]*subscription[.]created_at[[:space:]]+DESC[[:space:]]+LIMIT[[:space:]]+1[[:space:]]*;';
  new_fragment TEXT := E'  SELECT public.pinkeva_active_subscription_id(target_user_id)\n    INTO active_subscription_id;';
BEGIN
  SELECT pg_get_functiondef(
           'public.evaluate_tracker_safety(uuid,uuid,text)'::regprocedure
         )
    INTO function_definition;
  IF function_definition IS NULL
     OR function_definition !~ old_pattern THEN
    RAISE EXCEPTION 'evaluate_tracker_safety entitlement fragment changed';
  END IF;
  function_definition := regexp_replace(
    function_definition, old_pattern, new_fragment
  );
  IF function_definition ~ old_pattern THEN
    RAISE EXCEPTION 'evaluate_tracker_safety entitlement replacement incomplete';
  END IF;
  EXECUTE function_definition;
END;
$migration$;

COMMENT ON TABLE public.subscription IS
  'Account-level billing history. One current subscription unlocks premium services for every tracker currently owned by the account.';
COMMENT ON COLUMN public.subscription.device_id IS
  'Optional historical checkout-origin tag. Never used to decide premium access.';
COMMENT ON INDEX public.subscription_one_current_per_account IS
  'Allows account billing history while preventing two current subscriptions for one account.';
COMMENT ON TABLE public.billing_checkout_session IS
  'Backend-only account subscription Checkout reservations; device_id is nullable legacy audit context.';
COMMENT ON FUNCTION public.pinkeva_active_subscription_id(UUID) IS
  'Returns the one active/trialing account subscription whose paid period currently covers premium services.';
