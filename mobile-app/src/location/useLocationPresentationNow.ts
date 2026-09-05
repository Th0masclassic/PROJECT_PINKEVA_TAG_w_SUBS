import { useEffect, useState } from 'react';

const TICK_MS = 60_000;

export function useLocationPresentationNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return now;
}
