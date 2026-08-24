#include "ble_driver.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <vector>

#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_gap_ble_api.h"
#include "esp_gatt_defs.h"
#include "esp_gatts_api.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "mbedtls/md.h"
#include "mbedtls/sha256.h"
#include "nvs_driver.hpp"

namespace {
constexpr char LOG_TAG[] = "BLE_DRIVER";
constexpr uint16_t APP_ID = 0;
constexpr uint8_t SERVICE_INSTANCE_ID = 0;
constexpr uint8_t STATUS_VALUE_SIZE = 2;
constexpr uint8_t PROTOCOL_VALUE_SIZE = 6;
constexpr uint8_t KEY_FINGERPRINT_SIZE = 32;
constexpr uint8_t TAG_CHALLENGE_SIZE = 32;
constexpr uint8_t TAG_AUTHORIZATION_PROOF_SIZE = 32;
constexpr uint8_t RESET_COMMAND_SIZE = 64;
constexpr uint64_t AUTHORIZATION_TIMEOUT_MICROSECONDS = 30ULL * 1000ULL * 1000ULL;
constexpr size_t MAX_STAGED_VALUE_SIZE = RESET_COMMAND_SIZE;
constexpr uint8_t ADV_CONFIG_FLAG = 1U << 0;
constexpr uint8_t SCAN_RSP_CONFIG_FLAG = 1U << 1;

// ESP-IDF stores 128-bit UUIDs least-significant byte first. Keep the
// canonical string next to the wire representation so the mobile app,
// advertisement packet, and GATT database cannot silently drift apart.
constexpr char PINKEVA_SERVICE_UUID_STRING[] =
    "a6f0f000-3e4d-4b1a-9c2e-72d24c8f0a01";
constexpr uint8_t PINKEVA_SERVICE_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x00, 0xF0, 0xF0, 0xA6,
};
static_assert(sizeof(PINKEVA_SERVICE_UUID) == ESP_UUID_LEN_128);
constexpr uint8_t PROTOCOL_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x01, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t DEVICE_ID_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x02, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t ADVERTISEMENT_KEY_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x03, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t STATUS_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x04, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t KEY_FINGERPRINT_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x05, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t CONTROL_KEY_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x06, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t AUTHENTICATED_RESET_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x07, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t TAG_CHALLENGE_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x08, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t TAG_AUTHORIZATION_PROOF_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x09, 0xF0, 0xF0, 0xA6,
};

enum AttributeIndex : uint8_t {
    SERVICE,
    PROTOCOL_DECLARATION,
    PROTOCOL_VALUE,
    DEVICE_ID_DECLARATION,
    DEVICE_ID_VALUE,
    ADVERTISEMENT_KEY_DECLARATION,
    ADVERTISEMENT_KEY_VALUE,
    STATUS_DECLARATION,
    STATUS_VALUE,
    STATUS_CCC,
    KEY_FINGERPRINT_DECLARATION,
    KEY_FINGERPRINT_VALUE,
    CONTROL_KEY_DECLARATION,
    CONTROL_KEY_VALUE,
    AUTHENTICATED_RESET_DECLARATION,
    AUTHENTICATED_RESET_VALUE,
    TAG_CHALLENGE_DECLARATION,
    TAG_CHALLENGE_VALUE,
    TAG_AUTHORIZATION_PROOF_DECLARATION,
    TAG_AUTHORIZATION_PROOF_VALUE,
    ATTRIBUTE_COUNT,
};

constexpr uint16_t PRIMARY_SERVICE_UUID = ESP_GATT_UUID_PRI_SERVICE;
constexpr uint16_t CHARACTER_DECLARATION_UUID = ESP_GATT_UUID_CHAR_DECLARE;
constexpr uint16_t CLIENT_CONFIG_UUID = ESP_GATT_UUID_CHAR_CLIENT_CONFIG;
constexpr uint8_t READ_PROPERTY = ESP_GATT_CHAR_PROP_BIT_READ;
constexpr uint8_t WRITE_PROPERTY = ESP_GATT_CHAR_PROP_BIT_WRITE;
constexpr uint8_t READ_NOTIFY_PROPERTY =
    ESP_GATT_CHAR_PROP_BIT_READ | ESP_GATT_CHAR_PROP_BIT_NOTIFY;

// Protocol 1.2, firmware 0.1. Capability bit 0x10 requires a backend-issued,
// nonce-bound authorization proof before any provisioning/reset write.
uint8_t protocol_value[PROTOCOL_VALUE_SIZE] = {1, 2, 0, 1, 0x1F, 0x00};
char device_id[DEVICE_ID_LEN] = {};
uint8_t status_value[STATUS_VALUE_SIZE] = {
    static_cast<uint8_t>(ProvisioningState::UNPROVISIONED),
    static_cast<uint8_t>(ProvisioningResult::SUCCESS),
};
uint8_t ccc_value[2] = {0x00, 0x00};
uint8_t advertisement_key_attribute[PUBLIC_KEY_SIZE] = {};
uint8_t key_fingerprint_attribute[KEY_FINGERPRINT_SIZE] = {};
uint8_t control_key_attribute[TAG_CONTROL_KEY_SIZE] = {};
uint8_t reset_command_attribute[RESET_COMMAND_SIZE] = {};
uint8_t tag_challenge_attribute[TAG_CHALLENGE_SIZE] = {};
uint8_t tag_authorization_proof_attribute[TAG_AUTHORIZATION_PROOF_SIZE] = {};
uint16_t attribute_handles[ATTRIBUTE_COUNT] = {};

