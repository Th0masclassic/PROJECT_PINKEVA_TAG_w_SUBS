import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { ProvisioningApiConfig } from '../provisioning/api';
import {
  getPremiumFeatures,
  getPremiumOverview,
  premiumErrorCode,
  type PremiumFeatureAccess,
  type PremiumTrackerOverview,
} from './api';

export type PremiumTrackerState = {
  features: Record<string, PremiumFeatureAccess>;
  overviews: Record<string, PremiumTrackerOverview>;
  loadingIds: ReadonlySet<string>;
  errors: Record<string, string | undefined>;
  refreshDevice: (deviceId: string) => Promise<void>;
};

type PremiumTrackerScope = {
  ownerKey: string;
  enabled: boolean;
  apiConfig: ProvisioningApiConfig | null;
  getAccessToken: () => Promise<string | null>;
  deviceIds: readonly string[];
  demoPreviewEnabled?: boolean;
};

function setMembership(current: ReadonlySet<string>, value: string, present: boolean): Set<string> {
  const next = new Set(current);
  if (present) next.add(value);
  else next.delete(value);
  return next;
}

function createDemoFeatures(deviceId: string): PremiumFeatureAccess {
  return {
    deviceId,
    subscriptionActive: true,
    tier: 'premium',
    cloudLocationReports: true,
    locationHistoryDays: 30,
    smartAlerts: true,
    safeZones: true,
    companionSeparationAlerts: true,
    trustedSharing: true,
    recoveryReport: true,
    vehicleMode: true,
    replacementBenefit: true,
  };
}

function createDemoOverview(deviceId: string): PremiumTrackerOverview {
  return {
    deviceId,
    trackerName: 'Pinkeva Tag',
    subscriptionActive: true,
    locationStatus: 'current',
    lastLocationAt: new Date().toISOString(),
    firmwareVersion: '1.1.0',
    separationAlerts: true,
    vehicleMode: false,
    movementAlerts: true,
    safeZoneCount: 2,
    activeShareCount: 0,
    companionStatus: 'ready',
    replacementEligible: true,
  };
}

export function usePremiumTrackers(scope: PremiumTrackerScope): PremiumTrackerState {
  const deviceIdsKey = scope.deviceIds.join('\u001f');
  const deviceIds = useMemo(
    () => (deviceIdsKey ? deviceIdsKey.split('\u001f') : []),
    [deviceIdsKey],
  );
  const demoPreviewEnabled = Boolean(scope.demoPreviewEnabled);
  const mode = demoPreviewEnabled
    ? 'demo'
    : scope.enabled && scope.apiConfig
      ? 'live'
      : 'unavailable';
  const contextIdentity = [
    scope.ownerKey,
    mode,
    scope.apiConfig?.baseUrl ?? '',
    deviceIdsKey,
  ].join('\u001f');
  const currentContext = useRef(contextIdentity);
  currentContext.current = contextIdentity;
  const generation = useRef(0);
  const [features, setFeatures] = useState<Record<string, PremiumFeatureAccess>>({});
  const [overviews, setOverviews] = useState<Record<string, PremiumTrackerOverview>>({});
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const refreshDevice = useCallback(async (deviceId: string): Promise<void> => {
    const requestContext = contextIdentity;
    let featureLoaded = false;
    setLoadingIds((current) => setMembership(current, deviceId, true));
    try {
      const nextFeatures = mode === 'demo'
        ? createDemoFeatures(deviceId)
        : mode === 'live' && scope.apiConfig
          ? await getPremiumFeatures(scope.apiConfig, scope.getAccessToken, deviceId)
          : null;
      if (!nextFeatures) throw new Error('Premium services unavailable');
      if (currentContext.current !== requestContext) return;
      setFeatures((current) => ({ ...current, [deviceId]: nextFeatures }));
      featureLoaded = true;

      if (nextFeatures.subscriptionActive) {
        const nextOverview = mode === 'demo'
          ? createDemoOverview(deviceId)
          : await getPremiumOverview(scope.apiConfig!, scope.getAccessToken, deviceId);
        if (currentContext.current !== requestContext) return;
        setOverviews((current) => ({ ...current, [deviceId]: nextOverview }));
      } else {
        setOverviews((current) => {
          const next = { ...current };
          delete next[deviceId];
          return next;
        });
      }
      setErrors((current) => ({ ...current, [deviceId]: undefined }));
    } catch (error) {
      if (currentContext.current !== requestContext) return;
      setErrors((current) => ({ ...current, [deviceId]: premiumErrorCode(error) }));
      if (!featureLoaded) {
        setFeatures((current) => {
          const next = { ...current };
          delete next[deviceId];
          return next;
        });
        setOverviews((current) => {
          const next = { ...current };
          delete next[deviceId];
          return next;
        });
      }
    } finally {
      if (currentContext.current === requestContext) {
        setLoadingIds((current) => setMembership(current, deviceId, false));
      }
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.getAccessToken]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    const effectContext = contextIdentity;
    setFeatures({});
    setOverviews({});
    setErrors({});
    setLoadingIds(mode === 'unavailable' ? new Set() : new Set(deviceIds));

    if (mode === 'unavailable') {
      if (deviceIds.length) {
        setErrors(Object.fromEntries(deviceIds.map((id) => [id, 'PREMIUM_UNAVAILABLE'])));
      }
      return;
    }

    void (async () => {
      // Authentication refresh is intentionally serialized so several tags do
      // not race to rotate the same Supabase refresh token.
      for (const deviceId of deviceIds) {
        if (
          generation.current !== currentGeneration ||
          currentContext.current !== effectContext
        ) return;
        await refreshDevice(deviceId);
      }
    })();
  }, [contextIdentity, deviceIds, mode, refreshDevice]);

  useEffect(() => {
    if (mode !== 'live') return undefined;
    const listener = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      void (async () => {
        for (const deviceId of deviceIds) await refreshDevice(deviceId);
      })();
    });
    return () => listener.remove();
  }, [deviceIds, mode, refreshDevice]);

  return { features, overviews, loadingIds, errors, refreshDevice };
}
