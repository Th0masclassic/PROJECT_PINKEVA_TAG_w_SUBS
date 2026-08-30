-- Correct the account entitlement helper name used by the location worker.
-- The first account-level migration accidentally created the helper with
-- "pinkeva" while the application consistently calls it "pinqeva".

CREATE OR REPLACE FUNCTION public.pinqeva_active_subscription_id(
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

REVOKE EXECUTE ON FUNCTION public.pinqeva_active_subscription_id(UUID)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.pinqeva_active_subscription_id(UUID) IS
  'Returns the one active/trialing account subscription whose paid period currently covers premium services.';

-- The already-applied migration may have rewritten the safety function with
-- the misspelled helper. Replace only that qualified function reference, then
-- remove the unused typo so fresh and upgraded databases have one canonical API.
DO $migration$
DECLARE
  function_definition TEXT;
  old_name CONSTANT TEXT := 'public.pinkeva_active_subscription_id(';
  new_name CONSTANT TEXT := 'public.pinqeva_active_subscription_id(';
BEGIN
  SELECT pg_get_functiondef(
           'public.evaluate_tracker_safety(uuid,uuid,text)'::regprocedure
         )
    INTO function_definition;
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'evaluate_tracker_safety function is missing';
  END IF;
  IF position(old_name IN function_definition) > 0 THEN
    EXECUTE replace(function_definition, old_name, new_name);
  END IF;
END;
$migration$;

DROP FUNCTION IF EXISTS public.pinkeva_active_subscription_id(UUID);
