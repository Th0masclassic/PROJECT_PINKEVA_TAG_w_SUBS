#include <stdint.h>
#include <string.h>
#include <stdbool.h>
#include <stdio.h>

#include "nvs_driver.hpp"
#include "esp_partition.h"
#include "utils.hpp"


#include "ble_driver.hpp"
#include "nvs_driver.hpp"

#include <optional>
#include <cstring>
#include <cstdio>

#include "esp_bt.h"
#include "esp_bt_main.h"

#include "esp_gap_ble_api.h"

// GATT SERVER
#include "esp_gatts_api.h"
#include "esp_gatt_defs.h"

#include "esp_log.h"
#include "esp_mac.h"
#include "esp_partition.h"
#include "freertos/FreeRTOS.h"



static const char* LOG_TAG = "BLE_DRIVER";

// Device ID string
static char device_id[DEVICE_ID_LEN];

// Used to know which mode the BLE is currently in, either SETUP or TRACKER
static BLEMode ble_mode;

/** Callback function for BT events */
static void esp_gap_cb(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *param);

/** Callback function for GATT events */
static void esp_gatts_cb(
    esp_gatts_cb_event_t event,
    esp_gatt_if_t gatts_if,
    esp_ble_gatts_cb_param_t *param
);

/** Random device address */
static esp_bd_addr_t rnd_addr = { 0xFF, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF };

/** Advertisement payload */
static uint8_t adv_data[31] = {
	0x1e, /* Length (30) */
	0xff, /* Manufacturer Specific Data (type 0xff) */
	0x4c, 0x00, /* Company ID (Apple) */
	0x12, 0x19, /* Offline Finding type and length */
	0x00, /* State */
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, /* First two bits */
	0x00, /* Hint (0x00) */
};

static uint8_t setup_adv_data[31];
static uint8_t setup_adv_len = 0;

/* https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/bluetooth/esp_gap_ble.html#_CPPv420esp_ble_adv_params_t */
static esp_ble_adv_params_t tracker_adv_params  = {
    // Advertising min interval:
    // Minimum advertising interval for undirected and low duty cycle
    // directed advertising. Range: 0x0020 to 0x4000 Default: N = 0x0800
    // (1.28 second) Time = N * 0.625 msec Time Range: 20 ms to 10.24 sec
    .adv_int_min        = 0x0640, // 1s
    // Advertising max interval:
    // Maximum advertising interval for undirected and low duty cycle
    // directed advertising. Range: 0x0020 to 0x4000 Default: N = 0x0800
    // (1.28 second) Time = N * 0.625 msec Time Range: 20 ms to 10.24 sec
    .adv_int_max        = 0x0C80, // 2s
    // Advertisement type
    .adv_type           = ADV_TYPE_NONCONN_IND,
    // Use the random address
    .own_addr_type      = BLE_ADDR_TYPE_RANDOM,
    // All channels
    .channel_map        = ADV_CHNL_ALL,
    // Allow both scan and connection requests from anyone. 
    .adv_filter_policy = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};

static esp_ble_adv_params_t setup_adv_params = {
    .adv_int_min        = 0x00A0, // 100 ms
    .adv_int_max        = 0x0190, // 250 ms

    // Important: phone must be able to connect
    .adv_type           = ADV_TYPE_IND,

    // No Find My random address yet
    .own_addr_type      = BLE_ADDR_TYPE_PUBLIC,

    .channel_map        = ADV_CHNL_ALL,

    .adv_filter_policy  = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
};


