import {
  BleManager,
  type Device,
  type State,
} from '@sfourdrinier/react-native-ble-plx';
import { PermissionsAndroid, Platform } from 'react-native';

import type { PinqevaProvisioningClient } from './api';
import { normalizeAdvertisedSerial } from './protocol';
import { TagProvisioner, type ProvisioningProgress } from './provisionTag';
import type { DiscoveredTag, StopTagScan, TagRadio } from './radio.types';
import { TagRadioError } from './radio.types';

const ADAPTER_READY_TIMEOUT_MS = 15_000;

async function requestAndroidPermissions(): Promise<void> {
  if (Platform.OS !== 'android') return;

  const required =
    Number(Platform.Version) >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const results = await PermissionsAndroid.requestMultiple(required);
  if (required.some((permission) => results[permission] !== PermissionsAndroid.RESULTS.GRANTED)) {
    throw new TagRadioError('BLUETOOTH_PERMISSION_DENIED');
  }
}

function stateError(state: keyof typeof State): TagRadioError | null {
  if (state === 'Unauthorized') return new TagRadioError('BLUETOOTH_PERMISSION_DENIED');
  if (state === 'PoweredOff') return new TagRadioError('BLUETOOTH_POWERED_OFF');
  if (state === 'Unsupported') return new TagRadioError('BLUETOOTH_UNSUPPORTED');
  return null;
}

class NativeTagRadio implements TagRadio {
  private readonly manager = new BleManager();
  private scanning = false;
  private destroyed = false;

  async startScan(
    onTag: (tag: DiscoveredTag) => void,
    onError: (error: unknown) => void,
  ): Promise<StopTagScan> {
    if (this.destroyed) throw new TagRadioError('BLUETOOTH_UNAVAILABLE');
    await requestAndroidPermissions();
    await this.waitUntilReady();
    if (this.scanning) await this.stopScan();

    this.scanning = true;
    try {
      await this.manager.startDeviceScan(
        null,
        { allowDuplicates: true },
        (error, device) => {
          if (error) {
            this.scanning = false;
            onError(new TagRadioError('BLUETOOTH_SCAN_FAILED'));
            return;
          }
          const tag = device ? this.toDiscoveredTag(device) : null;
          if (tag) onTag(tag);
        },
      );
    } catch {
      this.scanning = false;
      throw new TagRadioError('BLUETOOTH_SCAN_FAILED');
    }

    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      await this.stopScan();
    };
  }

  provision(
    backend: PinqevaProvisioningClient,
    input: {
      peripheralId: string;
      idempotencyKey: string;
      provisioningRequestId: string;
      onProgress: (progress: ProvisioningProgress) => void;
    },
  ) {
    if (this.destroyed) throw new TagRadioError('BLUETOOTH_UNAVAILABLE');
    return new TagProvisioner(this.manager, backend).provision(input);
  }

  inspectTag(
    backend: PinqevaProvisioningClient,
    input: {
      peripheralId: string;
      onProgress: (progress: ProvisioningProgress) => void;
    },
  ) {
    if (this.destroyed) throw new TagRadioError('BLUETOOTH_UNAVAILABLE');
    return new TagProvisioner(this.manager, backend).inspectTag(input);
  }

  installEntitlement(
    backend: PinqevaProvisioningClient,
    input: {
      peripheralId: string;
      deviceId: string;
      serialNumber: string;
      onProgress: (progress: ProvisioningProgress) => void;
    },
  ) {
    if (this.destroyed) throw new TagRadioError('BLUETOOTH_UNAVAILABLE');
    return new TagProvisioner(this.manager, backend).installEntitlement(input);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.stopScan();
    await this.manager.destroy().catch(() => undefined);
  }

  private async stopScan(): Promise<void> {
    if (!this.scanning) return;
    this.scanning = false;
    await this.manager.stopDeviceScan().catch(() => undefined);
  }

  private toDiscoveredTag(device: Device): DiscoveredTag | null {
    const serialNumber =
      normalizeAdvertisedSerial(device.localName) ?? normalizeAdvertisedSerial(device.name);
    if (!serialNumber) return null;
    return {
      peripheralId: device.id,
      serialNumber,
      rssi: typeof device.rssi === 'number' ? device.rssi : null,
    };
  }

  private async waitUntilReady(): Promise<void> {
    const current = await this.manager.state();
    if (current === 'PoweredOn') return;
    const immediateError = stateError(current);
    if (immediateError) throw immediateError;

    await new Promise<void>((resolve, reject) => {
      let finished = false;
      let subscription: { remove(): void } | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        subscription?.remove();
        error ? reject(error) : resolve();
      };
      subscription = this.manager.onStateChange((nextState) => {
        if (nextState === 'PoweredOn') finish();
        else {
          const error = stateError(nextState);
          if (error) finish(error);
        }
      }, true);
      if (finished) {
        subscription.remove();
        return;
      }
      timeout = setTimeout(
        () => finish(new TagRadioError('BLUETOOTH_UNAVAILABLE')),
        ADAPTER_READY_TIMEOUT_MS,
      );
    });
  }
}

export function createTagRadio(): TagRadio {
  return new NativeTagRadio();
}

export type { DiscoveredTag, StopTagScan, TagRadio } from './radio.types';
