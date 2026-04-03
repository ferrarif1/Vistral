#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
COOKIE_FILE="$(mktemp)"
USERNAME="healthcheck-$(date +%s)"
PASSWORD="${HEALTHCHECK_PASSWORD:-healthcheck123}"

cleanup() {
  rm -f "${COOKIE_FILE}"
}
trap cleanup EXIT

echo "[docker-healthcheck] Checking nginx health endpoint"
curl -fsS "${BASE_URL}/healthz" >/dev/null

echo "[docker-healthcheck] Checking API health endpoint"
curl -fsS "${BASE_URL}/api/health" >/dev/null

echo "[docker-healthcheck] Registering probe account"
curl -fsS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -X POST "${BASE_URL}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}" >/dev/null

echo "[docker-healthcheck] Logging in with username/password"
curl -fsS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}" >/dev/null

echo "[docker-healthcheck] Validating wrong-password rejection"
curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${USERNAME}\",\"password\":\"wrong-password\"}" | \
  jq -e '.success == false' >/dev/null

echo "[docker-healthcheck] Verifying current session"
curl -fsS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/users/me" | jq -e ".success == true and .data.username == \"${USERNAME}\"" >/dev/null

echo "[docker-healthcheck] DONE"
