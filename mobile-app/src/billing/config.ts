export type BillingApiConfig = {
  baseUrl: string;
};

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function parseSafeUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;

  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url;
  } catch {
    return null;
  }

  return null;
}

export function parseBillingApiConfig(value: unknown): BillingApiConfig | null {
  const url = parseSafeUrl(value);
  if (!url || url.search || url.hash) return null;

  return { baseUrl: url.toString().replace(/\/$/, '') };
}

// Expo only inlines EXPO_PUBLIC variables when accessed with direct dot notation.
export const BILLING_API_CONFIG = parseBillingApiConfig(
  process.env.EXPO_PUBLIC_API_URL,
);
