import type { Language, Translate } from '../i18n';
import type { Tracker } from '../model';
import type { DeviceSafeZone } from '../premium/api';
import { distanceInMeters, type GeographicCoordinate } from './nearestTracker.ts';

type LocationCopy = {
  metersAway: string;
  kilometersAway: string;
  insideZone: string;
  availableOnMap: string;
  unavailable: string;
  updated: string;
  lastSeen: string;
};

const copy: Record<Language, LocationCopy> = {
  en: { metersAway: '{{value}} m away', kilometersAway: '{{value}} km away', insideZone: 'Inside {{name}}', availableOnMap: 'Location available on map', unavailable: 'Location unavailable', updated: 'Updated {{time}}', lastSeen: 'Last seen {{time}}' },
  pt: { metersAway: '{{value}} m de distância', kilometersAway: '{{value}} km de distância', insideZone: 'Dentro de {{name}}', availableOnMap: 'Localização disponível no mapa', unavailable: 'Localização indisponível', updated: 'Atualizado {{time}}', lastSeen: 'Visto pela última vez {{time}}' },
  fr: { metersAway: 'À {{value}} m', kilometersAway: 'À {{value}} km', insideZone: 'Dans {{name}}', availableOnMap: 'Localisation disponible sur la carte', unavailable: 'Localisation indisponible', updated: 'Mis à jour {{time}}', lastSeen: 'Vu pour la dernière fois {{time}}' },
  de: { metersAway: '{{value}} m entfernt', kilometersAway: '{{value}} km entfernt', insideZone: 'In {{name}}', availableOnMap: 'Standort auf der Karte verfügbar', unavailable: 'Standort nicht verfügbar', updated: 'Aktualisiert {{time}}', lastSeen: 'Zuletzt gesehen {{time}}' },
  zh: { metersAway: '距离 {{value}} 米', kilometersAway: '距离 {{value}} 公里', insideZone: '位于{{name}}内', availableOnMap: '可在地图上查看位置', unavailable: '位置不可用', updated: '更新于{{time}}', lastSeen: '最后出现于{{time}}' },
  it: { metersAway: 'A {{value}} m di distanza', kilometersAway: 'A {{value}} km di distanza', insideZone: 'Dentro {{name}}', availableOnMap: 'Posizione disponibile sulla mappa', unavailable: 'Posizione non disponibile', updated: 'Aggiornato {{time}}', lastSeen: 'Visto l’ultima volta {{time}}' },
  es: { metersAway: 'A {{value}} m de distancia', kilometersAway: 'A {{value}} km de distancia', insideZone: 'Dentro de {{name}}', availableOnMap: 'Ubicación disponible en el mapa', unavailable: 'Ubicación no disponible', updated: 'Actualizado {{time}}', lastSeen: 'Visto por última vez {{time}}' },
};

const locales: Record<Language, string> = {
  en: 'en-US', pt: 'pt-PT', fr: 'fr-FR', de: 'de-DE', zh: 'zh-CN', it: 'it-IT', es: 'es-ES',
};

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}

export function isCoordinateLikeLabel(value: string | undefined): boolean {
  if (!value) return false;
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*[,;]\s*([+-]?\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return false;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function compactLocationLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized === '—' || isCoordinateLikeLabel(normalized)) return undefined;
  const parts = normalized.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.slice(0, 2).join(', ') || undefined;
}

export function trackerLocationLabel(tracker: Pick<Tracker, 'address' | 'place'>): string | undefined {
  return compactLocationLabel(tracker.address) ?? compactLocationLabel(tracker.place);
}

export function formatDistanceAway(distanceMeters: number, language: Language): string | undefined {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return undefined;
  const roundedMeters = Math.round(distanceMeters);
  const number = roundedMeters < 1_000 ? roundedMeters : Math.round(distanceMeters / 100) / 10;
  const value = new Intl.NumberFormat(locales[language], {
    maximumFractionDigits: roundedMeters < 1_000 ? 0 : 1,
  }).format(number);
  return interpolate(
    roundedMeters < 1_000 ? copy[language].metersAway : copy[language].kilometersAway,
    { value },
  );
}

