import { useCallback, useEffect, useRef, useState } from 'react';

import type { Tracker } from '../model';
import { PinqevaProvisioningClient, ProvisioningApiError, type ProvisioningApiConfig } from './api';
import { createTagRadio, type TagRadio } from './radio';
import type { RingProgress, TagRingSession } from './ring';
import { safeRingErrorCode, type RingErrorCode } from './ringErrors';

type RingPhase = 'idle' | RingProgress | 'playing' | 'pausing' | 'error';
type Operation = {
  controller: AbortController;
  radio: TagRadio;
  session?: TagRingSession;
  heardPlaying: boolean;
  finished: boolean;
};

export function useTrackerRing(input: {
  tracker: Tracker;
  ownerId: string | null;
  getAccessToken: () => Promise<string | null>;
  apiConfig: ProvisioningApiConfig | null;
}) {
  const [state, setState] = useState<{ phase: RingPhase; error: RingErrorCode | null }>({ phase: 'idle', error: null });
  const operation = useRef<Operation | null>(null);
  const latest = useRef(input);
  latest.current = input;

  const release = useCallback(async (target = operation.current) => {
    if (!target) return;
    if (operation.current === target) operation.current = null;
    target.controller.abort();
    await target.session?.dispose();
    await target.radio.destroy().catch(() => undefined);
  }, []);

  useEffect(() => {
    setState({ phase: 'idle', error: null });
    return () => { void release(); };
  }, [input.ownerId, input.tracker.id, input.tracker.source, release]);

  const play = useCallback(async () => {
    if (operation.current && !operation.current.finished) return;
    const { tracker, ownerId, apiConfig } = latest.current;
    // Preview cards never simulate a successful physical ring.
    if (tracker.source !== 'hosted' || !tracker.serialNumber || !ownerId) return;
    if (!apiConfig) { setState({ phase: 'error', error: 'configuration' }); return; }
    const previous = operation.current;
    const current: Operation = {
      controller: new AbortController(), radio: createTagRadio(), heardPlaying: false, finished: false,
    };
    operation.current = current;
    if (previous) await release(previous);
    const isCurrent = () => operation.current === current && !current.controller.signal.aborted;
    const fail = (error: unknown) => {
      if (!isCurrent()) return;
      current.finished = true;
      setState({ phase: 'error', error: safeRingErrorCode(error) });
      void release(current);
    };
    setState({ phase: 'searching', error: null });
    try {
      const token = await latest.current.getAccessToken();
      if (!isCurrent()) return;
      if (!token) throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);
      const backend = new PinqevaProvisioningClient(apiConfig, async () => {
        if (!isCurrent()) throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);
        const freshToken = await latest.current.getAccessToken();
        if (!freshToken) throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);
        return freshToken;
      });
      current.session = await current.radio.connectRing(backend, {
        deviceId: tracker.id, serialNumber: tracker.serialNumber, signal: current.controller.signal,
        onProgress: (phase) => { if (isCurrent()) setState({ phase, error: null }); },
        onStatus: (status) => {
          if (!isCurrent()) return;
          if (status.playing) {
            current.heardPlaying = true;
            setState({ phase: 'playing', error: null });
          } else if (current.heardPlaying) {
            current.finished = true;
            setState({ phase: 'idle', error: null });
          }
        },
        onError: fail,
      });
      if (!isCurrent()) { await current.session.dispose(); return; }
      await current.session.play();
    } catch (error) { fail(error); }
  }, [release]);

  const pause = useCallback(async () => {
    const current = operation.current;
    if (!current || current.finished) return;
    if (!current.session) {
      setState({ phase: 'idle', error: null });
      await release(current);
      return;
    }
    setState({ phase: 'pausing', error: null });
    try {
      const status = await current.session.pause();
      if (operation.current !== current) return;
      if (status.playing) throw new Error('Pause not acknowledged');
      setState({ phase: 'idle', error: null });
      await release(current);
    } catch (error) {
      if (operation.current !== current || current.controller.signal.aborted) return;
      setState({ phase: 'error', error: safeRingErrorCode(error) });
      await release(current);
    }
  }, [release]);

  return { ...state, play, pause, available: input.tracker.source === 'hosted' && Boolean(input.ownerId && input.tracker.serialNumber) };
}
