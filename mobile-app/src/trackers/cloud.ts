import type { SupabaseClient } from '@supabase/supabase-js';

import type { Tracker } from '../model';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type OwnedTrackerErrorCode =
  | 'authentication'
  | 'configuration'
  | 'invalid-response'
  | 'unavailable';

export class OwnedTrackerError extends Error {
  readonly code: OwnedTrackerErrorCode;

  constructor(code: OwnedTrackerErrorCode) {
    super(code);
    this.name = 'OwnedTrackerError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new OwnedTrackerError('invalid-response');
  }
  return value.toLowerCase();
}

function parseNullableText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new OwnedTrackerError('invalid-response');

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength || CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    throw new OwnedTrackerError('invalid-response');
  }
  return trimmed;
}

function parseStartedAt(value: unknown): void {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new OwnedTrackerError('invalid-response');
  }
}

function parseNullableCoordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new OwnedTrackerError('invalid-response');
  }
  return value;
}

function relativeLastSeen(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new OwnedTrackerError('invalid-response');
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function mapHostedStatus(value: unknown): Tracker['status'] {
  const status = parseNullableText(value, 48)?.toLowerCase();
  // Database lifecycle states such as "active" or "suspended" do not prove
  // that a tag is physically close to this phone. Only an explicit proximity
  // state may be presented as Nearby.
  return status === 'nearby' ? 'nearby' : 'away';
}

function parseOwnedTrackerRow(value: unknown, expectedUserId: string): Tracker {
  if (!isRecord(value)) throw new OwnedTrackerError('invalid-response');

  const rowUserId = parseUuid(value.user_id);
  if (rowUserId !== expectedUserId || value.ended_at !== null) {
    throw new OwnedTrackerError('invalid-response');
  }
  parseStartedAt(value.started_at);

  const deviceId = parseUuid(value.device_id);
  if (!isRecord(value.device)) throw new OwnedTrackerError('invalid-response');

  const projectedDeviceId = parseUuid(value.device.id);
  if (projectedDeviceId !== deviceId) throw new OwnedTrackerError('invalid-response');

  const name = parseNullableText(value.device.name, 120) ?? 'Pinkeva Card';
  const firmwareVersion = parseNullableText(value.device.firmware_version, 64) ?? '—';
  const latitude = parseNullableCoordinate(value.device.last_latitude, -90, 90);
  const longitude = parseNullableCoordinate(value.device.last_longitude, -180, 180);
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new OwnedTrackerError('invalid-response');
  }
  const lastLocationAt = parseNullableText(value.device.last_location_at, 64);
  const lastPlace = parseNullableText(value.device.last_place, 160);

  return {
    id: deviceId,
    source: 'hosted',
    name,
    kind: 'card',
    status: mapHostedStatus(value.device.status),
    lastSeen: relativeLastSeen(lastLocationAt),
    place: lastPlace ?? '—',
    address: lastPlace ?? '—',
    intervalMs: 1000,
    isLost: false,
    firmwareVersion,
    ...(latitude !== undefined && longitude !== undefined
      ? { latitude, longitude }
      : {}),
    ...(lastLocationAt ? { lastLocationAt } : {}),
  };
}

export function parseOwnedTrackerRows(value: unknown, expectedUserId: string): Tracker[] {
  const normalizedUserId = parseUuid(expectedUserId);
  if (!Array.isArray(value)) throw new OwnedTrackerError('invalid-response');

  const seenDeviceIds = new Set<string>();
  return value.map((row) => {
    const tracker = parseOwnedTrackerRow(row, normalizedUserId);
    if (seenDeviceIds.has(tracker.id)) throw new OwnedTrackerError('invalid-response');
    seenDeviceIds.add(tracker.id);
    return tracker;
  });
}

export async function fetchOwnedTrackers(
  client: SupabaseClient,
  userId: string,
): Promise<Tracker[]> {
  const normalizedUserId = parseUuid(userId);
  const { data, error, status } = await client
    .from('ownership')
    .select(
      'user_id,device_id,started_at,ended_at,device:device!inner(id,name,status,firmware_version,last_latitude,last_longitude,last_location_at,last_place)',
    )
    .eq('user_id', normalizedUserId)
    .is('ended_at', null)
    .order('started_at', { ascending: true });

  if (error) {
    throw new OwnedTrackerError(
      status === 401 || status === 403 ? 'authentication' : 'unavailable',
    );
  }
  return parseOwnedTrackerRows(data, normalizedUserId);
}
