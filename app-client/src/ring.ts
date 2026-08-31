import type { BleManager, Device, Subscription } from 'react-native-ble-plx';

import type { PinqevaBackendClient as PinqevaProvisioningClient } from './backend.js';
import {
  DEVICE_IDENTIFIER_UUID, OWNER_RING_CAPABILITY, PINKEVA_SERVICE_UUID,
  PROTOCOL_INFO_UUID, ProvisioningClientError, RING_AUTHORIZATION_PROOF_LENGTH,
  RING_AUTHORIZATION_UUID, RING_CONTROL_UUID, RING_PAUSE, RING_PLAY,
  RING_STATUS_UUID, TAG_CHALLENGE_LENGTH, TAG_CHALLENGE_UUID,
  decodeBase64Url, decodeBleBase64, decodeDeviceIdentifier, encodeBase64Url,
  normalizeAdvertisedSerial, parseProtocolInformation, parseRingStatus, toBleBase64,
  type RingStatus,
} from './protocol.js';

export type RingProgress = 'searching' | 'connecting' | 'authorizing';
export type RingConnectionInput = {
  deviceId: string;
  serialNumber: string;
  signal: AbortSignal;
  onProgress?: (progress: RingProgress) => void;
  onStatus: (status: RingStatus) => void;
  onError: (error: unknown) => void;
  scanTimeoutMs?: number;
};

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new ProvisioningClientError('RING_CANCELLED', 'Ring cancelled');
}

/** A short-lived session. Playback timing is always authoritative on the tag. */
export class TagRingSession {
  private readonly ble: BleManager;
  private readonly device: Device;
  private readonly input: RingConnectionInput;
  private status: RingStatus = { playing: false, source: 'none' };
  private statusSubscription?: Subscription;
  private disconnectSubscription?: Subscription;
  private watchdog?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private closing?: Promise<void>;
  private commands: Promise<unknown> = Promise.resolve();
  private playPending?: Promise<RingStatus>;
  private executing = false;
  private observedPlayback = false;
  private readonly abort = () => { void this.dispose(); };

  constructor(
    ble: BleManager,
    device: Device,
    input: RingConnectionInput,
  ) {
    this.ble = ble;
    this.device = device;
    this.input = input;
  }

  async initialize(): Promise<void> {
    requireActive(this.input.signal);
    this.input.signal.addEventListener('abort', this.abort, { once: true });
    this.statusSubscription = this.device.monitorCharacteristicForService(
      PINKEVA_SERVICE_UUID, RING_STATUS_UUID, (error, characteristic) => {
        if (this.disposed) return;
        if (error) { this.fail(error); return; }
        if (!characteristic) return;
        try { this.receiveStatus(parseRingStatus(decodeBleBase64(characteristic.value))); }
        catch (error) { this.fail(error); }
      },
    );
    if (this.disposed) { this.statusSubscription.remove(); throw new ProvisioningClientError('RING_DISCONNECTED', 'Ring session ended'); }
    this.disconnectSubscription = this.ble.onDeviceDisconnected(this.device.id, (error) => {
      if (!this.disposed) this.fail(error ?? new ProvisioningClientError('RING_DISCONNECTED', 'Tag disconnected'));
    });
    await this.readStatus();
  }

  play(): Promise<RingStatus> {
    if (this.disposed || this.input.signal.aborted) {
      return Promise.reject(new ProvisioningClientError('RING_DISCONNECTED', 'Ring session ended'));
    }
    // Do not queue repeat presses or restart any timer while a play is in flight.
    if (this.playPending) return this.playPending;
    if (this.status.playing) return Promise.resolve(this.status);
    const command = this.command(RING_PLAY);
    this.playPending = command;
    void command.finally(() => { if (this.playPending === command) this.playPending = undefined; }).catch(() => undefined);
    return command;
  }

