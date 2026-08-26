# Pinkeva ESP32 provisioning firmware

This directory contains the Pinkeva setup firmware for the classic ESP32. It is
not the legacy OpenHaystack image. During setup the tag advertises its
`PKV-XXXXXXXXXXXX` name and the Pinkeva provisioning service:

`a6f0f000-3e4d-4b1a-9c2e-72d24c8f0a01`

The service is present both in the GATT database and in the setup advertisement
so iOS and Android can find the tag before it is claimed.

After provisioning, normal finder advertising is non-connectable. A continuous
five-second press on `CONFIG_PINQEVA_MAINTENANCE_BUTTON_GPIO` opens a
connectable Pinkeva maintenance advertisement for 120 seconds. The phone must
scan and create a fresh BLE connection; a disconnected BLE link cannot be
resumed. GPIO0 is the development default and is a boot-strapping pin on common
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

## Entitlement and expiry behavior

The firmware accepts only a backend-signed, serial-bound P-256 entitlement with
a strictly increasing counter and a future UTC expiry. While continuously
powered, an exact one-shot `esp_timer` stops the Apple-style manufacturer
advertisement at expiry; no periodic expiry polling loop is used. A successful
renewal replaces the stored packet, rearms the timer, and closes the temporary
maintenance window.

The classic ESP32 has no battery-backed wall clock. After any reboot, the
firmware therefore fails closed and does not infer how much wall time elapsed:
the owner must open maintenance mode and let an authorized phone provide fresh
UTC before a stored entitlement can resume. The saved timestamp is retained
only as an anti-rollback floor. A product that must resume unattended after
complete power loss needs a protected external RTC or another trusted time
source.

Normal finder frames use a two-second interval and are non-connectable. Setup
and maintenance advertisements are connectable only for their bounded setup
window. The build uses BLE-only mode, one controller connection, Bluetooth
modem sleep, automatic light sleep, tickless idle, and 40–80 MHz dynamic
frequency scaling. These settings reduce radio and CPU duty cycle, but final
battery life still requires current measurements on the production PCB,
battery, antenna, and chosen advertising interval.

## Flash

The checked-in images under `firmware/` are built for the classic ESP32. The flash
script verifies the image target before writing it. Flash them with:

```sh
./flash_esp32.sh --port /dev/tty.usbmodemXXXX
```

By default the script updates the bootloader, partition table, and application
without erasing NVS. To start this development board as a completely new tag,
including removing old advertisement/control/bootstrap data, use the explicit
development-only reset:

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
