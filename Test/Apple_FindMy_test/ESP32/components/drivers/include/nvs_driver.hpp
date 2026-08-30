#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

constexpr size_t ADVERTISEMENT_KEY_SIZE = 28;
constexpr size_t GOOGLE_ADVERTISEMENT_KEY_SIZE = 20;
constexpr size_t TAG_CONTROL_KEY_SIZE = 32;
constexpr size_t DEVICE_BOOTSTRAP_KEY_SIZE = 32;

enum class FindingNetwork : uint8_t {
    APPLE = 0x01,
    GOOGLE = 0x02,
};

/** Initialize the NVS partition used for finder identities and control data. */
esp_err_t nvs_init();

bool advertisement_key_is_valid(const uint8_t *key, size_t length);
bool google_advertisement_key_is_valid(const uint8_t *key, size_t length);

esp_err_t load_advertisement_key(uint8_t *destination,
                                 size_t destination_size);
esp_err_t load_google_advertisement_key(uint8_t *destination,
                                        size_t destination_size);
esp_err_t load_finding_network(FindingNetwork *network);
esp_err_t load_tag_control_key(uint8_t *destination, size_t destination_size);
esp_err_t load_device_bootstrap_key(uint8_t *destination,
                                    size_t destination_size);
esp_err_t load_trusted_clock_epoch(uint64_t *epoch_seconds);

/** Save once; an identical retry is accepted and replacement is rejected. */
esp_err_t save_tag_control_key(const uint8_t *key, size_t length);
esp_err_t save_advertisement_key(const uint8_t *key, size_t length);
esp_err_t save_google_advertisement_key(const uint8_t *key, size_t length);
esp_err_t save_finding_network(FindingNetwork network);

esp_err_t save_trusted_clock_epoch(uint64_t epoch_seconds);

/** Erase both finding identities while preserving the factory bootstrap key. */
esp_err_t erase_provisioning_data();
