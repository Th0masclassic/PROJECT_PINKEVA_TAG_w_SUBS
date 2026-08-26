#pragma once

#include <cstddef>
#include <optional>
#include <stdint.h>

#include "esp_err.h"
#include "utils.hpp"

constexpr size_t PUBLIC_KEY_SIZE = 28;
constexpr size_t DEVICE_ID_LEN = 17;

enum class BLEMode : uint8_t {
    SETUP,
    SUSPENDED,
    TRACKER,
};

enum class ProvisioningState : uint8_t {
    UNPROVISIONED = 0x00,
    RECEIVING = 0x01,
    VALIDATING = 0x02,
    PERSISTING = 0x03,
    READY = 0x04,
    SUSPENDED = 0x05,
    ERROR = 0x7F,
};

enum class ProvisioningResult : uint8_t {
    SUCCESS = 0x00,
    INVALID_LENGTH = 0x01,
    INVALID_VALUE = 0x02,
    STORAGE_FAILURE = 0x03,
    ALREADY_PROVISIONED = 0x04,
    UNAUTHORIZED = 0x05,
    UNSUPPORTED_VERSION = 0x06,
    ENTITLEMENT_REJECTED = 0x07,
    INTERNAL_ERROR = 0x7F,
};

std::optional<ERROR_TAG> ble_init();

/** Open a time-bounded connectable BLE window after the physical button hold. */
esp_err_t ble_open_maintenance_window();

/** True only after the asynchronous Pinkeva GATT service has started. */
bool ble_service_ready();
