import { describe, expect, it } from "vitest";

import {
  bytesEqual,
  decodeBase64Url,
  decodeDeviceIdentifier,
  decodeTagKeyFingerprint,
  encodeBase64Url,
  normalizeAdvertisedSerial,
  parseProtocolInformation,
  parseRingStatus,
  provisioningStatusIsReady,
  toBleBase64,
} from "./protocol.js";

describe("provisioning protocol", () => {
  it("parses the six-byte little-endian protocol value", () => {
    expect(parseProtocolInformation(Uint8Array.of(1, 0, 2, 7, 3, 1))).toEqual({
      protocolMajor: 1,
      protocolMinor: 0,
      firmwareMajor: 2,
      firmwareMinor: 7,
      capabilities: 0x0103,
    });
  });

  it("decodes an exact tag identifier", () => {
    const encoded = new TextEncoder().encode("PKV-AABBCCDDEEFF");
    expect(decodeDeviceIdentifier(encoded)).toBe("PKV-AABBCCDDEEFF");
  });

  it("converts backend base64url to BLE base64", () => {
    const bytes = Uint8Array.from({ length: 28 }, (_, index) => index);
    const base64url = toBleBase64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodeBase64Url(base64url)).toEqual(bytes);
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
  });

  it("distinguishes an empty tag from a stored-key fingerprint", () => {
    expect(decodeTagKeyFingerprint(new Uint8Array(32))).toBeNull();
    const fingerprint = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    expect(decodeTagKeyFingerprint(fingerprint)).toEqual(fingerprint);
    expect(bytesEqual(fingerprint, fingerprint.slice())).toBe(true);
    expect(bytesEqual(fingerprint, new Uint8Array(32))).toBe(false);
  });

  it("accepts only Ready / Success as complete", () => {
    expect(provisioningStatusIsReady(Uint8Array.of(0x04, 0x00))).toBe(true);
    expect(provisioningStatusIsReady(Uint8Array.of(0x03, 0x00))).toBe(false);
    expect(() => provisioningStatusIsReady(Uint8Array.of(0x7f, 0x03))).toThrow(
      /result 0x03/,
    );
  });

  it("parses only consistent ring states and canonical tracker serials", () => {
    expect(parseRingStatus(Uint8Array.of(1, 1))).toEqual({
      playing: true,
      source: "owner",
    });
    expect(parseRingStatus(Uint8Array.of(1, 2))).toEqual({
      playing: true,
      source: "dult",
    });
    expect(parseRingStatus(Uint8Array.of(0, 0))).toEqual({
      playing: false,
      source: "none",
    });
    expect(() => parseRingStatus(Uint8Array.of(0, 1))).toThrow(/ring status/i);
    expect(normalizeAdvertisedSerial(" pkv-aabbccddeeff ")).toBe(
      "PKV-AABBCCDDEEFF",
    );
    expect(normalizeAdvertisedSerial("PKV-not-a-tag")).toBeNull();
  });
});
