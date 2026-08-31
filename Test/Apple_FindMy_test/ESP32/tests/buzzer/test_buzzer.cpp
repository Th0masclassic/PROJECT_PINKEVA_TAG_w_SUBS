#include <atomic>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "buzzer.hpp"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_pm.h"
#include "esp_timer.h"
#include "sdkconfig.h"

#define CHECK(condition) do { if (!(condition)) { \
    std::cerr << __FILE__ << ":" << __LINE__ << ": " #condition "\n"; \
    std::abort(); \
} } while (false)

struct FakeTimer {
    esp_timer_cb_t callback = nullptr;
    void *arg = nullptr;
    bool armed = false;
    int64_t deadline = 0;
};
struct FakePmLock {
    esp_pm_lock_type_t type;
    int acquired = 0;
};

namespace {
std::atomic<int64_t> now_us{1000000};
FakeTimer *timer = nullptr;
std::string fail_at;
int failures_left = 0;
int live_pm_locks = 0;
int acquired_pm_locks = 0;
int live_timers = 0;
int timer_start_count = 0;
bool pwm_timer_configured = false;
bool pwm_paused = true;
bool pwm_output_enabled = false;
bool gpio_attached_to_ledc = false;
uint32_t gpio_level = 0;
uint32_t pending_duty = 0;
uint32_t pwm_duty = 0;
std::atomic<int> completions{0};
std::atomic<int> wrong_completions{0};

bool fail(const char *operation) {
    if (fail_at == operation && failures_left > 0) {
        --failures_left;
        return true;
    }
    return false;
}

void fail_once(const std::string &operation) {
    fail_at = operation;
    failures_left = 1;
}

void completed() {
    // The driver must release its mutex before invoking application callbacks.
    CHECK(!buzzer_is_active());
    CHECK(buzzer_init() == ESP_OK);
    ++completions;
}

void wrong_completed() { ++wrong_completions; }

void assert_silent() {
    CHECK(!buzzer_is_active());
    CHECK(!pwm_output_enabled || !gpio_attached_to_ledc);
    CHECK(pwm_paused);
    CHECK(gpio_level == 0);
    CHECK(acquired_pm_locks == 0);
}

void assert_audible() {
    CHECK(buzzer_is_active());
    CHECK(pwm_output_enabled);
    CHECK(gpio_attached_to_ledc);
    CHECK(!pwm_paused);
    CHECK(pwm_duty == 512);
#if CONFIG_PM_ENABLE
    CHECK(acquired_pm_locks == 2);
#else
    CHECK(acquired_pm_locks == 0);
#endif
}

void fire_deadline() {
    CHECK(timer != nullptr && timer->armed);
    now_us.store(timer->deadline);
    timer->armed = false;
    timer->callback(timer->arg);
}

void init_ok() {
    CHECK(buzzer_start(10000) == ESP_ERR_INVALID_STATE);
    CHECK(buzzer_stop() == ESP_ERR_INVALID_STATE);
    CHECK(buzzer_init() == ESP_OK);
    CHECK(buzzer_init() == ESP_OK);
    CHECK(live_timers == 1);
#if CONFIG_PM_ENABLE
    CHECK(live_pm_locks == 2);
#else
    CHECK(live_pm_locks == 0);
#endif
    assert_silent();
}

void test_timing() {
    init_ok();
    CHECK(buzzer_start(99) == ESP_ERR_INVALID_ARG);
    CHECK(buzzer_start(30001) == ESP_ERR_INVALID_ARG);
    CHECK(timer_start_count == 0);
    CHECK(buzzer_start(10000, completed) == ESP_OK);
    CHECK(timer->deadline == now_us + 10000000);
    assert_audible();
    now_us += 9999999;
    CHECK(buzzer_is_active());
    CHECK(completions == 0);
    fire_deadline();
    assert_silent();
    CHECK(completions == 1);
    CHECK(!timer->armed);
    CHECK(buzzer_start(12000, completed) == ESP_OK);
    CHECK(timer->deadline == now_us + 12000000);
    fire_deadline();
    assert_silent();
    CHECK(completions == 2);
}

void test_duplicate() {
    init_ok();
    CHECK(buzzer_start(10000, completed) == ESP_OK);
    const int64_t deadline = timer->deadline;
    now_us += 9000000;
    CHECK(buzzer_start(10000, wrong_completed) == ESP_ERR_INVALID_STATE);
    CHECK(timer->deadline == deadline);
    CHECK(timer_start_count == 1);
    assert_audible();
    fire_deadline();
    CHECK(completions == 1);
    CHECK(wrong_completions == 0);
    assert_silent();
}

void test_pause() {
    init_ok();
    CHECK(buzzer_start(10000, completed) == ESP_OK);
    now_us += 4500000;
    CHECK(buzzer_stop() == ESP_OK);
    CHECK(!timer->armed);
    assert_silent();
    timer->callback(timer->arg);
    CHECK(completions == 0);
    CHECK(buzzer_stop() == ESP_ERR_INVALID_STATE);
    assert_silent();
}

void test_stale() {
    init_ok();
    CHECK(buzzer_start(10000, wrong_completed) == ESP_OK);
    now_us = timer->deadline;
    // Model an expiry dispatched by ESP timer but waiting for the driver mutex.
    const auto old_callback = timer->callback;
    void *const old_arg = timer->arg;
    timer->armed = false;
    CHECK(buzzer_stop() == ESP_OK);
    CHECK(buzzer_start(10000, completed) == ESP_OK);
    const int64_t new_deadline = timer->deadline;
    old_callback(old_arg);
    CHECK(timer->armed);
    CHECK(timer->deadline == new_deadline);
    CHECK(timer_start_count == 2);
    CHECK(completions == 0);
    CHECK(wrong_completions == 0);
    assert_audible();
    fire_deadline();
    CHECK(completions == 1);
    CHECK(wrong_completions == 0);
    assert_silent();
}

void test_early() {
    init_ok();
    CHECK(buzzer_start(10000, completed) == ESP_OK);
    const int64_t deadline = timer->deadline;
    now_us = deadline - 1;
    timer->armed = false;
    timer->callback(timer->arg);
    CHECK(timer->armed);
    CHECK(timer->deadline == deadline);
    CHECK(completions == 0);
    assert_audible();
    fire_deadline();
    CHECK(completions == 1);
    assert_silent();
}

void test_concurrent() {
    init_ok();
    std::atomic<bool> go{false};
    std::atomic<int> accepted{0};
    std::atomic<int> ignored{0};
    std::vector<std::thread> threads;
    for (int i = 0; i < 16; ++i) {
        threads.emplace_back([&] {
            while (!go.load()) std::this_thread::yield();
            const esp_err_t result = buzzer_start(10000, completed);
            if (result == ESP_OK) ++accepted;
            else if (result == ESP_ERR_INVALID_STATE) ++ignored;
            else CHECK(false);
        });
    }
    go = true;
    for (auto &thread : threads) thread.join();
    CHECK(accepted == 1);
    CHECK(ignored == 15);
    CHECK(timer_start_count == 1);
    assert_audible();
    fire_deadline();
    CHECK(completions == 1);
    assert_silent();
}

void test_stop_race() {
    init_ok();
    CHECK(buzzer_start(10000, completed) == ESP_OK);
    now_us = timer->deadline;
    timer->armed = false;
    std::atomic<bool> go{false};
    std::thread expiry([&] {
        while (!go.load()) std::this_thread::yield();
        timer->callback(timer->arg);
    });
    std::thread pause([&] {
        while (!go.load()) std::this_thread::yield();
        const esp_err_t result = buzzer_stop();
        CHECK(result == ESP_OK || result == ESP_ERR_INVALID_STATE);
    });
    go = true;
    expiry.join();
    pause.join();
    CHECK(completions == 0 || completions == 1);
    assert_silent();
}

void test_init_failure(const std::string &operation) {
    fail_once(operation);
    CHECK(buzzer_init() == ESP_FAIL);
    CHECK(!buzzer_is_active());
    CHECK(acquired_pm_locks == 0);
    CHECK(live_pm_locks == 0);
    CHECK(live_timers == 0);
    CHECK(!pwm_timer_configured);
    CHECK(!gpio_attached_to_ledc);
    CHECK(gpio_level == 0);
    CHECK(buzzer_init() == ESP_OK);
    assert_silent();
}

void test_start_failure(const std::string &operation) {
    init_ok();
    fail_once(operation);
    CHECK(buzzer_start(10000, completed) == ESP_FAIL);
    assert_silent();
    CHECK(!timer->armed);
    CHECK(completions == 0);
    CHECK(buzzer_start(10000, completed) == ESP_OK);
    fire_deadline();
    CHECK(completions == 1);
    assert_silent();
}

void test_stop_failure() {
    init_ok();
    CHECK(buzzer_start(10000, completed) == ESP_OK);
    fail_once("stop");
    CHECK(buzzer_stop() == ESP_FAIL);
    assert_silent();
    CHECK(!gpio_attached_to_ledc);
    CHECK(completions == 0);
    CHECK(buzzer_start(10000) == ESP_ERR_INVALID_STATE);
}
}  // namespace

