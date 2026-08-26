import { useCallback, useEffect, useRef, useState } from 'react';

import type { PairingPhase, Tracker } from '../model';
import {
  PinqevaProvisioningClient,
  ProvisioningApiError,
  type ProvisioningApiConfig,
} from './api';
import type { FirmwareUpdateProgress } from './firmwareUpdate';
import { createTagRadio, type StopTagScan, type TagRadio } from './radio';
import { safeTagSetupErrorCode, type TagSetupErrorCode } from './setup';

const SCAN_TIMEOUT_MS = 30_000;

export type FirmwareUpdateState = {
  phase: PairingPhase;
  progress: number;
  trackerId: string | null;
  error: TagSetupErrorCode | null;
};

const IDLE_STATE: FirmwareUpdateState = {
  phase: 'idle',
  progress: 0,
  trackerId: null,
  error: null,
};

function pairingPhase(progress: FirmwareUpdateProgress): PairingPhase {
  if (progress.phase === 'installing' || progress.phase === 'restarting') return 'installing';
  return 'connecting';
}

export function useFirmwareUpdate(input: {
  getAccessToken: () => Promise<string | null>;
  apiConfig: ProvisioningApiConfig | null;
  onInstalled: (deviceId: string, version: string) => Promise<void>;
}) {
  const [state, setState] = useState<FirmwareUpdateState>(IDLE_STATE);
  const radio = useRef<TagRadio | null>(null);
  const stopScan = useRef<StopTagScan | null>(null);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequence = useRef(0);
  const lastTracker = useRef<Tracker | null>(null);
  const latestInput = useRef(input);
  latestInput.current = input;

  const releaseRadio = useCallback(async () => {
    if (scanTimer.current) clearTimeout(scanTimer.current);
    scanTimer.current = null;
    const currentStop = stopScan.current;
    const currentRadio = radio.current;
    stopScan.current = null;
    radio.current = null;
    if (currentStop) await currentStop().catch(() => undefined);
    if (currentRadio) await currentRadio.destroy().catch(() => undefined);
  }, []);

  const start = useCallback(async (tracker: Tracker) => {
    lastTracker.current = tracker;
    const currentSequence = ++sequence.current;
    await releaseRadio();
    if (currentSequence !== sequence.current) return;

    const { apiConfig, getAccessToken } = latestInput.current;
    const token = await getAccessToken();
    if (currentSequence !== sequence.current) return;
    if (!token || !apiConfig || !tracker.serialNumber || tracker.source !== 'hosted') {
      setState({
        phase: 'error',
        progress: 0,
        trackerId: tracker.id,
        error: !token ? 'authentication' : !apiConfig ? 'configuration' : 'incompatible',
      });
      return;
    }
    const serialNumber = tracker.serialNumber;

    const backend = new PinqevaProvisioningClient(apiConfig, async () => {
      const nextToken = await latestInput.current.getAccessToken();
      if (!nextToken) throw new Error('Session unavailable');
      return nextToken;
    });
    const currentRadio = createTagRadio();
    radio.current = currentRadio;
    setState({
      phase: 'searching',
      progress: 0,
      trackerId: tracker.id,
      error: null,
    });

    let candidateSelected = false;
    const fail = (error: unknown) => {
      if (currentSequence !== sequence.current) return;
      setState({
        phase: 'error',
        progress: 0,
        trackerId: tracker.id,
        error: safeTagSetupErrorCode(error),
      });
      void releaseRadio();
    };
    const install = async (peripheralId: string) => {
      if (candidateSelected || currentSequence !== sequence.current) return;
      candidateSelected = true;
      if (scanTimer.current) clearTimeout(scanTimer.current);
      scanTimer.current = null;
      const currentStop = stopScan.current;
      stopScan.current = null;
      if (currentStop) await currentStop().catch(() => undefined);
      if (currentSequence !== sequence.current) return;
      try {
        const installed = await currentRadio.installFirmware(backend, {
          peripheralId,
          deviceId: tracker.id,
          serialNumber,
          onProgress: (progress) => {
            if (currentSequence !== sequence.current) return;
            setState({
              phase: pairingPhase(progress),
              progress: progress.percent,
              trackerId: tracker.id,
              error: null,
            });
          },
        });
        if (currentSequence !== sequence.current) return;
        await latestInput.current.onInstalled(installed.deviceId, installed.version);
        if (currentSequence !== sequence.current) return;
        await releaseRadio();
        setState({
          phase: 'success',
          progress: 100,
          trackerId: tracker.id,
          error: null,
        });
      } catch (error) {
        fail(error);
      }
    };

    try {
      const stop = await currentRadio.startScan(
        (candidate) => {
          if (
            currentSequence === sequence.current &&
            candidate.serialNumber === serialNumber
          ) {
            void install(candidate.peripheralId);
          }
        },
        fail,
      );
      if (currentSequence !== sequence.current) {
        await stop().catch(() => undefined);
        return;
      }
      if (candidateSelected) {
        // A native scanner may report a cached peripheral before startScan()
        // resolves. Ensure that early match cannot leave scanning active while
        // the updater is already connecting.
        await stop().catch(() => undefined);
        return;
      }
      stopScan.current = stop;
      scanTimer.current = setTimeout(
        () => fail(new ProvisioningApiError('REQUEST_TIMEOUT')),
        SCAN_TIMEOUT_MS,
      );
    } catch (error) {
      fail(error);
    }
  }, [releaseRadio]);

  const close = useCallback(() => {
    sequence.current += 1;
    setState(IDLE_STATE);
    void releaseRadio();
  }, [releaseRadio]);

  useEffect(() => () => {
    sequence.current += 1;
    void releaseRadio();
  }, [releaseRadio]);

  return {
    state,
    start: (tracker: Tracker) => void start(tracker),
    retry: () => {
      if (lastTracker.current) void start(lastTracker.current);
    },
    close,
  };
}
