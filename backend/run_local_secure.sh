#!/bin/zsh
set -euo pipefail

# Local Mac development launcher. Application settings come from the ignored
# backend/.env file. The hosted database password remains in the login Keychain
# so it is not copied into a plaintext file or a process argument.

keychain_value() {
  /usr/bin/security find-generic-password \
    -a pinqeva \
    -s "$1" \
    -w
}

project_ref="ihquicfciteokafvrhol"
pooler_host="aws-0-eu-central-1.pooler.supabase.com"
runtime_password="$(keychain_value pinqeva-backend-db-role)"

script_dir="${0:A:h}"
cd "$script_dir"

if [[ ! -f .env ]]; then
  print -u2 "backend/.env is required"
  exit 1
fi

export DATABASE_URL="postgresql://pinqeva_backend.${project_ref}:${runtime_password}@${pooler_host}:5432/postgres?sslmode=require"
export SUPABASE_URL="https://${project_ref}.supabase.co"
export SUPABASE_JWKS_URL="https://${project_ref}.supabase.co/auth/v1/.well-known/jwks.json"
export SUPABASE_JWT_ISSUER="https://${project_ref}.supabase.co/auth/v1"
export SUPABASE_JWT_AUDIENCE="authenticated"
export SUPABASE_JWT_ALGORITHMS="ES256,RS256"

exec .venv/bin/uvicorn app.main:app \
  --host 127.0.0.1 \
  --port 8080 \
  --env-file .env
