"""Private Docker CLI for Apple authentication; no HTTP admin/login endpoint.

Run inside the running API container so it shares the Anisette provider and
encrypted state volume: python -m app.findmy_admin --help
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from uuid import UUID

import psycopg
import requests

from .apple_auth import AppleAuthenticationError
from .config import ConfigurationError, Settings, get_settings
from .findmy import FindMyClient, FindMyConfigurationError, FindMyRequestError
from .findmy_runtime import create_auth_manager
from .findmy_state import StateError


def anisette_status(settings: Settings) -> dict:
    try:
        response = requests.get(
            settings.findmy_anisette_url,
            timeout=settings.findmy_request_timeout_seconds,
            allow_redirects=False,
        )
        if response.status_code != 200:
            return {"ok": False, "http_status": response.status_code}
        value = response.json()
        present = isinstance(value, dict) and all(
            isinstance(value.get(name), str)
            and bool(value[name].strip())
            and not any(c in value[name] for c in "\x00\r\n")
            for name in ("X-Apple-I-MD", "X-Apple-I-MD-M")
        )
        return {"ok": present, "http_status": 200, "required_headers_present": present}
    except (requests.RequestException, ValueError):
        return {"ok": False, "reason": "anisette_unavailable"}


def tracker_report_hash(settings: Settings, device_id: UUID) -> bytes:
    """Read only one currently claimed tracker; never select private key material."""
    with psycopg.connect(settings.database_url, connect_timeout=10) as connection:
        connection.execute("SET TRANSACTION READ ONLY")
        connection.execute("SET LOCAL statement_timeout = '10s'")
        row = connection.execute(
            """
            SELECT ps.advertisement_key_sha256
              FROM public.device d
              JOIN public.ownership o ON o.device_id = d.id AND o.ended_at IS NULL
              JOIN public.provisioning_session ps
                ON ps.id = d.provisioning_session_id AND ps.device_id = d.id
               AND ps.user_id = o.user_id AND ps.status = 'claimed'
             WHERE d.id = %s
            """,
            (device_id,),
        ).fetchone()
    if not row or row[0] is None or len(row[0]) != 32:
        raise FindMyConfigurationError(
            "Claim this tracker before probing Apple", code="tracker_not_claimed"
        )
    return bytes(row[0])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "status", help="Show safe auth status and check Anisette (no Apple login)"
    )
    login = commands.add_parser("login", help="Obtain and persist an Apple session")
    login.add_argument(
        "--interactive",
        action="store_true",
        help="Read password/2FA with hidden TTY prompts",
    )
    login.add_argument(
        "--force",
        action="store_true",
        help="Explicitly retry after operator action or replace a cached session",
    )
    probe = commands.add_parser(
        "probe", help="Query Apple for one claimed tracker; print only status/count"
    )
    probe.add_argument("--device-id", required=True, type=UUID)
    args = parser.parse_args(argv)
    # Never enable verbose third-party HTTP logging, which may contain secrets.
    logging.getLogger("pinqeva").setLevel(logging.WARNING)
    try:
        if getattr(args, "interactive", False) and not sys.stdin.isatty():
            raise FindMyConfigurationError(
                "Use docker exec -it for interactive login",
                code="interactive_tty_required",
            )
        settings = get_settings()
        manager = create_auth_manager(
            settings,
            background=args.command != "login",
            interactive=getattr(args, "interactive", False),
        )
        if args.command == "status":
            auth = {"configured": manager is not None, "phase": "not_configured"}
            if manager is not None:
                auth.update(manager.status())
                if manager._store is not None:
                    # Validate encryption too: a stale status file must not hide
                    # an unreadable cache or a changed encryption root/account.
                    stored = manager._store.read()
                    state_exists = stored is not None and not stored.get("bind_account")
                    path = manager._store.status_path
                    if state_exists and path.is_file():
                        data = json.loads(path.read_text(encoding="utf-8"))
                        if isinstance(data, dict):
                            auth.update(
                                {
                                    key: data[key]
                                    for key in manager.status()
                                    if key in data
                                }
                            )
                auth["auto_relogin_enabled"] = bool(
                    settings.findmy_apple_id and settings.findmy_apple_password
                )
                auth["two_factor_provider"] = settings.findmy_two_factor_provider
            anisette = anisette_status(settings)
            print(json.dumps({"authentication": auth, "anisette": anisette}, indent=2))
            return 0 if anisette["ok"] and auth.get("phase") == "ready" else 1
        if manager is None:
            raise FindMyConfigurationError(
                "Configure Apple authentication first", code="credentials_required"
            )
        if args.command == "login":
            manager.initialize(force=args.force)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "authentication": manager.status(),
                        "next": "Run probe --device-id with your claimed tracker to verify Apple accepts the session.",
                    },
                    indent=2,
                )
            )
            return 0
        report_hash = tracker_report_hash(settings, args.device_id)
        manager.initialize(allow_login=False)
        client = FindMyClient(
            auth_manager=manager,
            anisette_url=settings.findmy_anisette_url,
            timeout_seconds=settings.findmy_request_timeout_seconds,
            lookback_hours=settings.findmy_lookback_hours,
            report_api=settings.findmy_report_api,
        )
        count = client.probe_reports(report_hash)
        print(
            json.dumps(
                {
                    "ok": True,
                    "apple_http_status": 200,
                    "report_count": count,
                    "lookback_hours": settings.findmy_lookback_hours,
                    "note": "A zero count means Apple accepted the query but returned no reports in this window.",
                },
                indent=2,
            )
        )
        return 0
    except FindMyRequestError as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "reason": exc.code,
                    "stage": exc.stage,
                    "apple_http_status": exc.http_status,
                }
            )
        )
    except (AppleAuthenticationError, FindMyConfigurationError) as exc:
        print(json.dumps({"ok": False, "reason": exc.code}))
    except ConfigurationError as exc:
        print(
            json.dumps(
                {"ok": False, "reason": "configuration_error", "message": str(exc)}
            )
        )
    except StateError:
        print(json.dumps({"ok": False, "reason": "state_unavailable"}))
    except psycopg.Error:
        print(json.dumps({"ok": False, "reason": "database_unavailable"}))
    except KeyboardInterrupt:
        print(json.dumps({"ok": False, "reason": "interrupted"}))
        return 130
    except Exception:
        print(json.dumps({"ok": False, "reason": "diagnostic_failed"}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
