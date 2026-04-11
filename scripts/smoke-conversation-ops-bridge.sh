#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-conversation-ops-bridge] jq is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8799}"
BASE_URL="http://${API_HOST}:${API_PORT}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_FILE" "$API_LOG"
}
trap cleanup EXIT

API_PORT="$API_PORT" npm run dev:api >"$API_LOG" 2>&1 &
API_PID=$!

for _ in $(seq 1 80); do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-conversation-ops-bridge] API failed to start"
  cat "$API_LOG"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-conversation-ops-bridge] failed to get csrf token"
  echo "$csrf_payload"
  exit 1
fi

start_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"model_id":"m-2","initial_message":"hi","attachment_ids":[]}' \
  "${BASE_URL}/api/conversations/start")"
conversation_id="$(echo "$start_payload" | jq -r '.data.conversation.id // empty')"
if [[ -z "$conversation_id" ]]; then
  echo "[smoke-conversation-ops-bridge] failed to start conversation"
  echo "$start_payload"
  exit 1
fi

send_message() {
  local content="$1"
  curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d "$(jq -nc --arg cid "$conversation_id" --arg c "$content" '{conversation_id:$cid,content:$c,attachment_ids:[]}')" \
    "${BASE_URL}/api/conversations/message"
}

msg_read="$(send_message "帮我查看训练任务")"
read_action="$(echo "$msg_read" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
read_status="$(echo "$msg_read" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
if [[ "$read_action" != "console_api_call" || "$read_status" != "completed" ]]; then
  echo "[smoke-conversation-ops-bridge] expected list-training-jobs action completed"
  echo "$msg_read"
  exit 1
fi

msg_missing="$(send_message "取消训练任务")"
missing_status="$(echo "$msg_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
missing_fields="$(echo "$msg_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
if [[ "$missing_status" != "requires_input" || "$missing_fields" != *"job_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected missing job_id"
  echo "$msg_missing"
  exit 1
fi

msg_fill="$(send_message "tj-det-1")"
fill_status="$(echo "$msg_fill" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
fill_requires_confirm="$(echo "$msg_fill" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
fill_missing="$(echo "$msg_fill" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
if [[ "$fill_status" != "requires_input" || "$fill_requires_confirm" != "true" || "$fill_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation requirement after filling job_id"
  echo "$msg_fill"
  exit 1
fi

msg_confirm="$(send_message "确认执行")"
confirm_action="$(echo "$msg_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
confirm_status="$(echo "$msg_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
if [[ "$confirm_action" != "console_api_call" ]]; then
  echo "[smoke-conversation-ops-bridge] expected console_api_call after confirmation"
  echo "$msg_confirm"
  exit 1
fi
if [[ "$confirm_status" != "completed" && "$confirm_status" != "failed" ]]; then
  echo "[smoke-conversation-ops-bridge] expected terminal status after confirmation"
  echo "$msg_confirm"
  exit 1
fi

msg_export_missing="$(send_message "导出标注")"
export_status="$(echo "$msg_export_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
export_missing="$(echo "$msg_export_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
if [[ "$export_status" != "requires_input" || "$export_missing" != *"dataset_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected missing dataset_id on export"
  echo "$msg_export_missing"
  exit 1
fi

echo "[smoke-conversation-ops-bridge] PASS"