BLEMode ble_mode = BLEMode::SETUP;
esp_gatt_if_t active_gatts_if = ESP_GATT_IF_NONE;
uint16_t active_connection_id = 0;
bool connected = false;
bool notifications_enabled = false;
bool service_started = false;
bool advertising_configuration_failed = false;
bool connection_authorized = false;
esp_timer_handle_t authorization_timeout_timer = nullptr;
uint8_t pending_adv_configuration = 0;

uint8_t staged_value[MAX_STAGED_VALUE_SIZE] = {};
bool staged_value_bytes[MAX_STAGED_VALUE_SIZE] = {};
size_t staged_value_length = 0;
size_t staged_expected_length = 0;
uint16_t staged_attribute_handle = 0;
uint16_t staged_connection_id = 0;
bool staged_write_active = false;
bool bond_cleanup_pending = false;

uint8_t setup_adv_data[3 + 18] = {
    0x02,
    ESP_BLE_AD_TYPE_FLAG,
    ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT,
    0x11,
    ESP_BLE_AD_TYPE_128SRV_CMPL,
    PINKEVA_SERVICE_UUID[0], PINKEVA_SERVICE_UUID[1], PINKEVA_SERVICE_UUID[2],
    PINKEVA_SERVICE_UUID[3], PINKEVA_SERVICE_UUID[4], PINKEVA_SERVICE_UUID[5],
    PINKEVA_SERVICE_UUID[6], PINKEVA_SERVICE_UUID[7], PINKEVA_SERVICE_UUID[8],
    PINKEVA_SERVICE_UUID[9], PINKEVA_SERVICE_UUID[10],
    PINKEVA_SERVICE_UUID[11], PINKEVA_SERVICE_UUID[12],
    PINKEVA_SERVICE_UUID[13], PINKEVA_SERVICE_UUID[14],
    PINKEVA_SERVICE_UUID[15],
};
uint8_t setup_scan_response[2 + (DEVICE_ID_LEN - 1)] = {};

esp_ble_adv_params_t setup_adv_params = {
    .adv_int_min = 0x00A0,  // 100 ms while actively setting up.
    .adv_int_max = 0x0190,  // 250 ms.
    .adv_type = ADV_TYPE_IND,
    .own_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .peer_addr = {0},
    .peer_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .channel_map = ADV_CHNL_ALL,
    .adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};

esp_ble_adv_params_t suspended_adv_params = {
    .adv_int_min = 0x0640,  // 1 second maintenance/renewal window.
    .adv_int_max = 0x0C80,  // 2 seconds; never contains finder payload.
    .adv_type = ADV_TYPE_IND,
    .own_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .peer_addr = {0},
    .peer_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .channel_map = ADV_CHNL_ALL,
    .adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};

const esp_gatts_attr_db_t provisioning_gatt_db[ATTRIBUTE_COUNT] = {
    [SERVICE] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&PRIMARY_SERVICE_UUID)),
          ESP_GATT_PERM_READ,
          ESP_UUID_LEN_128,
          ESP_UUID_LEN_128,
          const_cast<uint8_t *>(PINKEVA_SERVICE_UUID)}},

    [PROTOCOL_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_PROPERTY)}},
    [PROTOCOL_VALUE] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(PROTOCOL_UUID),
          ESP_GATT_PERM_READ,
          sizeof(protocol_value),
          sizeof(protocol_value),
          protocol_value}},

    [DEVICE_ID_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_PROPERTY)}},
    [DEVICE_ID_VALUE] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(DEVICE_ID_UUID),
          ESP_GATT_PERM_READ,
          DEVICE_ID_LEN - 1,
          DEVICE_ID_LEN - 1,
          reinterpret_cast<uint8_t *>(device_id)}},

    [ADVERTISEMENT_KEY_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [ADVERTISEMENT_KEY_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(ADVERTISEMENT_KEY_UUID),
          ESP_GATT_PERM_WRITE_ENCRYPTED,
          PUBLIC_KEY_SIZE,
          0,
          advertisement_key_attribute}},

    [STATUS_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_NOTIFY_PROPERTY)}},
    [STATUS_VALUE] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(STATUS_UUID),
          ESP_GATT_PERM_READ,
          sizeof(status_value),
          sizeof(status_value),
          status_value}},
    [STATUS_CCC] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CLIENT_CONFIG_UUID)),
          ESP_GATT_PERM_READ | ESP_GATT_PERM_WRITE,
          sizeof(ccc_value),
          sizeof(ccc_value),
          ccc_value}},

    [KEY_FINGERPRINT_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_PROPERTY)}},
    [KEY_FINGERPRINT_VALUE] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(KEY_FINGERPRINT_UUID),
          ESP_GATT_PERM_READ_ENCRYPTED,
          sizeof(key_fingerprint_attribute),
          sizeof(key_fingerprint_attribute),
          key_fingerprint_attribute}},

    [CONTROL_KEY_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [CONTROL_KEY_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(CONTROL_KEY_UUID),
          ESP_GATT_PERM_WRITE_ENCRYPTED,
          sizeof(control_key_attribute),
          0,
          control_key_attribute}},

    [AUTHENTICATED_RESET_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [AUTHENTICATED_RESET_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(AUTHENTICATED_RESET_UUID),
          ESP_GATT_PERM_WRITE_ENCRYPTED,
          sizeof(reset_command_attribute),
          0,
          reset_command_attribute}},

    [TAG_CHALLENGE_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_PROPERTY)}},
    [TAG_CHALLENGE_VALUE] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(TAG_CHALLENGE_UUID),
          ESP_GATT_PERM_READ_ENCRYPTED,
          sizeof(tag_challenge_attribute),
          sizeof(tag_challenge_attribute),
          tag_challenge_attribute}},

    [TAG_AUTHORIZATION_PROOF_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [TAG_AUTHORIZATION_PROOF_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(TAG_AUTHORIZATION_PROOF_UUID),
          ESP_GATT_PERM_WRITE_ENCRYPTED,
          sizeof(tag_authorization_proof_attribute),
          0,
          tag_authorization_proof_attribute}},
};

