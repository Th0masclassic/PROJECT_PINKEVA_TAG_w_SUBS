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

type ErrorEnvelope = { error?: { code?: string; message?: string } };

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
    return this.request<DeviceClaimStart>("/v1/devices/claim", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        serial_number: input.serialNumber,
        tag_challenge_base64url: input.tagChallengeBase64url,
        tag_advertisement_key_sha256_base64url:
          input.tagAdvertisementKeySha256Base64url,
      }),
    });
  }

  async completeDeviceClaim(input: {
    claim: DeviceClaimStart;
    tagAdvertisementKeySha256Base64url: string;
  }): Promise<DeviceClaim> {
    return this.request<DeviceClaim>("/v1/devices/claim/complete", {
      method: "POST",
      body: JSON.stringify({
        session_id: input.claim.session_id,
        serial_number: input.claim.serial_number,
        tag_advertisement_key_sha256_base64url:
          input.tagAdvertisementKeySha256Base64url,
        claim_completion_token_base64url:
          input.claim.claim_completion_token_base64url,
      }),
    });
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
    );
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const token = await this.accessToken();
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as ErrorEnvelope;
      throw new Error(
        body.error?.message ?? `Pinqeva backend request failed (${response.status})`,
      );
    }
    return (await response.json()) as T;
  }
}
