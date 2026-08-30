from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import hashlib
import hmac
from pathlib import Path
import secrets as secrets_module
import subprocess
import sys
import threading
import time
from typing import Any

from .codec import encode_base64url
from .config import PINNED_UPSTREAM_COMMIT


class UpstreamUnavailable(RuntimeError):
    pass


class RegistrationUnavailable(RuntimeError):
    pass


class ReportUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class UpstreamReport:
    latitude: float
    longitude: float
    confidence: int
    status: int
    timestamp: datetime
    source_fingerprint_base64url: str


@dataclass(frozen=True)
class _DeviceBinding:
    canonical_id: str
    identity_key: bytes
    registration: Any


class GoogleFindMyToolsAdapter:
    """Synchronous adapter around one exact GoogleFindMyTools revision.

    The upstream project uses process-global token/FCM caches, so all private
    API work is serialized. This service must run as one worker process per
    Google account; horizontal API replicas would otherwise race those caches.
    """

    def __init__(
        self,
        upstream_directory: Path,
        *,
        report_timeout_seconds: float,
        refresh_interval_seconds: int,
    ) -> None:
        self.upstream_directory = upstream_directory.resolve()
        self.report_timeout_seconds = report_timeout_seconds
        self.refresh_interval_seconds = refresh_interval_seconds
        self._lock = threading.RLock()
        self._last_refresh_monotonic = 0.0
        self._modules = self._load_modules()

    def _load_modules(self) -> dict[str, Any]:
        if not (self.upstream_directory / "main.py").is_file():
            raise UpstreamUnavailable("GoogleFindMyTools checkout is incomplete")
        try:
            result = subprocess.run(
                [
                    "git",
                    "-C",
                    str(self.upstream_directory),
                    "rev-parse",
                    "HEAD",
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise UpstreamUnavailable("Could not verify GoogleFindMyTools") from exc
        if result.stdout.strip().lower() != PINNED_UPSTREAM_COMMIT:
            raise UpstreamUnavailable(
                "GoogleFindMyTools checkout does not match the pinned commit"
            )
        try:
            worktree = subprocess.run(
                [
                    "git",
                    "-C",
                    str(self.upstream_directory),
                    "status",
                    "--porcelain",
                    "--untracked-files=no",
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise UpstreamUnavailable(
                "Could not verify GoogleFindMyTools worktree"
            ) from exc
        if worktree.stdout.strip():
            raise UpstreamUnavailable(
                "GoogleFindMyTools tracked files differ from the pinned commit"
            )
        directory_text = str(self.upstream_directory)
        if directory_text not in sys.path:
            sys.path.insert(0, directory_text)
        try:
            from Auth.fcm_receiver import FcmReceiver
            from FMDNCrypto.eid_generator import generate_eid
            from FMDNCrypto.foreign_tracker_cryptor import decrypt
            from FMDNCrypto.key_derivation import FMDNOwnerOperations
            from KeyBackup.cloud_key_decryptor import (
                decrypt_aes_gcm,
                decrypt_eik,
                encrypt_aes_gcm,
            )
            from NovaApi.ExecuteAction.LocateTracker.location_request import (
                create_location_request,
            )
            from NovaApi.nova_request import nova_request
            from NovaApi.scopes import NOVA_ACTION_API_SCOPE
            from NovaApi.util import generate_random_uuid
            from NovaApi.ListDevices.nbe_list_devices import request_device_list
            from ProtoDecoders import Common_pb2, DeviceUpdate_pb2
            from ProtoDecoders.decoder import (
                parse_device_list_protobuf,
                parse_device_update_protobuf,
            )
            from SpotApi.CreateBleDevice.config import (
                max_truncated_eid_seconds_server,
                mcu_fast_pair_model_id,
            )
            from SpotApi.CreateBleDevice.util import flip_bits, hours_to_seconds
            from SpotApi.GetEidInfoForE2eeDevices.get_owner_key import get_owner_key
            from SpotApi.UploadPrecomputedPublicKeyIds.upload_precomputed_public_key_ids import (
                get_next_eids,
            )
            from SpotApi.spot_request import spot_request
        except Exception as exc:
            raise UpstreamUnavailable(
                "GoogleFindMyTools or its Python dependencies cannot be imported"
            ) from exc
        return locals()

    def derive_advertisement_key(self, identity_key: bytes, timestamp: int = 0) -> bytes:
        return bytes(self._modules["generate_eid"](identity_key, timestamp))

    def _device_list(self) -> Any:
        encoded = self._modules["request_device_list"]()
        if not isinstance(encoded, str) or not encoded:
            raise UpstreamUnavailable("Google device list request failed")
        return self._modules["parse_device_list_protobuf"](encoded)

    def _bindings(self, device_list: Any) -> list[_DeviceBinding]:
        owner_key = self._modules["get_owner_key"]()
        model_id = self._modules["mcu_fast_pair_model_id"]
        bindings: list[_DeviceBinding] = []
        for device in device_list.deviceMetadata:
            registration = device.information.deviceRegistration
            if registration.fastPairModelId != model_id:
                continue
            canonical_ids = device.identifierInformation.canonicIds.canonicId
            if not canonical_ids:
                continue
            try:
                encrypted = self._modules["flip_bits"](
                    registration.encryptedUserSecrets.encryptedIdentityKey,
                    True,
                )
                identity_key = bytes(
                    self._modules["decrypt_eik"](owner_key, encrypted)
                )
            except Exception:
                # One old account entry must not prevent other Pinqeva tags from
                # being located. No key or identifier is logged here.
                continue
            if len(identity_key) != 32:
                continue
            bindings.append(
                _DeviceBinding(
                    canonical_id=canonical_ids[0].id,
                    identity_key=identity_key,
                    registration=registration,
                )
            )
        return bindings

    def _find_binding(self, device_list: Any, identity_key: bytes) -> _DeviceBinding | None:
        return next(
            (
                binding
                for binding in self._bindings(device_list)
                if hmac.compare_digest(binding.identity_key, identity_key)
            ),
            None,
        )

    def _register_exact_identity(self, identity_key: bytes, serial_number: str) -> None:
        modules = self._modules
        owner_key = modules["get_owner_key"]()
        pair_date = int(time.time())
        request = modules["DeviceUpdate_pb2"].RegisterBleDeviceRequest()
        request.fastPairModelId = modules["mcu_fast_pair_model_id"]
        request.description.userDefinedName = f"PINQEVA {serial_number[-6:]}"
        request.description.deviceType = (
            modules["DeviceUpdate_pb2"].SpotDeviceType.DEVICE_TYPE_BEACON
        )
        component = modules["DeviceUpdate_pb2"].DeviceComponentInformation()
        component.imageUrl = "https://pinqeva.com/"
        request.description.deviceComponentsInformation.append(component)
        request.capabilities.isAdvertising = True
        request.capabilities.trackableComponents = 1
        request.capabilities.capableComponents = 1
        registration = request.e2eePublicKeyRegistration
        registration.rotationExponent = 10
        registration.pairingDate = pair_date
        secrets = registration.encryptedUserSecrets
        secrets.encryptedIdentityKey = modules["flip_bits"](
            modules["encrypt_aes_gcm"](owner_key, identity_key), True
        )
        secrets.encryptedAccountKey = secrets_module.token_bytes(44)
        secrets.encryptedSha256AccountKeyPublicAddress = (
            secrets_module.token_bytes(60)
        )
        secrets.ownerKeyVersion = 1
        secrets.creationDate.seconds = pair_date
        static_eid = self.derive_advertisement_key(identity_key, 0)
        rotation_period = 1024
        counter = pair_date
        slots = int(modules["max_truncated_eid_seconds_server"] / rotation_period)
        for _ in range(slots):
            info = modules["DeviceUpdate_pb2"].PublicKeyIdList.PublicKeyIdInfo()
            info.publicKeyId.truncatedEid = static_eid[:10]
            info.timestamp.seconds = counter
            registration.publicKeyIdList.publicKeyIdInfo.append(info)
            counter += rotation_period
        request.manufacturerName = "PINQEVA development"
        request.modelName = "PINQEVA Card"
        owner_operations = modules["FMDNOwnerOperations"]()
        owner_operations.generate_keys(identity_key=identity_key)
        request.ringKey = owner_operations.ringing_key
        request.recoveryKey = owner_operations.recovery_key
        request.unwantedTrackingKey = owner_operations.tracking_key
        modules["spot_request"]("CreateBleDevice", request.SerializeToString())

    def refresh_all(self, *, force: bool = False) -> bool:
        with self._lock:
            now_monotonic = time.monotonic()
            if (
                not force
                and self._last_refresh_monotonic
                and now_monotonic - self._last_refresh_monotonic
                < self.refresh_interval_seconds
            ):
                return False
            device_list = self._device_list()
            request = self._modules[
                "DeviceUpdate_pb2"
            ].UploadPrecomputedPublicKeyIdsRequest()
            now_seconds = int(time.time())
            for binding in self._bindings(device_list):
                item = self._modules[
                    "DeviceUpdate_pb2"
                ].UploadPrecomputedPublicKeyIdsRequest.DevicePublicKeyIds()
                item.pairDate = binding.registration.pairDate
                item.canonicId.id = binding.canonical_id
                slots = self._modules["get_next_eids"](
                    binding.identity_key,
                    item.pairDate,
                    now_seconds - self._modules["hours_to_seconds"](3),
                    duration_seconds=self._modules[
                        "max_truncated_eid_seconds_server"
                    ],
                )
                item.clientList.publicKeyIdInfo.extend(slots)
                request.deviceEids.append(item)
            if request.deviceEids:
                self._modules["spot_request"](
                    "UploadPrecomputedPublicKeyIds", request.SerializeToString()
                )
            self._last_refresh_monotonic = now_monotonic
            return True

    def ensure_registration(
        self, *, identity_key: bytes, serial_number: str
    ) -> str:
        with self._lock:
            device_list = self._device_list()
            binding = self._find_binding(device_list, identity_key)
            if binding is None:
                self._register_exact_identity(identity_key, serial_number)
                for _ in range(4):
                    time.sleep(1)
                    device_list = self._device_list()
                    binding = self._find_binding(device_list, identity_key)
                    if binding is not None:
                        break
                if binding is None:
                    raise RegistrationUnavailable(
                        "Google did not confirm the exact identity registration"
                    )
                self.refresh_all(force=True)
                return "registered"
            return "refreshed" if self.refresh_all() else "current"

    def fetch_reports(
        self,
        *,
        identity_key: bytes,
        lookback_hours: int,
        requested_at: datetime,
    ) -> list[UpstreamReport]:
        with self._lock:
            device_list = self._device_list()
            binding = self._find_binding(device_list, identity_key)
            if binding is None:
                raise ReportUnavailable("Google identity is not registered")
            modules = self._modules
            event = threading.Event()
            response_holder: list[Any] = []
            request_uuid = modules["generate_random_uuid"]()

            def callback(encoded: str) -> None:
                try:
                    response = modules["parse_device_update_protobuf"](encoded)
                except Exception:
                    return
                if response.fcmMetadata.requestUuid == request_uuid:
                    response_holder.append(response)
                    event.set()

            receiver = modules["FcmReceiver"]()
            token = receiver.register_for_location_updates(callback)
            try:
                payload = modules["create_location_request"](
                    binding.canonical_id, token, request_uuid
                )
                modules["nova_request"](modules["NOVA_ACTION_API_SCOPE"], payload)
                if not event.wait(self.report_timeout_seconds):
                    raise ReportUnavailable("Google report response timed out")
            finally:
                try:
                    receiver.location_update_callbacks.remove(callback)
                except ValueError:
                    pass
            if not response_holder:
                raise ReportUnavailable("Google returned no matching response")
            return self._decode_reports(
                response_holder[0],
                identity_key,
                requested_at=requested_at,
                lookback_hours=lookback_hours,
            )

    def _decode_reports(
        self,
        response: Any,
        identity_key: bytes,
        *,
        requested_at: datetime,
        lookback_hours: int,
    ) -> list[UpstreamReport]:
        modules = self._modules
        locations = (
            response.deviceMetadata.information.locationInformation.reports
            .recentLocationAndNetworkLocations
        )
        raw_locations = list(locations.networkLocations)
        raw_times = list(locations.networkLocationTimestamps)
        if locations.HasField("recentLocation"):
            raw_locations.append(locations.recentLocation)
            raw_times.append(locations.recentLocationTimestamp)
        results: list[UpstreamReport] = []
        for location, timestamp_value in zip(raw_locations, raw_times):
            if location.status == modules["Common_pb2"].Status.SEMANTIC:
                continue
            encrypted = location.geoLocation.encryptedReport.encryptedLocation
            public_random = location.geoLocation.encryptedReport.publicKeyRandom
            try:
                if not public_random:
                    plaintext = modules["decrypt_aes_gcm"](
                        hashlib.sha256(identity_key).digest(), encrypted
                    )
                else:
                    plaintext = modules["decrypt"](
                        identity_key, encrypted, public_random, 0
                    )
                decoded = modules["DeviceUpdate_pb2"].Location()
                decoded.ParseFromString(plaintext)
                latitude = decoded.latitude / 1e7
                longitude = decoded.longitude / 1e7
                confidence = int(location.geoLocation.accuracy)
                status = int(location.status)
                timestamp = datetime.fromtimestamp(
                    int(timestamp_value.seconds), tz=UTC
                )
            except Exception:
                continue
            if (
                not -90 <= latitude <= 90
                or not -180 <= longitude <= 180
                or not 0 <= confidence <= 255
                or not 0 <= status <= 255
                or timestamp
                < requested_at.astimezone(UTC) - timedelta(hours=lookback_hours)
                or timestamp > requested_at.astimezone(UTC) + timedelta(minutes=5)
            ):
                continue
            fingerprint = hashlib.sha256(
                b"pinqeva-google-report-v1\x00"
                + binding_bytes(timestamp, encrypted, public_random)
            ).digest()
            results.append(
                UpstreamReport(
                    latitude=latitude,
                    longitude=longitude,
                    confidence=confidence,
                    status=status,
                    timestamp=timestamp,
                    source_fingerprint_base64url=encode_base64url(fingerprint),
                )
            )
        results.sort(key=lambda report: report.timestamp, reverse=True)
        return results


def binding_bytes(timestamp: datetime, encrypted: bytes, public_random: bytes) -> bytes:
    return (
        timestamp.isoformat(timespec="microseconds").encode("ascii")
        + b"\x00"
        + bytes(encrypted)
        + b"\x00"
        + bytes(public_random)
    )