void clear_staged_value() {
    std::memset(staged_value, 0, sizeof(staged_value));
    std::memset(staged_value_bytes, 0, sizeof(staged_value_bytes));
    staged_value_length = 0;
    staged_expected_length = 0;
    staged_attribute_handle = 0;
    staged_connection_id = 0;
    staged_write_active = false;
}

void stop_authorization_timeout() {
    if (authorization_timeout_timer != nullptr) {
        esp_timer_stop(authorization_timeout_timer);
    }
}

void clear_connection_authorization() {
    stop_authorization_timeout();
    connection_authorized = false;
    std::memset(tag_challenge_attribute, 0, sizeof(tag_challenge_attribute));
    std::memset(tag_authorization_proof_attribute, 0,
                sizeof(tag_authorization_proof_attribute));
}

void authorization_timeout_callback(void *) {
    if (connected && !connection_authorized &&
        active_gatts_if != ESP_GATT_IF_NONE) {
        ESP_LOGW(LOG_TAG, "Closing connection without app authorization");
        esp_ble_gatts_close(active_gatts_if, active_connection_id);
    }
}

esp_err_t begin_connection_authorization() {
    clear_connection_authorization();
    esp_fill_random(tag_challenge_attribute, sizeof(tag_challenge_attribute));
    esp_err_t error = esp_ble_gatts_set_attr_value(
        attribute_handles[TAG_CHALLENGE_VALUE],
        sizeof(tag_challenge_attribute), tag_challenge_attribute);
    if (error != ESP_OK) {
        return error;
    }
    if (authorization_timeout_timer == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    return esp_timer_start_once(authorization_timeout_timer,
                                AUTHORIZATION_TIMEOUT_MICROSECONDS);
}

void update_status(ProvisioningState state, ProvisioningResult result) {
    status_value[0] = static_cast<uint8_t>(state);
    status_value[1] = static_cast<uint8_t>(result);
    if (attribute_handles[STATUS_VALUE] != 0) {
        esp_ble_gatts_set_attr_value(
            attribute_handles[STATUS_VALUE], sizeof(status_value), status_value);
    }
    if (connected && notifications_enabled &&
        active_gatts_if != ESP_GATT_IF_NONE && attribute_handles[STATUS_VALUE] != 0) {
        esp_ble_gatts_send_indicate(
            active_gatts_if,
            active_connection_id,
            attribute_handles[STATUS_VALUE],
            sizeof(status_value),
            status_value,
            false);
    }
}

esp_err_t update_key_fingerprint(const uint8_t *key) {
    if (key == nullptr) {
        std::memset(key_fingerprint_attribute, 0,
                    sizeof(key_fingerprint_attribute));
    } else if (mbedtls_sha256(key, PUBLIC_KEY_SIZE,
                              key_fingerprint_attribute, 0) != 0) {
        std::memset(key_fingerprint_attribute, 0,
                    sizeof(key_fingerprint_attribute));
        return ESP_FAIL;
    }
    if (attribute_handles[KEY_FINGERPRINT_VALUE] != 0) {
        return esp_ble_gatts_set_attr_value(
            attribute_handles[KEY_FINGERPRINT_VALUE],
            sizeof(key_fingerprint_attribute), key_fingerprint_attribute);
    }
    return ESP_OK;
}

void erase_all_bonds() {
    int count = esp_ble_get_bond_device_num();
    if (count <= 0) {
        return;
    }
    std::vector<esp_ble_bond_dev_t> devices(static_cast<size_t>(count));
    if (esp_ble_get_bond_device_list(&count, devices.data()) != ESP_OK) {
        ESP_LOGE(LOG_TAG, "Could not enumerate BLE bonds after reset");
        return;
    }
    for (int index = 0; index < count; ++index) {
        esp_ble_remove_bond_device(devices[static_cast<size_t>(index)].bd_addr);
    }
}

void try_start_maintenance_advertising() {
    if (!connected && service_started && pending_adv_configuration == 0 &&
        !advertising_configuration_failed) {
        esp_ble_adv_params_t *parameters = ble_mode == BLEMode::SETUP
                                               ? &setup_adv_params
                                               : &suspended_adv_params;
        esp_err_t error = esp_ble_gap_start_advertising(parameters);
        if (error != ESP_OK) {
            ESP_LOGE(LOG_TAG, "Could not start maintenance advertising: %s",
                     esp_err_to_name(error));
        }
    }
}

esp_gatt_status_t persist_key(const uint8_t *key, size_t length) {
    if (ble_mode != BLEMode::SETUP) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::ALREADY_PROVISIONED);
        return ESP_GATT_WRITE_NOT_PERMIT;
    }
    if (length != PUBLIC_KEY_SIZE) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INVALID_LENGTH);
        return ESP_GATT_INVALID_ATTR_LEN;
    }

    update_status(ProvisioningState::VALIDATING, ProvisioningResult::SUCCESS);
    if (!advertisement_key_is_valid(key, length)) {
        update_status(ProvisioningState::ERROR, ProvisioningResult::INVALID_VALUE);
        return ESP_GATT_INVALID_PDU;
    }

    update_status(ProvisioningState::PERSISTING, ProvisioningResult::SUCCESS);
    esp_err_t error = save_advertisement_key(key, length);
    if (error == ESP_ERR_INVALID_STATE) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::ALREADY_PROVISIONED);
        return ESP_GATT_WRITE_NOT_PERMIT;
    }
    if (error != ESP_OK) {
        ESP_LOGE(LOG_TAG, "Key persistence failed: %s", esp_err_to_name(error));
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::STORAGE_FAILURE);
        return ESP_GATT_ERR_UNLIKELY;
    }
    if (update_key_fingerprint(key) != ESP_OK) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INTERNAL_ERROR);
        return ESP_GATT_ERR_UNLIKELY;
    }

    // The mandatory signed entitlement is not implemented yet. Report key
    // receipt as ready for the app, then remain connectable and fail closed.
    ble_mode = BLEMode::SUSPENDED;
    update_status(ProvisioningState::READY, ProvisioningResult::SUCCESS);
    ESP_LOGI(LOG_TAG, "Advertisement key committed; awaiting entitlement");
    return ESP_GATT_OK;
}

