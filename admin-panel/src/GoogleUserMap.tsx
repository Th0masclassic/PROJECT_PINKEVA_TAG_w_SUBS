import { useEffect, useRef } from 'react';

import type { TrackerSummary } from './types';

declare global {
  interface Window { google?: any; }
}

let mapsPromise: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (window.google?.maps) return Promise.resolve();
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('maps'));
    document.head.appendChild(script);
  });
  return mapsPromise;
}

export function GoogleUserMap({
  trackers,
  apiKey,
  mapId,
}: {
  trackers: TrackerSummary[];
  apiKey: string;
  mapId?: string;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void loadGoogleMaps(apiKey).then(() => {
      if (!active || !container.current || !window.google?.maps) return;
      const located = trackers.filter(
        (tracker) => tracker.last_latitude !== null && tracker.last_longitude !== null,
      );
      const center = located.length
        ? { lat: located[0].last_latitude, lng: located[0].last_longitude }
        : { lat: 38.7223, lng: -9.1393 };
      const map = new window.google.maps.Map(container.current, {
        center,
        zoom: located.length ? 13 : 7,
        mapId,
        streetViewControl: false,
        fullscreenControl: true,
        mapTypeControl: true,
      });
      const bounds = new window.google.maps.LatLngBounds();
      located.forEach((tracker) => {
        const position = { lat: tracker.last_latitude, lng: tracker.last_longitude };
        new window.google.maps.Marker({ map, position, title: tracker.name ?? tracker.serial_number });
        bounds.extend(position);
      });
      if (located.length > 1) map.fitBounds(bounds, 64);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [apiKey, mapId, trackers]);

  return <div ref={container} className="user-map" aria-label="User tracker map" />;
}
