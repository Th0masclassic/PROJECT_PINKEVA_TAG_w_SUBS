type PublicConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  apiUrl: string;
  googleMapsKey: string;
  googleMapId?: string;
};

function httpsOrLoopback(name: string, raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${name} is missing`);
  const url = new URL(raw.trim());
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} is invalid`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS`);
  }
  return url.toString().replace(/\/$/, '');
}

export function getPublicConfig(): PublicConfig {
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const mapsKey = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_API_KEY;
  if (typeof publishableKey !== 'string' || !publishableKey.trim()) {
    throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY is missing');
  }
  if (typeof mapsKey !== 'string' || !mapsKey.trim()) {
    throw new Error('VITE_GOOGLE_MAPS_BROWSER_API_KEY is missing');
  }
  return {
    supabaseUrl: httpsOrLoopback('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL),
    supabasePublishableKey: publishableKey.trim(),
    apiUrl: httpsOrLoopback('VITE_API_URL', import.meta.env.VITE_API_URL),
    googleMapsKey: mapsKey.trim(),
    googleMapId: import.meta.env.VITE_GOOGLE_MAP_ID?.trim() || undefined,
  };
}
