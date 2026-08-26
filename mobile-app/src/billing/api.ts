import type { BillingApiConfig } from './config';
import type {
  BillingErrorCode,
  BillingInterval,
  BillingPlan,
  BillingPortalAction,
  DeviceSubscription,
  SubscriptionStatus,
} from './types';

const REQUEST_TIMEOUT_MS = 15_000;
const PLAN_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseBillingDestination(value: unknown, expectedHost: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return null;
    if (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === expectedHost &&
      url.port === ''
    ) {
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export class BillingApiError extends Error {
  readonly code: BillingErrorCode;
  readonly status?: number;

  constructor(code: BillingErrorCode, status?: number) {
    super(code);
    this.name = 'BillingApiError';
    this.code = code;
    this.status = status;
  }
}

function errorCodeForStatus(status: number): BillingErrorCode {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

export function safeBillingErrorCode(error: unknown): BillingErrorCode {
  if (error instanceof BillingApiError) return error.code;
  if (error instanceof DOMException && error.name === 'AbortError') return 'timeout';
  return 'network';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nullableString(value: unknown, maxLength = 160): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function nullableDate(value: unknown): string | null {
  const text = nullableString(value, 64);
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return text;
}

function parseInterval(value: unknown): BillingInterval | null {
  if (value === 'month' || value === 'monthly') return 'month';
  if (value === 'year' || value === 'yearly' || value === 'annual') return 'year';
  return null;
}

function parseStatus(value: unknown): SubscriptionStatus {
  if (value === 'cancelled') return 'canceled';
  if (
    value === 'none' ||
    value === 'trialing' ||
    value === 'active' ||
    value === 'past_due' ||
    value === 'unpaid' ||
    value === 'paused' ||
    value === 'incomplete' ||
    value === 'incomplete_expired' ||
    value === 'canceled' ||
    value === 'ended'
  ) {
    return value;
  }
  return 'unknown';
}

function parseEntitlementSyncStatus(
  value: unknown,
): DeviceSubscription['entitlementSyncStatus'] {
  if (value === null || value === undefined) return null;
  if (value === 'pending' || value === 'issued' || value === 'installed') {
    return value;
  }
  throw new BillingApiError('invalid_response');
}

function parsePlan(value: unknown): BillingPlan | null {
  if (!isRecord(value)) return null;
  const code = nullableString(value.code, 80);
  const name = nullableString(value.name, 120);
  const amountMinor = value.amount_minor;
  const currency = nullableString(value.currency, 3)?.toUpperCase() ?? null;
  const interval = parseInterval(value.billing_interval);
  const intervalCount = value.billing_interval_count;
  const durationMonths = value.duration_months;

  if (
    !code ||
    !PLAN_CODE_PATTERN.test(code) ||
    !name ||
    typeof amountMinor !== 'number' ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    !currency ||
    !/^[A-Z]{3}$/.test(currency) ||
    !interval ||
    typeof intervalCount !== 'number' ||
    !Number.isSafeInteger(intervalCount) ||
    intervalCount < 1 ||
    intervalCount > 12 ||
    ![1, 3, 6, 12].includes(durationMonths as number)
  ) {
    return null;
  }

  return {
    code,
    name,
    amountMinor,
    currency,
    interval,
    intervalCount,
    durationMonths: durationMonths as 1 | 3 | 6 | 12,
  };
}

export function parseDeviceSubscription(
  value: unknown,
  expectedDeviceId: string,
): DeviceSubscription {
  if (!isRecord(value)) throw new BillingApiError('invalid_response');
  const deviceId = nullableString(value.device_id, 160);
  if (!deviceId || deviceId !== expectedDeviceId) {
    throw new BillingApiError('invalid_response');
  }

  const rawPlans = Array.isArray(value.available_plans) ? value.available_plans : [];
  const availablePlans = rawPlans.map(parsePlan).filter((plan): plan is BillingPlan => Boolean(plan));
  if (availablePlans.length !== rawPlans.length) {
    throw new BillingApiError('invalid_response');
  }

  const amountMinor = value.amount_minor;
  const parsedAmount =
    typeof amountMinor === 'number' && Number.isSafeInteger(amountMinor) && amountMinor >= 0
      ? amountMinor
      : null;
  const currency = nullableString(value.currency, 3)?.toUpperCase() ?? null;
  const interval = parseInterval(value.billing_interval);
  const rawIntervalCount = value.billing_interval_count;
  const intervalCount =
    typeof rawIntervalCount === 'number' &&
    Number.isSafeInteger(rawIntervalCount) &&
    rawIntervalCount >= 1 &&
    rawIntervalCount <= 12
      ? rawIntervalCount
      : null;
  const rawDurationMonths = value.duration_months;
  const durationMonths = [1, 3, 6, 12].includes(rawDurationMonths as number)
    ? (rawDurationMonths as 1 | 3 | 6 | 12)
    : null;

  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw new BillingApiError('invalid_response');
  }

  return {
    deviceId,
    status: parseStatus(value.status),
    planCode: nullableString(value.plan_code, 80),
    planName: nullableString(value.plan_name, 120),
    amountMinor: parsedAmount,
    currency,
    interval,
    intervalCount,
    durationMonths,
    currentPeriodStart: nullableDate(value.current_period_start),
    currentPeriodEnd: nullableDate(value.current_period_end),
    cancelAtPeriodEnd: value.cancel_at_period_end === true,
    entitlementSyncStatus: parseEntitlementSyncStatus(
      value.entitlement_sync_status,
    ),
    tagEntitlementExpiresAt: nullableDate(value.tag_entitlement_expires_at),
    tagEntitlementUpdatedAt: nullableDate(value.tag_entitlement_updated_at),
    availablePlans,
  };
}

function buildDevicePath(deviceId: string): string {
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new BillingApiError('invalid_response');
  return `/v1/devices/${encodeURIComponent(deviceId)}/subscription`;
}

async function requestJson(
  config: BillingApiConfig,
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  if (!accessToken) throw new BillingApiError('authentication');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new BillingApiError(errorCodeForStatus(response.status), response.status);
    try {
      return await response.json();
    } catch {
      throw new BillingApiError('invalid_response', response.status);
    }
  } catch (error) {
    if (error instanceof BillingApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new BillingApiError('timeout');
    }
    throw new BillingApiError('network');
  } finally {
    clearTimeout(timeout);
  }
}

export async function getDeviceSubscription(
  config: BillingApiConfig,
  accessToken: string,
  deviceId: string,
): Promise<DeviceSubscription> {
  const payload = await requestJson(config, accessToken, buildDevicePath(deviceId));
  return parseDeviceSubscription(payload, deviceId);
}

function parseDestinationResponse(value: unknown, expectedHost: string): string {
  if (!isRecord(value)) throw new BillingApiError('invalid_response');
  const destination = parseBillingDestination(value.url, expectedHost);
  if (!destination) throw new BillingApiError('invalid_response');
  return destination;
}

export async function createDeviceCheckout(
  config: BillingApiConfig,
  accessToken: string,
  deviceId: string,
  planCode: string,
): Promise<string> {
  if (!PLAN_CODE_PATTERN.test(planCode)) throw new BillingApiError('invalid_response');
  const payload = await requestJson(
    config,
    accessToken,
    `${buildDevicePath(deviceId)}/checkout`,
    { method: 'POST', body: JSON.stringify({ plan_code: planCode }) },
  );
  return parseDestinationResponse(payload, 'checkout.stripe.com');
}

export async function createProvisioningCheckout(
  config: BillingApiConfig,
  accessToken: string,
  requestId: string,
  planCode: string,
): Promise<string> {
  if (!DEVICE_ID_PATTERN.test(requestId) && !/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new BillingApiError('invalid_response');
  }
  if (!PLAN_CODE_PATTERN.test(planCode)) throw new BillingApiError('invalid_response');
  const payload = await requestJson(
    config,
    accessToken,
    `/v1/provisioning/requests/${encodeURIComponent(requestId)}/checkout`,
    { method: 'POST', body: JSON.stringify({ plan_code: planCode }) },
  );
  return parseDestinationResponse(payload, 'checkout.stripe.com');
}

export async function createDevicePortal(
  config: BillingApiConfig,
  accessToken: string,
  deviceId: string,
  action: BillingPortalAction = 'update',
): Promise<string> {
  const payload = await requestJson(
    config,
    accessToken,
    `${buildDevicePath(deviceId)}/portal`,
    { method: 'POST', body: JSON.stringify({ action }) },
  );
  return parseDestinationResponse(payload, 'billing.stripe.com');
}
