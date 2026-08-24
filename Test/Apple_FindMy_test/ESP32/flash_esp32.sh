#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
FIRMWARE_DIR="${SCRIPT_DIR}/firmware"
PORT=""
BAUDRATE=460800
ERASE_NVS=false

usage() {
    cat <<'EOF'
Flash the Pinkeva ESP32-C3 provisioning firmware.

Usage:
  ./flash_esp32.sh --port <serial-port> [--slow] [--erase-nvs]

Options:
  -p, --port <path>  Serial interface for the ESP32-C3 (required).
  -s, --slow         Use 115200 baud instead of 460800.
      --erase-nvs    Development-only: erase the NVS partition before flashing.
  -h, --help         Show this help.

The NVS partition is preserved by default. --erase-nvs is allowed only for the
checked-in development-no-bootstrap image and clears old tag keys so the board
starts a fresh setup flow. This script never writes an advertisement key and
never flashes the legacy OpenHaystack image.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -p|--port)
            if [[ $# -lt 2 ]]; then
                echo "Missing value for $1" >&2
                usage >&2
                exit 2
            fi
            PORT="$2"
            shift 2
            ;;
        -s|--slow)
            BAUDRATE=115200
            shift
            ;;
        --erase-nvs)
            ERASE_NVS=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ -z "$PORT" ]]; then
    echo "A serial port is required; use --port <path>." >&2
    usage >&2
    exit 2
fi
if [[ ! -e "$PORT" ]]; then
    echo "Serial port does not exist: $PORT" >&2
    exit 1
fi

BOOTLOADER="${FIRMWARE_DIR}/bootloader-esp32c3.bin"
PARTITION_TABLE="${FIRMWARE_DIR}/partition-table.bin"
APPLICATION="${FIRMWARE_DIR}/Pinkeva-ESP32-C3.bin"
for image in "$BOOTLOADER" "$PARTITION_TABLE" "$APPLICATION"; do
    if [[ ! -f "$image" ]]; then
        echo "Missing firmware image: $image" >&2
        echo "Run 'idf.py set-target esp32c3 && idf.py build' first." >&2
        exit 1
    fi
done

if command -v esptool.py >/dev/null 2>&1; then
    ESPTOOL=(esptool.py)
elif command -v python >/dev/null 2>&1 && python -c 'import esptool' >/dev/null 2>&1; then
    ESPTOOL=(python -m esptool)
else
    echo "esptool.py was not found. Activate the ESP-IDF environment first." >&2
    exit 1
fi

if ! "${ESPTOOL[@]}" --chip esp32c3 image_info "$APPLICATION" >/dev/null 2>&1; then
    echo "The application image is not a valid ESP32-C3 image; refusing to flash." >&2
    exit 1
fi
if ! "${ESPTOOL[@]}" --chip esp32c3 image_info "$BOOTLOADER" >/dev/null 2>&1; then
    echo "The bootloader image is not a valid ESP32-C3 image; refusing to flash." >&2
    exit 1
fi

if [[ "$ERASE_NVS" == true ]]; then
    if ! grep -q '"profile": "development-no-bootstrap"' "${FIRMWARE_DIR}/manifest.json"; then
        echo "--erase-nvs is only available for the development-no-bootstrap image." >&2
        exit 1
    fi
    echo "Erasing development NVS partition (old tag keys will be removed)."
    "${ESPTOOL[@]}" \
        --chip esp32c3 \
        --before default_reset \
        --after no_reset \
        --port "$PORT" \
        erase_region 0x9000 0x6000
fi

"${ESPTOOL[@]}" \
    --chip esp32c3 \
    --before default_reset \
    --after hard_reset \
    --baud "$BAUDRATE" \
    --port "$PORT" \
    write_flash \
    --flash_mode dio \
    --flash_freq 80m \
    --flash_size 2MB \
    0x0 "$BOOTLOADER" \
    0x8000 "$PARTITION_TABLE" \
    0x10000 "$APPLICATION"

echo "Pinkeva ESP32-C3 firmware flashed. NVS was preserved."
