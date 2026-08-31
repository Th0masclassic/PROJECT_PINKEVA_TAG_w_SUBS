# App-to-Tag provisioning bridge

`TagProvisioner` is the protocol-v1.9 React Native service layer. The UI supplies the selected BLE peripheral, a Supabase access-token callback, a stable idempotency key, and the platform setup preference. No QR scan or user-entered setup secret is required.

The flow is deliberately ordered:

1. Connect and discover the exact 128-bit provisioning service.
2. Read protocol information, the factory-derived `PKV-` identifier, a fresh 32-byte tag challenge, both key fingerprints, and the selected-network value.
3. Send the serial, challenge, observed tag state, and desired network to the authenticated backend.
4. Receive and write a one-time authorization proof. The app never receives the reusable per-device bootstrap key.
5. Install the 32-byte reset-control key, 20-byte Google EID, write-once startup-slot preference, and 28-byte Apple advertisement key. Identical interrupted writes are safe to retry; replacement requires authenticated reset.
6. Wait for `Ready / Success`, then read and compare both 32-byte fingerprints and the startup preference after NVS read-back. Firmware 0.6.0 advertises both identities regardless of that preference.
7. Complete the backend claim with the complete tag-read binding and completion capability.

The module never receives the finder private key or reusable factory bootstrap key. Authorization proofs, advertisement keys, control keys, and reset commands are cleared after use and must not be logged or persisted by the UI. Encrypted characteristics trigger platform pairing before sensitive reads/writes.

`TagProvisioner.release()` performs the inverse two-phase flow. It verifies both identities and the network on the connected owned tag, obtains an authenticated one-time reset command, erases the tag, checks that both fingerprints and the selector are empty, and only then completes backend release. Backend completion ends the sole active owner but does not cancel the account subscription, which continues to cover the account's other and future tags.

`TagRinger` handles nearby owner sound without exposing the reusable control key. It verifies the connected `PKV-` serial, reads a fresh tag challenge, asks the authenticated backend for an owner-bound proof, and writes Play or Pause. Firmware owns the 10-second deadline; repeated Play requests are ignored rather than queued or extended.

After both identities and the preference are committed, firmware alternates the Apple and Google frames and restores both after reboot. Subscription state is enforced only by authenticated cloud APIs. Renewal never sends billing state to the tag and subscription expiry never disables finder advertising.
