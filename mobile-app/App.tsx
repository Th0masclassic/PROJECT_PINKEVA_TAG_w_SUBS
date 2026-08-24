import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from './src/auth/AuthProvider';
import type { AuthFeedback, AuthMode, EmailAuthInput } from './src/auth/types';
import { getUserDisplayName, getUserFirstName } from './src/auth/userNames';
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
  applyTrackerIconOverrides,
  nextOperationPhase,
  reconcileTrackerPreferences,
  recordTrackerOpened,
  removeTracker,
  selectBillingDeviceIds,
  selectRecentTrackers,
  setTrackerIconOverride,
  updateTracker,
} from './src/model';
import {
  loadLanguagePreference,
  loadTrackerPreferences,
  saveLanguagePreference,
  saveTrackerPreferences,
} from './src/preferences';
import { AuthScreen } from './src/screens/AuthScreen';
import { ConfirmRemoveModal } from './src/screens/ConfirmRemoveModal';
import { FirmwareUpdateScreen } from './src/screens/FirmwareUpdateScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { InfoScreen } from './src/screens/InfoScreen';
import { IntervalScreen } from './src/screens/IntervalScreen';
import { LanguageScreen } from './src/screens/LanguageScreen';
import { MapScreen } from './src/screens/MapScreen';
import { PairingModal } from './src/screens/PairingModal';
import { PasswordResetScreen } from './src/screens/PasswordResetScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SubscriptionScreen } from './src/screens/SubscriptionScreen';
import { TrackerDetailScreen } from './src/screens/TrackerDetailScreen';
import { TrackersScreen } from './src/screens/TrackersScreen';
import { colors } from './src/theme';
import { TrackerCloudStateScreen } from './src/trackers/TrackerCloudStateScreen';
import { useOwnedTrackers } from './src/trackers/useOwnedTrackers';
import { PROVISIONING_API_CONFIG, type DeviceClaim } from './src/provisioning/api';
import { TagSetupModal } from './src/provisioning/TagSetupModal';
import { useTagSetup } from './src/provisioning/useTagSetup';

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
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousUserId = useRef<string | null | undefined>(undefined);
  const trackerCatalog = useOwnedTrackers(
    auth.user?.id ?? null,
    auth.session?.access_token ?? null,
    demoPreviewActive && __DEV__,
  );
  const { trackers, setTrackers } = trackerCatalog;

  const showNotice = useCallback((message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), 2400);
  }, []);

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
  const firstName = getUserFirstName(auth.user) ?? t('auth.accountFallbackName');

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
    setRemoveTrackerId(null);
  }, [auth.ready, tagSetup.close, userId]);

  useEffect(() => {
    if (auth.session) setDemoPreviewActive(false);
  }, [auth.session]);

  const displayTrackers = useMemo(
    () => applyTrackerIconOverrides(trackers, trackerPreferences.iconOverrides),
    [trackerPreferences.iconOverrides, trackers],
  );
  const billing = useTrackerBilling(
    selectBillingDeviceIds(displayTrackers, demoPreviewActive && __DEV__),
    auth.session?.access_token ?? null,
    demoPreviewActive && __DEV__,
  );
  const mainTracker = useMemo(
    () => displayTrackers.find((tracker) => tracker.id === trackerPreferences.mainTrackerId),
    [displayTrackers, trackerPreferences.mainTrackerId],
  );
  const recentTrackers = useMemo(
    () => selectRecentTrackers(displayTrackers, trackerPreferences.recentTrackerIds),
    [displayTrackers, trackerPreferences.recentTrackerIds],
  );
  const selectedTracker = useMemo(() => {
    if (
      route.name !== 'tracker' &&
      route.name !== 'subscription' &&
      route.name !== 'interval' &&
      route.name !== 'firmware'
    ) {
      return undefined;
    }
    return displayTrackers.find((tracker) => tracker.id === route.trackerId);
  }, [displayTrackers, route]);
  const pairingTracker = useMemo(() => {
    if (pairingContext.kind === 'add') return undefined;
    return displayTrackers.find((tracker) => tracker.id === pairingContext.trackerId);
  }, [displayTrackers, pairingContext]);

  useEffect(() => {
    const trackerScopedRoute =
      route.name === 'tracker' ||
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

  const back = useCallback(() => {
    if (tagSetup.state.phase !== 'idle') {
      tagSetup.close();
      return true;
    }
    if (pairingPhase !== 'idle') {
      setPairingPhase('idle');
      return true;
    }
    if (route.name === 'interval' || route.name === 'firmware' || route.name === 'subscription') {
      setRoute({ name: 'tracker', trackerId: route.trackerId });
      return true;
    }
    if (route.name !== 'main') {
      setRoute({ name: 'main' });
      return true;
    }
    return false;
  }, [pairingPhase, route, tagSetup.close, tagSetup.state.phase]);

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
    if (route.name === 'map') {
      return (
        <MapScreen
          trackers={displayTrackers}
          onOpenTracker={openTracker}
          onShowTrackers={() => changeTab('trackers')}
          onNotice={showNotice}
        />
      );
    }

    if (route.name === 'tracker' && selectedTracker) {
      return (
        <TrackerDetailScreen
          tracker={selectedTracker}
          onBack={() => changeTab('trackers')}
          onRename={(name) => {
            setTrackers((current) => updateTracker(current, selectedTracker.id, { name }));
            showNotice(t('tracker.nameUpdated'));
          }}
          onChangeIcon={(kind: TrackerKind) => {
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
          onOpenSubscription={() =>
            setRoute({ name: 'subscription', trackerId: selectedTracker.id })
          }
          onOpenInterval={() => setRoute({ name: 'interval', trackerId: selectedTracker.id })}
          onOpenFirmware={() => setRoute({ name: 'firmware', trackerId: selectedTracker.id })}
          onRemove={() => setRemoveTrackerId(selectedTracker.id)}
        />
      );
    }

    if (
      route.name === 'subscription' &&
      selectedTracker &&
      selectedTracker.source !== 'local-preview'
    ) {
      return (
        <SubscriptionScreen
          tracker={selectedTracker}
          subscription={billing.subscriptions[selectedTracker.id]}
          loading={billing.loadingIds.has(selectedTracker.id)}
          error={billing.errors[selectedTracker.id]}
          mode={billing.mode}
          purchasesEnabled={billing.purchasesEnabled}
          onBack={() => setRoute({ name: 'tracker', trackerId: selectedTracker.id })}
          onRetry={() => billing.refreshDevice(selectedTracker.id)}
          onCheckout={(planCode) => billing.startCheckout(selectedTracker.id, planCode)}
          onPortal={(action) => billing.openPortal(selectedTracker.id, action)}
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
            setPairingContext({ kind: 'firmware', trackerId: selectedTracker.id });
            setPairingPhase('searching');
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

    if (route.name === 'info') {
      return <InfoScreen topic={route.topic} onBack={() => changeTab('settings')} />;
    }

    if (activeTab === 'trackers') {
      return (
        <TrackersScreen
          trackers={displayTrackers}
          mainTrackerId={trackerPreferences.mainTrackerId}
          onAdd={openPairing}
          onOpenTracker={openTracker}
          onOpenSubscription={(trackerId) => {
            setActiveTab('trackers');
            setRoute({ name: 'subscription', trackerId });
          }}
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
          onOpenInfo={(topic) => setRoute({ name: 'info', topic })}
          onOpenLanguage={() => setRoute({ name: 'language' })}
          onSignOut={signOut}
        />
      );
    }

    return (
      <HomeScreen
        displayName={firstName}
        mainTracker={mainTracker}
        recentTrackers={recentTrackers}
        onOpenMap={() => setRoute({ name: 'map' })}
        onOpenTracker={openTracker}
        onShowTrackers={() => changeTab('trackers')}
        onAddTracker={openPairing}
        onToggleLost={(trackerId) => {
          const tracker = trackers.find((item) => item.id === trackerId);
          setTrackers((current) => updateTracker(current, trackerId, { isLost: !tracker?.isLost }));
          showNotice(tracker?.isLost ? t('notice.lostDisabled') : t('notice.markedLost'));
        }}
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
    route.name !== 'subscription' &&
    route.name !== 'info' &&
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
        phase={pairingPhase}
        operation={pairingContext.kind}
        trackerName={pairingTracker?.name}
        trackerKind={pairingTracker?.kind}
        onCancel={() => setPairingPhase('idle')}
      />
      <TagSetupModal
        state={tagSetup.state}
        onSelect={tagSetup.select}
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
