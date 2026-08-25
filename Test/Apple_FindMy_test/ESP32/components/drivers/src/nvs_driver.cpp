#include "nvs_driver.hpp"

#include <cstring>
#include <initializer_list>

#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#ifndef CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
#define CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP 0
#endif

namespace {
constexpr char STORAGE_NAMESPACE[] = "pinqeva";
constexpr char KEY_BLOB[] = "adv_key";
constexpr char CONTROL_KEY_BLOB[] = "control_key";
constexpr char BOOTSTRAP_KEY_BLOB[] = "boot_key";
constexpr char ENTITLEMENT_BLOB[] = "entitlement";
constexpr char TRUSTED_CLOCK_KEY[] = "clock_utc";
constexpr char FORMAT_KEY[] = "prov_ver";
constexpr uint8_t FORMAT_VERSION = 1;
}  // namespace

esp_err_t nvs_init() {
    // Provisioning data must not disappear because NVS is full or was created
    // by an incompatible firmware. Recovery/factory reset is explicit instead.
    return nvs_flash_init();
}

bool advertisement_key_is_valid(const uint8_t *key, size_t length) {
    if (key == nullptr || length != ADVERTISEMENT_KEY_SIZE) {
        return false;
    }

    bool all_zero = true;
    bool all_erased = true;
    for (size_t i = 0; i < length; ++i) {
        all_zero = all_zero && key[i] == 0x00;
        all_erased = all_erased && key[i] == 0xFF;
    }
    return !all_zero && !all_erased;
}

