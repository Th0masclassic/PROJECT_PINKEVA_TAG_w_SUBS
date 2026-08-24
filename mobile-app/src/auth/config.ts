export const AUTH_SCHEME = 'com.pinkeva.mobile';
export const AUTH_CALLBACK_PATH = 'auth/callback';
export const AUTH_RESET_PATH = 'auth/reset';
export const AUTH_BRIDGE_FUNCTION_PATH = '/functions/v1/auth-callback';

export type SupabasePublicConfig = {
  url: string;
  publishableKey: string;
};

export function parseSupabasePublicConfig(
  urlValue: unknown,
  keyValue: unknown,
): SupabasePublicConfig | null {
  if (typeof urlValue !== 'string' || typeof keyValue !== 'string') return null;

  const url = urlValue.trim();
  const publishableKey = keyValue.trim();
  if (!url || !publishableKey) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  } catch {
    return null;
  }

  return { url: url.replace(/\/$/, ''), publishableKey };
}

// Expo only inlines EXPO_PUBLIC variables when accessed with direct dot notation.
export const SUPABASE_PUBLIC_CONFIG = parseSupabasePublicConfig(
  process.env.EXPO_PUBLIC_SUPABASE_URL,
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);

/**
 * Email links first land on an HTTPS page so Mail/Safari can open them even
 * when the native app is not installed on that device. The page then offers
 * a deliberate button to return to the app's custom URL scheme.
 */
export function makeAuthBridgeRedirectUri(path: string): string | null {
  if (!SUPABASE_PUBLIC_CONFIG) return null;
  const segment = path === AUTH_RESET_PATH ? 'reset' : 'signup';
  return `${SUPABASE_PUBLIC_CONFIG.url}${AUTH_BRIDGE_FUNCTION_PATH}/${segment}`;
}
