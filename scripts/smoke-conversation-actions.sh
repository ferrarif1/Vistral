#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-8795}"
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

for _ in $(seq 1 50); do
  if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-conversation-actions] API failed to start"
  cat "$LOG_FILE"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-conversation-actions] Failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

model_id="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/models" | jq -r '.data[0].id // empty')"
if [[ -z "$model_id" ]]; then
  echo "[smoke-conversation-actions] No visible model found"
  exit 1
fi

dataset_name="conversation-smoke-dataset-$(date +%s)"
dataset_started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${model_id}\",\"initial_message\":\"帮我创建一个检测数据集，名字叫${dataset_name}\",\"attachment_ids\":[]}" \
  "${BASE_URL}/api/conversations/start")"

dataset_action="$(echo "$dataset_started" | jq -r '.data.messages[1].metadata.conversation_action.action // empty')"
dataset_status="$(echo "$dataset_started" | jq -r '.data.messages[1].metadata.conversation_action.status // empty')"
dataset_id="$(echo "$dataset_started" | jq -r '.data.messages[1].metadata.conversation_action.created_entity_id // empty')"

if [[ "$dataset_action" != "create_dataset" || "$dataset_status" != "completed" || -z "$dataset_id" ]]; then
  echo "[smoke-conversation-actions] Dataset conversation action failed"
  echo "$dataset_started"
  exit 1
fi

model_name="conversation-smoke-model-$(date +%s)"
model_started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${model_id}\",\"initial_message\":\"帮我创建一个OCR模型草稿，名字叫${model_name}\",\"attachment_ids\":[]}" \
  "${BASE_URL}/api/conversations/start")"

model_action="$(echo "$model_started" | jq -r '.data.messages[1].metadata.conversation_action.action // empty')"
model_status="$(echo "$model_started" | jq -r '.data.messages[1].metadata.conversation_action.status // empty')"
model_draft_id="$(echo "$model_started" | jq -r '.data.messages[1].metadata.conversation_action.created_entity_id // empty')"

if [[ "$model_action" != "create_model_draft" || "$model_status" != "completed" || -z "$model_draft_id" ]]; then
  echo "[smoke-conversation-actions] Model-draft conversation action failed"
  echo "$model_started"
  exit 1
fi

job_name="conversation-smoke-job-$(date +%s)"
training_started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${model_id}\",\"initial_message\":\"帮我创建一个检测训练任务，名字叫${job_name}\",\"attachment_ids\":[]}" \
  "${BASE_URL}/api/conversations/start")"

training_conversation_id="$(echo "$training_started" | jq -r '.data.conversation.id // empty')"
training_action="$(echo "$training_started" | jq -r '.data.messages[1].metadata.conversation_action.action // empty')"
training_status="$(echo "$training_started" | jq -r '.data.messages[1].metadata.conversation_action.status // empty')"
training_missing_dataset="$(echo "$training_started" | jq -r '.data.messages[1].metadata.conversation_action.missing_fields[]? | select(.=="dataset_id")')"

if [[ "$training_action" != "create_training_job" || "$training_status" != "requires_input" || "$training_missing_dataset" != "dataset_id" ]]; then
  echo "[smoke-conversation-actions] Training conversation action did not request dataset input"
  echo "$training_started"
  exit 1
fi

training_followup="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"conversation_id\":\"${training_conversation_id}\",\"content\":\"用数据集 ${dataset_id}\",\"attachment_ids\":[]}" \
  "${BASE_URL}/api/conversations/message")"

training_final_status="$(echo "$training_followup" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
training_job_id="$(echo "$training_followup" | jq -r '.data.messages[-1].metadata.conversation_action.created_entity_id // empty')"
training_dataset_id="$(echo "$training_followup" | jq -r '.data.messages[-1].metadata.conversation_action.collected_fields.dataset_id // empty')"

if [[ "$training_final_status" != "completed" || -z "$training_job_id" || "$training_dataset_id" != "$dataset_id" ]]; then
  echo "[smoke-conversation-actions] Training conversation completion failed"
  echo "$training_followup"
  exit 1
fi

job_exists="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/training/jobs" | jq -r --arg JOB_ID "$training_job_id" '[.data[] | select(.id==$JOB_ID)] | length')"
if [[ "$job_exists" != "1" ]]; then
  echo "[smoke-conversation-actions] Created training job not visible in training jobs list"
  exit 1
fi

echo "[smoke-conversation-actions] PASS"
echo "dataset_id=${dataset_id}"
echo "model_draft_id=${model_draft_id}"
echo "training_job_id=${training_job_id}"
