#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
COOKIE_FILE="$(mktemp)"
LOG_FILE="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_FILE" "$LOG_FILE"
  rm -rf "$APP_DATA_DIR"
}

trap cleanup EXIT

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-conversation-history-clear] jq is required."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-conversation-history-clear] python3 is required."
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
API_PORT="${API_PORT:-8795}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

wait_for_health() {
  for _ in $(seq 1 60); do
    if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

if [[ "${START_API}" == "true" ]]; then
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  API_HOST="${API_HOST}" \
  API_PORT="$API_PORT" \
  npm run dev:api >"$LOG_FILE" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  if [[ "${START_API}" == "true" ]]; then
    if ! kill -0 "$API_PID" >/dev/null 2>&1; then
      echo "[smoke-conversation-history-clear] API process exited before health check (possible port conflict)"
      cat "$LOG_FILE"
      exit 1
    fi
    echo "[smoke-conversation-history-clear] API failed to start"
    cat "$LOG_FILE"
  else
    echo "[smoke-conversation-history-clear] API is unreachable at ${BASE_URL}"
  fi
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-conversation-history-clear] Failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

if [[ -n "${AUTH_USERNAME}" ]]; then
  if [[ -z "${AUTH_PASSWORD}" ]]; then
    echo "[smoke-conversation-history-clear] AUTH_PASSWORD is required when AUTH_USERNAME is set"
    exit 1
  fi

  login_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "$login_response" | jq -r '.success // false')"
  if [[ "${login_success}" != "true" ]]; then
    echo "[smoke-conversation-history-clear] login failed for AUTH_USERNAME=${AUTH_USERNAME}"
    echo "$login_response"
    exit 1
  fi

  csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
  if [[ -z "$csrf_token" ]]; then
    echo "[smoke-conversation-history-clear] Failed to refresh CSRF token after login"
    echo "$csrf_payload"
    exit 1
  fi
fi

model_id="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/models" | jq -r '.data[0].id // empty')"
if [[ -z "$model_id" ]]; then
  echo "[smoke-conversation-history-clear] No visible model found"
  exit 1
fi

create_conversation() {
  local prompt="$1"
  local started
  started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -X POST "${BASE_URL}/api/conversations/start" \
    -d "{\"model_id\":\"${model_id}\",\"initial_message\":\"${prompt}\",\"attachment_ids\":[]}")"
  local conversation_id
  conversation_id="$(echo "$started" | jq -r '.data.conversation.id // empty')"
  if [[ -z "${conversation_id}" ]]; then
    echo "[smoke-conversation-history-clear] failed to create conversation"
    echo "$started"
    exit 1
  fi
  echo "${conversation_id}"
}

run_tag="$(date +%s)"
conversation_a="$(create_conversation "history-clear smoke ${run_tag} - a")"
conversation_b="$(create_conversation "history-clear smoke ${run_tag} - b")"

listed_before="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/conversations")"
contains_a="$(echo "$listed_before" | jq -r --arg cid "$conversation_a" '[.data[] | select(.id==$cid)] | length')"
contains_b="$(echo "$listed_before" | jq -r --arg cid "$conversation_b" '[.data[] | select(.id==$cid)] | length')"
if [[ "${contains_a}" != "1" || "${contains_b}" != "1" ]]; then
  echo "[smoke-conversation-history-clear] expected seeded conversations missing before clear"
  echo "$listed_before"
  exit 1
fi

clear_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -X POST "${BASE_URL}/api/conversations/clear" \
  -d '{}')"
clear_success="$(echo "$clear_response" | jq -r '.success // false')"
if [[ "${clear_success}" != "true" ]]; then
  echo "[smoke-conversation-history-clear] clear endpoint returned non-success"
  echo "$clear_response"
  exit 1
fi
failed_count="$(echo "$clear_response" | jq -r '.data.failed_ids | length')"
if [[ "${failed_count}" != "0" ]]; then
  echo "[smoke-conversation-history-clear] clear endpoint reported failed ids"
  echo "$clear_response"
  exit 1
fi
deleted_has_a="$(echo "$clear_response" | jq -r --arg cid "$conversation_a" '.data.deleted_ids | index($cid) | if . == null then 0 else 1 end')"
deleted_has_b="$(echo "$clear_response" | jq -r --arg cid "$conversation_b" '.data.deleted_ids | index($cid) | if . == null then 0 else 1 end')"
if [[ "${deleted_has_a}" != "1" || "${deleted_has_b}" != "1" ]]; then
  echo "[smoke-conversation-history-clear] clear response missing deleted conversation ids"
  echo "$clear_response"
  exit 1
fi

listed_after="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/conversations")"
remaining_count="$(echo "$listed_after" | jq -r '.data | length')"
if [[ "${remaining_count}" != "0" ]]; then
  echo "[smoke-conversation-history-clear] expected zero conversations after clear"
  echo "$listed_after"
  exit 1
fi

clear_again_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -X POST "${BASE_URL}/api/conversations/clear" \
  -d '{}')"
clear_again_success="$(echo "$clear_again_response" | jq -r '.success // false')"
clear_again_deleted_count="$(echo "$clear_again_response" | jq -r '.data.deleted_ids | length')"
clear_again_failed_count="$(echo "$clear_again_response" | jq -r '.data.failed_ids | length')"
if [[ "${clear_again_success}" != "true" || "${clear_again_deleted_count}" != "0" || "${clear_again_failed_count}" != "0" ]]; then
  echo "[smoke-conversation-history-clear] second clear should be idempotent"
  echo "$clear_again_response"
  exit 1
fi

echo "[smoke-conversation-history-clear] PASS"
echo "cleared_ids_count=$(echo "$clear_response" | jq -r '.data.deleted_ids | length')"
echo "first_clear_failed_ids=${failed_count}"
echo "second_clear_deleted_ids=${clear_again_deleted_count}"
