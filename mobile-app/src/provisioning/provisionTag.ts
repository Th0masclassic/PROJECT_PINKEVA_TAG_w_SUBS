import type {
  BleManager,
  Characteristic,
  Device,
  Subscription,
} from '@sfourdrinier/react-native-ble-plx';

import {
  PinqevaProvisioningClient,
  type DeviceClaim,
} from './api.ts';
import {
  ADVERTISEMENT_KEY_LENGTH,
  ADVERTISEMENT_KEY_UUID,
  DEVICE_IDENTIFIER_UUID,
  DUAL_FINDING_NETWORK_CAPABILITY,
  FINDING_NETWORK_UUID,
  GOOGLE_ADVERTISEMENT_KEY_LENGTH,
  GOOGLE_ADVERTISEMENT_KEY_UUID,
  GOOGLE_KEY_FINGERPRINT_UUID,
  KEY_FINGERPRINT_UUID,
  NON_BONDING_SETUP_CAPABILITY,
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
  UTC_TIME_SYNC_CAPABILITY,
  UTC_TIME_UUID,
  bytesEqual,
  decodeBase64Url,
  decodeBleBase64,
  decodeDeviceIdentifier,
  decodeFindingNetwork,
  decodeGoogleKeyFingerprint,
  decodeTagKeyFingerprint,
  encodeFindingNetwork,
  encodeBase64Url,
  encodeUtcUnixSeconds,
  parseProtocolInformation,
  provisioningStatusIsReady,
  toBleBase64,
  type FindingNetwork,
} from './protocol.ts';

export type ProvisioningProgress =
  | 'connecting'
  | 'verifying'
  | 'authorizing'
  | 'installing'
  | 'associating';

export type TagIdentity = {
  serialNumber: string;
  tagChallengeBase64url: string;
  tagAdvertisementKeySha256Base64url: string | null;
  tagGoogleAdvertisementKeySha256Base64url: string | null;
  findingNetwork: FindingNetwork | null;
};

// Provisioning is a one-shot BLE session. The app deliberately does not call
// any platform pairing/bonding API (the BLE library does not expose one), does
// not request an automatic reconnect, and never persists the peripheral ID.
// The required protocol capability confirms that the firmware will not mark
// setup characteristics as OS-encryption-required, because iOS treats that as
// a system pairing flow.
const NON_BONDING_CONNECTION_OPTIONS = Object.freeze({
  autoConnect: false,
  timeout: 15_000,
});

export class TagProvisioner {
  private readonly ble: BleManager;
  private readonly backend: PinqevaProvisioningClient;
  private readonly now: () => Date;

  constructor(
    ble: BleManager,
    backend: PinqevaProvisioningClient,
    now: () => Date = () => new Date(),
  ) {
    this.ble = ble;
    this.backend = backend;
    this.now = now;
  }

  private async syncUtcTime(device: Device): Promise<void> {
    await device.writeCharacteristicWithResponseForService(
      PINKEVA_SERVICE_UUID,
      UTC_TIME_UUID,
      toBleBase64(encodeUtcUnixSeconds(this.now())),
    );
  }

