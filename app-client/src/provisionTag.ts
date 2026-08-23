import type { BleManager, Characteristic, Device, Subscription } from "react-native-ble-plx";

import {
  PinqevaBackendClient,
  type DeviceClaim,
  type DeviceRelease,
} from "./backend.js";
import {
  ADVERTISEMENT_KEY_LENGTH,
  ADVERTISEMENT_KEY_UUID,
  AUTHENTICATED_RESET_UUID,
  DEVICE_IDENTIFIER_UUID,
  KEY_FINGERPRINT_UUID,
  PINQEVA_SERVICE_UUID,
  PROTOCOL_INFO_UUID,
  PROVISIONING_STATUS_UUID,
  ProvisioningClientError,
  RESET_COMMAND_LENGTH,
  TAG_CONTROL_KEY_LENGTH,
  TAG_CONTROL_KEY_UUID,
  bytesEqual,
  decodeBase64Url,
  decodeBleBase64,
  decodeDeviceIdentifier,
  decodeTagKeyFingerprint,
  encodeBase64Url,
  parseProtocolInformation,
  provisioningStatusIsReady,
  toBleBase64,
} from "./protocol.js";

export type ProvisionTagInput = {
  peripheralId: string;
  expectedSerialNumber: string;
  setupCode: string;
  idempotencyKey: string;
  timeoutMs?: number;
};

export type ReleaseTagInput = {
  peripheralId: string;
  deviceId: string;
  expectedSerialNumber: string;
  idempotencyKey: string;
};

export class TagProvisioner {
  constructor(
    private readonly ble: BleManager,
    private readonly backend: PinqevaBackendClient,
  ) {}