esp_gatt_status_t persist_control_key(const uint8_t *key, size_t length) {
    if (ble_mode != BLEMode::SETUP) {
        return ESP_GATT_WRITE_NOT_PERMIT;
    }
    if (length != TAG_CONTROL_KEY_SIZE) {
        return ESP_GATT_INVALID_ATTR_LEN;
    }
    esp_err_t error = save_tag_control_key(key, length);
    if (error == ESP_ERR_INVALID_STATE) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::ALREADY_PROVISIONED);
        return ESP_GATT_WRITE_NOT_PERMIT;
    }
    if (error != ESP_OK) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::STORAGE_FAILURE);
        return ESP_GATT_ERR_UNLIKELY;
    }
    return ESP_GATT_OK;
}

esp_gatt_status_t authenticated_reset(const uint8_t *command, size_t length) {
    if (ble_mode != BLEMode::SUSPENDED) {
        return ESP_GATT_WRITE_NOT_PERMIT;
    }
    if (command == nullptr || length != RESET_COMMAND_SIZE) {
        return ESP_GATT_INVALID_ATTR_LEN;
    }

    uint8_t control_key[TAG_CONTROL_KEY_SIZE] = {};
    if (load_tag_control_key(control_key, sizeof(control_key)) != ESP_OK) {
        std::memset(control_key, 0, sizeof(control_key));
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::UNAUTHORIZED);
        return ESP_GATT_INSUF_AUTHORIZATION;
    }
    constexpr char RESET_DOMAIN[] = "pinqeva:factory-reset:v1";
    uint8_t message[sizeof(RESET_DOMAIN) + DEVICE_ID_LEN - 1 + 32] = {};
    std::memcpy(message, RESET_DOMAIN, sizeof(RESET_DOMAIN));
    std::memcpy(message + sizeof(RESET_DOMAIN), device_id, DEVICE_ID_LEN - 1);
    std::memcpy(message + sizeof(RESET_DOMAIN) + DEVICE_ID_LEN - 1,
                command, 32);

    uint8_t expected_mac[32] = {};
    const mbedtls_md_info_t *sha256 =
        mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    int hmac_result = sha256 == nullptr
                          ? -1
                          : mbedtls_md_hmac(sha256, control_key,
                                            sizeof(control_key), message,
                                            sizeof(message), expected_mac);
    std::memset(control_key, 0, sizeof(control_key));
    std::memset(message, 0, sizeof(message));

    uint8_t difference = static_cast<uint8_t>(hmac_result != 0);
    for (size_t index = 0; index < sizeof(expected_mac); ++index) {
        difference |= expected_mac[index] ^ command[32 + index];
    }
    std::memset(expected_mac, 0, sizeof(expected_mac));
    if (difference != 0) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::UNAUTHORIZED);
        return ESP_GATT_INSUF_AUTHORIZATION;
    }

    if (erase_provisioning_data() != ESP_OK) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::STORAGE_FAILURE);
        return ESP_GATT_ERR_UNLIKELY;
    }
    update_key_fingerprint(nullptr);
    ble_mode = BLEMode::SETUP;
    bond_cleanup_pending = true;
    update_status(ProvisioningState::UNPROVISIONED,
                  ProvisioningResult::SUCCESS);
    ESP_LOGI(LOG_TAG, "Authenticated reset completed; key material erased");
    return ESP_GATT_OK;
}

