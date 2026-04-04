#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8802}"
BASE_URL="http://${API_HOST}:${API_PORT}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-auth-session] jq is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
ADMIN_COOKIE_FILE="$(mktemp)"
USER_COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
TMP_BODY="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${ADMIN_COOKIE_FILE}" "${USER_COOKIE_FILE}" "${API_LOG}" "${TMP_BODY}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
npm run dev:api >"${API_LOG}" 2>&1 &
API_PID=$!

for _ in {1..100}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-auth-session] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

me_before_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/users/me")"
me_before_username="$(jq -r '.data.username // empty' <"${TMP_BODY}")"
if [[ "${me_before_status}" != "200" || -z "${me_before_username}" ]]; then
  echo "[smoke-auth-session] expected bootstrap authenticated session before explicit logout."
  cat "${TMP_BODY}"
  exit 1
fi

register_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/register" \
  -d '{"username":"public-user","password":"public-pass-123"}')"
register_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${register_status}" != "403" || "${register_code}" != "PUBLIC_REGISTRATION_DISABLED" ]]; then
  echo "[smoke-auth-session] expected public registration to be explicitly disabled."
  cat "${TMP_BODY}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-auth-session] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

logout_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/auth/logout")"
logged_out="$(echo "${logout_response}" | jq -r '.data.logged_out // false')"
if [[ "${logged_out}" != "true" ]]; then
  echo "[smoke-auth-session] logout failed."
  echo "${logout_response}"
  exit 1
fi

me_after_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/users/me")"
me_after_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${me_after_status}" != "401" || "${me_after_code}" != "AUTHENTICATION_REQUIRED" ]]; then
  echo "[smoke-auth-session] expected /api/users/me to require auth after logout."
  cat "${TMP_BODY}"
  exit 1
fi

admin_login_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"admin","password":"mock-pass-admin"}')"
admin_login_username="$(echo "${admin_login_response}" | jq -r '.data.username // empty')"
if [[ "${admin_login_username}" != "admin" ]]; then
  echo "[smoke-auth-session] admin login failed after logout."
  echo "${admin_login_response}"
  exit 1
fi

admin_csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
admin_csrf_token="$(echo "${admin_csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${admin_csrf_token}" ]]; then
  echo "[smoke-auth-session] failed to obtain admin CSRF token."
  echo "${admin_csrf_response}"
  exit 1
fi

admin_users_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/admin/users")"
admin_users_count="$(jq -r '.data | length // 0' <"${TMP_BODY}")"
if [[ "${admin_users_status}" != "200" || "${admin_users_count}" -lt 2 ]]; then
  echo "[smoke-auth-session] expected admin user directory access."
  cat "${TMP_BODY}"
  exit 1
fi

create_user_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf_token}" \
  -X POST "${BASE_URL}/api/admin/users" \
  -d '{"username":"ops-user","password":"ops-pass-123","role":"user"}')"
created_user_id="$(echo "${create_user_response}" | jq -r '.data.id // empty')"
created_user_username="$(echo "${create_user_response}" | jq -r '.data.username // empty')"
created_user_role="$(echo "${create_user_response}" | jq -r '.data.role // empty')"
if [[ -z "${created_user_id}" || "${created_user_username}" != "ops-user" || "${created_user_role}" != "user" ]]; then
  echo "[smoke-auth-session] admin failed to create account."
  echo "${create_user_response}"
  exit 1
fi

admin_users_after_create_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/admin/users")"
created_user_visible="$(jq -r '[.data[] | select(.username == "ops-user")] | length' <"${TMP_BODY}")"
if [[ "${admin_users_after_create_status}" != "200" || "${created_user_visible}" != "1" ]]; then
  echo "[smoke-auth-session] expected created user to appear in admin directory."
  cat "${TMP_BODY}"
  exit 1
fi

cp "${COOKIE_FILE}" "${ADMIN_COOKIE_FILE}"

user_login_response="$(curl -sS -c "${USER_COOKIE_FILE}" -b "${USER_COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"ops-user","password":"ops-pass-123"}')"
user_login_username="$(echo "${user_login_response}" | jq -r '.data.username // empty')"
if [[ "${user_login_username}" != "ops-user" ]]; then
  echo "[smoke-auth-session] created user could not log in."
  echo "${user_login_response}"
  exit 1
fi

user_directory_denied_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${USER_COOKIE_FILE}" -b "${USER_COOKIE_FILE}" "${BASE_URL}/api/admin/users")"
user_directory_denied_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${user_directory_denied_status}" != "403" || "${user_directory_denied_code}" != "INSUFFICIENT_PERMISSIONS" ]]; then
  echo "[smoke-auth-session] non-admin should not access admin user directory."
  cat "${TMP_BODY}"
  exit 1
fi

