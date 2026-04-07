#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-mock-pass-admin}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-account-governance] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-account-governance] python3 is required."
  exit 1
fi

if [[ "${START_API}" == "true" && -z "${API_PORT:-}" ]]; then
  API_PORT="$(
    python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
  )"
fi
API_PORT="${API_PORT:-8808}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

ADMIN_COOKIE="$(mktemp)"
USER_COOKIE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
TMP_BODY="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${ADMIN_COOKIE}" "${USER_COOKIE}" "${API_LOG}" "${TMP_BODY}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

wait_for_health() {
  for _ in $(seq 1 120); do
    if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

get_csrf_token() {
  local cookie_file="$1"
  curl -sS -c "${cookie_file}" -b "${cookie_file}" "${BASE_URL}/api/auth/csrf" | jq -r '.data.csrf_token // empty'
}

if [[ "${START_API}" == "true" ]]; then
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  if [[ "${START_API}" == "true" ]]; then
    if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
      echo "[smoke-account-governance] API process exited before health check (possible port conflict)."
      cat "${API_LOG}"
      exit 1
    fi
    echo "[smoke-account-governance] API failed to start."
    cat "${API_LOG}"
  else
    echo "[smoke-account-governance] API is unreachable at ${BASE_URL}."
  fi
  exit 1
fi

admin_login_resp="$(curl -sS -c "${ADMIN_COOKIE}" -b "${ADMIN_COOKIE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}")"
admin_login_success="$(echo "${admin_login_resp}" | jq -r '.success // false')"
admin_role="$(echo "${admin_login_resp}" | jq -r '.data.role // empty')"
if [[ "${admin_login_success}" != "true" || "${admin_role}" != "admin" ]]; then
  echo "[smoke-account-governance] admin login failed."
  echo "${admin_login_resp}"
  exit 1
fi

admin_id="$(echo "${admin_login_resp}" | jq -r '.data.id // empty')"
if [[ -z "${admin_id}" ]]; then
  echo "[smoke-account-governance] admin id missing from login response."
  echo "${admin_login_resp}"
  exit 1
fi

admin_csrf="$(get_csrf_token "${ADMIN_COOKIE}")"
if [[ -z "${admin_csrf}" ]]; then
  echo "[smoke-account-governance] failed to obtain admin csrf token."
  exit 1
fi

created_username="ops-governance-$(date +%s)"
initial_password="ops-pass-123"
changed_password="ops-pass-456"
reset_password="ops-pass-789"
disable_reason="governance smoke disable"

create_user_resp="$(curl -sS -c "${ADMIN_COOKIE}" -b "${ADMIN_COOKIE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf}" \
  -X POST "${BASE_URL}/api/admin/users" \
  -d "{\"username\":\"${created_username}\",\"password\":\"${initial_password}\",\"role\":\"user\"}")"
created_user_id="$(echo "${create_user_resp}" | jq -r '.data.id // empty')"
created_user_role="$(echo "${create_user_resp}" | jq -r '.data.role // empty')"
if [[ -z "${created_user_id}" || "${created_user_role}" != "user" ]]; then
  echo "[smoke-account-governance] failed to create user."
  echo "${create_user_resp}"
  exit 1
fi

user_login_resp="$(curl -sS -c "${USER_COOKIE}" -b "${USER_COOKIE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${created_username}\",\"password\":\"${initial_password}\"}")"
user_login_success="$(echo "${user_login_resp}" | jq -r '.success // false')"
if [[ "${user_login_success}" != "true" ]]; then
  echo "[smoke-account-governance] created user login failed."
  echo "${user_login_resp}"
  exit 1
fi

user_admin_list_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${USER_COOKIE}" -b "${USER_COOKIE}" "${BASE_URL}/api/admin/users")"
user_admin_list_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${user_admin_list_status}" != "403" || "${user_admin_list_code}" != "INSUFFICIENT_PERMISSIONS" ]]; then
  echo "[smoke-account-governance] non-admin should not access /api/admin/users."
  cat "${TMP_BODY}"
  exit 1
fi

user_csrf="$(get_csrf_token "${USER_COOKIE}")"
if [[ -z "${user_csrf}" ]]; then
  echo "[smoke-account-governance] failed to obtain user csrf token."
  exit 1
fi

change_password_resp="$(curl -sS -c "${USER_COOKIE}" -b "${USER_COOKIE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${user_csrf}" \
  -X POST "${BASE_URL}/api/users/me/password" \
  -d "{\"current_password\":\"${initial_password}\",\"new_password\":\"${changed_password}\"}")"
change_password_ok="$(echo "${change_password_resp}" | jq -r '.data.updated // false')"
if [[ "${change_password_ok}" != "true" ]]; then
  echo "[smoke-account-governance] user self password change failed."
  echo "${change_password_resp}"
  exit 1
fi

old_password_login_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${created_username}\",\"password\":\"${initial_password}\"}")"
old_password_error_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${old_password_login_status}" != "401" || "${old_password_error_code}" != "AUTHENTICATION_REQUIRED" ]]; then
  echo "[smoke-account-governance] old password should be rejected after password change."
  cat "${TMP_BODY}"
  exit 1
fi

relogin_changed_resp="$(curl -sS -c "${USER_COOKIE}" -b "${USER_COOKIE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${created_username}\",\"password\":\"${changed_password}\"}")"
relogin_changed_success="$(echo "${relogin_changed_resp}" | jq -r '.success // false')"
if [[ "${relogin_changed_success}" != "true" ]]; then
  echo "[smoke-account-governance] login with changed password failed."
  echo "${relogin_changed_resp}"
  exit 1
fi

admin_csrf="$(get_csrf_token "${ADMIN_COOKIE}")"
if [[ -z "${admin_csrf}" ]]; then
  echo "[smoke-account-governance] failed to refresh admin csrf token."
  exit 1
fi

self_disable_resp="$(curl -sS -c "${ADMIN_COOKIE}" -b "${ADMIN_COOKIE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf}" \
  -X POST "${BASE_URL}/api/admin/users/${admin_id}/status" \
  -d '{"status":"disabled","reason":"self-disable-should-fail"}')"
self_disable_success="$(echo "${self_disable_resp}" | jq -r '.success // false')"
self_disable_error_code="$(echo "${self_disable_resp}" | jq -r '.error.code // empty')"
self_disable_message="$(echo "${self_disable_resp}" | jq -r '.error.message // empty')"
if [[ "${self_disable_success}" != "false" || "${self_disable_error_code}" != "VALIDATION_ERROR" || ("${self_disable_message}" != *"own account"* && "${self_disable_message}" != *"current admin"*) ]]; then
  echo "[smoke-account-governance] self-disable guard failed."
  echo "${self_disable_resp}"
  exit 1
fi

disable_user_resp="$(curl -sS -c "${ADMIN_COOKIE}" -b "${ADMIN_COOKIE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf}" \
  -X POST "${BASE_URL}/api/admin/users/${created_user_id}/status" \
  -d "{\"status\":\"disabled\",\"reason\":\"${disable_reason}\"}")"
disabled_status="$(echo "${disable_user_resp}" | jq -r '.data.status // empty')"
disabled_reason="$(echo "${disable_user_resp}" | jq -r '.data.status_reason // empty')"
if [[ "${disabled_status}" != "disabled" || "${disabled_reason}" != "${disable_reason}" ]]; then
  echo "[smoke-account-governance] disable user action failed."
  echo "${disable_user_resp}"
  exit 1
fi

disabled_session_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${USER_COOKIE}" -b "${USER_COOKIE}" "${BASE_URL}/api/users/me")"
disabled_session_error_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${disabled_session_status}" != "401" || "${disabled_session_error_code}" != "AUTHENTICATION_REQUIRED" ]]; then
  echo "[smoke-account-governance] disabled account session should be invalidated."
  cat "${TMP_BODY}"
  exit 1
fi

disabled_login_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${created_username}\",\"password\":\"${changed_password}\"}")"
disabled_login_error_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${disabled_login_status}" != "403" || "${disabled_login_error_code}" != "ACCOUNT_DISABLED" ]]; then
  echo "[smoke-account-governance] disabled account should not be able to login."
  cat "${TMP_BODY}"
  exit 1
