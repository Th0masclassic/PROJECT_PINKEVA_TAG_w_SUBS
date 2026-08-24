-- Extend the existing least-privilege backend login after the admin schema is
-- present. Fresh Supabase projects may not have the role yet, so this remains
-- conditional; backend/sql/upgrade_runtime_role_admin.sql is the equivalent
-- operator command when the role is created later.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
    EXECUTE 'GRANT SELECT (id, display_name, email, stripe_customer_id, created_at, updated_at) ON TABLE public.profiles TO pinqeva_backend';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.plan TO pinqeva_backend';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.plan_price_history TO pinqeva_backend';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.device TO pinqeva_backend';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.device_bootstrap_credential TO pinqeva_backend';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription TO pinqeva_backend';
    EXECUTE 'GRANT SELECT ON TABLE public.ownership TO pinqeva_backend';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.subscription_cancellation_outbox TO pinqeva_backend';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_role_assignment TO pinqeva_backend';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.admin_audit_log TO pinqeva_backend';
    EXECUTE 'REVOKE DELETE ON TABLE public.admin_role_assignment, public.admin_audit_log FROM pinqeva_backend';
  END IF;
END;
$$;
