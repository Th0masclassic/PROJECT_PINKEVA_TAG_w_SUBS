#include "ble_driver.hpp"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <vector>

#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_app_desc.h"
#include "esp_gap_ble_api.h"
#include "esp_gatt_defs.h"
#include "esp_gatts_api.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "mbedtls/md.h"
#include "mbedtls/platform_util.h"
#include "mbedtls/sha256.h"
#include "buzzer.hpp"
#include "nvs_driver.hpp"
#include "ota_update.hpp"
#include "sdkconfig.h"

#ifndef CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
#define CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP 0
#endif

#ifndef CONFIG_PINQEVA_LOG_ADVERTISEMENT_KEY
#define CONFIG_PINQEVA_LOG_ADVERTISEMENT_KEY 0
#endif

namespace {
constexpr char LOG_TAG[] = "BLE_DRIVER";
constexpr uint16_t APP_ID = 0;
constexpr uint8_t SERVICE_INSTANCE_ID = 0;
constexpr uint8_t DULT_SERVICE_INSTANCE_ID = 1;
constexpr uint8_t STATUS_VALUE_SIZE = 2;
constexpr uint8_t PROTOCOL_VALUE_SIZE = 6;
constexpr uint8_t KEY_FINGERPRINT_SIZE = 32;
constexpr uint8_t TAG_CHALLENGE_SIZE = 32;
constexpr uint8_t TAG_AUTHORIZATION_PROOF_SIZE = 32;
constexpr uint8_t UTC_TIME_SIZE = 8;
constexpr uint8_t RESET_COMMAND_SIZE = 64;
constexpr uint64_t AUTHORIZATION_TIMEOUT_MICROSECONDS = 30ULL * 1000ULL * 1000ULL;
constexpr uint64_t MAINTENANCE_WINDOW_MICROSECONDS =
    2ULL * 60ULL * 1000ULL * 1000ULL;
constexpr uint64_t CLOCK_SYNC_SKEW_TOLERANCE_SECONDS = 5ULL * 60ULL;
constexpr size_t MAX_STAGED_VALUE_SIZE = FIRMWARE_MANIFEST_SIZE;
constexpr uint8_t ADV_CONFIG_FLAG = 1U << 0;
constexpr uint8_t SCAN_RSP_CONFIG_FLAG = 1U << 1;
constexpr uint16_t TAG_AUTHORIZATION_CAPABILITY = 0x0010;
constexpr uint16_t NON_BONDING_SETUP_CAPABILITY = 0x0020;
constexpr uint16_t UTC_TIME_SYNC_CAPABILITY = 0x0040;
constexpr uint16_t FIRMWARE_UPDATE_CAPABILITY = 0x0080;
constexpr uint16_t DUAL_FINDING_NETWORK_CAPABILITY = 0x0100;
constexpr uint16_t DULT_SOUND_CAPABILITY = 0x0200;
constexpr uint16_t OWNER_RING_CAPABILITY = 0x0400;
constexpr size_t APPLE_FINDER_ADV_DATA_SIZE = 31;
constexpr size_t GOOGLE_FINDER_ADV_DATA_SIZE = 29;
constexpr uint64_t FINDER_FRAME_SLOT_MICROSECONDS =
    static_cast<uint64_t>(CONFIG_PINQEVA_FINDER_SLOT_MS) * 1000ULL;
constexpr uint64_t CONNECTION_IDLE_TIMEOUT_MICROSECONDS = 60ULL * 1000ULL * 1000ULL;
constexpr uint32_t OWNER_RING_DURATION_MILLISECONDS = 10U * 1000U;
constexpr uint8_t RING_PLAY = 0x01;
constexpr uint8_t RING_PAUSE = 0x00;
static_assert(CONFIG_PINQEVA_FINDER_SLOT_MS >= 2 * CONFIG_PINQEVA_FINDER_INTERVAL_MS,
              "Each finder slot must allow at least two advertising intervals");
static_assert(CONFIG_PINQEVA_FINDER_INTERVAL_MS % 5 == 0,
              "Finder interval must be a multiple of 5 ms");
constexpr uint32_t DULT_SOUND_DURATION_MILLISECONDS = 12U * 1000U;
constexpr uint16_t DULT_SOUND_START_OPCODE = 0x0300;
constexpr uint16_t DULT_SOUND_STOP_OPCODE = 0x0301;
constexpr uint16_t DULT_COMMAND_RESPONSE_OPCODE = 0x0302;
constexpr uint16_t DULT_SOUND_COMPLETED_OPCODE = 0x0303;
constexpr uint16_t DULT_RESPONSE_SUCCESS = 0x0000;
constexpr uint16_t DULT_RESPONSE_INVALID_STATE = 0x0001;
constexpr uint16_t DULT_RESPONSE_INVALID_CONFIGURATION = 0x0002;
constexpr uint16_t DULT_RESPONSE_INVALID_LENGTH = 0x0003;
constexpr uint16_t DULT_RESPONSE_INVALID_COMMAND = 0xFFFF;

enum class FinderFrame : uint8_t {
    APPLE,
    GOOGLE,
};

enum class SoundSource : uint8_t { NONE = 0, OWNER = 1, DULT = 2 };

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
constexpr uint8_t GOOGLE_ADVERTISEMENT_KEY_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x0A, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t UTC_TIME_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x0B, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t FIRMWARE_MANIFEST_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x0C, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t FIRMWARE_DATA_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x0D, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t FIRMWARE_CONTROL_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x0E, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t FIRMWARE_STATUS_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x0F, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t FIRMWARE_VERSION_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x10, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t GOOGLE_KEY_FINGERPRINT_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x11, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t FINDING_NETWORK_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x12, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t RING_AUTHORIZATION_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x13, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t RING_CONTROL_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x14, 0xF0, 0xF0, 0xA6,
};
constexpr uint8_t RING_STATUS_UUID[ESP_UUID_LEN_128] = {
    0x01, 0x0A, 0x8F, 0x4C, 0xD2, 0x72, 0x2E, 0x9C,
    0x1A, 0x4B, 0x4D, 0x3E, 0x15, 0xF0, 0xF0, 0xA6,
};

// Detecting Unwanted Location Trackers (DULT) non-owner service. UUID bytes
// are stored least-significant first by ESP-IDF.
constexpr char DULT_SERVICE_UUID_STRING[] =
    "15190001-12F4-C226-88ED-2AC5579F2A85";
constexpr uint8_t DULT_SERVICE_UUID[ESP_UUID_LEN_128] = {
    0x85, 0x2A, 0x9F, 0x57, 0xC5, 0x2A, 0xED, 0x88,
    0x26, 0xC2, 0xF4, 0x12, 0x01, 0x00, 0x19, 0x15,
};
constexpr uint8_t DULT_NON_OWNER_CONTROL_UUID[ESP_UUID_LEN_128] = {
    0x0E, 0x68, 0x21, 0x74, 0x37, 0x48, 0x61, 0xBF,
    0x92, 0xFB, 0x68, 0x1D, 0x01, 0x00, 0x0C, 0x8E,
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
    GOOGLE_ADVERTISEMENT_KEY_DECLARATION,
    GOOGLE_ADVERTISEMENT_KEY_VALUE,
    GOOGLE_KEY_FINGERPRINT_DECLARATION,
    GOOGLE_KEY_FINGERPRINT_VALUE,
    FINDING_NETWORK_DECLARATION,
    FINDING_NETWORK_VALUE,
    UTC_TIME_DECLARATION,
    UTC_TIME_VALUE,
    FIRMWARE_MANIFEST_DECLARATION,
    FIRMWARE_MANIFEST_VALUE,
    FIRMWARE_DATA_DECLARATION,
    FIRMWARE_DATA_VALUE,
    FIRMWARE_CONTROL_DECLARATION,
    FIRMWARE_CONTROL_VALUE,
    FIRMWARE_STATUS_DECLARATION,
    FIRMWARE_STATUS_VALUE,
    FIRMWARE_VERSION_DECLARATION,
    FIRMWARE_VERSION_VALUE,
    RING_AUTHORIZATION_DECLARATION,
    RING_AUTHORIZATION_VALUE,
    RING_CONTROL_DECLARATION,
    RING_CONTROL_VALUE,
    RING_STATUS_DECLARATION,
    RING_STATUS_VALUE,
    RING_STATUS_CCC,
    ATTRIBUTE_COUNT,
};

enum DultAttributeIndex : uint8_t {
    DULT_SERVICE,
    DULT_CONTROL_DECLARATION,
    DULT_CONTROL_VALUE,
    DULT_CONTROL_CCC,
    DULT_ATTRIBUTE_COUNT,
};

constexpr uint16_t PRIMARY_SERVICE_UUID = ESP_GATT_UUID_PRI_SERVICE;
constexpr uint16_t CHARACTER_DECLARATION_UUID = ESP_GATT_UUID_CHAR_DECLARE;
constexpr uint16_t CLIENT_CONFIG_UUID = ESP_GATT_UUID_CHAR_CLIENT_CONFIG;
constexpr uint8_t READ_PROPERTY = ESP_GATT_CHAR_PROP_BIT_READ;
constexpr uint8_t WRITE_PROPERTY = ESP_GATT_CHAR_PROP_BIT_WRITE;
constexpr uint8_t READ_WRITE_PROPERTY =
    ESP_GATT_CHAR_PROP_BIT_READ | ESP_GATT_CHAR_PROP_BIT_WRITE;
constexpr uint8_t WRITE_WITHOUT_RESPONSE_PROPERTY =
    ESP_GATT_CHAR_PROP_BIT_WRITE | ESP_GATT_CHAR_PROP_BIT_WRITE_NR;
constexpr uint8_t READ_NOTIFY_PROPERTY =
    ESP_GATT_CHAR_PROP_BIT_READ | ESP_GATT_CHAR_PROP_BIT_NOTIFY;
constexpr uint8_t WRITE_INDICATE_PROPERTY =
    ESP_GATT_CHAR_PROP_BIT_WRITE | ESP_GATT_CHAR_PROP_BIT_INDICATE;

// Protocol 1.9, firmware 0.6. Capability bit 0x10 requires a backend-issued,
// nonce-bound authorization proof before any provisioning/reset write. The
// checked-in development profile also advertises bit 0x20: setup deliberately
// avoids OS pairing/bonding and therefore must never be shipped as the final
// production transport until application-layer key confidentiality is added.
// Bit 0x40 asks an authorized phone to provide Unix UTC on each connection.
// Bit 0x80 supports signed, rollback-safe BLE OTA through dual app partitions.
// Bit 0x100 provisions Apple and Google identities together. The selector is
// retained as the setup/UI preference; experimental firmware time-slices both
// finder frames after provisioning.
// Bit 0x200 exposes the public DULT non-owner sound controls.
// Bit 0x400 adds owner ring control. Its control-key HMAC is NEVER bypassed,
// including on the development profile. It grants sound control only.
constexpr uint16_t PROTOCOL_CAPABILITIES =
    0x000F | TAG_AUTHORIZATION_CAPABILITY | UTC_TIME_SYNC_CAPABILITY |
    FIRMWARE_UPDATE_CAPABILITY | DUAL_FINDING_NETWORK_CAPABILITY |
    DULT_SOUND_CAPABILITY | OWNER_RING_CAPABILITY |
#if CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
    NON_BONDING_SETUP_CAPABILITY;
#else
    0x0000;
