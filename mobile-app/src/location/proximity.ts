import type { Tracker, TrackerKind } from '../model';

import { distanceInMeters, type GeographicCoordinate } from './nearestTracker.ts';

export const CARD_DISTANCE_THRESHOLD_METERS = 100;
export const CAR_DISTANCE_THRESHOLD_METERS = 1_000;

export function trackerDistanceThresholdMeters(kind: TrackerKind): number {
  return kind === 'car'
    ? CAR_DISTANCE_THRESHOLD_METERS
    : CARD_DISTANCE_THRESHOLD_METERS;
}

function hasValidCoordinate(value: GeographicCoordinate | undefined): value is GeographicCoordinate {
  return Boolean(
    value &&
      Number.isFinite(value.latitude) &&
      value.latitude >= -90 &&
      value.latitude <= 90 &&
      Number.isFinite(value.longitude) &&
      value.longitude >= -180 &&
      value.longitude <= 180,
  );
}

/**
 * Derives the Home status from the phone and the tracker's latest reported
 * coordinates. Undefined means there is not enough location data to replace
 * the backend status safely.
 */
export function trackerProximityStatus(
  tracker: Pick<Tracker, 'kind' | 'latitude' | 'longitude'>,
  userCoordinate: GeographicCoordinate | undefined,
): Tracker['status'] | undefined {
  if (
    !hasValidCoordinate(userCoordinate) ||
    !hasValidCoordinate(
      typeof tracker.latitude === 'number' && typeof tracker.longitude === 'number'
        ? { latitude: tracker.latitude, longitude: tracker.longitude }
        : undefined,
    )
  ) {
    return undefined;
  }

  const trackerCoordinate = {
    latitude: tracker.latitude,
    longitude: tracker.longitude,
  } as GeographicCoordinate;
  const distance = distanceInMeters(userCoordinate, trackerCoordinate);
  if (!Number.isFinite(distance)) return undefined;

  return distance > trackerDistanceThresholdMeters(tracker.kind) ? 'away' : 'nearby';
}
