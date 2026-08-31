#include "buzzer.hpp"

#include <atomic>
#include <mutex>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_pm.h"
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
constexpr gpio_num_t BUZZER_GPIO =
    static_cast<gpio_num_t>(CONFIG_PINQEVA_BUZZER_GPIO);

// ESP-IDF implements std::mutex with a priority-inheriting FreeRTOS mutex.
// Never hold a spinlock while calling LEDC, timers, or power-management APIs.
std::mutex state_mutex;
esp_timer_handle_t stop_timer = nullptr;
bool initialized = false;
bool output_healthy = true;
bool timer_configured = false;
bool channel_configured = false;
std::atomic_bool active{false};
int64_t stop_deadline_us = 0;
BuzzerCompletionCallback completion_callback = nullptr;

#if CONFIG_PM_ENABLE
esp_pm_lock_handle_t apb_lock = nullptr;
esp_pm_lock_handle_t awake_lock = nullptr;
bool apb_lock_held = false;
bool awake_lock_held = false;
#endif

esp_err_t first_error(esp_err_t first, esp_err_t next) {
    return first == ESP_OK ? next : first;
}

esp_err_t gpio_idle_low() {
    // Detach the peripheral first, including after a partial LEDC setup failure.
    esp_err_t error = gpio_reset_pin(BUZZER_GPIO);
    error = first_error(error, gpio_set_level(BUZZER_GPIO, 0));
    return first_error(error, gpio_set_direction(BUZZER_GPIO, GPIO_MODE_OUTPUT));
}

esp_err_t silence_locked() {
    esp_err_t error = ESP_OK;
    if (channel_configured) error = ledc_stop(SPEED_MODE, CHANNEL, 0);
    if (timer_configured) {
        error = first_error(error, ledc_timer_pause(SPEED_MODE, TIMER));
    }
    if (error != ESP_OK) {
        // Do not permit another start after an unexpected peripheral failure.
        // Disconnect LEDC so the GPIO remains low even if its timer still runs.
        output_healthy = false;
        const esp_err_t gpio_error = gpio_idle_low();
        ESP_LOGE(LOG_TAG, "LEDC stop failed (%s); GPIO fallback: %s",
                 esp_err_to_name(error), esp_err_to_name(gpio_error));
    }
    return error;
}

esp_err_t release_power_locked() {
    esp_err_t error = ESP_OK;
#if CONFIG_PM_ENABLE
    if (awake_lock_held) {
        const esp_err_t result = esp_pm_lock_release(awake_lock);
        if (result == ESP_OK) awake_lock_held = false;
        error = first_error(error, result);
    }
    if (apb_lock_held) {
        const esp_err_t result = esp_pm_lock_release(apb_lock);
        if (result == ESP_OK) apb_lock_held = false;
        error = first_error(error, result);
    }
#endif
    return error;
}

esp_err_t acquire_power_locked() {
#if CONFIG_PM_ENABLE
    // A fixed APB clock preserves 4 kHz while DFS is enabled. LEDC does not
    // prevent automatic light sleep itself, so keep it awake only while audible.
    if (!apb_lock_held) {
        const esp_err_t error = esp_pm_lock_acquire(apb_lock);
        if (error != ESP_OK) return error;
        apb_lock_held = true;
    }
    if (!awake_lock_held) {
        const esp_err_t error = esp_pm_lock_acquire(awake_lock);
        if (error != ESP_OK) {
            release_power_locked();
            return error;
        }
        awake_lock_held = true;
    }
#endif
    return ESP_OK;
}

esp_err_t finish_locked() {
    active.store(false, std::memory_order_release);
    stop_deadline_us = 0;
    completion_callback = nullptr;
    const esp_err_t output_error = silence_locked();
    return first_error(output_error, release_power_locked());
}

void stop_timer_callback(void *) {
    BuzzerCompletionCallback callback = nullptr;
    {
        std::lock_guard<std::mutex> guard(state_mutex);
        if (!initialized || !active.load(std::memory_order_acquire)) return;

        const int64_t remaining_us = stop_deadline_us - esp_timer_get_time();
        if (remaining_us > 0) {
            // esp_timer_stop() cannot retract a callback already dispatched.
            // A queued callback from a paused ring must not stop its successor.
            if (esp_timer_is_active(stop_timer)) return;
            const esp_err_t error = esp_timer_start_once(
                stop_timer, static_cast<uint64_t>(remaining_us));
            if (error == ESP_OK) return;
            ESP_LOGE(LOG_TAG, "Could not restore buzzer deadline: %s",
                     esp_err_to_name(error));
        }

        callback = completion_callback;
        const esp_err_t error = finish_locked();
        if (error != ESP_OK) {
            ESP_LOGE(LOG_TAG, "Could not finish buzzer cleanly: %s",
                     esp_err_to_name(error));
        }
    }
    // Call user code outside our mutex; callbacks may query the driver safely.
    if (callback != nullptr) callback();
}

void cleanup_failed_init_locked() {
    silence_locked();
    if (stop_timer != nullptr) {
        esp_timer_delete(stop_timer);
        stop_timer = nullptr;
    }
#if CONFIG_PM_ENABLE
    release_power_locked();
    if (awake_lock != nullptr) {
        esp_pm_lock_delete(awake_lock);
        awake_lock = nullptr;
    }
    if (apb_lock != nullptr) {
        esp_pm_lock_delete(apb_lock);
        apb_lock = nullptr;
    }
#endif
    if (timer_configured) {
        ledc_timer_config_t configuration = {};
        configuration.speed_mode = SPEED_MODE;
        configuration.timer_num = TIMER;
        configuration.deconfigure = true;
        ledc_timer_config(&configuration);
    }
    timer_configured = false;
    channel_configured = false;
    gpio_idle_low();
}
}  // namespace

