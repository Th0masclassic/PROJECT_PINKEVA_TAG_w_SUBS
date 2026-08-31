import type { Tracker } from '../model';

export type GeographicCoordinate = {
  latitude: number;
  longitude: number;
};

const EARTH_RADIUS_METERS = 6_371_000;

function isLocatedTracker(
  tracker: Tracker,
): tracker is Tracker & GeographicCoordinate {
  return (
    typeof tracker.latitude === 'number' &&
    Number.isFinite(tracker.latitude) &&
    typeof tracker.longitude === 'number' &&
    Number.isFinite(tracker.longitude)
  );
}

function angularDistance(
  origin: GeographicCoordinate,
  destination: GeographicCoordinate,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const originLatitude = toRadians(origin.latitude);
  const destinationLatitude = toRadians(destination.latitude);
  const latitudeDelta = destinationLatitude - originLatitude;
  const longitudeDelta = toRadians(destination.longitude - origin.longitude);
  const halfLatitude = Math.sin(latitudeDelta / 2);
  const halfLongitude = Math.sin(longitudeDelta / 2);

  return (
    halfLatitude * halfLatitude +
    Math.cos(originLatitude) *
      Math.cos(destinationLatitude) *
      halfLongitude *
      halfLongitude
  );
}

/**
 * Returns the great-circle distance between two geographic coordinates.
 *
 * The location reported by a tracker is a last-known point, so callers can
 * decide how to handle a stale or missing point separately from this pure
 * calculation.
 */
export function distanceInMeters(
  origin: GeographicCoordinate,
  destination: GeographicCoordinate,
): number {
  // Floating point rounding can produce a value just outside [0, 1] for very
  // small or antipodal distances. Clamp before asin so valid coordinates
  // always produce a finite result.
  const haversine = Math.min(1, Math.max(0, angularDistance(origin, destination)));
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

export function selectClosestLocatedTracker(
  trackers: readonly Tracker[],
  userCoordinate: GeographicCoordinate | undefined,
  preferredTrackerId?: string,
): Tracker | undefined {
  const located = trackers.filter(isLocatedTracker);
  if (!located.length) return undefined;

  if (!userCoordinate) {
    return located.find((tracker) => tracker.id === preferredTrackerId) ?? located[0];
  }

  return located.reduce((closest, tracker) =>
    angularDistance(userCoordinate, tracker) < angularDistance(userCoordinate, closest)
      ? tracker
      : closest,
  );
}
