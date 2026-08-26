#include "ota_update.hpp"

#include <cstdio>
#include <cstring>

#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/ecp.h"
#include "mbedtls/sha256.h"
#include "release_signing_key.hpp"

namespace {
constexpr char LOG_TAG[] = "OTA_UPDATE";
constexpr uint8_t MANIFEST_FORMAT_VERSION = 1;
constexpr uint8_t TARGET_CLASSIC_ESP32 = 1;
constexpr size_t MANIFEST_BODY_SIZE = 42;
constexpr size_t MANIFEST_DIGEST_OFFSET = 10;
constexpr size_t MANIFEST_SIGNATURE_LENGTH_OFFSET = 42;
constexpr size_t MANIFEST_SIGNATURE_OFFSET = 43;
constexpr size_t MANIFEST_SIGNATURE_MAX_SIZE = 72;
constexpr size_t MANIFEST_SIGNATURE_MIN_SIZE = 8;
constexpr uint64_t REBOOT_DELAY_MICROSECONDS = 750ULL * 1000ULL;

FirmwareUpdateState update_state = FirmwareUpdateState::IDLE;
FirmwareUpdateResult update_result = FirmwareUpdateResult::SUCCESS;
const esp_partition_t *update_partition = nullptr;
esp_ota_handle_t update_handle = 0;
bool update_handle_open = false;
uint32_t expected_size = 0;
uint32_t received_size = 0;
uint8_t expected_digest[32] = {};
mbedtls_sha256_context image_digest_context;
bool image_digest_active = false;
esp_timer_handle_t reboot_timer = nullptr;

uint32_t read_uint32_be(const uint8_t *value) {
    return (static_cast<uint32_t>(value[0]) << 24U) |
           (static_cast<uint32_t>(value[1]) << 16U) |
           (static_cast<uint32_t>(value[2]) << 8U) |
           static_cast<uint32_t>(value[3]);
}

bool parse_version(const char *value, uint8_t output[3]) {
    if (value == nullptr) return false;
    unsigned int major = 0;
    unsigned int minor = 0;
    unsigned int patch = 0;
    char trailing = '\0';
    if (std::sscanf(value, "%u.%u.%u%c", &major, &minor, &patch, &trailing) != 3 ||
        major > 255 || minor > 255 || patch > 255) {
        return false;
    }
    output[0] = static_cast<uint8_t>(major);
    output[1] = static_cast<uint8_t>(minor);
    output[2] = static_cast<uint8_t>(patch);
    return true;
}

int compare_version(const uint8_t left[3], const uint8_t right[3]) {
    for (size_t index = 0; index < 3; ++index) {
        if (left[index] < right[index]) return -1;
        if (left[index] > right[index]) return 1;
    }
    return 0;
}

bool verify_manifest_signature(const uint8_t *manifest) {
    const uint8_t signature_length = manifest[MANIFEST_SIGNATURE_LENGTH_OFFSET];
    if (signature_length < MANIFEST_SIGNATURE_MIN_SIZE ||
        signature_length > MANIFEST_SIGNATURE_MAX_SIZE) {
        return false;
    }
    for (size_t index = MANIFEST_SIGNATURE_OFFSET + signature_length;
         index < FIRMWARE_MANIFEST_SIZE; ++index) {
        if (manifest[index] != 0) return false;
    }

    uint8_t digest[32] = {};
    if (mbedtls_sha256(manifest, MANIFEST_BODY_SIZE, digest, 0) != 0) {
        return false;
    }

    mbedtls_ecdsa_context context;
    mbedtls_ecdsa_init(&context);
    int result = mbedtls_ecp_group_load(
        &context.MBEDTLS_PRIVATE(grp), MBEDTLS_ECP_DP_SECP256R1);
    if (result == 0) {
        result = mbedtls_ecp_point_read_binary(
            &context.MBEDTLS_PRIVATE(grp), &context.MBEDTLS_PRIVATE(Q),
            PINKEVA_RELEASE_PUBLIC_KEY, sizeof(PINKEVA_RELEASE_PUBLIC_KEY));
    }
    if (result == 0) {
        result = mbedtls_ecdsa_read_signature(
            &context, digest, sizeof(digest),
            manifest + MANIFEST_SIGNATURE_OFFSET, signature_length);
    }
    mbedtls_ecdsa_free(&context);
    std::memset(digest, 0, sizeof(digest));
    return result == 0;
}

void close_digest_context() {
    if (!image_digest_active) return;
    mbedtls_sha256_free(&image_digest_context);
    image_digest_active = false;
}

void close_update_handle() {
    if (!update_handle_open) return;
    esp_ota_abort(update_handle);
    update_handle_open = false;
    update_handle = 0;
}

void clear_transfer() {
    close_update_handle();
    close_digest_context();
    update_partition = nullptr;
    expected_size = 0;
    received_size = 0;
    std::memset(expected_digest, 0, sizeof(expected_digest));
}

esp_gatt_status_t fail(FirmwareUpdateResult result,
                       esp_gatt_status_t status = ESP_GATT_ERROR) {
    clear_transfer();
    update_state = FirmwareUpdateState::ERROR;
    update_result = result;
    return status;
}

void reboot_callback(void *) {
    esp_restart();
}

esp_err_t schedule_reboot() {
    if (reboot_timer == nullptr) {
        const esp_timer_create_args_t arguments = {
            .callback = &reboot_callback,
            .arg = nullptr,
            .dispatch_method = ESP_TIMER_TASK,
            .name = "ota_reboot",
            .skip_unhandled_events = true,
        };
        const esp_err_t create_result = esp_timer_create(&arguments, &reboot_timer);
        if (create_result != ESP_OK) return create_result;
    }
    esp_timer_stop(reboot_timer);
    return esp_timer_start_once(reboot_timer, REBOOT_DELAY_MICROSECONDS);
}
}  // namespace

