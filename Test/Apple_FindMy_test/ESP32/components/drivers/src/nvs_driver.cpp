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
constexpr char APPLE_KEY_BLOB[] = "adv_key";
constexpr char GOOGLE_KEY_BLOB[] = "google_eid";
constexpr char FINDING_NETWORK_KEY[] = "find_net";
constexpr char CONTROL_KEY_BLOB[] = "control_key";
constexpr char BOOTSTRAP_KEY_BLOB[] = "boot_key";
constexpr char TRUSTED_CLOCK_KEY[] = "clock_utc";
constexpr char FORMAT_KEY[] = "prov_ver";
constexpr uint8_t FORMAT_VERSION = 1;
constexpr size_t MAX_IDENTITY_SIZE = TAG_CONTROL_KEY_SIZE;

bool blob_is_valid(const uint8_t *value, size_t length, size_t expected) {
    if (value == nullptr || length != expected) {
        return false;
    }
    bool all_zero = true;
    bool all_erased = true;
    for (size_t index = 0; index < length; ++index) {
        all_zero = all_zero && value[index] == 0x00;
        all_erased = all_erased && value[index] == 0xFF;
    }
    return !all_zero && !all_erased;
}

bool is_missing_value(esp_err_t error) {
    return error == ESP_ERR_NVS_NOT_FOUND ||
           error == ESP_ERR_NVS_INVALID_HANDLE ||
           error == ESP_ERR_NVS_INVALID_LENGTH ||
           error == ESP_ERR_INVALID_SIZE ||
           error == ESP_ERR_INVALID_VERSION;
}

esp_err_t load_blob(const char *key, uint8_t *destination,
                    size_t destination_size, bool require_format) {
    if (key == nullptr || destination == nullptr || destination_size == 0 ||
        destination_size > MAX_IDENTITY_SIZE) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (error != ESP_OK) {
        return error;
    }
    if (require_format) {
        uint8_t version = 0;
        error = nvs_get_u8(handle, FORMAT_KEY, &version);
        if (error != ESP_OK || version != FORMAT_VERSION) {
            nvs_close(handle);
            return error == ESP_OK ? ESP_ERR_INVALID_VERSION : error;
        }
    }
    size_t stored_size = destination_size;
    error = nvs_get_blob(handle, key, destination, &stored_size);
    nvs_close(handle);
    if (error != ESP_OK || stored_size != destination_size ||
        !blob_is_valid(destination, stored_size, destination_size)) {
        std::memset(destination, 0, destination_size);
        return error == ESP_OK ? ESP_ERR_INVALID_SIZE : error;
    }
    return ESP_OK;
}

esp_err_t require_control_key() {
    uint8_t control_key[TAG_CONTROL_KEY_SIZE] = {};
    esp_err_t error = load_blob(CONTROL_KEY_BLOB, control_key,
                                sizeof(control_key), false);
    std::memset(control_key, 0, sizeof(control_key));
    return error;
}

esp_err_t save_blob_once(const char *key, const uint8_t *value, size_t length,
                         bool require_control, bool write_format) {
    if (key == nullptr || !blob_is_valid(value, length, length) ||
        length > MAX_IDENTITY_SIZE) {
        return ESP_ERR_INVALID_ARG;
    }
    if (require_control && require_control_key() != ESP_OK) {
        return ESP_ERR_INVALID_STATE;
    }

    uint8_t existing[MAX_IDENTITY_SIZE] = {};
    esp_err_t existing_result = load_blob(key, existing, length, write_format);
    if (existing_result == ESP_OK) {
        const bool matches = std::memcmp(existing, value, length) == 0;
        std::memset(existing, 0, sizeof(existing));
        return matches ? ESP_OK : ESP_ERR_INVALID_STATE;
    }
    std::memset(existing, 0, sizeof(existing));
    if (!is_missing_value(existing_result)) {
        return existing_result;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) {
        return error;
    }
    error = nvs_set_blob(handle, key, value, length);
    if (error == ESP_OK && write_format) {
        error = nvs_set_u8(handle, FORMAT_KEY, FORMAT_VERSION);
    }
    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }

    uint8_t read_back[MAX_IDENTITY_SIZE] = {};
    error = load_blob(key, read_back, length, write_format);
    const bool matches =
        error == ESP_OK && std::memcmp(read_back, value, length) == 0;
    std::memset(read_back, 0, sizeof(read_back));
    return matches ? ESP_OK : ESP_ERR_INVALID_CRC;
}
}  // namespace

esp_err_t nvs_init() {
    return nvs_flash_init();
}

bool advertisement_key_is_valid(const uint8_t *key, size_t length) {
    return blob_is_valid(key, length, ADVERTISEMENT_KEY_SIZE);
}

bool google_advertisement_key_is_valid(const uint8_t *key, size_t length) {
    return blob_is_valid(key, length, GOOGLE_ADVERTISEMENT_KEY_SIZE);
}