esp_gatt_status_t authorize_connection(const uint8_t *proof, size_t length) {
    if (proof == nullptr || length != TAG_AUTHORIZATION_PROOF_SIZE) {
        return ESP_GATT_INVALID_ATTR_LEN;
    }

    uint8_t bootstrap_key[DEVICE_BOOTSTRAP_KEY_SIZE] = {};
    if (load_device_bootstrap_key(bootstrap_key, sizeof(bootstrap_key)) != ESP_OK) {
        std::memset(bootstrap_key, 0, sizeof(bootstrap_key));
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::UNAUTHORIZED);
        return ESP_GATT_INSUF_AUTHORIZATION;
    }

    constexpr char AUTHORIZATION_DOMAIN[] = "pinqeva:bootstrap-auth:v1";
    uint8_t message[sizeof(AUTHORIZATION_DOMAIN) + DEVICE_ID_LEN - 1 +
                    TAG_CHALLENGE_SIZE] = {};
    std::memcpy(message, AUTHORIZATION_DOMAIN, sizeof(AUTHORIZATION_DOMAIN));
    std::memcpy(message + sizeof(AUTHORIZATION_DOMAIN), device_id,
                DEVICE_ID_LEN - 1);
    std::memcpy(message + sizeof(AUTHORIZATION_DOMAIN) + DEVICE_ID_LEN - 1,
                tag_challenge_attribute, TAG_CHALLENGE_SIZE);

    uint8_t expected_mac[TAG_AUTHORIZATION_PROOF_SIZE] = {};
    const mbedtls_md_info_t *sha256 =
        mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    int hmac_result = sha256 == nullptr
                          ? -1
                          : mbedtls_md_hmac(
                                sha256, bootstrap_key, sizeof(bootstrap_key),
                                message, sizeof(message), expected_mac);
    std::memset(bootstrap_key, 0, sizeof(bootstrap_key));
    std::memset(message, 0, sizeof(message));

    uint8_t difference = static_cast<uint8_t>(hmac_result != 0);
    for (size_t index = 0; index < sizeof(expected_mac); ++index) {
        difference |= expected_mac[index] ^ proof[index];
    }
    std::memset(expected_mac, 0, sizeof(expected_mac));
    if (difference != 0) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::UNAUTHORIZED);
        return ESP_GATT_INSUF_AUTHORIZATION;
    }

    connection_authorized = true;
    stop_authorization_timeout();
    ESP_LOGI(LOG_TAG, "Backend-authorized app connection accepted");
    return ESP_GATT_OK;
}

void send_write_response(esp_gatt_if_t gatts_if,
                         esp_ble_gatts_cb_param_t *param,
                         esp_gatt_status_t status,
                         const esp_gatt_rsp_t *response = nullptr) {
    if (param->write.need_rsp) {
        esp_ble_gatts_send_response(gatts_if, param->write.conn_id,
                                    param->write.trans_id,
                                    status,
                                    const_cast<esp_gatt_rsp_t *>(response));
    }
}

size_t secure_value_length(uint16_t handle) {
    if (handle == attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE]) {
        return TAG_AUTHORIZATION_PROOF_SIZE;
    }
    if (handle == attribute_handles[ADVERTISEMENT_KEY_VALUE]) {
        return PUBLIC_KEY_SIZE;
    }
    if (handle == attribute_handles[CONTROL_KEY_VALUE]) {
        return TAG_CONTROL_KEY_SIZE;
    }
    if (handle == attribute_handles[AUTHENTICATED_RESET_VALUE]) {
        return RESET_COMMAND_SIZE;
    }
    return 0;
}

bool secure_write_allowed_in_mode(uint16_t handle) {
    if (handle == attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE]) {
        return true;
    }
    if (!connection_authorized) {
        return false;
    }
    if (handle == attribute_handles[AUTHENTICATED_RESET_VALUE]) {
        return ble_mode == BLEMode::SUSPENDED;
    }
    return (handle == attribute_handles[ADVERTISEMENT_KEY_VALUE] ||
            handle == attribute_handles[CONTROL_KEY_VALUE]) &&
           ble_mode == BLEMode::SETUP;
}

esp_gatt_status_t process_secure_write(uint16_t handle,
                                       const uint8_t *value,
                                       size_t length) {
    if (handle == attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE]) {
        return authorize_connection(value, length);
    }
    if (!connection_authorized) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::UNAUTHORIZED);
        return ESP_GATT_INSUF_AUTHORIZATION;
    }
    if (handle == attribute_handles[ADVERTISEMENT_KEY_VALUE]) {
        return persist_key(value, length);
    }
    if (handle == attribute_handles[CONTROL_KEY_VALUE]) {
        return persist_control_key(value, length);
    }
    if (handle == attribute_handles[AUTHENTICATED_RESET_VALUE]) {
        return authenticated_reset(value, length);
    }
    return ESP_GATT_WRITE_NOT_PERMIT;
}

void handle_prepared_secure_write(esp_gatt_if_t gatts_if,
                                  esp_ble_gatts_cb_param_t *param) {
    const auto &write = param->write;
    size_t expected_length = secure_value_length(write.handle);
    esp_gatt_status_t status = ESP_GATT_OK;
    if (expected_length == 0) {
        status = ESP_GATT_WRITE_NOT_PERMIT;
    } else if (!secure_write_allowed_in_mode(write.handle)) {
        if (!connection_authorized &&
            write.handle != attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE]) {
            status = ESP_GATT_INSUF_AUTHORIZATION;
            update_status(ProvisioningState::ERROR,
                          ProvisioningResult::UNAUTHORIZED);
        } else {
            status = ESP_GATT_WRITE_NOT_PERMIT;
            update_status(ProvisioningState::ERROR,
                          ProvisioningResult::ALREADY_PROVISIONED);
        }
    } else if (write.offset > expected_length ||
               write.len > expected_length - write.offset) {
        status = ESP_GATT_INVALID_ATTR_LEN;
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INVALID_LENGTH);
    } else if (staged_write_active &&
               (staged_connection_id != write.conn_id ||
                staged_attribute_handle != write.handle)) {
        status = ESP_GATT_BUSY;
    }

    esp_gatt_rsp_t response = {};
    response.attr_value.handle = write.handle;
    response.attr_value.offset = write.offset;
    response.attr_value.auth_req = ESP_GATT_AUTH_REQ_NONE;
    if (status == ESP_GATT_OK) {
        if (!staged_write_active) {
            clear_staged_value();
            staged_write_active = true;
            staged_connection_id = write.conn_id;
            staged_attribute_handle = write.handle;
            staged_expected_length = expected_length;
            update_status(ProvisioningState::RECEIVING,
                          ProvisioningResult::SUCCESS);
        }
        std::memcpy(staged_value + write.offset, write.value, write.len);
        std::fill(staged_value_bytes + write.offset,
                  staged_value_bytes + write.offset + write.len, true);
        staged_value_length = std::max(
            staged_value_length, static_cast<size_t>(write.offset + write.len));
        response.attr_value.len = write.len;
        std::memcpy(response.attr_value.value, write.value, write.len);
    }
    send_write_response(gatts_if, param, status, &response);
    if (status == ESP_GATT_INSUF_AUTHORIZATION) {
        esp_ble_gatts_close(gatts_if, write.conn_id);
    }
}