esp_gatt_status_t ota_update_begin(const uint8_t *manifest, size_t length) {
    if (manifest == nullptr || length != FIRMWARE_MANIFEST_SIZE ||
        manifest[0] != MANIFEST_FORMAT_VERSION ||
        manifest[1] != TARGET_CLASSIC_ESP32) {
        return fail(FirmwareUpdateResult::INVALID_MANIFEST,
                    ESP_GATT_INVALID_ATTR_LEN);
    }
    if (!verify_manifest_signature(manifest)) {
        return fail(FirmwareUpdateResult::SIGNATURE_REJECTED,
                    ESP_GATT_INSUF_AUTHENTICATION);
    }

    const uint8_t requested_version[3] = {manifest[2], manifest[3], manifest[4]};
    uint8_t running_version[3] = {};
    const esp_app_desc_t *running_description = esp_app_get_description();
    if (running_description == nullptr ||
        !parse_version(running_description->version, running_version) ||
        compare_version(requested_version, running_version) <= 0) {
        return fail(FirmwareUpdateResult::VERSION_REJECTED,
                    ESP_GATT_REQ_NOT_SUPPORTED);
    }

    const uint32_t requested_size = read_uint32_be(manifest + 6);
    const esp_partition_t *candidate = esp_ota_get_next_update_partition(nullptr);
    if (requested_size == 0 || candidate == nullptr ||
        requested_size > candidate->size) {
        return fail(FirmwareUpdateResult::PARTITION_UNAVAILABLE,
                    ESP_GATT_INSUF_RESOURCE);
    }

    clear_transfer();
    esp_ota_handle_t candidate_handle = 0;
    const esp_err_t begin_result =
        esp_ota_begin(candidate, requested_size, &candidate_handle);
    if (begin_result != ESP_OK) {
        ESP_LOGE(LOG_TAG, "Could not begin OTA: %s", esp_err_to_name(begin_result));
        return fail(FirmwareUpdateResult::PARTITION_UNAVAILABLE,
                    ESP_GATT_INSUF_RESOURCE);
    }

    update_partition = candidate;
    update_handle = candidate_handle;
    update_handle_open = true;
    expected_size = requested_size;
    received_size = 0;
    std::memcpy(expected_digest, manifest + MANIFEST_DIGEST_OFFSET,
                sizeof(expected_digest));
    mbedtls_sha256_init(&image_digest_context);
    image_digest_active = true;
    if (mbedtls_sha256_starts(&image_digest_context, 0) != 0) {
        return fail(FirmwareUpdateResult::INTERNAL_ERROR);
    }
    update_state = FirmwareUpdateState::READY;
    update_result = FirmwareUpdateResult::SUCCESS;
    ESP_LOGI(LOG_TAG, "Accepted signed firmware %u.%u.%u (%lu bytes)",
             requested_version[0], requested_version[1], requested_version[2],
             static_cast<unsigned long>(requested_size));
    return ESP_GATT_OK;
}

