import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';

import { App } from './App';
import { getPublicConfig } from './config';
import './styles.css';

const config = getPublicConfig();
const supabase = createClient(config.supabaseUrl, config.supabasePublishableKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={supabase} config={config} />
  </StrictMode>,
);
