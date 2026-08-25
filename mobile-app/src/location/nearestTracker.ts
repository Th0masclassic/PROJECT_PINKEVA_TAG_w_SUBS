import type { Tracker } from '../model';

export type GeographicCoordinate = {
  latitude: number;
  longitude: number;
};

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
