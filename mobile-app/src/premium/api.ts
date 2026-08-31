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

export type ProtectionProfile = {
  deviceId: string;
  separationAlerts: boolean;
  separationThresholdMeters: number;
  vehicleMode: boolean;
  movementAlerts: boolean;
  movementThresholdMeters: number;
  updatedAt: string;
};

export type ProtectionProfileUpdate = Partial<Omit<ProtectionProfile, 'deviceId' | 'updatedAt'>>;

export type CompanionStatus = {
  deviceId: string;
  subscriptionActive: boolean;
  configured: boolean;
  installationId: string | null;
  platform: 'ios' | 'android' | null;
  observationAccepted: boolean | null;
  lastObservationAt: string | null;
  phoneAccuracyMeters: number | null;
  tagProximity: 'nearby' | 'not_seen' | 'unknown' | null;
  tagObservedAt: string | null;
  tagRssiDbm: number | null;
};

export type CompanionObservationInput = {
  installationId: string;
  platform: 'ios' | 'android';
  phoneLatitude: number;
  phoneLongitude: number;
  phoneAccuracyMeters: number;
  sampledAt: string;
  tagProximity?: 'nearby' | 'not_seen' | 'unknown';
  tagObservedAt?: string;
  tagRssiDbm?: number;
  scanDurationSeconds?: number;
};

export type RecoveryLocationPoint = {
  latitude: number;
  longitude: number;
  recordedAt: string;
};

export type RecoveryReport = {
  deviceId: string;
  trackerName: string;
  serialNumber: string;
  generatedAt: string;
  subscriptionPeriodEnd: string;
  lastLocation: RecoveryLocationPoint | null;
  locationCount30d: number;
  safeZoneCount: number;
  activeShareCount: number;
  recentAlertCount30d: number;
  companionStatus: 'ready' | 'stale' | 'not_configured';
  replacementEligible: boolean;
  replacementClaimStatus: ReplacementClaimStatus | null;
};

export type RecoveryShareSummary = {
  id: string;
  deviceId: string;
  label: string;
  accessLevel: 'latest' | 'history';
  expiresAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
};

export type RecoveryShareCreateResult = RecoveryShareSummary & {
  shareToken: string;
  sharePath: string;
};

export type RecoveryShareInput = {
  label: string;
  accessLevel: 'latest' | 'history';
  expiresInHours: number;
};

export type ReplacementClaimStatus =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'fulfilled'
  | 'cancelled';

export type ReplacementEligibilityReason =
  | 'eligible'
  | 'subscription_required'
  | 'paid_subscription_required'
  | 'plan_not_eligible'
  | 'already_claimed';

export type ReplacementEligibility = {
  deviceId: string;
  eligible: boolean;
  reason: ReplacementEligibilityReason;
  minimumPlanMonths: 6;
  currentPlanMonths: 1 | 3 | 6 | 12 | null;
  benefitPeriodStart: string | null;
  benefitPeriodEnd: string | null;
  existingClaimId: string | null;
  existingClaimStatus: ReplacementClaimStatus | null;
};

export type ReplacementClaim = {
  id: string;
  deviceId: string;
  subscriptionId: string;
  reason: 'lost' | 'stolen';
  incidentAt: string;
  status: ReplacementClaimStatus;
  notes: string | null;
  benefitPeriodStart: string;
  benefitPeriodEnd: string;
  replacementPriceMinor: 0;
  replacementDeviceId: string | null;
  replacementSerialNumber: string | null;
  provisioningRequestId: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  fulfilledAt: string | null;
};

export type ReplacementClaimInput = {
  reason: 'lost' | 'stolen';
  incidentAt: string;
  notes?: string;
};

