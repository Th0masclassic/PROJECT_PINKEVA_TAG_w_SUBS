import type { SupabaseClient } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import {
  AUTH_CALLBACK_PATH,
  AUTH_RESET_PATH,
  AUTH_SCHEME,
  makeAuthBridgeRedirectUri,
} from './config';
import { AuthOperationError } from './authErrors';

WebBrowser.maybeCompleteAuthSession();

export function makeAuthRedirectUri(path = AUTH_CALLBACK_PATH): string {
  return makeRedirectUri({ scheme: AUTH_SCHEME, path });
}

/**
 * Confirmation and recovery emails use the hosted HTTPS bridge. This avoids
 * Safari treating a custom scheme as an invalid address when the email is
 * opened on a device that does not have this build installed. OAuth still
 * uses the native callback directly.
 */
export function makeAuthEmailRedirectUri(path = AUTH_CALLBACK_PATH): string {
  return makeAuthBridgeRedirectUri(path) ?? makeAuthRedirectUri(path);
}

export type ParsedAuthCallback = {
  code: string | null;
  errorCode: string | null;
  recovery: boolean;
};

export function parseAuthCallbackUrl(url: string): ParsedAuthCallback | null {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    const path = parsed.pathname.replace(/^\/+/, '');
    const isCustomScheme = protocol === `${AUTH_SCHEME}:`;
    const customPath = `${parsed.hostname}/${path}`.replace(/\/$/, '');
    const isWebScheme = protocol === 'https:' || protocol === 'http:';
    const webPath = path.replace(/\/$/, '');
    const isCallback = isCustomScheme
      ? customPath === AUTH_CALLBACK_PATH || customPath === AUTH_RESET_PATH
      : isWebScheme && (webPath === AUTH_CALLBACK_PATH || webPath === AUTH_RESET_PATH);

    if (!isCallback) return null;

    return {
      code: parsed.searchParams.get('code'),
      errorCode:
        parsed.searchParams.get('error_code') ??
        parsed.searchParams.get('error') ??
        null,
      recovery:
        customPath === AUTH_RESET_PATH ||
        webPath === AUTH_RESET_PATH ||
        parsed.searchParams.get('type') === 'recovery',
    };
  } catch {
    return null;
  }
}

export async function exchangeAuthCallback(
  client: SupabaseClient,
  url: string,
): Promise<{ handled: boolean; recovery: boolean }> {
  const callback = parseAuthCallbackUrl(url);
  if (!callback) return { handled: false, recovery: false };
  if (callback.errorCode) throw new AuthOperationError(callback.errorCode);
  if (!callback.code) throw new AuthOperationError('oauth_callback_missing_code');

  const { error } = await client.auth.exchangeCodeForSession(callback.code);
  if (error) throw error;
  return { handled: true, recovery: callback.recovery };
}

/** Returns a callback URL on success and null when the user dismisses the browser. */
export async function launchGoogleOAuth(client: SupabaseClient): Promise<string | null> {
  const redirectTo = makeAuthRedirectUri();
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      skipBrowserRedirect: true,
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error) throw error;
  if (!data.url) throw new AuthOperationError('oauth_provider_not_supported');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type === 'success') return result.url;
  if (result.type === 'cancel' || result.type === 'dismiss') return null;
  throw new AuthOperationError('auth_flow_cancelled');
}
