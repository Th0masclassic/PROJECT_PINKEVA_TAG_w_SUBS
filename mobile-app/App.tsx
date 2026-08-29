import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from './src/auth/AuthProvider';
import type { AuthFeedback, AuthMode, EmailAuthInput } from './src/auth/types';
import { getUserDisplayName } from './src/auth/userNames';
import { canUseDemoPreview } from './src/auth/demoPreview';
import { useTrackerBilling } from './src/billing/useTrackerBilling';
import { BottomNav, Brand, Toast } from './src/components';
import { I18nProvider, LANGUAGE_NATIVE_NAMES, useI18n } from './src/i18n';
import {
  EMPTY_TRACKER_PREFERENCES,
  type AppRoute,
  type MainTab,
  type PairingPhase,
  type TrackerKind,
  type TrackerPreferences,
  addCanonicalCard,
  nextOperationPhase,
  reconcileTrackerPreferences,
  recordTrackerOpened,
  removeTracker,
  resolveTrackerIcon,
  selectBillingDeviceIds,
  setTrackerIconOverride,
  updateTracker,
} from './src/model';
import {
  loadLanguagePreference,
  loadNotificationPreference,
  loadTrackerPreferences,
  saveLanguagePreference,
  saveNotificationPreference,
  saveTrackerPreferences,
} from './src/preferences';
import { AuthScreen } from './src/screens/AuthScreen';
import { AccountScreen } from './src/screens/AccountScreen';
import { ConfirmRemoveModal } from './src/screens/ConfirmRemoveModal';
import { FirmwareUpdateScreen } from './src/screens/FirmwareUpdateScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { InfoScreen } from './src/screens/InfoScreen';
import { IntervalScreen } from './src/screens/IntervalScreen';
import { LanguageScreen } from './src/screens/LanguageScreen';
import { MapScreen } from './src/screens/MapScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';
import { PairingModal } from './src/screens/PairingModal';
import { PasswordResetScreen } from './src/screens/PasswordResetScreen';
import { ProtectionScreen } from './src/screens/ProtectionScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SubscriptionScreen } from './src/screens/SubscriptionScreen';
import { TrackerDetailScreen } from './src/screens/TrackerDetailScreen';
import { TrackersScreen } from './src/screens/TrackersScreen';
import { colors } from './src/theme';
import { TrackerCloudStateScreen } from './src/trackers/TrackerCloudStateScreen';
import { useOwnedTrackers } from './src/trackers/useOwnedTrackers';
import { useLocationReports } from './src/location/useLocationReports';
import { useRenewalPushRegistration } from './src/notifications/push';
import { useNotificationInbox } from './src/notifications/useNotificationInbox';
import {
  requestLocationHistory,
  type LocationHistoryRange,
} from './src/location/api';
import { PROVISIONING_API_CONFIG, type DeviceClaim } from './src/provisioning/api';
import { TagSetupModal } from './src/provisioning/TagSetupModal';
import { useTagSetup } from './src/provisioning/useTagSetup';
import { useFirmwareUpdate } from './src/provisioning/useFirmwareUpdate';
import { tagSetupErrorTranslationKey } from './src/provisioning/setup';
import { usePremiumTrackers } from './src/premium/usePremiumTrackers';

type PairingContext =
  | { kind: 'add' }
  | { kind: 'interval'; trackerId: string }
  | { kind: 'firmware'; trackerId: string };

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <SafeAreaProvider>
          <StatusBar style="dark" />
          <AppContent />
        </SafeAreaProvider>
      </AuthProvider>
    </I18nProvider>
  );
}