user_csrf_response="$(curl -sS -c "${USER_COOKIE_FILE}" -b "${USER_COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
user_csrf_token="$(echo "${user_csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${user_csrf_token}" ]]; then
  echo "[smoke-auth-session] failed to obtain user CSRF token."
  echo "${user_csrf_response}"
  exit 1
fi

change_password_response="$(curl -sS -c "${USER_COOKIE_FILE}" -b "${USER_COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${user_csrf_token}" \
  -X POST "${BASE_URL}/api/users/me/password" \
  -d '{"current_password":"ops-pass-123","new_password":"ops-pass-456"}')"
password_updated="$(echo "${change_password_response}" | jq -r '.data.updated // false')"
if [[ "${password_updated}" != "true" ]]; then
  echo "[smoke-auth-session] password change failed."
  echo "${change_password_response}"
  exit 1
fi

disable_user_response="$(curl -sS -c "${ADMIN_COOKIE_FILE}" -b "${ADMIN_COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf_token}" \
  -X POST "${BASE_URL}/api/admin/users/${created_user_id}/status" \
  -d '{"status":"disabled","reason":"security review hold"}')"
disable_user_status="$(echo "${disable_user_response}" | jq -r '.data.status // empty')"
disable_user_reason="$(echo "${disable_user_response}" | jq -r '.data.status_reason // empty')"
if [[ "${disable_user_status}" != "disabled" || "${disable_user_reason}" != "security review hold" ]]; then
  echo "[smoke-auth-session] expected admin to disable ops-user."
  echo "${disable_user_response}"
  exit 1
fi

disabled_me_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${USER_COOKIE_FILE}" -b "${USER_COOKIE_FILE}" "${BASE_URL}/api/users/me")"
disabled_me_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${disabled_me_status}" != "401" || "${disabled_me_code}" != "AUTHENTICATION_REQUIRED" ]]; then
  echo "[smoke-auth-session] disabling account should immediately invalidate existing authenticated sessions."
  cat "${TMP_BODY}"
  exit 1
fi

disabled_login_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"ops-user","password":"ops-pass-456"}')"
disabled_login_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${disabled_login_status}" != "403" || "${disabled_login_code}" != "ACCOUNT_DISABLED" ]]; then
  echo "[smoke-auth-session] disabled account should not be able to log in."
  cat "${TMP_BODY}"
  exit 1
fi

reactivate_user_response="$(curl -sS -c "${ADMIN_COOKIE_FILE}" -b "${ADMIN_COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf_token}" \
  -X POST "${BASE_URL}/api/admin/users/${created_user_id}/status" \
  -d '{"status":"active"}')"
reactivate_user_status="$(echo "${reactivate_user_response}" | jq -r '.data.status // empty')"
reactivate_user_reason="$(echo "${reactivate_user_response}" | jq -r '.data.status_reason // empty')"
if [[ "${reactivate_user_status}" != "active" || -n "${reactivate_user_reason}" ]]; then
  echo "[smoke-auth-session] expected admin to reactivate ops-user."
  echo "${reactivate_user_response}"
  exit 1
fi

reset_password_response="$(curl -sS -c "${ADMIN_COOKIE_FILE}" -b "${ADMIN_COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf_token}" \
  -X POST "${BASE_URL}/api/admin/users/${created_user_id}/password-reset" \
  -d '{"new_password":"ops-pass-789"}')"
reset_password_username="$(echo "${reset_password_response}" | jq -r '.data.username // empty')"
if [[ "${reset_password_username}" != "ops-user" ]]; then
  echo "[smoke-auth-session] expected admin password reset to succeed."
  echo "${reset_password_response}"
  exit 1
fi

reactivated_me_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${USER_COOKIE_FILE}" -b "${USER_COOKIE_FILE}" "${BASE_URL}/api/users/me")"
reactivated_me_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${reactivated_me_status}" != "401" || "${reactivated_me_code}" != "AUTHENTICATION_REQUIRED" ]]; then
  echo "[smoke-auth-session] reactivated account should still require a fresh login after forced session invalidation."
  cat "${TMP_BODY}"
  exit 1
fi

old_password_login_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"ops-user","password":"ops-pass-456"}')"
old_password_login_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${old_password_login_status}" != "401" || "${old_password_login_code}" != "AUTHENTICATION_REQUIRED" ]]; then
  echo "[smoke-auth-session] old password should stop working after password change."
  cat "${TMP_BODY}"
  exit 1
fi

new_password_login_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"ops-user","password":"ops-pass-789"}')"
new_password_login_username="$(echo "${new_password_login_response}" | jq -r '.data.username // empty')"
if [[ "${new_password_login_username}" != "ops-user" ]]; then
  echo "[smoke-auth-session] new password login failed."
  echo "${new_password_login_response}"
  exit 1
fi

admin_self_disable_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${ADMIN_COOKIE_FILE}" -b "${ADMIN_COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${admin_csrf_token}" \
  -X POST "${BASE_URL}/api/admin/users/u-2/status" \
  -d '{"status":"disabled","reason":"self-test"}')"
admin_self_disable_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${admin_self_disable_status}" != "400" || "${admin_self_disable_code}" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-auth-session] current admin session should not be disableable."
  cat "${TMP_BODY}"
  exit 1
fi

echo "[smoke-auth-session] PASS"
echo "bootstrap_user=${me_before_username}"
echo "admin_user=${admin_login_username}"
echo "created_user=${created_user_username}"
echo "relogin_user=${new_password_login_username}"
