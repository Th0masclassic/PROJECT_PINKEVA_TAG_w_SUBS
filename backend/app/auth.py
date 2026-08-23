from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from jwt import PyJWKClient

from .config import Settings, get_settings


@dataclass(frozen=True)
class Principal:
    user_id: UUID


@lru_cache
def _jwks_client(url: str) -> PyJWKClient:
    return PyJWKClient(url, cache_jwk_set=True, lifespan=300)


def _bearer_token(request: Request) -> str:
    authorization = request.headers.get("Authorization", "")
    scheme, separator, token = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A valid bearer token is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token


async def authenticated_principal(
    request: Request, settings: Annotated[Settings, Depends(get_settings)]
) -> Principal:
    token = _bearer_token(request)
    try:
        signing_key = await run_in_threadpool(
            _jwks_client(settings.supabase_jwks_url).get_signing_key_from_jwt,
            token,
        )
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=list(settings.supabase_jwt_algorithms),
            audience=settings.supabase_jwt_audience,
            issuer=settings.supabase_jwt_issuer,
            options={"require": ["exp", "iat", "sub", "aud"]},
        )
        user_id = UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError, KeyError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The access token is invalid or expired",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None
    return Principal(user_id=user_id)


AuthenticatedPrincipal = Annotated[Principal, Depends(authenticated_principal)]
