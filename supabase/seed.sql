-- Inserir Planos de Subscrição de teste
INSERT INTO public.plan (code, name, duration_months, price_cents, currency, active)
VALUES 
    ('monthly_basic', 'Plano Mensal', 1, 299, 'EUR', true),
    ('yearly_pro', 'Plano Anual', 12, 2999, 'EUR', true);

-- Inserir Dispositivos (Tags Bluetooth) de teste
INSERT INTO public.device (serial_number, name, status, firmware_version)
VALUES 
    ('PNQ-001', 'Pinqeva Tag - Chaves', 'active', '1.0.0'),
    ('PNQ-002', 'Pinqeva Tag - Mochila', 'inactive', '1.0.0'),
    ('PNQ-003', 'Pinqeva Tag - Carteira', 'testing', '1.0.1-beta');