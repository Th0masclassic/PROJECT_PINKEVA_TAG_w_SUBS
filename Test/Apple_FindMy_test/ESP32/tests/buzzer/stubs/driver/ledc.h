#pragma once
#include <cstdint>
#include "esp_err.h"
enum ledc_mode_t { LEDC_LOW_SPEED_MODE };
enum ledc_timer_t { LEDC_TIMER_0 };
enum ledc_channel_t { LEDC_CHANNEL_0 };
enum ledc_timer_bit_t { LEDC_TIMER_10_BIT = 10 };
enum ledc_clk_cfg_t { LEDC_USE_APB_CLK };
enum ledc_intr_type_t { LEDC_INTR_DISABLE };
enum ledc_sleep_mode_t { LEDC_SLEEP_MODE_NO_ALIVE_NO_PD };
struct ledc_timer_config_t {
    ledc_mode_t speed_mode;
    ledc_timer_bit_t duty_resolution;
    ledc_timer_t timer_num;
    uint32_t freq_hz;
    ledc_clk_cfg_t clk_cfg;
    bool deconfigure;
};
struct ledc_channel_config_t {
    int gpio_num;
    ledc_mode_t speed_mode;
    ledc_channel_t channel;
    ledc_intr_type_t intr_type;
    ledc_timer_t timer_sel;
    uint32_t duty;
    int hpoint;
    ledc_sleep_mode_t sleep_mode;
    struct { unsigned int output_invert : 1; } flags;
};
esp_err_t ledc_timer_config(const ledc_timer_config_t *);
esp_err_t ledc_channel_config(const ledc_channel_config_t *);
esp_err_t ledc_stop(ledc_mode_t, ledc_channel_t, uint32_t);
esp_err_t ledc_timer_pause(ledc_mode_t, ledc_timer_t);
esp_err_t ledc_timer_resume(ledc_mode_t, ledc_timer_t);
esp_err_t ledc_set_freq(ledc_mode_t, ledc_timer_t, uint32_t);
esp_err_t ledc_set_duty(ledc_mode_t, ledc_channel_t, uint32_t);
esp_err_t ledc_update_duty(ledc_mode_t, ledc_channel_t);
