#pragma once
inline void stub_log(const char *, const char *, ...) {}
#define ESP_LOGE(...) stub_log(__VA_ARGS__)
#define ESP_LOGI(...) stub_log(__VA_ARGS__)
