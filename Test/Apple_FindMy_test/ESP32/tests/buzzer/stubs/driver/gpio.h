#pragma once
#include <cstdint>
#include "esp_err.h"
using gpio_num_t = int;
enum gpio_mode_t { GPIO_MODE_OUTPUT };
#define GPIO_IS_VALID_OUTPUT_GPIO(pin) ((pin) >= 0 && (pin) < 34 && (pin) != 20 && (pin) != 24 && !((pin) >= 28 && (pin) <= 31))
esp_err_t gpio_reset_pin(gpio_num_t);
esp_err_t gpio_set_level(gpio_num_t, uint32_t);
esp_err_t gpio_set_direction(gpio_num_t, gpio_mode_t);
