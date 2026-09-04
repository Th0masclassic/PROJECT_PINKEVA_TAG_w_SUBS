-- Operator-managed credentials. Run with a migration/admin database role.
BEGIN;

CREATE TABLE IF NOT EXISTS public.upstream_apple_session (
    account_key text PRIMARY KEY CHECK (length(account_key) BETWEEN 1 AND 128),
    anisette_endpoint text NOT NULL CHECK (length(anisette_endpoint) BETWEEN 1 AND 2048),
    encrypted_session bytea NOT NULL CHECK (octet_length(encrypted_session) BETWEEN 30 AND 32768),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- No credentials here: workers can invalidate the revision they actually
-- used, while only the coordinator/operator can replace encrypted tokens.
CREATE TABLE IF NOT EXISTS public.upstream_apple_session_status (
    account_key text PRIMARY KEY CHECK (length(account_key) BETWEEN 1 AND 128),
    session_revision bigint NOT NULL DEFAULT 0 CHECK (session_revision >= 0),
    phase text NOT NULL DEFAULT 'not_initialized' CHECK (phase IN (
        'not_initialized', 'authenticating', 'session_unverified', 'ready',
        'recovering', 'needs_attention', 'upstream_unavailable'
    )),
    failures integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 30),
    next_attempt_at timestamptz,
    last_error text CHECK (last_error ~ '^[a-z0-9_]{1,80}$'),
    last_http_status integer CHECK (last_http_status BETWEEN 100 AND 599),
    last_verified_at timestamptz,
    last_login_at timestamptz,
    lease_token uuid,
    lease_expires_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

ALTER TABLE public.upstream_apple_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upstream_apple_session_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.upstream_apple_session FROM PUBLIC;
REVOKE ALL ON public.upstream_apple_session_status FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.upstream_apple_session FROM anon;
        REVOKE ALL ON public.upstream_apple_session_status FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.upstream_apple_session FROM authenticated;
        REVOKE ALL ON public.upstream_apple_session_status FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pinqeva_backend') THEN
        GRANT SELECT ON public.upstream_apple_session TO pinqeva_backend;
        GRANT SELECT, INSERT, UPDATE ON public.upstream_apple_session_status TO pinqeva_backend;
        -- The documented backend role has BYPASSRLS. A custom worker role
        -- without BYPASSRLS needs an equivalent SELECT policy and grant.
    END IF;
END $$;

COMMENT ON TABLE public.upstream_apple_session IS
    'AES-GCM encrypted Apple session; write only through an operator role. Stable Anisette endpoint affinity.';
COMMIT;
