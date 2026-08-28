export type BillingInterval = 'month' | 'year';

export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'paused'
  | 'incomplete'
  | 'incomplete_expired'
  | 'canceled'
  | 'ended'
  | 'unknown';

export type BillingPlan = {
  code: string;
  name: string;
  amountMinor: number;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  durationMonths: 1 | 3 | 6 | 12;
};

export type DeviceSubscription = {
  deviceId: string;
  status: SubscriptionStatus;
  planCode: string | null;
  planName: string | null;
  amountMinor: number | null;
  currency: string | null;
  interval: BillingInterval | null;
  intervalCount: number | null;
  durationMonths: 1 | 3 | 6 | 12 | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  availablePlans: BillingPlan[];
};

export type BillingErrorCode =
  | 'configuration'
  | 'authentication'
  | 'not_found'
  | 'rate_limited'
  | 'conflict'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'unavailable';

export type BillingActionResult =
  | { kind: 'opened' }
  | { kind: 'demo' }
  | { kind: 'disabled' }
  | { kind: 'error'; code: BillingErrorCode };

export type BillingMode = 'live' | 'demo' | 'unavailable';
export type BillingPortalAction = 'update' | 'cancel';

export function resolveBillingMode(
  hasApiConfiguration: boolean,
  hasAccessToken: boolean,
  demoPreviewEnabled: boolean,
): BillingMode {
  if (hasApiConfiguration && hasAccessToken) return 'live';
  if (demoPreviewEnabled) return 'demo';
  return 'unavailable';
}

export function isCurrentSubscription(subscription: DeviceSubscription): boolean {
  return !['none', 'canceled', 'ended', 'incomplete_expired', 'unknown'].includes(
    subscription.status,
  );
}

export function canStartCheckout(subscription: DeviceSubscription): boolean {
  return !isCurrentSubscription(subscription);
}
