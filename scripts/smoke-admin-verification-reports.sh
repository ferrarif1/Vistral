#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
BUSINESS_USERNAME="${BUSINESS_USERNAME:-alice}"
BUSINESS_PASSWORD="${BUSINESS_PASSWORD:-mock-pass}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-mock-pass-admin}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-admin-verification-reports] jq is required but not found"
  exit 1
fi

BUSINESS_COOKIE="$(mktemp)"
ADMIN_COOKIE="$(mktemp)"
NON_ADMIN_BODY_FILE="$(mktemp)"
ADMIN_BODY_FILE="$(mktemp)"

cleanup() {
  rm -f "${BUSINESS_COOKIE}" "${ADMIN_COOKIE}" "${NON_ADMIN_BODY_FILE}" "${ADMIN_BODY_FILE}"
}
trap cleanup EXIT

echo "[smoke-admin-verification-reports] login as non-admin (${BUSINESS_USERNAME})"
curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${BUSINESS_USERNAME}\",\"password\":\"${BUSINESS_PASSWORD}\"}" | \
  jq -e ".success == true and .data.username == \"${BUSINESS_USERNAME}\"" >/dev/null

echo "[smoke-admin-verification-reports] verify non-admin cannot access admin endpoint"
non_admin_status="$(curl -sS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -o "${NON_ADMIN_BODY_FILE}" \
  -w '%{http_code}' \
  "${BASE_URL}/api/admin/verification-reports")"
if [[ "${non_admin_status}" != "403" ]]; then
  echo "[smoke-admin-verification-reports] expected 403 for non-admin, got ${non_admin_status}"
  cat "${NON_ADMIN_BODY_FILE}"
  exit 1
fi

jq -e '.success == false and .error.code == "INSUFFICIENT_PERMISSIONS"' "${NON_ADMIN_BODY_FILE}" >/dev/null

echo "[smoke-admin-verification-reports] login as admin (${ADMIN_USERNAME})"
curl -fsS -c "${ADMIN_COOKIE}" -b "${ADMIN_COOKIE}" \
  -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}" | \
  jq -e ".success == true and .data.username == \"${ADMIN_USERNAME}\" and .data.role == \"admin\"" >/dev/null

echo "[smoke-admin-verification-reports] verify admin access succeeds"
admin_status="$(curl -sS -c "${ADMIN_COOKIE}" -b "${ADMIN_COOKIE}" \
  -o "${ADMIN_BODY_FILE}" \
  -w '%{http_code}' \
  "${BASE_URL}/api/admin/verification-reports")"
if [[ "${admin_status}" != "200" ]]; then
  echo "[smoke-admin-verification-reports] expected 200 for admin, got ${admin_status}"
  cat "${ADMIN_BODY_FILE}"
  exit 1
fi

jq -e '.success == true and (.data | type == "array")' "${ADMIN_BODY_FILE}" >/dev/null

echo "[smoke-admin-verification-reports] PASSED"
