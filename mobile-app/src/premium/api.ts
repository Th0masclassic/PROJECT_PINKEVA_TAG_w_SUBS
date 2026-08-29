import type { ProvisioningApiConfig } from '../provisioning/api';

export type PremiumFeatureAccess = {
  deviceId: string;
  subscriptionActive: boolean;
  tier: 'premium' | 'none';
  cloudLocationReports: boolean;
  locationHistoryDays: number;
  smartAlerts: boolean;
  safeZones: boolean;
  companionSeparationAlerts: boolean;
  trustedSharing: boolean;
  recoveryReport: boolean;
  vehicleMode: boolean;
  replacementBenefit: boolean;
};

export type PremiumTrackerOverview = {
  deviceId: string;
  trackerName: string;
  subscriptionActive: boolean;
  locationStatus: 'current' | 'stale' | 'never';
  lastLocationAt: string | null;
  firmwareVersion: string | null;
  separationAlerts: boolean;
  vehicleMode: boolean;
  movementAlerts: boolean;
  safeZoneCount: number;
  activeShareCount: number;
  companionStatus: 'ready' | 'stale' | 'not_configured';
  replacementEligible: boolean;
};

export type DeviceSafeZone = {
  id: string;
  deviceId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  enabled: boolean;
  lastTrackerInside: boolean | null;
  lastEvaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SafeZoneInput = {
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
};

export type SafeZoneUpdate = Partial<SafeZoneInput> & {
  enabled?: boolean;
};

type ErrorEnvelope = {
  error?: { code?: string; request_id?: string };
};

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 20_000;
const SAFE_ZONE_NAME_MAX_LENGTH = 80;
export const SAFE_ZONE_LIMIT = 20;
export const SAFE_ZONE_MIN_RADIUS_METERS = 50;
export const SAFE_ZONE_MAX_RADIUS_METERS = 100_000;

export class PremiumApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(code: string, status?: number, requestId?: string) {
    super(code);
    this.name = 'PremiumApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUuid(value: string, code: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new PremiumApiError(code, 400);
  return normalized;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isFiniteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isIsoDateOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function normalizeSafeZoneName(name: string): string {
  const normalized = name.trim().split(/\s+/).join(' ');
  if (
    !normalized ||
    normalized.length > SAFE_ZONE_NAME_MAX_LENGTH ||
    /[\x00-\x1f\x7f]/.test(normalized)
  ) {
    throw new PremiumApiError('INVALID_SAFE_ZONE_NAME', 400);
  }
  return normalized;
}

function validateLatitude(value: number): number {
  if (!Number.isFinite(value) || value < -90 || value > 90) {
    throw new PremiumApiError('INVALID_SAFE_ZONE_LATITUDE', 400);
  }
  return value;
}

function validateLongitude(value: number): number {
  if (!Number.isFinite(value) || value < -180 || value > 180) {
    throw new PremiumApiError('INVALID_SAFE_ZONE_LONGITUDE', 400);
  }
  return value;
}

function validateRadius(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < SAFE_ZONE_MIN_RADIUS_METERS ||
    value > SAFE_ZONE_MAX_RADIUS_METERS
  ) {
    throw new PremiumApiError('INVALID_SAFE_ZONE_RADIUS', 400);
  }
  return value;
}

function safeZoneCreateBody(input: SafeZoneInput): Record<string, unknown> {
  return {
    name: normalizeSafeZoneName(input.name),
    latitude: validateLatitude(input.latitude),
    longitude: validateLongitude(input.longitude),
    radius_meters: validateRadius(input.radiusMeters),
  };
}

function safeZoneUpdateBody(input: SafeZoneUpdate): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = normalizeSafeZoneName(input.name);
  if (input.latitude !== undefined) body.latitude = validateLatitude(input.latitude);
  if (input.longitude !== undefined) body.longitude = validateLongitude(input.longitude);
  if (input.radiusMeters !== undefined) body.radius_meters = validateRadius(input.radiusMeters);
  if (input.enabled !== undefined) {
    if (!isBoolean(input.enabled)) throw new PremiumApiError('INVALID_SAFE_ZONE_ENABLED', 400);
    body.enabled = input.enabled;
  }
  if (!Object.keys(body).length) throw new PremiumApiError('EMPTY_SAFE_ZONE_UPDATE', 400);
  return body;
}

