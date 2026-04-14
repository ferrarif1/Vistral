#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
COOKIE_FILE="$(mktemp)"
USERNAME="${HEALTHCHECK_USERNAME:-alice}"
PASSWORD="${HEALTHCHECK_PASSWORD:-mock-pass}"
CHECK_RUNTIME_IMPORTS="${CHECK_RUNTIME_IMPORTS:-1}"
RUNTIME_PYTHON_BIN="${RUNTIME_PYTHON_BIN:-/opt/vistral-venv/bin/python}"

cleanup() {
  rm -f "${COOKIE_FILE}"
}
trap cleanup EXIT

echo "[docker-healthcheck] Checking nginx health endpoint"
curl -fsS "${BASE_URL}/healthz" >/dev/null

echo "[docker-healthcheck] Checking API health endpoint"
curl -fsS "${BASE_URL}/api/health" >/dev/null

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

if [[ "${CHECK_RUNTIME_IMPORTS}" == "1" ]]; then
  echo "[docker-healthcheck] Verifying vistral-api runtime python path"
  runtime_python_env="$(docker compose exec -T vistral-api sh -lc 'printf "%s" "${VISTRAL_PYTHON_BIN:-}"')"
  if [[ -z "${runtime_python_env}" ]]; then
    echo "[docker-healthcheck] VISTRAL_PYTHON_BIN is empty in vistral-api container."
    echo "  Set CHECK_RUNTIME_IMPORTS=0 to skip this check."
    exit 1
  fi
  if [[ "${runtime_python_env}" != "${RUNTIME_PYTHON_BIN}" ]]; then
    echo "[docker-healthcheck] VISTRAL_PYTHON_BIN mismatch."
    echo "  expected=${RUNTIME_PYTHON_BIN}"
    echo "  actual=${runtime_python_env}"
    exit 1
  fi

  echo "[docker-healthcheck] Verifying runtime dependency imports in vistral-api"
  docker compose exec -T vistral-api "${RUNTIME_PYTHON_BIN}" -c "import paddleocr, doctr, ultralytics; print('runtime_imports_ok')" >/dev/null
fi

echo "[docker-healthcheck] DONE"