  async provision(input: ProvisionTagInput): Promise<DeviceClaim> {
    let device: Device | undefined;
    let statusSubscription: Subscription | undefined;
    let cancelReadyWait: (() => void) | undefined;
    try {
      device = await this.ble.connectToDevice(input.peripheralId, { timeout: 15_000 });
      device = await device.discoverAllServicesAndCharacteristics();
      // Android commonly starts at ATT MTU 23. Request 128 for the 64-byte
      // reset command; firmware also supports prepared writes for every value.
      device = await device.requestMTU(128).catch(() => device as Device);

      const [protocolCharacteristic, identifierCharacteristic, fingerprintCharacteristic] = await Promise.all([
        device.readCharacteristicForService(PINQEVA_SERVICE_UUID, PROTOCOL_INFO_UUID),
        device.readCharacteristicForService(PINQEVA_SERVICE_UUID, DEVICE_IDENTIFIER_UUID),
        device.readCharacteristicForService(PINQEVA_SERVICE_UUID, KEY_FINGERPRINT_UUID),
      ]);
      const protocol = parseProtocolInformation(decodeBleBase64(protocolCharacteristic.value));
      if (protocol.protocolMajor !== 1) {
        throw new ProvisioningClientError(
          "UNSUPPORTED_PROTOCOL",
          `Tag protocol ${protocol.protocolMajor}.${protocol.protocolMinor} is not supported`,
        );
      }

      const serialNumber = decodeDeviceIdentifier(
        decodeBleBase64(identifierCharacteristic.value),
      );
      if (serialNumber !== input.expectedSerialNumber.toUpperCase()) {
        throw new ProvisioningClientError(
          "SERIAL_MISMATCH",
          "The connected tag does not match the scanned QR code",
        );
      }

      const initialFingerprint = decodeTagKeyFingerprint(
        decodeBleBase64(fingerprintCharacteristic.value),
      );
      const claim = await this.backend.startDeviceClaim({
        serialNumber,
        setupCode: input.setupCode,
        idempotencyKey: input.idempotencyKey,
        tagAdvertisementKeySha256Base64url:
          initialFingerprint === null ? null : encodeBase64Url(initialFingerprint),
      });
      if (claim.serial_number !== serialNumber || claim.protocol_version !== 1) {
        throw new ProvisioningClientError(
          "BACKEND_BINDING_MISMATCH",
          "The claim is bound to a different tag or protocol",
        );
      }
      if (claim.tag_action === "write_key" && Date.parse(claim.expires_at) <= Date.now()) {
        throw new ProvisioningClientError(
          "SESSION_EXPIRED",
          "The key-delivery window expired before the BLE transfer",
        );
      }

      const expectedFingerprint = decodeBase64Url(
        claim.advertisement_key_sha256_base64url,
      );
      if (expectedFingerprint.length !== 32) {
        throw new ProvisioningClientError(
          "INVALID_BACKEND_KEY",
          "Expected a 32-byte advertisement-key fingerprint",
        );
      }

      if (claim.tag_action === "write_key") {
        if (initialFingerprint !== null) {
          throw new ProvisioningClientError(
            "BACKEND_BINDING_MISMATCH",
            "Backend requested a write although the tag already contains a key",
          );
        }
        const advertisementKey = decodeBase64Url(claim.advertisement_key_base64url);
        if (claim.tag_control_key_base64url === null) {
          advertisementKey.fill(0);
          throw new ProvisioningClientError(
            "MISSING_BACKEND_CONTROL_KEY",
            "Backend omitted the control key for an empty tag",
          );
        }
        const controlKey = decodeBase64Url(claim.tag_control_key_base64url);
        if (advertisementKey.length !== ADVERTISEMENT_KEY_LENGTH) {
          throw new ProvisioningClientError(
            "INVALID_BACKEND_KEY",
            `Expected ${ADVERTISEMENT_KEY_LENGTH} advertisement-key bytes`,
          );
        }
        if (controlKey.length !== TAG_CONTROL_KEY_LENGTH) {
          advertisementKey.fill(0);
          throw new ProvisioningClientError(
            "INVALID_BACKEND_CONTROL_KEY",
            `Expected ${TAG_CONTROL_KEY_LENGTH} tag-control bytes`,
          );
        }

        const readyWait = this.waitForReady(
          device,
          input.timeoutMs ?? 20_000,
          (subscription) => {
            statusSubscription = subscription;
          },
        );
        cancelReadyWait = readyWait.cancel;
        // Install the reset-control secret first. Firmware permits an identical
        // retry but rejects replacement. The advertisement key is committed only
        // after this succeeds, so every normally provisioned tag is transferable.
        try {
          await device.writeCharacteristicWithResponseForService(
            PINQEVA_SERVICE_UUID,
            TAG_CONTROL_KEY_UUID,
            toBleBase64(controlKey),
          );
          await device.writeCharacteristicWithResponseForService(
            PINQEVA_SERVICE_UUID,
            ADVERTISEMENT_KEY_UUID,
            toBleBase64(advertisementKey),
          );
        } finally {
          advertisementKey.fill(0);
          controlKey.fill(0);
        }
        const currentStatus = await device
          .readCharacteristicForService(PINQEVA_SERVICE_UUID, PROVISIONING_STATUS_UUID)
          .catch(() => null);
        if (
          currentStatus === null ||
          !provisioningStatusIsReady(decodeBleBase64(currentStatus.value))
        ) {
          await readyWait.promise;
        }
      } else if (
        initialFingerprint === null ||
        !bytesEqual(initialFingerprint, expectedFingerprint)
      ) {
        throw new ProvisioningClientError(
          "TAG_KEY_MISMATCH",
          "The stored tag key does not match the backend allocation",
        );
      }

      const confirmedFingerprintCharacteristic = await device.readCharacteristicForService(
        PINQEVA_SERVICE_UUID,
        KEY_FINGERPRINT_UUID,
      );
      const confirmedFingerprint = decodeTagKeyFingerprint(
        decodeBleBase64(confirmedFingerprintCharacteristic.value),
      );
      if (
        confirmedFingerprint === null ||
        !bytesEqual(confirmedFingerprint, expectedFingerprint)
      ) {
        throw new ProvisioningClientError(
          "TAG_KEY_MISMATCH",
          "The tag did not persist the backend-allocated advertisement key",
        );
      }

      return await this.backend.completeDeviceClaim({
        claim,
        tagAdvertisementKeySha256Base64url: encodeBase64Url(confirmedFingerprint),
      });
    } finally {
      cancelReadyWait?.();
      statusSubscription?.remove();
      if (device) {
        await this.ble.cancelDeviceConnection(device.id).catch(() => undefined);
      }
    }
  }

