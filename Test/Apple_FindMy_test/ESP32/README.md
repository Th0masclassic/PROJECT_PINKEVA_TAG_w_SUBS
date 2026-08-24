# Pinkeva ESP32-C3 provisioning firmware

This directory contains the Pinkeva setup firmware for the ESP32-C3. It is
not the legacy OpenHaystack image. During setup the tag advertises its
`PKV-XXXXXXXXXXXX` name and the Pinkeva provisioning service:

`a6f0f000-3e4d-4b1a-9c2e-72d24c8f0a01`

The service is present both in the GATT database and in the setup advertisement
so iOS and Android can find the tag before it is claimed.

## Build

Install ESP-IDF 5.4 or newer, then run from this directory:

```sh
idf.py set-target esp32c3
idf.py build
```

The project defaults to the ESP32-C3 target. Do not reuse the old
`git_ready/build/openhaystack.bin` artifact; it does not contain the Pinkeva
GATT service.

The checked-in `sdkconfig` is the development profile used by the current
hardware test: it disables the factory-bootstrap requirement and does not
persist phone-specific BLE bonds. This is why a board with its `boot_key`
removed can still advertise and accept the mobile setup flow. The resulting
image is deliberately marked `development-no-bootstrap` in `firmware/manifest.json`.
It is not a production security profile. Production tags must be built with
`CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP=n`, injected with a unique `boot_key`, and
registered with the matching encrypted backend credential.

## Flash

The checked-in images under `firmware/` are built for ESP32-C3. The flash
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
