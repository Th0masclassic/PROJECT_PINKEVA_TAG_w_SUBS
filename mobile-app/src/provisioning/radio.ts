import type { TagRadio } from './radio.types';
import { TagRadioError } from './radio.types';

class UnsupportedTagRadio implements TagRadio {
  async connectRing(): Promise<never> {
    throw new TagRadioError('BLUETOOTH_UNSUPPORTED');
  }
  async startScan(): Promise<never> {
    throw new TagRadioError('BLUETOOTH_UNSUPPORTED');
  }

  async inspectTag(): Promise<never> {
    throw new TagRadioError('BLUETOOTH_UNSUPPORTED');
  }

  async provision(): Promise<never> {
    throw new TagRadioError('BLUETOOTH_UNSUPPORTED');
  }

  async installFirmware(): Promise<never> {
    throw new TagRadioError('BLUETOOTH_UNSUPPORTED');
  }

  async destroy(): Promise<void> {}
}

export function createTagRadio(): TagRadio {
  return new UnsupportedTagRadio();
}

export type { DiscoveredTag, StopTagScan, TagRadio } from './radio.types';