#endif
uint8_t protocol_value[PROTOCOL_VALUE_SIZE] = {
    1,
    9,
    0,
    6,
    static_cast<uint8_t>(PROTOCOL_CAPABILITIES & 0xFFU),
    static_cast<uint8_t>((PROTOCOL_CAPABILITIES >> 8U) & 0xFFU),
};

#if CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
// Development hardware uses application authorization without asking iOS or
// Android to create a system pairing/bond. This keeps the current hardware
// workflow testable, but it does not provide production-grade confidentiality
// for the key material on the radio link.
constexpr uint16_t SETUP_READ_PERMISSION = ESP_GATT_PERM_READ;
constexpr uint16_t SETUP_WRITE_PERMISSION = ESP_GATT_PERM_WRITE;
#else
constexpr uint16_t SETUP_READ_PERMISSION = ESP_GATT_PERM_READ_ENCRYPTED;
constexpr uint16_t SETUP_WRITE_PERMISSION = ESP_GATT_PERM_WRITE_ENCRYPTED;
#endif
char device_id[DEVICE_ID_LEN] = {};
// A versioned, deterministic static-random address keeps setup stable across
// reboots while separating it from an old public-address bond cached by iOS.
// Increment the version when a development device must intentionally appear
// as a new CoreBluetooth peripheral. Version 3 invalidates the setup identity
// used by the previous checked-in image while leaving the factory serial
// number, provisioning records, and finder identity unchanged.
constexpr uint8_t SETUP_BLE_IDENTITY_VERSION = 3;
esp_bd_addr_t setup_ble_address = {};
esp_bd_addr_t apple_finder_ble_address = {};
esp_bd_addr_t google_finder_ble_address = {};
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
uint8_t google_advertisement_key_attribute[GOOGLE_ADVERTISEMENT_KEY_SIZE] = {};
uint8_t google_key_fingerprint_attribute[KEY_FINGERPRINT_SIZE] = {};
uint8_t finding_network_attribute[1] = {};
uint8_t utc_time_attribute[UTC_TIME_SIZE] = {};
uint8_t firmware_manifest_attribute[FIRMWARE_MANIFEST_SIZE] = {};
uint8_t firmware_data_attribute[512] = {};
uint8_t firmware_control_attribute[1] = {};
uint8_t firmware_status_attribute[FIRMWARE_STATUS_SIZE] = {};
uint8_t firmware_version_attribute[3] = {0, 6, 0};
uint8_t ring_authorization_attribute[TAG_AUTHORIZATION_PROOF_SIZE] = {};
uint8_t ring_control_attribute[1] = {};
uint8_t ring_status_attribute[2] = {};
uint8_t ring_ccc_value[2] = {};
uint16_t attribute_handles[ATTRIBUTE_COUNT] = {};
uint16_t dult_attribute_handles[DULT_ATTRIBUTE_COUNT] = {};

BLEMode ble_mode = BLEMode::SETUP;
std::atomic<esp_gatt_if_t> active_gatts_if{ESP_GATT_IF_NONE};
std::atomic<uint16_t> active_connection_id{0};
std::atomic_bool connected{false};
bool notifications_enabled = false;
std::atomic_bool dult_indications_enabled{false};
std::atomic_bool ring_notifications_enabled{false};
std::atomic_bool ring_authorized{false};
std::atomic<int64_t> ring_authorization_deadline{0};
std::atomic<int64_t> connection_idle_deadline{0};
std::atomic<SoundSource> sound_source{SoundSource::NONE};
std::atomic<uint32_t> connection_generation{0};
std::atomic<uint32_t> dult_sound_generation{0};
std::atomic_bool service_started{false};
bool pinkeva_service_started = false;
bool dult_service_started = false;
bool advertising_configuration_failed = false;
std::atomic_bool connection_authorized{false};
esp_timer_handle_t authorization_timeout_timer = nullptr;
esp_timer_handle_t connection_idle_timer = nullptr;
esp_timer_handle_t maintenance_window_timer = nullptr;
esp_timer_handle_t finder_frame_timer = nullptr;
uint64_t trusted_clock_epoch = 0;
int64_t trusted_clock_started_microseconds = 0;
bool trusted_clock_is_set = false;
uint8_t pending_adv_configuration = 0;
bool scan_response_configured = false;
bool scan_response_uses_setup = false;
bool pending_scan_response_uses_setup = false;
bool random_address_change_pending = false;
bool advertising_active = false;
bool advertising_refresh_pending = false;
bool maintenance_window_open = false;
FinderFrame active_finder_frame = FinderFrame::APPLE;
bool finder_frames_ready = false;
std::atomic<uint16_t> dult_sound_connection_id{0};

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
// Finder payloads already fill the advertisement. A service-only scan response
// lets the owner app discover/connect without broadcasting a stable serial.
uint8_t tracker_scan_response[18] = {
    0x11, ESP_BLE_AD_TYPE_128SRV_CMPL,
    PINKEVA_SERVICE_UUID[0], PINKEVA_SERVICE_UUID[1], PINKEVA_SERVICE_UUID[2],
    PINKEVA_SERVICE_UUID[3], PINKEVA_SERVICE_UUID[4], PINKEVA_SERVICE_UUID[5],
    PINKEVA_SERVICE_UUID[6], PINKEVA_SERVICE_UUID[7], PINKEVA_SERVICE_UUID[8],
    PINKEVA_SERVICE_UUID[9], PINKEVA_SERVICE_UUID[10], PINKEVA_SERVICE_UUID[11],
    PINKEVA_SERVICE_UUID[12], PINKEVA_SERVICE_UUID[13], PINKEVA_SERVICE_UUID[14],
    PINKEVA_SERVICE_UUID[15],
};
uint8_t apple_finder_adv_data[APPLE_FINDER_ADV_DATA_SIZE] = {};
uint8_t google_finder_adv_data[GOOGLE_FINDER_ADV_DATA_SIZE] = {};
uint8_t dult_control_value[6] = {};
uint8_t dult_ccc_value[2] = {0x00, 0x00};

esp_ble_adv_params_t setup_adv_params = {
    .adv_int_min = 0x00A0,  // 100 ms while actively setting up.
    .adv_int_max = 0x0190,  // 250 ms.
    .adv_type = ADV_TYPE_IND,
    .own_addr_type = BLE_ADDR_TYPE_RANDOM,
    .peer_addr = {0},
    .peer_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .channel_map = ADV_CHNL_ALL,
    .adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};

esp_ble_adv_params_t maintenance_adv_params = {
    .adv_int_min = 0x0190,  // 250 ms during a user-requested maintenance window.
    .adv_int_max = 0x0280,  // 400 ms.
    .adv_type = ADV_TYPE_IND,
    .own_addr_type = BLE_ADDR_TYPE_RANDOM,
    .peer_addr = {0},
    .peer_addr_type = BLE_ADDR_TYPE_PUBLIC,
    .channel_map = ADV_CHNL_ALL,
    .adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};

esp_ble_adv_params_t finder_adv_params = {
    // BLE units are 0.625 ms. Defaults preserve the existing finder cadence;
    // a slower, explicit build profile can trade discovery latency for power.
    .adv_int_min = CONFIG_PINQEVA_FINDER_INTERVAL_MS * 8 / 5,
    .adv_int_max = CONFIG_PINQEVA_FINDER_INTERVAL_MS * 8 / 5,
    // Connectable finder frames let Apple/Android non-owner detection clients
    // reach the public DULT sound service. Pinkeva provisioning characteristics
    // still enforce their independent authorization rules.
    .adv_type = ADV_TYPE_IND,
    .own_addr_type = BLE_ADDR_TYPE_RANDOM,
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
          SETUP_WRITE_PERMISSION,
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
          SETUP_READ_PERMISSION,
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
          SETUP_WRITE_PERMISSION,
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
          SETUP_WRITE_PERMISSION,
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
           ESP_GATT_PERM_READ,
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
          SETUP_WRITE_PERMISSION,
          sizeof(tag_authorization_proof_attribute),
          0,
          tag_authorization_proof_attribute}},

    [GOOGLE_ADVERTISEMENT_KEY_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [GOOGLE_ADVERTISEMENT_KEY_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(GOOGLE_ADVERTISEMENT_KEY_UUID),
          SETUP_WRITE_PERMISSION,
          sizeof(google_advertisement_key_attribute),
          0,
          google_advertisement_key_attribute}},

    [GOOGLE_KEY_FINGERPRINT_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_PROPERTY)}},
    [GOOGLE_KEY_FINGERPRINT_VALUE] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(GOOGLE_KEY_FINGERPRINT_UUID),
          SETUP_READ_PERMISSION,
          sizeof(google_key_fingerprint_attribute),
          sizeof(google_key_fingerprint_attribute),
          google_key_fingerprint_attribute}},

    [FINDING_NETWORK_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_WRITE_PROPERTY)}},
    [FINDING_NETWORK_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(FINDING_NETWORK_UUID),
          static_cast<uint16_t>(SETUP_READ_PERMISSION | SETUP_WRITE_PERMISSION),
          sizeof(finding_network_attribute),
          sizeof(finding_network_attribute),
          finding_network_attribute}},

    [UTC_TIME_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [UTC_TIME_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(UTC_TIME_UUID),
          SETUP_WRITE_PERMISSION,
          sizeof(utc_time_attribute),
          0,
          utc_time_attribute}},

    [FIRMWARE_MANIFEST_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [FIRMWARE_MANIFEST_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(FIRMWARE_MANIFEST_UUID),
          SETUP_WRITE_PERMISSION,
          sizeof(firmware_manifest_attribute),
          0,
          firmware_manifest_attribute}},

    [FIRMWARE_DATA_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_WITHOUT_RESPONSE_PROPERTY)}},
    [FIRMWARE_DATA_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(FIRMWARE_DATA_UUID),
          SETUP_WRITE_PERMISSION,
          sizeof(firmware_data_attribute),
          0,
          firmware_data_attribute}},

    [FIRMWARE_CONTROL_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [FIRMWARE_CONTROL_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(FIRMWARE_CONTROL_UUID),
          SETUP_WRITE_PERMISSION,
          sizeof(firmware_control_attribute),
          0,
          firmware_control_attribute}},

    [FIRMWARE_STATUS_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_PROPERTY)}},
    [FIRMWARE_STATUS_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(FIRMWARE_STATUS_UUID),
          SETUP_READ_PERMISSION,
          sizeof(firmware_status_attribute),
          0,
          firmware_status_attribute}},

    [FIRMWARE_VERSION_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_PROPERTY)}},
    [FIRMWARE_VERSION_VALUE] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(FIRMWARE_VERSION_UUID),
          ESP_GATT_PERM_READ,
          sizeof(firmware_version_attribute),
          sizeof(firmware_version_attribute),
           firmware_version_attribute}},

    [RING_AUTHORIZATION_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ, sizeof(uint8_t), sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [RING_AUTHORIZATION_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128, const_cast<uint8_t *>(RING_AUTHORIZATION_UUID),
          ESP_GATT_PERM_WRITE, sizeof(ring_authorization_attribute), 0,
          ring_authorization_attribute}},
    [RING_CONTROL_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ, sizeof(uint8_t), sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_PROPERTY)}},
    [RING_CONTROL_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128, const_cast<uint8_t *>(RING_CONTROL_UUID),
          ESP_GATT_PERM_WRITE, sizeof(ring_control_attribute), 0,
          ring_control_attribute}},
    [RING_STATUS_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ, sizeof(uint8_t), sizeof(uint8_t),
          const_cast<uint8_t *>(&READ_NOTIFY_PROPERTY)}},
    [RING_STATUS_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128, const_cast<uint8_t *>(RING_STATUS_UUID),
          ESP_GATT_PERM_READ, sizeof(ring_status_attribute),
          sizeof(ring_status_attribute), ring_status_attribute}},
    [RING_STATUS_CCC] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CLIENT_CONFIG_UUID)),
          ESP_GATT_PERM_READ | ESP_GATT_PERM_WRITE,
          sizeof(ring_ccc_value), sizeof(ring_ccc_value), ring_ccc_value}},
};

