import type { DeviceClaim, PinqevaProvisioningClient } from './api';
import type { ProvisioningProgress } from './provisionTag';

export type DiscoveredTag = {
  peripheralId: string;
  serialNumber: string;
  rssi: number | null;
};

export type StopTagScan = () => Promise<void>;

export interface TagRadio {
  startScan(
    onTag: (tag: DiscoveredTag) => void,
    onError: (error: unknown) => void,
  ): Promise<StopTagScan>;
  provision(
    backend: PinqevaProvisioningClient,
    input: {
      peripheralId: string;
      idempotencyKey: string;
      onProgress: (progress: ProvisioningProgress) => void;
    },
  ): Promise<DeviceClaim>;
  destroy(): Promise<void>;
}

export class TagRadioError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'TagRadioError';
    this.code = code;
  }
}
