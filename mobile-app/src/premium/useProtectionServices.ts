import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProvisioningApiConfig } from '../provisioning/api';
import {
  createRecoveryShare,
  createReplacementClaim,
  deleteLocationHistory,
  getCompanionStatus,
  getProtectionProfile,
  getRecoveryReport,
  getReplacementEligibility,
  listRecoveryShares,
  listReplacementClaims,
  PremiumApiError,
  premiumErrorCode,
  reportCompanionObservation,
  resetCompanion,
  revokeRecoveryShare,
  updateProtectionProfile,
  type CompanionObservationInput,
  type CompanionStatus,
  type LocationHistoryDeleteResult,
  type ProtectionProfile,
  type ProtectionProfileUpdate,
  type RecoveryReport,
  type RecoveryShareCreateResult,
  type RecoveryShareInput,
  type RecoveryShareSummary,
  type ReplacementClaim,
  type ReplacementClaimInput,
  type ReplacementEligibility,
} from './api';

type Scope = {
  ownerKey: string;
  deviceId: string;
  enabled: boolean;
  apiConfig: ProvisioningApiConfig | null;
  getAccessToken: () => Promise<string | null>;
  demoPreviewEnabled?: boolean;
};

export type ProtectionServicesState = {
  profile?: ProtectionProfile;
  companion?: CompanionStatus;
  report?: RecoveryReport;
  shares: RecoveryShareSummary[];
  eligibility?: ReplacementEligibility;
  claims: ReplacementClaim[];
  loading: boolean;
  mutating: string | null;
  error?: string;
  mode: 'live' | 'demo' | 'unavailable';
  refresh: () => Promise<void>;
  updateProfile: (input: ProtectionProfileUpdate) => Promise<ProtectionProfile>;
  observeCompanion: (input: CompanionObservationInput) => Promise<CompanionStatus>;
  removeCompanion: () => Promise<void>;
  createShare: (input: RecoveryShareInput) => Promise<RecoveryShareCreateResult>;
  revokeShare: (shareId: string) => Promise<RecoveryShareSummary>;
  submitClaim: (input: ReplacementClaimInput) => Promise<ReplacementClaim>;
  eraseHistory: () => Promise<LocationHistoryDeleteResult>;
};

function demoProfile(deviceId: string): ProtectionProfile {
  return {
    deviceId,
    separationAlerts: true,
    separationThresholdMeters: 500,
    vehicleMode: false,
    movementAlerts: true,
    movementThresholdMeters: 750,
    updatedAt: new Date().toISOString(),
  };
}

function demoCompanion(deviceId: string): CompanionStatus {
  return {
    deviceId,
    subscriptionActive: true,
    configured: true,
    installationId: '99999999-9999-4999-8999-999999999999',
    platform: 'ios',
    observationAccepted: true,
    lastObservationAt: new Date().toISOString(),
    phoneAccuracyMeters: 15,
    tagProximity: 'unknown',
    tagObservedAt: null,
    tagRssiDbm: null,
  };
}

function demoReport(deviceId: string): RecoveryReport {
  return {
    deviceId,
    trackerName: 'Preview tracker',
    serialNumber: 'PKV-AABBCCDDEEFF',
    generatedAt: new Date().toISOString(),
    subscriptionPeriodEnd: '2027-08-31T00:00:00Z',
    lastLocation: {
      latitude: 38.7223,
      longitude: -9.1393,
      recordedAt: new Date().toISOString(),
    },
    locationCount30d: 18,
    safeZoneCount: 2,
    activeShareCount: 1,
    recentAlertCount30d: 2,
    companionStatus: 'ready',
    replacementEligible: true,
    replacementClaimStatus: null,
  };
}

function demoShare(deviceId: string): RecoveryShareSummary {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 72 * 60 * 60 * 1_000);
  return {
    id: '88888888-8888-4888-8888-888888888888',
    deviceId,
    label: 'Preview recovery contact',
    accessLevel: 'latest',
    expiresAt: expiresAt.toISOString(),
    revokedAt: null,
    lastAccessedAt: null,
    createdAt: createdAt.toISOString(),
  };
}

