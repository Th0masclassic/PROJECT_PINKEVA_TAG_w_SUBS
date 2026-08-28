export type AdminPublicConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  apiUrl: string;
};

export function parseHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function parseAdminPublicConfig(input: {
  supabaseUrl: unknown;
  supabasePublishableKey: unknown;
  apiUrl: unknown;
}): AdminPublicConfig | null {
  const supabaseUrl = parseHttpsUrl(input.supabaseUrl);
  const apiUrl = parseHttpsUrl(input.apiUrl);
  const supabasePublishableKey =
    typeof input.supabasePublishableKey === 'string'
      ? input.supabasePublishableKey.trim()
      : '';
  if (!supabaseUrl || !apiUrl || !supabasePublishableKey) return null;
  return { supabaseUrl, supabasePublishableKey, apiUrl };
}

// Expo inlines EXPO_PUBLIC variables only when they are accessed directly.
export const ADMIN_PUBLIC_CONFIG = parseAdminPublicConfig({
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  apiUrl: process.env.EXPO_PUBLIC_API_URL,
});