async function requestPremiumJson(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  path: string,
  options: RequestOptions = {},
): Promise<unknown> {
  let token: string | null;
  try {
    token = await getAccessToken();
  } catch {
    throw new PremiumApiError('AUTH_TOKEN_UNAVAILABLE', 401);
  }
  if (!token) throw new PremiumApiError('AUTH_TOKEN_UNAVAILABLE', 401);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v1${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PremiumApiError('REQUEST_TIMEOUT');
    }
    throw new PremiumApiError('NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const parsed: unknown = await response.json().catch(() => null);
    const envelope: ErrorEnvelope = isRecord(parsed) ? (parsed as ErrorEnvelope) : {};
    throw new PremiumApiError(
      envelope.error?.code ?? 'REQUEST_FAILED',
      response.status,
      envelope.error?.request_id ?? response.headers.get('X-Request-ID') ?? undefined,
    );
  }

  if (response.status === 204) return null;
  return response.json().catch(() => {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  });
}

function assertExpectedDeviceId(value: unknown, expectedDeviceId: string): void {
  if (
    typeof value !== 'string' ||
    !UUID_PATTERN.test(value) ||
    value.toLowerCase() !== expectedDeviceId
  ) {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  }
}

export function parsePremiumFeatureAccess(
  value: unknown,
  expectedDeviceId: string,
): PremiumFeatureAccess {
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, expectedDeviceId);
  if (
    !isBoolean(value.subscription_active) ||
    (value.tier !== 'premium' && value.tier !== 'none') ||
    !isBoolean(value.cloud_location_reports) ||
    !isInteger(value.location_history_days, 0, 30) ||
    !isBoolean(value.smart_alerts) ||
    !isBoolean(value.safe_zones) ||
    !isBoolean(value.companion_separation_alerts) ||
    !isBoolean(value.trusted_sharing) ||
    !isBoolean(value.recovery_report) ||
    !isBoolean(value.vehicle_mode) ||
    !isBoolean(value.replacement_benefit)
  ) {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  }
  return {
    deviceId: expectedDeviceId,
    subscriptionActive: value.subscription_active,
    tier: value.tier,
    cloudLocationReports: value.cloud_location_reports,
    locationHistoryDays: value.location_history_days,
    smartAlerts: value.smart_alerts,
    safeZones: value.safe_zones,
    companionSeparationAlerts: value.companion_separation_alerts,
    trustedSharing: value.trusted_sharing,
    recoveryReport: value.recovery_report,
    vehicleMode: value.vehicle_mode,
    replacementBenefit: value.replacement_benefit,
  };
}

export function parsePremiumTrackerOverview(
  value: unknown,
  expectedDeviceId: string,
): PremiumTrackerOverview {
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, expectedDeviceId);
  if (
    typeof value.tracker_name !== 'string' ||
    !value.tracker_name.trim() ||
    value.tracker_name.length > 160 ||
    !isBoolean(value.subscription_active) ||
    (value.location_status !== 'current' &&
      value.location_status !== 'stale' &&
      value.location_status !== 'never') ||
    !isIsoDateOrNull(value.last_location_at) ||
    !(value.firmware_version === null ||
      (typeof value.firmware_version === 'string' && value.firmware_version.length <= 80)) ||
    !isBoolean(value.separation_alerts) ||
    !isBoolean(value.vehicle_mode) ||
    !isBoolean(value.movement_alerts) ||
    !isInteger(value.safe_zone_count) ||
    !isInteger(value.active_share_count) ||
    (value.companion_status !== 'ready' &&
      value.companion_status !== 'stale' &&
      value.companion_status !== 'not_configured') ||
    !isBoolean(value.replacement_eligible)
  ) {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  }
  return {
    deviceId: expectedDeviceId,
    trackerName: value.tracker_name.trim(),
    subscriptionActive: value.subscription_active,
    locationStatus: value.location_status,
    lastLocationAt: value.last_location_at,
    firmwareVersion: value.firmware_version,
    separationAlerts: value.separation_alerts,
    vehicleMode: value.vehicle_mode,
    movementAlerts: value.movement_alerts,
    safeZoneCount: value.safe_zone_count,
    activeShareCount: value.active_share_count,
    companionStatus: value.companion_status,
    replacementEligible: value.replacement_eligible,
  };
}