static void esp_gatts_cb(
    esp_gatts_cb_event_t event,
    esp_gatt_if_t gatts_if,
    esp_ble_gatts_cb_param_t *param
)
{
    switch (event)
    {
        // =========================================================
        // GATT APP REGISTERED
        // =========================================================
        case ESP_GATTS_REG_EVT:
        {
            ESP_LOGI(LOG_TAG, "GATT application registered");

            if (param->reg.status != ESP_GATT_OK)
            {
                ESP_LOGE(
                    LOG_TAG,
                    "GATT registration failed: %d",
                    param->reg.status
                );

                break;
            }

            /*
             * Aqui depois vamos criar o PINKEVA Provisioning Service.
             */

            break;
        }


        // =========================================================
        // CLIENT CONNECTED
        // =========================================================
        case ESP_GATTS_CONNECT_EVT:
        {
            ESP_LOGI(
                LOG_TAG,
                "Client connected"
            );

            ESP_LOGI(
                LOG_TAG,
                "Connection ID: %d",
                param->connect.conn_id
            );

            ESP_LOGI(
                LOG_TAG,
                "Remote device: "
                "%02X:%02X:%02X:%02X:%02X:%02X",
                param->connect.remote_bda[0],
                param->connect.remote_bda[1],
                param->connect.remote_bda[2],
                param->connect.remote_bda[3],
                param->connect.remote_bda[4],
                param->connect.remote_bda[5]
            );

            break;
        }


        // =========================================================
        // CLIENT DISCONNECTED
        // =========================================================
        case ESP_GATTS_DISCONNECT_EVT:
        {
            ESP_LOGI(
                LOG_TAG,
                "Client disconnected. Reason: %d",
                param->disconnect.reason
            );

            /*
             * Se ainda estamos em setup mode,
             * voltamos a anunciar para permitir uma nova conexão.
             */
            if (ble_mode == BLEMode::SETUP)
            {
                esp_err_t ret =
                    esp_ble_gap_start_advertising(
                        &setup_adv_params
                    );

                if (ret != ESP_OK)
                {
                    ESP_LOGE(
                        LOG_TAG,
                        "Failed to restart setup advertising: %s",
                        esp_err_to_name(ret)
                    );
                }
            }

            break;
        }


        // =========================================================
        // CLIENT READ CHARACTERISTIC
        // =========================================================
        case ESP_GATTS_READ_EVT:
        {
            ESP_LOGI(
                LOG_TAG,
                "GATT READ request"
            );

            ESP_LOGI(
                LOG_TAG,
                "Handle: %d",
                param->read.handle
            );

            /*
             * Mais tarde:
             *
             * if (param->read.handle == device_id_handle)
             * {
             *     devolver device_id
             * }
             */

            break;
        }


        // =========================================================
        // CLIENT WRITE CHARACTERISTIC
        // =========================================================
        case ESP_GATTS_WRITE_EVT:
        {
            ESP_LOGI(
                LOG_TAG,
                "GATT WRITE request"
            );

            ESP_LOGI(
                LOG_TAG,
                "Handle: %d | Length: %d",
                param->write.handle,
                param->write.len
            );

            /*
             * Mostrar os bytes recebidos.
             */
            ESP_LOG_BUFFER_HEX(
                LOG_TAG,
                param->write.value,
                param->write.len
            );


            /*
             * FUTURO:
             *
             * if (param->write.handle == public_key_handle)
             * {
             *     if (param->write.len == PUBLIC_KEY_SIZE)
             *     {
             *         save_key(param->write.value);
             *
             *         switch_to_tracker_mode();
             *     }
             * }
             */


            // Se o client pediu response
            if (param->write.need_rsp)
            {
                esp_ble_gatts_send_response(
                    gatts_if,
                    param->write.conn_id,
                    param->write.trans_id,
                    ESP_GATT_OK,
                    NULL
                );
            }

            break;
        }


        // =========================================================
        // MTU CHANGED
        // =========================================================
        case ESP_GATTS_MTU_EVT:
        {
            ESP_LOGI(
                LOG_TAG,
                "MTU updated: %d",
                param->mtu.mtu
            );

            break;
        }


        default:
            break;
    }
}

