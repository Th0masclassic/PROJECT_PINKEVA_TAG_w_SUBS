export type DeviceClaimStart = {
  session_id: string;
  serial_number: string;
  protocol_version: 1;
  tag_action: "write_key" | "verify_existing_key";
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
  status: "suspended";
  claimed_at: string;
  next_action: "install_signed_entitlement";
};

export type DeviceReleaseStart = {
  release_id: string;
  device_id: string;
  serial_number: string;
  tag_authorization_proof_base64url: string;
  reset_command_base64url: string;
  release_completion_token_base64url: string;
  expires_at: string;
};

export type DeviceRelease = {
  device_id: string;
  serial_number: string;
  status: "unprovisioned";
  released_at: string;
  cancelled_subscriptions: number;
  provider_cancellations_queued: number;
  next_action: "ready_for_new_owner";
};

type ErrorEnvelope = {
  error?: { code?: string; request_id?: string };
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function hasNullableString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === null || typeof value[key] === "string";
}

function hasNonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const field = value[key];
  return typeof field === "number" && Number.isInteger(field) && field >= 0;
}

function isDeviceClaimStart(value: unknown): value is DeviceClaimStart {
  if (!isJsonObject(value)) return false;
  return (
    hasString(value, "session_id") &&
    hasString(value, "serial_number") &&
    value.protocol_version === 1 &&
    (value.tag_action === "write_key" ||
      value.tag_action === "verify_existing_key") &&
    hasString(value, "advertisement_key_base64url") &&
    hasString(value, "advertisement_key_sha256_base64url") &&
    hasString(value, "tag_authorization_proof_base64url") &&
    hasString(value, "claim_completion_token_base64url") &&
    hasNullableString(value, "tag_control_key_base64url") &&
    hasString(value, "expires_at") &&
    hasString(value, "claim_deadline")
  );
}

function isDeviceClaim(value: unknown): value is DeviceClaim {
  if (!isJsonObject(value)) return false;
  return (
    hasString(value, "device_id") &&
    hasString(value, "serial_number") &&
    value.status === "suspended" &&
    hasString(value, "claimed_at") &&
    value.next_action === "install_signed_entitlement"
  );
}

function isDeviceReleaseStart(value: unknown): value is DeviceReleaseStart {
  if (!isJsonObject(value)) return false;
  return (
    hasString(value, "release_id") &&
    hasString(value, "device_id") &&
    hasString(value, "serial_number") &&
    hasString(value, "tag_authorization_proof_base64url") &&
    hasString(value, "reset_command_base64url") &&
    hasString(value, "release_completion_token_base64url") &&
    hasString(value, "expires_at")
  );
}

function isDeviceRelease(value: unknown): value is DeviceRelease {
  if (!isJsonObject(value)) return false;
  return (
    hasString(value, "device_id") &&
    hasString(value, "serial_number") &&
    value.status === "unprovisioned" &&
    hasString(value, "released_at") &&
    hasNonNegativeInteger(value, "cancelled_subscriptions") &&
    hasNonNegativeInteger(value, "provider_cancellations_queued") &&
    value.next_action === "ready_for_new_owner"
  );
}

export class PinqevaApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(publicMessage(status));
    this.name = "PinqevaApiError";
  }
}

function publicMessage(status: number): string {
  if (status === 401) return "Please sign in again and retry.";
  if (status === 403) return "This request is not allowed.";
  if (status === 409) return "The request could not be completed in its current state.";
  if (status === 422) return "Please check the information and try again.";
  if (status === 429) return "Too many attempts. Please wait and try again.";
  return "Unable to complete the request. Please try again.";
}

export class PinqevaBackendClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: () => Promise<string>,
  ) {}

  async startDeviceClaim(input: {
    serialNumber: string;
    idempotencyKey: string;
    tagChallengeBase64url: string;
    tagAdvertisementKeySha256Base64url: string | null;
  }): Promise<DeviceClaimStart> {
    return this.request<DeviceClaimStart>(
      "/v1/devices/claim",
      {
        method: "POST",
        headers: { "Idempotency-Key": input.idempotencyKey },
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

  async completeDeviceClaim(input: {
    claim: DeviceClaimStart;
    tagAdvertisementKeySha256Base64url: string;
  }): Promise<DeviceClaim> {
    return this.request<DeviceClaim>(
      "/v1/devices/claim/complete",
      {
        method: "POST",
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

  async startDeviceRelease(input: {
    deviceId: string;
    serialNumber: string;
    tagAdvertisementKeySha256Base64url: string;
    tagChallengeBase64url: string;
    idempotencyKey: string;
  }): Promise<DeviceReleaseStart> {
    return this.request<DeviceReleaseStart>(
      `/v1/devices/${encodeURIComponent(input.deviceId)}/release`,
      {
        method: "POST",
        headers: { "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify({
          serial_number: input.serialNumber,
          tag_challenge_base64url: input.tagChallengeBase64url,
          tag_advertisement_key_sha256_base64url:
            input.tagAdvertisementKeySha256Base64url,
        }),
      },
      isDeviceReleaseStart,
    );
  }

  async completeDeviceRelease(input: {
    release: DeviceReleaseStart;
  }): Promise<DeviceRelease> {
    return this.request<DeviceRelease>(
      `/v1/devices/${encodeURIComponent(input.release.device_id)}/release/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          release_id: input.release.release_id,
          serial_number: input.release.serial_number,
          tag_key_state: "empty",
          release_completion_token_base64url:
            input.release.release_completion_token_base64url,
        }),
      },
      isDeviceRelease,
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    let url: URL;
    try {
      url = new URL(path, this.baseUrl);
    } catch {
      throw new PinqevaApiError("CLIENT_CONFIGURATION_ERROR", 0);
    }

    let token: string;
    try {
      token = await this.accessToken();
    } catch {
      throw new PinqevaApiError("AUTH_TOKEN_UNAVAILABLE", 401);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
    } catch {
      throw new PinqevaApiError("NETWORK_ERROR", 0);
    }
    if (!response.ok) {
      const parsedBody: unknown = await response.json().catch(() => ({}));
      const body: ErrorEnvelope = isJsonObject(parsedBody)
        ? (parsedBody as ErrorEnvelope)
        : {};
      throw new PinqevaApiError(
        body.error?.code ?? "REQUEST_FAILED",
        response.status,
        body.error?.request_id ?? response.headers.get("X-Request-ID") ?? undefined,
      );
    }
    try {
      const body: unknown = await response.json();
      if (!validate(body)) {
        throw new Error("Unexpected response shape");
      }
      return body;
    } catch {
      throw new PinqevaApiError("INVALID_RESPONSE", 502);
    }
  }
}
