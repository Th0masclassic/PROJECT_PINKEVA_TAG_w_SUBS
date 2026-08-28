export type ProvisioningApiConfig = {
  baseUrl: string;
};

export type DeviceClaimStart = {
  session_id: string;
  serial_number: string;
  protocol_version: 1;
  tag_action: 'write_key' | 'verify_existing_key';
  advertisement_key_base64url: string;
  advertisement_key_sha256_base64url: string;
  google_advertisement_key_base64url: string;
  google_advertisement_key_sha256_base64url: string;
  finding_network: 'apple' | 'google';
  tag_authorization_proof_base64url: string;
  claim_completion_token_base64url: string;
  tag_control_key_base64url: string | null;
  expires_at: string;
  claim_deadline: string;
};

export type DeviceClaim = {
  device_id: string;
  serial_number: string;
  status: 'claimed';
  claimed_at: string;
  next_action: 'ready';
  finding_network: 'apple' | 'google';
};

export type FirmwareAvailability = {
  device_id: string;
  current_version: string | null;
  update_available: boolean;
  latest_version: string | null;
  image_size: number | null;
  image_sha256_base64url: string | null;
};

export type FirmwareUpdateSession = {
  device_id: string;
  serial_number: string;
  version: string;
  install_required: boolean;
  image_size: number;
  image_sha256_base64url: string;
  manifest_base64url: string;
  tag_authorization_proof_base64url: string;
  image_url: string;
};

export type FirmwareUpdateAcknowledgement = {
  device_id: string;
  version: string;
  status: 'installed';
};

export type ProvisioningPlan = {
  code: string;
  name: string;
  amount_minor: number;
  currency: string;
  billing_interval: 'month' | 'year';
  billing_interval_count: number;
  duration_months: 1 | 3 | 6 | 12;
};

export type ProvisioningRequestStatus =
  | 'pending'
  | 'creating'
  | 'open'
  | 'paid'
  | 'claiming'
  | 'completed'
  | 'expired'
  | 'failed';

export type ProvisioningRequest = {
  request_id: string;
  device_id: string;
  serial_number: string;
  status: ProvisioningRequestStatus;
  plan_code: string | null;
  expires_at: string;
  claim_deadline: string | null;
  available_plans: ProvisioningPlan[];
};

export type ProvisioningCheckout = {
  request_id: string;
  url: string;
  expires_at: string;
};

type ErrorEnvelope = {
  error?: { code?: string; request_id?: string };
};

const REQUEST_TIMEOUT_MS = 20_000;
const FIRMWARE_DOWNLOAD_TIMEOUT_MS = 120_000;
const FIRMWARE_PARTITION_MAX_SIZE = 0xe0000;
const FIRMWARE_VERSION_PATTERN = /^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/;

function isFirmwareVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    FIRMWARE_VERSION_PATTERN.test(value) &&
    value.split('.').every((component) => Number(component) <= 255)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

function hasNullableString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === null || typeof value[key] === 'string';
}

export function parseProvisioningApiConfig(value: unknown): ProvisioningApiConfig | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '::1' ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return { baseUrl: url.toString().replace(/\/$/, '') };
  } catch {
    return null;
  }
}

// Expo replaces direct EXPO_PUBLIC property access while bundling.
export const PROVISIONING_API_CONFIG = parseProvisioningApiConfig(
  process.env.EXPO_PUBLIC_API_URL,
);

function isDeviceClaimStart(value: unknown): value is DeviceClaimStart {
  if (!isRecord(value)) return false;
  return (
    hasString(value, 'session_id') &&
    hasString(value, 'serial_number') &&
    value.protocol_version === 1 &&
    (value.tag_action === 'write_key' || value.tag_action === 'verify_existing_key') &&
    hasString(value, 'advertisement_key_base64url') &&
    hasString(value, 'advertisement_key_sha256_base64url') &&
    hasString(value, 'google_advertisement_key_base64url') &&
    hasString(value, 'google_advertisement_key_sha256_base64url') &&
    (value.finding_network === 'apple' || value.finding_network === 'google') &&
    hasString(value, 'tag_authorization_proof_base64url') &&
    hasString(value, 'claim_completion_token_base64url') &&
    hasNullableString(value, 'tag_control_key_base64url') &&
    hasString(value, 'expires_at') &&
    hasString(value, 'claim_deadline')
  );
}

function isDeviceClaim(value: unknown): value is DeviceClaim {
  if (!isRecord(value)) return false;
  return (
    hasString(value, 'device_id') &&
    hasString(value, 'serial_number') &&
    value.status === 'claimed' &&
    hasString(value, 'claimed_at') &&
    value.next_action === 'ready' &&
    (value.finding_network === 'apple' || value.finding_network === 'google')
  );
}

