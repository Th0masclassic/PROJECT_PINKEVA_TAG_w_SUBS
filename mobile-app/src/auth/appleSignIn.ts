import type { SupabaseClient } from '@supabase/supabase-js';

import { AuthOperationError } from './authErrors';

export async function performNativeAppleSignIn(_client: SupabaseClient): Promise<void> {
  throw new AuthOperationError('provider_not_available');
}

export function subscribeToAppleCredentialRevocation(_listener: () => void): () => void {
  return () => undefined;
}
