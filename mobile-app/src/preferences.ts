import AsyncStorage from '@react-native-async-storage/async-storage';

import { isLanguage, type Language } from './i18n';
import {
  EMPTY_TRACKER_PREFERENCES,
  parseTrackerPreferences,
  type TrackerPreferences,
} from './model';

const LEGACY_PREFERENCES_KEY = 'pinkeva.preferences.v1';
const LANGUAGE_PREFERENCES_KEY = 'pinkeva.language.preferences.v2';
const TRACKER_PREFERENCES_PREFIX = 'pinkeva.tracker.preferences.v2';
const NOTIFICATION_PREFERENCES_PREFIX = 'pinkeva.notification.preferences.v1';

export type AppPreferences = TrackerPreferences & {
  language: Language | null;
};

export const EMPTY_APP_PREFERENCES: AppPreferences = {
  ...EMPTY_TRACKER_PREFERENCES,
  language: null,
};

export function parseAppPreferences(raw: string | null): AppPreferences {
  if (!raw) return EMPTY_APP_PREFERENCES;

  try {
    const value = JSON.parse(raw) as unknown;
    const trackerPreferences = parseTrackerPreferences(value);
    const language =
      value && typeof value === 'object' && 'language' in value &&
      isLanguage((value as { language?: unknown }).language)
        ? (value as { language: Language }).language
        : null;

    return { ...trackerPreferences, language };
  } catch {
    return EMPTY_APP_PREFERENCES;
  }
}

export function trackerPreferencesKey(userId: string): string {
  return `${TRACKER_PREFERENCES_PREFIX}:${userId}`;
}

export async function loadLanguagePreference(): Promise<Language | null> {
  try {
    const current = await AsyncStorage.getItem(LANGUAGE_PREFERENCES_KEY);
    if (isLanguage(current)) return current;

    // Preserve only the device language from the old global preference record. Tracker choices
    // are deliberately not migrated because they must never be assigned to an arbitrary account.
    const legacy = parseAppPreferences(await AsyncStorage.getItem(LEGACY_PREFERENCES_KEY));
    return legacy.language;
  } catch {
    return null;
  }
}

export async function saveLanguagePreference(language: Language | null): Promise<void> {
  if (language) await AsyncStorage.setItem(LANGUAGE_PREFERENCES_KEY, language);
  else await AsyncStorage.removeItem(LANGUAGE_PREFERENCES_KEY);
}

export async function loadTrackerPreferences(
  userId: string | null,
): Promise<TrackerPreferences> {
  if (!userId) return EMPTY_TRACKER_PREFERENCES;
  try {
    return parseTrackerPreferences(await AsyncStorage.getItem(trackerPreferencesKey(userId)));
  } catch {
    return EMPTY_TRACKER_PREFERENCES;
  }
}

export async function saveTrackerPreferences(
  userId: string,
  preferences: TrackerPreferences,
): Promise<void> {
  await AsyncStorage.setItem(trackerPreferencesKey(userId), JSON.stringify(preferences));
}

export async function loadNotificationPreference(userId: string | null): Promise<boolean> {
  if (!userId) return true;
  try {
    return (await AsyncStorage.getItem(`${NOTIFICATION_PREFERENCES_PREFIX}:${userId}`)) !== 'off';
  } catch {
    return true;
  }
}

export async function saveNotificationPreference(userId: string, enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(
    `${NOTIFICATION_PREFERENCES_PREFIX}:${userId}`,
    enabled ? 'on' : 'off',
  );
}