function isFirmwareAvailability(value: unknown): value is FirmwareAvailability {
  if (!isRecord(value)) return false;
  const nullableVersion = value.latest_version === null ||
    isFirmwareVersion(value.latest_version);
  const nullableCurrent = value.current_version === null || typeof value.current_version === 'string';
  const nullableSize = value.image_size === null ||
    (typeof value.image_size === 'number' && Number.isSafeInteger(value.image_size) && value.image_size > 0);
  const nullableDigest = value.image_sha256_base64url === null ||
    (typeof value.image_sha256_base64url === 'string' && value.image_sha256_base64url.length === 43);
  return (
    hasString(value, 'device_id') &&
    nullableCurrent &&
    typeof value.update_available === 'boolean' &&
    nullableVersion &&
    nullableSize &&
    nullableDigest &&
    (value.latest_version === null
      ? value.image_size === null && value.image_sha256_base64url === null && !value.update_available
      : value.image_size !== null && value.image_sha256_base64url !== null)
  );
}

function isFirmwareUpdateSession(value: unknown): value is FirmwareUpdateSession {
  return (
    isRecord(value) &&
    hasString(value, 'device_id') &&
    hasString(value, 'serial_number') &&
    isFirmwareVersion(value.version) &&
    typeof value.install_required === 'boolean' &&
    typeof value.image_size === 'number' &&
    Number.isSafeInteger(value.image_size) &&
    value.image_size > 0 &&
    value.image_size <= FIRMWARE_PARTITION_MAX_SIZE &&
    typeof value.image_sha256_base64url === 'string' &&
    value.image_sha256_base64url.length === 43 &&
    typeof value.manifest_base64url === 'string' &&
    value.manifest_base64url.length === 154 &&
    typeof value.tag_authorization_proof_base64url === 'string' &&
    value.tag_authorization_proof_base64url.length === 43 &&
    typeof value.image_url === 'string' &&
    value.image_url.startsWith('/')
  );
}

function isFirmwareUpdateAcknowledgement(
  value: unknown,
): value is FirmwareUpdateAcknowledgement {
  return (
    isRecord(value) &&
    hasString(value, 'device_id') &&
    isFirmwareVersion(value.version) &&
    value.status === 'installed'
  );
}

function isProvisioningPlan(value: unknown): value is ProvisioningPlan {
  if (!isRecord(value)) return false;
  return (
    hasString(value, 'code') &&
    hasString(value, 'name') &&
    typeof value.amount_minor === 'number' &&
    Number.isSafeInteger(value.amount_minor) &&
    value.amount_minor >= 0 &&
    typeof value.currency === 'string' &&
    /^[A-Z]{3}$/.test(value.currency) &&
    (value.billing_interval === 'month' || value.billing_interval === 'year') &&
    typeof value.billing_interval_count === 'number' &&
    Number.isSafeInteger(value.billing_interval_count) &&
    value.billing_interval_count >= 1 &&
    value.billing_interval_count <= 12 &&
    [1, 3, 6, 12].includes(value.duration_months as number)
  );
}

function isProvisioningRequest(value: unknown): value is ProvisioningRequest {
  if (!isRecord(value)) return false;
  const statuses = new Set<ProvisioningRequestStatus>([
    'pending',
    'creating',
    'open',
    'paid',
    'claiming',
    'completed',
    'expired',
    'failed',
  ]);
  const plans = Array.isArray(value.available_plans) ? value.available_plans : [];
  return (
    hasString(value, 'request_id') &&
    hasString(value, 'device_id') &&
    hasString(value, 'serial_number') &&
    typeof value.status === 'string' &&
    statuses.has(value.status as ProvisioningRequestStatus) &&
    (value.plan_code === null || typeof value.plan_code === 'string') &&
    hasString(value, 'expires_at') &&
    (value.claim_deadline === null || typeof value.claim_deadline === 'string') &&
    plans.every(isProvisioningPlan)
  );
}

function isProvisioningCheckout(value: unknown): value is ProvisioningCheckout {
  return (
    isRecord(value) &&
    hasString(value, 'request_id') &&
    hasString(value, 'url') &&
    hasString(value, 'expires_at')
  );
}