void handle_ccc_write(esp_gatt_if_t gatts_if, esp_ble_gatts_cb_param_t *param) {
    esp_gatt_status_t status = ESP_GATT_OK;
    if (param->write.len != sizeof(ccc_value)) {
        status = ESP_GATT_INVALID_ATTR_LEN;
    } else {
        uint16_t value = static_cast<uint16_t>(param->write.value[0]) |
                         static_cast<uint16_t>(param->write.value[1] << 8U);
        if (value != 0x0000 && value != 0x0001) {
            status = ESP_GATT_CCC_CFG_ERR;
        } else {
            notifications_enabled = value == 0x0001;
            ccc_value[0] = param->write.value[0];
            ccc_value[1] = param->write.value[1];
            esp_ble_gatts_set_attr_value(
                attribute_handles[STATUS_CCC], sizeof(ccc_value), ccc_value);
        }
    }
    send_write_response(gatts_if, param, status);
    if (status == ESP_GATT_OK && notifications_enabled) {
        update_status(static_cast<ProvisioningState>(status_value[0]),
                      static_cast<ProvisioningResult>(status_value[1]));
    }
}

void gatts_callback(esp_gatts_cb_event_t event,
                    esp_gatt_if_t gatts_if,
                    esp_ble_gatts_cb_param_t *param) {
    switch (event) {
        case ESP_GATTS_REG_EVT: {
            if (param->reg.status != ESP_GATT_OK) {
                ESP_LOGE(LOG_TAG, "GATT registration failed: %d", param->reg.status);
                break;
            }
            active_gatts_if = gatts_if;
            esp_err_t error = esp_ble_gap_set_device_name(device_id);
            if (error != ESP_OK) {
                ESP_LOGE(LOG_TAG, "Could not set device name: %s",
                         esp_err_to_name(error));
            }

            pending_adv_configuration = ADV_CONFIG_FLAG | SCAN_RSP_CONFIG_FLAG;
            advertising_configuration_failed = false;
            error = esp_ble_gap_config_adv_data_raw(setup_adv_data,
                                                    sizeof(setup_adv_data));
            if (error != ESP_OK) {
                advertising_configuration_failed = true;
                ESP_LOGE(LOG_TAG, "Could not configure Pinkeva service advertisement: %s",
                         esp_err_to_name(error));
                pending_adv_configuration &= ~ADV_CONFIG_FLAG;
            }
            error = esp_ble_gap_config_scan_rsp_data_raw(
                setup_scan_response, sizeof(setup_scan_response));
            if (error != ESP_OK) {
                advertising_configuration_failed = true;
                ESP_LOGE(LOG_TAG, "Could not configure Pinkeva scan response: %s",
                         esp_err_to_name(error));
                pending_adv_configuration &= ~SCAN_RSP_CONFIG_FLAG;
            }

            error = esp_ble_gatts_create_attr_tab(
                provisioning_gatt_db, gatts_if, ATTRIBUTE_COUNT,
                SERVICE_INSTANCE_ID);
            if (error != ESP_OK) {
                ESP_LOGE(LOG_TAG, "Could not create provisioning GATT table: %s",
                         esp_err_to_name(error));
            }
            break;
        }
        case ESP_GATTS_CREAT_ATTR_TAB_EVT: {
            if (param->add_attr_tab.status != ESP_GATT_OK ||
                param->add_attr_tab.num_handle != ATTRIBUTE_COUNT) {
                ESP_LOGE(LOG_TAG, "Provisioning GATT table creation failed");
                break;
            }
            std::memcpy(attribute_handles, param->add_attr_tab.handles,
                        sizeof(attribute_handles));
            esp_err_t error = esp_ble_gatts_start_service(attribute_handles[SERVICE]);
            if (error != ESP_OK) {
                ESP_LOGE(LOG_TAG, "Could not start Pinkeva GATT service %s: %s",
                         PINKEVA_SERVICE_UUID_STRING, esp_err_to_name(error));
            }
            break;
        }
        case ESP_GATTS_START_EVT:
            if (param->start.status == ESP_GATT_OK) {
                service_started = true;
                ESP_LOGI(LOG_TAG, "Pinkeva GATT service ready: %s",
                         PINKEVA_SERVICE_UUID_STRING);
                try_start_maintenance_advertising();
            }
            break;
        case ESP_GATTS_CONNECT_EVT:
            connected = true;
            active_connection_id = param->connect.conn_id;
            notifications_enabled = false;
            ccc_value[0] = ccc_value[1] = 0;
            clear_staged_value();
            if (begin_connection_authorization() != ESP_OK) {
                ESP_LOGE(LOG_TAG, "Could not create connection challenge");
                esp_ble_gatts_close(gatts_if, param->connect.conn_id);
                break;
            }
            // Encryption and bonding are enforced by the key characteristic.
            // No-MITM is an explicit prototype limitation until QR/OOB pairing
            // or a physical confirmation control is present on production tags.
            esp_ble_set_encryption(param->connect.remote_bda,
                                   ESP_BLE_SEC_ENCRYPT_NO_MITM);
            break;
        case ESP_GATTS_DISCONNECT_EVT:
            connected = false;
            notifications_enabled = false;
            clear_staged_value();
            clear_connection_authorization();
            if (bond_cleanup_pending) {
                erase_all_bonds();
                bond_cleanup_pending = false;
            } else if (ble_mode == BLEMode::SUSPENDED) {
                update_status(ProvisioningState::SUSPENDED,
                              ProvisioningResult::ENTITLEMENT_REJECTED);
            } else if (ble_mode == BLEMode::SETUP) {
                update_status(ProvisioningState::UNPROVISIONED,
                              ProvisioningResult::SUCCESS);
            }
            try_start_maintenance_advertising();
            break;
        case ESP_GATTS_WRITE_EVT:
            if (param->write.is_prep) {
                handle_prepared_secure_write(gatts_if, param);
            } else if (secure_value_length(param->write.handle) != 0) {
                esp_gatt_status_t result = process_secure_write(
                    param->write.handle, param->write.value, param->write.len);
                send_write_response(gatts_if, param, result);
                if (result == ESP_GATT_INSUF_AUTHORIZATION) {
                    esp_ble_gatts_close(gatts_if, param->write.conn_id);
                }
            } else if (param->write.handle == attribute_handles[STATUS_CCC]) {
                handle_ccc_write(gatts_if, param);
            } else {
                send_write_response(gatts_if, param,
                                    ESP_GATT_WRITE_NOT_PERMIT);
            }
            break;
        case ESP_GATTS_EXEC_WRITE_EVT: {
            esp_gatt_status_t result = ESP_GATT_OK;
            bool was_authorization_write =
                staged_attribute_handle ==
                attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE];
            if (param->exec_write.exec_write_flag == ESP_GATT_PREP_WRITE_EXEC) {
                bool complete = staged_write_active &&
                                staged_value_length == staged_expected_length &&
                                std::all_of(staged_value_bytes,
                                            staged_value_bytes + staged_expected_length,
                                            [](bool received) { return received; });
                result = complete
                             ? process_secure_write(staged_attribute_handle,
                                                    staged_value,
                                                    staged_value_length)
                             : ESP_GATT_INVALID_ATTR_LEN;
                if (!complete) {
                    update_status(ProvisioningState::ERROR,
                                  ProvisioningResult::INVALID_LENGTH);
                }
            }
            clear_staged_value();
            esp_ble_gatts_send_response(
                gatts_if, param->exec_write.conn_id,
                param->exec_write.trans_id, result, nullptr);
            if (was_authorization_write && result != ESP_GATT_OK) {
                esp_ble_gatts_close(gatts_if, param->exec_write.conn_id);
            }
            break;
        }
        default:
            break;
    }
}