const esp_gatts_attr_db_t dult_gatt_db[DULT_ATTRIBUTE_COUNT] = {
    [DULT_SERVICE] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&PRIMARY_SERVICE_UUID)),
          ESP_GATT_PERM_READ,
          ESP_UUID_LEN_128,
          ESP_UUID_LEN_128,
          const_cast<uint8_t *>(DULT_SERVICE_UUID)}},

    [DULT_CONTROL_DECLARATION] =
        {{ESP_GATT_AUTO_RSP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CHARACTER_DECLARATION_UUID)),
          ESP_GATT_PERM_READ,
          sizeof(uint8_t),
          sizeof(uint8_t),
          const_cast<uint8_t *>(&WRITE_INDICATE_PROPERTY)}},
    [DULT_CONTROL_VALUE] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_128,
          const_cast<uint8_t *>(DULT_NON_OWNER_CONTROL_UUID),
          ESP_GATT_PERM_WRITE,
          sizeof(dult_control_value),
          0,
          dult_control_value}},
    [DULT_CONTROL_CCC] =
        {{ESP_GATT_RSP_BY_APP},
         {ESP_UUID_LEN_16,
          reinterpret_cast<uint8_t *>(const_cast<uint16_t *>(&CLIENT_CONFIG_UUID)),
          ESP_GATT_PERM_READ | ESP_GATT_PERM_WRITE,
          sizeof(dult_ccc_value),
          sizeof(dult_ccc_value),
          dult_ccc_value}},
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
    ring_authorized = false;
    ring_authorization_deadline = 0;
    std::memset(tag_challenge_attribute, 0, sizeof(tag_challenge_attribute));
    std::memset(tag_authorization_proof_attribute, 0,
                sizeof(tag_authorization_proof_attribute));
}

void authorization_timeout_callback(void *) {
    if (connected && !connection_authorized && !ring_authorized &&
        esp_timer_get_time() >= ring_authorization_deadline &&
        active_gatts_if != ESP_GATT_IF_NONE) {
        ESP_LOGW(LOG_TAG, "Closing connection without app authorization");
        esp_ble_gatts_close(active_gatts_if, active_connection_id);
    }
}

void connection_idle_timeout_callback(void *) {
    if (connected && esp_timer_get_time() >= connection_idle_deadline &&
        active_gatts_if != ESP_GATT_IF_NONE) {
        ESP_LOGI(LOG_TAG, "Closing idle BLE link; resuming finder advertising");
        esp_ble_gatts_close(active_gatts_if, active_connection_id);
    }
}

void refresh_connection_idle_timeout() {
    if (connection_idle_timer != nullptr && connected) {
        connection_idle_deadline = esp_timer_get_time() + CONNECTION_IDLE_TIMEOUT_MICROSECONDS;
        esp_timer_stop(connection_idle_timer);
        const esp_err_t error = esp_timer_start_once(
            connection_idle_timer, CONNECTION_IDLE_TIMEOUT_MICROSECONDS);
        if (error != ESP_OK) {
            ESP_LOGW(LOG_TAG, "Could not arm BLE idle timeout: %s", esp_err_to_name(error));
        }
    }
}

