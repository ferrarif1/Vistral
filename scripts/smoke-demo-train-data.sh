#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-8799}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${API_PORT}}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
DEMO_DIR="${DEMO_DIR:-${ROOT_DIR}/demo_data/train}"
MAX_FILES="${MAX_FILES:-0}"
WAIT_TIMEOUT_SEC="${WAIT_TIMEOUT_SEC:-90}"
TRAIN_RATIO="${TRAIN_RATIO:-0.8}"
VAL_RATIO="${VAL_RATIO:-0.1}"
TEST_RATIO="${TEST_RATIO:-0.1}"
SPLIT_SEED="${SPLIT_SEED:-42}"
VERSION_NAME="${VERSION_NAME:-demo-train-v1}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-demo-train-data] jq is required but not found"
  exit 1
fi

if [[ ! -d "$DEMO_DIR" ]]; then
  echo "[smoke-demo-train-data] demo dir not found: ${DEMO_DIR}"
  exit 1
fi

if ! [[ "$MAX_FILES" =~ ^[0-9]+$ ]]; then
  echo "[smoke-demo-train-data] MAX_FILES must be a non-negative integer"
  exit 1
fi

if ! [[ "$WAIT_TIMEOUT_SEC" =~ ^[0-9]+$ ]]; then
  echo "[smoke-demo-train-data] WAIT_TIMEOUT_SEC must be a non-negative integer"
  exit 1
fi

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

if [[ "$START_API" == "true" ]]; then
  API_PORT="${API_PORT}" \
  PADDLEOCR_RUNTIME_ENDPOINT="http://127.0.0.1:9/unreachable" \
  DOCTR_RUNTIME_ENDPOINT="http://127.0.0.1:9/unreachable" \
  YOLO_RUNTIME_ENDPOINT="http://127.0.0.1:9/unreachable" \
  npm run dev:api >"$API_LOG" 2>&1 &
  API_PID=$!

  for _ in $(seq 1 50); do
    if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done

  if ! curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    echo "[smoke-demo-train-data] API failed to start"
    cat "$API_LOG"
    exit 1
  fi
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-demo-train-data] Failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

if [[ -n "$AUTH_USERNAME" ]]; then
  if [[ -z "$AUTH_PASSWORD" ]]; then
    echo "[smoke-demo-train-data] AUTH_PASSWORD is required when AUTH_USERNAME is set"
    exit 1
  fi

  login_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "$login_response" | jq -r '.success // false')"
  if [[ "$login_success" != "true" ]]; then
    echo "[smoke-demo-train-data] login failed for AUTH_USERNAME=${AUTH_USERNAME}"
    echo "$login_response"
    exit 1
  fi

  csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
  if [[ -z "$csrf_token" ]]; then
    echo "[smoke-demo-train-data] Failed to refresh CSRF token after login"
    echo "$csrf_payload"
    exit 1
  fi
fi

mapfile -t image_paths < <(find "$DEMO_DIR" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | sort)

if [[ "${#image_paths[@]}" -eq 0 ]]; then
  echo "[smoke-demo-train-data] no image files found in ${DEMO_DIR}"
  exit 1
fi

if (( MAX_FILES > 0 && ${#image_paths[@]} > MAX_FILES )); then
  image_paths=("${image_paths[@]:0:MAX_FILES}")
fi

total_files="${#image_paths[@]}"
dataset_name="Demo Train Dataset $(date +%Y%m%d-%H%M%S)"

create_dataset_payload="$(jq -nc \
  --arg name "$dataset_name" \
  --arg description "Imported from ${DEMO_DIR}" \
  '{
    name: $name,
    description: $description,
    task_type: "detection",
    label_schema: { classes: ["train"] }
  }'
)"

created_dataset="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$create_dataset_payload" \
  "${BASE_URL}/api/datasets")"

dataset_id="$(echo "$created_dataset" | jq -r '.data.id // empty')"
if [[ -z "$dataset_id" ]]; then
  echo "[smoke-demo-train-data] Dataset creation failed"
  echo "$created_dataset"
  exit 1
fi

echo "[smoke-demo-train-data] dataset created: ${dataset_id}"
echo "[smoke-demo-train-data] uploading ${total_files} files from ${DEMO_DIR}"

