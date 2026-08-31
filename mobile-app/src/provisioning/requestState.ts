import type { ProvisioningRequestStatus } from './api';

export type ProvisioningRequestAction = 'claim' | 'payment' | 'unavailable';

/**
 * The backend is the authority for the payment gate. A request marked paid or
 * claiming is already covered by the account's active subscription and can
 * resume secure Bluetooth provisioning without another checkout.
 */
export function provisioningRequestAction(
  status: ProvisioningRequestStatus,
): ProvisioningRequestAction {
  if (status === 'paid' || status === 'claiming') return 'claim';
  if (status === 'pending' || status === 'creating' || status === 'open') {
    return 'payment';
  }
  return 'unavailable';
}
