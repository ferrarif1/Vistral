#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
BASE_URL="http://${API_HOST}:${API_PORT}"
BUSINESS_USERNAME="${BUSINESS_USERNAME:-alice}"
BUSINESS_PASSWORD="${BUSINESS_PASSWORD:-mock-pass}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-mock-pass-admin}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-verify-report-retention-e2e] jq is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
VERIFY_LOG="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
REPORT_DIR="${APP_DATA_DIR}/verify-reports"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${VERIFY_LOG}" "${API_LOG}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
VERIFICATION_REPORTS_DIR="${REPORT_DIR}" \
API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
npm run dev:api >"${API_LOG}" 2>&1 &
API_PID=$!

for _ in {1..120}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-verify-report-retention-e2e] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

REPORT_BASENAME="docker-verify-full-retention-e2e-$(date +%s)"
VERIFY_SKIP_HEALTHZ=1 \
BASE_URL="${BASE_URL}" \
REPORT_DIR="${REPORT_DIR}" \
REPORT_BASENAME="${REPORT_BASENAME}" \
BUSINESS_USERNAME="${BUSINESS_USERNAME}" \
BUSINESS_PASSWORD="${BUSINESS_PASSWORD}" \
bash scripts/docker-verify-full.sh >"${VERIFY_LOG}" 2>&1

REPORT_JSON_PATH="${REPORT_DIR}/${REPORT_BASENAME}.json"
if [[ ! -f "${REPORT_JSON_PATH}" ]]; then
  echo "[smoke-verify-report-retention-e2e] expected report file not found: ${REPORT_JSON_PATH}"
  cat "${VERIFY_LOG}"
  exit 1
fi

file_retention_json="$(jq -c '.runtime_metrics_retention' "${REPORT_JSON_PATH}")"
if [[ -z "${file_retention_json}" || "${file_retention_json}" == "null" ]]; then
  echo "[smoke-verify-report-retention-e2e] runtime_metrics_retention missing in report file."
  cat "${REPORT_JSON_PATH}"
  exit 1
fi

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}")"
if [[ "$(echo "${login_resp}" | jq -r '.success')" != "true" ]]; then
  echo "[smoke-verify-report-retention-e2e] admin login failed."
  echo "${login_resp}"
  exit 1
fi

reports_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/admin/verification-reports")"
if [[ "$(echo "${reports_resp}" | jq -r '.success')" != "true" ]]; then
  echo "[smoke-verify-report-retention-e2e] admin report API failed."
  echo "${reports_resp}"
  exit 1
fi

api_retention_json="$(echo "${reports_resp}" | jq -c --arg filename "${REPORT_BASENAME}.json" '.data[] | select(.filename==$filename) | .runtime_metrics_retention')"
if [[ -z "${api_retention_json}" || "${api_retention_json}" == "null" ]]; then
  echo "[smoke-verify-report-retention-e2e] runtime_metrics_retention missing in admin API response."
  echo "${reports_resp}"
  exit 1
fi

normalized_file_json="$(jq -S -c '.' <<<"${file_retention_json}")"
normalized_api_json="$(jq -S -c '.' <<<"${api_retention_json}")"
if [[ "${normalized_file_json}" != "${normalized_api_json}" ]]; then
  echo "[smoke-verify-report-retention-e2e] retention mismatch between report file and admin API."
  echo "file=${normalized_file_json}"
  echo "api=${normalized_api_json}"
  exit 1
fi

echo "[smoke-verify-report-retention-e2e] PASS"
echo "report=${REPORT_BASENAME}.json"
echo "retention=${normalized_api_json}"