  pause(): Promise<RingStatus> {
    // Serialize behind an in-flight Play so Pause cannot be overtaken by it.
    return this.command(RING_PAUSE);
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.input.signal.removeEventListener('abort', this.abort);
    this.statusSubscription?.remove();
    this.disconnectSubscription?.remove();
    this.closing = this.ble.cancelDeviceConnection(this.device.id).then(() => undefined, () => undefined);
    return this.closing;
  }

  private command(value: number): Promise<RingStatus> {
    const next = this.commands.then(async () => {
      requireActive(this.input.signal);
      if (this.disposed) throw new ProvisioningClientError('RING_DISCONNECTED', 'Ring session ended');
      this.executing = true;
      try {
        await this.device.writeCharacteristicWithResponseForService(
          PINKEVA_SERVICE_UUID, RING_CONTROL_UUID, toBleBase64(Uint8Array.of(value)),
        );
        return await this.readStatus();
      } catch (error) {
        this.fail(error);
        throw error;
      } finally {
        this.executing = false;
        if (this.observedPlayback && !this.status.playing) void this.dispose();
      }
    });
    this.commands = next.catch(() => undefined);
    return next;
  }

  private async readStatus(): Promise<RingStatus> {
    const value = await this.device.readCharacteristicForService(PINKEVA_SERVICE_UUID, RING_STATUS_UUID);
    requireActive(this.input.signal);
    if (this.disposed) throw new ProvisioningClientError('RING_DISCONNECTED', 'Ring session ended');
    const status = parseRingStatus(decodeBleBase64(value.value));
    this.receiveStatus(status);
    return status;
  }

  private receiveStatus(status: RingStatus): void {
    const completed = this.status.playing && !status.playing;
    this.status = status;
    this.observedPlayback ||= status.playing;
    if (status.playing && !this.watchdog) {
      // Only a safety disconnect if notifications fail, never a simulated completion.
      this.watchdog = setTimeout(() => this.fail(new ProvisioningClientError(
        'RING_STATUS_TIMEOUT', 'Tag did not confirm sound completion',
      )), 15_000);
    }
    this.input.onStatus(status);
    if (completed && !this.executing) void this.dispose();
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    this.input.onError(error);
    void this.dispose();
  }
}

export class TagRinger {
  private readonly ble: BleManager;
  private readonly backend: PinqevaProvisioningClient;

  constructor(ble: BleManager, backend: PinqevaProvisioningClient) {
    this.ble = ble;
    this.backend = backend;
  }

