
#pragma once

#include <atomic>
#include "driver/gpio.h"
#include "esp_log.h"

#define LED_PIN GPIO_NUM_2

class ERROR_TAG {
    public:
        ERROR_TAG(const char* message, const char *tag) : message(message), tag(tag) {}
        const char* get_message() const { return message; }
        const char* get_tag() const { return tag; }
        void log_error() const {
            ESP_LOGE(tag, "%s", message);
        }
    private:
        const char* message;
        const char *tag;
};
    
class ERROR_LED 
{
    public:
    /** @brief This function activates the LED on ESP32 and blinks it for a specified number of times indicating error status and then repeats
     *  @note This function can be used to indicate status of errors at the initializing of the ESP32 device.
     *  @param times Number of times to blink the LED
     *  @param delay_ms Delay in milliseconds between each blink
     *  @param critical Boolean flag indicating if the error is critical. if Critical firmware will not be running after the error detected
     *  @param tag Pointer to an ERROR_TAG instance containing the error message
     * 
     */
    void blink(int times, int delay_ms, bool critical = true, ERROR_TAG *tag = nullptr);

    /** @brief method to check if the led is currently active and blinking
     *  @return true if the led is currently active and blinking, false otherwise
     */
    bool is_active();
    
    /** @brief method to stop the led from blinking
     *  @note this method will stop the led from blinking and turn it off
     */
    void stop_blinking() {
        active = false;
    }

    private:
        static std::atomic<bool> active;

        /** @brief method to delay the LED blinking for a specified number of milliseconds. 
         *  @note Every millisecond the function will check if the LED is still active. If not it will return and stop active loops that are blinking the LED
         *  @param delay_ms Delay in milliseconds between each blink
         *  @return true if the delay was successful, false otherwise
         */
        bool delay_led(int delay_ms);
};

/**
 * @brief function to initialize the LED pin as output
 * @return ESP_OK if the initialization was successful, ESP_FAIL otherwise
 */
esp_err_t init_led();


