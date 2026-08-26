export type MainTab = 'home' | 'trackers' | 'subscriptions' | 'settings';

export type PairingPhase = 'idle' | 'searching' | 'connecting' | 'installing' | 'success';

export type ConnectionOperation = 'add' | 'interval' | 'firmware';

export type TrackerKind = 'card' | 'keys' | 'backpack' | 'car';

export type TrackerSource = 'demo' | 'hosted' | 'local-preview';

export type TrackerIconOverride = Exclude<TrackerKind, 'card'>;

export type Tracker = {
  id: string;
  serialNumber?: string;
  source: TrackerSource;
  name: string;
  kind: TrackerKind;
  status: 'nearby' | 'away';
  lastSeen: string;
  place: string;
  address: string;
  intervalMs: number;
  isLost: boolean;
  firmwareVersion: string;
  firmwareUpdateVersion?: string;
  latitude?: number;
  longitude?: number;
  lastLocationAt?: string;
};

export type InfoTopic =
  | 'account'
  | 'notifications'
  | 'privacy'
  | 'permissions'
  | 'support'
  | 'about'
  | 'firmware';

export type AppRoute =
  | { name: 'main' }
  | { name: 'map' }
  | { name: 'tracker'; trackerId: string }
  | { name: 'subscription'; trackerId: string }
  | { name: 'interval'; trackerId: string }
  | { name: 'firmware'; trackerId: string }
  | { name: 'language' }
  | { name: 'account' }
  | { name: 'notifications' }
  | { name: 'info'; topic: InfoTopic };

export type TrackerPreferences = {
  version: 1;
  recentTrackerIds: string[];
  mainTrackerId: string | null;
  iconOverrides: Record<string, TrackerIconOverride>;
};

export const EMPTY_TRACKER_PREFERENCES: TrackerPreferences = {
  version: 1,
  recentTrackerIds: [],
  mainTrackerId: null,
  iconOverrides: {},
};

export const CARD_TRACKER: Tracker = {
  id: 'pinkeva-card',
  source: 'demo',
  name: 'Pinkeva Card',
  kind: 'card',
  status: 'nearby',
  lastSeen: 'Just now',
  place: 'Wallet',
  address: '123 Pinkeva Lane, San Francisco, CA',
  intervalMs: 1000,
  isLost: false,
  firmwareVersion: '1.0.4',
  firmwareUpdateVersion: '1.1.0',
  latitude: 37.7749,
  longitude: -122.4194,
};

export const DEMO_TRACKERS: Tracker[] = [
  CARD_TRACKER,
  {
    id: 'keys',
    source: 'demo',
    name: 'Keys',
    kind: 'card',
    status: 'away',
    lastSeen: '15 min ago',
    place: '451 Market St',
    address: '451 Market St, San Francisco, CA',
    intervalMs: 1000,
    isLost: false,
    firmwareVersion: '1.1.0',
    latitude: 37.7936,
    longitude: -122.3965,
  },
  {
    id: 'backpack',
    source: 'demo',
    name: 'Backpack',
    kind: 'card',
    status: 'away',
    lastSeen: '1 h ago',
    place: '888 Mission St',
    address: '888 Mission St, San Francisco, CA',
    intervalMs: 1000,
    isLost: false,
    firmwareVersion: '1.1.0',
    latitude: 37.7786,
    longitude: -122.4147,
  },
];

export function nextPairingPhase(phase: PairingPhase): PairingPhase {
  if (phase === 'searching') return 'connecting';
  if (phase === 'connecting') return 'success';
  if (phase === 'installing') return 'success';
  return 'idle';
}

export function nextOperationPhase(
  phase: PairingPhase,
  operation: ConnectionOperation,
): PairingPhase {
  if (operation === 'firmware' && phase === 'connecting') return 'installing';
  return nextPairingPhase(phase);
}

export function addCanonicalCard(trackers: Tracker[]): Tracker[] {
  const usedIds = new Set(trackers.map((tracker) => tracker.id));
  if (!usedIds.has(CARD_TRACKER.id)) {
    return [
      {
        ...CARD_TRACKER,
        source: 'local-preview',
        place: 'New tracker',
        firmwareUpdateVersion: undefined,
      },
      ...trackers,
    ];
  }

  let sequence = 2;
  while (usedIds.has(`pinkeva-card-${sequence}`)) sequence += 1;
  return [
    {
      ...CARD_TRACKER,
      id: `pinkeva-card-${sequence}`,
      source: 'local-preview',
      name: `Pinkeva Card ${sequence}`,
      place: 'New tracker',
      firmwareUpdateVersion: undefined,
    },
    ...trackers,
  ];
}

export function removeTracker(trackers: Tracker[], trackerId: string): Tracker[] {
  return trackers.filter((tracker) => tracker.id !== trackerId);
}

