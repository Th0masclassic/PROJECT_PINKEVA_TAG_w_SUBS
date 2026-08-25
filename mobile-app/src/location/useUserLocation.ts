import * as Location from 'expo-location';
import { useEffect, useState } from 'react';

import type { GeographicCoordinate } from './nearestTracker';

function coordinateFromLocation(
  location: Location.LocationObject,
): GeographicCoordinate {
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
  };
}

export function useUserLocation(enabled: boolean): GeographicCoordinate | undefined {
  const [coordinate, setCoordinate] = useState<GeographicCoordinate>();

  useEffect(() => {
    if (!enabled) {
      setCoordinate(undefined);
      return undefined;
    }

    let active = true;
    void (async () => {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (!active || permission.status !== 'granted') return;

        const cached = await Location.getLastKnownPositionAsync({
          maxAge: 120_000,
          requiredAccuracy: 1_000,
        });
        if (active && cached) setCoordinate(coordinateFromLocation(cached));

        const current = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (active) setCoordinate(coordinateFromLocation(current));
      } catch {
        // The map still focuses the preferred tag when location is unavailable.
      }
    })();

    return () => {
      active = false;
    };
  }, [enabled]);

  return coordinate;
}
