import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProvisioningApiConfig } from '../provisioning/api';
import type { Tracker } from '../model';
import { requestLocationReport, type DeviceLocationReport } from './api';

type UpdateTrackers = (action: (current: Tracker[]) => Tracker[]) => void;

type LocationReportScope = {
  ownerKey: string;
  enabled: boolean;
  apiConfig: ProvisioningApiConfig | null;
  getAccessToken: () => Promise<string | null>;
  trackerIds: string[];
  trackers: Tracker[];
  updateTrackers: UpdateTrackers;
};

export type LocationReportResult = {
  updated: number;
  failed: number;
};

function relativeLastSeen(value: string | null): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function applyReport(current: Tracker[], report: DeviceLocationReport): Tracker[] {
  return current.map((tracker) => {
    if (tracker.id !== report.device_id) return tracker;
    const lastSeen = relativeLastSeen(report.last_location_at);
    return {
      ...tracker,
      ...(report.latitude !== null && report.longitude !== null
        ? { latitude: report.latitude, longitude: report.longitude }
        : {}),
      ...(report.last_location_at ? { lastLocationAt: report.last_location_at } : {}),
      ...(report.last_place ? { place: report.last_place, address: report.last_place } : {}),
      ...(lastSeen ? { lastSeen } : {}),
    };
  });
}

/**
 * Requests reports only for hosted UUID-backed tags. The hook is deliberately
 * trigger-based: the caller chooses when a map, tracker list, or detail page
 * becomes visible, while this hook handles concurrency and local projection
 * updates without exposing any key material.
 */
export function useLocationReports(scope: LocationReportScope) {
  const [refreshing, setRefreshing] = useState(false);
  const requestSequence = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeKey = `${scope.ownerKey}:${scope.enabled ? '1' : '0'}:${scope.trackerIds.join(',')}`;

  const refresh = useCallback(async (): Promise<LocationReportResult> => {
    const currentScope = scopeRef.current;
    const targets = currentScope.trackerIds.filter((id) =>
      currentScope.trackers.some((tracker) => tracker.id === id && tracker.source === 'hosted'),
    );
    if (!currentScope.enabled || !currentScope.apiConfig || targets.length === 0) {
      return { updated: 0, failed: 0 };
    }

    const sequence = ++requestSequence.current;
    setRefreshing(true);
    const responses = await Promise.allSettled(
      targets.map((deviceId) =>
        requestLocationReport(
          currentScope.apiConfig!,
          currentScope.getAccessToken,
          deviceId,
        ),
      ),
    );
    if (requestSequence.current === sequence) {
      const reports = responses.flatMap((response) =>
        response.status === 'fulfilled' ? [response.value] : [],
      );
      if (reports.length) {
        currentScope.updateTrackers((trackers) =>
          reports.reduce((next, report) => applyReport(next, report), trackers),
        );
      }
      setRefreshing(false);
    }
    return {
      updated: responses.filter(
        (response) => response.status === 'fulfilled' && response.value.report_status === 'updated',
      ).length,
      failed: responses.filter((response) => response.status === 'rejected').length,
    };
  }, [scopeKey]);

  const refreshTracker = useCallback(async (deviceId: string): Promise<DeviceLocationReport> => {
    const currentScope = scopeRef.current;
    const isHostedTarget = currentScope.trackers.some(
      (tracker) => tracker.id === deviceId && tracker.source === 'hosted',
    );
    if (!currentScope.enabled || !currentScope.apiConfig || !isHostedTarget) {
      throw new Error('Location reporting is unavailable for this tracker');
    }

    const sequence = ++requestSequence.current;
    setRefreshing(true);
    try {
      const report = await requestLocationReport(
        currentScope.apiConfig,
        currentScope.getAccessToken,
        deviceId,
      );
      if (requestSequence.current === sequence) {
        currentScope.updateTrackers((trackers) => applyReport(trackers, report));
      }
      return report;
    } finally {
      if (requestSequence.current === sequence) setRefreshing(false);
    }
  }, [scopeKey]);

  useEffect(() => {
    // Invalidate an in-flight request if the authenticated owner or visible
    // device scope changes. A report from the previous account must never be
    // applied to the next account's local projection.
    requestSequence.current += 1;
    setRefreshing(false);
  }, [scopeKey]);

  return { refreshing, refresh, refreshTracker };
}
