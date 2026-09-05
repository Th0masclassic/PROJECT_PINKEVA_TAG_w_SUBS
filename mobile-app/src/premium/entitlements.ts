import type { PremiumFeatureAccess } from './api';

export function canUseSafeZones(
  features: Pick<PremiumFeatureAccess, 'subscriptionActive' | 'safeZones'> | undefined,
): boolean {
  return Boolean(features?.subscriptionActive && features.safeZones);
}
