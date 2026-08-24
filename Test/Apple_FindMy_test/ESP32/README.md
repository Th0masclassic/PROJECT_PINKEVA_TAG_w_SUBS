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

## Flash

The checked-in images under `firmware/` are built for ESP32-C3. Flash them
with:

```sh
./flash_esp32.sh --port /dev/tty.usbmodemXXXX
```

The script updates the bootloader, partition table, and application without
erasing the NVS partition. This preserves the per-device factory bootstrap
key required before BLE setup can start. New devices must receive that key
through the controlled manufacturing flow; it must never be placed in this
repository or in the mobile app.

After flashing, refresh the device in nRF Connect. The connected services
should include the Pinkeva UUID above, in addition to Generic Access and
Generic Attribute. The advertisement view should also list the same UUID.
