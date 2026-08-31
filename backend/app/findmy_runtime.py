"""Construct the same authentication stack for the API and container CLI."""

from __future__ import annotations

from .apple_2fa import TwilioSMSCodeProvider
from .apple_sms import InteractiveTwoFactor
from .apple_auth import AppleAuthManager, AppleSession
from .config import Settings


def create_auth_manager(
    settings: Settings, *, background: bool = True, interactive: bool = False
) -> AppleAuthManager | None:
    static = None
    if settings.findmy_dsid and settings.findmy_search_party_token:
        static = AppleSession(settings.findmy_dsid, settings.findmy_search_party_token)
    if not (settings.findmy_apple_id or settings.findmy_auth_file or static):
        return None
    manager = AppleAuthManager(
        apple_id=settings.findmy_apple_id,
        apple_password=settings.findmy_apple_password,
        second_factor=settings.findmy_second_factor,
        anisette_url=settings.findmy_anisette_url,
        timeout_seconds=settings.findmy_request_timeout_seconds,
        auth_file=settings.findmy_auth_file,
        static_session=static,
        login_on_startup=settings.findmy_login_on_startup,
        state_path=settings.findmy_state_path,
        state_key=settings.key_encryption_key,
        background=background,
        interactive=interactive,
        sms_phone_id=settings.findmy_sms_phone_id,
        retry_initial_seconds=settings.findmy_retry_initial_seconds,
        retry_max_seconds=settings.findmy_retry_max_seconds,
        two_factor_provider_name="interactive"
        if interactive
        else settings.findmy_two_factor_provider,
    )
    if interactive:
        manager.two_factor_code_provider = InteractiveTwoFactor()
    elif settings.findmy_two_factor_provider == "twilio":
        manager.two_factor_code_provider = TwilioSMSCodeProvider(
            account_sid=settings.findmy_twilio_account_sid,
            auth_token=settings.findmy_twilio_auth_token,
            phone_number=settings.findmy_twilio_phone_number,
            allowed_senders=settings.findmy_twilio_allowed_senders,
            timeout_seconds=settings.findmy_twilio_timeout_seconds,
            poll_seconds=settings.findmy_twilio_poll_seconds,
            request_timeout=min(settings.findmy_request_timeout_seconds, 10),
            stop=manager.stop_event,
        )
    return manager
