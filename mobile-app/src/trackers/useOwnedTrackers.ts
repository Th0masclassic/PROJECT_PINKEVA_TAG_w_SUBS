import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { AppState } from 'react-native';

import { supabase } from '../auth/supabase';
import { DEMO_TRACKERS, type Tracker } from '../model';
import {
  PinqevaProvisioningClient,
  type ProvisioningApiConfig,
} from '../provisioning/api';
import {
  OwnedTrackerError,
  fetchOwnedTrackers,
  type OwnedTrackerErrorCode,
} from './cloud';

export type OwnedTrackerCatalog = {
  trackers: Tracker[];
  status: 'loading' | 'ready' | 'error';
  error: OwnedTrackerErrorCode | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
  setTrackers: Dispatch<SetStateAction<Tracker[]>>;
};

type CatalogState = {
  ownerKey: string;
  trackers: Tracker[];
  status: OwnedTrackerCatalog['status'];
  error: OwnedTrackerErrorCode | null;
  refreshing: boolean;
};

function safeErrorCode(error: unknown): OwnedTrackerErrorCode {
  return error instanceof OwnedTrackerError ? error.code : 'unavailable';
}

export function useOwnedTrackers(
  userId: string | null,
  accessToken: string | null,
  demoPreviewEnabled: boolean,
  apiConfig: ProvisioningApiConfig | null,
  getAccessToken: () => Promise<string | null>,
): OwnedTrackerCatalog {
  const mode = demoPreviewEnabled
    ? 'demo'
    : userId && accessToken
      ? supabase
        ? 'live'
        : 'configuration'
      : 'anonymous';
  const ownerKey = mode === 'live' || mode === 'configuration'
    ? `account:${userId ?? ''}`
    : mode;
  const requestKey = `${mode}\u001f${userId ?? ''}\u001f${accessToken ?? ''}\u001f${apiConfig?.baseUrl ?? ''}`;
  const currentRequestKey = useRef(requestKey);
  currentRequestKey.current = requestKey;
  const requestSequence = useRef(0);
  const [state, setState] = useState<CatalogState>({
    ownerKey: 'initial',
    trackers: [],
    status: 'loading',
    error: null,
    refreshing: false,
  });

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const expectedRequestKey = requestKey;

    if (mode === 'demo') {
      setState({
        ownerKey,
        trackers: DEMO_TRACKERS,
        status: 'ready',
        error: null,
        refreshing: false,
      });
      return;
    }

    if (mode === 'anonymous') {
      setState({
        ownerKey,
        trackers: [],
        status: 'ready',
        error: null,
        refreshing: false,
      });
      return;
    }

    if (mode === 'configuration' || !supabase || !userId) {
      setState({
        ownerKey,
        trackers: [],
        status: 'error',
        error: 'configuration',
        refreshing: false,
      });
      return;
    }

    setState((current) =>
      current.ownerKey === ownerKey && current.status === 'ready'
        ? { ...current, error: null, refreshing: true }
        : {
            ownerKey,
            trackers: [],
            status: 'loading',
            error: null,
            refreshing: false,
          },
    );

    try {
      let hostedTrackers = await fetchOwnedTrackers(supabase, userId);
      if (apiConfig) {
        const backend = new PinqevaProvisioningClient(apiConfig, async () => {
          const token = await getAccessToken();
          if (!token) throw new Error('Session unavailable');
          return token;
        });
        hostedTrackers = await Promise.all(
          hostedTrackers.map(async (tracker) => {
            try {
              const release = await backend.getFirmwareAvailability(tracker.id);
              if (release.device_id !== tracker.id) return tracker;
              return {
                ...tracker,
                firmwareVersion: release.current_version ?? tracker.firmwareVersion,
                firmwareUpdateVersion:
                  release.update_available && release.latest_version
                    ? release.latest_version
                    : undefined,
              };
            } catch {
              // Tracker loading must remain usable if the separately deployed
              // release API is temporarily unavailable.
              return tracker;
            }
          }),
        );
      }
      if (
        currentRequestKey.current !== expectedRequestKey ||
        requestSequence.current !== sequence
      ) return;

      setState((current) => {
        const localPreviews = current.ownerKey === ownerKey
          ? current.trackers.filter((tracker) => tracker.source === 'local-preview')
          : [];
        return {
          ownerKey,
          trackers: [...hostedTrackers, ...localPreviews],
          status: 'ready',
          error: null,
          refreshing: false,
        };
      });
    } catch (error) {
      if (
        currentRequestKey.current !== expectedRequestKey ||
        requestSequence.current !== sequence
      ) return;
      setState({
        ownerKey,
        trackers: [],
        status: 'error',
        error: safeErrorCode(error),
        refreshing: false,
      });
    }
  }, [apiConfig, getAccessToken, mode, ownerKey, requestKey, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (mode !== 'live') return undefined;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [mode, refresh]);

  const updateTrackers = useCallback<Dispatch<SetStateAction<Tracker[]>>>(
    (action) => {
      setState((current) => {
        if (current.ownerKey !== ownerKey || current.status !== 'ready') return current;
        const trackers = typeof action === 'function' ? action(current.trackers) : action;
        return { ...current, trackers };
      });
    },
    [ownerKey],
  );

  return useMemo(() => {
    if (state.ownerKey === ownerKey) {
      return {
        trackers: state.trackers,
        status: state.status,
        error: state.error,
        refreshing: state.refreshing,
        refresh,
        setTrackers: updateTrackers,
      };
    }

    return {
      trackers: [],
      status: mode === 'anonymous' ? 'ready' : 'loading',
      error: null,
      refreshing: false,
      refresh,
      setTrackers: updateTrackers,
    };
  }, [mode, ownerKey, refresh, state, updateTrackers]);
}