esp_err_t load_advertisement_key(uint8_t *destination,
                                 size_t destination_size) {
    if (destination_size != ADVERTISEMENT_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    return load_blob(APPLE_KEY_BLOB, destination, destination_size, true);
}

esp_err_t load_google_advertisement_key(uint8_t *destination,
                                        size_t destination_size) {
    if (destination_size != GOOGLE_ADVERTISEMENT_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    return load_blob(GOOGLE_KEY_BLOB, destination, destination_size, false);
}

esp_err_t load_finding_network(FindingNetwork *network) {
    if (network == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READONLY, &handle);
    if (error != ESP_OK) {
        return error;
    }
    uint8_t value = 0;
    error = nvs_get_u8(handle, FINDING_NETWORK_KEY, &value);
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }
    if (value != static_cast<uint8_t>(FindingNetwork::APPLE) &&
        value != static_cast<uint8_t>(FindingNetwork::GOOGLE)) {
        return ESP_ERR_INVALID_STATE;
    }
    *network = static_cast<FindingNetwork>(value);
    return ESP_OK;
}

esp_err_t load_tag_control_key(uint8_t *destination, size_t destination_size) {
    if (destination_size != TAG_CONTROL_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    return load_blob(CONTROL_KEY_BLOB, destination, destination_size, false);
}

esp_err_t load_device_bootstrap_key(uint8_t *destination,
                                    size_t destination_size) {
    if (destination_size != DEVICE_BOOTSTRAP_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    return load_blob(BOOTSTRAP_KEY_BLOB, destination, destination_size, false);
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
    if (length != TAG_CONTROL_KEY_SIZE) {
        return ESP_ERR_INVALID_SIZE;
    }
    return save_blob_once(CONTROL_KEY_BLOB, key, length, false, false);
}

esp_err_t save_advertisement_key(const uint8_t *key, size_t length) {
    if (!advertisement_key_is_valid(key, length)) {
        return length == ADVERTISEMENT_KEY_SIZE ? ESP_ERR_INVALID_ARG
                                                : ESP_ERR_INVALID_SIZE;
    }
    return save_blob_once(APPLE_KEY_BLOB, key, length, true, true);
}

esp_err_t save_google_advertisement_key(const uint8_t *key, size_t length) {
    if (!google_advertisement_key_is_valid(key, length)) {
        return length == GOOGLE_ADVERTISEMENT_KEY_SIZE ? ESP_ERR_INVALID_ARG
                                                       : ESP_ERR_INVALID_SIZE;
    }
    return save_blob_once(GOOGLE_KEY_BLOB, key, length, true, false);
}

esp_err_t save_finding_network(FindingNetwork network) {
    if (network != FindingNetwork::APPLE && network != FindingNetwork::GOOGLE) {
        return ESP_ERR_INVALID_ARG;
    }
    if (require_control_key() != ESP_OK) {
        return ESP_ERR_INVALID_STATE;
    }

    FindingNetwork existing = FindingNetwork::APPLE;
    esp_err_t existing_result = load_finding_network(&existing);
    if (existing_result == ESP_OK) {
        return existing == network ? ESP_OK : ESP_ERR_INVALID_STATE;
    }
    if (!is_missing_value(existing_result) &&
        existing_result != ESP_ERR_INVALID_STATE) {
        return existing_result;
    }

    nvs_handle_t handle;
    esp_err_t error = nvs_open(STORAGE_NAMESPACE, NVS_READWRITE, &handle);
    if (error != ESP_OK) {
        return error;
    }
    error = nvs_set_u8(handle, FINDING_NETWORK_KEY,
                       static_cast<uint8_t>(network));
    if (error == ESP_OK) {
        error = nvs_commit(handle);
    }
    nvs_close(handle);
    if (error != ESP_OK) {
        return error;
    }
    FindingNetwork read_back = FindingNetwork::APPLE;
    error = load_finding_network(&read_back);
    return error == ESP_OK && read_back == network ? ESP_OK
                                                    : ESP_ERR_INVALID_CRC;
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
    } else if (!is_missing_value(existing_result) &&
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
    for (const char *key : {APPLE_KEY_BLOB, GOOGLE_KEY_BLOB,
                            FINDING_NETWORK_KEY, CONTROL_KEY_BLOB,
                            FORMAT_KEY}) {
        const esp_err_t erase_result = nvs_erase_key(handle, key);
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

    uint8_t apple_key[ADVERTISEMENT_KEY_SIZE] = {};
    uint8_t google_key[GOOGLE_ADVERTISEMENT_KEY_SIZE] = {};
    uint8_t control_key[TAG_CONTROL_KEY_SIZE] = {};
    FindingNetwork network = FindingNetwork::APPLE;
    const esp_err_t apple_result =
        load_advertisement_key(apple_key, sizeof(apple_key));
    const esp_err_t google_result =
        load_google_advertisement_key(google_key, sizeof(google_key));
    const esp_err_t network_result = load_finding_network(&network);
    const esp_err_t control_result =
        load_tag_control_key(control_key, sizeof(control_key));
#if CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
    const esp_err_t bootstrap_result = ESP_OK;
#else
    uint8_t bootstrap_key[DEVICE_BOOTSTRAP_KEY_SIZE] = {};
    const esp_err_t bootstrap_result =
        load_device_bootstrap_key(bootstrap_key, sizeof(bootstrap_key));
    std::memset(bootstrap_key, 0, sizeof(bootstrap_key));
#endif
    std::memset(apple_key, 0, sizeof(apple_key));
    std::memset(google_key, 0, sizeof(google_key));
    std::memset(control_key, 0, sizeof(control_key));
    if (apple_result == ESP_OK || google_result == ESP_OK ||
        network_result == ESP_OK || control_result == ESP_OK ||
        bootstrap_result != ESP_OK) {
        return ESP_ERR_INVALID_STATE;
    }
    return ESP_OK;
}
