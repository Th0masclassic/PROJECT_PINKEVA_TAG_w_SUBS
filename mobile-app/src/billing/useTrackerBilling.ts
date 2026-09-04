import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import {
  createAccountCheckout,
  createAccountPortal,
  createProvisioningCheckout,
  getAccountSubscription,
  safeBillingErrorCode,
} from './api';
import { BILLING_API_CONFIG } from './config';
import { createDemoAccountSubscription } from './demo';
import { resolveBillingMode } from './types';
import type {
  AccountSubscription,
  BillingActionResult,
  BillingErrorCode,
  BillingMode,
  BillingPortalAction,
} from './types';

type BillingState = {
  subscription?: AccountSubscription;
  loading: boolean;
  error?: BillingErrorCode;
  mode: BillingMode;
  purchasesEnabled: boolean;
  refresh: () => Promise<void>;
  startCheckout: (planCode: string) => Promise<BillingActionResult>;
  startProvisioningCheckout: (
    requestId: string,
    planCode: string,
  ) => Promise<BillingActionResult>;
  openPortal: (action?: BillingPortalAction) => Promise<BillingActionResult>;
};

const POST_BILLING_REFRESH_DELAYS_MS = [0, 1_000, 2_500, 5_000] as const;

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function useTrackerBilling(
  accessToken: string | null,
  demoPreviewEnabled = false,
): BillingState {
  const mode = resolveBillingMode(
    Boolean(BILLING_API_CONFIG),
    Boolean(accessToken),
    demoPreviewEnabled,
  );
  const contextIdentity = `${mode}\u001f${accessToken ?? ''}`;
  const currentContext = useRef(contextIdentity);
  currentContext.current = contextIdentity;
  const generation = useRef(0);
  const [subscription, setSubscription] = useState<AccountSubscription>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<BillingErrorCode>();

  const refresh = useCallback(async (): Promise<void> => {
    const requestContext = contextIdentity;
    if (mode === 'demo') {
      setSubscription(createDemoAccountSubscription());
      setError(undefined);
      setLoading(false);
      return;
    }
    if (mode !== 'live' || !BILLING_API_CONFIG || !accessToken) {
      setSubscription(undefined);
      setError(accessToken ? 'configuration' : 'authentication');
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const next = await getAccountSubscription(BILLING_API_CONFIG, accessToken);
      if (currentContext.current !== requestContext) return;
      setSubscription(next);
      setError(undefined);
    } catch (requestError) {
      if (currentContext.current !== requestContext) return;
      setSubscription(undefined);
      setError(safeBillingErrorCode(requestError));
    } finally {
      if (currentContext.current === requestContext) setLoading(false);
    }
  }, [accessToken, contextIdentity, mode]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const effectContext = contextIdentity;
    setSubscription(undefined);
    setError(undefined);
    setLoading(mode === 'live');
    void refresh().finally(() => {
      if (
        generation.current === currentGeneration &&
        currentContext.current === effectContext
      ) {
        setLoading(false);
      }
    });
  }, [contextIdentity, mode, refresh]);

  const refreshAfterBillingReturn = useCallback(async () => {
    const requestContext = contextIdentity;
    for (const delayMs of POST_BILLING_REFRESH_DELAYS_MS) {
      if (delayMs) await waitFor(delayMs);
      if (currentContext.current !== requestContext) return;
      await refresh();
    }
  }, [contextIdentity, refresh]);

  useEffect(() => {
    if (mode !== 'live') return undefined;
    const listener = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refresh();
    });
    return () => listener.remove();
  }, [mode, refresh]);

  const startCheckout = useCallback(async (
    planCode: string,
  ): Promise<BillingActionResult> => {
    if (mode === 'demo') return { kind: 'demo' };
    if (mode !== 'live' || !BILLING_API_CONFIG || !accessToken) {
      return { kind: 'error', code: 'configuration' };
    }
    try {
      const url = await createAccountCheckout(BILLING_API_CONFIG, accessToken, planCode);
      await WebBrowser.openBrowserAsync(url);
      void refreshAfterBillingReturn();
      return { kind: 'opened' };
    } catch (requestError) {
      return { kind: 'error', code: safeBillingErrorCode(requestError) };
    }
  }, [accessToken, mode, refreshAfterBillingReturn]);

  const openPortal = useCallback(async (
    action: BillingPortalAction = 'update',
  ): Promise<BillingActionResult> => {
    if (mode === 'demo') return { kind: 'demo' };
    if (mode !== 'live' || !BILLING_API_CONFIG || !accessToken) {
      return { kind: 'error', code: 'configuration' };
    }
    try {
      const url = await createAccountPortal(BILLING_API_CONFIG, accessToken, action);
      await WebBrowser.openBrowserAsync(url);
      void refreshAfterBillingReturn();
      return { kind: 'opened' };
    } catch (requestError) {
      return { kind: 'error', code: safeBillingErrorCode(requestError) };
    }
  }, [accessToken, mode, refreshAfterBillingReturn]);

  const startProvisioningCheckout = useCallback(async (
    requestId: string,
    planCode: string,
  ): Promise<BillingActionResult> => {
    if (mode === 'demo') return { kind: 'demo' };
    if (mode !== 'live' || !BILLING_API_CONFIG || !accessToken) {
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
    } catch (requestError) {
      return { kind: 'error', code: safeBillingErrorCode(requestError) };
    }
  }, [accessToken, mode]);

  return {
    subscription,
    loading,
    error,
    mode,
    purchasesEnabled: mode === 'demo' || mode === 'live',
    refresh,
    startCheckout,
    startProvisioningCheckout,
    openPortal,
  };
}