void gap_callback(esp_gap_ble_cb_event_t event,
                  esp_ble_gap_cb_param_t *param) {
    switch (event) {
        case ESP_GAP_BLE_ADV_DATA_RAW_SET_COMPLETE_EVT:
            if (param->adv_data_raw_cmpl.status != ESP_BT_STATUS_SUCCESS) {
                advertising_configuration_failed = true;
                ESP_LOGE(LOG_TAG, "Pinkeva service advertisement rejected: %d",
                         param->adv_data_raw_cmpl.status);
            }
            pending_adv_configuration &= ~ADV_CONFIG_FLAG;
            try_start_maintenance_advertising();
            break;
        case ESP_GAP_BLE_SCAN_RSP_DATA_RAW_SET_COMPLETE_EVT:
            if (param->scan_rsp_data_raw_cmpl.status != ESP_BT_STATUS_SUCCESS) {
                advertising_configuration_failed = true;
                ESP_LOGE(LOG_TAG, "Pinkeva scan response rejected: %d",
                         param->scan_rsp_data_raw_cmpl.status);
            }
            pending_adv_configuration &= ~SCAN_RSP_CONFIG_FLAG;
            try_start_maintenance_advertising();
            break;
        case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
            if (param->adv_start_cmpl.status != ESP_BT_STATUS_SUCCESS) {
                ESP_LOGE(LOG_TAG, "Advertising failed to start: %d",
                         param->adv_start_cmpl.status);
            }
            break;
        case ESP_GAP_BLE_SEC_REQ_EVT:
            esp_ble_gap_security_rsp(param->ble_security.ble_req.bd_addr, true);
            break;
        case ESP_GAP_BLE_AUTH_CMPL_EVT:
            if (!param->ble_security.auth_cmpl.success) {
                ESP_LOGW(LOG_TAG, "BLE pairing failed: reason 0x%x",
                         param->ble_security.auth_cmpl.fail_reason);
            }
            break;
        default:
            break;
    }
}

