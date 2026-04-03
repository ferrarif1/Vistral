#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-8798}"
RUNTIME_MOCK_PORT="${RUNTIME_MOCK_PORT:-9393}"
RUNTIME_ENDPOINT="http://127.0.0.1:${RUNTIME_MOCK_PORT}/predict"
BASE_URL="http://127.0.0.1:${API_PORT}"

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

RUNTIME_MOCK_PORT="$RUNTIME_MOCK_PORT" npx tsx scripts/mockRuntimeServer.ts >"$RUNTIME_LOG" 2>&1 &
RUNTIME_PID=$!

for _ in $(seq 1 40); do
  if curl -sS "http://127.0.0.1:${RUNTIME_MOCK_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! curl -sS "http://127.0.0.1:${RUNTIME_MOCK_PORT}/health" >/dev/null 2>&1; then
  echo "[smoke-runtime-success] Runtime mock server failed to start"
  cat "$RUNTIME_LOG"
  exit 1
fi

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

yolo_inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"model_version_id":"mv-2","input_attachment_id":"f-1","task_type":"detection"}' \
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
  -d '{"model_version_id":"mv-1","input_attachment_id":"f-3","task_type":"ocr"}' \
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
  -d '{"name":"doctr-runtime-success","task_type":"ocr","framework":"doctr","dataset_id":"d-1","dataset_version_id":"dv-1","base_model":"doctr-base","config":{"epochs":"1","batch_size":"1"}}' \
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

doctr_register_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"m-3\",\"training_job_id\":\"${doctr_training_job_id}\",\"version_name\":\"doctr-runtime-v1\"}" \
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
  -d "{\"model_version_id\":\"${doctr_model_version_id}\",\"input_attachment_id\":\"f-3\",\"task_type\":\"ocr\"}" \
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
