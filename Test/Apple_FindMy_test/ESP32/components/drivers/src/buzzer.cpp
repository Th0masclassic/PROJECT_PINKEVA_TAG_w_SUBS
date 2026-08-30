#include "buzzer.hpp"

#include <atomic>

#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "sdkconfig.h"

namespace {
constexpr char LOG_TAG[] = "BUZZER";
constexpr ledc_mode_t SPEED_MODE = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t TIMER = LEDC_TIMER_0;
constexpr ledc_channel_t CHANNEL = LEDC_CHANNEL_0;
constexpr ledc_timer_bit_t DUTY_RESOLUTION = LEDC_TIMER_10_BIT;
constexpr uint32_t ACTIVE_DUTY = 1U << 9U;
constexpr uint32_t MIN_DURATION_MS = 100;
constexpr uint32_t MAX_DURATION_MS = 30U * 1000U;

esp_timer_handle_t stop_timer = nullptr;
std::atomic_bool initialized{false};
std::atomic_bool active{false};
std::atomic<BuzzerCompletionCallback> completion_callback{nullptr};

esp_err_t set_output(bool enabled) {
    return ledc_set_duty_and_update(SPEED_MODE, CHANNEL,
                                    enabled ? ACTIVE_DUTY : 0, 0);
}

void stop_timer_callback(void *) {
    const bool was_active = active.exchange(false, std::memory_order_acq_rel);
    const esp_err_t output_error = set_output(false);
    if (output_error != ESP_OK) {
        ESP_LOGE(LOG_TAG, "Could not silence buzzer: %s",
                 esp_err_to_name(output_error));
    }
    BuzzerCompletionCallback callback =
        completion_callback.exchange(nullptr, std::memory_order_acq_rel);
    if (was_active && callback != nullptr) callback();
}
}  // namespace

esp_err_t buzzer_init() {
    if (initialized.load(std::memory_order_acquire)) return ESP_OK;

    const ledc_timer_config_t timer_configuration = {
        .speed_mode = SPEED_MODE,
        .duty_resolution = DUTY_RESOLUTION,
        .timer_num = TIMER,
        .freq_hz = CONFIG_PINQEVA_BUZZER_FREQUENCY_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
        .deconfigure = false,
    };
    esp_err_t error = ledc_timer_config(&timer_configuration);
    if (error != ESP_OK) return error;

    const ledc_channel_config_t channel_configuration = {
        .gpio_num = CONFIG_PINQEVA_BUZZER_GPIO,
        .speed_mode = SPEED_MODE,
        .channel = CHANNEL,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = TIMER,
        .duty = 0,
        .hpoint = 0,
        .sleep_mode = LEDC_SLEEP_MODE_NO_ALIVE_NO_PD,
        .flags = {.output_invert = 0},
    };
    error = ledc_channel_config(&channel_configuration);
    if (error != ESP_OK) return error;

    const esp_timer_create_args_t timer_arguments = {
        .callback = &stop_timer_callback,
        .arg = nullptr,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "buzzer_stop",
        .skip_unhandled_events = true,
    };
    error = esp_timer_create(&timer_arguments, &stop_timer);
    if (error != ESP_OK) return error;

    completion_callback.store(nullptr, std::memory_order_release);
    active.store(false, std::memory_order_release);
    initialized.store(true, std::memory_order_release);
    ESP_LOGI(LOG_TAG, "CPT-9019A drive ready on GPIO%d at %d Hz",
             CONFIG_PINQEVA_BUZZER_GPIO,
             CONFIG_PINQEVA_BUZZER_FREQUENCY_HZ);
    return ESP_OK;
}

esp_err_t buzzer_start(uint32_t duration_ms,
                       BuzzerCompletionCallback callback) {
    if (!initialized.load(std::memory_order_acquire) || stop_timer == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    if (duration_ms < MIN_DURATION_MS || duration_ms > MAX_DURATION_MS) {
        return ESP_ERR_INVALID_ARG;
    }
    if (active.load(std::memory_order_acquire)) return ESP_ERR_INVALID_STATE;

    completion_callback.store(callback, std::memory_order_release);
    esp_err_t error = set_output(true);
    if (error != ESP_OK) {
        completion_callback.store(nullptr, std::memory_order_release);
        return error;
    }
    active.store(true, std::memory_order_release);
    error = esp_timer_start_once(stop_timer,
                                 static_cast<uint64_t>(duration_ms) * 1000ULL);
    if (error != ESP_OK) {
        active.store(false, std::memory_order_release);
        completion_callback.store(nullptr, std::memory_order_release);
        set_output(false);
        return error;
    }
    return ESP_OK;
}

esp_err_t buzzer_stop() {
    if (!initialized.load(std::memory_order_acquire) || stop_timer == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const bool was_active = active.exchange(false, std::memory_order_acq_rel);
    completion_callback.store(nullptr, std::memory_order_release);
    const esp_err_t timer_error = esp_timer_stop(stop_timer);
    const esp_err_t output_error = set_output(false);
    if (output_error != ESP_OK) return output_error;
    if (timer_error != ESP_OK && timer_error != ESP_ERR_INVALID_STATE) {
        return timer_error;
    }
    return was_active ? ESP_OK : ESP_ERR_INVALID_STATE;
}

bool buzzer_is_active() {
    return active.load(std::memory_order_acquire);
}