esp_err_t begin_connection_authorization() {
    clear_connection_authorization();
    esp_fill_random(tag_challenge_attribute, sizeof(tag_challenge_attribute));
    ring_authorization_deadline = esp_timer_get_time() + AUTHORIZATION_TIMEOUT_MICROSECONDS;
    esp_err_t error = esp_ble_gatts_set_attr_value(
        attribute_handles[TAG_CHALLENGE_VALUE],
        sizeof(tag_challenge_attribute), tag_challenge_attribute);
    if (error != ESP_OK) {
        return error;
    }
#if CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
    connection_authorized = true;
    ESP_LOGW(LOG_TAG,
             "DEVELOPMENT MODE: bootstrap authorization bypassed for this connection");
    return ESP_OK;
#else
    if (authorization_timeout_timer == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    return esp_timer_start_once(authorization_timeout_timer,
                                AUTHORIZATION_TIMEOUT_MICROSECONDS);
#endif
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

esp_err_t update_fingerprint(const uint8_t *key,
                             size_t key_length,
                             uint8_t *fingerprint,
                             size_t fingerprint_length,
                             AttributeIndex attribute_index) {
    if (fingerprint == nullptr || fingerprint_length != KEY_FINGERPRINT_SIZE) {
        return ESP_ERR_INVALID_ARG;
    }
    if (key == nullptr) {
        std::memset(fingerprint, 0, fingerprint_length);
    } else if (mbedtls_sha256(key, key_length, fingerprint, 0) != 0) {
        std::memset(fingerprint, 0, fingerprint_length);
        return ESP_FAIL;
    }
    if (attribute_handles[attribute_index] != 0) {
        return esp_ble_gatts_set_attr_value(
            attribute_handles[attribute_index], fingerprint_length, fingerprint);
    }
    return ESP_OK;
}

esp_err_t update_key_fingerprint(const uint8_t *key) {
    return update_fingerprint(key, PUBLIC_KEY_SIZE, key_fingerprint_attribute,
                              sizeof(key_fingerprint_attribute),
                              KEY_FINGERPRINT_VALUE);
}

esp_err_t update_google_key_fingerprint(const uint8_t *key) {
    return update_fingerprint(key, GOOGLE_ADVERTISEMENT_KEY_SIZE,
                              google_key_fingerprint_attribute,
                              sizeof(google_key_fingerprint_attribute),
                              GOOGLE_KEY_FINGERPRINT_VALUE);
}

void log_received_advertisement_key(const uint8_t *key, size_t length) {
#if CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP && CONFIG_PINQEVA_LOG_ADVERTISEMENT_KEY
    if (key == nullptr || length != PUBLIC_KEY_SIZE) {
        return;
    }
    char encoded_key[PUBLIC_KEY_SIZE * 2 + 1] = {};
    for (size_t index = 0; index < length; ++index) {
        std::snprintf(encoded_key + (index * 2), 3, "%02X", key[index]);
    }
    ESP_LOGI(LOG_TAG,
             "Received advertisement key over BLE (%u bytes): %s",
             static_cast<unsigned>(length), encoded_key);
#else
    (void)key;
    (void)length;
#endif
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

esp_err_t configure_apple_finder_advertisement(const uint8_t *key,
                                                size_t length) {
    if (!advertisement_key_is_valid(key, length)) {
        return ESP_ERR_INVALID_ARG;
    }

    // The legacy Find My ESP32 test script uses the first six public-key bytes
    // as the static-random BLE address and puts the remaining 22 bytes in the
    // Apple offline-finding manufacturer payload. The public advertisement key
    // is the complete on-device requirement; subscriptions protect cloud
    // services and are intentionally not a radio kill switch.
    apple_finder_ble_address[0] = static_cast<uint8_t>(key[0] | 0xC0U);
    std::memcpy(apple_finder_ble_address + 1, key + 1, 5);

    std::memset(apple_finder_adv_data, 0, sizeof(apple_finder_adv_data));
    apple_finder_adv_data[0] = 0x1E;  // 30 bytes follow this length byte.
    apple_finder_adv_data[1] = 0xFF;  // Manufacturer-specific data.
    apple_finder_adv_data[2] = 0x4C;  // Apple company identifier, little endian.
    apple_finder_adv_data[3] = 0x00;
    apple_finder_adv_data[4] = 0x12;  // Offline Finding type.
    apple_finder_adv_data[5] = 0x19;  // Offline Finding payload length.
    apple_finder_adv_data[6] = 0x00;  // State.
    std::memcpy(apple_finder_adv_data + 7, key + 6, 22);
    apple_finder_adv_data[29] = static_cast<uint8_t>(key[0] >> 6);
    apple_finder_adv_data[30] = 0x00;  // Hint.

    ESP_LOGI(LOG_TAG,
             "Apple finder BLE identity: %02X:%02X:%02X:%02X:%02X:%02X",
             apple_finder_ble_address[0], apple_finder_ble_address[1],
             apple_finder_ble_address[2], apple_finder_ble_address[3],
             apple_finder_ble_address[4], apple_finder_ble_address[5]);
    return ESP_OK;
}

esp_err_t configure_google_finder_advertisement(const uint8_t *eid,
                                                 size_t length) {
    if (!google_advertisement_key_is_valid(eid, length)) {
        return ESP_ERR_INVALID_ARG;
    }

    // This development frame is the counter-zero FMDN EID generated by the
    // backend. Certified hardware must rotate the EID and BLE address using a
    // battery-backed clock. Hashing here gives this development identity a
    // deterministic non-resolvable private address (NRPA) without exposing
    // more key material.
    uint8_t address_digest[KEY_FINGERPRINT_SIZE] = {};
    if (mbedtls_sha256(eid, length, address_digest, 0) != 0) {
        return ESP_FAIL;
    }
    std::memcpy(google_finder_ble_address, address_digest,
                sizeof(google_finder_ble_address));
    google_finder_ble_address[0] =
        static_cast<uint8_t>(google_finder_ble_address[0] & 0x3FU);
    std::memset(address_digest, 0, sizeof(address_digest));

    // Google Find Hub Network legacy service-data frame used by the pinned
    // GoogleFindMyTools development bridge: flags, UUID 0xFEAA, unwanted-
    // tracking frame type 0x41, 20-byte EID, and one hashed-flags byte.
    std::memset(google_finder_adv_data, 0, sizeof(google_finder_adv_data));
    constexpr uint8_t GOOGLE_FRAME_PREFIX[] = {
        0x02, 0x01, 0x06, 0x19, 0x16, 0xAA, 0xFE, 0x41,
    };
    std::memcpy(google_finder_adv_data, GOOGLE_FRAME_PREFIX,
                sizeof(GOOGLE_FRAME_PREFIX));
    std::memcpy(google_finder_adv_data + sizeof(GOOGLE_FRAME_PREFIX), eid,
                length);
    google_finder_adv_data[GOOGLE_FINDER_ADV_DATA_SIZE - 1] = 0x00;

    ESP_LOGI(LOG_TAG,
             "Google finder BLE identity: %02X:%02X:%02X:%02X:%02X:%02X",
             google_finder_ble_address[0], google_finder_ble_address[1],
             google_finder_ble_address[2], google_finder_ble_address[3],
             google_finder_ble_address[4], google_finder_ble_address[5]);
    return ESP_OK;
}

uint8_t *active_finder_address() {
    return active_finder_frame == FinderFrame::APPLE
               ? apple_finder_ble_address
               : google_finder_ble_address;
}

uint8_t *active_finder_advertisement() {
    return active_finder_frame == FinderFrame::APPLE
               ? apple_finder_adv_data
               : google_finder_adv_data;
}

size_t active_finder_advertisement_size() {
    return active_finder_frame == FinderFrame::APPLE
               ? APPLE_FINDER_ADV_DATA_SIZE
               : GOOGLE_FINDER_ADV_DATA_SIZE;
}

const char *active_finder_network_name() {
    return active_finder_frame == FinderFrame::APPLE ? "Apple" : "Google";
}

void stop_finder_frame_timer() {
    if (finder_frame_timer != nullptr) {
        const esp_err_t error = esp_timer_stop(finder_frame_timer);
        if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) {
            ESP_LOGW(LOG_TAG, "Could not stop finder frame timer: %s",
                     esp_err_to_name(error));
        }
    }
}

void request_advertising_refresh();

void finder_frame_timer_callback(void *) {
    if (ble_mode != BLEMode::TRACKER || maintenance_window_open || connected ||
        !finder_frames_ready) {
        return;
    }
    active_finder_frame = active_finder_frame == FinderFrame::APPLE
                              ? FinderFrame::GOOGLE
                              : FinderFrame::APPLE;
    request_advertising_refresh();
}

void configure_advertising_for_mode() {
    if (active_gatts_if == ESP_GATT_IF_NONE) {
        return;
    }
    const bool maintenance_frame =
        maintenance_window_open && ble_mode != BLEMode::SETUP;
    const bool setup_frame = ble_mode == BLEMode::SETUP || maintenance_frame;
    stop_finder_frame_timer();
    const bool update_scan_response = !scan_response_configured ||
                                      scan_response_uses_setup != setup_frame;
    pending_adv_configuration = ADV_CONFIG_FLAG |
        (update_scan_response ? SCAN_RSP_CONFIG_FLAG : 0);
    advertising_configuration_failed = false;
    if (ble_mode == BLEMode::TRACKER && !maintenance_frame) {
        random_address_change_pending = true;
        esp_err_t address_error =
            esp_ble_gap_set_rand_addr(active_finder_address());
        if (address_error != ESP_OK) {
            random_address_change_pending = false;
            ESP_LOGE(LOG_TAG, "Could not activate finder BLE identity: %s",
                     esp_err_to_name(address_error));
        }
    } else {
        random_address_change_pending = true;
        esp_err_t address_error = esp_ble_gap_set_rand_addr(setup_ble_address);
        if (address_error != ESP_OK) {
            random_address_change_pending = false;
            ESP_LOGE(LOG_TAG, "Could not activate setup BLE identity: %s",
                     esp_err_to_name(address_error));
        }
    }

    uint8_t *advertisement_data =
        setup_frame ? setup_adv_data : active_finder_advertisement();
    size_t advertisement_data_size =
        setup_frame ? sizeof(setup_adv_data)
                    : active_finder_advertisement_size();
    if (!setup_frame && !finder_frames_ready) {
        advertising_configuration_failed = true;
        pending_adv_configuration = 0;
        ESP_LOGE(LOG_TAG, "Finder advertisement was not initialized");
        return;
    }
    esp_err_t error = esp_ble_gap_config_adv_data_raw(
        advertisement_data, advertisement_data_size);
    if (error != ESP_OK) {
        advertising_configuration_failed = true;
        pending_adv_configuration &= ~ADV_CONFIG_FLAG;
        ESP_LOGE(LOG_TAG, "Could not configure BLE advertisement: %s",
                 esp_err_to_name(error));
    }
    // Apple/Google swaps use the same service-only response; do not re-send
    // identical HCI data every slot. Change it only on setup/maintenance entry
    // or exit, so a tracker never inherits the setup response's stable serial.
    if (update_scan_response) {
        pending_scan_response_uses_setup = setup_frame;
        error = esp_ble_gap_config_scan_rsp_data_raw(
            setup_frame ? setup_scan_response : tracker_scan_response,
            setup_frame ? sizeof(setup_scan_response) : sizeof(tracker_scan_response));
        if (error != ESP_OK) {
            scan_response_configured = false;
            advertising_configuration_failed = true;
            pending_adv_configuration &= ~SCAN_RSP_CONFIG_FLAG;
            ESP_LOGE(LOG_TAG, "Could not configure Pinkeva scan response: %s",
                     esp_err_to_name(error));
        }
    }
}

void try_start_advertising() {
    if (!connected && service_started && pending_adv_configuration == 0 &&
        !advertising_configuration_failed && !random_address_change_pending) {
        const bool maintenance_frame =
            maintenance_window_open && ble_mode != BLEMode::SETUP;
        esp_ble_adv_params_t *parameters = &finder_adv_params;
        if (ble_mode == BLEMode::SETUP) {
            parameters = &setup_adv_params;
        } else if (maintenance_frame) {
            parameters = &maintenance_adv_params;
        }
        esp_err_t error = esp_ble_gap_start_advertising(parameters);
        if (error != ESP_OK) {
            ESP_LOGE(LOG_TAG, "Could not start BLE advertising: %s",
                     esp_err_to_name(error));
        }
    }
}

void request_advertising_refresh() {
    if (connected) {
        advertising_refresh_pending = true;
        return;
    }
    if (advertising_active) {
        advertising_refresh_pending = true;
        const esp_err_t error = esp_ble_gap_stop_advertising();
        if (error == ESP_OK) return;
        ESP_LOGW(LOG_TAG, "Could not stop advertising for refresh: %s",
                 esp_err_to_name(error));
        advertising_active = false;
    }
    advertising_refresh_pending = false;
    configure_advertising_for_mode();
}

uint64_t read_uint64_be(const uint8_t *value) {
    uint64_t result = 0;
    for (size_t index = 0; index < sizeof(uint64_t); ++index) {
        result = (result << 8U) | value[index];
    }
    return result;
}

uint64_t trusted_clock_now() {
    if (!trusted_clock_is_set) return 0;
    const int64_t elapsed = esp_timer_get_time() - trusted_clock_started_microseconds;
    if (elapsed < 0) return trusted_clock_epoch;
    return trusted_clock_epoch + static_cast<uint64_t>(elapsed / 1000000LL);
}

esp_err_t restore_finder_configuration(bool *complete) {
    if (complete == nullptr) return ESP_ERR_INVALID_ARG;
    *complete = false;

    uint8_t apple_key[PUBLIC_KEY_SIZE] = {};
    uint8_t google_key[GOOGLE_ADVERTISEMENT_KEY_SIZE] = {};
    uint8_t control_key[TAG_CONTROL_KEY_SIZE] = {};
    FindingNetwork network = FindingNetwork::APPLE;
    const esp_err_t apple_result =
        load_advertisement_key(apple_key, sizeof(apple_key));
    const esp_err_t google_result =
        load_google_advertisement_key(google_key, sizeof(google_key));
    const esp_err_t control_result =
        load_tag_control_key(control_key, sizeof(control_key));
    const esp_err_t network_result = load_finding_network(&network);

    esp_err_t result = update_key_fingerprint(
        apple_result == ESP_OK ? apple_key : nullptr);
    if (result == ESP_OK) {
        result = update_google_key_fingerprint(
            google_result == ESP_OK ? google_key : nullptr);
    }
    finding_network_attribute[0] =
        network_result == ESP_OK ? static_cast<uint8_t>(network) : 0;
    if (result == ESP_OK && attribute_handles[FINDING_NETWORK_VALUE] != 0) {
        result = esp_ble_gatts_set_attr_value(
            attribute_handles[FINDING_NETWORK_VALUE],
            sizeof(finding_network_attribute), finding_network_attribute);
    }

    const bool has_everything = apple_result == ESP_OK &&
                                google_result == ESP_OK &&
                                control_result == ESP_OK &&
                                network_result == ESP_OK;
    finder_frames_ready = false;
    if (result == ESP_OK && has_everything) {
        result = configure_apple_finder_advertisement(
            apple_key, sizeof(apple_key));
        if (result == ESP_OK) {
            result = configure_google_finder_advertisement(
                google_key, sizeof(google_key));
        }
        if (result == ESP_OK) {
            active_finder_frame = network == FindingNetwork::APPLE
                                      ? FinderFrame::APPLE
                                      : FinderFrame::GOOGLE;
            finder_frames_ready = true;
        }
    }

    std::memset(apple_key, 0, sizeof(apple_key));
    std::memset(google_key, 0, sizeof(google_key));
    std::memset(control_key, 0, sizeof(control_key));
    if (result != ESP_OK) return result;

    *complete = has_everything;
    ble_mode = has_everything ? BLEMode::TRACKER : BLEMode::SETUP;
    update_status(has_everything ? ProvisioningState::READY
                                 : ProvisioningState::UNPROVISIONED,
                  ProvisioningResult::SUCCESS);
    return ESP_OK;
}

esp_gatt_status_t persist_trusted_utc(const uint8_t *value, size_t length) {
    if (value == nullptr || length != UTC_TIME_SIZE) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INVALID_LENGTH);
        return ESP_GATT_INVALID_ATTR_LEN;
    }
    const uint64_t requested_epoch = read_uint64_be(value);
    const uint64_t current_epoch = trusted_clock_now();
    const uint64_t rollback_floor =
        trusted_clock_is_set ? current_epoch : trusted_clock_epoch;
    if (requested_epoch == 0 ||
        (rollback_floor > requested_epoch &&
         rollback_floor - requested_epoch > CLOCK_SYNC_SKEW_TOLERANCE_SECONDS)) {
        ESP_LOGW(LOG_TAG, "Rejected UTC clock rollback");
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INVALID_VALUE);
        return ESP_GATT_INVALID_PDU;
    }

    const uint64_t accepted_epoch = std::max(requested_epoch, rollback_floor);
    const esp_err_t error = save_trusted_clock_epoch(accepted_epoch);
    if (error != ESP_OK) {
        ESP_LOGE(LOG_TAG, "UTC clock persistence failed: %s",
                 esp_err_to_name(error));
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::STORAGE_FAILURE);
        return ESP_GATT_ERR_UNLIKELY;
    }
    std::memcpy(utc_time_attribute, value, sizeof(utc_time_attribute));
    if (attribute_handles[UTC_TIME_VALUE] != 0) {
        esp_ble_gatts_set_attr_value(attribute_handles[UTC_TIME_VALUE],
                                    sizeof(utc_time_attribute),
                                    utc_time_attribute);
    }
    trusted_clock_epoch = accepted_epoch;
    trusted_clock_started_microseconds = esp_timer_get_time();
    trusted_clock_is_set = true;

    ESP_LOGI(LOG_TAG, "UTC clock synchronized and persisted");
    return ESP_GATT_OK;
}

void maintenance_window_timeout_callback(void *) {
    if (!maintenance_window_open) return;
    maintenance_window_open = false;
    ESP_LOGI(LOG_TAG, "Maintenance advertising window closed");
    request_advertising_refresh();
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

    log_received_advertisement_key(key, length);

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

    bool complete = false;
    if (restore_finder_configuration(&complete) != ESP_OK) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INTERNAL_ERROR);
        return ESP_GATT_ERR_UNLIKELY;
    }
    if (complete) {
        request_advertising_refresh();
        ESP_LOGI(LOG_TAG,
                 "Both finding identities committed; dual advertising enabled");
    } else {
        ESP_LOGI(LOG_TAG,
                 "Apple advertisement key committed; dual setup is incomplete");
    }
    return ESP_GATT_OK;
}

