import type { SupabaseClient } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';

import { AuthOperationError } from './authErrors';

const appleSignInEnabled = process.env.EXPO_PUBLIC_ENABLE_APPLE_SIGN_IN === 'true';

function fullName(
  name: AppleAuthentication.AppleAuthenticationFullName | null,
): { full_name: string; given_name: string | null; family_name: string | null } | null {
  if (!name) return null;
  const value = [name.givenName, name.middleName, name.familyName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .trim();
  if (!value) return null;
  return {
    full_name: value,
    given_name: name.givenName,
    family_name: name.familyName,
  };
}

export async function performNativeAppleSignIn(client: SupabaseClient): Promise<void> {
  if (!appleSignInEnabled || !(await AppleAuthentication.isAvailableAsync())) {
    throw new AuthOperationError('provider_not_available');
  }

  const rawNonce = Crypto.randomUUID();
  const hashedNonce = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
    { encoding: Crypto.CryptoEncoding.HEX },
  );
  const state = Crypto.randomUUID();
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
    nonce: hashedNonce,
    state,
  });
  if (credential.state !== state) {
    throw new AuthOperationError('oauth_callback_failed');
  }
  if (!credential.identityToken) {
    throw new AuthOperationError('apple_identity_token_missing');
  }

  const { error } = await client.auth.signInWithIdToken({
    provider: 'apple',
    token: credential.identityToken,
    nonce: rawNonce,
    access_token: credential.authorizationCode ?? undefined,
  });
  if (error) throw error;

  const metadata = fullName(credential.fullName);
  if (metadata) {
    const { error: updateError } = await client.auth.updateUser({ data: metadata });
    if (updateError) {
      // Authentication succeeded. A profile sync can retry later without exposing provider detail.
    }
  }
}

export function subscribeToAppleCredentialRevocation(listener: () => void): () => void {
  const subscription = AppleAuthentication.addRevokeListener(listener);
  return () => subscription.remove();
}
