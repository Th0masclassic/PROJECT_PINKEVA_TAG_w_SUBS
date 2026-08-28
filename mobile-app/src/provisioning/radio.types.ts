import type {
  DeviceClaim,
  PinqevaProvisioningClient,
} from './api';
import type { ProvisioningProgress, TagIdentity } from './provisionTag';
import type { FirmwareUpdateProgress, InstalledFirmware } from './firmwareUpdate';

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
  inspectTag(
    backend: PinqevaProvisioningClient,
    input: {
      peripheralId: string;
      onProgress: (progress: ProvisioningProgress) => void;
    },
  ): Promise<TagIdentity>;
  provision(
    backend: PinqevaProvisioningClient,
    input: {
      peripheralId: string;
      idempotencyKey: string;
      provisioningRequestId: string;
      onProgress: (progress: ProvisioningProgress) => void;
    },
  ): Promise<DeviceClaim>;
  installFirmware(
    backend: PinqevaProvisioningClient,
    input: {
      peripheralId: string;
      deviceId: string;
      serialNumber: string;
      onProgress: (progress: FirmwareUpdateProgress) => void;
    },
  ): Promise<InstalledFirmware>;
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