export type LocationHistoryDeleteResult = {
  deviceId: string;
  deletedReports: number;
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
export const SEPARATION_THRESHOLD_MIN_METERS = 100;
export const SEPARATION_THRESHOLD_MAX_METERS = 5_000;
export const MOVEMENT_THRESHOLD_MIN_METERS = 100;
export const MOVEMENT_THRESHOLD_MAX_METERS = 10_000;

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

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parseUuidOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

function parseSafeText(value: unknown, minimum: number, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().split(/\s+/).join(' ');
  return normalized.length >= minimum &&
    normalized.length <= maximum &&
    !/[\x00-\x1f\x7f]/.test(normalized)
    ? normalized
    : null;
}

function isReplacementClaimStatus(value: unknown): value is ReplacementClaimStatus {
  return value === 'submitted' || value === 'approved' || value === 'rejected' ||
    value === 'fulfilled' || value === 'cancelled';
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

export function parseProtectionProfile(
  value: unknown,
  expectedDeviceId: string,
): ProtectionProfile {
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, expectedDeviceId);
  if (
    !isBoolean(value.separation_alerts) ||
    !isInteger(
      value.separation_threshold_meters,
      SEPARATION_THRESHOLD_MIN_METERS,
      SEPARATION_THRESHOLD_MAX_METERS,
    ) ||
    !isBoolean(value.vehicle_mode) ||
    !isBoolean(value.movement_alerts) ||
    !isInteger(
      value.movement_threshold_meters,
      MOVEMENT_THRESHOLD_MIN_METERS,
      MOVEMENT_THRESHOLD_MAX_METERS,
    ) ||
    !isIsoDate(value.updated_at)
  ) throw new PremiumApiError('INVALID_RESPONSE', 502);
  return {
    deviceId: expectedDeviceId,
    separationAlerts: value.separation_alerts,
    separationThresholdMeters: value.separation_threshold_meters,
    vehicleMode: value.vehicle_mode,
    movementAlerts: value.movement_alerts,
    movementThresholdMeters: value.movement_threshold_meters,
    updatedAt: value.updated_at,
  };
}

function protectionProfileUpdateBody(
  input: ProtectionProfileUpdate,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.separationAlerts !== undefined) {
    if (!isBoolean(input.separationAlerts)) throw new PremiumApiError('INVALID_PROTECTION_SETTING', 400);
    body.separation_alerts = input.separationAlerts;
  }
  if (input.separationThresholdMeters !== undefined) {
    if (!isInteger(
      input.separationThresholdMeters,
      SEPARATION_THRESHOLD_MIN_METERS,
      SEPARATION_THRESHOLD_MAX_METERS,
    )) throw new PremiumApiError('INVALID_SEPARATION_THRESHOLD', 400);
    body.separation_threshold_meters = input.separationThresholdMeters;
  }
  if (input.vehicleMode !== undefined) {
    if (!isBoolean(input.vehicleMode)) throw new PremiumApiError('INVALID_PROTECTION_SETTING', 400);
    body.vehicle_mode = input.vehicleMode;
  }
  if (input.movementAlerts !== undefined) {
    if (!isBoolean(input.movementAlerts)) throw new PremiumApiError('INVALID_PROTECTION_SETTING', 400);
    body.movement_alerts = input.movementAlerts;
  }
  if (input.movementThresholdMeters !== undefined) {
    if (!isInteger(
      input.movementThresholdMeters,
      MOVEMENT_THRESHOLD_MIN_METERS,
      MOVEMENT_THRESHOLD_MAX_METERS,
    )) throw new PremiumApiError('INVALID_MOVEMENT_THRESHOLD', 400);
    body.movement_threshold_meters = input.movementThresholdMeters;
  }
  if (!Object.keys(body).length) throw new PremiumApiError('EMPTY_PROTECTION_UPDATE', 400);
  return body;
}

export function parseCompanionStatus(
  value: unknown,
  expectedDeviceId: string,
): CompanionStatus {
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, expectedDeviceId);
  const installationId = parseUuidOrNull(value.installation_id);
  const platform = value.platform;
  const observationAccepted = value.observation_accepted;
  const accuracy = value.phone_accuracy_meters;
  const proximity = value.tag_proximity;
  const rssi = value.tag_rssi_dbm;
  if (
    !isBoolean(value.subscription_active) ||
    !isBoolean(value.configured) ||
    installationId === undefined ||
    !(platform === null || platform === 'ios' || platform === 'android') ||
    !(observationAccepted === null || isBoolean(observationAccepted)) ||
    !isIsoDateOrNull(value.last_observation_at) ||
    !(accuracy === null || isFiniteNumber(accuracy, 1, 1_000)) ||
    !(proximity === null || proximity === 'nearby' || proximity === 'not_seen' || proximity === 'unknown') ||
    !isIsoDateOrNull(value.tag_observed_at) ||
    !(rssi === null || isInteger(rssi, -127, 20)) ||
    (value.configured && (installationId === null || platform === null)) ||
    (!value.configured && (installationId !== null || platform !== null))
  ) throw new PremiumApiError('INVALID_RESPONSE', 502);
  return {
    deviceId: expectedDeviceId,
    subscriptionActive: value.subscription_active,
    configured: value.configured,
    installationId,
    platform,
    observationAccepted,
    lastObservationAt: value.last_observation_at,
    phoneAccuracyMeters: accuracy,
    tagProximity: proximity,
    tagObservedAt: value.tag_observed_at,
    tagRssiDbm: rssi,
  };
}

