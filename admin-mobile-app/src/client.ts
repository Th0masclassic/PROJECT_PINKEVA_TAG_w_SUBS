import 'react-native-url-polyfill/auto';

import { createClient } from '@supabase/supabase-js';

import { ADMIN_PUBLIC_CONFIG } from './config';
import { secureAdminStorage } from './storage';

export const supabase = ADMIN_PUBLIC_CONFIG
  ? createClient(
      ADMIN_PUBLIC_CONFIG.supabaseUrl,
      ADMIN_PUBLIC_CONFIG.supabasePublishableKey,
      {
        auth: {
          storage: secureAdminStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
          flowType: 'pkce',
        },
      },
    )
  : null;
