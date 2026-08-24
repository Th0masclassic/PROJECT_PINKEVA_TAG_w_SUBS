import {
  createClient,
  type SupabaseClient,
  type SupabaseClientOptions,
} from '@supabase/supabase-js';

import { SUPABASE_PUBLIC_CONFIG } from './config';
import type { AuthStorage } from './chunkedStorage';

export function createPinkevaSupabaseClient(storage: AuthStorage): SupabaseClient | null {
  if (!SUPABASE_PUBLIC_CONFIG) return null;

  const options: SupabaseClientOptions<'public'> = {
    auth: {
      storage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  };

  return createClient(
    SUPABASE_PUBLIC_CONFIG.url,
    SUPABASE_PUBLIC_CONFIG.publishableKey,
    options,
  );
}
