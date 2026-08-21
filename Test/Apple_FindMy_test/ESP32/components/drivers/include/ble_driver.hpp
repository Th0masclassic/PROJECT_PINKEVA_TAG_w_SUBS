#pragma once

#include <stdint.h>
#include "esp_err.h"
#include <optional>
#include "utils.hpp"

#define PUBLIC_KEY_SIZE 28
#define DEVICE_ID_LEN 17

enum class BLEMode {
    SETUP,
    TRACKER
};


std::optional<ERROR_TAG> ble_init();