static void esp_gap_cb(
    esp_gap_ble_cb_event_t event,
    esp_ble_gap_cb_param_t *param
)
{
    switch (event) {

        // =====================================================
        // Advertising data has been configured
        // =====================================================
        case ESP_GAP_BLE_ADV_DATA_RAW_SET_COMPLETE_EVT:
        {
            if (param->adv_data_raw_cmpl.status != ESP_BT_STATUS_SUCCESS) {
                ESP_LOGE(
                    LOG_TAG,
                    "Failed to configure advertising data. Status: %d",
                    param->adv_data_raw_cmpl.status
                );
                break;
            }

            esp_err_t ret;

            if (ble_mode == BLEMode::SETUP) {

                ESP_LOGI(
                    LOG_TAG,
                    "Starting SETUP advertising..."
                );

                ret = esp_ble_gap_start_advertising(
                    &setup_adv_params
                );

            } else {

                ESP_LOGI(
                    LOG_TAG,
                    "Starting TRACKER advertising..."
                );

                ret = esp_ble_gap_start_advertising(
                    &tracker_adv_params
                );
            }

            if (ret != ESP_OK) {
                ESP_LOGE(
                    LOG_TAG,
                    "Could not start advertising: %s",
                    esp_err_to_name(ret)
                );
            }

            break;
        }


        // =====================================================
        // Advertising started
        // =====================================================
        case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
        {
            if (
                param->adv_start_cmpl.status
                != ESP_BT_STATUS_SUCCESS
            ) {

                ESP_LOGE(
                    LOG_TAG,
                    "Advertising start failed. Status: %d",
                    param->adv_start_cmpl.status
                );

            } else {

                if (ble_mode == BLEMode::SETUP) {

                    ESP_LOGI(
                        LOG_TAG,
                        "SETUP advertising started."
                    );

                } else {

                    ESP_LOGI(
                        LOG_TAG,
                        "TRACKER advertising started."
                    );
                }
            }

            break;
        }


        // =====================================================
        // Advertising stopped
        // =====================================================
        case ESP_GAP_BLE_ADV_STOP_COMPLETE_EVT:
        {
            if (
                param->adv_stop_cmpl.status
                != ESP_BT_STATUS_SUCCESS
            ) {

                ESP_LOGE(
                    LOG_TAG,
                    "Advertising stop failed. Status: %d",
                    param->adv_stop_cmpl.status
                );

            } else {

                ESP_LOGI(
                    LOG_TAG,
                    "Advertising stopped successfully."
                );
            }

            break;
        }


        default:
            break;
    }
}

int load_key(uint8_t *dst, size_t size) {
    const esp_partition_t *keypart = esp_partition_find_first(static_cast<esp_partition_type_t>(0x40), static_cast<esp_partition_subtype_t>(0x00), "key");
    if (keypart == NULL) {
        ESP_LOGE(LOG_TAG, "Could not find key partition");
        return 1;
    }
    esp_err_t status;
    status = esp_partition_read(keypart, 0, dst, size);
    if (status != ESP_OK) {
        ESP_LOGE(LOG_TAG, "Could not read key from partition: %s", esp_err_to_name(status));
    }
    return status;
}

void set_addr_from_key(esp_bd_addr_t addr, uint8_t *public_key) {
	addr[0] = public_key[0] | 0b11000000;
	addr[1] = public_key[1];
	addr[2] = public_key[2];
	addr[3] = public_key[3];
	addr[4] = public_key[4];
	addr[5] = public_key[5];
}

void set_payload_from_key(uint8_t *payload, uint8_t *public_key) {
    /* copy last 22 bytes */
	memcpy(&payload[7], &public_key[6], 22);
	/* append two bits of public key */
	payload[29] = public_key[0] >> 6;
}


/**
 * @brief Initialize the device ID based on the factory MAC address
 * @return ESP_OK if successful, otherwise an error code
 */
static esp_err_t init_device_id(void)
{
    uint8_t mac[6];

    esp_err_t err = esp_efuse_mac_get_default(mac);

    if (err != ESP_OK) {
        ESP_LOGE(LOG_TAG, "Failed to read factory MAC");
        return err;
    }

    snprintf(
        device_id,
        sizeof(device_id),
        "PKV-%02X%02X%02X%02X%02X%02X",
        mac[0],
        mac[1],
        mac[2],
        mac[3],
        mac[4],
        mac[5]
    );

    ESP_LOGI(LOG_TAG, "Device ID: %s", device_id);

    return ESP_OK;
}

static void build_setup_adv_data()
{
    size_t i = 0;

    // Flags
    setup_adv_data[i++] = 0x02;  // Length
    setup_adv_data[i++] = ESP_BLE_AD_TYPE_FLAG;
    setup_adv_data[i++] =
        ESP_BLE_ADV_FLAG_GEN_DISC |
        ESP_BLE_ADV_FLAG_BREDR_NOT_SPT;

    // Complete Local Name
    size_t name_len = strlen(device_id);

    setup_adv_data[i++] = name_len + 1;
    setup_adv_data[i++] = ESP_BLE_AD_TYPE_NAME_CMPL;

    memcpy(
        &setup_adv_data[i],
        device_id,
        name_len
    );

    i += name_len;

    setup_adv_len = i;
}

