import type {
  BleManager,
  Characteristic,
  Device,
  Subscription,
} from '@sfourdrinier/react-native-ble-plx';

import {
  PinqevaProvisioningClient,
  type DeviceClaim,
} from './api';
import {
  ADVERTISEMENT_KEY_LENGTH,
  ADVERTISEMENT_KEY_UUID,
  DEVICE_IDENTIFIER_UUID,
  KEY_FINGERPRINT_UUID,
  PINKEVA_SERVICE_UUID,
  PROTOCOL_INFO_UUID,
  PROVISIONING_STATUS_UUID,
  ProvisioningClientError,
  TAG_AUTHORIZATION_CAPABILITY,
  TAG_AUTHORIZATION_PROOF_LENGTH,
  TAG_AUTHORIZATION_PROOF_UUID,
  TAG_CHALLENGE_LENGTH,
  TAG_CHALLENGE_UUID,
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
} from './protocol';

export type ProvisioningProgress =
  | 'connecting'
  | 'verifying'
  | 'authorizing'
  | 'installing'
  | 'associating';

export class TagProvisioner {
  constructor(
    private readonly ble: BleManager,
    private readonly backend: PinqevaProvisioningClient,
  ) {}

  async provision(input: {
    peripheralId: string;
    idempotencyKey: string;
    timeoutMs?: number;
    onProgress?: (progress: ProvisioningProgress) => void;
  }): Promise<DeviceClaim> {
    let device: Device | undefined;
    let statusSubscription: Subscription | undefined;
    let cancelReadyWait: (() => void) | undefined;

    try {
      input.onProgress?.('connecting');
      device = await this.ble.connectToDevice(input.peripheralId, { timeout: 15_000 });
      device = await device.discoverAllServicesAndCharacteristics();
      device = await device.requestMTU(128).catch(() => device as Device);

      input.onProgress?.('verifying');
      const [protocolValue, identifierValue, fingerprintValue, challengeValue] =
        await Promise.all([
          device.readCharacteristicForService(PINKEVA_SERVICE_UUID, PROTOCOL_INFO_UUID),
          device.readCharacteristicForService(PINKEVA_SERVICE_UUID, DEVICE_IDENTIFIER_UUID),
          device.readCharacteristicForService(PINKEVA_SERVICE_UUID, KEY_FINGERPRINT_UUID),
          device.readCharacteristicForService(PINKEVA_SERVICE_UUID, TAG_CHALLENGE_UUID),
        ]);

      const protocol = parseProtocolInformation(decodeBleBase64(protocolValue.value));
      if (
        protocol.protocolMajor !== 1 ||
        (protocol.capabilities & TAG_AUTHORIZATION_CAPABILITY) === 0
      ) {
        throw new ProvisioningClientError(
          'UNSUPPORTED_PROTOCOL',
          'The tag does not support secure app provisioning',
        );
      }

      const serialNumber = decodeDeviceIdentifier(decodeBleBase64(identifierValue.value));
      const tagChallenge = decodeBleBase64(challengeValue.value);
      if (tagChallenge.length !== TAG_CHALLENGE_LENGTH) {
        throw new ProvisioningClientError('INVALID_TAG_CHALLENGE', 'Unexpected tag challenge');
      }
      const initialFingerprint = decodeTagKeyFingerprint(
        decodeBleBase64(fingerprintValue.value),
      );

      input.onProgress?.('authorizing');
      const claim = await this.backend.startDeviceClaim({
        serialNumber,
        idempotencyKey: input.idempotencyKey,
        tagChallengeBase64url: encodeBase64Url(tagChallenge),
        tagAdvertisementKeySha256Base64url:
          initialFingerprint === null ? null : encodeBase64Url(initialFingerprint),
      });
      if (claim.serial_number !== serialNumber || claim.protocol_version !== 1) {
        throw new ProvisioningClientError(
          'BACKEND_BINDING_MISMATCH',
          'The backend response is bound to a different tag',
        );
      }
      if (claim.tag_action === 'write_key' && Date.parse(claim.expires_at) <= Date.now()) {
        throw new ProvisioningClientError('SESSION_EXPIRED', 'The setup window expired');
      }

      const expectedFingerprint = decodeBase64Url(
        claim.advertisement_key_sha256_base64url,
      );
      if (expectedFingerprint.length !== 32) {
        throw new ProvisioningClientError('INVALID_BACKEND_KEY', 'Unexpected backend key');
      }

      const authorizationProof = decodeBase64Url(
        claim.tag_authorization_proof_base64url,
      );
      if (authorizationProof.length !== TAG_AUTHORIZATION_PROOF_LENGTH) {
        throw new ProvisioningClientError(
          'INVALID_BACKEND_AUTHORIZATION',
          'Unexpected backend authorization',
        );
      }
      try {
        await device.writeCharacteristicWithResponseForService(
          PINKEVA_SERVICE_UUID,
          TAG_AUTHORIZATION_PROOF_UUID,
          toBleBase64(authorizationProof),
        );
      } finally {
        authorizationProof.fill(0);
        tagChallenge.fill(0);
      }

      if (claim.tag_action === 'write_key') {
        if (initialFingerprint !== null) {
          throw new ProvisioningClientError(
            'BACKEND_BINDING_MISMATCH',
            'The tag key state does not match the backend allocation',
          );
        }

        const advertisementKey = decodeBase64Url(claim.advertisement_key_base64url);
        if (claim.tag_control_key_base64url === null) {
          advertisementKey.fill(0);
          throw new ProvisioningClientError(
            'MISSING_BACKEND_CONTROL_KEY',
            'The backend omitted required setup material',
          );
        }
        const controlKey = decodeBase64Url(claim.tag_control_key_base64url);
        if (advertisementKey.length !== ADVERTISEMENT_KEY_LENGTH) {
          advertisementKey.fill(0);
          controlKey.fill(0);
          throw new ProvisioningClientError('INVALID_BACKEND_KEY', 'Unexpected backend key');
        }
        if (controlKey.length !== TAG_CONTROL_KEY_LENGTH) {
          advertisementKey.fill(0);
          controlKey.fill(0);
          throw new ProvisioningClientError(
            'INVALID_BACKEND_CONTROL_KEY',
            'Unexpected backend control key',
          );
        }

        input.onProgress?.('installing');
        const readyWait = this.waitForReady(
          device,
          input.timeoutMs ?? 20_000,
          (subscription) => {
            statusSubscription = subscription;
          },
        );
        cancelReadyWait = readyWait.cancel;

        try {
          // Install the reset-control secret first. Firmware accepts identical
          // retries but refuses replacement of either value.
          await device.writeCharacteristicWithResponseForService(
            PINKEVA_SERVICE_UUID,
            TAG_CONTROL_KEY_UUID,
            toBleBase64(controlKey),
          );
          await device.writeCharacteristicWithResponseForService(
            PINKEVA_SERVICE_UUID,
            ADVERTISEMENT_KEY_UUID,
            toBleBase64(advertisementKey),
          );
        } finally {
          advertisementKey.fill(0);
          controlKey.fill(0);
        }

        const currentStatus = await device
          .readCharacteristicForService(PINKEVA_SERVICE_UUID, PROVISIONING_STATUS_UUID)
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
          'TAG_KEY_MISMATCH',
          'The stored tag key does not match the backend allocation',
        );
      }

      const confirmedValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        KEY_FINGERPRINT_UUID,
      );
      const confirmedFingerprint = decodeTagKeyFingerprint(
        decodeBleBase64(confirmedValue.value),
      );
      if (
        confirmedFingerprint === null ||
        !bytesEqual(confirmedFingerprint, expectedFingerprint)
      ) {
        throw new ProvisioningClientError(
          'TAG_KEY_MISMATCH',
          'The tag did not persist the backend allocation',
        );
      }

      input.onProgress?.('associating');
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
              'TAG_CONFIRMATION_TIMEOUT',
              'The tag did not confirm setup',
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
        PINKEVA_SERVICE_UUID,
        PROVISIONING_STATUS_UUID,
        (error: Error | null, characteristic: Characteristic | null) => {
          if (error) {
            finish(error);
            return;
          }
          if (!characteristic) return;
          try {
            if (provisioningStatusIsReady(decodeBleBase64(characteristic.value))) finish();
          } catch (statusError) {
            finish(
              statusError instanceof Error
                ? statusError
                : new ProvisioningClientError('INVALID_TAG_STATUS', 'Unexpected tag status'),
            );
          }
        },
      );
      setSubscription(subscription);
    });
    return { promise, cancel };
  }
}