esp_gatt_status_t persist_google_key(const uint8_t *key, size_t length) {
    if (ble_mode != BLEMode::SETUP) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::ALREADY_PROVISIONED);
        return ESP_GATT_WRITE_NOT_PERMIT;
    }
    if (length != GOOGLE_ADVERTISEMENT_KEY_SIZE) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INVALID_LENGTH);
        return ESP_GATT_INVALID_ATTR_LEN;
    }
    update_status(ProvisioningState::VALIDATING, ProvisioningResult::SUCCESS);
    if (!google_advertisement_key_is_valid(key, length)) {
        update_status(ProvisioningState::ERROR, ProvisioningResult::INVALID_VALUE);
        return ESP_GATT_INVALID_PDU;
    }
    update_status(ProvisioningState::PERSISTING, ProvisioningResult::SUCCESS);
    esp_err_t error = save_google_advertisement_key(key, length);
    if (error == ESP_ERR_INVALID_STATE) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::ALREADY_PROVISIONED);
        return ESP_GATT_WRITE_NOT_PERMIT;
    }
    if (error != ESP_OK) {
        ESP_LOGE(LOG_TAG, "Google identity persistence failed: %s",
                 esp_err_to_name(error));
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::STORAGE_FAILURE);
        return ESP_GATT_ERR_UNLIKELY;
    }
    if (update_google_key_fingerprint(key) != ESP_OK) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INTERNAL_ERROR);
        return ESP_GATT_ERR_UNLIKELY;
    }
    bool complete = false;
    if (restore_finder_configuration(&complete) != ESP_OK) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INTERNAL_ERROR);
        return ESP_GATT_ERR_UNLIKELY;
    }
    if (complete) {
        request_advertising_refresh();
    }
    ESP_LOGI(LOG_TAG,
             "Google advertisement identity committed%s",
             complete ? "; dual advertising enabled" : "");
    return ESP_GATT_OK;
}

esp_gatt_status_t persist_finding_network(const uint8_t *value, size_t length) {
    if (ble_mode != BLEMode::SETUP) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::ALREADY_PROVISIONED);
        return ESP_GATT_WRITE_NOT_PERMIT;
    }
    if (value == nullptr || length != sizeof(finding_network_attribute)) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INVALID_LENGTH);
        return ESP_GATT_INVALID_ATTR_LEN;
    }
    if (value[0] != static_cast<uint8_t>(FindingNetwork::APPLE) &&
        value[0] != static_cast<uint8_t>(FindingNetwork::GOOGLE)) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::NETWORK_REJECTED);
        return ESP_GATT_INVALID_PDU;
    }

    update_status(ProvisioningState::PERSISTING, ProvisioningResult::SUCCESS);
    const FindingNetwork network = static_cast<FindingNetwork>(value[0]);
    const esp_err_t save_result = save_finding_network(network);
    if (save_result == ESP_ERR_INVALID_STATE) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::ALREADY_PROVISIONED);
        return ESP_GATT_WRITE_NOT_PERMIT;
    }
    if (save_result != ESP_OK) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::STORAGE_FAILURE);
        return ESP_GATT_ERR_UNLIKELY;
    }

    bool complete = false;
    if (restore_finder_configuration(&complete) != ESP_OK) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INTERNAL_ERROR);
        return ESP_GATT_ERR_UNLIKELY;
    }
    if (complete) {
        request_advertising_refresh();
    }
    ESP_LOGI(LOG_TAG, "%s setup preference selected%s",
             network == FindingNetwork::APPLE ? "Apple" : "Google",
             complete ? "; both finder frames enabled" : "");
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
    bool complete = false;
    if (restore_finder_configuration(&complete) != ESP_OK) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::INTERNAL_ERROR);
        return ESP_GATT_ERR_UNLIKELY;
    }
    if (complete) {
        request_advertising_refresh();
    }
    return ESP_GATT_OK;
}

esp_gatt_status_t authenticated_reset(const uint8_t *command, size_t length) {
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
    update_google_key_fingerprint(nullptr);
    finding_network_attribute[0] = 0;
    if (attribute_handles[FINDING_NETWORK_VALUE] != 0) {
        esp_ble_gatts_set_attr_value(attribute_handles[FINDING_NETWORK_VALUE],
                                    sizeof(finding_network_attribute),
                                    finding_network_attribute);
    }
    stop_finder_frame_timer();
    std::memset(apple_finder_adv_data, 0, sizeof(apple_finder_adv_data));
    std::memset(google_finder_adv_data, 0, sizeof(google_finder_adv_data));
    finder_frames_ready = false;
    ble_mode = BLEMode::SETUP;
    maintenance_window_open = false;
    bond_cleanup_pending = true;
    update_status(ProvisioningState::UNPROVISIONED,
                  ProvisioningResult::SUCCESS);
    request_advertising_refresh();
    ESP_LOGI(LOG_TAG,
             "Authenticated reset completed; both finding identities erased");
    return ESP_GATT_OK;
}

esp_gatt_status_t authorize_connection(const uint8_t *proof, size_t length) {
    if (proof == nullptr || length != TAG_AUTHORIZATION_PROOF_SIZE) {
        return ESP_GATT_INVALID_ATTR_LEN;
    }

#if CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
    connection_authorized = true;
    stop_authorization_timeout();
    ESP_LOGW(LOG_TAG,
             "DEVELOPMENT MODE: authorization proof accepted without bootstrap key");
    return ESP_GATT_OK;
#else
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
#endif
}

esp_gatt_status_t authorize_ring_connection(const uint8_t *proof, size_t length) {
    if (proof == nullptr || length != TAG_AUTHORIZATION_PROOF_SIZE) {
        return ESP_GATT_INVALID_ATTR_LEN;
    }
    if (!connected || ble_mode != BLEMode::TRACKER ||
        esp_timer_get_time() >= ring_authorization_deadline) {
        return ESP_GATT_INSUF_AUTHORIZATION;
    }

    // Unlike bootstrap setup, owner sound authorization has NO development
    // bypass. The backend reconstructs this already-provisioned control key
    // only after checking the current owner and allocation, and never returns
    // the reusable key to the phone. A proof cannot authorize reset or OTA.
    uint8_t control_key[TAG_CONTROL_KEY_SIZE] = {};
    if (load_tag_control_key(control_key, sizeof(control_key)) != ESP_OK) {
        mbedtls_platform_zeroize(control_key, sizeof(control_key));
        return ESP_GATT_INSUF_AUTHORIZATION;
    }
    constexpr char DOMAIN[] = "pinqeva:ring-auth:v1";
    uint8_t message[sizeof(DOMAIN) + DEVICE_ID_LEN - 1 + TAG_CHALLENGE_SIZE] = {};
    std::memcpy(message, DOMAIN, sizeof(DOMAIN));  // includes the NUL separator
    std::memcpy(message + sizeof(DOMAIN), device_id, DEVICE_ID_LEN - 1);
    std::memcpy(message + sizeof(DOMAIN) + DEVICE_ID_LEN - 1,
                tag_challenge_attribute, TAG_CHALLENGE_SIZE);
    uint8_t expected[TAG_AUTHORIZATION_PROOF_SIZE] = {};
    const mbedtls_md_info_t *sha256 = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    const int result = sha256 == nullptr ? -1 : mbedtls_md_hmac(
        sha256, control_key, sizeof(control_key), message, sizeof(message), expected);
    uint8_t difference = static_cast<uint8_t>(result != 0);
    for (size_t index = 0; index < sizeof(expected); ++index) {
        difference |= expected[index] ^ proof[index];
    }
    mbedtls_platform_zeroize(control_key, sizeof(control_key));
    mbedtls_platform_zeroize(message, sizeof(message));
    mbedtls_platform_zeroize(expected, sizeof(expected));
    if (difference != 0) return ESP_GATT_INSUF_AUTHORIZATION;
    ring_authorized = true;
    stop_authorization_timeout();
    return ESP_GATT_OK;
}

void read_ring_status(uint8_t value[2]) {
    const bool active = buzzer_is_active();
    value[0] = active ? 1 : 0;
    value[1] = active ? static_cast<uint8_t>(sound_source.load()) : 0;
}

void notify_ring_status() {
    if (!connected || !ring_notifications_enabled ||
        active_gatts_if == ESP_GATT_IF_NONE) return;
    uint8_t value[2] = {};
    read_ring_status(value);
    esp_ble_gatts_send_indicate(active_gatts_if, active_connection_id,
        attribute_handles[RING_STATUS_VALUE], sizeof(value), value, false);
}

void owner_ring_completed_callback() {
    // A queued completion must never report an old tone as the new tone's end.
    if (!buzzer_is_active()) notify_ring_status();
}

esp_err_t send_dult_sound_completed();

esp_gatt_status_t process_ring_control(const uint8_t *value, size_t length) {
    if (value == nullptr || length != 1) return ESP_GATT_INVALID_ATTR_LEN;
    if (!ring_authorized || ble_mode != BLEMode::TRACKER) {
        return ESP_GATT_INSUF_AUTHORIZATION;
    }
    if (value[0] == RING_PLAY) {
        // Success acknowledges an intentionally ignored duplicate. It never
        // queues a second sound, resets the timer, or changes the sound source.
        if (buzzer_is_active()) return ESP_GATT_OK;
        if (ota_update_active()) return ESP_GATT_WRITE_NOT_PERMIT;
        const esp_err_t error = buzzer_start(
            OWNER_RING_DURATION_MILLISECONDS, &owner_ring_completed_callback);
        if (error != ESP_OK) return ESP_GATT_ERROR;
        sound_source = SoundSource::OWNER;
    } else if (value[0] == RING_PAUSE) {
        const bool was_dult = sound_source == SoundSource::DULT &&
            dult_sound_generation == connection_generation &&
            dult_sound_connection_id == active_connection_id;
        const esp_err_t error = buzzer_stop();
        if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) return ESP_GATT_ERROR;
        if (was_dult && error == ESP_OK) send_dult_sound_completed();
    } else {
        return ESP_GATT_ILLEGAL_PARAMETER;
    }
    notify_ring_status();
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

void encode_u16_little_endian(uint8_t *destination, uint16_t value) {
    destination[0] = static_cast<uint8_t>(value & 0xFFU);
    destination[1] = static_cast<uint8_t>((value >> 8U) & 0xFFU);
}

esp_err_t send_dult_indication(const uint8_t *value, size_t length) {
    if (!connected || !dult_indications_enabled ||
        active_gatts_if == ESP_GATT_IF_NONE ||
        dult_attribute_handles[DULT_CONTROL_VALUE] == 0 || value == nullptr ||
        length > sizeof(dult_control_value)) {
        return ESP_ERR_INVALID_STATE;
    }
    return esp_ble_gatts_send_indicate(
        active_gatts_if, active_connection_id,
        dult_attribute_handles[DULT_CONTROL_VALUE],
        static_cast<uint16_t>(length), const_cast<uint8_t *>(value), true);
}

esp_err_t send_dult_command_response(uint16_t command, uint16_t status) {
    uint8_t response[6] = {};
    encode_u16_little_endian(response, DULT_COMMAND_RESPONSE_OPCODE);
    encode_u16_little_endian(response + 2, command);
    encode_u16_little_endian(response + 4, status);
    return send_dult_indication(response, sizeof(response));
}

esp_err_t send_dult_sound_completed() {
    uint8_t response[2] = {};
    encode_u16_little_endian(response, DULT_SOUND_COMPLETED_OPCODE);
    return send_dult_indication(response, sizeof(response));
}

