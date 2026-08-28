-- Account access is a first-class state. Administrators can suspend a customer
-- account without deleting its billing or tracker history, while the customer
-- retains access to their own profile row so the app can explain the state.

ALTER TABLE public.profiles
  ADD COLUMN account_status VARCHAR(16) NOT NULL DEFAULT 'active',
  ADD COLUMN banned_at TIMESTAMPTZ,
  ADD COLUMN banned_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT,
  ADD COLUMN ban_reason VARCHAR(240);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_account_status_check
    CHECK (account_status IN ('active', 'banned')),
  ADD CONSTRAINT profiles_account_ban_shape CHECK (
    (account_status = 'active'
      AND banned_at IS NULL
      AND banned_by IS NULL
      AND ban_reason IS NULL)
    OR (account_status = 'banned'
      AND banned_at IS NOT NULL
      AND banned_by IS NOT NULL
      AND ban_reason IS NOT NULL
      AND BTRIM(ban_reason) <> '')
  );

CREATE INDEX profiles_banned_accounts
  ON public.profiles (banned_at DESC, id)
  WHERE account_status = 'banned';

-- This SECURITY DEFINER predicate avoids a recursive profiles RLS lookup and
-- makes the same active-account requirement usable across all customer-facing
-- Data API projections.
CREATE OR REPLACE FUNCTION public.is_pinkeva_account_active()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = auth.uid()
       AND account_status = 'active'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.is_pinkeva_account_active()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_pinkeva_account_active() TO authenticated;

DROP POLICY IF EXISTS "Atualizar o próprio perfil" ON public.profiles;
CREATE POLICY "Atualizar o próprio perfil" ON public.profiles
  FOR UPDATE TO authenticated
  USING (auth.uid() = id AND public.is_pinkeva_account_active())
  WITH CHECK (auth.uid() = id AND public.is_pinkeva_account_active());

DROP POLICY IF EXISTS "Ver a própria posse de tags" ON public.ownership;
CREATE POLICY "Ver a própria posse de tags" ON public.ownership
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND public.is_pinkeva_account_active());

DROP POLICY IF EXISTS "Ver os próprios dispositivos" ON public.device;
CREATE POLICY "Ver os próprios dispositivos" ON public.device
  FOR SELECT TO authenticated
  USING (
    public.is_pinkeva_account_active()
    AND EXISTS (
      SELECT 1
        FROM public.ownership o
       WHERE o.device_id = device.id
         AND o.user_id = auth.uid()
         AND o.ended_at IS NULL
    )
  );

DROP POLICY IF EXISTS "Read own subscriptions" ON public.subscription;
CREATE POLICY "Read own subscriptions" ON public.subscription
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND public.is_pinkeva_account_active());

DROP POLICY IF EXISTS "Read own invoices" ON public.invoice;
CREATE POLICY "Read own invoices" ON public.invoice
  FOR SELECT TO authenticated
  USING (
    public.is_pinkeva_account_active()
    AND EXISTS (
      SELECT 1
        FROM public.subscription s
       WHERE s.id = invoice.subscription_id
         AND s.user_id = auth.uid()
    )
  );

-- Administrator messages live alongside renewal notices, but are not tied to
-- a subscription. They receive exactly the same durable inbox and push retry
-- behavior as an automated notice.
ALTER TABLE public.user_notification
  ALTER COLUMN device_id DROP NOT NULL,
  ALTER COLUMN subscription_id DROP NOT NULL,
  ALTER COLUMN period_end DROP NOT NULL,
  ADD COLUMN title VARCHAR(120),
  ADD COLUMN body VARCHAR(320),
  ADD COLUMN admin_created_by UUID REFERENCES public.profiles(id) ON DELETE RESTRICT;

ALTER TABLE public.user_notification
  DROP CONSTRAINT user_notification_kind_check,
  ADD CONSTRAINT user_notification_kind_check CHECK (
    kind IN (
      'renewal_7_days',
      'renewal_1_day',
      'expired',
      'tag_sync_required',
      'admin_message'
    )
  ),
  ADD CONSTRAINT user_notification_message_shape CHECK (
    (kind = 'admin_message'
      AND device_id IS NULL
      AND subscription_id IS NULL
      AND period_end IS NULL
      AND admin_created_by IS NOT NULL
      AND title IS NOT NULL
      AND BTRIM(title) <> ''
      AND body IS NOT NULL
      AND BTRIM(body) <> '')
    OR (kind <> 'admin_message'
      AND device_id IS NOT NULL
      AND subscription_id IS NOT NULL
      AND period_end IS NOT NULL
      AND admin_created_by IS NULL
      AND title IS NULL
      AND body IS NULL)
  );

CREATE INDEX user_notification_admin_message_due
  ON public.user_notification (due_at, id)
  WHERE kind = 'admin_message' AND push_status IN ('pending', 'retry');

-- The runtime account needs only the new profile columns required by the
-- protected Admin routes; customers still receive their narrow projection.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
    EXECUTE 'GRANT SELECT (id, display_name, email, stripe_customer_id, '
      || 'created_at, updated_at, account_status, banned_at, banned_by, ban_reason) '
      || 'ON TABLE public.profiles TO pinqeva_backend';
    EXECUTE 'GRANT UPDATE (account_status, banned_at, banned_by, ban_reason) '
      || 'ON TABLE public.profiles TO pinqeva_backend';
  END IF;
END;
$$;

GRANT SELECT (id, display_name, created_at, updated_at, account_status)
  ON TABLE public.profiles TO authenticated;

COMMENT ON COLUMN public.profiles.account_status IS
  'Customer account access state. Banned accounts are blocked in API authentication and Data API resource policies.';
COMMENT ON COLUMN public.user_notification.admin_created_by IS
  'Administrator who authored a customer message; null for automatic renewal notices.';
