#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_pm.h"
#include "ble_driver.hpp"
#include "sdkconfig.h"
#include "utils.hpp"

// Variable to hold the tag for logging
const char *TAG = "APP_MAIN";
TaskHandle_t maintenance_button_task_handle = nullptr;


bool maintenance_button_pressed()
{
    const int level = gpio_get_level(
        static_cast<gpio_num_t>(CONFIG_PINQEVA_MAINTENANCE_BUTTON_GPIO));
#if CONFIG_PINQEVA_MAINTENANCE_BUTTON_ACTIVE_LOW
    return level == 0;
#else
    return level != 0;
#endif
}

void IRAM_ATTR maintenance_button_isr(void *)
{
    BaseType_t higher_priority_task_woken = pdFALSE;
    vTaskNotifyGiveFromISR(
        maintenance_button_task_handle, &higher_priority_task_woken);
    if (higher_priority_task_woken == pdTRUE) {
        portYIELD_FROM_ISR();
    }
}

void task_maintenance_button(void *)
{
    constexpr TickType_t SAMPLE_INTERVAL = pdMS_TO_TICKS(50);
    const TickType_t required_hold =
        pdMS_TO_TICKS(CONFIG_PINQEVA_MAINTENANCE_BUTTON_HOLD_MS);
    while (true) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        vTaskDelay(pdMS_TO_TICKS(30));
        if (!maintenance_button_pressed()) continue;

        const TickType_t pressed_at = xTaskGetTickCount();
        bool opened = false;
        while (maintenance_button_pressed()) {
            if (!opened && xTaskGetTickCount() - pressed_at >= required_hold) {
                const esp_err_t error = ble_open_maintenance_window();
                if (error == ESP_OK) {
                    opened = true;
                } else if (error != ESP_ERR_INVALID_STATE) {
                    ESP_LOGE(TAG, "Could not open BLE maintenance: %s",
                             esp_err_to_name(error));
                    opened = true;
                }
            }
            vTaskDelay(SAMPLE_INTERVAL);
        }
    }
}

esp_err_t init_maintenance_button()
{
    const gpio_num_t button_gpio =
        static_cast<gpio_num_t>(CONFIG_PINQEVA_MAINTENANCE_BUTTON_GPIO);
    const gpio_config_t configuration = {
        .pin_bit_mask = 1ULL << button_gpio,
        .mode = GPIO_MODE_INPUT,
#if CONFIG_PINQEVA_MAINTENANCE_BUTTON_ACTIVE_LOW
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_NEGEDGE,
#else
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
        .intr_type = GPIO_INTR_POSEDGE,
#endif
    };
    esp_err_t error = gpio_config(&configuration);
    if (error != ESP_OK) return error;
    if (xTaskCreate(task_maintenance_button, "maintenance_button", 2048,
                    nullptr, 4, &maintenance_button_task_handle) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    error = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
    if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) return error;
    return gpio_isr_handler_add(button_gpio, maintenance_button_isr, nullptr);
}


void task_blink_led(void *pvParameters)
{
    ERROR_LED *error_led = (ERROR_LED *)pvParameters;
    error_led->blink(3, 500, true, new ERROR_TAG("Critical error detected", "TEST_TAG"));
    vTaskDelay(pdMS_TO_TICKS(100000));
    vTaskDelete(NULL);
}

void task_ble_init(void *pvParameters)
{
    constexpr TickType_t BLE_READY_TIMEOUT = pdMS_TO_TICKS(10000);
    constexpr TickType_t BLE_READY_POLL_INTERVAL = pdMS_TO_TICKS(50);
    const esp_partition_t *running_partition = esp_ota_get_running_partition();
    esp_ota_img_states_t running_state = ESP_OTA_IMG_UNDEFINED;
    const bool pending_ota_validation =
        running_partition != nullptr &&
        esp_ota_get_state_partition(running_partition, &running_state) == ESP_OK &&
        running_state == ESP_OTA_IMG_PENDING_VERIFY;
    std::optional<ERROR_TAG> error = ble_init();
    if (error.has_value()) {
        error->log_error();
        if (pending_ota_validation) {
            ESP_LOGE(TAG, "New OTA image failed initialization; rolling back");
            esp_ota_mark_app_invalid_rollback_and_reboot();
        }
        ERROR_LED error_led;
        error_led.blink(3, 500, true, &error.value());
        vTaskDelete(NULL);
        return;
    }

    if (pending_ota_validation) {
        const TickType_t ready_started_at = xTaskGetTickCount();
        while (!ble_service_ready() &&
               xTaskGetTickCount() - ready_started_at < BLE_READY_TIMEOUT) {
            vTaskDelay(BLE_READY_POLL_INTERVAL);
        }
        if (!ble_service_ready()) {
            ESP_LOGE(TAG, "New OTA image did not start its GATT service; rolling back");
            esp_ota_mark_app_invalid_rollback_and_reboot();
            vTaskDelete(NULL);
            return;
        }

        // Let the phone reconnect after the reboot and verify the running
        // version before it acknowledges installation to the backend.
        const esp_err_t maintenance_result = ble_open_maintenance_window();
        if (maintenance_result != ESP_OK) {
            ESP_LOGE(TAG, "New OTA image could not open maintenance: %s",
                     esp_err_to_name(maintenance_result));
            esp_ota_mark_app_invalid_rollback_and_reboot();
            vTaskDelete(NULL);
            return;
        }

        const esp_err_t validation_result =
            esp_ota_mark_app_valid_cancel_rollback();
        if (validation_result != ESP_OK) {
            ESP_LOGE(TAG, "Could not confirm OTA image: %s; rolling back",
                     esp_err_to_name(validation_result));
            esp_ota_mark_app_invalid_rollback_and_reboot();
            vTaskDelete(NULL);
            return;
        }
    }
    vTaskDelete(NULL);
}

extern "C" void app_main(void)
{
    ESP_LOGI(TAG, "Starting application...");
#if CONFIG_PM_ENABLE
    const esp_pm_config_t power_configuration = {
        .max_freq_mhz = CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ,
        .min_freq_mhz = 40,
        .light_sleep_enable = true,
    };
    ESP_ERROR_CHECK(esp_pm_configure(&power_configuration));
#endif
    ESP_ERROR_CHECK(init_led());
    ESP_ERROR_CHECK(init_maintenance_button());
    xTaskCreate(task_ble_init, "ble_init_task", 2048 * 4, NULL, 5, NULL);
}
