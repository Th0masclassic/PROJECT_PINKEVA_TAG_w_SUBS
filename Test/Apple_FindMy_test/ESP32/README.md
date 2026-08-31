# Pinkeva ESP32 tracker firmware

This directory contains the Pinkeva setup firmware for the classic ESP32. It is
not the legacy OpenHaystack image. During setup the tag advertises its
`PKV-XXXXXXXXXXXX` name and the Pinkeva provisioning service:

`a6f0f000-3e4d-4b1a-9c2e-72d24c8f0a01`

The service is present both in the GATT database and in the setup advertisement
so iOS and Android can find the tag before it is claimed.

After provisioning, finder advertisements remain connectable for Pinkeva owner
ringing and the public DULT non-owner sound service. A service-only scan response
lets the Pinkeva app discover nearby trackers without broadcasting their stable
serial numbers. The app reads and verifies the serial after connecting. A
continuous five-second press on `CONFIG_PINQEVA_MAINTENANCE_BUTTON_GPIO` switches
to the Pinkeva maintenance advertisement for 120 seconds. The phone must scan
and create a fresh BLE connection; a disconnected BLE link cannot be resumed.
GPIO0 is the development button default and is a boot-strapping pin on common
boards, so production hardware should select a dedicated non-strapping GPIO.

## Build

Install ESP-IDF 5.4 or newer, then run from this directory:

```sh
idf.py set-target esp32
idf.py build
```

The project defaults to the classic ESP32 target. Do not reuse the old
`git_ready/build/openhaystack.bin` artifact; it does not contain the Pinkeva
GATT service.

The checked-in `sdkconfig` is the development profile used by the current
hardware test. This setting is also stored in `sdkconfig.defaults`, so running
`idf.py set-target esp32` cannot silently re-enable pairing. It disables the
factory-bootstrap requirement and does not
ask iOS or Android to pair/bond for the provisioning characteristics. This is
why a board with its `boot_key` removed can still advertise and accept the
mobile setup flow. The protocol advertises capability `0x20` so the app can
reject the older pairing-dependent profile. The resulting image is deliberately
marked `development-no-bootstrap-no-bond` in `firmware/manifest.json`.
During setup, the firmware uses version 3 of a static-random BLE address derived
from the board MAC. The visible `PKV-XXXXXXXXXXXX` device ID stays unchanged,
but iOS sees a new CoreBluetooth identity instead of attempting to reuse an old
LTK from the previous setup image. If the phone still shows the old peripheral,
flash the new image and restart Bluetooth; no database identifier needs to be
changed.

This is not a production security profile: bootstrap proof verification is
bypassed and the development radio link does not provide authentication or key
confidentiality. Production tags must use a reviewed application-layer secure
channel before retaining the no-bond UX, re-enable the factory bootstrap,
inject a unique `boot_key`, and register the matching encrypted backend
credential.

## Signed BLE firmware updates

Firmware `0.6.0` implements protocol `1.9`. Capability `0x0080` identifies
signed OTA support, `0x0100` identifies dual-network provisioning, and `0x0200`
identifies the public DULT non-owner sound control. `0x0400` identifies the new
owner-authenticated 10-second ring control.
During the physical two-minute maintenance window, an authorized phone can
install a newer classic-ESP32 application into the inactive OTA slot. The
tracker accepts a transfer only when its fixed 115-byte manifest:

- is signed by the backend P-256 release key embedded in the tracker;
- targets the classic ESP32 and names a strictly newer semantic version;
- binds the exact image byte length and SHA-256 digest; and
- fits one 896 KiB OTA slot.

The image is streamed in ordered BLE chunks. Firmware hashes bytes while
writing, lets ESP-IDF validate the completed application, selects the inactive
slot, and reboots. ESP-IDF rollback is enabled: a new image that cannot finish
BLE initialization marks itself invalid and returns to the previous slot. A
healthy image opens a maintenance window after its first boot so the phone can
read the exact three-component version before acknowledging installation to
the backend. An interrupted transfer is aborted on disconnect and the current
slot continues to boot.

The old checked-in layout had only one application partition. Consequently,
the first installation of this OTA-capable build must be wired and must flash
the new bootloader, partition table, initial OTA data, and application. Later
versions can use BLE. The migration keeps the existing NVS range
`0x9000`-`0xEFFF` unchanged, so tracker identity and provisioning data are
preserved unless `--erase-nvs` is explicitly supplied.

## Dual-network advertising

Provisioning stores a 28-byte Apple advertisement key, a 20-byte Google Find
Hub development EID, and a write-once setup preference. Both identities must be
present. The classic ESP32 has one legacy advertising set, so firmware alternates
500 ms Apple and Google slots. Each slot uses a 250 ms advertising interval,
targeting two Apple events followed by two Google events per second. The stored
preference only decides which frame starts first; both are restored after every
reboot and neither is controlled by billing state.