function AppContent() {
  const { language, setLanguage, t } = useI18n();
  const auth = useAuth();
  const [languageHydrated, setLanguageHydrated] = useState(false);
  const [notificationPreferenceOwnerId, setNotificationPreferenceOwnerId] = useState<
    string | null | undefined
  >(undefined);
  const [notificationDeliveryEnabled, setNotificationDeliveryEnabled] = useState(true);
  const [trackerPreferencesOwnerId, setTrackerPreferencesOwnerId] = useState<
    string | null | undefined
  >(undefined);
  const [languageChosen, setLanguageChosen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [demoPreviewActive, setDemoPreviewActive] = useState(false);
  const [activeTab, setActiveTab] = useState<MainTab>('home');
  const [route, setRoute] = useState<AppRoute>({ name: 'main' });
  const [trackerPreferences, setTrackerPreferences] = useState<TrackerPreferences>(
    EMPTY_TRACKER_PREFERENCES,
  );
  const [pairingPhase, setPairingPhase] = useState<PairingPhase>('idle');
  const [pairingContext, setPairingContext] = useState<PairingContext>({ kind: 'add' });
  const [removeTrackerId, setRemoveTrackerId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const provisioningCheckout = useRef<
    (
      requestId: string,
      planCode: string,
    ) => Promise<{ kind: 'opened' | 'demo' | 'disabled' | 'error'; code?: string }>
  >(async () => ({ kind: 'error', code: 'configuration' }));
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousUserId = useRef<string | null | undefined>(undefined);
  const trackerCatalog = useOwnedTrackers(
    auth.user?.id ?? null,
    auth.session?.access_token ?? null,
    demoPreviewActive && __DEV__,
    PROVISIONING_API_CONFIG,
    auth.getAccessToken,
  );
  const { trackers, setTrackers } = trackerCatalog;

  const showNotice = useCallback((message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), 2400);
  }, []);

  const notificationInbox = useNotificationInbox({
    enabled: Boolean(auth.session),
    apiConfig: PROVISIONING_API_CONFIG,
    getAccessToken: auth.getAccessToken,
  });

  const handleTagClaimed = useCallback(
    async (claim: DeviceClaim) => {
      await trackerCatalog.refresh();
      setTrackerPreferences((current) => ({
        ...current,
        mainTrackerId: current.mainTrackerId ?? claim.device_id,
        recentTrackerIds: recordTrackerOpened(current.recentTrackerIds, claim.device_id),
      }));
      setActiveTab('trackers');
      setRoute({ name: 'main' });
      showNotice(t('pairing.tagAddedNotice', { name: claim.serial_number }));
    },
    [showNotice, t, trackerCatalog.refresh],
  );
  const tagSetup = useTagSetup({
    getAccessToken: auth.getAccessToken,
    apiConfig: PROVISIONING_API_CONFIG,
    onClaimed: handleTagClaimed,
    onProvisioningCheckout: (requestId, planCode) =>
      provisioningCheckout.current(requestId, planCode),
  });
  const firmwareUpdate = useFirmwareUpdate({
    getAccessToken: auth.getAccessToken,
    apiConfig: PROVISIONING_API_CONFIG,
    onInstalled: async (deviceId, version) => {
      setTrackers((current) =>
        updateTracker(current, deviceId, {
          firmwareVersion: version,
          firmwareUpdateVersion: undefined,
        }),
      );
      await trackerCatalog.refresh();
    },
  });

  useEffect(() => {
    let active = true;
    void loadLanguagePreference().then((stored) => {
      if (!active) return;
      if (stored) {
        setLanguage(stored);
        setLanguageChosen(true);
      }
      setLanguageHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [setLanguage]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const userId = auth.user?.id ?? (demoPreviewActive ? 'development-preview' : null);
  const authenticated = Boolean(auth.session) || demoPreviewActive;
  const trackerPreferencesHydrated =
    auth.ready && trackerPreferencesOwnerId === userId;
  const accountName = getUserDisplayName(auth.user) ?? t('auth.accountFallbackName');

  useEffect(() => {
    if (!auth.ready) return undefined;
    let active = true;
    setTrackerPreferencesOwnerId(undefined);
    setTrackerPreferences(EMPTY_TRACKER_PREFERENCES);
    void loadTrackerPreferences(userId).then((stored) => {
      if (!active) return;
      setTrackerPreferences(stored);
      setTrackerPreferencesOwnerId(userId);
    });
    return () => {
      active = false;
    };
  }, [auth.ready, userId]);

  useEffect(() => {
    let active = true;
    setNotificationPreferenceOwnerId(undefined);
    setNotificationDeliveryEnabled(true);
    void loadNotificationPreference(userId).then((enabled) => {
      if (!active) return;
      setNotificationDeliveryEnabled(enabled);
      setNotificationPreferenceOwnerId(userId);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  useEffect(() => {
    if (!languageHydrated) return;
    void saveLanguagePreference(languageChosen ? language : null).catch(() => undefined);
  }, [language, languageChosen, languageHydrated]);

  useEffect(() => {
    if (!userId || trackerPreferencesOwnerId !== userId) return;
    void saveTrackerPreferences(userId, trackerPreferences).catch(() => undefined);
  }, [trackerPreferences, trackerPreferencesOwnerId, userId]);

  useEffect(() => {
    if (!trackerPreferencesHydrated || trackerCatalog.status !== 'ready') return;
    setTrackerPreferences((current) => reconcileTrackerPreferences(trackers, current));
  }, [trackerCatalog.status, trackerPreferencesHydrated, trackers]);

  useEffect(() => {
    if (!auth.ready || previousUserId.current === userId) return;
    previousUserId.current = userId;
    setAuthMode('login');
    setActiveTab('home');
    setRoute({ name: 'main' });
    setPairingPhase('idle');
    tagSetup.close();
    firmwareUpdate.close();
    setRemoveTrackerId(null);
  }, [auth.ready, firmwareUpdate.close, tagSetup.close, userId]);

  useEffect(() => {
    if (auth.session) setDemoPreviewActive(false);
  }, [auth.session]);

  const managedDeviceIds = selectBillingDeviceIds(trackers, demoPreviewActive && __DEV__);
  const billing = useTrackerBilling(
    managedDeviceIds,
    auth.session?.access_token ?? null,
    demoPreviewActive && __DEV__,
  );
  const premium = usePremiumTrackers({
    ownerKey: userId ?? '',
    enabled: Boolean(auth.session),
    apiConfig: PROVISIONING_API_CONFIG,
    getAccessToken: auth.getAccessToken,
    deviceIds: managedDeviceIds,
    demoPreviewEnabled: demoPreviewActive && __DEV__,
  });
  const displayTrackers = useMemo(
    () => trackers.map((tracker) =>
      premium.features[tracker.id]?.subscriptionActive
        ? {
            ...tracker,
            kind: resolveTrackerIcon(tracker.id, trackerPreferences.iconOverrides),
          }
        : tracker,
    ),
    [premium.features, trackerPreferences.iconOverrides, trackers],
  );
  provisioningCheckout.current = billing.startProvisioningCheckout;
  const openSubscriptionFromNotification = useCallback(
    (deviceId: string) => {
      void notificationInbox.refresh();
      void billing.refreshDevice(deviceId);
      setActiveTab('trackers');
      setRoute({ name: 'subscription', trackerId: deviceId });
    },
    [billing.refreshDevice, notificationInbox.refresh],
  );
  const openTrackerFromNotification = useCallback(
    (deviceId: string) => {
      void notificationInbox.refresh();
      setTrackerPreferences((current) => ({
        ...current,
        recentTrackerIds: recordTrackerOpened(current.recentTrackerIds, deviceId),
      }));
      setActiveTab('trackers');
      setRoute({ name: 'tracker', trackerId: deviceId });
    },
    [notificationInbox.refresh],
  );
  useRenewalPushRegistration({
    enabled: Boolean(auth.session) && notificationDeliveryEnabled,
    userId: auth.user?.id ?? null,
    apiConfig: PROVISIONING_API_CONFIG,
    getAccessToken: auth.getAccessToken,
    onOpenSubscription: openSubscriptionFromNotification,
    onOpenTracker: openTrackerFromNotification,
  });
  const updateNotificationDelivery = useCallback(
    async (enabled: boolean) => {
      setNotificationDeliveryEnabled(enabled);
      if (userId && notificationPreferenceOwnerId === userId) {
        await saveNotificationPreference(userId, enabled);
      }
    },
    [notificationPreferenceOwnerId, userId],
  );
  const mainTracker = useMemo(
    () => displayTrackers.find((tracker) => tracker.id === trackerPreferences.mainTrackerId),
    [displayTrackers, trackerPreferences.mainTrackerId],
  );
  const selectedTracker = useMemo(() => {
    if (
      route.name !== 'tracker' &&
      route.name !== 'protection' &&
      route.name !== 'subscription' &&
      route.name !== 'interval' &&
      route.name !== 'firmware'
    ) {
      return undefined;
    }
    return displayTrackers.find((tracker) => tracker.id === route.trackerId);
  }, [displayTrackers, route]);
  const selectedBillingDeviceId = selectedTracker?.id;
  const pairingTracker = useMemo(() => {
    if (pairingContext.kind === 'add') return undefined;
    return displayTrackers.find((tracker) => tracker.id === pairingContext.trackerId);
  }, [displayTrackers, pairingContext]);

  const locationTrackerIds = useMemo(() => {
    if (!authenticated || demoPreviewActive || !auth.session) return [];
    if (route.name === 'map') {
      return displayTrackers.map((tracker) => tracker.id);
    }
    if ((route.name === 'tracker' || route.name === 'protection') && selectedTracker) {
      return [selectedTracker.id];
    }
    if (route.name === 'main' && activeTab === 'trackers') {
      return displayTrackers.map((tracker) => tracker.id);
    }
    if (route.name === 'main' && activeTab === 'map') {
      return displayTrackers.map((tracker) => tracker.id);
    }
    if (route.name === 'main' && activeTab === 'home') {
      return displayTrackers.map((tracker) => tracker.id);
    }
    return [];
  }, [activeTab, auth.session, authenticated, demoPreviewActive, displayTrackers, route.name, selectedTracker]);
  const locationReports = useLocationReports({
    ownerKey: auth.user?.id ?? '',
    enabled: Boolean(auth.session) && !demoPreviewActive,
    apiConfig: PROVISIONING_API_CONFIG,
    getAccessToken: auth.getAccessToken,
    trackerIds: locationTrackerIds,
    trackers: displayTrackers,
    updateTrackers: setTrackers,
  });
  const locationTrigger = `${route.name}:${activeTab}:${locationTrackerIds.join(',')}`;
  const requestTrackerHistory = useCallback(
    async (trackerId: string, range: LocationHistoryRange) => {
      const access = premium.features[trackerId];
      const requiredDays = range === '30d' ? 30 : 1;
      if (!access?.subscriptionActive || access.locationHistoryDays < requiredDays) {
        throw new Error('Pinkeva Cloud + required');
      }
      if (!PROVISIONING_API_CONFIG) throw new Error('API configuration unavailable');
      return requestLocationHistory(
        PROVISIONING_API_CONFIG,
        auth.getAccessToken,
        trackerId,
        range,
      );
    },
    [auth.getAccessToken, premium.features],
  );

  useEffect(() => {
    if (!locationTrackerIds.length || !auth.session || demoPreviewActive) return;
    void locationReports.refresh();
  }, [auth.session, demoPreviewActive, locationReports.refresh, locationTrackerIds.length, locationTrigger]);

  useEffect(() => {
    const trackerScopedRoute =
      route.name === 'tracker' ||
      route.name === 'protection' ||
      route.name === 'subscription' ||
      route.name === 'interval' ||
      route.name === 'firmware';
    const invalidLocalSubscription =
      route.name === 'subscription' && selectedTracker?.source === 'local-preview';
    if (
      trackerCatalog.status !== 'ready' ||
      !trackerScopedRoute ||
      (selectedTracker && !invalidLocalSubscription)
    ) return;

    setRoute({ name: 'main' });
    setActiveTab('trackers');
    setPairingPhase('idle');
  }, [route.name, selectedTracker, trackerCatalog.status]);

  useEffect(() => {
    if (pairingPhase === 'idle') return;

    const delay =
      pairingPhase === 'success'
        ? 950
        : pairingPhase === 'installing'
          ? 2200
          : pairingPhase === 'connecting'
            ? 1600
            : 1800;
    const timer = setTimeout(() => {
      if (pairingPhase === 'success') {
        if (pairingContext.kind === 'add') {
          setTrackers((current) => addCanonicalCard(current));
          setActiveTab('trackers');
          setRoute({ name: 'main' });
          showNotice(t('pairing.tagAddedNotice', { name: 'Pinkeva Card' }));
        } else if (pairingContext.kind === 'interval') {
          setTrackers((current) =>
            updateTracker(current, pairingContext.trackerId, { intervalMs: 5000 }),
          );
          setRoute({ name: 'tracker', trackerId: pairingContext.trackerId });
          showNotice(t('interval.updatedNotice'));
        } else {
          setTrackers((current) => {
            const tracker = current.find((item) => item.id === pairingContext.trackerId);
            if (!tracker) return current;
            return updateTracker(current, tracker.id, {
              firmwareVersion: tracker.firmwareUpdateVersion ?? tracker.firmwareVersion,
              firmwareUpdateVersion: undefined,
            });
          });
          setRoute({ name: 'tracker', trackerId: pairingContext.trackerId });
          showNotice(t('tracker.updateCompletedNotice', { name: pairingTracker?.name ?? 'Tracker' }));
        }
        setPairingPhase('idle');
        return;
      }

      setPairingPhase(nextOperationPhase(pairingPhase, pairingContext.kind));
    }, delay);

    return () => clearTimeout(timer);
  }, [pairingContext, pairingPhase, pairingTracker?.name, showNotice, t]);

  useEffect(() => {
    if (firmwareUpdate.state.phase !== 'success' || !firmwareUpdate.state.trackerId) return;
    const trackerId = firmwareUpdate.state.trackerId;
    const trackerName = trackers.find((tracker) => tracker.id === trackerId)?.name ?? 'Tracker';
    const timer = setTimeout(() => {
      firmwareUpdate.close();
      setRoute({ name: 'tracker', trackerId });
      showNotice(t('tracker.updateCompletedNotice', { name: trackerName }));
    }, 950);
    return () => clearTimeout(timer);
  }, [firmwareUpdate.close, firmwareUpdate.state.phase, firmwareUpdate.state.trackerId, showNotice, t, trackers]);

  const back = useCallback(() => {
    if (tagSetup.state.phase !== 'idle') {
      tagSetup.close();
      return true;
    }
    if (firmwareUpdate.state.phase !== 'idle') {
      firmwareUpdate.close();
      return true;
    }
    if (pairingPhase !== 'idle') {
      setPairingPhase('idle');
      return true;
    }
    if (
      route.name === 'interval' ||
      route.name === 'firmware' ||
      route.name === 'subscription' ||
      route.name === 'protection'
    ) {
      setRoute({ name: 'tracker', trackerId: route.trackerId });
      return true;
    }
    if (route.name === 'account' || route.name === 'notifications') {
      setRoute({ name: 'main' });
      return true;
    }
    if (route.name !== 'main') {
      setRoute({ name: 'main' });
      return true;
    }
    return false;
  }, [firmwareUpdate.close, firmwareUpdate.state.phase, pairingPhase, route, tagSetup.close, tagSetup.state.phase]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', back);
    return () => subscription.remove();
  }, [back]);

  const changeTab = (tab: MainTab) => {
    setActiveTab(tab);
    setRoute({ name: 'main' });
  };

  const openTracker = (trackerId: string) => {
    setTrackerPreferences((current) => ({
      ...current,
      recentTrackerIds: recordTrackerOpened(current.recentTrackerIds, trackerId),
    }));
    setActiveTab('trackers');
    setRoute({ name: 'tracker', trackerId });
  };

  const openCloudPlus = (trackerId: string) => {
    const tracker = trackers.find((item) => item.id === trackerId);
    if (!tracker || tracker.source === 'local-preview') {
      showNotice(t('pairing.errorUnavailable'));
      return;
    }
    setActiveTab('trackers');
    setRoute({ name: 'subscription', trackerId });
  };

  const openProtection = (trackerId: string) => {
    const tracker = trackers.find((item) => item.id === trackerId);
    if (!tracker || tracker.source === 'local-preview') {
      showNotice(t('pairing.errorUnavailable'));
      return;
    }
    setActiveTab('trackers');
    setRoute({ name: 'protection', trackerId });
  };

  const openPairing = () => {
    if (demoPreviewActive && __DEV__) {
      setPairingContext({ kind: 'add' });
      setPairingPhase('searching');
      return;
    }
    tagSetup.open();
  };

  const confirmRemove = () => {
    if (!removeTrackerId) return;
    const removed = displayTrackers.find((tracker) => tracker.id === removeTrackerId);
    const nextTrackers = removeTracker(trackers, removeTrackerId);
    const nextPreferences = reconcileTrackerPreferences(nextTrackers, trackerPreferences);
    setTrackers(nextTrackers);
    setTrackerPreferences(nextPreferences);
    setRemoveTrackerId(null);
    setActiveTab('trackers');
    setRoute({ name: 'main' });
    showNotice(t('tracker.removedNotice', { name: removed?.name ?? t('common.tracker') }));
    if (
      removed?.id === trackerPreferences.mainTrackerId &&
      nextPreferences.mainTrackerId
    ) {
      const fallback = nextTrackers.find((tracker) => tracker.id === nextPreferences.mainTrackerId);
      if (fallback) showNotice(t('trackers.mainAutoNotice', { name: fallback.name }));
    }
  };

  const presentAuthFeedback = useCallback(
    (feedback: AuthFeedback) => {
      if (feedback.kind !== 'silent' && feedback.key) {
        showNotice(t(feedback.key, feedback.params));
      }
    },
    [showNotice, t],
  );

  useEffect(() => {
    if (!auth.pendingFeedback) return;
    presentAuthFeedback(auth.pendingFeedback);
    auth.clearPendingFeedback();
  }, [auth, presentAuthFeedback]);

  const signOut = () => {
    if (demoPreviewActive) {
      setDemoPreviewActive(false);
      showNotice(t('auth.signedOut'));
      return;
    }
    void auth.signOut().then(presentAuthFeedback);
  };

  const renderAuthenticatedScreen = () => {
    if ((route.name === 'map' || activeTab === 'map') && displayTrackers.length) {
      return (
        <MapScreen
          trackers={displayTrackers}
          premiumFeatures={premium.features}
          requestedHistoryTrackerId={
            route.name === 'map' ? route.historyTrackerId : undefined
          }
          onHistoryRequestHandled={() => setRoute({ name: 'main' })}
          onRequestTrackerLocation={locationReports.refreshTracker}
          onRequestTrackerHistory={requestTrackerHistory}
          onShowTrackers={() => changeTab('trackers')}
          onNotice={showNotice}
        />
      );
    }

    if (route.name === 'tracker' && selectedTracker) {
      return (
        <TrackerDetailScreen
          tracker={selectedTracker}
          premiumActive={Boolean(premium.features[selectedTracker.id]?.subscriptionActive)}
          premiumLoading={premium.loadingIds.has(selectedTracker.id)}
          onBack={() => changeTab('trackers')}
          onRename={(name) => {
            setTrackers((current) => updateTracker(current, selectedTracker.id, { name }));
            showNotice(t('tracker.nameUpdated'));
          }}
          onChangeIcon={(kind: TrackerKind) => {
            if (!premium.features[selectedTracker.id]?.subscriptionActive) {
              openCloudPlus(selectedTracker.id);
              return;
            }
            setTrackerPreferences((current) => ({
              ...current,
              iconOverrides: setTrackerIconOverride(
                current.iconOverrides,
                selectedTracker.id,
                kind,
              ),
            }));
            const iconName =
              kind === 'keys'
                ? t('tracker.iconKeys')
                : kind === 'backpack'
                  ? t('tracker.iconBag')
                  : kind === 'car'
                    ? t('tracker.iconCar')
                    : t('tracker.iconCard');
            showNotice(t('tracker.iconUpdated', { name: selectedTracker.name, icon: iconName }));
          }}
          subscription={billing.subscriptions[selectedTracker.id]}
          subscriptionLoading={billing.loadingIds.has(selectedTracker.id)}
          onOpenProtection={() => openProtection(selectedTracker.id)}
          onOpenSubscription={() => openCloudPlus(selectedTracker.id)}
          onOpenInterval={() => setRoute({ name: 'interval', trackerId: selectedTracker.id })}
          onOpenFirmware={() => setRoute({ name: 'firmware', trackerId: selectedTracker.id })}
          onRemove={() => setRemoveTrackerId(selectedTracker.id)}
        />
      );
    }

    if (route.name === 'protection' && selectedTracker) {
      return (
        <ProtectionScreen
          tracker={selectedTracker}
          features={premium.features[selectedTracker.id]}
          overview={premium.overviews[selectedTracker.id]}
          premiumLoading={premium.loadingIds.has(selectedTracker.id)}
          premiumError={premium.errors[selectedTracker.id]}
          ownerKey={userId ?? ''}
          apiConfig={PROVISIONING_API_CONFIG}
          getAccessToken={auth.getAccessToken}
          demoPreviewEnabled={demoPreviewActive && __DEV__}
          onBack={() => setRoute({ name: 'tracker', trackerId: selectedTracker.id })}
          onOpenSubscription={() => openCloudPlus(selectedTracker.id)}
          onRefreshPremium={() => premium.refreshDevice(selectedTracker.id)}
          onNotice={showNotice}
        />
      );
    }

    if (
      route.name === 'subscription' &&
      selectedTracker &&
      selectedBillingDeviceId &&
      selectedTracker.source !== 'local-preview'
    ) {
      return (
        <SubscriptionScreen
          tracker={selectedTracker}
          subscription={billing.subscriptions[selectedTracker.id]}
          loading={billing.loadingIds.has(selectedTracker.id)}
          error={billing.errors[selectedBillingDeviceId]}
          mode={billing.mode}
          purchasesEnabled={billing.purchasesEnabled}
          onBack={() => setRoute({ name: 'tracker', trackerId: selectedTracker.id })}
          onRetry={async () => {
            await Promise.all([
              billing.refreshDevice(selectedBillingDeviceId),
              premium.refreshDevice(selectedBillingDeviceId),
            ]);
          }}
          onCheckout={(planCode) => billing.startCheckout(selectedBillingDeviceId, planCode)}
          onPortal={(action) => billing.openPortal(selectedBillingDeviceId, action)}
          onNotice={showNotice}
        />
      );
    }

    if (route.name === 'interval' && selectedTracker) {
      return (
        <IntervalScreen
          tracker={selectedTracker}
          onBack={() => setRoute({ name: 'tracker', trackerId: selectedTracker.id })}
          onPressed={() => {
            setPairingContext({ kind: 'interval', trackerId: selectedTracker.id });
            setPairingPhase('searching');
          }}
        />
      );
    }

    if (route.name === 'firmware' && selectedTracker) {
      return (
        <FirmwareUpdateScreen
          tracker={selectedTracker}
          onBack={() => setRoute({ name: 'tracker', trackerId: selectedTracker.id })}
          onStartUpdate={() => {
            if (selectedTracker.source === 'demo' && demoPreviewActive && __DEV__) {
              setPairingContext({ kind: 'firmware', trackerId: selectedTracker.id });
              setPairingPhase('searching');
            } else {
              firmwareUpdate.start(selectedTracker);
            }
          }}
        />
      );
    }

    if (route.name === 'language') {
      return (
        <LanguageScreen
          onboarding={false}
          onBack={() => changeTab('settings')}
          onContinue={() => {
            changeTab('settings');
            showNotice(
              t('settings.languageMessage', {
                language: LANGUAGE_NATIVE_NAMES[language],
              }),
            );
          }}
        />
      );
    }

    if (route.name === 'account') {
      return (
        <AccountScreen
          accountName={accountName}
          email={auth.user?.email ?? null}
          busy={auth.busy !== null}
          onBack={() => setRoute({ name: 'main' })}
          onSaveName={async (name) => {
            const feedback = await auth.updateProfileName(name);
            presentAuthFeedback(feedback);
            return feedback.kind === 'success';
          }}
          onNotice={showNotice}
        />
      );
    }

    if (route.name === 'notifications') {
      return (
        <NotificationsScreen
          notifications={notificationInbox.notifications}
          loading={notificationInbox.loading}
          error={notificationInbox.error}
          onBack={() => setRoute({ name: 'main' })}
          onRetry={notificationInbox.refresh}
          onOpenSubscription={openSubscriptionFromNotification}
          onOpenTracker={openTrackerFromNotification}
          onMarkRead={notificationInbox.markRead}
        />
      );
    }

    if (route.name === 'info') {
      return (
        <InfoScreen
          topic={route.topic}
          onBack={() => changeTab('settings')}
          notificationDeliveryEnabled={notificationDeliveryEnabled}
          onNotificationDeliveryChange={updateNotificationDelivery}
        />
      );
    }

    if (activeTab === 'trackers') {
      return (
        <TrackersScreen
          trackers={displayTrackers}
          mainTrackerId={trackerPreferences.mainTrackerId}
          onAdd={openPairing}
          onOpenTracker={openTracker}
          onOpenSubscription={openCloudPlus}
          onSetMain={(trackerId) => {
            const tracker = displayTrackers.find((item) => item.id === trackerId);
            setTrackerPreferences((current) => ({ ...current, mainTrackerId: trackerId }));
            if (tracker) showNotice(t('trackers.mainSetNotice', { name: tracker.name }));
          }}
          onNotice={showNotice}
          subscriptions={billing.subscriptions}
          subscriptionLoadingIds={billing.loadingIds}
        />
      );
    }

    if (activeTab === 'settings') {
      return (
        <SettingsScreen
          accountName={accountName}
          accountEmail={auth.user?.email ?? null}
          unreadNotificationCount={notificationInbox.unreadCount}
          onOpenAccount={() => setRoute({ name: 'account' })}
          onOpenNotifications={() => setRoute({ name: 'notifications' })}
          onOpenInfo={(topic) => setRoute({ name: 'info', topic })}
          onOpenLanguage={() => setRoute({ name: 'language' })}
          onSignOut={signOut}
        />
      );
    }

    return (
      <HomeScreen
        trackers={displayTrackers}
        mainTracker={mainTracker}
        premiumFeatures={premium.features}
        onOpenTracker={openTracker}
        onAddTracker={openPairing}
        onOpenHistory={(trackerId) => {
          const access = premium.features[trackerId];
          if (!access?.subscriptionActive || access.locationHistoryDays < 1) {
            openCloudPlus(trackerId);
            return;
          }
          setActiveTab('map');
          setRoute({ name: 'map', historyTrackerId: trackerId });
        }}
        onOpenProtection={openProtection}
        onOpenCloudPlus={openCloudPlus}
        onOpenNotifications={() => setRoute({ name: 'notifications' })}
        unreadNotificationCount={notificationInbox.unreadCount}
        onNotice={showNotice}
      />
    );
  };

  if (!languageHydrated || !auth.ready || !trackerPreferencesHydrated) {
    return (
      <View style={styles.loading}>
        <Brand />
        <ActivityIndicator color={colors.blue} />
      </View>
    );
  }

  if (!languageChosen) {
    return (
      <LanguageScreen
        onboarding
        onContinue={() => {
          setLanguageChosen(true);
          setRoute({ name: 'main' });
        }}
      />
    );
  }

  if (authenticated && auth.passwordRecovery) {
    return (
      <View style={styles.app}>
        <PasswordResetScreen
          busy={auth.busy !== null}
          onSubmit={(password) => void auth.updatePassword(password).then(presentAuthFeedback)}
          onCancel={auth.cancelPasswordRecovery}
          onNotice={showNotice}
        />
        {notice ? <Toast message={notice} /> : null}
      </View>
    );
  }

  if (authenticated && trackerCatalog.status === 'loading') {
    return (
      <TrackerCloudStateScreen
        status="loading"
        error={null}
        onRetry={() => void trackerCatalog.refresh()}
        onSignOut={signOut}
      />
    );
  }

  if (authenticated && trackerCatalog.status === 'error') {
    return (
      <TrackerCloudStateScreen
        status="error"
        error={trackerCatalog.error}
        onRetry={() => void trackerCatalog.refresh()}
        onSignOut={signOut}
      />
    );
  }

  const showBottomNav =
    authenticated &&
    route.name !== 'interval' &&
    route.name !== 'firmware' &&
    route.name !== 'protection' &&
    route.name !== 'subscription' &&
    route.name !== 'info' &&
    route.name !== 'account' &&
    route.name !== 'notifications' &&
    route.name !== 'language';

  return (
    <View style={styles.app}>
      {authenticated ? (
        <>
          <View style={styles.screen}>{renderAuthenticatedScreen()}</View>
          {showBottomNav ? <BottomNav active={activeTab} onChange={changeTab} /> : null}
        </>
      ) : route.name === 'language' ? (
        <LanguageScreen
          onboarding={false}
          onBack={() => setRoute({ name: 'main' })}
          onContinue={() => {
            setRoute({ name: 'main' });
            showNotice(
              t('settings.languageMessage', {
                language: LANGUAGE_NATIVE_NAMES[language],
              }),
            );
          }}
        />
      ) : (
        <AuthScreen
          mode={authMode}
          onModeChange={setAuthMode}
          onEmailAuthenticate={(input: EmailAuthInput) => {
            void auth.signInWithEmail(input).then(presentAuthFeedback);
          }}
          onGoogleAuthenticate={() => {
            void auth.signInWithGoogle().then(presentAuthFeedback);
          }}
          onAppleAuthenticate={() => {
            void auth.signInWithApple().then(presentAuthFeedback);
          }}
          onForgotPassword={(email) => {
            void auth.requestPasswordReset(email).then(presentAuthFeedback);
          }}
          onNotice={showNotice}
          onChangeLanguage={() => setRoute({ name: 'language' })}
          configured={auth.configured}
          busy={auth.busy !== null}
          showDemoPreview={canUseDemoPreview(__DEV__)}
          onDemoPreview={() => {
            if (canUseDemoPreview(__DEV__)) {
              setDemoPreviewActive(true);
              setActiveTab('trackers');
              setRoute({ name: 'main' });
            }
          }}
        />
      )}

      <PairingModal
        phase={firmwareUpdate.state.phase !== 'idle' ? firmwareUpdate.state.phase : pairingPhase}
        operation={firmwareUpdate.state.phase !== 'idle' ? 'firmware' : pairingContext.kind}
        trackerName={
          firmwareUpdate.state.phase !== 'idle'
            ? displayTrackers.find((tracker) => tracker.id === firmwareUpdate.state.trackerId)?.name
            : pairingTracker?.name
        }
        trackerKind={
          firmwareUpdate.state.phase !== 'idle'
            ? displayTrackers.find((tracker) => tracker.id === firmwareUpdate.state.trackerId)?.kind
            : pairingTracker?.kind
        }
        progress={firmwareUpdate.state.progress}
        errorMessage={
          firmwareUpdate.state.error
            ? t(tagSetupErrorTranslationKey(firmwareUpdate.state.error))
            : undefined
        }
        onRetry={firmwareUpdate.state.phase === 'error' ? firmwareUpdate.retry : undefined}
        onCancel={
          firmwareUpdate.state.phase !== 'idle'
            ? firmwareUpdate.close
            : () => setPairingPhase('idle')
        }
      />
      <TagSetupModal
        state={tagSetup.state}
        onSelect={tagSetup.select}
        onChoosePlan={tagSetup.chooseProvisioningPlan}
        onRetry={tagSetup.retry}
        onClose={tagSetup.close}
      />
      <ConfirmRemoveModal
        visible={removeTrackerId !== null}
        trackerName={displayTrackers.find((tracker) => tracker.id === removeTrackerId)?.name ?? t('common.tracker')}
        onCancel={() => setRemoveTrackerId(null)}
        onConfirm={confirmRemove}
      />
      {notice ? <Toast message={notice} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.background },
  screen: { flex: 1 },
  loading: { flex: 1, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', gap: 28 },
});