function currentInsideZone(
  tracker: Pick<Tracker, 'lastLocationAt'>,
  zones: readonly DeviceSafeZone[],
): DeviceSafeZone | undefined {
  const trackerAt = tracker.lastLocationAt ? Date.parse(tracker.lastLocationAt) : Number.NaN;
  return [...zones]
    .filter((zone) => {
      if (!zone.enabled || zone.lastTrackerInside !== true) return false;
      if (!Number.isFinite(trackerAt) || !zone.lastEvaluatedAt) return false;
      const evaluatedAt = Date.parse(zone.lastEvaluatedAt);
      return Number.isFinite(evaluatedAt) && evaluatedAt >= trackerAt - 1_000;
    })
    .sort((left, right) => left.radiusMeters - right.radiusMeters || left.name.localeCompare(right.name))[0];
}

function relativeLocationTime(
  tracker: Pick<Tracker, 'lastLocationAt' | 'lastSeen'>,
  language: Language,
  t: Translate,
  now: number,
): string | undefined {
  const timestamp = tracker.lastLocationAt ? Date.parse(tracker.lastLocationAt) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    if (!tracker.lastSeen || tracker.lastSeen === '—') return undefined;
    if (tracker.lastSeen === 'Just now') return t('time.justNow');
    const minutes = /^(\d+)\s*min/.exec(tracker.lastSeen)?.[1];
    if (minutes) return t('time.minutesAgo', { count: Number(minutes) });
    const hours = /^(\d+)\s*h/.exec(tracker.lastSeen)?.[1];
    if (hours) return t('time.hoursAgo', { count: Number(hours) });
    return tracker.lastSeen;
  }
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  if (minutes < 24 * 60) return t('time.hoursAgo', { count: Math.floor(minutes / 60) });
  return new Intl.DateTimeFormat(locales[language], { day: 'numeric', month: 'short' })
    .format(new Date(timestamp));
}

export type TrackerLocationPresentation = {
  primary: string;
  secondary?: string;
  freshness?: string;
  safeZoneName?: string;
  distanceMeters?: number;
};

export function createTrackerLocationPresentation({
  tracker,
  language,
  t,
  userCoordinate,
  resolvedAddress,
  safeZones = [],
  now = Date.now(),
}: {
  tracker: Tracker;
  language: Language;
  t: Translate;
  userCoordinate?: GeographicCoordinate;
  resolvedAddress?: string;
  safeZones?: readonly DeviceSafeZone[];
  now?: number;
}): TrackerLocationPresentation {
  const hasCoordinate =
    typeof tracker.latitude === 'number' && Number.isFinite(tracker.latitude) &&
    typeof tracker.longitude === 'number' && Number.isFinite(tracker.longitude);
  const distanceMeters = hasCoordinate && userCoordinate
    ? distanceInMeters(userCoordinate, { latitude: tracker.latitude!, longitude: tracker.longitude! })
    : undefined;
  const distance = distanceMeters === undefined
    ? undefined
    : formatDistanceAway(distanceMeters, language);
  const address = compactLocationLabel(resolvedAddress) ?? trackerLocationLabel(tracker);
  const zone = currentInsideZone(tracker, safeZones);
  const relativeTime = relativeLocationTime(tracker, language, t, now);
  const freshness = relativeTime
    ? interpolate(tracker.locationStale ? copy[language].lastSeen : copy[language].updated, { time: relativeTime })
    : undefined;

  if (zone) {
    return {
      primary: interpolate(copy[language].insideZone, { name: zone.name }),
      ...(distance ? { secondary: distance, distanceMeters } : {}),
      ...(freshness ? { freshness } : {}),
      safeZoneName: zone.name,
    };
  }
  if (distance) {
    return {
      primary: distance,
      secondary: address ?? copy[language].availableOnMap,
      ...(freshness ? { freshness } : {}),
      distanceMeters,
    };
  }
  return {
    primary: address ?? (hasCoordinate ? copy[language].availableOnMap : copy[language].unavailable),
    ...(freshness ? { freshness } : {}),
  };
}
