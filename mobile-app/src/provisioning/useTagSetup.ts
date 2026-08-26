import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  PinqevaProvisioningClient,
  type DeviceClaim,
  type ProvisioningPlan,
  type ProvisioningRequest,
  type ProvisioningApiConfig,
} from './api';
import { createTagRadio, type DiscoveredTag, type StopTagScan, type TagRadio } from './radio';
import { safeTagSetupErrorCode, type TagSetupErrorCode } from './setup';

export type TagSetupPhase =
  | 'idle'
  | 'entitlement_ready'
  | 'starting'
  | 'scanning'
  | 'connecting'
  | 'verifying'
  | 'authorizing'
  | 'payment'
  | 'waiting_payment'
  | 'installing'
  | 'associating'
  | 'success'
  | 'error';

export type TagSetupOperation = 'claim' | 'entitlement';

export type TagSetupState = {
  phase: TagSetupPhase;
  operation: TagSetupOperation;
  candidates: DiscoveredTag[];
  selected: DiscoveredTag | null;
  claim: DeviceClaim | null;
  error: TagSetupErrorCode | null;
  provisioningRequest: ProvisioningRequest | null;
  targetDeviceId?: string;
  targetSerialNumber?: string;
};

const IDLE_STATE: TagSetupState = {
  phase: 'idle',
  operation: 'claim',
  candidates: [],
  selected: null,
  claim: null,
  error: null,
  provisioningRequest: null,
};

function logDevelopmentSetupFailure(context: string, error: unknown): void {
  if (!__DEV__) return;
  const source = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  console.warn('[Pinkeva BLE]', context, {
    name: error instanceof Error ? error.name : typeof error,
    code: typeof source.code === 'string' ? source.code : undefined,
    reason: typeof source.reason === 'string' ? source.reason : undefined,
    attErrorCode:
      typeof source.attErrorCode === 'number' ? source.attErrorCode : undefined,
    iosErrorCode:
      typeof source.iosErrorCode === 'number' ? source.iosErrorCode : undefined,
    message: error instanceof Error ? error.message : undefined,
  });
}