esp_err_t buzzer_init() {
    std::lock_guard<std::mutex> guard(state_mutex);
    if (initialized) return output_healthy ? ESP_OK : ESP_ERR_INVALID_STATE;
    if (!GPIO_IS_VALID_OUTPUT_GPIO(CONFIG_PINQEVA_BUZZER_GPIO) ||
        CONFIG_PINQEVA_BUZZER_GPIO == CONFIG_PINQEVA_MAINTENANCE_BUTTON_GPIO ||
        CONFIG_PINQEVA_BUZZER_GPIO == 2) {  // utils.hpp uses GPIO2 for its LED.
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t error = gpio_idle_low();
    if (error != ESP_OK) return error;
    output_healthy = true;

    const ledc_timer_config_t timer_configuration = {
        .speed_mode = SPEED_MODE,
        .duty_resolution = DUTY_RESOLUTION,
        .timer_num = TIMER,
        .freq_hz = CONFIG_PINQEVA_BUZZER_FREQUENCY_HZ,
        .clk_cfg = LEDC_USE_APB_CLK,
        .deconfigure = false,
    };
    error = ledc_timer_config(&timer_configuration);
    if (error == ESP_OK) {
        timer_configured = true;
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
        if (error == ESP_OK) {
            channel_configured = true;
            error = silence_locked();
        }
    }
#if CONFIG_PM_ENABLE
    if (error == ESP_OK) {
        error = esp_pm_lock_create(ESP_PM_APB_FREQ_MAX, 0, "buzzer_apb", &apb_lock);
    }
    if (error == ESP_OK) {
        error = esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "buzzer_awake", &awake_lock);
    }
#endif
    if (error == ESP_OK) {
        const esp_timer_create_args_t timer_arguments = {
            .callback = &stop_timer_callback,
            .arg = nullptr,
            .dispatch_method = ESP_TIMER_TASK,
            .name = "buzzer_stop",
            // A sound-stop deadline is safety-relevant and must wake the CPU.
            .skip_unhandled_events = false,
        };
        error = esp_timer_create(&timer_arguments, &stop_timer);
    }
    if (error != ESP_OK) {
        cleanup_failed_init_locked();
        return error;
    }

    completion_callback = nullptr;
    stop_deadline_us = 0;
    active.store(false, std::memory_order_release);
    initialized = true;
    ESP_LOGI(LOG_TAG, "CPT-9019A drive ready on GPIO%d at %d Hz",
             CONFIG_PINQEVA_BUZZER_GPIO, CONFIG_PINQEVA_BUZZER_FREQUENCY_HZ);
    return ESP_OK;
}

esp_err_t buzzer_start(uint32_t duration_ms, BuzzerCompletionCallback callback) {
    std::lock_guard<std::mutex> guard(state_mutex);
    if (!initialized || !output_healthy || stop_timer == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    if (duration_ms < MIN_DURATION_MS || duration_ms > MAX_DURATION_MS) {
        return ESP_ERR_INVALID_ARG;
    }
    // The test and transition share one mutex: duplicate requests cannot extend
    // the deadline, replace the callback, or start a second tone concurrently.
    if (active.load(std::memory_order_acquire)) return ESP_ERR_INVALID_STATE;

    esp_err_t error = acquire_power_locked();
    if (error != ESP_OK) return error;
    // Recalculate after locking APB: initialization may have run at a lower
    // DFS frequency, and its divider must not turn 4 kHz into a different tone.
    error = ledc_set_freq(SPEED_MODE, TIMER, CONFIG_PINQEVA_BUZZER_FREQUENCY_HZ);
    // These two calls are serialized by state_mutex. The combined IDF API
    // requires the fade service, which a fixed-frequency piezo does not need.
    if (error == ESP_OK) error = ledc_set_duty(SPEED_MODE, CHANNEL, ACTIVE_DUTY);
    if (error == ESP_OK) error = ledc_update_duty(SPEED_MODE, CHANNEL);
    const int64_t started_at_us = esp_timer_get_time();
    if (error == ESP_OK) error = ledc_timer_resume(SPEED_MODE, TIMER);
    if (error == ESP_OK) {
        stop_deadline_us = started_at_us + static_cast<int64_t>(duration_ms) * 1000LL;
        completion_callback = callback;
        active.store(true, std::memory_order_release);
        const int64_t remaining_us = stop_deadline_us - esp_timer_get_time();
        error = remaining_us > 0
                    ? esp_timer_start_once(stop_timer, static_cast<uint64_t>(remaining_us))
                    : ESP_ERR_TIMEOUT;
    }
    if (error != ESP_OK) finish_locked();
    return error;
}

esp_err_t buzzer_stop() {
    std::lock_guard<std::mutex> guard(state_mutex);
    if (!initialized || stop_timer == nullptr) return ESP_ERR_INVALID_STATE;

    const bool was_active = active.load(std::memory_order_acquire);
    const esp_err_t timer_error = esp_timer_stop(stop_timer);
    const esp_err_t output_error = finish_locked();
    if (output_error != ESP_OK) return output_error;
    if (timer_error != ESP_OK && timer_error != ESP_ERR_INVALID_STATE) {
        return timer_error;
    }
    return was_active ? ESP_OK : ESP_ERR_INVALID_STATE;
}

bool buzzer_is_active() {
    return active.load(std::memory_order_acquire);
}
