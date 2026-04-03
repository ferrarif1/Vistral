#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-8798}"
BASE_URL="http://127.0.0.1:${API_PORT}"
COOKIE_FILE="$(mktemp)"
LOG_FILE="$(mktemp)"
CONV_UPLOAD="$(mktemp)"
CONV_DOWNLOAD="$(mktemp)"
MODEL_UPLOAD="$(mktemp)"
MODEL_DOWNLOAD="$(mktemp)"
DATASET_UPLOAD="$(mktemp)"
DATASET_DOWNLOAD="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -f \
    "$COOKIE_FILE" \
    "$LOG_FILE" \
    "$CONV_UPLOAD" \
    "$CONV_DOWNLOAD" \
    "$MODEL_UPLOAD" \
    "$MODEL_DOWNLOAD" \
    "$DATASET_UPLOAD" \
    "$DATASET_DOWNLOAD"
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
  echo "[smoke-attachments] API failed to start"
  cat "$LOG_FILE"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-attachments] Failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

# Conversation multipart upload + content read + delete cleanup check.
printf 'conversation multipart payload\n' >"$CONV_UPLOAD"
conversation_upload_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H "x-csrf-token: $csrf_token" \
  -F "file=@${CONV_UPLOAD};type=text/plain;filename=conversation-smoke.txt" \
  "${BASE_URL}/api/files/conversation/upload")"
conversation_attachment_id="$(echo "$conversation_upload_payload" | jq -r '.data.id // empty')"
if [[ -z "$conversation_attachment_id" ]]; then
  echo "[smoke-attachments] Conversation upload failed"
  echo "$conversation_upload_payload"
  exit 1
fi

conversation_status=""
for _ in $(seq 1 20); do
  conversation_status="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    "${BASE_URL}/api/files/conversation" | jq -r --arg ID "$conversation_attachment_id" '.data[] | select(.id==$ID) | .status // empty')"
  if [[ "$conversation_status" == "ready" ]]; then
    break
  fi
  sleep 0.2
done

if [[ "$conversation_status" != "ready" ]]; then
  echo "[smoke-attachments] Conversation attachment did not reach ready"
  exit 1
fi

curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  "${BASE_URL}/api/files/${conversation_attachment_id}/content" -o "$CONV_DOWNLOAD"
cmp "$CONV_UPLOAD" "$CONV_DOWNLOAD" >/dev/null

curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H "x-csrf-token: $csrf_token" \
  -X DELETE "${BASE_URL}/api/files/${conversation_attachment_id}" >/dev/null

deleted_read_status="$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  "${BASE_URL}/api/files/${conversation_attachment_id}/content")"
if [[ "$deleted_read_status" != "404" ]]; then
  echo "[smoke-attachments] Deleted conversation file should return 404, got ${deleted_read_status}"
  exit 1
fi

# Model multipart upload + content read.
model_id="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/models/my" | jq -r '.data[0].id // empty')"
if [[ -z "$model_id" ]]; then
  echo "[smoke-attachments] No model available for model upload test"
  exit 1
fi

printf 'model multipart payload\n' >"$MODEL_UPLOAD"
model_upload_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H "x-csrf-token: $csrf_token" \
  -F "file=@${MODEL_UPLOAD};type=application/octet-stream;filename=model-smoke.bin" \
  "${BASE_URL}/api/files/model/${model_id}/upload")"
model_attachment_id="$(echo "$model_upload_payload" | jq -r '.data.id // empty')"
if [[ -z "$model_attachment_id" ]]; then
  echo "[smoke-attachments] Model upload failed"
  echo "$model_upload_payload"
  exit 1
fi

model_status=""
for _ in $(seq 1 20); do
  model_status="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    "${BASE_URL}/api/files/model/${model_id}" | jq -r --arg ID "$model_attachment_id" '.data[] | select(.id==$ID) | .status // empty')"
  if [[ "$model_status" == "ready" ]]; then
    break
  fi
  sleep 0.2
done

if [[ "$model_status" != "ready" ]]; then
  echo "[smoke-attachments] Model attachment did not reach ready"
  exit 1
fi

curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  "${BASE_URL}/api/files/${model_attachment_id}/content" -o "$MODEL_DOWNLOAD"
cmp "$MODEL_UPLOAD" "$MODEL_DOWNLOAD" >/dev/null

# Dataset multipart upload + content read.
create_dataset_payload='{"name":"attachment-smoke-dataset","description":"multipart dataset upload check","task_type":"detection","label_schema":{"classes":["defect"]}}'
created_dataset="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$create_dataset_payload" \
  "${BASE_URL}/api/datasets")"
dataset_id="$(echo "$created_dataset" | jq -r '.data.id // empty')"
if [[ -z "$dataset_id" ]]; then
  echo "[smoke-attachments] Dataset creation failed"
  echo "$created_dataset"
  exit 1
fi

printf 'dataset multipart payload\n' >"$DATASET_UPLOAD"
dataset_upload_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H "x-csrf-token: $csrf_token" \
  -F "file=@${DATASET_UPLOAD};type=application/octet-stream;filename=dataset-smoke.bin" \
  "${BASE_URL}/api/files/dataset/${dataset_id}/upload")"
dataset_attachment_id="$(echo "$dataset_upload_payload" | jq -r '.data.id // empty')"
if [[ -z "$dataset_attachment_id" ]]; then
  echo "[smoke-attachments] Dataset upload failed"
  echo "$dataset_upload_payload"
  exit 1
fi

dataset_status=""
for _ in $(seq 1 20); do
  dataset_status="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    "${BASE_URL}/api/files/dataset/${dataset_id}" | jq -r --arg ID "$dataset_attachment_id" '.data[] | select(.id==$ID) | .status // empty')"
  if [[ "$dataset_status" == "ready" ]]; then
    break
  fi
  sleep 0.2
done

if [[ "$dataset_status" != "ready" ]]; then
  echo "[smoke-attachments] Dataset attachment did not reach ready"
  exit 1
fi

curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  "${BASE_URL}/api/files/${dataset_attachment_id}/content" -o "$DATASET_DOWNLOAD"
cmp "$DATASET_UPLOAD" "$DATASET_DOWNLOAD" >/dev/null

echo "[smoke-attachments] PASS"
echo "conversation_attachment_id=${conversation_attachment_id}"
echo "model_attachment_id=${model_attachment_id}"
echo "dataset_attachment_id=${dataset_attachment_id}"