export function useTagSetup(input: {
  getAccessToken: () => Promise<string | null>;
  apiConfig: ProvisioningApiConfig | null;
  onClaimed: (claim: DeviceClaim) => Promise<void>;
  onEntitlementInstalled?: (deviceId: string) => Promise<void>;
  onProvisioningCheckout: (
    requestId: string,
    planCode: string,
  ) => Promise<{ kind: 'opened' | 'demo' | 'disabled' | 'error'; code?: string }>;
}) {
  const [state, setState] = useState<TagSetupState>(IDLE_STATE);
  const radio = useRef<TagRadio | null>(null);
  const stopScan = useRef<StopTagScan | null>(null);
  const sequence = useRef(0);
  const idempotencyKeys = useRef(new Map<string, string>());
  const request = useRef<{
    operation: TagSetupOperation;
    deviceId?: string;
    serialNumber?: string;
    provisioningRequestId?: string;
    provisioningRequest?: ProvisioningRequest;
  }>({ operation: 'claim' });
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

  const beginScan = useCallback(
    async (
      operation: TagSetupOperation = 'claim',
      target?: {
        deviceId: string;
        serialNumber: string;
        provisioningRequestId?: string;
        provisioningRequest?: ProvisioningRequest;
      },
    ) => {
      request.current = {
        operation,
        deviceId: target?.deviceId,
        serialNumber: target?.serialNumber,
        provisioningRequestId: target?.provisioningRequestId,
        provisioningRequest: target?.provisioningRequest,
      };
      const currentSequence = ++sequence.current;
      await releaseRadio();
      if (currentSequence !== sequence.current) return;

      // Do not open a BLE scan that can never complete. The claim flow needs both
      // a live Supabase session and the separately deployed provisioning API; a
      // missing API URL is a build/configuration problem, not a tag discovery
      // problem. Failing before scanning also avoids leaving a physical tag in
      // setup mode while the app cannot finish the ownership transaction.
      const { getAccessToken, apiConfig } = latestInput.current;
      // Always use a freshly validated Supabase token. Falling back to a cached
      // token here can repeat the same 401 after a signing-key/session change.
      const liveAccessToken = await getAccessToken();
      if (currentSequence !== sequence.current) return;
      if (!liveAccessToken || !apiConfig) {
        setState({
          ...IDLE_STATE,
          phase: 'error',
          error: !liveAccessToken ? 'authentication' : 'configuration',
        });
        return;
      }

      const currentRadio = createTagRadio();
      radio.current = currentRadio;
      setState({
        ...IDLE_STATE,
        phase: 'starting',
        operation,
        targetDeviceId: target?.deviceId,
        targetSerialNumber: target?.serialNumber,
        provisioningRequest: target?.provisioningRequest ?? null,
      });

      try {
        const stop = await currentRadio.startScan(
          (candidate) => {
            if (currentSequence !== sequence.current) return;
            if (target?.serialNumber && candidate.serialNumber !== target.serialNumber) return;
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
            logDevelopmentSetupFailure('scan callback', error);
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
        logDevelopmentSetupFailure('scan start', error);
        setState({
          ...IDLE_STATE,
          phase: 'error',
          error: safeTagSetupErrorCode(error),
        });
      }
    },
    [releaseRadio],
  );

  const prepareEntitlement = useCallback(
    async (deviceId: string, serialNumber: string) => {
      const currentSequence = ++sequence.current;
      request.current = {
        operation: 'entitlement',
        deviceId,
        serialNumber,
      };
      await releaseRadio();
      if (currentSequence !== sequence.current) return;
      setState({
        ...IDLE_STATE,
        phase: 'entitlement_ready',
        operation: 'entitlement',
        targetDeviceId: deviceId,
        targetSerialNumber: serialNumber,
      });
    },
    [releaseRadio],
  );

  const close = useCallback(() => {
    sequence.current += 1;
    request.current = { operation: 'claim' };
    setState(IDLE_STATE);
    void releaseRadio();
  }, [releaseRadio]);

  const waitForPaidRequest = useCallback(
    async (
      backend: PinqevaProvisioningClient,
      requestId: string,
      serialNumber: string,
    ) => {
      const currentSequence = sequence.current;
      const deadline = Date.now() + 30 * 60 * 1000;
      while (currentSequence === sequence.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        if (currentSequence !== sequence.current) return;
        try {
          const paymentRequest = await backend.getProvisioningRequest(requestId);
          if (currentSequence !== sequence.current) return;
          setState((current) => ({ ...current, provisioningRequest: paymentRequest }));
          if (paymentRequest.status === 'paid' || paymentRequest.status === 'claiming') {
            await beginScan('claim', {
              deviceId: paymentRequest.device_id,
              serialNumber: paymentRequest.serial_number || serialNumber,
              provisioningRequestId: paymentRequest.request_id,
              provisioningRequest: paymentRequest,
            });
            return;
          }
          if (
            paymentRequest.status === 'expired' ||
            paymentRequest.status === 'failed'
          ) {
            setState((current) => ({
              ...current,
              phase: 'error',
              error: 'timeout',
              provisioningRequest: paymentRequest,
            }));
            return;
          }
        } catch (error) {
          if (currentSequence !== sequence.current) return;
          logDevelopmentSetupFailure('payment status', error);
        }
      }
      if (currentSequence === sequence.current) {
        setState((current) => ({ ...current, phase: 'error', error: 'timeout' }));
      }
    },
    [beginScan],
  );

  const chooseProvisioningPlan = useCallback(
    async (plan: ProvisioningPlan) => {
      const requestId = request.current.provisioningRequestId;
      if (!requestId) return;
      const { onProvisioningCheckout } = latestInput.current;
      setState((current) => ({ ...current, phase: 'waiting_payment', error: null }));
      try {
        const result = await onProvisioningCheckout(requestId, plan.code);
        if (result.kind !== 'opened') {
          setState((current) => ({ ...current, phase: 'payment', error: 'unavailable' }));
          return;
        }
        const { apiConfig } = latestInput.current;
        if (!apiConfig) {
          setState((current) => ({ ...current, phase: 'error', error: 'configuration' }));
          return;
        }
        const backend = new PinqevaProvisioningClient(apiConfig, async () => {
          const currentInput = latestInput.current;
          const token = await currentInput.getAccessToken();
          if (!token) throw new Error('Session unavailable');
          return token;
        });
        void waitForPaidRequest(
          backend,
          requestId,
          request.current.serialNumber ?? '',
        );
      } catch (error) {
        logDevelopmentSetupFailure('provisioning checkout', error);
        setState((current) => ({ ...current, phase: 'payment', error: 'unavailable' }));
      }
    },
    [waitForPaidRequest],
  );

  const select = useCallback(async (candidate: DiscoveredTag) => {
    const currentSequence = sequence.current;
    const currentRadio = radio.current;
    if (!currentRadio) return;

    const currentStop = stopScan.current;
    stopScan.current = null;
    if (currentStop) await currentStop().catch(() => undefined);
    if (currentSequence !== sequence.current) return;

    const {
      getAccessToken,
      apiConfig,
      onClaimed,
      onEntitlementInstalled,
    } = latestInput.current;
    const currentRequest = request.current;
    const liveAccessToken = await getAccessToken();
    if (currentSequence !== sequence.current) return;
    if (!liveAccessToken) {
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
      const currentInput = latestInput.current;
      const currentToken = await currentInput.getAccessToken();
      if (!currentToken) throw new Error('Session unavailable');
      return currentToken;
    });
    const idempotencyKey =
      idempotencyKeys.current.get(candidate.serialNumber) ?? `provision:${randomUUID()}`;
    if (currentRequest.operation === 'claim') {
      idempotencyKeys.current.set(candidate.serialNumber, idempotencyKey);
    }
    setState((current) => ({
      ...current,
      phase: 'connecting',
      selected: candidate,
      claim: null,
      error: null,
    }));

    try {
      if (currentRequest.operation === 'claim') {
        if (!currentRequest.provisioningRequestId) {
          const identity = await currentRadio.inspectTag(backend, {
            peripheralId: candidate.peripheralId,
            onProgress: (phase) => {
              if (currentSequence !== sequence.current) return;
              setState((current) => ({ ...current, phase }));
            },
          });
          if (identity.serialNumber !== candidate.serialNumber) {
            throw new Error('Tag identity changed during inspection');
          }
          const provisioningRequest = await backend.startProvisioningRequest({
            serialNumber: identity.serialNumber,
            idempotencyKey: `request:${idempotencyKey}`,
            tagChallengeBase64url: identity.tagChallengeBase64url,
            tagAdvertisementKeySha256Base64url:
              identity.tagAdvertisementKeySha256Base64url,
          });
          if (currentSequence !== sequence.current) return;
          if (
            !provisioningRequest.device_id ||
            provisioningRequest.serial_number !== identity.serialNumber ||
            provisioningRequest.available_plans.length === 0
          ) {
            throw new Error('Invalid provisioning request binding');
          }
          request.current = {
            ...request.current,
            provisioningRequestId: provisioningRequest.request_id,
            provisioningRequest,
            serialNumber: provisioningRequest.serial_number,
            deviceId: provisioningRequest.device_id,
          };
          await releaseRadio();
          setState((current) => ({
            ...current,
            phase: 'payment',
            selected: candidate,
            provisioningRequest,
            claim: null,
            error: null,
          }));
          return;
        }
        const claim = await currentRadio.provision(backend, {
          peripheralId: candidate.peripheralId,
          idempotencyKey,
          provisioningRequestId: currentRequest.provisioningRequestId,
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
        return;
      }

      if (!currentRequest.deviceId || !currentRequest.serialNumber) {
        throw new Error('Missing entitlement target');
      }
      await currentRadio.installEntitlement(backend, {
        peripheralId: candidate.peripheralId,
        deviceId: currentRequest.deviceId,
        serialNumber: currentRequest.serialNumber,
        onProgress: (phase) => {
          if (currentSequence !== sequence.current) return;
          setState((current) => ({ ...current, phase }));
        },
      });
      if (currentSequence !== sequence.current) return;
      if (onEntitlementInstalled) {
        await onEntitlementInstalled(currentRequest.deviceId).catch(() => undefined);
      }
      if (currentSequence !== sequence.current) return;
      await releaseRadio();
      setState((current) => ({ ...current, phase: 'success', claim: null, error: null }));
    } catch (error) {
      if (currentSequence !== sequence.current) return;
      logDevelopmentSetupFailure('provision', error);
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
    retry: () => {
      const currentRequest = request.current;
      if (
        currentRequest.operation === 'entitlement' &&
        currentRequest.deviceId &&
        currentRequest.serialNumber
      ) {
        // The maintenance advertising window is deliberately physical and
        // bounded. Ask the owner to enable it again rather than rescanning a
        // tag that may no longer be accepting entitlement delivery.
        void prepareEntitlement(
          currentRequest.deviceId,
          currentRequest.serialNumber,
        );
      } else if (
        currentRequest.provisioningRequestId &&
        currentRequest.provisioningRequest &&
        currentRequest.deviceId &&
        currentRequest.serialNumber
      ) {
        void beginScan('claim', {
          deviceId: currentRequest.deviceId,
          serialNumber: currentRequest.serialNumber,
          provisioningRequestId: currentRequest.provisioningRequestId,
          provisioningRequest: currentRequest.provisioningRequest,
        });
      } else {
        void beginScan('claim');
      }
    },
    select: (candidate: DiscoveredTag) => void select(candidate),
    chooseProvisioningPlan,
    beginEntitlementScan: () => {
      const currentRequest = request.current;
      if (
        currentRequest.operation !== 'entitlement' ||
        !currentRequest.deviceId ||
        !currentRequest.serialNumber
      ) {
        return;
      }
      void beginScan('entitlement', {
        deviceId: currentRequest.deviceId,
        serialNumber: currentRequest.serialNumber,
      });
    },
    close,
    openForEntitlement: (deviceId: string, serialNumber: string) =>
      void prepareEntitlement(deviceId, serialNumber),
  };
}
