import type { BillingPlan, DeviceSubscription } from './types';

export const DEMO_BILLING_PLANS: BillingPlan[] = [
  {
    code: 'monthly_basic',
    name: 'Pinkeva Monthly',
    amountMinor: 299,
    currency: 'EUR',
    interval: 'month',
    intervalCount: 1,
    durationMonths: 1,
  },
  {
    code: 'quarterly_standard',
    name: 'Pinkeva 3 Months',
    amountMinor: 799,
    currency: 'EUR',
    interval: 'month',
    intervalCount: 3,
    durationMonths: 3,
  },
  {
    code: 'semiannual_plus',
    name: 'Pinkeva 6 Months',
    amountMinor: 1499,
    currency: 'EUR',
    interval: 'month',
    intervalCount: 6,
    durationMonths: 6,
  },
  {
    code: 'yearly_pro',
    name: 'Pinkeva Annual',
    amountMinor: 2999,
    currency: 'EUR',
    interval: 'year',
    intervalCount: 1,
    durationMonths: 12,
  },
];

const DEMO_PERIOD_START = '2026-08-12T12:00:00.000Z';
const DEMO_MONTH_END = '2026-09-12T12:00:00.000Z';
const DEMO_YEAR_END = '2026-12-14T12:00:00.000Z';

export function createDemoSubscription(deviceId: string): DeviceSubscription {
  const availablePlans = DEMO_BILLING_PLANS.map((plan) => ({ ...plan }));

  if (deviceId === 'pinkeva-card') {
    const plan = availablePlans[0];
    return {
      deviceId,
      status: 'active',
      planCode: plan.code,
      planName: plan.name,
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
      durationMonths: plan.durationMonths,
      currentPeriodStart: DEMO_PERIOD_START,
      currentPeriodEnd: DEMO_MONTH_END,
      cancelAtPeriodEnd: false,
      entitlementSyncStatus: 'installed',
      tagEntitlementExpiresAt: DEMO_MONTH_END,
      tagEntitlementUpdatedAt: DEMO_PERIOD_START,
      availablePlans,
    };
  }

  if (deviceId === 'backpack') {
    const plan = availablePlans[3];
    return {
      deviceId,
      status: 'active',
      planCode: plan.code,
      planName: plan.name,
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      interval: plan.interval,
      intervalCount: plan.intervalCount,
      durationMonths: plan.durationMonths,
      currentPeriodStart: '2025-12-14T12:00:00.000Z',
      currentPeriodEnd: DEMO_YEAR_END,
      cancelAtPeriodEnd: true,
      entitlementSyncStatus: 'installed',
      tagEntitlementExpiresAt: DEMO_YEAR_END,
      tagEntitlementUpdatedAt: DEMO_PERIOD_START,
      availablePlans,
    };
  }

  return {
    deviceId,
    status: 'none',
    planCode: null,
    planName: null,
    amountMinor: null,
    currency: null,
    interval: null,
    intervalCount: null,
    durationMonths: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    entitlementSyncStatus: null,
    tagEntitlementExpiresAt: null,
    tagEntitlementUpdatedAt: null,
    availablePlans,
  };
}
