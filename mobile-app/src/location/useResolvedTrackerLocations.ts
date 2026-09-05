import * as Location from 'expo-location';
import { useEffect, useMemo, useState } from 'react';

import type { Tracker } from '../model';
import { trackerLocationLabel } from './presentation';

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
const FAILURE_TTL_MS = 5 * 60 * 1_000;
const MAX_CACHE_ENTRIES = 200;

type CacheEntry = { expiresAt: number; value: string | undefined; promise?: Promise<string | undefined> };
const cache = new Map<string, CacheEntry>();

export function reverseGeocodeCacheKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
}

export function formatGeocodedAddress(address: Location.LocationGeocodedAddress | undefined): string | undefined {
  if (!address) return undefined;
  const street = address.street?.trim() || address.name?.trim() || address.district?.trim() || address.subregion?.trim();
  const city = address.city?.trim() || address.subregion?.trim() || address.region?.trim();
  return [street, city]
    .filter((part, index, parts): part is string => Boolean(part) && parts.findIndex((candidate) => candidate?.toLocaleLowerCase() === part?.toLocaleLowerCase()) === index)
    .slice(0, 2)
    .join(', ') || undefined;
}

async function resolveAddress(latitude: number, longitude: number): Promise<string | undefined> {
  const key = reverseGeocodeCacheKey(latitude, longitude);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.promise ?? existing.value;
  }
  const promise = Location.reverseGeocodeAsync({ latitude, longitude })
    .then((results) => formatGeocodedAddress(results[0]))
    .catch(() => undefined)
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + (value ? SUCCESS_TTL_MS : FAILURE_TTL_MS) });
      return value;
    });
  cache.set(key, { value: undefined, promise, expiresAt: Date.now() + FAILURE_TTL_MS });
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return promise;
}

export function useResolvedTrackerLocations(trackers: readonly Tracker[]): Record<string, string | undefined> {
  const targetKey = trackers.map((tracker) => [
    tracker.id,
    tracker.latitude?.toFixed(4) ?? '',
    tracker.longitude?.toFixed(4) ?? '',
    trackerLocationLabel(tracker) ?? '',
  ].join(':')).join('|');
  const targets = useMemo(() => trackers.filter((tracker) =>
    !trackerLocationLabel(tracker) &&
    typeof tracker.latitude === 'number' && Number.isFinite(tracker.latitude) &&
    typeof tracker.longitude === 'number' && Number.isFinite(tracker.longitude),
  ), [targetKey]);
  const [locations, setLocations] = useState<Record<string, string | undefined>>({});

  useEffect(() => {
    let active = true;
    void Promise.all(targets.map(async (tracker) => [
      tracker.id,
      await resolveAddress(tracker.latitude!, tracker.longitude!),
    ] as const)).then((entries) => {
      if (active) setLocations(Object.fromEntries(entries));
    });
    return () => { active = false; };
  }, [targetKey]);

  return locations;
}
