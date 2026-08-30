from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


PINNED_UPSTREAM_COMMIT = "d46e9528578015b51d3b84dd91bf8f16e9ab850f"


@dataclass(frozen=True)
class BridgeSettings:
    service_token: str
    upstream_directory: Path
    refresh_interval_seconds: int = 3 * 24 * 60 * 60
    report_timeout_seconds: float = 60.0

    @classmethod
    def from_environment(cls) -> "BridgeSettings":
        token = os.getenv("PINQEVA_GOOGLE_BRIDGE_TOKEN", "")
        upstream = os.getenv("PINQEVA_GOOGLE_FINDMYTOOLS_DIR", "")
        try:
            refresh = int(
                os.getenv(
                    "PINQEVA_GOOGLE_REFRESH_INTERVAL_SECONDS",
                    str(3 * 24 * 60 * 60),
                )
            )
            timeout = float(
                os.getenv("PINQEVA_GOOGLE_REPORT_TIMEOUT_SECONDS", "60")
            )
        except ValueError as exc:
            raise RuntimeError("Google bridge timing configuration is invalid") from exc
        if len(token) < 32 or any(character.isspace() for character in token):
            raise RuntimeError(
                "PINQEVA_GOOGLE_BRIDGE_TOKEN must be at least 32 non-space characters"
            )
        if not upstream:
            raise RuntimeError("PINQEVA_GOOGLE_FINDMYTOOLS_DIR is required")
        if not 60 * 60 <= refresh <= 4 * 24 * 60 * 60:
            raise RuntimeError(
                "PINQEVA_GOOGLE_REFRESH_INTERVAL_SECONDS must be between one hour and four days"
            )
        if not 10 <= timeout <= 180:
            raise RuntimeError(
                "PINQEVA_GOOGLE_REPORT_TIMEOUT_SECONDS must be between 10 and 180"
            )
        return cls(
            service_token=token,
            upstream_directory=Path(upstream).resolve(),
            refresh_interval_seconds=refresh,
            report_timeout_seconds=timeout,
        )
