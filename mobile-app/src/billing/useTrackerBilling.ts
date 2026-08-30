import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  createAccountCheckout,
  createAccountPortal,
  createProvisioningCheckout,
  getAccountSubscription,
  safeBillingErrorCode,
} from './api';
import { BILLING_API_CONFIG } from './config';
import { createDemoSubscription } from './demo';
import { resolveBillingMode } from './types';
import type {
  BillingActionResult,
  BillingErrorCode,
  BillingMode,
  BillingPortalAction,
  AccountSubscription,
  DeviceSubscription,
} from './types';

type BillingState = {
  subscriptions: Record<string, DeviceSubscription>;
  loadingIds: ReadonlySet<string>;
  errors: Record<string, BillingErrorCode | undefined>;
  mode: BillingMode;
  purchasesEnabled: boolean;
  refreshDevice: (deviceId: string) => Promise<void>;
  startCheckout: (deviceId: string, planCode: string) => Promise<BillingActionResult>;
  startProvisioningCheckout: (
    requestId: string,
    planCode: string,
  ) => Promise<BillingActionResult>;
  openPortal: (deviceId: string, action?: BillingPortalAction) => Promise<BillingActionResult>;
};

const POST_BILLING_REFRESH_DELAYS_MS = [0, 1_000, 2_500, 5_000] as const;

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function subscriptionsForDevices(
  subscription: AccountSubscription,
  deviceIds: readonly string[],
): Record<string, DeviceSubscription> {
  return Object.fromEntries(
    deviceIds.map((deviceId) => [deviceId, { ...subscription, deviceId }]),
  );
}

function errorsForDevices(
  code: BillingErrorCode | undefined,
  deviceIds: readonly string[],
): Record<string, BillingErrorCode | undefined> {
  return Object.fromEntries(deviceIds.map((deviceId) => [deviceId, code]));
}

