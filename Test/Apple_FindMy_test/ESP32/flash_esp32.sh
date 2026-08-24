#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
FIRMWARE_DIR="${SCRIPT_DIR}/firmware"
PORT=""
BAUDRATE=460800

usage() {
    cat <<'EOF'
Flash the Pinkeva ESP32-C3 provisioning firmware.

Usage:
  ./flash_esp32.sh --port <serial-port> [--slow]

Options:
  -p, --port <path>  Serial interface for the ESP32-C3 (required).
  -s, --slow         Use 115200 baud instead of 460800.
  -h, --help         Show this help.

The NVS partition is intentionally preserved because it contains the
per-device factory bootstrap key. This script never writes an advertisement
key and never flashes the legacy OpenHaystack image.
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
