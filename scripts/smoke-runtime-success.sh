#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_HOST="${API_HOST:-127.0.0.1}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-runtime-success] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-runtime-success] python3 is required."
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
if [[ -z "${RUNTIME_MOCK_PORT:-}" ]]; then
  RUNTIME_MOCK_PORT="$(
    python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
  )"
fi
RUNTIME_ENDPOINT="http://127.0.0.1:${RUNTIME_MOCK_PORT}/predict"
BASE_URL="http://${API_HOST}:${API_PORT}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
RUNTIME_LOG="$(mktemp)"
API_PID=""
RUNTIME_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi

  if [[ -n "$RUNTIME_PID" ]]; then
    kill "$RUNTIME_PID" >/dev/null 2>&1 || true
    wait "$RUNTIME_PID" >/dev/null 2>&1 || true
  fi

  rm -f "$COOKIE_FILE" "$API_LOG" "$RUNTIME_LOG"
}

trap cleanup EXIT

wait_inference_attachment_ready() {
  local attachment_id="$1"
  local files_resp=""
  local attachment_status=""

  for _ in $(seq 1 120); do
    files_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/files/inference")"
    attachment_status="$(echo "$files_resp" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"
    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi
    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-runtime-success] inference attachment entered error state"
      echo "$files_resp"
      exit 1
    fi
    sleep 0.2
  done

  echo "[smoke-runtime-success] inference attachment not ready in time"
  echo "$files_resp"
  exit 1
}

RUNTIME_MOCK_PORT="$RUNTIME_MOCK_PORT" npx tsx scripts/mockRuntimeServer.ts >"$RUNTIME_LOG" 2>&1 &
RUNTIME_PID=$!

for _ in $(seq 1 40); do
  if curl -sS "http://127.0.0.1:${RUNTIME_MOCK_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! kill -0 "$RUNTIME_PID" >/dev/null 2>&1; then
  echo "[smoke-runtime-success] Runtime mock process exited before health check (possible port conflict)"
  cat "$RUNTIME_LOG"
  exit 1
fi

if ! curl -sS "http://127.0.0.1:${RUNTIME_MOCK_PORT}/health" >/dev/null 2>&1; then
  echo "[smoke-runtime-success] Runtime mock server failed to start"
  cat "$RUNTIME_LOG"
  exit 1
fi

API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
PADDLEOCR_RUNTIME_ENDPOINT="$RUNTIME_ENDPOINT" \
DOCTR_RUNTIME_ENDPOINT="$RUNTIME_ENDPOINT" \
YOLO_RUNTIME_ENDPOINT="$RUNTIME_ENDPOINT" \
npm run dev:api >"$API_LOG" 2>&1 &
API_PID=$!

for _ in $(seq 1 40); do
  if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! kill -0 "$API_PID" >/dev/null 2>&1; then
  echo "[smoke-runtime-success] API process exited before health check (possible port conflict)"
  cat "$API_LOG"
  exit 1
fi

if ! curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-runtime-success] API failed to start"
  cat "$API_LOG"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-runtime-success] Failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

model_versions_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/model-versions")"
detection_model_version_id="$(echo "$model_versions_resp" | jq -r '.data[] | select(.task_type=="detection" and .status=="registered") | .id' | head -n 1)"
ocr_model_version_id="$(echo "$model_versions_resp" | jq -r '.data[] | select(.task_type=="ocr" and .framework=="paddleocr" and .status=="registered") | .id' | head -n 1)"
if [[ -z "$ocr_model_version_id" ]]; then
  ocr_model_version_id="$(echo "$model_versions_resp" | jq -r '.data[] | select(.task_type=="ocr" and .status=="registered") | .id' | head -n 1)"
fi
if [[ -z "$detection_model_version_id" || -z "$ocr_model_version_id" ]]; then
  echo "[smoke-runtime-success] required detection/ocr model versions not found"
  echo "$model_versions_resp"
  exit 1
fi

datasets_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets")"
ocr_dataset_id="$(echo "$datasets_resp" | jq -r '.data[] | select(.task_type=="ocr" and .status=="ready") | .id' | head -n 1)"
if [[ -z "$ocr_dataset_id" ]]; then
  ocr_dataset_id="$(echo "$datasets_resp" | jq -r '.data[] | select(.task_type=="ocr") | .id' | head -n 1)"
fi
if [[ -z "$ocr_dataset_id" ]]; then
  echo "[smoke-runtime-success] no OCR dataset found for docTR training"
  echo "$datasets_resp"
  exit 1
fi

ocr_versions_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${ocr_dataset_id}/versions")"
ocr_dataset_version_id="$(echo "$ocr_versions_resp" | jq -r '.data[] | select((.split_summary.train // 0) > 0 and (.annotation_coverage // 0) > 0) | .id' | head -n 1)"
if [[ -z "$ocr_dataset_version_id" ]]; then
  echo "[smoke-runtime-success] no trainable OCR dataset version found"
  echo "$ocr_versions_resp"
  exit 1
fi

detection_upload_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"filename\":\"runtime-success-detection-$(date +%s).jpg\"}" \
  "${BASE_URL}/api/files/inference/upload")"
detection_input_attachment_id="$(echo "$detection_upload_resp" | jq -r '.data.id // empty')"
if [[ -z "$detection_input_attachment_id" ]]; then
  echo "[smoke-runtime-success] failed to upload detection inference attachment"
  echo "$detection_upload_resp"
  exit 1