  async release(input: ReleaseTagInput): Promise<DeviceRelease> {
    let device: Device | undefined;
    try {
      device = await this.ble.connectToDevice(input.peripheralId, { timeout: 15_000 });
      device = await device.discoverAllServicesAndCharacteristics();
      device = await device.requestMTU(128).catch(() => device as Device);

      const [protocolCharacteristic, identifierCharacteristic, fingerprintCharacteristic] =
        await Promise.all([
          device.readCharacteristicForService(PINQEVA_SERVICE_UUID, PROTOCOL_INFO_UUID),
          device.readCharacteristicForService(PINQEVA_SERVICE_UUID, DEVICE_IDENTIFIER_UUID),
          device.readCharacteristicForService(PINQEVA_SERVICE_UUID, KEY_FINGERPRINT_UUID),
        ]);
      const protocol = parseProtocolInformation(
        decodeBleBase64(protocolCharacteristic.value),
      );
      if (protocol.protocolMajor !== 1 || (protocol.capabilities & 0x08) === 0) {
        throw new ProvisioningClientError(
          "AUTHENTICATED_RESET_UNSUPPORTED",
          "This tag requires operator-assisted recovery before transfer",
        );
      }
      const serialNumber = decodeDeviceIdentifier(
        decodeBleBase64(identifierCharacteristic.value),
      );
      if (serialNumber !== input.expectedSerialNumber.toUpperCase()) {
        throw new ProvisioningClientError(
          "SERIAL_MISMATCH",
          "The connected tag does not match the device being removed",
        );
      }
      const fingerprint = decodeTagKeyFingerprint(
        decodeBleBase64(fingerprintCharacteristic.value),
      );
      if (fingerprint === null) {
        throw new ProvisioningClientError(
          "RECOVERY_REQUIRED",
          "The backend owns this tag but the tag contains no key",
        );
      }

      const release = await this.backend.startDeviceRelease({
        deviceId: input.deviceId,
        serialNumber,
        tagAdvertisementKeySha256Base64url: encodeBase64Url(fingerprint),
        idempotencyKey: input.idempotencyKey,
      });
      if (release.serial_number !== serialNumber || release.device_id !== input.deviceId) {
        throw new ProvisioningClientError(
          "BACKEND_BINDING_MISMATCH",
          "The release command is bound to another device",
        );
      }
      if (Date.parse(release.expires_at) <= Date.now()) {
        throw new ProvisioningClientError(
          "RELEASE_EXPIRED",
          "The authenticated reset command expired",
        );
      }
      const resetCommand = decodeBase64Url(release.reset_command_base64url);
      if (resetCommand.length !== RESET_COMMAND_LENGTH) {
        throw new ProvisioningClientError(
          "INVALID_RESET_COMMAND",
          `Expected ${RESET_COMMAND_LENGTH} reset-command bytes`,
        );
      }
      try {
        await device.writeCharacteristicWithResponseForService(
          PINQEVA_SERVICE_UUID,
          AUTHENTICATED_RESET_UUID,
          toBleBase64(resetCommand),
        );
      } finally {
        resetCommand.fill(0);
      }

      const emptyFingerprintCharacteristic = await device.readCharacteristicForService(
        PINQEVA_SERVICE_UUID,
        KEY_FINGERPRINT_UUID,
      );
      if (
        decodeTagKeyFingerprint(decodeBleBase64(emptyFingerprintCharacteristic.value)) !== null
      ) {
        throw new ProvisioningClientError(
          "TAG_RESET_FAILED",
          "The tag did not confirm erasure of its advertisement key",
        );
      }
      return await this.backend.completeDeviceRelease({ release });
    } finally {
      if (device) {
        await this.ble.cancelDeviceConnection(device.id).catch(() => undefined);
      }
    }
  }

  private waitForReady(
    device: Device,
    timeoutMs: number,
    setSubscription: (subscription: Subscription) => void,
  ): { promise: Promise<void>; cancel: () => void } {
    let cancel = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve();
      };
      const timeout = setTimeout(
        () =>
          finish(
            new ProvisioningClientError(
              "TAG_CONFIRMATION_TIMEOUT",
              "The tag did not confirm persistent key storage",
            ),
          ),
        timeoutMs,
      );
      cancel = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
      };
      const subscription = device.monitorCharacteristicForService(
        PINQEVA_SERVICE_UUID,
        PROVISIONING_STATUS_UUID,
        (error: Error | null, characteristic: Characteristic | null) => {
          if (error) {
            finish(error);
            return;
          }
          if (!characteristic) return;
          try {
            if (provisioningStatusIsReady(decodeBleBase64(characteristic.value))) {
              finish();
            }
          } catch (statusError) {
            finish(
              statusError instanceof Error
                ? statusError
                : new ProvisioningClientError(
                    "INVALID_TAG_STATUS",
                    "Tag returned an invalid provisioning status",
                  ),
            );
          }
        },
      );
      setSubscription(subscription);
    });
    return { promise, cancel: () => cancel() };
  }
}