  async inspectTag(input: {
    peripheralId: string;
    onProgress?: (progress: ProvisioningProgress) => void;
  }): Promise<TagIdentity> {
    let device: Device | undefined;
    try {
      input.onProgress?.('connecting');
      device = await this.ble.connectToDevice(
        input.peripheralId,
        NON_BONDING_CONNECTION_OPTIONS,
      );
      device = await device.discoverAllServicesAndCharacteristics();
      device = await device.requestMTU(128).catch(() => device as Device);

      input.onProgress?.('verifying');
      const protocolValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        PROTOCOL_INFO_UUID,
      );
      const identifierValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        DEVICE_IDENTIFIER_UUID,
      );
      const fingerprintValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        KEY_FINGERPRINT_UUID,
      );
      const googleFingerprintValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        GOOGLE_KEY_FINGERPRINT_UUID,
      );
      const findingNetworkValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        FINDING_NETWORK_UUID,
      );
      const challengeValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        TAG_CHALLENGE_UUID,
      );
      const protocol = parseProtocolInformation(decodeBleBase64(protocolValue.value));
      if (
        protocol.protocolMajor !== 1 ||
        (protocol.capabilities & TAG_AUTHORIZATION_CAPABILITY) === 0 ||
        (protocol.capabilities & NON_BONDING_SETUP_CAPABILITY) === 0 ||
        (protocol.capabilities & UTC_TIME_SYNC_CAPABILITY) === 0 ||
        (protocol.capabilities & DUAL_FINDING_NETWORK_CAPABILITY) === 0
      ) {
        throw new ProvisioningClientError(
          'UNSUPPORTED_PROTOCOL',
          'The tag does not support non-bonding app provisioning',
        );
      }
      const serialNumber = decodeDeviceIdentifier(
        decodeBleBase64(identifierValue.value),
      );
      const challenge = decodeBleBase64(challengeValue.value);
      if (challenge.length !== TAG_CHALLENGE_LENGTH) {
        throw new ProvisioningClientError(
          'INVALID_TAG_CHALLENGE',
          'Unexpected tag challenge',
        );
      }
      const fingerprint = decodeTagKeyFingerprint(
        decodeBleBase64(fingerprintValue.value),
      );
      const googleFingerprint = decodeGoogleKeyFingerprint(
        decodeBleBase64(googleFingerprintValue.value),
      );
      return {
        serialNumber,
        tagChallengeBase64url: encodeBase64Url(challenge),
        tagAdvertisementKeySha256Base64url:
          fingerprint === null ? null : encodeBase64Url(fingerprint),
        tagGoogleAdvertisementKeySha256Base64url:
          googleFingerprint === null ? null : encodeBase64Url(googleFingerprint),
        findingNetwork: decodeFindingNetwork(
          decodeBleBase64(findingNetworkValue.value),
        ),
      };
    } finally {
      if (device) {
        await this.ble.cancelDeviceConnection(device.id).catch(() => undefined);
      }
    }
  }

  async provision(input: {
    peripheralId: string;
    idempotencyKey: string;
    provisioningRequestId: string;
    findingNetwork: FindingNetwork;
    timeoutMs?: number;
    onProgress?: (progress: ProvisioningProgress) => void;
  }): Promise<DeviceClaim> {
    let device: Device | undefined;
    let statusSubscription: Subscription | undefined;
    let cancelReadyWait: (() => void) | undefined;
    let tagChallenge: Uint8Array | undefined;

    try {
      input.onProgress?.('connecting');
      device = await this.ble.connectToDevice(
        input.peripheralId,
        NON_BONDING_CONNECTION_OPTIONS,
      );
      device = await device.discoverAllServicesAndCharacteristics();
      device = await device.requestMTU(128).catch(() => device as Device);

      input.onProgress?.('verifying');
      // Read the public identity first, then the encrypted setup values in
      // sequence. On iOS and some Android stacks, the first encrypted GATT
      // operation triggers link encryption; issuing the fingerprint and
      // challenge reads concurrently can race that handshake and make a valid
      // tag look unavailable.
      const protocolValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        PROTOCOL_INFO_UUID,
      );
      const identifierValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        DEVICE_IDENTIFIER_UUID,
      );
      const fingerprintValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        KEY_FINGERPRINT_UUID,
      );
      const googleFingerprintValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        GOOGLE_KEY_FINGERPRINT_UUID,
      );
      const findingNetworkValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        FINDING_NETWORK_UUID,
      );
      const challengeValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        TAG_CHALLENGE_UUID,
      );

      const protocol = parseProtocolInformation(decodeBleBase64(protocolValue.value));
      if (
        protocol.protocolMajor !== 1 ||
        (protocol.capabilities & TAG_AUTHORIZATION_CAPABILITY) === 0 ||
        (protocol.capabilities & NON_BONDING_SETUP_CAPABILITY) === 0 ||
        (protocol.capabilities & UTC_TIME_SYNC_CAPABILITY) === 0 ||
        (protocol.capabilities & DUAL_FINDING_NETWORK_CAPABILITY) === 0
      ) {
        throw new ProvisioningClientError(
          'UNSUPPORTED_PROTOCOL',
          'The tag does not support non-bonding app provisioning',
        );
      }

      const serialNumber = decodeDeviceIdentifier(decodeBleBase64(identifierValue.value));
      tagChallenge = decodeBleBase64(challengeValue.value);
      if (tagChallenge.length !== TAG_CHALLENGE_LENGTH) {
        throw new ProvisioningClientError('INVALID_TAG_CHALLENGE', 'Unexpected tag challenge');
      }
      const initialFingerprint = decodeTagKeyFingerprint(
        decodeBleBase64(fingerprintValue.value),
      );
      const initialGoogleFingerprint = decodeGoogleKeyFingerprint(
        decodeBleBase64(googleFingerprintValue.value),
      );
      const initialFindingNetwork = decodeFindingNetwork(
        decodeBleBase64(findingNetworkValue.value),
      );
      if (
        initialFindingNetwork !== null &&
        initialFindingNetwork !== input.findingNetwork
      ) {
        throw new ProvisioningClientError(
          'FINDING_NETWORK_MISMATCH',
          'The tag is already configured for a different finding network',
        );
      }

      input.onProgress?.('authorizing');
      const claim = await this.backend.startDeviceClaim({
        provisioningRequestId: input.provisioningRequestId,
        serialNumber,
        idempotencyKey: input.idempotencyKey,
        tagChallengeBase64url: encodeBase64Url(tagChallenge),
        tagAdvertisementKeySha256Base64url:
          initialFingerprint === null ? null : encodeBase64Url(initialFingerprint),
        tagGoogleAdvertisementKeySha256Base64url:
          initialGoogleFingerprint === null
            ? null
            : encodeBase64Url(initialGoogleFingerprint),
        findingNetwork: input.findingNetwork,
        tagFindingNetwork: initialFindingNetwork,
      });
      if (
        claim.serial_number !== serialNumber ||
        claim.protocol_version !== 1 ||
        claim.finding_network !== input.findingNetwork
      ) {
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
      const expectedGoogleFingerprint = decodeBase64Url(
        claim.google_advertisement_key_sha256_base64url,
      );
      if (expectedGoogleFingerprint.length !== 32) {
        throw new ProvisioningClientError(
          'INVALID_BACKEND_KEY',
          'Unexpected backend Google key',
        );
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
      }
      await this.syncUtcTime(device);

      if (
        (initialFingerprint !== null &&
          !bytesEqual(initialFingerprint, expectedFingerprint)) ||
        (initialGoogleFingerprint !== null &&
          !bytesEqual(initialGoogleFingerprint, expectedGoogleFingerprint))
      ) {
        throw new ProvisioningClientError(
          'TAG_KEY_MISMATCH',
          'A stored tag key does not match the backend allocation',
        );
      }

      if (claim.tag_action === 'write_key') {
        const advertisementKey = decodeBase64Url(claim.advertisement_key_base64url);
        const googleAdvertisementKey = decodeBase64Url(
          claim.google_advertisement_key_base64url,
        );
        if (claim.tag_control_key_base64url === null) {
          advertisementKey.fill(0);
          googleAdvertisementKey.fill(0);
          throw new ProvisioningClientError(
            'MISSING_BACKEND_CONTROL_KEY',
            'The backend omitted required setup material',
          );
        }
        const controlKey = decodeBase64Url(claim.tag_control_key_base64url);
        if (
          advertisementKey.length !== ADVERTISEMENT_KEY_LENGTH ||
          googleAdvertisementKey.length !== GOOGLE_ADVERTISEMENT_KEY_LENGTH
        ) {
          advertisementKey.fill(0);
          googleAdvertisementKey.fill(0);
          controlKey.fill(0);
          throw new ProvisioningClientError('INVALID_BACKEND_KEY', 'Unexpected backend key');
        }
        if (controlKey.length !== TAG_CONTROL_KEY_LENGTH) {
          advertisementKey.fill(0);
          googleAdvertisementKey.fill(0);
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
          // Each value is write-once. Identical writes make interrupted setup
          // safe to retry; replacement still requires a factory reset.
          await device.writeCharacteristicWithResponseForService(
            PINKEVA_SERVICE_UUID,
            TAG_CONTROL_KEY_UUID,
            toBleBase64(controlKey),
          );
          if (initialGoogleFingerprint === null) {
            await device.writeCharacteristicWithResponseForService(
              PINKEVA_SERVICE_UUID,
              GOOGLE_ADVERTISEMENT_KEY_UUID,
              toBleBase64(googleAdvertisementKey),
            );
          }
          if (initialFindingNetwork === null) {
            await device.writeCharacteristicWithResponseForService(
              PINKEVA_SERVICE_UUID,
              FINDING_NETWORK_UUID,
              toBleBase64(encodeFindingNetwork(input.findingNetwork)),
            );
          }
          if (initialFingerprint === null) {
            await device.writeCharacteristicWithResponseForService(
              PINKEVA_SERVICE_UUID,
              ADVERTISEMENT_KEY_UUID,
              toBleBase64(advertisementKey),
            );
          }
        } finally {
          advertisementKey.fill(0);
          googleAdvertisementKey.fill(0);
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
        initialGoogleFingerprint === null ||
        initialFindingNetwork !== input.findingNetwork
      ) {
        throw new ProvisioningClientError(
          'TAG_KEY_MISMATCH',
          'The tag does not contain the complete backend allocation',
        );
      }

      const confirmedValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        KEY_FINGERPRINT_UUID,
      );
      const confirmedFingerprint = decodeTagKeyFingerprint(
        decodeBleBase64(confirmedValue.value),
      );
      const confirmedGoogleValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        GOOGLE_KEY_FINGERPRINT_UUID,
      );
      const confirmedGoogleFingerprint = decodeGoogleKeyFingerprint(
        decodeBleBase64(confirmedGoogleValue.value),
      );
      const confirmedNetworkValue = await device.readCharacteristicForService(
        PINKEVA_SERVICE_UUID,
        FINDING_NETWORK_UUID,
      );
      const confirmedFindingNetwork = decodeFindingNetwork(
        decodeBleBase64(confirmedNetworkValue.value),
      );
      if (
        confirmedFingerprint === null ||
        !bytesEqual(confirmedFingerprint, expectedFingerprint) ||
        confirmedGoogleFingerprint === null ||
        !bytesEqual(confirmedGoogleFingerprint, expectedGoogleFingerprint) ||
        confirmedFindingNetwork !== input.findingNetwork
      ) {
        throw new ProvisioningClientError(
          'TAG_KEY_MISMATCH',
          'The tag did not persist the backend allocation',
        );
      }

      input.onProgress?.('associating');
      const completedClaim = await this.backend.completeDeviceClaim({
        claim,
        tagAdvertisementKeySha256Base64url: encodeBase64Url(confirmedFingerprint),
        tagGoogleAdvertisementKeySha256Base64url: encodeBase64Url(
          confirmedGoogleFingerprint,
        ),
      });
      if (completedClaim.finding_network !== input.findingNetwork) {
        throw new ProvisioningClientError(
          'BACKEND_BINDING_MISMATCH',
          'The completed claim changed finding networks',
        );
      }
      cancelReadyWait?.();
      statusSubscription?.remove();
      cancelReadyWait = undefined;
      statusSubscription = undefined;
      return completedClaim;
    } finally {
      cancelReadyWait?.();
      statusSubscription?.remove();
      tagChallenge?.fill(0);
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
