#pragma once

#include <stdint.h>

#include "esp_err.h"

using BuzzerCompletionCallback = void (*)();

/** Configure the CPT-9019A-SMT-TR drive GPIO, idle low with its PWM timer paused. */
esp_err_t buzzer_init();

/**
 * Drive the piezo at its 4 kHz rated frequency for a bounded duration.
 *
 * Thread-safe from task context (not an ISR). Accepted durations are 100-30000
 * milliseconds. Starting an active tone returns ESP_ERR_INVALID_STATE without
 * extending its deadline or replacing its callback.
 *
 * The callback runs outside the driver mutex from the ESP timer task after a
 * natural timeout; it must not block. It is not called when buzzer_stop() ends
 * the tone explicitly. Automatic light sleep and APB scaling are constrained
 * only while the tone is active, so PWM remains continuous and at 4 kHz.
 */
esp_err_t buzzer_start(uint32_t duration_ms,
                       BuzzerCompletionCallback completion_callback = nullptr);

/** Stop immediately, discard the callback, and release the ring's power locks. */
esp_err_t buzzer_stop();

bool buzzer_is_active();
