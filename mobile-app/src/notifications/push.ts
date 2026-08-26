import type { ProvisioningApiConfig } from '../provisioning/api';

export function useRenewalPushRegistration(_input: {
  enabled: boolean;
  userId: string | null;
  apiConfig: ProvisioningApiConfig | null;
  getAccessToken: () => Promise<string | null>;
  onOpenSubscription?: (deviceId: string) => void;
}): void {
  // Push registration is intentionally native-only. The web build still uses
  // the same backend notification inbox without requesting browser push.
}
