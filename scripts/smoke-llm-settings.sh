#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-llm-settings] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-llm-settings] python3 is required."
  exit 1
fi

if [[ -z "${API_PORT:-}" ]]; then
  API_PORT="$(
    python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
  )"
fi
BASE_URL="http://${API_HOST}:${API_PORT}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_RUNTIME_DIR="$(mktemp -d)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}"
  rm -rf "${APP_RUNTIME_DIR}"
}
trap cleanup EXIT

start_api() {
  (
    cd "${APP_RUNTIME_DIR}"
    APP_STATE_STORE_PATH="${APP_RUNTIME_DIR}/app-state.json" \
    UPLOAD_STORAGE_ROOT="${APP_RUNTIME_DIR}/uploads" \
    TRAINING_WORKDIR_ROOT="${APP_RUNTIME_DIR}/training" \
    LLM_CONFIG_SECRET="smoke-llm-settings-secret" \
    API_HOST="${API_HOST}" \
    API_PORT="${API_PORT}" \
    "${ROOT_DIR}/node_modules/.bin/tsx" "${ROOT_DIR}/backend/src/server.ts"
  ) >>"${API_LOG}" 2>&1 &
  API_PID=$!

  for _ in {1..100}; do
    if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
    echo "[smoke-llm-settings] API process exited before health check (possible port conflict)."
    cat "${API_LOG}"
    return 1
  fi

  echo "[smoke-llm-settings] API failed to start."
  cat "${API_LOG}"
  return 1
}

stop_api() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
    API_PID=""
  fi
}

cd "${ROOT_DIR}"

start_api

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-llm-settings] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

initial_config="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/settings/llm")"
initial_has_key="$(echo "${initial_config}" | jq -r 'if .data.has_api_key == null then "" else (.data.has_api_key | tostring) end')"
if [[ "${initial_has_key}" != "false" ]]; then
  echo "[smoke-llm-settings] expected clean initial config without saved key."
  echo "${initial_config}"
  exit 1
fi

save_payload='{"llm_config":{"enabled":true,"provider":"chatanywhere","base_url":"https://api.chatanywhere.tech/v1","api_key":"sk-smoke-1234567890","model":"gpt-4o-mini","temperature":0.4},"keep_existing_api_key":false}'
save_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/settings/llm" \
  -d "${save_payload}")"

save_masked="$(echo "${save_response}" | jq -r '.data.api_key_masked // empty')"
save_model="$(echo "${save_response}" | jq -r '.data.model // empty')"
if [[ -z "${save_masked}" || "${save_masked}" == "Not set" || "${save_model}" != "gpt-4o-mini" ]]; then
  echo "[smoke-llm-settings] initial save failed."
  echo "${save_response}"
  exit 1
fi

edit_payload='{"llm_config":{"enabled":true,"provider":"chatanywhere","base_url":"https://api.chatanywhere.tech/v1/chat/completions","api_key":"","model":"gpt-4.1-mini","temperature":0.1},"keep_existing_api_key":true}'
edit_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/settings/llm" \
  -d "${edit_payload}")"

edit_has_key="$(echo "${edit_response}" | jq -r 'if .data.has_api_key == null then "" else (.data.has_api_key | tostring) end')"
edit_model="$(echo "${edit_response}" | jq -r '.data.model // empty')"
edit_base_url="$(echo "${edit_response}" | jq -r '.data.base_url // empty')"
if [[ "${edit_has_key}" != "true" || "${edit_model}" != "gpt-4.1-mini" || "${edit_base_url}" != "https://api.chatanywhere.tech/v1/chat/completions" ]]; then
  echo "[smoke-llm-settings] edit-with-stored-key failed."
  echo "${edit_response}"
  exit 1
fi

stop_api
start_api

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-llm-settings] failed to refresh CSRF token after restart."
  echo "${csrf_response}"
  exit 1
fi

persisted_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/settings/llm")"
persisted_has_key="$(echo "${persisted_response}" | jq -r 'if .data.has_api_key == null then "" else (.data.has_api_key | tostring) end')"
persisted_model="$(echo "${persisted_response}" | jq -r '.data.model // empty')"
persisted_base_url="$(echo "${persisted_response}" | jq -r '.data.base_url // empty')"
persisted_temperature="$(echo "${persisted_response}" | jq -r '.data.temperature // empty')"
if [[ "${persisted_has_key}" != "true" || "${persisted_model}" != "gpt-4.1-mini" || "${persisted_base_url}" != "https://api.chatanywhere.tech/v1/chat/completions" || "${persisted_temperature}" != "0.1" ]]; then
  echo "[smoke-llm-settings] persisted config did not reload after restart."
  echo "${persisted_response}"
  exit 1
fi

clear_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X DELETE "${BASE_URL}/api/settings/llm")"
clear_has_key="$(echo "${clear_response}" | jq -r 'if .data.has_api_key == null then "" else (.data.has_api_key | tostring) end')"
clear_enabled="$(echo "${clear_response}" | jq -r 'if .data.enabled == null then "" else (.data.enabled | tostring) end')"
if [[ "${clear_has_key}" != "false" || "${clear_enabled}" != "false" ]]; then
  echo "[smoke-llm-settings] clear failed."
  echo "${clear_response}"
  exit 1
fi

echo "[smoke-llm-settings] PASS"
echo "saved_masked_key=${save_masked}"
echo "persisted_model=${persisted_model}"