The former development entitlement characteristic, verifier, timer, NVS key,
erase path, and API transport have been removed. The ESP32 contains no
subscription state. UTC synchronization remains for authorized maintenance and
future rotating-identity work, not subscription enforcement.

The current 29-byte Google frame matches the pinned GoogleFindMyTools development
format: service UUID `0xFEAA`, frame type `0x41`, a 20-byte counter-zero EID, and
one hashed-flags byte. The isolated bridge refreshes the server-side future-slot
announcement about every four days; the EID stored on the tag does not change.
This is experimental. Google's published switchable-protocol guidance requires
only one finder network at a time, so simultaneous Apple/Google advertising is
not a certifiable Find Hub implementation. Commercial operation still needs
partner onboarding, rotating EIDs, Fast Pair/FHN behavior, and certification.

Finder frames are connectable for DULT and switch every 500 ms. Setup and
maintenance advertisements remain bounded by their respective workflow. The
faster radio schedule and connectability materially increase power use compared
with the former two-second non-connectable frame; final battery life requires
current measurements on the production PCB, battery, antenna, and enclosure.
The build uses BLE-only mode, one controller connection, Bluetooth modem sleep,
tickless idle, and 40–80 MHz dynamic scaling. See the power notes below for the
hardware limitation on actual automatic light sleep.

## CPT-9019A sound and platform commands

`CONFIG_PINQEVA_BUZZER_GPIO` defaults to GPIO25. Firmware drives one terminal of
the CPT-9019A-SMT-TR at its rated 4 kHz with a 50% duty square wave; the direct
development wiring connects the other terminal to ground. Production hardware
may use a transistor or bridge driver when enclosure measurements require more
output, while remaining inside the buzzer voltage rating.