export class ProvisioningApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(
    code: string,
    status?: number,
    requestId?: string,
  ) {
    super(code);
    this.name = 'ProvisioningApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export class PinqevaProvisioningClient {
  private readonly config: ProvisioningApiConfig;
  private readonly accessToken: () => Promise<string>;

  constructor(
    config: ProvisioningApiConfig,
    accessToken: () => Promise<string>,
  ) {
    this.config = config;
    this.accessToken = accessToken;
  }

  startDeviceClaim(input: {
    provisioningRequestId: string;
    serialNumber: string;
    idempotencyKey: string;
    tagChallengeBase64url: string;
    tagAdvertisementKeySha256Base64url: string | null;
    tagGoogleAdvertisementKeySha256Base64url: string | null;
    findingNetwork: 'apple' | 'google';
    tagFindingNetwork: 'apple' | 'google' | null;
  }): Promise<DeviceClaimStart> {
    return this.request(
      '/v1/devices/claim',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({
          serial_number: input.serialNumber,
          provisioning_request_id: input.provisioningRequestId,
          tag_challenge_base64url: input.tagChallengeBase64url,
          tag_advertisement_key_sha256_base64url:
            input.tagAdvertisementKeySha256Base64url,
          tag_google_advertisement_key_sha256_base64url:
            input.tagGoogleAdvertisementKeySha256Base64url,
          finding_network: input.findingNetwork,
          tag_finding_network: input.tagFindingNetwork,
        }),
      },
      isDeviceClaimStart,
    );
  }

  startProvisioningRequest(input: {
    serialNumber: string;
    idempotencyKey: string;
    tagChallengeBase64url: string;
    tagAdvertisementKeySha256Base64url: string | null;
    tagGoogleAdvertisementKeySha256Base64url: string | null;
    tagFindingNetwork: 'apple' | 'google' | null;
  }): Promise<ProvisioningRequest> {
    return this.request(
      '/v1/provisioning/requests',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({
          serial_number: input.serialNumber,
          tag_challenge_base64url: input.tagChallengeBase64url,
          tag_advertisement_key_sha256_base64url:
            input.tagAdvertisementKeySha256Base64url,
          tag_google_advertisement_key_sha256_base64url:
            input.tagGoogleAdvertisementKeySha256Base64url,
          tag_finding_network: input.tagFindingNetwork,
        }),
      },
      isProvisioningRequest,
    );
  }

  getProvisioningRequest(requestId: string): Promise<ProvisioningRequest> {
    return this.request(
      `/v1/provisioning/requests/${encodeURIComponent(requestId)}`,
      {},
      isProvisioningRequest,
    );
  }

  createProvisioningCheckout(input: {
    requestId: string;
    planCode: string;
  }): Promise<ProvisioningCheckout> {
    return this.request(
      `/v1/provisioning/requests/${encodeURIComponent(input.requestId)}/checkout`,
      {
        method: 'POST',
        body: JSON.stringify({ plan_code: input.planCode }),
      },
      isProvisioningCheckout,
    );
  }

  completeDeviceClaim(input: {
    claim: DeviceClaimStart;
    tagAdvertisementKeySha256Base64url: string;
    tagGoogleAdvertisementKeySha256Base64url: string;
  }): Promise<DeviceClaim> {
    return this.request(
      '/v1/devices/claim/complete',
      {
        method: 'POST',
        body: JSON.stringify({
          session_id: input.claim.session_id,
          serial_number: input.claim.serial_number,
          tag_advertisement_key_sha256_base64url:
            input.tagAdvertisementKeySha256Base64url,
          tag_google_advertisement_key_sha256_base64url:
            input.tagGoogleAdvertisementKeySha256Base64url,
          finding_network: input.claim.finding_network,
          claim_completion_token_base64url:
            input.claim.claim_completion_token_base64url,
        }),
      },
      isDeviceClaim,
    );
  }

  getFirmwareAvailability(deviceId: string): Promise<FirmwareAvailability> {
    return this.request(
      `/v1/devices/${encodeURIComponent(deviceId)}/firmware`,
      {},
      isFirmwareAvailability,
    );
  }

  startFirmwareUpdateSession(input: {
    deviceId: string;
    serialNumber: string;
    currentVersion: string;
    tagChallengeBase64url: string;
  }): Promise<FirmwareUpdateSession> {
    return this.request(
      `/v1/devices/${encodeURIComponent(input.deviceId)}/firmware/session`,
      {
        method: 'POST',
        body: JSON.stringify({
          serial_number: input.serialNumber,
          current_version: input.currentVersion,
          tag_challenge_base64url: input.tagChallengeBase64url,
        }),
      },
      isFirmwareUpdateSession,
    );
  }

  acknowledgeFirmwareUpdate(input: {
    deviceId: string;
    version: string;
    imageSha256Base64url: string;
  }): Promise<FirmwareUpdateAcknowledgement> {
    return this.request(
      `/v1/devices/${encodeURIComponent(input.deviceId)}/firmware/acknowledge`,
      {
        method: 'POST',
        body: JSON.stringify({
          version: input.version,
          image_sha256_base64url: input.imageSha256Base64url,
        }),
      },
      isFirmwareUpdateAcknowledgement,
    );
  }

  async downloadFirmwareImage(session: FirmwareUpdateSession): Promise<Uint8Array> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch {
      throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);
    }
    if (!token) throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);

    const base = new URL(this.config.baseUrl);
    const imageUrl = new URL(session.image_url, base);
    if (imageUrl.origin !== base.origin) {
      throw new ProvisioningApiError('INVALID_RESPONSE', 502);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FIRMWARE_DOWNLOAD_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(imageUrl.toString(), {
        headers: {
          Accept: 'application/octet-stream',
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
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
    const image = new Uint8Array(await response.arrayBuffer());
    if (image.length !== session.image_size || image.length === 0 || image[0] !== 0xe9) {
      image.fill(0);
      throw new ProvisioningApiError('INVALID_FIRMWARE_IMAGE', 502);
    }
    return image;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch {
      throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);
    }
    if (!token) throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: controller.signal,
      });
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

    const payload: unknown = await response.json().catch(() => null);
    if (!validate(payload)) throw new ProvisioningApiError('INVALID_RESPONSE', 502);
    return payload;
  }
}
