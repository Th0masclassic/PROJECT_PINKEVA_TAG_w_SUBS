import type { BleManager, Device } from '@sfourdrinier/react-native-ble-plx';

import { PinqevaProvisioningClient, type FirmwareUpdateSession } from './api';
import { sha256Digest } from './digest';
import {
  DEVICE_IDENTIFIER_UUID,
  FIRMWARE_CONTROL_UUID,
  FIRMWARE_DATA_UUID,
  FIRMWARE_MANIFEST_LENGTH,
  FIRMWARE_MANIFEST_UUID,
  FIRMWARE_STATUS_UUID,
  FIRMWARE_UPDATE_CAPABILITY,
  FIRMWARE_VERSION_UUID,
  PINKEVA_SERVICE_UUID,
  PROTOCOL_INFO_UUID,
  ProvisioningClientError,
  TAG_AUTHORIZATION_CAPABILITY,
  TAG_AUTHORIZATION_PROOF_LENGTH,
  TAG_AUTHORIZATION_PROOF_UUID,
  TAG_CHALLENGE_LENGTH,
  TAG_CHALLENGE_UUID,
  bytesEqual,
  decodeBase64Url,
  decodeBleBase64,
  decodeDeviceIdentifier,
  encodeBase64Url,
  parseFirmwareStatus,
  parseFirmwareVersion,
  parseProtocolInformation,
  toBleBase64,
} from './protocol';

const CONNECTION_OPTIONS = Object.freeze({ autoConnect: false, timeout: 15_000 });
const REBOOT_VERIFICATION_TIMEOUT_MS = 35_000;
const CHUNKS_BETWEEN_STATUS_CHECKS = 32;

export type FirmwareUpdateProgress = {
  phase: 'connecting' | 'verifying' | 'authorizing' | 'downloading' | 'installing' | 'restarting';
  percent: number;
};