void dult_sound_completed_callback() {
    if (buzzer_is_active()) return;
    notify_ring_status();
    if (!connected || sound_source != SoundSource::DULT ||
        active_connection_id != dult_sound_connection_id ||
        connection_generation != dult_sound_generation) return;
    const esp_err_t error = send_dult_sound_completed();
    if (error != ESP_OK) {
        ESP_LOGW(LOG_TAG, "Could not indicate DULT sound completion: %s",
                 esp_err_to_name(error));
    }
}

void handle_dult_control_write(esp_gatt_if_t gatts_if,
                               esp_ble_gatts_cb_param_t *param) {
    if (!dult_indications_enabled) {
        send_write_response(gatts_if, param, ESP_GATT_CCC_CFG_ERR);
        return;
    }

    uint16_t command = 0;
    uint16_t response_status = DULT_RESPONSE_SUCCESS;
    if (param->write.len != 2) {
        response_status = DULT_RESPONSE_INVALID_LENGTH;
    } else {
        command = static_cast<uint16_t>(param->write.value[0]) |
                  static_cast<uint16_t>(param->write.value[1] << 8U);
        if (ble_mode != BLEMode::TRACKER) {
            response_status = DULT_RESPONSE_INVALID_COMMAND;
        } else if (command == DULT_SOUND_START_OPCODE) {
            if (buzzer_is_active()) {
                response_status = DULT_RESPONSE_INVALID_STATE;
            } else {
                const esp_err_t error = buzzer_start(
                    DULT_SOUND_DURATION_MILLISECONDS,
                    &dult_sound_completed_callback);
                if (error == ESP_OK) {
                    sound_source = SoundSource::DULT;
                    dult_sound_connection_id = param->write.conn_id;
                    dult_sound_generation = connection_generation.load();
                    notify_ring_status();
                } else {
                    ESP_LOGE(LOG_TAG, "Could not start DULT sound: %s",
                             esp_err_to_name(error));
                    response_status = DULT_RESPONSE_INVALID_CONFIGURATION;
                }
            }
        } else if (command == DULT_SOUND_STOP_OPCODE) {
            if (!buzzer_is_active() ||
                sound_source != SoundSource::DULT ||
                dult_sound_connection_id != param->write.conn_id) {
                response_status = DULT_RESPONSE_INVALID_STATE;
            } else {
                const esp_err_t error = buzzer_stop();
                if (error != ESP_OK) {
                    ESP_LOGE(LOG_TAG, "Could not stop DULT sound: %s",
                             esp_err_to_name(error));
                    response_status = DULT_RESPONSE_INVALID_CONFIGURATION;
                } else {
                    notify_ring_status();
                }
            }
        } else {
            response_status = DULT_RESPONSE_INVALID_COMMAND;
        }
    }

    send_write_response(gatts_if, param, ESP_GATT_OK);
    esp_err_t indication_error = ESP_OK;
    if (command == DULT_SOUND_STOP_OPCODE &&
        response_status == DULT_RESPONSE_SUCCESS) {
        indication_error = send_dult_sound_completed();
    } else {
        indication_error = send_dult_command_response(command, response_status);
    }
    if (indication_error != ESP_OK) {
        ESP_LOGW(LOG_TAG, "Could not indicate DULT sound response: %s",
                 esp_err_to_name(indication_error));
    }
}

void handle_dult_ccc_write(esp_gatt_if_t gatts_if,
                           esp_ble_gatts_cb_param_t *param) {
    esp_gatt_status_t status = ESP_GATT_OK;
    if (param->write.len != sizeof(dult_ccc_value)) {
        status = ESP_GATT_INVALID_ATTR_LEN;
    } else {
        const uint16_t value =
            static_cast<uint16_t>(param->write.value[0]) |
            static_cast<uint16_t>(param->write.value[1] << 8U);
        if (value != 0x0000 && value != 0x0002) {
            status = ESP_GATT_CCC_CFG_ERR;
        } else {
            dult_indications_enabled = value == 0x0002;
            dult_ccc_value[0] = param->write.value[0];
            dult_ccc_value[1] = param->write.value[1];
            esp_ble_gatts_set_attr_value(
                dult_attribute_handles[DULT_CONTROL_CCC],
                sizeof(dult_ccc_value), dult_ccc_value);
        }
    }
    send_write_response(gatts_if, param, status);
}

size_t secure_value_length(uint16_t handle) {
    if (handle == attribute_handles[RING_AUTHORIZATION_VALUE]) {
        return TAG_AUTHORIZATION_PROOF_SIZE;
    }
    if (handle == attribute_handles[RING_CONTROL_VALUE]) return 1;
    if (handle == attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE]) {
        return TAG_AUTHORIZATION_PROOF_SIZE;
    }
    if (handle == attribute_handles[ADVERTISEMENT_KEY_VALUE]) {
        return PUBLIC_KEY_SIZE;
    }
    if (handle == attribute_handles[GOOGLE_ADVERTISEMENT_KEY_VALUE]) {
        return GOOGLE_ADVERTISEMENT_KEY_SIZE;
    }
    if (handle == attribute_handles[FINDING_NETWORK_VALUE]) {
        return sizeof(finding_network_attribute);
    }
    if (handle == attribute_handles[CONTROL_KEY_VALUE]) {
        return TAG_CONTROL_KEY_SIZE;
    }
    if (handle == attribute_handles[AUTHENTICATED_RESET_VALUE]) {
        return RESET_COMMAND_SIZE;
    }
    if (handle == attribute_handles[UTC_TIME_VALUE]) {
        return UTC_TIME_SIZE;
    }
    if (handle == attribute_handles[FIRMWARE_MANIFEST_VALUE]) {
        return FIRMWARE_MANIFEST_SIZE;
    }
    if (handle == attribute_handles[FIRMWARE_CONTROL_VALUE]) {
        return 1;
    }
    return 0;
}

bool secure_write_allowed_in_mode(uint16_t handle) {
    if (handle == attribute_handles[RING_AUTHORIZATION_VALUE]) {
        return ble_mode == BLEMode::TRACKER;
    }
    if (handle == attribute_handles[RING_CONTROL_VALUE]) {
        return ring_authorized && ble_mode == BLEMode::TRACKER;
    }
    if (handle == attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE]) {
        return true;
    }
    if (!connection_authorized) {
        return false;
    }
    if (handle == attribute_handles[UTC_TIME_VALUE]) {
        return true;
    }
    if (handle == attribute_handles[AUTHENTICATED_RESET_VALUE]) {
        return true;
    }
    if (handle == attribute_handles[FIRMWARE_MANIFEST_VALUE]) {
        return maintenance_window_open && ble_mode == BLEMode::TRACKER;
    }
    if (handle == attribute_handles[FIRMWARE_CONTROL_VALUE]) {
        return ota_update_active() ||
               (maintenance_window_open && ble_mode == BLEMode::TRACKER);
    }
    return (handle == attribute_handles[ADVERTISEMENT_KEY_VALUE] ||
            handle == attribute_handles[GOOGLE_ADVERTISEMENT_KEY_VALUE] ||
            handle == attribute_handles[FINDING_NETWORK_VALUE] ||
            handle == attribute_handles[CONTROL_KEY_VALUE]) &&
           ble_mode == BLEMode::SETUP;
}

esp_gatt_status_t process_secure_write(uint16_t handle,
                                        const uint8_t *value,
                                        size_t length) {
    if (handle == attribute_handles[RING_AUTHORIZATION_VALUE]) {
        return authorize_ring_connection(value, length);
    }
    if (handle == attribute_handles[RING_CONTROL_VALUE]) {
        return process_ring_control(value, length);
    }
    if (handle == attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE]) {
        return authorize_connection(value, length);
    }
    if (!connection_authorized) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::UNAUTHORIZED);
        return ESP_GATT_INSUF_AUTHORIZATION;
    }
    if ((handle == attribute_handles[FIRMWARE_MANIFEST_VALUE] ||
         handle == attribute_handles[FIRMWARE_CONTROL_VALUE]) &&
        !secure_write_allowed_in_mode(handle)) return ESP_GATT_WRITE_NOT_PERMIT;
    if (handle == attribute_handles[ADVERTISEMENT_KEY_VALUE]) {
        return persist_key(value, length);
    }
    if (handle == attribute_handles[GOOGLE_ADVERTISEMENT_KEY_VALUE]) {
        return persist_google_key(value, length);
    }
    if (handle == attribute_handles[FINDING_NETWORK_VALUE]) {
        return persist_finding_network(value, length);
    }
    if (handle == attribute_handles[CONTROL_KEY_VALUE]) {
        return persist_control_key(value, length);
    }
    if (handle == attribute_handles[AUTHENTICATED_RESET_VALUE]) {
        return authenticated_reset(value, length);
    }
    if (handle == attribute_handles[UTC_TIME_VALUE]) {
        return persist_trusted_utc(value, length);
    }
    if (handle == attribute_handles[FIRMWARE_MANIFEST_VALUE]) {
        return ota_update_begin(value, length);
    }
    if (handle == attribute_handles[FIRMWARE_CONTROL_VALUE]) {
        return ota_update_control(value, length);
    }
    return ESP_GATT_WRITE_NOT_PERMIT;
}

esp_gatt_status_t process_firmware_data_write(const uint8_t *value,
                                               size_t length) {
    if (!connection_authorized) {
        update_status(ProvisioningState::ERROR,
                      ProvisioningResult::UNAUTHORIZED);
        return ESP_GATT_INSUF_AUTHORIZATION;
    }
    if (!ota_update_active()) return ESP_GATT_WRITE_NOT_PERMIT;
    return ota_update_write(value, length);
}

