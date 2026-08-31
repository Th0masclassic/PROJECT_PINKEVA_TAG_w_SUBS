import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PinqevaApiError,
  PinqevaBackendClient,
  type DeviceClaimStart,
  type DeviceReleaseStart,
} from "./backend.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("backend error handling", () => {
  const claimInput = {
    provisioningRequestId: "33333333-3333-4333-8333-333333333333",
    serialNumber: "PKV-AABBCCDDEEFF",
    idempotencyKey: "provision:test-request-001",
    tagChallengeBase64url: "challenge",
    tagAdvertisementKeySha256Base64url: null,
    tagGoogleAdvertisementKeySha256Base64url: null,
    findingNetwork: "google" as const,
    tagFindingNetwork: null,
  };
  const validClaimStart: DeviceClaimStart = {
    session_id: "claim-session",
    serial_number: "PKV-AABBCCDDEEFF",
    protocol_version: 1,
    tag_action: "write_key",
    advertisement_key_base64url: "advertisement-key",
    advertisement_key_sha256_base64url: "advertisement-key-hash",
    google_advertisement_key_base64url: "google-advertisement-key",
    google_advertisement_key_sha256_base64url: "google-advertisement-key-hash",
    finding_network: "google",
    tag_authorization_proof_base64url: "authorization-proof",
    claim_completion_token_base64url: "completion-token",
    tag_control_key_base64url: "control-key",
    expires_at: "2026-08-24T12:00:00Z",
    claim_deadline: "2026-08-24T12:00:00Z",
  };
  const validClaim = {
    device_id: "device-id",
    serial_number: "PKV-AABBCCDDEEFF",
    status: "claimed",
    claimed_at: "2026-08-24T12:00:00Z",
    next_action: "ready",
    finding_network: "google",
  };
  const validReleaseStart: DeviceReleaseStart = {
    release_id: "release-id",
    device_id: "device-id",
    serial_number: "PKV-AABBCCDDEEFF",
    tag_authorization_proof_base64url: "authorization-proof",
    reset_command_base64url: "reset-command",
    release_completion_token_base64url: "release-token",
    expires_at: "2026-08-24T12:00:00Z",
  };
  const validRelease = {
    device_id: "device-id",
    serial_number: "PKV-AABBCCDDEEFF",
    status: "unprovisioned",
    released_at: "2026-08-24T12:00:00Z",
    cancelled_subscriptions: 1,
    provider_cancellations_queued: 0,
    next_action: "ready_for_new_owner",
  };

  function clientReturning(responseBody: unknown): PinqevaBackendClient {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    return new PinqevaBackendClient(
      "https://api.pinqeva.example/",
      async () => "access-token",
    );
  }

  it("keeps backend diagnostics out of the user-visible error", async () => {
    const internalMessage = "database row and private key details";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "RECOVERY_REQUIRED",
              message: internalMessage,
              request_id: "request-123",
            },
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const client = new PinqevaBackendClient(
      "https://api.pinqeva.example/",
      async () => "access-token",
    );

    const request = client.startDeviceClaim(claimInput);

    await expect(request).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      status: 409,
      requestId: "request-123",
    });
    await expect(request).rejects.not.toThrow(internalMessage);
  });

  it("uses a typed safe error when the response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gateway details", { status: 503 })),
    );

    const client = new PinqevaBackendClient(
      "https://api.pinqeva.example/",
      async () => "access-token",
    );

    try {
      await client.startDeviceClaim(claimInput);
      throw new Error("Expected the request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PinqevaApiError);
      expect((error as Error).message).toBe(
        "Unable to complete the request. Please try again.",
      );
      expect((error as Error).message).not.toContain("gateway");
    }
  });

  it("uses a typed safe error when an error response contains JSON null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("null", {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const client = new PinqevaBackendClient(
      "https://api.pinqeva.example/",
      async () => "access-token",
    );

    await expect(client.startDeviceClaim(claimInput)).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: 500,
    });
  });

  it("authorizes ring through the owner endpoint with only the fresh challenge", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        device_id: "device-id",
        serial_number: "PKV-AABBCCDDEEFF",
        ring_authorization_proof_base64url: "A".repeat(43),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new PinqevaBackendClient(
      "https://api.pinqeva.example/",
      async () => "fresh-access-token",
    );

    await expect(client.authorizeRing({
      deviceId: "device-id",
      serialNumber: "PKV-AABBCCDDEEFF",
      tagChallengeBase64url: "challenge-value",
    })).resolves.toMatchObject({ device_id: "device-id" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe("https://api.pinqeva.example/v1/devices/device-id/ring/authorize");
    expect(init.headers).toMatchObject({ Authorization: "Bearer fresh-access-token" });
    expect(JSON.parse(String(init.body))).toEqual({
      serial_number: "PKV-AABBCCDDEEFF",
      tag_challenge_base64url: "challenge-value",
    });
  });

  it.each([
    {
      name: "access token failure",
      baseUrl: "https://api.pinqeva.example/",
      accessToken: async () => {
        throw new Error("private auth provider diagnostics");
      },
      fetchValue: undefined,
      code: "AUTH_TOKEN_UNAVAILABLE",
      status: 401,
    },
    {
      name: "invalid API URL",
      baseUrl: "not a URL",
      accessToken: async () => "access-token",
      fetchValue: undefined,
      code: "CLIENT_CONFIGURATION_ERROR",
      status: 0,
    },
    {
      name: "network failure",
      baseUrl: "https://api.pinqeva.example/",
      accessToken: async () => "access-token",
      fetchValue: new Error("private proxy hostname and port"),
      code: "NETWORK_ERROR",
      status: 0,
    },
  ])("sanitizes $name", async ({ baseUrl, accessToken, fetchValue, code, status }) => {
    if (fetchValue) {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchValue));
    }
    const client = new PinqevaBackendClient(baseUrl, accessToken);

    await expect(client.startDeviceClaim(claimInput)).rejects.toMatchObject({
      code,
      status,
    });
    await expect(client.startDeviceClaim(claimInput)).rejects.not.toThrow(
      /private|proxy|provider/i,
    );
  });

  it.each(["private upstream response", "null", "[]"])(
    "sanitizes malformed successful responses: %s",
    async (responseBody) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(responseBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const client = new PinqevaBackendClient(
      "https://api.pinqeva.example/",
      async () => "access-token",
    );

    const request = client.startDeviceClaim(claimInput);
    await expect(request).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 502,
    });
    await expect(request).rejects.not.toThrow(/private|upstream/i);
    },
  );

  it.each([
    {
      name: "claim start",
      body: validClaim,
      call: (client: PinqevaBackendClient) =>
        client.startDeviceClaim(claimInput),
    },
    {
      name: "claim completion",
      body: validClaimStart,
      call: (client: PinqevaBackendClient) =>
        client.completeDeviceClaim({
          claim: validClaimStart,
          tagAdvertisementKeySha256Base64url: "advertisement-key-hash",
          tagGoogleAdvertisementKeySha256Base64url: "google-advertisement-key-hash",
        }),
    },
    {
      name: "release start",
      body: validRelease,
      call: (client: PinqevaBackendClient) =>
        client.startDeviceRelease({
          deviceId: "device-id",
          serialNumber: "PKV-AABBCCDDEEFF",
          tagAdvertisementKeySha256Base64url: "advertisement-key-hash",
          tagGoogleAdvertisementKeySha256Base64url: "google-advertisement-key-hash",
          findingNetwork: "google",
          tagChallengeBase64url: "challenge",
          idempotencyKey: "release:test-request-001",
        }),
    },
    {
      name: "release completion",
      body: validReleaseStart,
      call: (client: PinqevaBackendClient) =>
        client.completeDeviceRelease({ release: validReleaseStart }),
    },
  ])("rejects a malformed $name response", async ({ body, call }) => {
    const request = call(clientReturning(body));

    await expect(request).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 502,
    });
  });

  it.each([
    {
      name: "claim start",
      body: validClaimStart,
      call: (client: PinqevaBackendClient) =>
        client.startDeviceClaim(claimInput),
    },
    {
      name: "claim completion",
      body: validClaim,
      call: (client: PinqevaBackendClient) =>
        client.completeDeviceClaim({
          claim: validClaimStart,
          tagAdvertisementKeySha256Base64url: "advertisement-key-hash",
          tagGoogleAdvertisementKeySha256Base64url: "google-advertisement-key-hash",
        }),
    },
    {
      name: "release start",
      body: validReleaseStart,
      call: (client: PinqevaBackendClient) =>
        client.startDeviceRelease({
          deviceId: "device-id",
          serialNumber: "PKV-AABBCCDDEEFF",
          tagAdvertisementKeySha256Base64url: "advertisement-key-hash",
          tagGoogleAdvertisementKeySha256Base64url: "google-advertisement-key-hash",
          findingNetwork: "google",
          tagChallengeBase64url: "challenge",
          idempotencyKey: "release:test-request-001",
        }),
    },
    {
      name: "release completion",
      body: validRelease,
      call: (client: PinqevaBackendClient) =>
        client.completeDeviceRelease({ release: validReleaseStart }),
    },
  ])("accepts a valid $name response", async ({ body, call }) => {
    await expect(call(clientReturning(body))).resolves.toEqual(body);
  });
});
