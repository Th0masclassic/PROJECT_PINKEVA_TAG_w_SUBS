#pragma once
#include "esp_err.h"
enum esp_pm_lock_type_t { ESP_PM_APB_FREQ_MAX, ESP_PM_NO_LIGHT_SLEEP };
struct FakePmLock;
using esp_pm_lock_handle_t = FakePmLock *;
esp_err_t esp_pm_lock_create(esp_pm_lock_type_t, int, const char *, esp_pm_lock_handle_t *);
esp_err_t esp_pm_lock_acquire(esp_pm_lock_handle_t);
esp_err_t esp_pm_lock_release(esp_pm_lock_handle_t);
esp_err_t esp_pm_lock_delete(esp_pm_lock_handle_t);
