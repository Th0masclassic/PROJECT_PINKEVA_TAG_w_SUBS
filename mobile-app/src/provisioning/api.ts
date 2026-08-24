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
  tag_authorization_proof_base64url: string;
  claim_completion_token_base64url: string;
  tag_control_key_base64url: string | null;
  expires_at: string;
  claim_deadline: string;
};

export type DeviceClaim = {
  device_id: string;
  serial_number: string;
  status: 'suspended';
  claimed_at: string;
  next_action: 'install_signed_entitlement';
};

type ErrorEnvelope = {
  error?: { code?: string; request_id?: string };
};

const REQUEST_TIMEOUT_MS = 20_000;

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
    value.status === 'suspended' &&
    hasString(value, 'claimed_at') &&
    value.next_action === 'install_signed_entitlement'
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
    serialNumber: string;
    idempotencyKey: string;
    tagChallengeBase64url: string;
    tagAdvertisementKeySha256Base64url: string | null;
  }): Promise<DeviceClaimStart> {
    return this.request(
      '/v1/devices/claim',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({
          serial_number: input.serialNumber,
          tag_challenge_base64url: input.tagChallengeBase64url,
          tag_advertisement_key_sha256_base64url:
            input.tagAdvertisementKeySha256Base64url,
        }),
      },
      isDeviceClaimStart,
    );
  }

  completeDeviceClaim(input: {
    claim: DeviceClaimStart;
    tagAdvertisementKeySha256Base64url: string;
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
          claim_completion_token_base64url:
            input.claim.claim_completion_token_base64url,
        }),
      },
      isDeviceClaim,
    );
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
