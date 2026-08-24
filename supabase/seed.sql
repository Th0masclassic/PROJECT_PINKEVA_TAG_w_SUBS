-- Local development data only. Never apply this seed to production.
INSERT INTO public.plan (code, name, duration_months, price_cents, currency, active)
VALUES 
    ('monthly_basic', 'Pinkeva 1 Month', 1, 299, 'EUR', true),
    ('quarterly_standard', 'Pinkeva 3 Months', 3, 799, 'EUR', true),
    ('semiannual_plus', 'Pinkeva 6 Months', 6, 1499, 'EUR', true),
    ('yearly_pro', 'Pinkeva 12 Months', 12, 2699, 'EUR', true)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    duration_months = EXCLUDED.duration_months,
    price_cents = EXCLUDED.price_cents,
    currency = EXCLUDED.currency,
    active = EXCLUDED.active;

-- Devices are deliberately not seeded. A usable device must be registered by
-- the controlled manufacturing tool so its bootstrap credential and hardware
-- NVS key are created as one operation.
