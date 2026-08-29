import type { ProvisioningApiConfig } from '../provisioning/api';

const REQUEST_TIMEOUT_MS = 15_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NotificationKind =
  | 'renewal_7_days'
  | 'renewal_1_day'
  | 'expired'
  | 'admin_message'
  | 'separation_detected'
  | 'movement_detected';

export type UserNotification = {
  id: string;
  deviceId: string | null;
  kind: NotificationKind;
  periodEnd: string | null;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};

export type NotificationErrorCode =
  | 'configuration'
  | 'authentication'
  | 'not_found'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'unavailable';

export class NotificationApiError extends Error {
  readonly code: NotificationErrorCode;

  constructor(code: NotificationErrorCode) {
    super(code);
    this.name = 'NotificationApiError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function parseDate(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function parseText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text && text.length <= maximum ? text : null;
}

function parseKind(value: unknown): NotificationKind | null {
  return value === 'renewal_7_days' ||
    value === 'renewal_1_day' ||
    value === 'expired' ||
    value === 'admin_message' ||
    value === 'separation_detected' ||
    value === 'movement_detected'
    ? value
    : null;
}

export function parseUserNotifications(value: unknown): UserNotification[] {
  if (!isRecord(value) || !Array.isArray(value.notifications)) {
    throw new NotificationApiError('invalid_response');
  }
  return value.notifications.map((item) => {
    if (!isRecord(item)) throw new NotificationApiError('invalid_response');
    const id = parseUuid(item.id);
    const deviceId = item.device_id === null ? null : parseUuid(item.device_id);
    const kind = parseKind(item.kind);
    const periodEnd = item.period_end === null ? null : parseDate(item.period_end);
    const title = parseText(item.title, 120);
    const body = parseText(item.body, 320);
    const createdAt = parseDate(item.created_at);
    const readAt = item.read_at === null ? null : parseDate(item.read_at);
    const isAdminMessage = kind === 'admin_message';
    const isBillingMessage =
      kind === 'renewal_7_days' || kind === 'renewal_1_day' || kind === 'expired';
    const isPremiumTrackerAlert =
      kind === 'separation_detected' ||
      kind === 'movement_detected';
    if (!id || !kind || !title || !body || !createdAt || readAt === null && item.read_at !== null ||
      (isAdminMessage && (deviceId !== null || periodEnd !== null)) ||
      (isBillingMessage && (!deviceId || !periodEnd)) ||
      (isPremiumTrackerAlert && (!deviceId || periodEnd !== null))) {
      throw new NotificationApiError('invalid_response');
    }
    return { id, deviceId, kind, periodEnd, title, body, createdAt, readAt };
  });
}

function errorForStatus(status: number): NotificationErrorCode {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404) return 'not_found';
  return 'unavailable';
}

async function requestJson(
  config: ProvisioningApiConfig,
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  if (!accessToken) throw new NotificationApiError('authentication');
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
    if (!response.ok) throw new NotificationApiError(errorForStatus(response.status));
    try {
      return await response.json();
    } catch {
      throw new NotificationApiError('invalid_response');
    }
  } catch (error) {
    if (error instanceof NotificationApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new NotificationApiError('timeout');
    }
    throw new NotificationApiError('network');
  } finally {
    clearTimeout(timeout);
  }
}

export async function getUserNotifications(
  config: ProvisioningApiConfig,
  accessToken: string,
  limit = 25,
): Promise<UserNotification[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new NotificationApiError('invalid_response');
  }
  const payload = await requestJson(config, accessToken, `/v1/notifications?limit=${limit}`);
  return parseUserNotifications(payload);
}

export async function markUserNotificationRead(
  config: ProvisioningApiConfig,
  accessToken: string,
  notificationId: string,
): Promise<void> {
  const normalizedId = parseUuid(notificationId);
  if (!normalizedId) throw new NotificationApiError('invalid_response');
  const payload = await requestJson(
    config,
    accessToken,
    `/v1/notifications/${encodeURIComponent(normalizedId)}/read`,
    { method: 'POST' },
  );
  if (!isRecord(payload) || parseUuid(payload.id) !== normalizedId || payload.status !== 'read') {
    throw new NotificationApiError('invalid_response');
  }
}