function companionObservationBody(input: CompanionObservationInput): Record<string, unknown> {
  const installationId = normalizeUuid(input.installationId, 'INVALID_INSTALLATION_ID');
  if (input.platform !== 'ios' && input.platform !== 'android') {
    throw new PremiumApiError('INVALID_COMPANION_PLATFORM', 400);
  }
  if (!isIsoDate(input.sampledAt)) throw new PremiumApiError('INVALID_COMPANION_TIME', 400);
  if (!isFiniteNumber(input.phoneAccuracyMeters, 1, 1_000)) {
    throw new PremiumApiError('INVALID_COMPANION_ACCURACY', 400);
  }
  const proximity = input.tagProximity ?? 'unknown';
  if (proximity !== 'nearby' && proximity !== 'not_seen' && proximity !== 'unknown') {
    throw new PremiumApiError('INVALID_COMPANION_PROXIMITY', 400);
  }
  if (proximity === 'nearby' && !input.tagObservedAt) {
    throw new PremiumApiError('INVALID_COMPANION_PROXIMITY', 400);
  }
  if (proximity !== 'nearby' && (input.tagObservedAt || input.tagRssiDbm !== undefined)) {
    throw new PremiumApiError('INVALID_COMPANION_PROXIMITY', 400);
  }
  if (proximity === 'not_seen' && input.scanDurationSeconds === undefined) {
    throw new PremiumApiError('INVALID_COMPANION_PROXIMITY', 400);
  }
  const body: Record<string, unknown> = {
    installation_id: installationId,
    platform: input.platform,
    phone_latitude: validateLatitude(input.phoneLatitude),
    phone_longitude: validateLongitude(input.phoneLongitude),
    phone_accuracy_meters: input.phoneAccuracyMeters,
    sampled_at: input.sampledAt,
    tag_proximity: proximity,
  };
  if (input.tagObservedAt !== undefined) {
    if (!isIsoDate(input.tagObservedAt)) throw new PremiumApiError('INVALID_COMPANION_TIME', 400);
    body.tag_observed_at = input.tagObservedAt;
  }
  if (input.tagRssiDbm !== undefined) {
    if (!isInteger(input.tagRssiDbm, -127, 20)) throw new PremiumApiError('INVALID_COMPANION_RSSI', 400);
    body.tag_rssi_dbm = input.tagRssiDbm;
  }
  if (input.scanDurationSeconds !== undefined) {
    if (!isInteger(input.scanDurationSeconds, 5, 120)) {
      throw new PremiumApiError('INVALID_COMPANION_SCAN_DURATION', 400);
    }
    body.scan_duration_seconds = input.scanDurationSeconds;
  }
  return body;
}

function parseRecoveryPoint(value: unknown): RecoveryLocationPoint | null {
  if (!isRecord(value) ||
    !isFiniteNumber(value.latitude, -90, 90) ||
    !isFiniteNumber(value.longitude, -180, 180) ||
    !isIsoDate(value.recorded_at)
  ) return null;
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    recordedAt: value.recorded_at,
  };
}

