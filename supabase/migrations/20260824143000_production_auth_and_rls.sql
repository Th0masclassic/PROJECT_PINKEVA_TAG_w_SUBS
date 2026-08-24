-- Production hardening for hosted Supabase Auth and Data API access.
-- Backend-only tables intentionally have no anon/authenticated policies.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  requested_name text;
BEGIN
  requested_name := COALESCE(
    NULLIF(BTRIM(new.raw_user_meta_data->>'display_name'), ''),
    NULLIF(BTRIM(new.raw_user_meta_data->>'full_name'), ''),
    NULLIF(BTRIM(new.raw_user_meta_data->>'name'), '')
  );

  INSERT INTO public.profiles (id, display_name)
  VALUES (new.id, requested_name)
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Hosted projects can already contain Auth users when this migration is first
-- applied. Keep profile foreign keys usable for those accounts as well.
INSERT INTO public.profiles (id, display_name)
SELECT
  user_record.id,
  COALESCE(
    NULLIF(BTRIM(user_record.raw_user_meta_data->>'display_name'), ''),
    NULLIF(BTRIM(user_record.raw_user_meta_data->>'full_name'), ''),
    NULLIF(BTRIM(user_record.raw_user_meta_data->>'name'), '')
  )
FROM auth.users AS user_record
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  new.updated_at := now();
  RETURN new;
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS device_set_updated_at ON public.device;
CREATE TRIGGER device_set_updated_at
  BEFORE UPDATE ON public.device
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS plan_set_updated_at ON public.plan;
CREATE TRIGGER plan_set_updated_at
  BEFORE UPDATE ON public.plan
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS subscription_set_updated_at ON public.subscription;
CREATE TRIGGER subscription_set_updated_at
  BEFORE UPDATE ON public.subscription
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS invoice_set_updated_at ON public.invoice;
CREATE TRIGGER invoice_set_updated_at
  BEFORE UPDATE ON public.invoice
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provisioning_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_cancellation_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_bootstrap_credential ENABLE ROW LEVEL SECURITY;

-- The prototype device policy also matched historical ownership rows. Once a
-- tag is released, its former owner must immediately lose Data API access to
-- the device projection even though the ownership history is retained.
DROP POLICY IF EXISTS "Ver os próprios dispositivos" ON public.device;
CREATE POLICY "Ver os próprios dispositivos" ON public.device
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.ownership o
      WHERE o.device_id = device.id
        AND o.user_id = auth.uid()
        AND o.ended_at IS NULL
    )
  );

DROP POLICY IF EXISTS "Read active plans" ON public.plan;
CREATE POLICY "Read active plans" ON public.plan
  FOR SELECT TO anon, authenticated
  USING (active = true);

DROP POLICY IF EXISTS "Read own subscriptions" ON public.subscription;
CREATE POLICY "Read own subscriptions" ON public.subscription
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Read own invoices" ON public.invoice;
CREATE POLICY "Read own invoices" ON public.invoice
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.subscription s
      WHERE s.id = invoice.subscription_id
        AND s.user_id = auth.uid()
    )
  );

-- Start from no Data API privileges, then expose only deliberate projections.
REVOKE ALL PRIVILEGES ON TABLE
  public.profiles,
  public.device,
  public.ownership,
  public.plan,
  public.subscription,
  public.invoice,
  public.payment_event,
  public.provisioning_session,
  public.device_release,
  public.subscription_cancellation_outbox,
  public.device_bootstrap_credential
FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT (id, display_name, created_at, updated_at)
  ON TABLE public.profiles TO authenticated;
GRANT UPDATE (display_name)
  ON TABLE public.profiles TO authenticated;

GRANT SELECT (id, user_id, device_id, started_at, ended_at)
  ON TABLE public.ownership TO authenticated;

GRANT SELECT (
  id, serial_number, name, status, firmware_version, created_at, updated_at
) ON TABLE public.device TO authenticated;

GRANT SELECT (code, name, duration_months, price_cents, currency, active)
  ON TABLE public.plan TO anon, authenticated;

GRANT SELECT (
  id, user_id, device_id, plan_code, status, starts_at, current_period_end,
  cancel_at_period_end, ended_reason, created_at, updated_at
) ON TABLE public.subscription TO authenticated;

GRANT SELECT (
  id, subscription_id, billing_reason, status, subtotal_cents, tax_cents,
  total_cents, amount_paid_cents, currency, period_start, period_end,
  issued_at, paid_at, attempt_count, created_at, updated_at
) ON TABLE public.invoice TO authenticated;

-- The database is fresh when these migrations are first deployed, so the
-- earlier NOT VALID constraint can be validated without deleting user data.
ALTER TABLE public.device VALIDATE CONSTRAINT device_serial_number_format;

COMMENT ON POLICY "Read active plans" ON public.plan IS
  'Only public product information for currently active plans is exposed.';
COMMENT ON TABLE public.payment_event IS
  'Backend-only payment webhook payloads; never exposed through the Data API.';