esp_gatt_status_t ota_update_write(const uint8_t *data, size_t length) {
    if (!update_handle_open || !image_digest_active || data == nullptr ||
        length == 0) {
        return fail(FirmwareUpdateResult::INVALID_STATE,
                    ESP_GATT_WRITE_NOT_PERMIT);
    }
    if (length > expected_size - received_size) {
        return fail(FirmwareUpdateResult::INCOMPLETE_IMAGE,
                    ESP_GATT_INVALID_ATTR_LEN);
    }
    if (esp_ota_write(update_handle, data, length) != ESP_OK ||
        mbedtls_sha256_update(&image_digest_context, data, length) != 0) {
        return fail(FirmwareUpdateResult::WRITE_FAILED);
    }
    received_size += static_cast<uint32_t>(length);
    update_state = FirmwareUpdateState::RECEIVING;
    return ESP_GATT_OK;
}

esp_gatt_status_t ota_update_control(const uint8_t *command, size_t length) {
    if (command == nullptr || length != 1) {
        return fail(FirmwareUpdateResult::INVALID_MANIFEST,
                    ESP_GATT_INVALID_ATTR_LEN);
    }
    if (command[0] == 0x02) {
        ota_update_abort();
        return ESP_GATT_OK;
    }
    if (command[0] != 0x01 || !update_handle_open || !image_digest_active) {
        return fail(FirmwareUpdateResult::INVALID_STATE,
                    ESP_GATT_WRITE_NOT_PERMIT);
    }
    if (received_size != expected_size) {
        return fail(FirmwareUpdateResult::INCOMPLETE_IMAGE,
                    ESP_GATT_INVALID_ATTR_LEN);
    }

    update_state = FirmwareUpdateState::VERIFYING;
    uint8_t actual_digest[32] = {};
    if (mbedtls_sha256_finish(&image_digest_context, actual_digest) != 0) {
        std::memset(actual_digest, 0, sizeof(actual_digest));
        return fail(FirmwareUpdateResult::INTERNAL_ERROR);
    }
    close_digest_context();
    if (std::memcmp(actual_digest, expected_digest, sizeof(actual_digest)) != 0) {
        std::memset(actual_digest, 0, sizeof(actual_digest));
        return fail(FirmwareUpdateResult::DIGEST_MISMATCH,
                    ESP_GATT_INVALID_PDU);
    }
    std::memset(actual_digest, 0, sizeof(actual_digest));

    const esp_ota_handle_t completed_handle = update_handle;
    update_handle_open = false;
    update_handle = 0;
    const esp_err_t end_result = esp_ota_end(completed_handle);
    if (end_result != ESP_OK) {
        ESP_LOGE(LOG_TAG, "OTA image validation failed: %s",
                 esp_err_to_name(end_result));
        return fail(FirmwareUpdateResult::INVALID_IMAGE);
    }
    const esp_partition_t *running_partition = esp_ota_get_running_partition();
    if (esp_ota_set_boot_partition(update_partition) != ESP_OK) {
        return fail(FirmwareUpdateResult::PARTITION_UNAVAILABLE);
    }

    update_state = FirmwareUpdateState::COMPLETE;
    update_result = FirmwareUpdateResult::SUCCESS;
    std::memset(expected_digest, 0, sizeof(expected_digest));
    update_partition = nullptr;
    if (schedule_reboot() != ESP_OK) {
        if (running_partition != nullptr &&
            esp_ota_set_boot_partition(running_partition) != ESP_OK) {
            ESP_LOGE(LOG_TAG,
                     "Could not restore the running partition after reboot scheduling failed");
        }
        return fail(FirmwareUpdateResult::INTERNAL_ERROR);
    }
    ESP_LOGI(LOG_TAG, "Firmware verified; rebooting into the new OTA partition");
    return ESP_GATT_OK;
}

void ota_update_abort() {
    clear_transfer();
    update_state = FirmwareUpdateState::IDLE;
    update_result = FirmwareUpdateResult::SUCCESS;
}

bool ota_update_active() {
    return update_handle_open;
}

void ota_update_status(uint8_t output[FIRMWARE_STATUS_SIZE]) {
    output[0] = static_cast<uint8_t>(update_state);
    output[1] = static_cast<uint8_t>(update_result);
    output[2] = static_cast<uint8_t>(received_size >> 24U);
    output[3] = static_cast<uint8_t>(received_size >> 16U);
    output[4] = static_cast<uint8_t>(received_size >> 8U);
    output[5] = static_cast<uint8_t>(received_size);
}
