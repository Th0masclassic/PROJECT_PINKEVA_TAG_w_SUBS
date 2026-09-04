import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Tracker } from '../model';
import {
  PinqevaProvisioningClient,
  ProvisioningApiError,
  type DeviceRelease,
  type ProvisioningApiConfig,
} from './api';
import { createTagRadio, type TagRadio } from './radio';
import type { NearbyReleaseProgress } from './release';
import { safeReleaseErrorCode, type ReleaseErrorCode } from './releaseErrors';
import {
  clearPendingDeviceRelease,
  loadPendingDeviceRelease,
  savePendingDeviceRelease,
} from './pendingRelease';

type ReleasePhase = 'idle' | NearbyReleaseProgress | 'error';
type Operation = {
  trackerId: string;
  controller: AbortController;
  radio: TagRadio;
};

export function useTrackerRelease(input: {
  getAccessToken: () => Promise<string | null>;
  apiConfig: ProvisioningApiConfig | null;
}) {
  const [state, setState] = useState<{
    phase: ReleasePhase;
    error: ReleaseErrorCode | null;
  }>({ phase: 'idle', error: null });
  const operation = useRef<Operation | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());
  const latest = useRef(input);
  latest.current = input;

  const closeOperation = useCallback(async (target = operation.current) => {
    if (!target) return;
    if (operation.current === target) operation.current = null;
    target.controller.abort();
    await target.radio.destroy().catch(() => undefined);
  }, []);

  useEffect(() => () => { void closeOperation(); }, [closeOperation]);

  const start = useCallback(async (tracker: Tracker): Promise<DeviceRelease | null> => {
    if (operation.current || tracker.source !== 'hosted' || !tracker.serialNumber) return null;
    if (!latest.current.apiConfig) {
      setState({ phase: 'error', error: 'configuration' });
      return null;
    }
    const current: Operation = {
      trackerId: tracker.id,
      controller: new AbortController(),
      radio: createTagRadio(),
    };
    operation.current = current;
    const isCurrent = () => operation.current === current && !current.controller.signal.aborted;
    setState({ phase: 'searching', error: null });
    try {
      const token = await latest.current.getAccessToken();
      if (!isCurrent()) return null;
      if (!token) throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);
      const backend = new PinqevaProvisioningClient(latest.current.apiConfig, async () => {
        const freshToken = await latest.current.getAccessToken();
        if (!freshToken) throw new ProvisioningApiError('AUTH_TOKEN_UNAVAILABLE', 401);
        return freshToken;
      });
      const pending = await loadPendingDeviceRelease(tracker.id);
      if (!isCurrent()) return null;
      if (pending && pending.serial_number !== tracker.serialNumber.trim().toUpperCase()) {
        throw new ProvisioningApiError('PENDING_RELEASE_BINDING_MISMATCH', 403);
      }
      if (pending) {
        setState({ phase: 'finalizing', error: null });
        const completed = await backend.completeDeviceRelease({
          release: {
            ...pending,
            tag_authorization_proof_base64url: '',
            reset_command_base64url: '',
          },
        });
        if (!isCurrent()) return null;
        if (
          completed.device_id !== tracker.id ||
          completed.serial_number !== tracker.serialNumber.trim().toUpperCase()
        ) {
          throw new ProvisioningApiError('BACKEND_BINDING_MISMATCH', 502);
        }
        await clearPendingDeviceRelease(tracker.id).catch(() => undefined);
        idempotencyKeys.current.delete(tracker.id);
        await closeOperation(current);
        setState({ phase: 'idle', error: null });
        return completed;
      }
      const idempotencyKey = idempotencyKeys.current.get(tracker.id) ??
        `release:${randomUUID()}`;
      idempotencyKeys.current.set(tracker.id, idempotencyKey);
      const released = await current.radio.releaseTracker(backend, {
        deviceId: tracker.id,
        serialNumber: tracker.serialNumber,
        idempotencyKey,
        signal: current.controller.signal,
        onProgress: (phase) => {
          if (isCurrent()) setState({ phase, error: null });
        },
        onResetVerified: savePendingDeviceRelease,
        onCompleted: () => clearPendingDeviceRelease(tracker.id),
      });
      if (!isCurrent()) return null;
      idempotencyKeys.current.delete(tracker.id);
      await closeOperation(current);
      setState({ phase: 'idle', error: null });
      return released;
    } catch (error) {
      if (!isCurrent()) return null;
      await closeOperation(current);
      setState({ phase: 'error', error: safeReleaseErrorCode(error) });
      return null;
    }
  }, [closeOperation]);

  const cancel = useCallback(async () => {
    await closeOperation();
    setState({ phase: 'idle', error: null });
  }, [closeOperation]);

  const reset = useCallback(() => {
    if (!operation.current) setState({ phase: 'idle', error: null });
  }, []);

  return {
    ...state,
    busy: state.phase !== 'idle' && state.phase !== 'error',
    start,
    cancel,
    reset,
  };
}