esp_err_t gpio_reset_pin(gpio_num_t) {
    gpio_attached_to_ledc = false;
    return ESP_OK;
}
esp_err_t gpio_set_level(gpio_num_t, uint32_t level) {
    gpio_level = level;
    return ESP_OK;
}
esp_err_t gpio_set_direction(gpio_num_t, gpio_mode_t) { return ESP_OK; }

esp_err_t ledc_timer_config(const ledc_timer_config_t *config) {
    if (config->deconfigure) {
        CHECK(pwm_paused);
        pwm_timer_configured = false;
        return ESP_OK;
    }
    if (fail("timer_config")) return ESP_FAIL;
    CHECK(config->freq_hz == 4000);
    CHECK(config->clk_cfg == LEDC_USE_APB_CLK);
    CHECK(config->duty_resolution == LEDC_TIMER_10_BIT);
    pwm_timer_configured = true;
    pwm_paused = false;
    return ESP_OK;
}
esp_err_t ledc_channel_config(const ledc_channel_config_t *config) {
    if (fail("channel_config")) return ESP_FAIL;
    CHECK(config->duty == 0);
    CHECK(config->sleep_mode == LEDC_SLEEP_MODE_NO_ALIVE_NO_PD);
    gpio_attached_to_ledc = true;
    pwm_duty = config->duty;
    return ESP_OK;
}
esp_err_t ledc_stop(ledc_mode_t, ledc_channel_t, uint32_t idle) {
    CHECK(idle == 0);
    if (fail("stop")) return ESP_FAIL;
    pwm_output_enabled = false;
    gpio_level = idle;
    return ESP_OK;
}
esp_err_t ledc_timer_pause(ledc_mode_t, ledc_timer_t) {
    if (fail("pause")) return ESP_FAIL;
    pwm_paused = true;
    return ESP_OK;
}
esp_err_t ledc_timer_resume(ledc_mode_t, ledc_timer_t) {
    if (fail("resume")) return ESP_FAIL;
    pwm_paused = false;
    return ESP_OK;
}
esp_err_t ledc_set_freq(ledc_mode_t, ledc_timer_t, uint32_t frequency) {
#if CONFIG_PM_ENABLE
    CHECK(acquired_pm_locks == 2);
#endif
    CHECK(frequency == 4000);
    return fail("frequency") ? ESP_FAIL : ESP_OK;
}
esp_err_t ledc_set_duty(ledc_mode_t, ledc_channel_t, uint32_t duty) {
    if (fail("duty")) return ESP_FAIL;
    pending_duty = duty;
    return ESP_OK;
}
esp_err_t ledc_update_duty(ledc_mode_t, ledc_channel_t) {
    if (fail("update")) return ESP_FAIL;
    pwm_duty = pending_duty;
    pwm_output_enabled = true;
    return ESP_OK;
}

