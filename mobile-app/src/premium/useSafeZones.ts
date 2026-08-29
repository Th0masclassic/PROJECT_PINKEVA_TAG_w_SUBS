import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProvisioningApiConfig } from '../provisioning/api';
import {
  createSafeZone,
  deleteSafeZone,
  listSafeZones,
  PremiumApiError,
  premiumErrorCode,
  SAFE_ZONE_LIMIT,
  updateSafeZone,
  type DeviceSafeZone,
  type SafeZoneInput,
  type SafeZoneUpdate,
} from './api';

type SafeZoneScope = {
  ownerKey: string;
  deviceId: string;
  enabled: boolean;
  apiConfig: ProvisioningApiConfig | null;
  getAccessToken: () => Promise<string | null>;
  demoPreviewEnabled?: boolean;
};

export type SafeZoneState = {
  zones: DeviceSafeZone[];
  loading: boolean;
  mutating: boolean;
  error?: string;
  refresh: () => Promise<void>;
  create: (input: SafeZoneInput) => Promise<DeviceSafeZone>;
  update: (safeZoneId: string, input: SafeZoneUpdate) => Promise<DeviceSafeZone>;
  remove: (safeZoneId: string) => Promise<void>;
};

function createDemoZones(deviceId: string): DeviceSafeZone[] {
  const now = new Date().toISOString();
  return [
    {
      id: '11111111-1111-4111-8111-111111111111',
      deviceId,
      name: 'Home',
      latitude: 38.7223,
      longitude: -9.1393,
      radiusMeters: 75,
      enabled: true,
      lastTrackerInside: true,
      lastEvaluatedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      deviceId,
      name: 'Work',
      latitude: 38.7369,
      longitude: -9.1427,
      radiusMeters: 100,
      enabled: true,
      lastTrackerInside: false,
      lastEvaluatedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function nextDemoZoneId(count: number): string {
  return `30000000-0000-4000-8000-${String(count + 1).padStart(12, '0')}`;
}

export function useSafeZones(scope: SafeZoneScope): SafeZoneState {
  const demoPreviewEnabled = Boolean(scope.demoPreviewEnabled);
  const mode = demoPreviewEnabled
    ? 'demo'
    : scope.enabled && scope.apiConfig
      ? 'live'
      : 'unavailable';
  const contextIdentity = [
    scope.ownerKey,
    scope.deviceId,
    mode,
    scope.apiConfig?.baseUrl ?? '',
  ].join('\u001f');
  const currentContext = useRef(contextIdentity);
  currentContext.current = contextIdentity;
  const [zones, setZones] = useState<DeviceSafeZone[]>([]);
  const zonesRef = useRef(zones);
  zonesRef.current = zones;
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(async (): Promise<void> => {
    const requestContext = contextIdentity;
    if (mode === 'unavailable') {
      setZones([]);
      setError('PREMIUM_UNAVAILABLE');
      return;
    }
    setLoading(true);
    try {
      const next = mode === 'demo'
        ? createDemoZones(scope.deviceId)
        : await listSafeZones(scope.apiConfig!, scope.getAccessToken, scope.deviceId);
      if (currentContext.current !== requestContext) return;
      setZones(next);
      setError(undefined);
    } catch (requestError) {
      if (currentContext.current !== requestContext) return;
      setError(premiumErrorCode(requestError));
    } finally {
      if (currentContext.current === requestContext) setLoading(false);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  useEffect(() => {
    setZones([]);
    setError(undefined);
    setLoading(false);
    setMutating(false);
    if (mode !== 'unavailable') void refresh();
  }, [contextIdentity, mode, refresh]);

  const create = useCallback(async (input: SafeZoneInput): Promise<DeviceSafeZone> => {
    const requestContext = contextIdentity;
    if (mode === 'unavailable') throw new PremiumApiError('PREMIUM_UNAVAILABLE');
    if (zonesRef.current.length >= SAFE_ZONE_LIMIT) {
      throw new PremiumApiError('SAFE_ZONE_LIMIT_REACHED', 409);
    }
    setMutating(true);
    try {
      const created = mode === 'demo'
        ? {
            id: nextDemoZoneId(zonesRef.current.length),
            deviceId: scope.deviceId,
            name: input.name.trim(),
            latitude: input.latitude,
            longitude: input.longitude,
            radiusMeters: input.radiusMeters,
            enabled: true,
            lastTrackerInside: null,
            lastEvaluatedAt: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        : await createSafeZone(
            scope.apiConfig!,
            scope.getAccessToken,
            scope.deviceId,
            input,
          );
      if (currentContext.current === requestContext) {
        setZones((current) => [...current, created]);
        setError(undefined);
      }
      return created;
    } catch (requestError) {
      if (currentContext.current === requestContext) setError(premiumErrorCode(requestError));
      throw requestError;
    } finally {
      if (currentContext.current === requestContext) setMutating(false);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  const update = useCallback(async (
    safeZoneId: string,
    input: SafeZoneUpdate,
  ): Promise<DeviceSafeZone> => {
    const requestContext = contextIdentity;
    if (mode === 'unavailable') throw new PremiumApiError('PREMIUM_UNAVAILABLE');
    setMutating(true);
    try {
      const existing = zonesRef.current.find((zone) => zone.id === safeZoneId);
      const updated = mode === 'demo'
        ? existing
          ? {
              ...existing,
              ...(input.name !== undefined ? { name: input.name.trim() } : {}),
              ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
              ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
              ...(input.radiusMeters !== undefined ? { radiusMeters: input.radiusMeters } : {}),
              ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
              lastTrackerInside: null,
              lastEvaluatedAt: null,
              updatedAt: new Date().toISOString(),
            }
          : null
        : await updateSafeZone(
            scope.apiConfig!,
            scope.getAccessToken,
            scope.deviceId,
            safeZoneId,
            input,
          );
      if (!updated) throw new PremiumApiError('SAFE_ZONE_NOT_FOUND', 404);
      if (currentContext.current === requestContext) {
        setZones((current) => current.map((zone) => zone.id === safeZoneId ? updated : zone));
        setError(undefined);
      }
      return updated;
    } catch (requestError) {
      if (currentContext.current === requestContext) setError(premiumErrorCode(requestError));
      throw requestError;
    } finally {
      if (currentContext.current === requestContext) setMutating(false);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  const remove = useCallback(async (safeZoneId: string): Promise<void> => {
    const requestContext = contextIdentity;
    if (mode === 'unavailable') throw new PremiumApiError('PREMIUM_UNAVAILABLE');
    setMutating(true);
    try {
      if (mode !== 'demo') {
        await deleteSafeZone(
          scope.apiConfig!,
          scope.getAccessToken,
          scope.deviceId,
          safeZoneId,
        );
      }
      if (currentContext.current === requestContext) {
        setZones((current) => current.filter((zone) => zone.id !== safeZoneId));
        setError(undefined);
      }
    } catch (requestError) {
      if (currentContext.current === requestContext) setError(premiumErrorCode(requestError));
      throw requestError;
    } finally {
      if (currentContext.current === requestContext) setMutating(false);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  return { zones, loading, mutating, error, refresh, create, update, remove };
}
