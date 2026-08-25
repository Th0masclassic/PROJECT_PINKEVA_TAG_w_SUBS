import type { ProvisioningApiConfig } from '../provisioning/api.ts';
import { ProvisioningApiError } from '../provisioning/api.ts';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_TIMEOUT_MS = 30_000;

export type DeviceLocationReport = {
  device_id: string;
  serial_number: string;
  report_status: 'updated' | 'unchanged' | 'no_report';
  latitude: number | null;
  longitude: number | null;
  last_location_at: string | null;
  last_place: string | null;
  confidence: number | null;
  status_code: number | null;
};

export type DeviceLocationHistoryPoint = {
  latitude: number;
  longitude: number;
  recorded_at: string | null;
};

export type DeviceLocationHistory = {
  device_id: string;
  points: DeviceLocationHistoryPoint[];
};

type ErrorEnvelope = {
  error?: { code?: string; request_id?: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum)
  );
}

function isNullableText(value: unknown, maximum: number): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value))
  );
}

function parseLocationReport(value: unknown, expectedDeviceId: string): DeviceLocationReport {
  if (!isRecord(value)) throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  const deviceId = value.device_id;
  if (
    typeof deviceId !== 'string' ||
    !UUID_PATTERN.test(deviceId) ||
    deviceId.toLowerCase() !== expectedDeviceId
  ) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }
  if (
    typeof value.serial_number !== 'string' ||
    value.serial_number.length !== 16 ||
    !/^PKV-[0-9A-F]{12}$/.test(value.serial_number)
  ) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }
  if (
    value.report_status !== 'updated' &&
    value.report_status !== 'unchanged' &&
    value.report_status !== 'no_report'
  ) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }
  if (!isNullableNumber(value.latitude, -90, 90) || !isNullableNumber(value.longitude, -180, 180)) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }
  if ((value.latitude === null) !== (value.longitude === null)) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }
  if (!isNullableText(value.last_location_at, 64) || !isNullableText(value.last_place, 160)) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }
  if (
    value.last_location_at !== null &&
    !Number.isFinite(Date.parse(value.last_location_at))
  ) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }
  if (!isNullableNumber(value.confidence, 0, 255) || !isNullableNumber(value.status_code, 0, 255)) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }
  return {
    device_id: deviceId.toLowerCase(),
    serial_number: value.serial_number,
    report_status: value.report_status,
    latitude: value.latitude,
    longitude: value.longitude,
    last_location_at: value.last_location_at,
    last_place: value.last_place,
    confidence: value.confidence,
    status_code: value.status_code,
  };
}

function parseHistoryPoint(value: unknown): DeviceLocationHistoryPoint | null {
  if (!isRecord(value)) return null;
  const latitude = value.latitude ?? value.lat;
  const longitude = value.longitude ?? value.lng ?? value.lon;
  const recordedAt =
    value.recorded_at ??
    value.location_at ??
    value.last_location_at ??
    value.timestamp ??
    value.created_at ??
    value.received_at ??
    null;
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    (recordedAt !== null &&
      (typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))))
  ) {
    return null;
  }
  return { latitude, longitude, recorded_at: recordedAt };
}

function parseLocationHistory(value: unknown, expectedDeviceId: string): DeviceLocationHistory {
  const envelope = isRecord(value) ? value : null;
  const responseDeviceId = envelope?.device_id;
  if (
    responseDeviceId !== undefined &&
    (typeof responseDeviceId !== 'string' ||
      !UUID_PATTERN.test(responseDeviceId) ||
      responseDeviceId.toLowerCase() !== expectedDeviceId)
  ) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }

  const candidates = Array.isArray(value)
    ? value
    : envelope?.points ??
      envelope?.locations ??
      envelope?.locations_24h ??
      envelope?.reports ??
      envelope?.history;
  if (!Array.isArray(candidates) || candidates.length > 20_000) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }

  const points = candidates.map(parseHistoryPoint);
  if (points.some((point) => point === null)) {
    throw new ProvisioningApiError('INVALID_RESPONSE', 502);
  }
  const validated = points as DeviceLocationHistoryPoint[];
  const chronological = validated.every((point) => point.recorded_at !== null)
    ? [...validated].sort(
        (left, right) =>
          Date.parse(left.recorded_at!) - Date.parse(right.recorded_at!),
      )
    : validated;
  const deduplicated = chronological.filter(
    (point, index) =>
      index === 0 ||
      point.latitude !== chronological[index - 1].latitude ||
      point.longitude !== chronological[index - 1].longitude,
  );
  return { device_id: expectedDeviceId, points: deduplicated };
}

async function requestAuthenticatedLocationJson(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  normalizedDeviceId: string,
  endpoint: string,
): Promise<unknown> {
  let token: string | null;
  try {
    token = await getAccessToken();
  } catch {
    throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);
  }
  if (!token) throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      `${config.baseUrl}/v1/devices/${normalizedDeviceId}/location/${endpoint}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ProvisioningApiError('REQUEST_TIMEOUT');
    }
    throw new ProvisioningApiError('NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const parsed: unknown = await response.json().catch(() => null);
    const body: ErrorEnvelope = isRecord(parsed) ? (parsed as ErrorEnvelope) : {};
    throw new ProvisioningApiError(
      body.error?.code ?? 'REQUEST_FAILED',
      response.status,
      body.error?.request_id ?? response.headers.get('X-Request-ID') ?? undefined,
    );
  }

  return response.json().catch(() => null);
}

export async function requestLocationReport(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<DeviceLocationReport> {
  const normalizedDeviceId = deviceId.toLowerCase();
  if (!UUID_PATTERN.test(normalizedDeviceId)) {
    throw new ProvisioningApiError('INVALID_DEVICE_ID', 400);
  }
  return parseLocationReport(
    await requestAuthenticatedLocationJson(
      config,
      getAccessToken,
      normalizedDeviceId,
      'report',
    ),
    normalizedDeviceId,
  );
}

export async function requestLocationHistory24h(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<DeviceLocationHistory> {
  const normalizedDeviceId = deviceId.toLowerCase();
  if (!UUID_PATTERN.test(normalizedDeviceId)) {
    throw new ProvisioningApiError('INVALID_DEVICE_ID', 400);
  }
  return parseLocationHistory(
    await requestAuthenticatedLocationJson(
      config,
      getAccessToken,
      normalizedDeviceId,
      'report_24h',
    ),
    normalizedDeviceId,
  );
}