fi
wait_inference_attachment_ready "${detection_input_attachment_id}"

ocr_upload_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"filename\":\"runtime-success-ocr-$(date +%s).jpg\"}" \
  "${BASE_URL}/api/files/inference/upload")"
ocr_input_attachment_id="$(echo "$ocr_upload_resp" | jq -r '.data.id // empty')"
if [[ -z "$ocr_input_attachment_id" ]]; then
  echo "[smoke-runtime-success] failed to upload OCR inference attachment"
  echo "$ocr_upload_resp"
  exit 1
fi
wait_inference_attachment_ready "${ocr_input_attachment_id}"

yolo_inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${detection_input_attachment_id}\",\"task_type\":\"detection\"}" \
  "${BASE_URL}/api/inference/runs")"

yolo_source="$(echo "$yolo_inference_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
yolo_boxes="$(echo "$yolo_inference_result" | jq -r '.data.normalized_output.boxes | length // 0')"
yolo_fallback_reason="$(echo "$yolo_inference_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"

if [[ "$yolo_source" != "yolo_runtime" || "$yolo_boxes" -lt 1 || -n "$yolo_fallback_reason" ]]; then
  echo "[smoke-runtime-success] YOLO runtime success assertion failed"
  echo "$yolo_inference_result"
  exit 1
fi

paddle_inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_version_id\":\"${ocr_model_version_id}\",\"input_attachment_id\":\"${ocr_input_attachment_id}\",\"task_type\":\"ocr\"}" \
  "${BASE_URL}/api/inference/runs")"

paddle_source="$(echo "$paddle_inference_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
paddle_lines="$(echo "$paddle_inference_result" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
paddle_fallback_reason="$(echo "$paddle_inference_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"

if [[ "$paddle_source" != "paddleocr_runtime" || "$paddle_lines" -lt 1 || -n "$paddle_fallback_reason" ]]; then
  echo "[smoke-runtime-success] PaddleOCR runtime success assertion failed"
  echo "$paddle_inference_result"
  exit 1
fi

doctr_training_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"name\":\"doctr-runtime-success\",\"task_type\":\"ocr\",\"framework\":\"doctr\",\"dataset_id\":\"${ocr_dataset_id}\",\"dataset_version_id\":\"${ocr_dataset_version_id}\",\"base_model\":\"doctr-base\",\"config\":{\"epochs\":\"1\",\"batch_size\":\"1\"}}" \
  "${BASE_URL}/api/training/jobs")"

doctr_training_job_id="$(echo "$doctr_training_result" | jq -r '.data.id // empty')"
if [[ -z "$doctr_training_job_id" ]]; then
  echo "[smoke-runtime-success] docTR training creation failed"
  echo "$doctr_training_result"
  exit 1
fi

doctr_job_status=""
for _ in $(seq 1 50); do
  doctr_job_detail="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/training/jobs/${doctr_training_job_id}")"
  doctr_job_status="$(echo "$doctr_job_detail" | jq -r '.data.job.status // empty')"
  if [[ "$doctr_job_status" == "completed" ]]; then
    break
  fi
  sleep 0.2
done

if [[ "$doctr_job_status" != "completed" ]]; then
  echo "[smoke-runtime-success] docTR training job did not complete"
  echo "$doctr_job_detail"
  exit 1
fi

doctr_model_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"name":"doctr-runtime-success-model","description":"docTR runtime smoke model","model_type":"ocr","visibility":"workspace"}' \
  "${BASE_URL}/api/models/draft")"

doctr_model_id="$(echo "$doctr_model_result" | jq -r '.data.id // empty')"
if [[ -z "$doctr_model_id" ]]; then
  echo "[smoke-runtime-success] docTR model draft creation failed"
  echo "$doctr_model_result"
  exit 1
fi

doctr_register_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${doctr_model_id}\",\"training_job_id\":\"${doctr_training_job_id}\",\"version_name\":\"doctr-runtime-v1\"}" \
  "${BASE_URL}/api/model-versions/register")"

doctr_model_version_id="$(echo "$doctr_register_result" | jq -r '.data.id // empty')"
if [[ -z "$doctr_model_version_id" ]]; then
  echo "[smoke-runtime-success] docTR model version registration failed"
  echo "$doctr_register_result"
  exit 1
fi

doctr_inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_version_id\":\"${doctr_model_version_id}\",\"input_attachment_id\":\"${ocr_input_attachment_id}\",\"task_type\":\"ocr\"}" \
  "${BASE_URL}/api/inference/runs")"

doctr_source="$(echo "$doctr_inference_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
doctr_lines="$(echo "$doctr_inference_result" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
doctr_fallback_reason="$(echo "$doctr_inference_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"

if [[ "$doctr_source" != "doctr_runtime" || "$doctr_lines" -lt 1 || -n "$doctr_fallback_reason" ]]; then
  echo "[smoke-runtime-success] docTR runtime success assertion failed"
  echo "$doctr_inference_result"
  exit 1
fi

echo "[smoke-runtime-success] PASS"
echo "runtime_endpoint=${RUNTIME_ENDPOINT}"
echo "yolo_source=${yolo_source}"
echo "paddle_source=${paddle_source}"
echo "doctr_source=${doctr_source}"
echo "doctr_training_job_id=${doctr_training_job_id}"
echo "doctr_model_version_id=${doctr_model_version_id}"