export function updateTracker(
  trackers: Tracker[],
  trackerId: string,
  patch: Partial<Tracker>,
): Tracker[] {
  return trackers.map((tracker) =>
    tracker.id === trackerId ? { ...tracker, ...patch } : tracker,
  );
}

export function formatInterval(intervalMs: number): string {
  if (intervalMs >= 1000 && intervalMs % 1000 === 0) {
    return `${intervalMs / 1000}s`;
  }
  return `${intervalMs} ms`;
}

export function recordTrackerOpened(
  recentTrackerIds: string[],
  trackerId: string,
  limit = 2,
): string[] {
  if (limit <= 0) return [];
  return [trackerId, ...recentTrackerIds.filter((id) => id !== trackerId)].slice(0, limit);
}

export function selectRecentTrackers(
  trackers: Tracker[],
  recentTrackerIds: string[],
  limit = 2,
): Tracker[] {
  const byId = new Map(trackers.map((tracker) => [tracker.id, tracker]));
  const seen = new Set<string>();
  const recent: Tracker[] = [];

  for (const id of recentTrackerIds) {
    if (seen.has(id)) continue;
    const tracker = byId.get(id);
    if (!tracker) continue;
    seen.add(id);
    recent.push(tracker);
    if (recent.length === limit) break;
  }

  return recent;
}

export function selectBillingDeviceIds(
  trackers: readonly Tracker[],
  demoPreviewEnabled: boolean,
): string[] {
  return trackers
    .filter(
      (tracker) =>
        tracker.source === 'hosted' ||
        (demoPreviewEnabled && tracker.source === 'demo'),
    )
    .map((tracker) => tracker.id);
}

export function chooseMainTrackerId(
  trackers: Tracker[],
  preferredId: string | null,
  random: () => number = Math.random,
): string | null {
  if (preferredId && trackers.some((tracker) => tracker.id === preferredId)) {
    return preferredId;
  }
  if (trackers.length === 0) return null;

  const sample = Math.max(0, Math.min(0.999999999, random()));
  return trackers[Math.floor(sample * trackers.length)]?.id ?? trackers[0]?.id ?? null;
}

export function resolveTrackerIcon(
  trackerId: string,
  iconOverrides: Record<string, TrackerIconOverride>,
): TrackerKind {
  return iconOverrides[trackerId] ?? 'card';
}

export function setTrackerIconOverride(
  iconOverrides: Record<string, TrackerIconOverride>,
  trackerId: string,
  icon: TrackerKind,
): Record<string, TrackerIconOverride> {
  const next = { ...iconOverrides };
  if (icon === 'card') delete next[trackerId];
  else next[trackerId] = icon;
  return next;
}

export function applyTrackerIconOverrides(
  trackers: Tracker[],
  iconOverrides: Record<string, TrackerIconOverride>,
): Tracker[] {
  return trackers.map((tracker) => ({
    ...tracker,
    kind: resolveTrackerIcon(tracker.id, iconOverrides),
  }));
}

export function reconcileTrackerPreferences(
  trackers: Tracker[],
  preferences: TrackerPreferences,
  random: () => number = Math.random,
): TrackerPreferences {
  const validIds = new Set(trackers.map((tracker) => tracker.id));
  const iconOverrides = Object.fromEntries(
    Object.entries(preferences.iconOverrides).filter(([id]) => validIds.has(id)),
  ) as Record<string, TrackerIconOverride>;

  return {
    version: 1,
    recentTrackerIds: selectRecentTrackers(
      trackers,
      preferences.recentTrackerIds,
      2,
    ).map((tracker) => tracker.id),
    mainTrackerId: chooseMainTrackerId(trackers, preferences.mainTrackerId, random),
    iconOverrides,
  };
}

export function parseTrackerPreferences(raw: unknown): TrackerPreferences {
  if (!raw || typeof raw !== 'object') return EMPTY_TRACKER_PREFERENCES;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return EMPTY_TRACKER_PREFERENCES;

  const recentTrackerIds = Array.isArray(value.recentTrackerIds)
    ? value.recentTrackerIds.filter((id): id is string => typeof id === 'string').slice(0, 2)
    : [];
  const mainTrackerId = typeof value.mainTrackerId === 'string' ? value.mainTrackerId : null;
  const iconOverrides: Record<string, TrackerIconOverride> = {};

  if (value.iconOverrides && typeof value.iconOverrides === 'object') {
    for (const [id, icon] of Object.entries(value.iconOverrides as Record<string, unknown>)) {
      if (icon === 'keys' || icon === 'backpack' || icon === 'car') {
        iconOverrides[id] = icon;
      }
    }
  }

  return { version: 1, recentTrackerIds, mainTrackerId, iconOverrides };
}