export function useTrackerBilling(
  deviceIdsInput: readonly string[],
  accessToken: string | null,
  demoPreviewEnabled = false,
): BillingState {
  const deviceIdsKey = deviceIdsInput.join('\u001f');
  const deviceIds = useMemo(
    () => (deviceIdsKey ? deviceIdsKey.split('\u001f') : []),
    [deviceIdsKey],
  );
  const mode: BillingMode = resolveBillingMode(
    Boolean(BILLING_API_CONFIG),
    Boolean(accessToken),
    demoPreviewEnabled,
  );
  const contextIdentity = `${mode}\u001f${accessToken ?? ''}\u001f${deviceIdsKey}`;
  const currentContext = useRef(contextIdentity);
  currentContext.current = contextIdentity;
  const [subscriptions, setSubscriptions] = useState<Record<string, DeviceSubscription>>({});
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, BillingErrorCode | undefined>>({});
  const generation = useRef(0);

  const refreshDevice = useCallback(
    async (deviceId: string) => {
      const requestContext = contextIdentity;
      if (mode === 'demo') {
        setSubscriptions((current) => ({
          ...current,
          [deviceId]: createDemoSubscription(deviceId),
        }));
        setErrors((current) => ({ ...current, [deviceId]: undefined }));
        return;
      }

      if (mode === 'unavailable' || !BILLING_API_CONFIG || !accessToken) {
        setSubscriptions({});
        setErrors(
          errorsForDevices(
            accessToken ? 'configuration' : 'authentication',
            deviceIds,
          ),
        );
        return;
      }

      setLoadingIds(new Set(deviceIds));
      try {
        const subscription = await getAccountSubscription(BILLING_API_CONFIG, accessToken);
        if (currentContext.current !== requestContext) return;
        setSubscriptions(subscriptionsForDevices(subscription, deviceIds));
        setErrors(errorsForDevices(undefined, deviceIds));
      } catch (error) {
        if (currentContext.current !== requestContext) return;
        setSubscriptions({});
        setErrors(errorsForDevices(safeBillingErrorCode(error), deviceIds));
      } finally {
        if (currentContext.current === requestContext) {
          setLoadingIds(new Set());
        }
      }
    },
    [accessToken, contextIdentity, deviceIds, mode],
  );

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const effectContext = contextIdentity;
    if (mode === 'demo') {
      setSubscriptions(
        Object.fromEntries(deviceIds.map((id) => [id, createDemoSubscription(id)])),
      );
      setLoadingIds(new Set());
      setErrors({});
      return;
    }

    if (mode === 'unavailable') {
      setSubscriptions({});
      setLoadingIds(new Set());
      setErrors(
        Object.fromEntries(
          deviceIds.map((id) => [id, accessToken ? 'configuration' : 'authentication']),
        ),
      );
      return;
    }

    // Never retain a demo or previous-account status while live data is being
    // loaded. A failed fetch must render as unavailable, not as a fake Active
    // subscription inherited from the preview state.
    setSubscriptions({});
    setErrors({});
    setLoadingIds(new Set(deviceIds));
    void (async () => {
      if (!BILLING_API_CONFIG || !accessToken) return;
      try {
        const subscription = await getAccountSubscription(BILLING_API_CONFIG, accessToken);
        if (
          generation.current !== currentGeneration ||
          currentContext.current !== effectContext
        ) return;
        setSubscriptions(subscriptionsForDevices(subscription, deviceIds));
        setErrors(errorsForDevices(undefined, deviceIds));
      } catch (error) {
        if (
          generation.current !== currentGeneration ||
          currentContext.current !== effectContext
        ) return;
        setSubscriptions({});
        setErrors(errorsForDevices(safeBillingErrorCode(error), deviceIds));
      } finally {
        if (
          generation.current === currentGeneration &&
          currentContext.current === effectContext
        ) {
          setLoadingIds(new Set());
        }
      }
    })();
  }, [accessToken, contextIdentity, deviceIds, mode]);

  const refreshAfterBillingReturn = useCallback(
    async (deviceId: string) => {
      const requestContext = contextIdentity;
      for (const delayMs of POST_BILLING_REFRESH_DELAYS_MS) {
        if (delayMs) await waitFor(delayMs);
        if (currentContext.current !== requestContext) return;
        await refreshDevice(deviceId);
      }
    },
    [contextIdentity, refreshDevice],
  );

  useEffect(() => {
    if (mode !== 'live') return undefined;
    const listener = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      const firstDeviceId = deviceIds[0];
      if (firstDeviceId) void refreshDevice(firstDeviceId);
    });
    return () => listener.remove();
  }, [deviceIds, mode, refreshDevice]);

  const startCheckout = useCallback(
    async (deviceId: string, planCode: string): Promise<BillingActionResult> => {
      if (mode === 'demo') return { kind: 'demo' };
      if (mode === 'unavailable') return { kind: 'error', code: 'configuration' };
      if (!BILLING_API_CONFIG || !accessToken) {
        return { kind: 'error', code: 'configuration' };
      }
      try {
        const url = await createAccountCheckout(BILLING_API_CONFIG, accessToken, planCode);
        await WebBrowser.openBrowserAsync(url);
        void refreshAfterBillingReturn(deviceId);
        return { kind: 'opened' };
      } catch (error) {
        return { kind: 'error', code: safeBillingErrorCode(error) };
      }
    },
    [accessToken, mode, refreshAfterBillingReturn],
  );

  const openPortal = useCallback(
    async (
      deviceId: string,
      action: BillingPortalAction = 'update',
    ): Promise<BillingActionResult> => {
      if (mode === 'demo') return { kind: 'demo' };
      if (mode === 'unavailable') return { kind: 'error', code: 'configuration' };
      if (!BILLING_API_CONFIG || !accessToken) {
        return { kind: 'error', code: 'configuration' };
      }
      try {
        const url = await createAccountPortal(BILLING_API_CONFIG, accessToken, action);
        await WebBrowser.openBrowserAsync(url);
        void refreshAfterBillingReturn(deviceId);
        return { kind: 'opened' };
      } catch (error) {
        return { kind: 'error', code: safeBillingErrorCode(error) };
      }
    },
    [accessToken, mode, refreshAfterBillingReturn],
  );

  const startProvisioningCheckout = useCallback(
    async (requestId: string, planCode: string): Promise<BillingActionResult> => {
      if (mode === 'demo') return { kind: 'demo' };
      if (mode === 'unavailable') return { kind: 'error', code: 'configuration' };
      if (!BILLING_API_CONFIG || !accessToken) {
        return { kind: 'error', code: 'configuration' };
      }
      try {
        const url = await createProvisioningCheckout(
          BILLING_API_CONFIG,
          accessToken,
          requestId,
          planCode,
        );
        await WebBrowser.openBrowserAsync(url);
        return { kind: 'opened' };
      } catch (error) {
        return { kind: 'error', code: safeBillingErrorCode(error) };
      }
    },
    [accessToken, mode],
  );

  return {
    subscriptions,
    loadingIds,
    errors,
    mode,
    purchasesEnabled: mode === 'demo' || mode === 'live',
    refreshDevice,
    startCheckout,
    startProvisioningCheckout,
    openPortal,
  };
}
