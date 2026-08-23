# App-to-Tag provisioning bridge

`TagProvisioner` is the protocol-v1.2 React Native service layer. The UI supplies the selected BLE peripheral, a Supabase access-token callback, and a stable idempotency key. No QR scan or user-entered setup secret is required.

The flow is deliberately ordered:

1. Connect and discover the exact 128-bit provisioning service.
2. Read protocol information, the factory-derived `PKV-` identifier, a fresh 32-byte tag challenge, and the encrypted key fingerprint.
3. Send the serial, challenge, and observed fingerprint to the authenticated backend.
4. Receive and write a one-time authorization proof. The app never receives the reusable per-device bootstrap key.
5. If the tag is empty, install the 32-byte reset-control key and then the 28-byte advertisement key with write-with-response. If the backend allocation already matches the tag fingerprint, do not write either key again.
6. Wait for `Ready / Success`, then read and compare the 32-byte fingerprint after NVS read-back.
7. Complete the backend claim with the tag-read fingerprint and completion capability.

The module never receives the finder private key or reusable factory bootstrap key. Authorization proofs, advertisement keys, control keys, and reset commands are cleared after use and must not be logged or persisted by the UI. Encrypted characteristics trigger platform pairing before sensitive reads/writes.

`TagProvisioner.release()` performs the inverse two-phase flow. It verifies the connected owned tag, obtains an authenticated one-time reset command, erases the tag, checks that the fingerprint is empty, and only then completes backend release. Backend completion ends the sole active owner and locally cancels all nonterminal subscriptions for that user/device; provider cancellations are delivered through the database outbox.

The tag remains subscription-suspended after provisioning. Installing and verifying the signed entitlement is a separate milestone and must complete before finder advertisements are enabled.
