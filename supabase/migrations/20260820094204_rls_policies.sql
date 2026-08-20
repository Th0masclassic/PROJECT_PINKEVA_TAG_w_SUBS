-- 1. Ativar o RLS 
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device ENABLE ROW LEVEL SECURITY;

-- 2. Regra para Profiles: Um utilizador só pode ver e alterar o seu próprio perfil
CREATE POLICY "Ver o próprio perfil" ON public.profiles 
FOR SELECT USING ( auth.uid() = id );

CREATE POLICY "Atualizar o próprio perfil" ON public.profiles 
FOR UPDATE USING ( auth.uid() = id );

-- 3. O utilizador só vê as tags associadas a si
CREATE POLICY "Ver a própria posse de tags" ON public.ownership 
FOR SELECT USING ( auth.uid() = user_id );

-- 4. O utilizador só vê dispositivos que estejam na sua lista de ownership
CREATE POLICY "Ver os próprios dispositivos" ON public.device 
FOR SELECT USING (
    id IN (
        SELECT device_id 
        FROM public.ownership 
        WHERE user_id = auth.uid()
    )
);