function parseSafeZone(value: unknown, expectedDeviceId: string): DeviceSafeZone {
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, expectedDeviceId);
  if (
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    value.name.length > SAFE_ZONE_NAME_MAX_LENGTH ||
    !isFiniteNumber(value.latitude, -90, 90) ||
    !isFiniteNumber(value.longitude, -180, 180) ||
    !isInteger(
      value.radius_meters,
      SAFE_ZONE_MIN_RADIUS_METERS,
      SAFE_ZONE_MAX_RADIUS_METERS,
    ) ||
    !isBoolean(value.enabled) ||
    !(value.last_tracker_inside === null || isBoolean(value.last_tracker_inside)) ||
    !isIsoDateOrNull(value.last_evaluated_at) ||
    !isIsoDateOrNull(value.created_at) ||
    value.created_at === null ||
    !isIsoDateOrNull(value.updated_at) ||
    value.updated_at === null
  ) {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  }
  return {
    id: value.id.toLowerCase(),
    deviceId: expectedDeviceId,
    name: value.name,
    latitude: value.latitude,
    longitude: value.longitude,
    radiusMeters: value.radius_meters,
    enabled: value.enabled,
    lastTrackerInside: value.last_tracker_inside,
    lastEvaluatedAt: value.last_evaluated_at,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

export function parseSafeZoneList(value: unknown, expectedDeviceId: string): DeviceSafeZone[] {
  if (!isRecord(value) || !Array.isArray(value.safe_zones) || value.safe_zones.length > SAFE_ZONE_LIMIT) {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  }
  const zones = value.safe_zones.map((zone) => parseSafeZone(zone, expectedDeviceId));
  if (new Set(zones.map((zone) => zone.id)).size !== zones.length) {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  }
  return zones;
}

export async function getPremiumFeatures(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<PremiumFeatureAccess> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parsePremiumFeatureAccess(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/premium/features`,
    ),
    normalizedDeviceId,
  );
}

export async function getPremiumOverview(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<PremiumTrackerOverview> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parsePremiumTrackerOverview(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/premium/overview`,
    ),
    normalizedDeviceId,
  );
}

export async function listSafeZones(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<DeviceSafeZone[]> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseSafeZoneList(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/safe-zones`,
    ),
    normalizedDeviceId,
  );
}

export async function createSafeZone(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
  input: SafeZoneInput,
): Promise<DeviceSafeZone> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseSafeZone(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/safe-zones`,
      { method: 'POST', body: safeZoneCreateBody(input) },
    ),
    normalizedDeviceId,
  );
}

export async function updateSafeZone(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
  safeZoneId: string,
  input: SafeZoneUpdate,
): Promise<DeviceSafeZone> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  const normalizedSafeZoneId = normalizeUuid(safeZoneId, 'INVALID_SAFE_ZONE_ID');
  return parseSafeZone(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/safe-zones/${normalizedSafeZoneId}`,
      { method: 'PATCH', body: safeZoneUpdateBody(input) },
    ),
    normalizedDeviceId,
  );
}

export async function deleteSafeZone(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
  safeZoneId: string,
): Promise<void> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  const normalizedSafeZoneId = normalizeUuid(safeZoneId, 'INVALID_SAFE_ZONE_ID');
  await requestPremiumJson(
    config,
    getAccessToken,
    `/devices/${normalizedDeviceId}/safe-zones/${normalizedSafeZoneId}`,
    { method: 'DELETE' },
  );
}

export function premiumErrorCode(error: unknown): string {
  return error instanceof PremiumApiError ? error.code : 'UNKNOWN_ERROR';
}