fi

admin_csrf="$(get_csrf_token "${ADMIN_COOKIE}")"
reactivate_resp="$(curl -sS -c "${ADMIN_COOKIE}" -b "${ADMIN_COOKIE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf}" \
  -X POST "${BASE_URL}/api/admin/users/${created_user_id}/status" \
  -d '{"status":"active"}')"
reactivated_status="$(echo "${reactivate_resp}" | jq -r '.data.status // empty')"
reactivated_reason="$(echo "${reactivate_resp}" | jq -r '.data.status_reason')"
if [[ "${reactivated_status}" != "active" || "${reactivated_reason}" != "null" ]]; then
  echo "[smoke-account-governance] reactivate user action failed."
  echo "${reactivate_resp}"
  exit 1
fi

admin_csrf="$(get_csrf_token "${ADMIN_COOKIE}")"
reset_password_resp="$(curl -sS -c "${ADMIN_COOKIE}" -b "${ADMIN_COOKIE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf}" \
  -X POST "${BASE_URL}/api/admin/users/${created_user_id}/password-reset" \
  -d "{\"new_password\":\"${reset_password}\"}")"
reset_user_id="$(echo "${reset_password_resp}" | jq -r '.data.id // empty')"
reset_user_status="$(echo "${reset_password_resp}" | jq -r '.data.status // empty')"
if [[ "${reset_user_id}" != "${created_user_id}" || "${reset_user_status}" != "active" ]]; then
  echo "[smoke-account-governance] admin password reset failed."
  echo "${reset_password_resp}"
  exit 1
fi

reset_login_resp="$(curl -sS -c "${USER_COOKIE}" -b "${USER_COOKIE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${created_username}\",\"password\":\"${reset_password}\"}")"
reset_login_success="$(echo "${reset_login_resp}" | jq -r '.success // false')"
if [[ "${reset_login_success}" != "true" ]]; then
  echo "[smoke-account-governance] login with reset password failed."
  echo "${reset_login_resp}"
  exit 1
fi

echo "[smoke-account-governance] PASS"
echo "created_user_id=${created_user_id}"
echo "created_username=${created_username}"
echo "admin_id=${admin_id}"
