-- 1. Tabela PROFILES (Substitui a tua tabela USER)
-- Estende a tabela auth.users gerida pelo Supabase
CREATE TABLE public.profiles (
    id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
    display_name VARCHAR,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabela DEVICE
CREATE TABLE public.device (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    serial_number VARCHAR UNIQUE NOT NULL,
    name VARCHAR,
    status VARCHAR,
    firmware_version VARCHAR,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabela OWNERSHIP
CREATE TABLE public.ownership (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    device_id UUID REFERENCES public.device(id) ON DELETE CASCADE NOT NULL,
    started_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    ended_at TIMESTAMPTZ
);

-- 4. Tabela PLAN
CREATE TABLE public.plan (
    code VARCHAR PRIMARY KEY,
    name VARCHAR NOT NULL,
    duration_months SMALLINT NOT NULL,
    price_cents INTEGER NOT NULL,
    currency CHAR(3) DEFAULT 'EUR' NOT NULL,
    active BOOLEAN DEFAULT TRUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Tabela SUBSCRIPTION
CREATE TABLE public.subscription (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    device_id UUID REFERENCES public.device(id) ON DELETE CASCADE NOT NULL,
    plan_code VARCHAR REFERENCES public.plan(code) NOT NULL,
    status VARCHAR NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,
    cancel_at_period_end BOOLEAN DEFAULT FALSE NOT NULL,
    provider_customer_id VARCHAR,
    provider_subscription_id VARCHAR UNIQUE,
    ended_reason VARCHAR,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Tabela INVOICE
CREATE TABLE public.invoice (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    subscription_id UUID REFERENCES public.subscription(id) ON DELETE CASCADE NOT NULL,
    provider_invoice_id VARCHAR UNIQUE,
    billing_reason VARCHAR,
    status VARCHAR NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    tax_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    amount_paid_cents INTEGER NOT NULL,
    currency CHAR(3) DEFAULT 'EUR' NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    attempt_count INTEGER DEFAULT 0 NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Tabela PAYMENT_EVENT
-- Utiliza uma chave primária composta (provider + event_id) para garantir unicidade
CREATE TABLE public.payment_event (
    provider VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    payload_sha256 CHAR(64) NOT NULL,
    status VARCHAR NOT NULL,
    received_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    processed_at TIMESTAMPTZ,
    event_data JSONB NOT NULL,
    PRIMARY KEY (provider, event_id)
);