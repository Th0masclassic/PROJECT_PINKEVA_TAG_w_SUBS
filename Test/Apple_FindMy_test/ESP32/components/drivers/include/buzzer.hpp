#pragma once

#include <stdint.h>

#include "esp_err.h"

using BuzzerCompletionCallback = void (*)();

/** Configure the CPT-9019A-SMT-TR drive GPIO and leave it silent. */
esp_err_t buzzer_init();

/**
 * Drive the piezo at its 4 kHz rated frequency for a bounded duration.
 *
 * The callback runs from the ESP timer task after a natural timeout. It is not
 * called when buzzer_stop() ends the tone explicitly.
 */
esp_err_t buzzer_start(uint32_t duration_ms,
                       BuzzerCompletionCallback completion_callback = nullptr);

/** Stop an active tone and discard its natural-completion callback. */
esp_err_t buzzer_stop();

bool buzzer_is_active();
