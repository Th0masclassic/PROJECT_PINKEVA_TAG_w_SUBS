import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  PinqevaProvisioningClient,
  type DeviceClaim,
  type ProvisioningApiConfig,
} from './api';
import { createTagRadio, type DiscoveredTag, type StopTagScan, type TagRadio } from './radio';
import { safeTagSetupErrorCode, type TagSetupErrorCode } from './setup';

export type TagSetupPhase =
  | 'idle'
  | 'starting'
  | 'scanning'
  | 'connecting'
  | 'verifying'
  | 'authorizing'
  | 'installing'
  | 'associating'
  | 'success'
  | 'error';

export type TagSetupState = {
  phase: TagSetupPhase;
  candidates: DiscoveredTag[];
  selected: DiscoveredTag | null;
  claim: DeviceClaim | null;
  error: TagSetupErrorCode | null;
};

const IDLE_STATE: TagSetupState = {
  phase: 'idle',
  candidates: [],
  selected: null,
  claim: null,
  error: null,
};

export function useTagSetup(input: {
  accessToken: string | null;
  apiConfig: ProvisioningApiConfig | null;
  onClaimed: (claim: DeviceClaim) => Promise<void>;
}) {
  const [state, setState] = useState<TagSetupState>(IDLE_STATE);
  const radio = useRef<TagRadio | null>(null);
  const stopScan = useRef<StopTagScan | null>(null);
  const sequence = useRef(0);
  const idempotencyKeys = useRef(new Map<string, string>());
  const latestInput = useRef(input);
  latestInput.current = input;

  const releaseRadio = useCallback(async () => {
    const currentStop = stopScan.current;
    const currentRadio = radio.current;
    stopScan.current = null;
    radio.current = null;
    if (currentStop) await currentStop().catch(() => undefined);
    if (currentRadio) await currentRadio.destroy().catch(() => undefined);
  }, []);

  const beginScan = useCallback(async () => {
    const currentSequence = ++sequence.current;
    await releaseRadio();
    if (currentSequence !== sequence.current) return;

    const currentRadio = createTagRadio();
    radio.current = currentRadio;
    setState({ ...IDLE_STATE, phase: 'starting' });

    try {
      const stop = await currentRadio.startScan(
        (candidate) => {
          if (currentSequence !== sequence.current) return;
          setState((current) => {
            if (current.phase !== 'scanning' && current.phase !== 'starting') return current;
            const candidates = [
              candidate,
              ...current.candidates.filter(
                (item) => item.peripheralId !== candidate.peripheralId,
              ),
            ].sort((left, right) => (right.rssi ?? -999) - (left.rssi ?? -999));
            return { ...current, phase: 'scanning', candidates };
          });
        },
        (error) => {
          if (currentSequence !== sequence.current) return;
          setState((current) => ({
            ...current,
            phase: 'error',
            error: safeTagSetupErrorCode(error),
          }));
        },
      );
      if (currentSequence !== sequence.current) {
        await stop().catch(() => undefined);
        return;
      }
      stopScan.current = stop;
      setState((current) => ({ ...current, phase: 'scanning' }));
    } catch (error) {
      if (currentSequence !== sequence.current) return;
      setState({
        ...IDLE_STATE,
        phase: 'error',
        error: safeTagSetupErrorCode(error),
      });
    }
  }, [releaseRadio]);

  const close = useCallback(() => {
    sequence.current += 1;
    setState(IDLE_STATE);
    void releaseRadio();
  }, [releaseRadio]);

  const select = useCallback(async (candidate: DiscoveredTag) => {
    const currentSequence = sequence.current;
    const currentRadio = radio.current;
    if (!currentRadio) return;

    const currentStop = stopScan.current;
    stopScan.current = null;
    if (currentStop) await currentStop().catch(() => undefined);
    if (currentSequence !== sequence.current) return;

    const { accessToken, apiConfig, onClaimed } = latestInput.current;
    if (!accessToken) {
      setState((current) => ({
        ...current,
        phase: 'error',
        selected: candidate,
        error: 'authentication',
      }));
      return;
    }
    if (!apiConfig) {
      setState((current) => ({
        ...current,
        phase: 'error',
        selected: candidate,
        error: 'configuration',
      }));
      return;
    }

    const backend = new PinqevaProvisioningClient(apiConfig, async () => {
      const currentToken = latestInput.current.accessToken;
      if (!currentToken) throw new Error('Session unavailable');
      return currentToken;
    });
    const idempotencyKey =
      idempotencyKeys.current.get(candidate.serialNumber) ?? `provision:${randomUUID()}`;
    idempotencyKeys.current.set(candidate.serialNumber, idempotencyKey);
    setState((current) => ({
      ...current,
      phase: 'connecting',
      selected: candidate,
      claim: null,
      error: null,
    }));

    try {
      const claim = await currentRadio.provision(backend, {
        peripheralId: candidate.peripheralId,
        idempotencyKey,
        onProgress: (phase) => {
          if (currentSequence !== sequence.current) return;
          setState((current) => ({ ...current, phase }));
        },
      });
      if (currentSequence !== sequence.current) return;
      idempotencyKeys.current.delete(candidate.serialNumber);
      await onClaimed(claim).catch(() => undefined);
      if (currentSequence !== sequence.current) return;
      await releaseRadio();
      setState((current) => ({ ...current, phase: 'success', claim, error: null }));
    } catch (error) {
      if (currentSequence !== sequence.current) return;
      setState((current) => ({
        ...current,
        phase: 'error',
        error: safeTagSetupErrorCode(error),
      }));
    }
  }, [releaseRadio]);

  useEffect(() => {
    return () => {
      sequence.current += 1;
      void releaseRadio();
    };
  }, [releaseRadio]);

  return {
    state,
    open: () => void beginScan(),
    retry: () => void beginScan(),
    select: (candidate: DiscoveredTag) => void select(candidate),
    close,
  };
}