esp_err_t initialize_device_id() {
    uint8_t mac[6] = {};
    esp_err_t error = esp_efuse_mac_get_default(mac);
    if (error != ESP_OK) {
        return error;
    }
    std::snprintf(device_id, sizeof(device_id),
                  "PKV-%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2],
                  mac[3], mac[4], mac[5]);

    setup_scan_response[0] = DEVICE_ID_LEN;
    setup_scan_response[1] = ESP_BLE_AD_TYPE_NAME_CMPL;
    std::memcpy(setup_scan_response + 2, device_id, DEVICE_ID_LEN - 1);
    return ESP_OK;
}

esp_err_t configure_ble_security() {
    esp_ble_auth_req_t auth_request = ESP_LE_AUTH_REQ_SC_BOND;
    esp_ble_io_cap_t io_capability = ESP_IO_CAP_NONE;
    uint8_t key_size = 16;
    uint8_t key_mask = ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK;

    esp_err_t error = esp_ble_gap_set_security_param(
        ESP_BLE_SM_AUTHEN_REQ_MODE, &auth_request, sizeof(auth_request));
    if (error == ESP_OK) {
        error = esp_ble_gap_set_security_param(
            ESP_BLE_SM_IOCAP_MODE, &io_capability, sizeof(io_capability));
    }
    if (error == ESP_OK) {
        error = esp_ble_gap_set_security_param(
            ESP_BLE_SM_MAX_KEY_SIZE, &key_size, sizeof(key_size));
    }
    if (error == ESP_OK) {
        error = esp_ble_gap_set_security_param(
            ESP_BLE_SM_SET_INIT_KEY, &key_mask, sizeof(key_mask));
    }
    if (error == ESP_OK) {
        error = esp_ble_gap_set_security_param(
            ESP_BLE_SM_SET_RSP_KEY, &key_mask, sizeof(key_mask));
    }
    return error;
}
}  // namespace

std::optional<ERROR_TAG> ble_init() {
    esp_err_t error = nvs_init();
    if (error != ESP_OK) {
        return ERROR_TAG("NVS initialization failed", "NVS");
    }

    uint8_t bootstrap_key[DEVICE_BOOTSTRAP_KEY_SIZE] = {};
    error = load_device_bootstrap_key(bootstrap_key, sizeof(bootstrap_key));
    std::memset(bootstrap_key, 0, sizeof(bootstrap_key));
    if (error != ESP_OK) {
        return ERROR_TAG("Factory bootstrap key is missing or invalid", "NVS");
    }

    const esp_timer_create_args_t authorization_timer_arguments = {
        .callback = &authorization_timeout_callback,
        .arg = nullptr,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "ble_auth",
        .skip_unhandled_events = false,
    };
    error = esp_timer_create(&authorization_timer_arguments,
                             &authorization_timeout_timer);
    if (error != ESP_OK) {
        return ERROR_TAG("Authorization timer initialization failed", LOG_TAG);
    }
    error = initialize_device_id();
    if (error != ESP_OK) {
        return ERROR_TAG("Device ID initialization failed", "DEVICE_ID");
    }

    uint8_t existing_key[PUBLIC_KEY_SIZE] = {};
    if (load_advertisement_key(existing_key, sizeof(existing_key)) == ESP_OK) {
        // Fail closed: finder advertising requires a signed entitlement, which
        // is the next milestone. Never emit the finder payload on key alone.
        ble_mode = BLEMode::SUSPENDED;
        status_value[0] = static_cast<uint8_t>(ProvisioningState::SUSPENDED);
        status_value[1] =
            static_cast<uint8_t>(ProvisioningResult::ENTITLEMENT_REJECTED);
        if (update_key_fingerprint(existing_key) != ESP_OK) {
            std::memset(existing_key, 0, sizeof(existing_key));
            return ERROR_TAG("Key fingerprint initialization failed", "NVS");
        }
    } else {
        ble_mode = BLEMode::SETUP;
        update_key_fingerprint(nullptr);
    }
    std::memset(existing_key, 0, sizeof(existing_key));

    esp_bt_controller_config_t controller_config =
        BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    error = esp_bt_controller_init(&controller_config);
    if (error != ESP_OK) {
        return ERROR_TAG("BLE controller initialization failed", LOG_TAG);
    }
    error = esp_bt_controller_enable(ESP_BT_MODE_BLE);
    if (error != ESP_OK) {
        return ERROR_TAG("BLE controller enable failed", LOG_TAG);
    }
    error = esp_bluedroid_init();
    if (error != ESP_OK) {
        return ERROR_TAG("Bluedroid initialization failed", LOG_TAG);
    }
    error = esp_bluedroid_enable();
    if (error != ESP_OK) {
        return ERROR_TAG("Bluedroid enable failed", LOG_TAG);
    }
    error = esp_ble_gap_register_callback(gap_callback);
    if (error != ESP_OK) {
        return ERROR_TAG("GAP callback registration failed", LOG_TAG);
    }
    error = esp_ble_gatts_register_callback(gatts_callback);
    if (error != ESP_OK) {
        return ERROR_TAG("GATT callback registration failed", LOG_TAG);
    }
    error = configure_ble_security();
    if (error != ESP_OK) {
        return ERROR_TAG("BLE security configuration failed", LOG_TAG);
    }
    error = esp_ble_gatts_app_register(APP_ID);
    if (error != ESP_OK) {
        return ERROR_TAG("GATT application registration failed", LOG_TAG);
    }

    ESP_LOGI(LOG_TAG, "Bluetooth initialized for %s", device_id);
    return std::nullopt;
}
