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
read_first_link="$(echo "$msg_read" | jq -r '.data.messages[-1].metadata.conversation_action.action_links[0].href // empty')"
if [[ "$read_action" != "console_api_call" || "$read_status" != "completed" ]]; then
  echo "[smoke-conversation-ops-bridge] expected list-training-jobs action completed"
  echo "$msg_read"
  exit 1
fi
if [[ "$read_first_link" != "/training/jobs" ]]; then
  echo "[smoke-conversation-ops-bridge] expected training-jobs action link on list_training_jobs"
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
fill_confirmation_phrase="$(echo "$msg_fill" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$fill_status" != "requires_input" || "$fill_requires_confirm" != "true" || "$fill_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation requirement after filling job_id"
  echo "$msg_fill"
  exit 1
fi
if [[ -z "$fill_confirmation_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation phrase for high-risk API"
  echo "$msg_fill"
  exit 1
fi

msg_wrong_confirm="$(send_message "yes, execute")"
wrong_confirm_status="$(echo "$msg_wrong_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
wrong_confirm_missing="$(echo "$msg_wrong_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
if [[ "$wrong_confirm_status" != "requires_input" || "$wrong_confirm_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected strict confirmation phrase guard before execution"
  echo "$msg_wrong_confirm"
  exit 1
fi

msg_confirm="$(send_message "$fill_confirmation_phrase")"
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
export_first_link="$(echo "$msg_export_missing" | jq -r '.data.messages[-1].metadata.conversation_action.action_links[0].href // empty')"
if [[ "$export_status" != "requires_input" || "$export_missing" != *"dataset_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected missing dataset_id on export"
  echo "$msg_export_missing"
  exit 1
fi
if [[ "$export_first_link" != "/datasets" ]]; then
  echo "[smoke-conversation-ops-bridge] expected dataset action link on export missing-card"
  echo "$msg_export_missing"
  exit 1
fi

msg_review_missing="$(send_message "审核标注通过")"
review_missing_status="$(echo "$msg_review_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
review_missing_fields="$(echo "$msg_review_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
review_first_link="$(echo "$msg_review_missing" | jq -r '.data.messages[-1].metadata.conversation_action.action_links[0].href // empty')"
if [[ "$review_missing_status" != "requires_input" || "$review_missing_fields" != *"annotation_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected intent switch and missing annotation_id for review"
  echo "$msg_review_missing"
  exit 1
fi
if [[ "$review_first_link" != "/datasets" ]]; then
  echo "[smoke-conversation-ops-bridge] expected dataset action link on review missing-card"
  echo "$msg_review_missing"
  exit 1
fi

msg_review_fill="$(send_message "ann-1")"
review_fill_status="$(echo "$msg_review_fill" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
review_fill_requires_confirm="$(echo "$msg_review_fill" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
review_fill_missing="$(echo "$msg_review_fill" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
review_confirmation_phrase="$(echo "$msg_review_fill" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$review_fill_status" != "requires_input" || "$review_fill_requires_confirm" != "true" || "$review_fill_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation requirement after filling annotation_id"
  echo "$msg_review_fill"
  exit 1
fi
if [[ -z "$review_confirmation_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation phrase for review high-risk API"
  echo "$msg_review_fill"
  exit 1
fi

msg_review_confirm="$(send_message "$review_confirmation_phrase")"
review_confirm_action="$(echo "$msg_review_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
review_confirm_status="$(echo "$msg_review_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
if [[ "$review_confirm_action" != "console_api_call" ]]; then
  echo "[smoke-conversation-ops-bridge] expected console_api_call after review confirmation"
  echo "$msg_review_confirm"
  exit 1
fi
if [[ "$review_confirm_status" != "completed" && "$review_confirm_status" != "failed" ]]; then
  echo "[smoke-conversation-ops-bridge] expected terminal review status after confirmation"
  echo "$msg_review_confirm"
  exit 1
fi

echo "[smoke-conversation-ops-bridge] PASS"
