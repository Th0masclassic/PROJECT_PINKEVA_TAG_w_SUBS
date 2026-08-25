#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

constexpr size_t ADVERTISEMENT_KEY_SIZE = 28;
constexpr size_t TAG_CONTROL_KEY_SIZE = 32;
constexpr size_t DEVICE_BOOTSTRAP_KEY_SIZE = 32;
constexpr size_t SUBSCRIPTION_ENTITLEMENT_SIZE = 135;

/** Initialize NVS without silently erasing already provisioned data. */
esp_err_t nvs_init();

/** Reject erased, zero, or incorrectly sized advertisement keys. */
bool advertisement_key_is_valid(const uint8_t *key, size_t length);

/** Load and validate the committed protocol-v1 advertisement key. */
esp_err_t load_advertisement_key(uint8_t *destination, size_t destination_size);

/** Load the secret used to authenticate an owner-authorized reset. */
esp_err_t load_tag_control_key(uint8_t *destination, size_t destination_size);

/** Load the factory-injected key used for per-connection app authorization. */
esp_err_t load_device_bootstrap_key(uint8_t *destination, size_t destination_size);

/** Load the last signed subscription entitlement, if one is stored. */
esp_err_t load_subscription_entitlement(uint8_t *destination,
                                        size_t destination_size);

/** Load the last trusted Unix UTC clock checkpoint. */
esp_err_t load_trusted_clock_epoch(uint64_t *epoch_seconds);

/** Save once; an identical retry is accepted, replacement is rejected. */
esp_err_t save_tag_control_key(const uint8_t *key, size_t length);

/** Atomically commit a new key, then read it back and compare every byte. */
esp_err_t save_advertisement_key(const uint8_t *key, size_t length);

/** Atomically replace the signed entitlement packet after firmware validation. */
esp_err_t save_subscription_entitlement(const uint8_t *entitlement,
                                         size_t length);

/** Persist a monotonic Unix UTC checkpoint; rollback attempts are rejected. */
esp_err_t save_trusted_clock_epoch(uint64_t epoch_seconds);

/** Erase owner provisioning data while preserving the factory bootstrap key. */
esp_err_t erase_provisioning_data();
