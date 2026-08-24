-- A subscription purchases service for one physical Pinqeva tag. The account
-- is retained as the payer/owner reference, but it is not the subscribed
-- resource: one account may therefore have one current subscription per tag.
--
-- Historical rows are preserved. In the existing state model, `cancelled` and
-- `ended` are terminal; every other status is current/nonterminal, including a
-- subscription that is trialling, active, past due, or scheduled to cancel at
-- the end of its paid period.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.subscription
    WHERE status NOT IN ('cancelled', 'ended')
    GROUP BY device_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'more than one current subscription exists for a device',
      HINT = 'End or cancel duplicate current subscriptions before applying this migration.';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_one_current_per_device
  ON public.subscription (device_id)
  WHERE status NOT IN ('cancelled', 'ended');

COMMENT ON TABLE public.subscription IS
  'Per-tag billing history. Each row belongs to one physical device; historical terminal rows are retained.';

COMMENT ON COLUMN public.subscription.device_id IS
  'The subscribed physical tag. At most one current/nonterminal subscription may exist per device.';

COMMENT ON COLUMN public.subscription.user_id IS
  'The account that pays for or owns this subscription; it does not make the subscription account-wide.';

COMMENT ON COLUMN public.subscription.status IS
  'Billing lifecycle status. cancelled and ended are terminal; all other values are current/nonterminal.';

COMMENT ON INDEX public.subscription_one_current_per_device IS
  'Allows subscription history while preventing two current subscriptions from billing the same tag.';