esp_err_t load_advertisement_key(uint8_t *destination, size_t destination_size) {
    if (destination == nullptr || destination_size != ADVERTISEMENT_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (error != ESP_OK) {
        return error;
    }

    uint8_t version = 0;
    error = nvs_get_u8(handle, FORMAT_KEY, &version);
    if (error != ESP_OK || version != FORMAT_VERSION) {
        nvs_close(handle);
        return error == ESP_OK ? ESP_ERR_INVALID_VERSION : error;
    }

    size_t stored_size = destination_size;
    error = nvs_get_blob(handle, KEY_BLOB, destination, &stored_size);
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }
    if (stored_size != ADVERTISEMENT_KEY_SIZE ||
        !advertisement_key_is_valid(destination, stored_size)) {
        std::memset(destination, 0, destination_size);
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

esp_err_t load_tag_control_key(uint8_t *destination, size_t destination_size) {
    if (destination == nullptr || destination_size != TAG_CONTROL_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (error != ESP_OK) {
        return error;
    }
    size_t stored_size = destination_size;
    error = nvs_get_blob(handle, CONTROL_KEY_BLOB, destination, &stored_size);
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }
    bool all_zero = true;
    bool all_erased = true;
    for (size_t index = 0; index < stored_size; ++index) {
        all_zero = all_zero && destination[index] == 0x00;
        all_erased = all_erased && destination[index] == 0xFF;
    }
    if (stored_size != TAG_CONTROL_KEY_SIZE || all_zero || all_erased) {
        std::memset(destination, 0, destination_size);
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

esp_err_t load_device_bootstrap_key(uint8_t *destination,
                                    size_t destination_size) {
    if (destination == nullptr || destination_size != DEVICE_BOOTSTRAP_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (error != ESP_OK) {
        return error;
    }
    size_t stored_size = destination_size;
    error = nvs_get_blob(handle, BOOTSTRAP_KEY_BLOB, destination, &stored_size);
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }
    bool all_zero = true;
    bool all_erased = true;
    for (size_t index = 0; index < stored_size; ++index) {
        all_zero = all_zero && destination[index] == 0x00;
        all_erased = all_erased && destination[index] == 0xFF;
    }
    if (stored_size != DEVICE_BOOTSTRAP_KEY_SIZE || all_zero || all_erased) {
        std::memset(destination, 0, destination_size);
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

esp_err_t load_subscription_entitlement(uint8_t *destination,
                                        size_t destination_size) {
    if (destination == nullptr ||
        destination_size != SUBSCRIPTION_ENTITLEMENT_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (error != ESP_OK) {
        return error;
    }
    size_t stored_size = destination_size;
    error = nvs_get_blob(handle, ENTITLEMENT_BLOB, destination, &stored_size);
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }
    bool all_zero = true;
    bool all_erased = true;
    for (size_t index = 0; index < stored_size; ++index) {
        all_zero = all_zero && destination[index] == 0x00;
        all_erased = all_erased && destination[index] == 0xFF;
    }
    if (stored_size != SUBSCRIPTION_ENTITLEMENT_SIZE || all_zero || all_erased) {
        std::memset(destination, 0, destination_size);
        return ESP_ERR_INVALID_SIZE;
    }
    return ESP_OK;
}

esp_err_t load_trusted_clock_epoch(uint64_t *epoch_seconds) {
    if (epoch_seconds == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (error != ESP_OK) {
        return error;
    }
    uint64_t stored_epoch = 0;
    error = nvs_get_u64(handle, TRUSTED_CLOCK_KEY, &stored_epoch);
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }
    if (stored_epoch == 0) {
        return ESP_ERR_INVALID_STATE;
    }
    *epoch_seconds = stored_epoch;
    return ESP_OK;
}

esp_err_t save_tag_control_key(const uint8_t *key, size_t length) {
    if (key == nullptr || length != TAG_CONTROL_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    uint8_t existing[TAG_CONTROL_KEY_SIZE] = {};
    esp_err_t existing_result = load_tag_control_key(existing, sizeof(existing));
    if (existing_result == ESP_OK) {
        bool matches = std::memcmp(existing, key, TAG_CONTROL_KEY_SIZE) == 0;
        std::memset(existing, 0, sizeof(existing));
        return matches ? ESP_OK : ESP_ERR_INVALID_STATE;
    }
    std::memset(existing, 0, sizeof(existing));
    if (existing_result != ESP_ERR_NVS_NOT_FOUND &&
        existing_result != ESP_ERR_NVS_INVALID_HANDLE &&
        existing_result != ESP_ERR_INVALID_SIZE) {
        return existing_result;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) {
        return error;
    }
    error = nvs_set_blob(handle, CONTROL_KEY_BLOB, key, length);
    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }

    uint8_t read_back[TAG_CONTROL_KEY_SIZE] = {};
    error = load_tag_control_key(read_back, sizeof(read_back));
    bool matches = error == ESP_OK &&
                   std::memcmp(read_back, key, TAG_CONTROL_KEY_SIZE) == 0;
    std::memset(read_back, 0, sizeof(read_back));
    return matches ? ESP_OK : ESP_ERR_INVALID_CRC;
}

esp_err_t save_advertisement_key(const uint8_t *key, size_t length) {
    if (length != ADVERTISEMENT_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    if (!advertisement_key_is_valid(key, length)) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t control_key[TAG_CONTROL_KEY_SIZE] = {};
    esp_err_t control_result =
        load_tag_control_key(control_key, sizeof(control_key));
    std::memset(control_key, 0, sizeof(control_key));
    if (control_result != ESP_OK) {
        return ESP_ERR_INVALID_STATE;
    }

    uint8_t existing[ADVERTISEMENT_KEY_SIZE] = {};
    esp_err_t existing_result =
        load_advertisement_key(existing, sizeof(existing));
    if (existing_result == ESP_OK) {
        // Never replace a provisioned key through the ordinary write path.
        return ESP_ERR_INVALID_STATE;
    }
    if (existing_result != ESP_ERR_NVS_NOT_FOUND &&
        existing_result != ESP_ERR_NVS_INVALID_HANDLE &&
        existing_result != ESP_ERR_INVALID_VERSION &&
        existing_result != ESP_ERR_INVALID_SIZE) {
        return existing_result;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) {
        return error;
    }

    error = nvs_set_blob(handle, KEY_BLOB, key, length);
    if (error == ESP_OK) {
        error = nvs_set_u8(handle, FORMAT_KEY, FORMAT_VERSION);
    }
    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }

    uint8_t read_back[ADVERTISEMENT_KEY_SIZE] = {};
    error = load_advertisement_key(read_back, sizeof(read_back));
    bool matches = error == ESP_OK &&
                   std::memcmp(read_back, key, ADVERTISEMENT_KEY_SIZE) == 0;
    std::memset(read_back, 0, sizeof(read_back));
    return matches ? ESP_OK : ESP_ERR_INVALID_CRC;
}

esp_err_t save_subscription_entitlement(const uint8_t *entitlement,
                                         size_t length) {
    if (entitlement == nullptr || length != SUBSCRIPTION_ENTITLEMENT_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    bool all_zero = true;
    bool all_erased = true;
    for (size_t index = 0; index < length; ++index) {
        all_zero = all_zero && entitlement[index] == 0x00;
        all_erased = all_erased && entitlement[index] == 0xFF;
    }
    if (all_zero || all_erased) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) {
        return error;
    }
    error = nvs_set_blob(handle, ENTITLEMENT_BLOB, entitlement, length);
    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }

    uint8_t read_back[SUBSCRIPTION_ENTITLEMENT_SIZE] = {};
    error = load_subscription_entitlement(read_back, sizeof(read_back));
    bool matches = error == ESP_OK &&
                   std::memcmp(read_back, entitlement,
                               SUBSCRIPTION_ENTITLEMENT_SIZE) == 0;
    std::memset(read_back, 0, sizeof(read_back));
    return matches ? ESP_OK : ESP_ERR_INVALID_CRC;
}

esp_err_t save_trusted_clock_epoch(uint64_t epoch_seconds) {
    if (epoch_seconds == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    uint64_t existing_epoch = 0;
    esp_err_t existing_result = load_trusted_clock_epoch(&existing_epoch);
    if (existing_result == ESP_OK) {
        if (epoch_seconds < existing_epoch) {
            return ESP_ERR_INVALID_STATE;
        }
        if (epoch_seconds == existing_epoch) {
            return ESP_OK;
        }
    } else if (existing_result != ESP_ERR_NVS_NOT_FOUND &&
               existing_result != ESP_ERR_NVS_INVALID_HANDLE &&
               existing_result != ESP_ERR_INVALID_STATE) {
        return existing_result;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) {
        return error;
    }
    error = nvs_set_u64(handle, TRUSTED_CLOCK_KEY, epoch_seconds);
    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }

    uint64_t read_back = 0;
    error = load_trusted_clock_epoch(&read_back);
    return error == ESP_OK && read_back == epoch_seconds
               ? ESP_OK
               : ESP_ERR_INVALID_CRC;
}

esp_err_t erase_provisioning_data() {
    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) {
        return error;
    }
    for (const char *key : {
             KEY_BLOB, CONTROL_KEY_BLOB, ENTITLEMENT_BLOB, FORMAT_KEY}) {
        esp_err_t erase_result = nvs_erase_key(handle, key);
        if (erase_result != ESP_OK && erase_result != ESP_ERR_NVS_NOT_FOUND) {
            error = erase_result;
            break;
        }
    }
    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }

    uint8_t advertisement_key[ADVERTISEMENT_KEY_SIZE] = {};
    uint8_t control_key[TAG_CONTROL_KEY_SIZE] = {};
    uint8_t entitlement[SUBSCRIPTION_ENTITLEMENT_SIZE] = {};
    esp_err_t advertisement_result =
        load_advertisement_key(advertisement_key, sizeof(advertisement_key));
    esp_err_t control_result =
        load_tag_control_key(control_key, sizeof(control_key));
    esp_err_t entitlement_result =
        load_subscription_entitlement(entitlement, sizeof(entitlement));
#if CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
    esp_err_t bootstrap_result = ESP_OK;
#else
    uint8_t bootstrap_key[DEVICE_BOOTSTRAP_KEY_SIZE] = {};
    esp_err_t bootstrap_result =
        load_device_bootstrap_key(bootstrap_key, sizeof(bootstrap_key));
#endif
    std::memset(advertisement_key, 0, sizeof(advertisement_key));
    std::memset(control_key, 0, sizeof(control_key));
    std::memset(entitlement, 0, sizeof(entitlement));
#if !CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
    std::memset(bootstrap_key, 0, sizeof(bootstrap_key));
#endif
    if (advertisement_result == ESP_OK || control_result == ESP_OK ||
        entitlement_result == ESP_OK ||
        bootstrap_result != ESP_OK) {
        return ESP_ERR_INVALID_STATE;
    }
    return ESP_OK;
}
