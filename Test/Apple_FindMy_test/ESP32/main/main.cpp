#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "esp_err.h"
#include "esp_log.h"
#include "ble_driver.hpp"
#include "utils.hpp"

// Variable to hold the tag for logging
const char *TAG = "APP_MAIN";


void task_blink_led(void *pvParameters)
{
    ERROR_LED *error_led = (ERROR_LED *)pvParameters;
    error_led->blink(3, 500, true, new ERROR_TAG("Critical error detected", "TEST_TAG"));
    vTaskDelay(pdMS_TO_TICKS(100000));
    vTaskDelete(NULL);
}

void task_ble_init(void *pvParameters)
{
    std::optional<ERROR_TAG> error = ble_init();
    if (error.has_value()) {
        error->log_error();
        ERROR_LED error_led;
        error_led.blink(3, 500, true, &error.value());
    }
    vTaskDelete(NULL);
}

extern "C" void app_main(void)
{
    ESP_LOGI(TAG, "Starting application...");
    ESP_ERROR_CHECK(init_led());
    xTaskCreate(task_ble_init, "ble_init_task", 2048 * 4, NULL, 5, NULL);
}