uploaded_count=0
upload_fail_count=0

for image_path in "${image_paths[@]}"; do
  filename="$(basename "$image_path")"
  upload_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H "x-csrf-token: $csrf_token" \
    -F "file=@${image_path};filename=${filename}" \
    "${BASE_URL}/api/files/dataset/${dataset_id}/upload")"

  attachment_id="$(echo "$upload_response" | jq -r '.data.id // empty')"
  if [[ -z "$attachment_id" ]]; then
    upload_fail_count=$((upload_fail_count + 1))
    echo "[smoke-demo-train-data] upload failed for ${filename}"
    continue
  fi

  uploaded_count=$((uploaded_count + 1))
  if (( uploaded_count % 50 == 0 )); then
    echo "[smoke-demo-train-data] uploaded ${uploaded_count}/${total_files}"
  fi
done

if (( uploaded_count == 0 )); then
  echo "[smoke-demo-train-data] no files were uploaded successfully"
  exit 1
fi

if (( upload_fail_count > 0 )); then
  echo "[smoke-demo-train-data] failed to submit ${upload_fail_count} uploads"
  exit 1
fi

ready_count=0
error_count=0
pending_count="$uploaded_count"
deadline=$((SECONDS + WAIT_TIMEOUT_SEC))

while (( SECONDS <= deadline )); do
  attachments_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    "${BASE_URL}/api/files/dataset/${dataset_id}")"

  ready_count="$(echo "$attachments_response" | jq -r '[.data[] | select(.status == "ready")] | length')"
  error_count="$(echo "$attachments_response" | jq -r '[.data[] | select(.status == "error")] | length')"
  pending_count=$((uploaded_count - ready_count - error_count))

  if (( pending_count <= 0 )); then
    break
  fi
  sleep 0.3
done

if (( pending_count > 0 )); then
  echo "[smoke-demo-train-data] timeout waiting attachment lifecycle completion"
  echo "pending_count=${pending_count}"
  exit 1
fi

if (( error_count > 0 )); then
  echo "[smoke-demo-train-data] some attachments ended in error"
  echo "error_count=${error_count}"
  exit 1
fi

split_payload="$(jq -nc \
  --argjson train "$TRAIN_RATIO" \
  --argjson val "$VAL_RATIO" \
  --argjson test "$TEST_RATIO" \
  --argjson seed "$SPLIT_SEED" \
  '{ train_ratio: $train, val_ratio: $val, test_ratio: $test, seed: $seed }'
)"

split_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$split_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/split")"

split_train="$(echo "$split_response" | jq -r '.data.split_summary.train // 0')"
split_val="$(echo "$split_response" | jq -r '.data.split_summary.val // 0')"
split_test="$(echo "$split_response" | jq -r '.data.split_summary.test // 0')"
split_unassigned="$(echo "$split_response" | jq -r '.data.split_summary.unassigned // 0')"

version_payload="$(jq -nc --arg version_name "$VERSION_NAME" '{ version_name: $version_name }')"
version_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$version_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/versions")"

dataset_version_id="$(echo "$version_response" | jq -r '.data.id // empty')"
if [[ -z "$dataset_version_id" ]]; then
  echo "[smoke-demo-train-data] dataset version creation failed"
  echo "$version_response"
  exit 1
fi

items_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  "${BASE_URL}/api/datasets/${dataset_id}/items")"
item_count="$(echo "$items_response" | jq -r '.data | length')"
ready_item_count="$(echo "$items_response" | jq -r '[.data[] | select(.status == "ready")] | length')"

echo "[smoke-demo-train-data] PASS"
echo "dataset_id=${dataset_id}"
echo "dataset_name=${dataset_name}"
echo "dataset_version_id=${dataset_version_id}"
echo "source_dir=${DEMO_DIR}"
echo "uploaded_files=${uploaded_count}"
echo "ready_attachments=${ready_count}"
echo "error_attachments=${error_count}"
echo "dataset_items=${item_count}"
echo "ready_items=${ready_item_count}"
echo "split_train=${split_train}"
echo "split_val=${split_val}"
echo "split_test=${split_test}"
echo "split_unassigned=${split_unassigned}"
