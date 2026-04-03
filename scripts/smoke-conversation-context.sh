#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-8796}"
BASE_URL="http://127.0.0.1:${API_PORT}"
COOKIE_FILE="$(mktemp)"
LOG_FILE="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_FILE" "$LOG_FILE"
}
trap cleanup EXIT

API_PORT="$API_PORT" npm run dev:api >"$LOG_FILE" 2>&1 &
API_PID=$!

for _ in $(seq 1 40); do
  if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-conversation-context] API failed to start"
  cat "$LOG_FILE"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-conversation-context] Failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

# Upload three attachments via compatibility path.
upload_1="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"filename":"context-a.txt"}' \
  "${BASE_URL}/api/files/conversation/upload")"
upload_2="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"filename":"context-b.txt"}' \
  "${BASE_URL}/api/files/conversation/upload")"
upload_3="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"filename":"context-c.txt"}' \
  "${BASE_URL}/api/files/conversation/upload")"

attachment_a="$(echo "$upload_1" | jq -r '.data.id // empty')"
attachment_b="$(echo "$upload_2" | jq -r '.data.id // empty')"
attachment_c="$(echo "$upload_3" | jq -r '.data.id // empty')"

if [[ -z "$attachment_a" || -z "$attachment_b" || -z "$attachment_c" ]]; then
  echo "[smoke-conversation-context] Attachment upload failed"
  echo "$upload_1"
  echo "$upload_2"
  echo "$upload_3"
  exit 1
fi

for _ in $(seq 1 20); do
  statuses="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/files/conversation" | jq -r --arg A "$attachment_a" --arg B "$attachment_b" --arg C "$attachment_c" '
    [.data[] | select(.id==$A or .id==$B or .id==$C) | .status] | join(",")')"
  if [[ "$statuses" == *"ready"* ]]; then
    all_ready_count="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/files/conversation" | jq -r --arg A "$attachment_a" --arg B "$attachment_b" --arg C "$attachment_c" '
      [.data[] | select((.id==$A or .id==$B or .id==$C) and .status=="ready")] | length')"
    if [[ "$all_ready_count" == "3" ]]; then
      break
    fi
  fi
  sleep 0.2
done

ready_count="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/files/conversation" | jq -r --arg A "$attachment_a" --arg B "$attachment_b" --arg C "$attachment_c" '
  [.data[] | select((.id==$A or .id==$B or .id==$C) and .status=="ready")] | length')"
if [[ "$ready_count" != "3" ]]; then
  echo "[smoke-conversation-context] Uploaded attachments did not all reach ready"
  exit 1
fi

model_id="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/models" | jq -r '.data[0].id // empty')"
if [[ -z "$model_id" ]]; then
  echo "[smoke-conversation-context] No visible model found"
  exit 1
fi

start_payload="$(cat <<JSON
{
  "model_id": "$model_id",
  "initial_message": "context ordering start",
  "attachment_ids": ["$attachment_c", "$attachment_a", "$attachment_b"]
}
JSON
)"

started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$start_payload" \
  "${BASE_URL}/api/conversations/start")"

conversation_id="$(echo "$started" | jq -r '.data.conversation.id // empty')"
first_user_ids="$(echo "$started" | jq -c '.data.messages[] | select(.sender=="user") | .attachment_ids')"
expected_first="[\"${attachment_c}\",\"${attachment_a}\",\"${attachment_b}\"]"
if [[ "$first_user_ids" != "$expected_first" ]]; then
  echo "[smoke-conversation-context] Start message attachment order mismatch"
  echo "expected=$expected_first"
  echo "actual=$first_user_ids"
  exit 1
fi

send_payload="$(cat <<JSON
{
  "conversation_id": "$conversation_id",
  "content": "context ordering followup",
  "attachment_ids": ["$attachment_b", "$attachment_c"]
}
JSON
)"

sent="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$send_payload" \
  "${BASE_URL}/api/conversations/message")"

last_user_ids="$(echo "$sent" | jq -c '[.data.messages[] | select(.sender=="user")][-1].attachment_ids')"
expected_last="[\"${attachment_b}\",\"${attachment_c}\"]"
if [[ "$last_user_ids" != "$expected_last" ]]; then
  echo "[smoke-conversation-context] Follow-up message attachment order mismatch"
  echo "expected=$expected_last"
  echo "actual=$last_user_ids"
  exit 1
fi

echo "[smoke-conversation-context] PASS"
echo "conversation_id=${conversation_id}"
echo "start_order=${first_user_ids}"
echo "followup_order=${last_user_ids}"
