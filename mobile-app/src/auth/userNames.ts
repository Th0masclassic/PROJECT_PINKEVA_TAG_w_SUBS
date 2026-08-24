import type { User } from '@supabase/supabase-js';

function normalizedName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 80) : null;
}

export function getUserDisplayName(user: User | null): string | null {
  if (!user) return null;
  return (
    normalizedName(user.user_metadata.full_name) ??
    normalizedName(user.user_metadata.name) ??
    normalizedName(user.user_metadata.display_name)
  );
}

export function getUserFirstName(user: User | null): string | null {
  const displayName = getUserDisplayName(user);
  return displayName?.split(' ')[0] ?? null;
}
