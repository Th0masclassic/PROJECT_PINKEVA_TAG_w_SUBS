import type { BleManager, Device } from '@sfourdrinier/react-native-ble-plx';

import type { DeviceRelease, PinqevaProvisioningClient } from './api';
import { PINKEVA_SERVICE_UUID, ProvisioningClientError, normalizeAdvertisedSerial } from './protocol';
import { TagProvisioner, type ReleaseProgress } from './provisionTag';

export type NearbyReleaseProgress = 'searching' | ReleaseProgress;

export type NearbyReleaseInput = {
  deviceId: string;
  serialNumber: string;
  idempotencyKey: string;
  signal: AbortSignal;
  onProgress?: (progress: NearbyReleaseProgress) => void;
  onResetVerified?: Parameters<TagProvisioner['release']>[0]['onResetVerified'];
  onCompleted?: Parameters<TagProvisioner['release']>[0]['onCompleted'];
  scanTimeoutMs?: number;
};

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ProvisioningClientError('RELEASE_CANCELLED', 'Tracker release cancelled');
  }
}

export class TagReleaser {
  constructor(
    private readonly ble: BleManager,
    private readonly backend: PinqevaProvisioningClient,
  ) {}

  async releaseNearby(input: NearbyReleaseInput): Promise<DeviceRelease> {
    const expectedSerial = normalizeAdvertisedSerial(input.serialNumber);
    if (!expectedSerial) {
      throw new ProvisioningClientError('INVALID_DEVICE_ID', 'Invalid tracker serial');
    }
    const deadline = Date.now() + (input.scanTimeoutMs ?? 30_000);
    const seen = new Set<string>();
    while (Date.now() < deadline) {
      requireActive(input.signal);
      input.onProgress?.('searching');
      const candidate = await this.nextCandidate(input, seen, deadline, expectedSerial);
      seen.add(candidate.id);
      try {
        return await new TagProvisioner(this.ble, this.backend).release({
          peripheralId: candidate.id,
          deviceId: input.deviceId,
          expectedSerialNumber: expectedSerial,
          idempotencyKey: input.idempotencyKey,
          signal: input.signal,
          onProgress: input.onProgress,
          onResetVerified: input.onResetVerified,
          onCompleted: input.onCompleted,
        });
      } catch (error) {
        const code = error && typeof error === 'object'
          ? (error as { code?: unknown }).code
          : undefined;
        if (code !== 'SERIAL_MISMATCH') throw error;
      }
    }
    throw new ProvisioningClientError('RELEASE_NOT_FOUND', 'Tracker not found nearby');
  }

  private async nextCandidate(
    input: NearbyReleaseInput,
    seen: Set<string>,
    deadline: number,
    expectedSerial: string,
  ): Promise<Device> {
    requireActive(input.signal);
    try {
      return await new Promise<Device>((resolve, reject) => {
        let finished = false;
        const finish = (error?: unknown, device?: Device) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          input.signal.removeEventListener('abort', abort);
          error ? reject(error) : resolve(device as Device);
        };
        const abort = () => finish(
          new ProvisioningClientError('RELEASE_CANCELLED', 'Tracker release cancelled'),
        );
        const timeout = setTimeout(
          () => finish(
            new ProvisioningClientError('RELEASE_NOT_FOUND', 'Tracker not found nearby'),
          ),
          Math.max(1, deadline - Date.now()),
        );
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) {
          abort();
          return;
        }
        try {
          void Promise.resolve(this.ble.startDeviceScan(
            [PINKEVA_SERVICE_UUID],
            { allowDuplicates: false },
            (error, device) => {
              if (error) {
                finish(error);
                return;
              }
              if (!device || seen.has(device.id)) return;
              const advertisedSerial =
                normalizeAdvertisedSerial(device.localName) ??
                normalizeAdvertisedSerial(device.name);
              if (advertisedSerial && advertisedSerial !== expectedSerial) return;
              finish(undefined, device);
            },
          )).catch((error) => finish(error));
        } catch (error) {
          finish(error);
        }
      });
    } finally {
      await Promise.resolve(this.ble.stopDeviceScan()).catch(() => undefined);
    }
  }
}