void handle_prepared_secure_write(esp_gatt_if_t gatts_if,
                                   esp_ble_gatts_cb_param_t *param) {
    const auto &write = param->write;
    const bool ring_write = write.handle == attribute_handles[RING_AUTHORIZATION_VALUE] ||
                            write.handle == attribute_handles[RING_CONTROL_VALUE];
    size_t expected_length = secure_value_length(write.handle);
    esp_gatt_status_t status = ESP_GATT_OK;
    if (expected_length == 0) {
        status = ESP_GATT_WRITE_NOT_PERMIT;
    } else if (!secure_write_allowed_in_mode(write.handle)) {
        if (!connection_authorized &&
            write.handle != attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE]) {
            status = ESP_GATT_INSUF_AUTHORIZATION;
            if (!ring_write) update_status(ProvisioningState::ERROR,
                                          ProvisioningResult::UNAUTHORIZED);
        } else {
            status = ESP_GATT_WRITE_NOT_PERMIT;
            if (!ring_write) update_status(ProvisioningState::ERROR,
                                          ProvisioningResult::ALREADY_PROVISIONED);
        }
    } else if (write.offset > expected_length ||
               write.len > expected_length - write.offset) {
        status = ESP_GATT_INVALID_ATTR_LEN;
        if (!ring_write) update_status(ProvisioningState::ERROR,
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
            if (!ring_write) update_status(ProvisioningState::RECEIVING,
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

void handle_ring_ccc_write(esp_gatt_if_t gatts_if, esp_ble_gatts_cb_param_t *param) {
    esp_gatt_status_t status = ESP_GATT_OK;
    if (param->write.offset != 0) {
        status = ESP_GATT_INVALID_OFFSET;
    } else if (param->write.len != sizeof(ring_ccc_value)) {
        status = ESP_GATT_INVALID_ATTR_LEN;
    } else if (param->write.value[1] != 0 || param->write.value[0] > 1) {
        status = ESP_GATT_CCC_CFG_ERR;
    } else {
        ring_notifications_enabled = param->write.value[0] == 1;
        std::memcpy(ring_ccc_value, param->write.value, sizeof(ring_ccc_value));
    }
    send_write_response(gatts_if, param, status);
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

            configure_advertising_for_mode();

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
            if (param->add_attr_tab.svc_inst_id == SERVICE_INSTANCE_ID) {
                if (param->add_attr_tab.status != ESP_GATT_OK ||
                    param->add_attr_tab.num_handle != ATTRIBUTE_COUNT) {
                    ESP_LOGE(LOG_TAG, "Provisioning GATT table creation failed");
                    break;
                }
                std::memcpy(attribute_handles, param->add_attr_tab.handles,
                            sizeof(attribute_handles));
                esp_err_t error =
                    esp_ble_gatts_start_service(attribute_handles[SERVICE]);
                if (error != ESP_OK) {
                    ESP_LOGE(LOG_TAG,
                             "Could not start Pinkeva GATT service %s: %s",
                             PINKEVA_SERVICE_UUID_STRING, esp_err_to_name(error));
                    break;
                }
                error = esp_ble_gatts_create_attr_tab(
                    dult_gatt_db, gatts_if, DULT_ATTRIBUTE_COUNT,
                    DULT_SERVICE_INSTANCE_ID);
                if (error != ESP_OK) {
                    ESP_LOGE(LOG_TAG, "Could not create DULT GATT table: %s",
                             esp_err_to_name(error));
                }
            } else if (param->add_attr_tab.svc_inst_id ==
                       DULT_SERVICE_INSTANCE_ID) {
                if (param->add_attr_tab.status != ESP_GATT_OK ||
                    param->add_attr_tab.num_handle != DULT_ATTRIBUTE_COUNT) {
                    ESP_LOGE(LOG_TAG, "DULT GATT table creation failed");
                    break;
                }
                std::memcpy(dult_attribute_handles,
                            param->add_attr_tab.handles,
                            sizeof(dult_attribute_handles));
                const esp_err_t error = esp_ble_gatts_start_service(
                    dult_attribute_handles[DULT_SERVICE]);
                if (error != ESP_OK) {
                    ESP_LOGE(LOG_TAG, "Could not start DULT GATT service %s: %s",
                             DULT_SERVICE_UUID_STRING, esp_err_to_name(error));
                }
            } else {
                ESP_LOGE(LOG_TAG, "Unexpected GATT service instance: %u",
                         param->add_attr_tab.svc_inst_id);
            }
            break;
        }
        case ESP_GATTS_START_EVT: {
            if (param->start.status == ESP_GATT_OK) {
                if (param->start.service_handle == attribute_handles[SERVICE]) {
                    pinkeva_service_started = true;
                    ESP_LOGI(LOG_TAG, "Pinkeva GATT service ready: %s",
                             PINKEVA_SERVICE_UUID_STRING);
                } else if (param->start.service_handle ==
                           dult_attribute_handles[DULT_SERVICE]) {
                    dult_service_started = true;
                    ESP_LOGI(LOG_TAG, "DULT sound service ready: %s",
                             DULT_SERVICE_UUID_STRING);
                }
                if (pinkeva_service_started && dult_service_started) {
                    service_started.store(true, std::memory_order_release);
                    try_start_advertising();
                }
            }
            break;
        }
        case ESP_GATTS_CONNECT_EVT: {
            // A stopped esp_timer may already have dispatched its callback.
            // Keep the new link unpublished until its identity and deadlines
            // replace every value belonging to the previous connection.
            connected = false;
            ++connection_generation;
            advertising_active = false;
            stop_finder_frame_timer();
            active_connection_id = param->connect.conn_id;
            notifications_enabled = false;
            dult_indications_enabled = false;
            ring_notifications_enabled = false;
            ccc_value[0] = ccc_value[1] = 0;
            dult_ccc_value[0] = dult_ccc_value[1] = 0;
            ring_ccc_value[0] = ring_ccc_value[1] = 0;
            clear_staged_value();
            if (begin_connection_authorization() != ESP_OK) {
                ESP_LOGE(LOG_TAG, "Could not create connection challenge");
                esp_ble_gatts_close(gatts_if, param->connect.conn_id);
                break;
            }
            connection_idle_deadline =
                esp_timer_get_time() + CONNECTION_IDLE_TIMEOUT_MICROSECONDS;
            connected = true;
            refresh_connection_idle_timeout();
            // The central may decline these preferences. Slave latency skips
            // empty connection events while queued Play/Pause still responds
            // at a short connection interval; it does not delay OTA payloads.
            esp_ble_conn_update_params_t connection_parameters = {};
            std::memcpy(connection_parameters.bda, param->connect.remote_bda,
                        sizeof(esp_bd_addr_t));
            connection_parameters.min_int = 24;  // 30 ms (1.25 ms units)
            connection_parameters.max_int = 40;  // 50 ms
            connection_parameters.latency = 4;
            connection_parameters.timeout = 400; // 4 s (10 ms units)
            esp_ble_gap_update_conn_params(&connection_parameters);
#if !CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
            // Production keeps link encryption while intentionally omitting
            // the bond bit. The explicitly insecure development bypass must
            // not start OS pairing here.
            // Finder connections can be owner-ring or public DULT clients.
            // Neither should be forced to pair simply for connecting.
            if (ble_mode == BLEMode::SETUP || maintenance_window_open) {
                esp_ble_set_encryption(param->connect.remote_bda,
                                       ESP_BLE_SEC_ENCRYPT_NO_MITM);
            }
#endif
            break;
        }
        case ESP_GATTS_DISCONNECT_EVT:
            connected = false;
            notifications_enabled = false;
            dult_indications_enabled = false;
            ring_notifications_enabled = false;
            if (connection_idle_timer != nullptr) esp_timer_stop(connection_idle_timer);
            if (buzzer_is_active() &&
                sound_source == SoundSource::DULT &&
                dult_sound_connection_id == param->disconnect.conn_id) {
                buzzer_stop();
            }
            dult_sound_connection_id = 0;
            dult_sound_generation = 0;
            clear_staged_value();
            if (ota_update_active()) ota_update_abort();
            clear_connection_authorization();
            if (bond_cleanup_pending) {
                erase_all_bonds();
                bond_cleanup_pending = false;
            } else if (ble_mode == BLEMode::SETUP) {
                update_status(ProvisioningState::UNPROVISIONED,
                              ProvisioningResult::SUCCESS);
            }
            if (advertising_refresh_pending) {
                advertising_refresh_pending = false;
                configure_advertising_for_mode();
            } else {
                try_start_advertising();
            }
            break;
        case ESP_GATTS_READ_EVT: {
            refresh_connection_idle_timeout();
            esp_gatt_status_t read_status = ESP_GATT_READ_NOT_PERMIT;
            esp_gatt_rsp_t response = {};
            if (param->read.handle == attribute_handles[RING_STATUS_VALUE] ||
                param->read.handle == attribute_handles[RING_STATUS_CCC]) {
                uint8_t value[2] = {};
                if (param->read.handle == attribute_handles[RING_STATUS_VALUE]) {
                    read_ring_status(value);
                } else {
                    std::memcpy(value, ring_ccc_value, sizeof(value));
                }
                if (param->read.offset > sizeof(value)) {
                    read_status = ESP_GATT_INVALID_OFFSET;
                } else {
                    response.attr_value.handle = param->read.handle;
                    response.attr_value.offset = param->read.offset;
                    response.attr_value.len = sizeof(value) - param->read.offset;
                    std::memcpy(response.attr_value.value, value + param->read.offset,
                                response.attr_value.len);
                    read_status = ESP_GATT_OK;
                }
            } else if (param->read.handle == attribute_handles[FIRMWARE_STATUS_VALUE] &&
                connection_authorized) {
                uint8_t firmware_status[FIRMWARE_STATUS_SIZE] = {};
                ota_update_status(firmware_status);
                if (param->read.offset > FIRMWARE_STATUS_SIZE) {
                    read_status = ESP_GATT_INVALID_OFFSET;
                } else {
                    const size_t remaining = FIRMWARE_STATUS_SIZE - param->read.offset;
                    response.attr_value.handle = param->read.handle;
                    response.attr_value.offset = param->read.offset;
                    response.attr_value.len = static_cast<uint16_t>(remaining);
                    std::memcpy(response.attr_value.value,
                                firmware_status + param->read.offset, remaining);
                    read_status = ESP_GATT_OK;
                }
            } else if (param->read.handle ==
                       attribute_handles[FINDING_NETWORK_VALUE]) {
                if (param->read.offset > sizeof(finding_network_attribute)) {
                    read_status = ESP_GATT_INVALID_OFFSET;
                } else {
                    const size_t remaining =
                        sizeof(finding_network_attribute) - param->read.offset;
                    response.attr_value.handle = param->read.handle;
                    response.attr_value.offset = param->read.offset;
                    response.attr_value.len = static_cast<uint16_t>(remaining);
                    std::memcpy(response.attr_value.value,
                                finding_network_attribute + param->read.offset,
                                remaining);
                    read_status = ESP_GATT_OK;
                }
            }
            esp_ble_gatts_send_response(
                gatts_if, param->read.conn_id, param->read.trans_id,
                read_status, read_status == ESP_GATT_OK ? &response : nullptr);
            break;
        }
        case ESP_GATTS_WRITE_EVT:
            refresh_connection_idle_timeout();
            if (param->write.is_prep) {
                handle_prepared_secure_write(gatts_if, param);
            } else if (secure_value_length(param->write.handle) != 0) {
                esp_gatt_status_t result = param->write.offset == 0
                    ? process_secure_write(param->write.handle, param->write.value, param->write.len)
                    : ESP_GATT_INVALID_OFFSET;
                send_write_response(gatts_if, param, result);
                if (result == ESP_GATT_INSUF_AUTHORIZATION) {
                    esp_ble_gatts_close(gatts_if, param->write.conn_id);
                }
            } else if (param->write.handle ==
                       attribute_handles[FIRMWARE_DATA_VALUE]) {
                const esp_gatt_status_t result = process_firmware_data_write(
                    param->write.value, param->write.len);
                send_write_response(gatts_if, param, result);
                if (result == ESP_GATT_INSUF_AUTHORIZATION) {
                    esp_ble_gatts_close(gatts_if, param->write.conn_id);
                }
            } else if (param->write.handle == attribute_handles[STATUS_CCC]) {
                handle_ccc_write(gatts_if, param);
            } else if (param->write.handle == attribute_handles[RING_STATUS_CCC]) {
                handle_ring_ccc_write(gatts_if, param);
            } else if (param->write.handle ==
                       dult_attribute_handles[DULT_CONTROL_VALUE]) {
                handle_dult_control_write(gatts_if, param);
            } else if (param->write.handle ==
                       dult_attribute_handles[DULT_CONTROL_CCC]) {
                handle_dult_ccc_write(gatts_if, param);
            } else {
                send_write_response(gatts_if, param,
                                    ESP_GATT_WRITE_NOT_PERMIT);
            }
            break;
        case ESP_GATTS_EXEC_WRITE_EVT: {
            refresh_connection_idle_timeout();
            esp_gatt_status_t result = ESP_GATT_OK;
            bool was_authorization_write =
                staged_attribute_handle ==
                attribute_handles[TAG_AUTHORIZATION_PROOF_VALUE] ||
                staged_attribute_handle == attribute_handles[RING_AUTHORIZATION_VALUE];
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

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wswitch"
#pragma GCC diagnostic ignored "-Wswitch-enum"
void gap_callback(esp_gap_ble_cb_event_t event,
                  esp_ble_gap_cb_param_t *param) {
    switch (static_cast<int>(event)) {
        case ESP_GAP_BLE_SET_STATIC_RAND_ADDR_EVT: {
            if (param->set_rand_addr_cmpl.status != ESP_BT_STATUS_SUCCESS) {
                random_address_change_pending = false;
                ESP_LOGE(LOG_TAG, "Could not activate setup BLE identity: %d",
                         param->set_rand_addr_cmpl.status);
                break;
            }
            random_address_change_pending = false;
            const bool finder_identity =
                ble_mode == BLEMode::TRACKER && !maintenance_window_open;
            const uint8_t *active_address =
                finder_identity ? active_finder_address() : setup_ble_address;
            ESP_LOGD(LOG_TAG,
                     "%s BLE identity v%u ready: %02X:%02X:%02X:%02X:%02X:%02X",
                     finder_identity ? active_finder_network_name() : "Setup",
                     SETUP_BLE_IDENTITY_VERSION,
                     active_address[0], active_address[1], active_address[2],
                     active_address[3], active_address[4], active_address[5]);
            if (active_gatts_if == ESP_GATT_IF_NONE) {
                if (esp_ble_gatts_app_register(APP_ID) != ESP_OK) {
                    ESP_LOGE(LOG_TAG, "Could not register GATT application");
                }
            } else {
                try_start_advertising();
            }
            break;
        }
        case ESP_GAP_BLE_ADV_DATA_RAW_SET_COMPLETE_EVT:
            if (param->adv_data_raw_cmpl.status != ESP_BT_STATUS_SUCCESS) {
                advertising_configuration_failed = true;
                ESP_LOGE(LOG_TAG, "Pinkeva service advertisement rejected: %d",
                         param->adv_data_raw_cmpl.status);
            }
            pending_adv_configuration &= ~ADV_CONFIG_FLAG;
            try_start_advertising();
            break;
        case ESP_GAP_BLE_SCAN_RSP_DATA_RAW_SET_COMPLETE_EVT:
            if (param->scan_rsp_data_raw_cmpl.status != ESP_BT_STATUS_SUCCESS) {
                scan_response_configured = false;
                advertising_configuration_failed = true;
                ESP_LOGE(LOG_TAG, "Pinkeva scan response rejected: %d",
                         param->scan_rsp_data_raw_cmpl.status);
            } else {
                scan_response_configured = true;
                scan_response_uses_setup = pending_scan_response_uses_setup;
            }
            pending_adv_configuration &= ~SCAN_RSP_CONFIG_FLAG;
            try_start_advertising();
            break;
        case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
            if (param->adv_start_cmpl.status != ESP_BT_STATUS_SUCCESS) {
                advertising_active = false;
                ESP_LOGE(LOG_TAG, "Advertising failed to start: %d",
                         param->adv_start_cmpl.status);
            } else {
                advertising_active = true;
                const bool finder_frame =
                    ble_mode == BLEMode::TRACKER && !maintenance_window_open;
                ESP_LOGD(LOG_TAG, "%s advertising active",
                         finder_frame ? active_finder_network_name()
                                      : "Maintenance");
                if (finder_frame && finder_frame_timer != nullptr) {
                    stop_finder_frame_timer();
                    const esp_err_t timer_error = esp_timer_start_once(
                        finder_frame_timer, FINDER_FRAME_SLOT_MICROSECONDS);
                    if (timer_error != ESP_OK) {
                        ESP_LOGE(LOG_TAG,
                                 "Could not schedule finder frame switch: %s",
                                 esp_err_to_name(timer_error));
                    }
                }
            }
            break;
        case ESP_GAP_BLE_ADV_STOP_COMPLETE_EVT:
            advertising_active = false;
            if (advertising_refresh_pending) {
                advertising_refresh_pending = false;
                configure_advertising_for_mode();
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
#pragma GCC diagnostic pop

esp_err_t initialize_firmware_version() {
    const esp_app_desc_t *description = esp_app_get_description();
    unsigned int major = 0;
    unsigned int minor = 0;
    unsigned int patch = 0;
    char trailing = '\0';
    if (description == nullptr ||
        std::sscanf(description->version, "%u.%u.%u%c", &major, &minor,
                    &patch, &trailing) != 3 ||
        major > 255 || minor > 255 || patch > 255) {
        return ESP_ERR_INVALID_ARG;
    }
    firmware_version_attribute[0] = static_cast<uint8_t>(major);
    firmware_version_attribute[1] = static_cast<uint8_t>(minor);
    firmware_version_attribute[2] = static_cast<uint8_t>(patch);
    protocol_value[2] = firmware_version_attribute[0];
    protocol_value[3] = firmware_version_attribute[1];
    return ESP_OK;
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

    // XOR keeps the address unique per board. The two most-significant bits
    // must be 1 for a Bluetooth static-random address.
    constexpr uint8_t SETUP_ADDRESS_MASK[6] = {
        0x15, 0x50, 0x4B, 0x56, 0xA5, SETUP_BLE_IDENTITY_VERSION,
    };
    for (size_t index = 0; index < sizeof(setup_ble_address); ++index) {
        setup_ble_address[index] = mac[index] ^ SETUP_ADDRESS_MASK[index];
    }
    setup_ble_address[0] =
        static_cast<uint8_t>((setup_ble_address[0] & 0x3FU) | 0xC0U);

    setup_scan_response[0] = DEVICE_ID_LEN;
    setup_scan_response[1] = ESP_BLE_AD_TYPE_NAME_CMPL;
    std::memcpy(setup_scan_response + 2, device_id, DEVICE_ID_LEN - 1);
    return ESP_OK;
}

esp_err_t configure_ble_security() {
    // Keep link encryption, but do not persist a phone-specific BLE bond.
    // This lets a freshly reset/setup tag establish a new Secure Connections
    // session without depending on an LTK left over on the phone.
    esp_ble_auth_req_t auth_request = ESP_LE_AUTH_REQ_SC_ONLY;
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

#if CONFIG_PINQEVA_DEV_BYPASS_BOOTSTRAP
    ESP_LOGW(LOG_TAG,
             "DEVELOPMENT MODE: factory bootstrap key is not required");
#else
    uint8_t bootstrap_key[DEVICE_BOOTSTRAP_KEY_SIZE] = {};
    error = load_device_bootstrap_key(bootstrap_key, sizeof(bootstrap_key));
    std::memset(bootstrap_key, 0, sizeof(bootstrap_key));
    if (error != ESP_OK) {
        return ERROR_TAG("Factory bootstrap key is missing or invalid", "NVS");
    }
#endif

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
    const esp_timer_create_args_t idle_timer_arguments = {
        .callback = &connection_idle_timeout_callback,
        .arg = nullptr,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "ble_idle",
        .skip_unhandled_events = false,
    };
    error = esp_timer_create(&idle_timer_arguments, &connection_idle_timer);
    if (error != ESP_OK) {
        return ERROR_TAG("Connection idle timer initialization failed", LOG_TAG);
    }
    const esp_timer_create_args_t maintenance_timer_arguments = {
        .callback = &maintenance_window_timeout_callback,
        .arg = nullptr,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "ble_maintenance",
        .skip_unhandled_events = true,
    };
    error = esp_timer_create(&maintenance_timer_arguments,
                             &maintenance_window_timer);
    if (error != ESP_OK) {
        return ERROR_TAG("Maintenance timer initialization failed", LOG_TAG);
    }
    const esp_timer_create_args_t finder_frame_timer_arguments = {
        .callback = &finder_frame_timer_callback,
        .arg = nullptr,
        .dispatch_method = ESP_TIMER_TASK,
        .name = "finder_frame",
        .skip_unhandled_events = true,
    };
    error = esp_timer_create(&finder_frame_timer_arguments,
                             &finder_frame_timer);
    if (error != ESP_OK) {
        return ERROR_TAG("Finder frame timer initialization failed", LOG_TAG);
    }
    uint64_t stored_clock_epoch = 0;
    error = load_trusted_clock_epoch(&stored_clock_epoch);
    if (error != ESP_OK) {
        stored_clock_epoch = 0;
        ESP_LOGI(LOG_TAG, "No UTC rollback floor found");
    } else {
        ESP_LOGI(LOG_TAG, "Restored UTC rollback floor from NVS");
    }
    trusted_clock_epoch = stored_clock_epoch;
    trusted_clock_started_microseconds = esp_timer_get_time();
    // The ESP32 has no battery-backed wall clock. Never infer elapsed wall
    // time across a reset. The stored value is only a rollback floor until a
    // freshly authorized phone synchronizes UTC during this boot.
    trusted_clock_is_set = false;

    error = initialize_firmware_version();
    if (error != ESP_OK) {
        return ERROR_TAG("Firmware version initialization failed", "APP_VERSION");
    }
    error = initialize_device_id();
    if (error != ESP_OK) {
        return ERROR_TAG("Device ID initialization failed", "DEVICE_ID");
    }

    bool finder_configuration_complete = false;
    error = restore_finder_configuration(&finder_configuration_complete);
    if (error != ESP_OK) {
        return ERROR_TAG("Finding-network configuration restore failed", LOG_TAG);
    }
    if (finder_configuration_complete) {
        ESP_LOGI(LOG_TAG,
                 "Apple and Google finder advertising restored from NVS");
    } else {
        ESP_LOGI(LOG_TAG,
                 "Dual finding-network setup incomplete; setup advertising enabled");
    }

    error = esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
    if (error != ESP_OK) {
        return ERROR_TAG("Classic Bluetooth memory release failed", LOG_TAG);
    }
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
    error = esp_bt_sleep_enable();
    if (error != ESP_OK) {
        return ERROR_TAG("BLE modem sleep enable failed", LOG_TAG);
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
    if (ble_mode == BLEMode::SETUP) {
        error = esp_ble_gap_set_rand_addr(setup_ble_address);
        if (error != ESP_OK) {
            return ERROR_TAG("Setup BLE identity configuration failed", LOG_TAG);
        }
    } else if (ble_mode == BLEMode::TRACKER) {
        error = esp_ble_gap_set_rand_addr(active_finder_address());
        if (error != ESP_OK) {
            return ERROR_TAG("Finder BLE identity configuration failed", LOG_TAG);
        }
    }

    ESP_LOGI(LOG_TAG, "Bluetooth initialized for %s", device_id);
    return std::nullopt;
}

esp_err_t ble_open_maintenance_window() {
    if (ble_mode == BLEMode::SETUP) {
        return ESP_OK;
    }
    maintenance_window_open = true;
    if (maintenance_window_timer == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    esp_timer_stop(maintenance_window_timer);
    const esp_err_t timer_error = esp_timer_start_once(
        maintenance_window_timer, MAINTENANCE_WINDOW_MICROSECONDS);
    if (timer_error != ESP_OK) {
        maintenance_window_open = false;
        return timer_error;
    }
    ESP_LOGI(LOG_TAG,
             "Maintenance advertising opened for 120 seconds after button hold");
    request_advertising_refresh();
    return ESP_OK;
}

bool ble_service_ready() {
    return service_started.load(std::memory_order_acquire);
}