esp_err_t esp_pm_lock_create(esp_pm_lock_type_t type, int, const char *,
                            esp_pm_lock_handle_t *out) {
    if (fail(type == ESP_PM_APB_FREQ_MAX ? "apb_create" : "awake_create")) return ESP_FAIL;
    *out = new FakePmLock{type};
    ++live_pm_locks;
    return ESP_OK;
}
esp_err_t esp_pm_lock_acquire(esp_pm_lock_handle_t lock) {
    CHECK(lock != nullptr);
    if (fail(lock->type == ESP_PM_APB_FREQ_MAX ? "apb_acquire" : "awake_acquire")) return ESP_FAIL;
    CHECK(lock->acquired == 0);
    ++lock->acquired;
    ++acquired_pm_locks;
    return ESP_OK;
}
esp_err_t esp_pm_lock_release(esp_pm_lock_handle_t lock) {
    CHECK(lock != nullptr && lock->acquired == 1);
    --lock->acquired;
    --acquired_pm_locks;
    return ESP_OK;
}
esp_err_t esp_pm_lock_delete(esp_pm_lock_handle_t lock) {
    CHECK(lock != nullptr && lock->acquired == 0);
    delete lock;
    --live_pm_locks;
    return ESP_OK;
}
esp_err_t esp_timer_create(const esp_timer_create_args_t *config, esp_timer_handle_t *out) {
    if (fail("timer_create")) return ESP_FAIL;
    CHECK(!config->skip_unhandled_events);
    CHECK(config->dispatch_method == ESP_TIMER_TASK);
    timer = new FakeTimer{config->callback, config->arg};
    *out = timer;
    ++live_timers;
    return ESP_OK;
}
esp_err_t esp_timer_delete(esp_timer_handle_t handle) {
    CHECK(!handle->armed);
    delete handle;
    timer = nullptr;
    --live_timers;
    return ESP_OK;
}
esp_err_t esp_timer_start_once(esp_timer_handle_t handle, uint64_t duration) {
    if (fail("timer")) return ESP_FAIL;
    CHECK(!handle->armed);
    handle->armed = true;
    handle->deadline = now_us + static_cast<int64_t>(duration);
    ++timer_start_count;
    return ESP_OK;
}
esp_err_t esp_timer_stop(esp_timer_handle_t handle) {
    if (!handle->armed) return ESP_ERR_INVALID_STATE;
    handle->armed = false;
    return ESP_OK;
}
bool esp_timer_is_active(esp_timer_handle_t handle) { return handle->armed; }
int64_t esp_timer_get_time() { return now_us.load(); }

int main(int argc, char **argv) {
    CHECK(argc == 2);
    const std::string scenario = argv[1];
    if (scenario == "timing") test_timing();
    else if (scenario == "duplicate") test_duplicate();
    else if (scenario == "pause") test_pause();
    else if (scenario == "stale") test_stale();
    else if (scenario == "early") test_early();
    else if (scenario == "concurrent") test_concurrent();
    else if (scenario == "stop_race") test_stop_race();
    else if (scenario.rfind("init_", 0) == 0) test_init_failure(scenario.substr(5));
    else if (scenario.rfind("start_", 0) == 0) test_start_failure(scenario.substr(6));
    else if (scenario == "stop_output") test_stop_failure();
    else if (scenario == "invalid_gpio") {
        CHECK(buzzer_init() == ESP_ERR_INVALID_ARG);
        CHECK(live_timers == 0 && live_pm_locks == 0);
    } else CHECK(false);
    std::cout << "PASS " << scenario << "\n";
}