export function parseRecoveryReport(value: unknown, expectedDeviceId: string): RecoveryReport {
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, expectedDeviceId);
  const trackerName = parseSafeText(value.tracker_name, 1, 160);
  const lastLocation = value.last_location === null ? null : parseRecoveryPoint(value.last_location);
  const claimStatus = value.replacement_claim_status;
  if (
    !trackerName ||
    typeof value.serial_number !== 'string' ||
    !/^PKV-[0-9A-F]{12}$/.test(value.serial_number) ||
    !isIsoDate(value.generated_at) ||
    value.protection_status !== 'active' ||
    !isIsoDate(value.subscription_period_end) ||
    (value.last_location !== null && lastLocation === null) ||
    !isInteger(value.location_count_30d) ||
    !isInteger(value.safe_zone_count) ||
    !isInteger(value.active_share_count) ||
    !isInteger(value.recent_alert_count_30d) ||
    (value.companion_status !== 'ready' && value.companion_status !== 'stale' &&
      value.companion_status !== 'not_configured') ||
    !isBoolean(value.replacement_eligible) ||
    !(claimStatus === null || isReplacementClaimStatus(claimStatus))
  ) throw new PremiumApiError('INVALID_RESPONSE', 502);
  return {
    deviceId: expectedDeviceId,
    trackerName,
    serialNumber: value.serial_number,
    generatedAt: value.generated_at,
    subscriptionPeriodEnd: value.subscription_period_end,
    lastLocation,
    locationCount30d: value.location_count_30d,
    safeZoneCount: value.safe_zone_count,
    activeShareCount: value.active_share_count,
    recentAlertCount30d: value.recent_alert_count_30d,
    companionStatus: value.companion_status,
    replacementEligible: value.replacement_eligible,
    replacementClaimStatus: claimStatus,
  };
}

function parseRecoveryShare(
  value: unknown,
  expectedDeviceId: string,
): RecoveryShareSummary {
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, expectedDeviceId);
  const id = parseUuidOrNull(value.id);
  const label = parseSafeText(value.label, 1, 80);
  if (
    !id || !label ||
    (value.access_level !== 'latest' && value.access_level !== 'history') ||
    !isIsoDate(value.expires_at) ||
    !isIsoDateOrNull(value.revoked_at) ||
    !isIsoDateOrNull(value.last_accessed_at) ||
    !isIsoDate(value.created_at)
  ) throw new PremiumApiError('INVALID_RESPONSE', 502);
  return {
    id,
    deviceId: expectedDeviceId,
    label,
    accessLevel: value.access_level,
    expiresAt: value.expires_at,
    revokedAt: value.revoked_at,
    lastAccessedAt: value.last_accessed_at,
    createdAt: value.created_at,
  };
}

export function parseRecoveryShareList(
  value: unknown,
  expectedDeviceId: string,
): RecoveryShareSummary[] {
  if (!isRecord(value) || !Array.isArray(value.shares) || value.shares.length > 100) {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  }
  const shares = value.shares.map((share) => parseRecoveryShare(share, expectedDeviceId));
  if (new Set(shares.map((share) => share.id)).size !== shares.length) {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  }
  return shares;
}

export function parseRecoveryShareCreate(
  value: unknown,
  expectedDeviceId: string,
): RecoveryShareCreateResult {
  const summary = parseRecoveryShare(value, expectedDeviceId);
  if (!isRecord(value) ||
    typeof value.share_token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.share_token) ||
    value.share_path !== `/recovery#token=${value.share_token}`
  ) throw new PremiumApiError('INVALID_RESPONSE', 502);
  return { ...summary, shareToken: value.share_token, sharePath: value.share_path };
}

function recoveryShareCreateBody(input: RecoveryShareInput): Record<string, unknown> {
  const label = parseSafeText(input.label, 1, 80);
  if (!label) throw new PremiumApiError('INVALID_RECOVERY_SHARE_LABEL', 400);
  if (input.accessLevel !== 'latest' && input.accessLevel !== 'history') {
    throw new PremiumApiError('INVALID_RECOVERY_SHARE_ACCESS', 400);
  }
  if (!isInteger(input.expiresInHours, 1, 720)) {
    throw new PremiumApiError('INVALID_RECOVERY_SHARE_EXPIRY', 400);
  }
  return {
    label,
    access_level: input.accessLevel,
    expires_in_hours: input.expiresInHours,
  };
}