  async connectNearby(input: RingConnectionInput): Promise<TagRingSession> {
    requireActive(input.signal);
    const expectedSerial = normalizeAdvertisedSerial(input.serialNumber);
    if (!expectedSerial) throw new ProvisioningClientError('INVALID_DEVICE_ID', 'Invalid tracker');
    const deadline = Date.now() + (input.scanTimeoutMs ?? 30_000);
    const seen = new Set<string>();
    while (Date.now() < deadline) {
      requireActive(input.signal);
      input.onProgress?.('searching');
      const candidate = await this.nextCandidate(input, seen, deadline, expectedSerial);
      seen.add(candidate.id);
      let device: Device | undefined;
      let session: TagRingSession | undefined;
      let matched = false;
      let transferred = false;
      const disconnectOnAbort = () => {
        void this.ble.cancelDeviceConnection(candidate.id).catch(() => undefined);
      };
      input.signal.addEventListener('abort', disconnectOnAbort, { once: true });
      try {
        input.onProgress?.('connecting');
        device = await this.ble.connectToDevice(candidate.id, {
          autoConnect: false, timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
        });
        requireActive(input.signal);
        device = await device.discoverAllServicesAndCharacteristics();
        requireActive(input.signal);
        const identifier = await device.readCharacteristicForService(PINKEVA_SERVICE_UUID, DEVICE_IDENTIFIER_UUID);
        if (decodeDeviceIdentifier(decodeBleBase64(identifier.value)) !== expectedSerial) continue;
        matched = true;
        const protocolValue = await device.readCharacteristicForService(PINKEVA_SERVICE_UUID, PROTOCOL_INFO_UUID);
        const protocol = parseProtocolInformation(decodeBleBase64(protocolValue.value));
        if (protocol.protocolMajor !== 1 || !(protocol.capabilities & OWNER_RING_CAPABILITY)) {
          throw new ProvisioningClientError('RING_UNSUPPORTED', 'Update tracker firmware to use sound');
        }
        device = await device.requestMTU(64).catch(() => device as Device);
        requireActive(input.signal);
        const challengeValue = await device.readCharacteristicForService(PINKEVA_SERVICE_UUID, TAG_CHALLENGE_UUID);
        const challenge = decodeBleBase64(challengeValue.value);
        try {
          if (challenge.length !== TAG_CHALLENGE_LENGTH) {
            throw new ProvisioningClientError('INVALID_TAG_CHALLENGE', 'Invalid tag challenge');
          }
          input.onProgress?.('authorizing');
          requireActive(input.signal);
          const authorization = await this.backend.authorizeRing({
            deviceId: input.deviceId, serialNumber: expectedSerial,
            tagChallengeBase64url: encodeBase64Url(challenge),
          });
          requireActive(input.signal);
          if (authorization.device_id !== input.deviceId || authorization.serial_number !== expectedSerial) {
            throw new ProvisioningClientError('BACKEND_BINDING_MISMATCH', 'Ring authorization mismatch');
          }
          const proof = decodeBase64Url(authorization.ring_authorization_proof_base64url);
          authorization.ring_authorization_proof_base64url = '';
          try {
            if (proof.length !== RING_AUTHORIZATION_PROOF_LENGTH) {
              throw new ProvisioningClientError('INVALID_BACKEND_AUTHORIZATION', 'Invalid ring authorization');
            }
            await device.writeCharacteristicWithResponseForService(PINKEVA_SERVICE_UUID, RING_AUTHORIZATION_UUID, toBleBase64(proof));
          } finally { proof.fill(0); }
        } finally { challenge.fill(0); }
        requireActive(input.signal);
        session = new TagRingSession(this.ble, device, input);
        await session.initialize();
        requireActive(input.signal);
        transferred = true;
        return session;
      } catch (error) {
        requireActive(input.signal);
        if (matched) throw error;
        // Unrelated or unreachable candidates never receive owner authorization.
      } finally {
        input.signal.removeEventListener('abort', disconnectOnAbort);
        if (!transferred) {
          if (session) await session.dispose();
          else if (device) await this.ble.cancelDeviceConnection(device.id).catch(() => undefined);
        }
      }
    }
    throw new ProvisioningClientError('RING_NOT_FOUND', 'Tracker not found nearby');
  }

  private async nextCandidate(input: RingConnectionInput, seen: Set<string>, deadline: number, serial: string): Promise<Device> {
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
        const abort = () => finish(new ProvisioningClientError('RING_CANCELLED', 'Ring cancelled'));
        const timeout = setTimeout(() => finish(new ProvisioningClientError('RING_NOT_FOUND', 'Tracker not found nearby')), Math.max(1, deadline - Date.now()));
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) { abort(); return; }
        try {
          void Promise.resolve(this.ble.startDeviceScan([PINKEVA_SERVICE_UUID], { allowDuplicates: false }, (error, device) => {
            if (error) { finish(error); return; }
            if (!device || seen.has(device.id)) return;
            const advertisedSerial = normalizeAdvertisedSerial(device.localName) ?? normalizeAdvertisedSerial(device.name);
            if (advertisedSerial && advertisedSerial !== serial) return;
            finish(undefined, device);
          })).catch((error) => finish(error));
        } catch (error) { finish(error); }
      });
    } finally { await Promise.resolve(this.ble.stopDeviceScan()).catch(() => undefined); }
  }
}
