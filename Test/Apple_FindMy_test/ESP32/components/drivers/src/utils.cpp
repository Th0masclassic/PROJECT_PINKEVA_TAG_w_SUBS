#include <stdio.h>
#include "utils.hpp"
#include "driver/gpio.h"
#include <atomic>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"


// Class refered to the LED 
std::atomic<bool> ERROR_LED::active{false};

void ERROR_LED::blink(int times, int delay_ms, bool critical, ERROR_TAG *tag)
{
    bool expected = false;

    if (!active.compare_exchange_strong(expected, true))
    {
        return;
    }

    for (int i = 0; i < times; ++i)
        {
            if (!active.load())
                break;

            // TUrn on the LED
            gpio_set_level(LED_PIN, 1);

            if (!delay_led(delay_ms))
                break;

            // Turn off the LED
            gpio_set_level(LED_PIN, 0);

            if (!delay_led(delay_ms))
                break;

            if (tag) {
                tag->log_error();
            }
        }

    gpio_set_level(LED_PIN, 0);
    active.store(false);
}   

bool ERROR_LED::delay_led(int delay_ms)
{
    const int check_interval_ms = 10;
    int elapsed = 0;

    while (elapsed < delay_ms)
    {
        if (!active.load())
        {
            return false;
        }

        int remaining = delay_ms - elapsed;
        int wait_ms = remaining < check_interval_ms
                          ? remaining
                          : check_interval_ms;

        TickType_t ticks = pdMS_TO_TICKS(wait_ms);

        if (ticks == 0)
        {
            ticks = 1;
        }

        vTaskDelay(ticks);

        elapsed += wait_ms;
    }

    return true;
}

bool ERROR_LED::is_active() {
    return active.load();
}



esp_err_t init_led() {
    // Initialize the LED GPIO pin
    esp_err_t ret = gpio_reset_pin(LED_PIN);
    if (ret != ESP_OK) {
        return ret;
    }
    
    // Set the pin as output
    ret = gpio_set_direction(LED_PIN, GPIO_MODE_OUTPUT);

    // Turn off the LED initially
    gpio_set_level(LED_PIN, 0);

    // Return ESP_OK if successful, otherwise return an error code
    return ret;
}