export function parseReplacementEligibility(
  value: unknown,
  expectedDeviceId: string,
): ReplacementEligibility {
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, expectedDeviceId);
  const reasons = new Set<ReplacementEligibilityReason>([
    'eligible', 'subscription_required', 'paid_subscription_required',
    'plan_not_eligible', 'already_claimed',
  ]);
  const existingClaimId = parseUuidOrNull(value.existing_claim_id);
  const existingStatus = value.existing_claim_status;
  if (
    !isBoolean(value.eligible) ||
    typeof value.reason !== 'string' ||
    !reasons.has(value.reason as ReplacementEligibilityReason) ||
    value.minimum_plan_months !== 6 ||
    !(value.current_plan_months === null || [1, 3, 6, 12].includes(value.current_plan_months as number)) ||
    !isIsoDateOrNull(value.benefit_period_start) ||
    !isIsoDateOrNull(value.benefit_period_end) ||
    existingClaimId === undefined ||
    !(existingStatus === null || isReplacementClaimStatus(existingStatus)) ||
    (value.eligible !== (value.reason === 'eligible'))
  ) throw new PremiumApiError('INVALID_RESPONSE', 502);
  return {
    deviceId: expectedDeviceId,
    eligible: value.eligible,
    reason: value.reason as ReplacementEligibilityReason,
    minimumPlanMonths: 6,
    currentPlanMonths: value.current_plan_months as 1 | 3 | 6 | 12 | null,
    benefitPeriodStart: value.benefit_period_start,
    benefitPeriodEnd: value.benefit_period_end,
    existingClaimId,
    existingClaimStatus: existingStatus,
  };
}

function parseReplacementClaim(value: unknown, expectedDeviceId: string): ReplacementClaim {
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, expectedDeviceId);
  const id = parseUuidOrNull(value.id);
  const subscriptionId = parseUuidOrNull(value.subscription_id);
  const replacementDeviceId = parseUuidOrNull(value.replacement_device_id);
  const provisioningRequestId = parseUuidOrNull(value.provisioning_request_id);
  const notes = value.notes === null ? null : parseSafeText(value.notes, 1, 500);
  if (
    !id || !subscriptionId ||
    (value.reason !== 'lost' && value.reason !== 'stolen') ||
    !isIsoDate(value.incident_at) ||
    !isReplacementClaimStatus(value.status) ||
    (value.notes !== null && notes === null) ||
    !isIsoDate(value.benefit_period_start) ||
    !isIsoDate(value.benefit_period_end) ||
    value.replacement_price_minor !== 0 ||
    replacementDeviceId === undefined ||
    !(value.replacement_serial_number === null ||
      (typeof value.replacement_serial_number === 'string' &&
        /^PKV-[0-9A-F]{12}$/.test(value.replacement_serial_number))) ||
    provisioningRequestId === undefined ||
    !isIsoDate(value.submitted_at) ||
    !isIsoDateOrNull(value.reviewed_at) ||
    !isIsoDateOrNull(value.fulfilled_at)
  ) throw new PremiumApiError('INVALID_RESPONSE', 502);
  return {
    id,
    deviceId: expectedDeviceId,
    subscriptionId,
    reason: value.reason,
    incidentAt: value.incident_at,
    status: value.status,
    notes,
    benefitPeriodStart: value.benefit_period_start,
    benefitPeriodEnd: value.benefit_period_end,
    replacementPriceMinor: 0,
    replacementDeviceId,
    replacementSerialNumber: value.replacement_serial_number,
    provisioningRequestId,
    submittedAt: value.submitted_at,
    reviewedAt: value.reviewed_at,
    fulfilledAt: value.fulfilled_at,
  };
}

export function parseReplacementClaimList(
  value: unknown,
  expectedDeviceId: string,
): ReplacementClaim[] {
  if (!isRecord(value) || !Array.isArray(value.claims) || value.claims.length > 100) {
    throw new PremiumApiError('INVALID_RESPONSE', 502);
  }
  return value.claims.map((claim) => parseReplacementClaim(claim, expectedDeviceId));
}

function replacementClaimBody(input: ReplacementClaimInput): Record<string, unknown> {
  if (input.reason !== 'lost' && input.reason !== 'stolen') {
    throw new PremiumApiError('INVALID_REPLACEMENT_REASON', 400);
  }
  if (!isIsoDate(input.incidentAt)) throw new PremiumApiError('INVALID_REPLACEMENT_TIME', 400);
  const body: Record<string, unknown> = {
    reason: input.reason,
    incident_at: input.incidentAt,
  };
  if (input.notes !== undefined) {
    const notes = input.notes.trim() ? parseSafeText(input.notes, 1, 500) : null;
    if (input.notes.trim() && !notes) throw new PremiumApiError('INVALID_REPLACEMENT_NOTES', 400);
    body.notes = notes;
  }
  return body;
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

export async function getProtectionProfile(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<ProtectionProfile> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseProtectionProfile(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/protection`,
    ),
    normalizedDeviceId,
  );
}

export async function updateProtectionProfile(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
  input: ProtectionProfileUpdate,
): Promise<ProtectionProfile> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseProtectionProfile(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/protection`,
      { method: 'PATCH', body: protectionProfileUpdateBody(input) },
    ),
    normalizedDeviceId,
  );
}

