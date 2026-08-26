#pragma once

#include <cstddef>
#include <cstdint>

#include "esp_gatt_defs.h"

constexpr size_t FIRMWARE_MANIFEST_SIZE = 115;
constexpr size_t FIRMWARE_STATUS_SIZE = 6;

enum class FirmwareUpdateState : uint8_t {
    IDLE = 0x00,
    READY = 0x01,
    RECEIVING = 0x02,
    VERIFYING = 0x03,
    COMPLETE = 0x04,
    ERROR = 0x7F,
};

enum class FirmwareUpdateResult : uint8_t {
    SUCCESS = 0x00,
    INVALID_MANIFEST = 0x01,
    SIGNATURE_REJECTED = 0x02,
    VERSION_REJECTED = 0x03,
    PARTITION_UNAVAILABLE = 0x04,
    WRITE_FAILED = 0x05,
    DIGEST_MISMATCH = 0x06,
    INCOMPLETE_IMAGE = 0x07,
    INVALID_IMAGE = 0x08,
    INVALID_STATE = 0x09,
    INTERNAL_ERROR = 0x7F,
};

/** Start a signed firmware transfer into the inactive OTA partition. */
esp_gatt_status_t ota_update_begin(const uint8_t *manifest, size_t length);

/** Append one ordered BLE chunk to the inactive OTA partition. */
esp_gatt_status_t ota_update_write(const uint8_t *data, size_t length);

/** Finalize command: 0x01 commits, 0x02 aborts. */
esp_gatt_status_t ota_update_control(const uint8_t *command, size_t length);

/** Abort an incomplete transfer. Safe to call after disconnect. */
void ota_update_abort();

/** True while an authenticated transfer owns the OTA partition handle. */
bool ota_update_active();

/** State, result, and received-byte count (big endian). */
void ota_update_status(uint8_t output[FIRMWARE_STATUS_SIZE]);