export type InstalledFirmware = {
  deviceId: string;
  version: string;
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readUint32Be(value: Uint8Array, offset: number): number {
  return (
    value[offset] * 0x1000000 +
    (value[offset + 1] << 16) +
    (value[offset + 2] << 8) +
    value[offset + 3]
  );
}

function validateSessionManifest(session: FirmwareUpdateSession, manifest: Uint8Array): void {
  if (manifest.length !== FIRMWARE_MANIFEST_LENGTH || manifest[0] !== 1 || manifest[1] !== 1) {
    throw new ProvisioningClientError('INVALID_FIRMWARE_MANIFEST', 'Unexpected firmware manifest');
  }
  const version = `${manifest[2]}.${manifest[3]}.${manifest[4]}`;
  if (version !== session.version || readUint32Be(manifest, 6) !== session.image_size) {
    throw new ProvisioningClientError('BACKEND_BINDING_MISMATCH', 'Firmware manifest binding mismatch');
  }
  const expectedDigest = decodeBase64Url(session.image_sha256_base64url);
  try {
    if (expectedDigest.length !== 32 || !bytesEqual(manifest.slice(10, 42), expectedDigest)) {
      throw new ProvisioningClientError('BACKEND_BINDING_MISMATCH', 'Firmware digest binding mismatch');
    }
  } finally {
    expectedDigest.fill(0);
  }
}

export class TagFirmwareUpdater {
  constructor(
    private readonly ble: BleManager,
    private readonly backend: PinqevaProvisioningClient,
  ) {}

  async install(input: {
    peripheralId: string;
    deviceId: string;
    serialNumber: string;
    onProgress?: (progress: FirmwareUpdateProgress) => void;
  }): Promise<InstalledFirmware> {
    let device: Device | undefined;
    let image: Uint8Array | undefined;
    let manifestAccepted = false;
    let committed = false;
    try {
      input.onProgress?.({ phase: 'connecting', percent: 0 });
      device = await this.ble.connectToDevice(input.peripheralId, CONNECTION_OPTIONS);
      device = await device.discoverAllServicesAndCharacteristics();
      device = await device.requestMTU(247).catch(() => device as Device);

      input.onProgress?.({ phase: 'verifying', percent: 2 });
      const identity = await this.readUpdateIdentity(device);
      if (identity.serialNumber !== input.serialNumber) {
        throw new ProvisioningClientError(
          'BACKEND_BINDING_MISMATCH',
          'The connected tag does not match the selected tracker',
        );
      }

      input.onProgress?.({ phase: 'authorizing', percent: 4 });
      let session: FirmwareUpdateSession;
      try {
        session = await this.backend.startFirmwareUpdateSession({
          deviceId: input.deviceId,
          serialNumber: identity.serialNumber,
          currentVersion: identity.firmwareVersion,
          tagChallengeBase64url: encodeBase64Url(identity.challenge),
        });
      } finally {
        identity.challenge.fill(0);
      }
      if (
        session.device_id !== input.deviceId ||
        session.serial_number !== input.serialNumber
      ) {
        throw new ProvisioningClientError(
          'BACKEND_BINDING_MISMATCH',
          'Firmware session is bound to another tracker',
        );
      }
      if (!session.install_required) {
        if (identity.firmwareVersion !== session.version) {
          throw new ProvisioningClientError(
            'BACKEND_BINDING_MISMATCH',
            'The tracker version does not match the recovery session',
          );
        }
        const acknowledgement = await this.backend.acknowledgeFirmwareUpdate({
          deviceId: input.deviceId,
          version: session.version,
          imageSha256Base64url: session.image_sha256_base64url,
        });
        if (
          acknowledgement.device_id !== input.deviceId ||
          acknowledgement.version !== session.version
        ) {
          throw new ProvisioningClientError(
            'BACKEND_BINDING_MISMATCH',
            'Firmware acknowledgement is bound to another tracker',
          );
        }
        input.onProgress?.({ phase: 'restarting', percent: 100 });
        return { deviceId: input.deviceId, version: session.version };
      }

      const manifest = decodeBase64Url(session.manifest_base64url);
      const authorizationProof = decodeBase64Url(session.tag_authorization_proof_base64url);
      try {
        validateSessionManifest(session, manifest);
        if (authorizationProof.length !== TAG_AUTHORIZATION_PROOF_LENGTH) {
          throw new ProvisioningClientError(
            'INVALID_BACKEND_AUTHORIZATION',
            'Unexpected firmware authorization',
          );
        }
        await device.writeCharacteristicWithResponseForService(
          PINKEVA_SERVICE_UUID,
          TAG_AUTHORIZATION_PROOF_UUID,
          toBleBase64(authorizationProof),
        );

        input.onProgress?.({ phase: 'downloading', percent: 5 });
        image = await this.backend.downloadFirmwareImage(session);
        const actualDigest = await sha256Digest(image);
        const expectedDigest = decodeBase64Url(session.image_sha256_base64url);
        try {
          if (!bytesEqual(actualDigest, expectedDigest)) {
            throw new ProvisioningClientError(
              'FIRMWARE_DIGEST_MISMATCH',
              'Downloaded firmware digest mismatch',
            );
          }
        } finally {
          actualDigest.fill(0);
          expectedDigest.fill(0);
        }

        input.onProgress?.({ phase: 'installing', percent: 8 });
        await device.writeCharacteristicWithResponseForService(
          PINKEVA_SERVICE_UUID,
          FIRMWARE_MANIFEST_UUID,
          toBleBase64(manifest),
        );
        manifestAccepted = true;
      } finally {
        manifest.fill(0);
        authorizationProof.fill(0);
      }

      await this.requireFirmwareStatus(device, 0x01, 0, 0);
      const chunkSize = Math.max(20, Math.min(180, (device.mtu || 23) - 3));
      let sent = 0;
      let chunks = 0;
      while (sent < image.length) {
        const next = Math.min(image.length, sent + chunkSize);
        await device.writeCharacteristicWithResponseForService(
          PINKEVA_SERVICE_UUID,
          FIRMWARE_DATA_UUID,
          toBleBase64(image.subarray(sent, next)),
        );
        sent = next;
        chunks += 1;
        input.onProgress?.({
          phase: 'installing',
          percent: 8 + Math.floor((sent / image.length) * 84),
        });
        if (chunks % CHUNKS_BETWEEN_STATUS_CHECKS === 0 || sent === image.length) {
          await this.requireFirmwareStatus(device, 0x02, 0, sent);
        }
      }

      input.onProgress?.({ phase: 'restarting', percent: 94 });
      await device.writeCharacteristicWithResponseForService(
        PINKEVA_SERVICE_UUID,
        FIRMWARE_CONTROL_UUID,
        toBleBase64(Uint8Array.of(0x01)),
      );
      committed = true;
      await this.ble.cancelDeviceConnection(device.id).catch(() => undefined);
      device = undefined;

      const confirmedVersion = await this.verifyAfterReboot(
        input.peripheralId,
        input.serialNumber,
        session.version,
        (percent) => input.onProgress?.({ phase: 'restarting', percent }),
      );
      const acknowledgement = await this.backend.acknowledgeFirmwareUpdate({
        deviceId: input.deviceId,
        version: confirmedVersion,
        imageSha256Base64url: session.image_sha256_base64url,
      });
      if (
        acknowledgement.device_id !== input.deviceId ||
        acknowledgement.version !== session.version
      ) {
        throw new ProvisioningClientError(
          'BACKEND_BINDING_MISMATCH',
          'Firmware acknowledgement is bound to another tracker',
        );
      }
      input.onProgress?.({ phase: 'restarting', percent: 100 });
      return { deviceId: input.deviceId, version: session.version };
    } catch (error) {
      if (device && manifestAccepted && !committed) {
        await device
          .writeCharacteristicWithResponseForService(
            PINKEVA_SERVICE_UUID,
            FIRMWARE_CONTROL_UUID,
            toBleBase64(Uint8Array.of(0x02)),
          )
          .catch(() => undefined);
      }
      throw error;
    } finally {
      image?.fill(0);
      if (device) {
        await this.ble.cancelDeviceConnection(device.id).catch(() => undefined);
      }
    }
  }

  private async readUpdateIdentity(device: Device): Promise<{
    serialNumber: string;
    firmwareVersion: string;
    challenge: Uint8Array;
  }> {
    const protocolValue = await device.readCharacteristicForService(
      PINKEVA_SERVICE_UUID,
      PROTOCOL_INFO_UUID,
    );
    const protocol = parseProtocolInformation(decodeBleBase64(protocolValue.value));
    if (
      protocol.protocolMajor !== 1 ||
      (protocol.capabilities & TAG_AUTHORIZATION_CAPABILITY) === 0 ||
      (protocol.capabilities & FIRMWARE_UPDATE_CAPABILITY) === 0
    ) {
      throw new ProvisioningClientError(
        'UNSUPPORTED_PROTOCOL',
        'The tag does not support signed BLE firmware updates',
      );
    }
    const identifierValue = await device.readCharacteristicForService(
      PINKEVA_SERVICE_UUID,
      DEVICE_IDENTIFIER_UUID,
    );
    const firmwareVersionValue = await device.readCharacteristicForService(
      PINKEVA_SERVICE_UUID,
      FIRMWARE_VERSION_UUID,
    );
    const challengeValue = await device.readCharacteristicForService(
      PINKEVA_SERVICE_UUID,
      TAG_CHALLENGE_UUID,
    );
    const challenge = decodeBleBase64(challengeValue.value);
    if (challenge.length !== TAG_CHALLENGE_LENGTH) {
      throw new ProvisioningClientError('INVALID_TAG_CHALLENGE', 'Unexpected tag challenge');
    }
    return {
      serialNumber: decodeDeviceIdentifier(decodeBleBase64(identifierValue.value)),
      firmwareVersion: parseFirmwareVersion(decodeBleBase64(firmwareVersionValue.value)),
      challenge,
    };
  }

  private async requireFirmwareStatus(
    device: Device,
    expectedState: number,
    expectedResult: number,
    expectedBytes: number,
  ): Promise<void> {
    const value = await device.readCharacteristicForService(
      PINKEVA_SERVICE_UUID,
      FIRMWARE_STATUS_UUID,
    );
    const status = parseFirmwareStatus(decodeBleBase64(value.value));
    if (
      status.state !== expectedState ||
      status.result !== expectedResult ||
      status.receivedBytes !== expectedBytes
    ) {
      throw new ProvisioningClientError(
        'TAG_REJECTED_FIRMWARE',
        `Firmware transfer rejected (${status.state}:${status.result})`,
      );
    }
  }

  private async verifyAfterReboot(
    peripheralId: string,
    serialNumber: string,
    expectedVersion: string,
    onProgress: (percent: number) => void,
  ): Promise<string> {
    const deadline = Date.now() + REBOOT_VERIFICATION_TIMEOUT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      await wait(attempt === 1 ? 1_500 : 1_000);
      let device: Device | undefined;
      try {
        device = await this.ble.connectToDevice(peripheralId, CONNECTION_OPTIONS);
        device = await device.discoverAllServicesAndCharacteristics();
        const identity = await this.readUpdateIdentity(device);
        identity.challenge.fill(0);
        if (identity.serialNumber === serialNumber && identity.firmwareVersion === expectedVersion) {
          onProgress(99);
          return identity.firmwareVersion;
        }
      } catch {
        // The tracker is expected to disappear while the bootloader swaps slots.
      } finally {
        if (device) await this.ble.cancelDeviceConnection(device.id).catch(() => undefined);
      }
      onProgress(Math.min(98, 94 + attempt));
    }
    throw new ProvisioningClientError(
      'FIRMWARE_REBOOT_TIMEOUT',
      'The tracker did not return with the expected firmware',
    );
  }
}