export async function getCompanionStatus(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<CompanionStatus> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseCompanionStatus(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/companion`,
    ),
    normalizedDeviceId,
  );
}

export async function reportCompanionObservation(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
  input: CompanionObservationInput,
): Promise<CompanionStatus> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseCompanionStatus(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/companion/observations`,
      { method: 'POST', body: companionObservationBody(input) },
    ),
    normalizedDeviceId,
  );
}

export async function resetCompanion(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<void> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  const value = await requestPremiumJson(
    config,
    getAccessToken,
    `/devices/${normalizedDeviceId}/companion`,
    { method: 'DELETE' },
  );
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, normalizedDeviceId);
  if (value.status !== 'removed') throw new PremiumApiError('INVALID_RESPONSE', 502);
}

export async function getRecoveryReport(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<RecoveryReport> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseRecoveryReport(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/recovery-report`,
    ),
    normalizedDeviceId,
  );
}

export async function listRecoveryShares(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<RecoveryShareSummary[]> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseRecoveryShareList(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/recovery-shares`,
    ),
    normalizedDeviceId,
  );
}

export async function createRecoveryShare(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
  input: RecoveryShareInput,
): Promise<RecoveryShareCreateResult> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseRecoveryShareCreate(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/recovery-shares`,
      { method: 'POST', body: recoveryShareCreateBody(input) },
    ),
    normalizedDeviceId,
  );
}

export async function revokeRecoveryShare(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
  shareId: string,
): Promise<RecoveryShareSummary> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  const normalizedShareId = normalizeUuid(shareId, 'INVALID_RECOVERY_SHARE_ID');
  return parseRecoveryShare(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/recovery-shares/${normalizedShareId}`,
      { method: 'DELETE' },
    ),
    normalizedDeviceId,
  );
}

export function recoveryShareUrl(
  config: ProvisioningApiConfig,
  share: RecoveryShareCreateResult,
): string {
  const base = new URL(config.baseUrl);
  const url = new URL(share.sharePath, base);
  if (
    url.origin !== base.origin ||
    url.pathname !== '/recovery' ||
    url.search ||
    url.hash !== `#token=${share.shareToken}`
  ) throw new PremiumApiError('INVALID_RESPONSE', 502);
  return url.toString();
}

export async function getReplacementEligibility(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<ReplacementEligibility> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseReplacementEligibility(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/replacement-eligibility`,
    ),
    normalizedDeviceId,
  );
}

export async function listReplacementClaims(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<ReplacementClaim[]> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseReplacementClaimList(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/replacement-claims`,
    ),
    normalizedDeviceId,
  );
}

export async function createReplacementClaim(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
  input: ReplacementClaimInput,
): Promise<ReplacementClaim> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  return parseReplacementClaim(
    await requestPremiumJson(
      config,
      getAccessToken,
      `/devices/${normalizedDeviceId}/replacement-claims`,
      { method: 'POST', body: replacementClaimBody(input) },
    ),
    normalizedDeviceId,
  );
}

export async function deleteLocationHistory(
  config: ProvisioningApiConfig,
  getAccessToken: () => Promise<string | null>,
  deviceId: string,
): Promise<LocationHistoryDeleteResult> {
  const normalizedDeviceId = normalizeUuid(deviceId, 'INVALID_DEVICE_ID');
  const value = await requestPremiumJson(
    config,
    getAccessToken,
    `/devices/${normalizedDeviceId}/location/history`,
    { method: 'DELETE' },
  );
  if (!isRecord(value)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  assertExpectedDeviceId(value.device_id, normalizedDeviceId);
  if (!isInteger(value.deleted_reports)) throw new PremiumApiError('INVALID_RESPONSE', 502);
  return { deviceId: normalizedDeviceId, deletedReports: value.deleted_reports };
}

export function premiumErrorCode(error: unknown): string {
  return error instanceof PremiumApiError ? error.code : 'UNKNOWN_ERROR';
}