function demoEligibility(deviceId: string): ReplacementEligibility {
  return {
    deviceId,
    eligible: true,
    reason: 'eligible',
    minimumPlanMonths: 6,
    currentPlanMonths: 12,
    benefitPeriodStart: '2026-08-01T00:00:00Z',
    benefitPeriodEnd: '2027-08-01T00:00:00Z',
    existingClaimId: null,
    existingClaimStatus: null,
  };
}

export function useProtectionServices(scope: Scope): ProtectionServicesState {
  const mode: ProtectionServicesState['mode'] = scope.demoPreviewEnabled
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
  const [profile, setProfile] = useState<ProtectionProfile>();
  const [companion, setCompanion] = useState<CompanionStatus>();
  const [report, setReport] = useState<RecoveryReport>();
  const [shares, setShares] = useState<RecoveryShareSummary[]>([]);
  const [eligibility, setEligibility] = useState<ReplacementEligibility>();
  const [claims, setClaims] = useState<ReplacementClaim[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState<string | null>(null);
  const activeMutation = useRef<string | null>(null);
  const [error, setError] = useState<string>();

  const beginMutation = (kind: string) => {
    if (activeMutation.current) throw new PremiumApiError('OPERATION_IN_PROGRESS', 409);
    activeMutation.current = kind;
    setMutating(kind);
  };

  const finishMutation = (kind: string, requestContext: string) => {
    if (currentContext.current !== requestContext || activeMutation.current !== kind) return;
    activeMutation.current = null;
    setMutating(null);
  };

  const refresh = useCallback(async () => {
    const requestContext = contextIdentity;
    if (mode === 'unavailable') {
      setError('PREMIUM_UNAVAILABLE');
      return;
    }
    setLoading(true);
    setError(undefined);
    if (mode === 'demo') {
      setProfile(demoProfile(scope.deviceId));
      setCompanion(demoCompanion(scope.deviceId));
      setReport(demoReport(scope.deviceId));
      setShares([demoShare(scope.deviceId)]);
      setEligibility(demoEligibility(scope.deviceId));
      setClaims([]);
      setLoading(false);
      return;
    }
    const config = scope.apiConfig!;
    const results = await Promise.allSettled([
      getProtectionProfile(config, scope.getAccessToken, scope.deviceId),
      getCompanionStatus(config, scope.getAccessToken, scope.deviceId),
      getRecoveryReport(config, scope.getAccessToken, scope.deviceId),
      listRecoveryShares(config, scope.getAccessToken, scope.deviceId),
      getReplacementEligibility(config, scope.getAccessToken, scope.deviceId),
      listReplacementClaims(config, scope.getAccessToken, scope.deviceId),
    ] as const);
    if (currentContext.current !== requestContext) return;
    const [profileResult, companionResult, reportResult, sharesResult, eligibilityResult, claimsResult] = results;
    if (profileResult.status === 'fulfilled') setProfile(profileResult.value);
    if (companionResult.status === 'fulfilled') setCompanion(companionResult.value);
    if (reportResult.status === 'fulfilled') setReport(reportResult.value);
    if (sharesResult.status === 'fulfilled') setShares(sharesResult.value);
    if (eligibilityResult.status === 'fulfilled') setEligibility(eligibilityResult.value);
    if (claimsResult.status === 'fulfilled') setClaims(claimsResult.value);
    const failure = results.find((result) => result.status === 'rejected');
    setError(failure?.status === 'rejected' ? premiumErrorCode(failure.reason) : undefined);
    setLoading(false);
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  useEffect(() => {
    setProfile(undefined);
    setCompanion(undefined);
    setReport(undefined);
    setShares([]);
    setEligibility(undefined);
    setClaims([]);
    setError(undefined);
    activeMutation.current = null;
    setMutating(null);
    if (mode !== 'unavailable') void refresh();
  }, [contextIdentity, mode, refresh]);

  const requireLive = () => {
    if (mode !== 'live' || !scope.apiConfig) {
      throw new PremiumApiError(
        mode === 'demo' ? 'DEMO_PREVIEW_ONLY' : 'PREMIUM_UNAVAILABLE',
      );
    }
    return scope.apiConfig;
  };

  const updateProfile = useCallback(async (input: ProtectionProfileUpdate) => {
    const requestContext = contextIdentity;
    if (mode === 'demo') {
      const updated = { ...(profile ?? demoProfile(scope.deviceId)), ...input, updatedAt: new Date().toISOString() };
      if (currentContext.current === requestContext) setProfile(updated);
      return updated;
    }
    const config = requireLive();
    beginMutation('profile');
    try {
      const updated = await updateProtectionProfile(config, scope.getAccessToken, scope.deviceId, input);
      if (currentContext.current === requestContext) setProfile(updated);
      return updated;
    } finally {
      finishMutation('profile', requestContext);
    }
  }, [contextIdentity, mode, profile, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  const observeCompanion = useCallback(async (input: CompanionObservationInput) => {
    const requestContext = contextIdentity;
    const config = requireLive();
    beginMutation('companion');
    try {
      const updated = await reportCompanionObservation(config, scope.getAccessToken, scope.deviceId, input);
      if (currentContext.current === requestContext) setCompanion(updated);
      return updated;
    } finally {
      finishMutation('companion', requestContext);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  const removeCompanion = useCallback(async () => {
    const requestContext = contextIdentity;
    const config = requireLive();
    beginMutation('companion');
    try {
      await resetCompanion(config, scope.getAccessToken, scope.deviceId);
      if (currentContext.current === requestContext) {
        setCompanion({
          deviceId: scope.deviceId,
          subscriptionActive: true,
          configured: false,
          installationId: null,
          platform: null,
          observationAccepted: null,
          lastObservationAt: null,
          phoneAccuracyMeters: null,
          tagProximity: null,
          tagObservedAt: null,
          tagRssiDbm: null,
        });
      }
    } finally {
      finishMutation('companion', requestContext);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  const createShare = useCallback(async (input: RecoveryShareInput) => {
    const requestContext = contextIdentity;
    const config = requireLive();
    beginMutation('share');
    try {
      const created = await createRecoveryShare(config, scope.getAccessToken, scope.deviceId, input);
      if (currentContext.current === requestContext) {
        setShares((current) => [created, ...current]);
        setReport((current) => current ? { ...current, activeShareCount: current.activeShareCount + 1 } : current);
      }
      return created;
    } finally {
      finishMutation('share', requestContext);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  const revokeShare = useCallback(async (shareId: string) => {
    const requestContext = contextIdentity;
    const config = requireLive();
    beginMutation('share');
    try {
      const revoked = await revokeRecoveryShare(config, scope.getAccessToken, scope.deviceId, shareId);
      if (currentContext.current === requestContext) {
        setShares((current) => current.map((share) => share.id === shareId ? revoked : share));
        setReport((current) => current ? {
          ...current,
          activeShareCount: Math.max(0, current.activeShareCount - 1),
        } : current);
      }
      return revoked;
    } finally {
      finishMutation('share', requestContext);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  const submitClaim = useCallback(async (input: ReplacementClaimInput) => {
    const requestContext = contextIdentity;
    const config = requireLive();
    beginMutation('claim');
    try {
      const created = await createReplacementClaim(config, scope.getAccessToken, scope.deviceId, input);
      const nextEligibility = await getReplacementEligibility(config, scope.getAccessToken, scope.deviceId);
      if (currentContext.current === requestContext) {
        setClaims((current) => [created, ...current]);
        setEligibility(nextEligibility);
        setReport((current) => current ? {
          ...current,
          replacementEligible: false,
          replacementClaimStatus: created.status,
        } : current);
      }
      return created;
    } finally {
      finishMutation('claim', requestContext);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  const eraseHistory = useCallback(async () => {
    const requestContext = contextIdentity;
    const config = requireLive();
    beginMutation('history');
    try {
      const deleted = await deleteLocationHistory(config, scope.getAccessToken, scope.deviceId);
      if (currentContext.current === requestContext) {
        setReport((current) => current ? {
          ...current,
          lastLocation: null,
          locationCount30d: 0,
        } : current);
      }
      return deleted;
    } finally {
      finishMutation('history', requestContext);
    }
  }, [contextIdentity, mode, scope.apiConfig, scope.deviceId, scope.getAccessToken]);

  return {
    profile,
    companion,
    report,
    shares,
    eligibility,
    claims,
    loading,
    mutating,
    error,
    mode,
    refresh,
    updateProfile,
    observeCompanion,
    removeCompanion,
    createShare,
    revokeShare,
    submitClaim,
    eraseHistory,
  };
}