std::optional<ERROR_TAG> ble_init(void)
{
    // Initialize NVS
    esp_err_t ret = nvs_init();
    
    // If nvs cant be initialized, return an error tag
    if (ret != ESP_OK) {
        return ERROR_TAG("NVS initialization failed", "NVS");
    }

    // Initialize the device ID
    ret = init_device_id();
    if(ret != ESP_OK) {
        return ERROR_TAG("Device ID initialization failed", "DEVICE_ID");
    }

    if ((ret = esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT)) != ESP_OK) {
        return ERROR_TAG("Could not release classic BT memory", LOG_TAG);
    }
    esp_bt_controller_config_t bt_cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    esp_bt_controller_init(&bt_cfg);
    esp_bt_controller_enable(ESP_BT_MODE_BLE);

    esp_bluedroid_init();
    esp_bluedroid_enable();

    //register the scan callback function to the gap module
    ret = esp_ble_gap_register_callback(esp_gap_cb);
    if (ret != ESP_OK) {
        ESP_LOGE(LOG_TAG, "gap register error: %s", esp_err_to_name(ret));
        return ERROR_TAG("gap register error", LOG_TAG);
    }

    //register the GATTS callback function to the gap module
    ret = esp_ble_gatts_register_callback(esp_gatts_cb);
    if (ret != ESP_OK) {
        return ERROR_TAG(
            "GATTS callback registration failed",
            LOG_TAG
        );
    }
    
    ret = esp_ble_gatts_app_register(0);

    if (ret != ESP_OK) {
        return ERROR_TAG(
            "GATTS app registration failed",
            LOG_TAG
        );
    }

    static uint8_t public_key[28];
    ret = load_key(public_key, sizeof(public_key));

    if (ret == ESP_OK) {

        // =========================================
        // REGISTERED DEVICE
        // =========================================

        
        ble_mode = BLEMode::TRACKER;

        ESP_LOGI(LOG_TAG, "Public key found");
        ESP_LOGI(LOG_TAG, "Starting tracker mode");

        set_addr_from_key(rnd_addr, public_key);
        set_payload_from_key(adv_data, public_key);

        ESP_LOGI(LOG_TAG, "using device address: %02x %02x %02x %02x %02x %02x", rnd_addr[0], rnd_addr[1], rnd_addr[2], rnd_addr[3], rnd_addr[4], rnd_addr[5]);
    

        if ((ret = esp_ble_gap_set_rand_addr(rnd_addr)) != ESP_OK) {
            ESP_LOGE(LOG_TAG, "couldn't set random address: %s", esp_err_to_name(ret));
            return ERROR_TAG("couldn't set random address", LOG_TAG);
        }

        if ((esp_ble_gap_config_adv_data_raw((uint8_t*)&adv_data, sizeof(adv_data))) != ESP_OK) {
            ESP_LOGE(LOG_TAG, "couldn't configure BLE adv: %s", esp_err_to_name(ret));
            return ERROR_TAG("couldn't configure BLE adv", LOG_TAG);
        }

    } else {

        // =========================================
        // BRAND NEW DEVICE
        // =========================================

        ble_mode = BLEMode::SETUP;

        // Blink the LED to indicate that the device is in setup mode
        ERROR_LED led;
        led.blink(1, 5000, true, new ERROR_TAG("SETUP MODE ENTERING", LOG_TAG));

        ESP_LOGI(LOG_TAG, "No public key");
        ESP_LOGI(LOG_TAG, "Starting setup mode");

        build_setup_adv_data();

        ret = esp_ble_gap_config_adv_data_raw(
            setup_adv_data,
            setup_adv_len
        );

        if (ret != ESP_OK) {
            return ERROR_TAG(
                "Could not configure setup advertising",
                LOG_TAG
            );
        }
    }


   
    ESP_LOGI(LOG_TAG, "bluetooth initialized");
    return std::nullopt;
}