The [manufacturer datasheet](https://www.sameskydevices.com/product/resource/cpt-9019a-smt-tr.pdf)
specifies external drive, 3 Vp-p rated voltage, 1–25 Vp-p operating range, and
4 kHz / 50% duty. GPIO25 is the existing classic-ESP32 development wiring default,
not an inferred production PCB connection. Check the real PCB/driver before
flashing; GPIO25 does not exist on ESP32-C3. This image is **not** a C3 release.

### Pinkeva app Play / Pause

Owner ringing needs no physical maintenance-button hold and no OS bond. The
firmware accepts a BLE connection, but a connection or an app-name string alone
does not authorize sound. The app must be online and signed in as the current
owner to obtain a one-connection proof. No subscription is required for ringing.

All characteristics below belong to the Pinkeva service. UUID suffix is
`-3e4d-4b1a-9c2e-72d24c8f0a01`.

| UUID prefix | Operation | Value |
| --- | --- | --- |
| `a6f0f002` | Read | Factory serial, 16 ASCII bytes |
| `a6f0f008` | Read | Fresh random 32-byte connection challenge (public, not a secret) |
| `a6f0f013` | Write with response | 32-byte owner ring authorization proof |
| `a6f0f014` | Write with response | `01` = Play; `00` = Pause/stop (not resume) |
| `a6f0f015` | Read / notify | `[state, source]`: state `0` idle / `1` playing; source `0` none / `1` owner / `2` DULT |

1. Scan for the Pinkeva service, connect, discover services, and check protocol
   capability `0x0400` plus the serial against the selected owned tracker.
2. Read the challenge and POST `{serial_number, tag_challenge_base64url}` to
   `/v1/devices/{device_id}/ring/authorize` with the user's bearer token.
3. The backend verifies active ownership and the current claimed allocation,
   derives its existing per-allocation control key, and returns only
   `ring_authorization_proof_base64url` (never that reusable key).
4. Within 30 seconds of connecting, write the proof to `a6f0f013`, subscribe to
   `a6f0f015`, then write Play/Pause to `a6f0f014`.

The proof is `HMAC-SHA256(control_key, "pinqeva:ring-auth:v1" || 00 || serial ||
challenge)`. Firmware compares all 32 bytes, resets permission on every
disconnect, and rejects a replay from a previous connection. This permission
grants sound control only, not setup/reset/OTA. Unlike factory bootstrap setup,
**ring proof verification is never bypassed by the development profile**.
However, development setup still transmits the control key without production
confidentiality: someone who captured that earlier key can forge ring proofs.
Production secure provisioning remains a prerequisite for production security.

An accepted Play emits a continuous 4 kHz tone for 10 seconds. Any further Play
while the buzzer is active returns success but is ignored: it cannot extend the
deadline or queue another sound. Authorized Pause silences it immediately; Pause
while idle is harmless. Owner sound finishes its original timer even if the phone
disconnects. A newly authenticated owner connection can stop it. Status updates
are event-driven, with no BLE polling or busy wait. The app/backend changes must
be released alongside this firmware to expose the button; old firmware is
reported as incompatible instead of silently using the public DULT command.

### Public platform sound (unchanged authorization policy)

The public DULT non-owner service
`15190001-12F4-C226-88ED-2AC5579F2A85` supports `Sound_Start` and `Sound_Stop`.
It plays for the recommended 12 seconds, reports command status by indication,
and emits `Sound_Completed`. This is the cross-platform anti-stalking sound
path; it is not Apple's owner **Play Sound** protocol. Apple exposes the owner
accessory protocol only through the MFi Find My program, and Google's certified
owner ring path additionally requires the Fast Pair account/ring-key protocol.

Public DULT deliberately remains accessible without owner authentication for
anti-stalking use. It shares the piezo, so an owner Play cannot interrupt or extend
an active DULT sound. DULT Stop/disconnect only stops that connection's DULT sound,
not an owner sound. This is not a claim that Apple/Google owner Play Sound works.

## Power and robustness changes

- The PWM timer is paused and the output driven low when silent. APB-frequency
  and no-light-sleep locks are held only while sounding, avoiding pitch changes
  or silent gaps during CPU scaling/sleep. The driver serializes start, stop, and
  timeout, ignores stale timeout callbacks after a restart, and uses the basic
  LEDC duty API without allocating the otherwise-required fade service.
- Repeated per-slot radio identity/advertising logs are debug-only, and identical
  scan-response data is not reconfigured on every Apple/Google swap.
- Connections request 30–50 ms intervals with slave latency 4 (the phone can
  decline). Idle links are closed after 60 seconds so finding advertisements
  resume; successful maintenance/OTA traffic keeps its link active.
- The physical button uses an interrupt and light-sleep wake source, with the
  level interrupt masked while held; the idle task does not poll the pin.
- Finder cadence remains 250 ms / 500 ms by default. For measured low-power
  experiments, `sdkconfig.low_power` selects a 1000 ms interval and 2500 ms slots.
  This reduces radio work and switches but increases discovery latency. A slot
  must be at least twice its interval; intervals must be multiples of 5 ms.

Use a separate config/build to avoid overwriting your existing target settings:

```sh
idf.py -B build-ring-low -D SDKCONFIG=sdkconfig.ring-low \
  -D 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.low_power' build
```

The current ESP-IDF 5.4 classic-ESP32 main-crystal BLE sleep clock supports modem
sleep and dynamic frequency scaling but prevents Bluetooth automatic light sleep.
A correctly populated/configured external 32.768 kHz clock is needed for that
additional saving on this target; do not select it merely to lower a software
setting. See [Espressif power management](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32/api-reference/system/power_management.html)
and [LEDC sleep behavior](https://docs.espressif.com/projects/esp-idf/en/v5.4/esp32/api-reference/peripherals/ledc.html).
Deep sleep is not used because it would make the tracker unavailable to BLE.

No battery-life number is claimed from software checks. Measure idle advertising,
connected idle, 10-second ringing, and OTA current on the battery-powered PCB
(USB-UART/regulator/power LEDs can dominate a development-board measurement).
On hardware, also verify tone frequency/duration, duplicate Play at 1/9 seconds,
Pause, disconnect/reconnect, wrong-owner/replayed proofs, and DULT interoperability.

## Flash

The checked-in images under `firmware/` are built for the classic ESP32. The flash
script verifies the image target before writing it. Flash them with:

```sh
./flash_esp32.sh --port /dev/tty.usbmodemXXXX
```

By default the script updates the bootloader, partition table, initial OTA
metadata, and `ota_0` application without erasing NVS. This wired step is
required once for any board still using the earlier single-application layout.
To start this development board as a completely new tag, including removing
old advertisement/control/bootstrap data, use the explicit development-only
reset:

```sh
./flash_esp32.sh --port /dev/tty.usbmodemXXXX --erase-nvs
```

That option is refused for a production-profile manifest and erases only the
ESP32 NVS partition (`0x9000`–`0xEFFF`); it does not erase the application.

After flashing, refresh the device in nRF Connect. The connected services
should include the Pinkeva UUID above, in addition to Generic Access and
Generic Attribute. The advertisement view should also list the same UUID.

On Windows with an ESP32 on `COM5`, a completely clean source build is:

```cmd
idf.py fullclean
idf.py set-target esp32
idf.py -p COM5 erase-flash
idf.py -p COM5 flash monitor
```
