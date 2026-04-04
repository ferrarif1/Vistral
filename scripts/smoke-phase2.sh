#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-8797}"
BASE_URL="http://127.0.0.1:${API_PORT}"
PADDLEOCR_RUNTIME_ENDPOINT_FOR_SMOKE="${PADDLEOCR_RUNTIME_ENDPOINT_FOR_SMOKE:-http://127.0.0.1:9/unreachable}"
DOCTR_RUNTIME_ENDPOINT_FOR_SMOKE="${DOCTR_RUNTIME_ENDPOINT_FOR_SMOKE:-http://127.0.0.1:9/unreachable}"
YOLO_RUNTIME_ENDPOINT_FOR_SMOKE="${YOLO_RUNTIME_ENDPOINT_FOR_SMOKE:-http://127.0.0.1:9/unreachable}"

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

API_PORT="${API_PORT}" \
PADDLEOCR_RUNTIME_ENDPOINT="${PADDLEOCR_RUNTIME_ENDPOINT_FOR_SMOKE}" \
DOCTR_RUNTIME_ENDPOINT="${DOCTR_RUNTIME_ENDPOINT_FOR_SMOKE}" \
YOLO_RUNTIME_ENDPOINT="${YOLO_RUNTIME_ENDPOINT_FOR_SMOKE}" \
npm run dev:api >"$LOG_FILE" 2>&1 &
API_PID=$!

for _ in $(seq 1 30); do
  if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-phase2] API failed to start"
  cat "$LOG_FILE"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-phase2] Failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

create_dataset_payload='{"name":"Segmentation Smoke","description":"seg workflow smoke","task_type":"segmentation","label_schema":{"classes":["region"]}}'
created_dataset="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$create_dataset_payload" \
  "${BASE_URL}/api/datasets")"

dataset_id="$(echo "$created_dataset" | jq -r '.data.id // empty')"
if [[ -z "$dataset_id" ]]; then
  echo "[smoke-phase2] Dataset creation failed"
  echo "$created_dataset"
  exit 1
fi

upload_attachment="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"filename":"seg-smoke-image.png"}' \
  "${BASE_URL}/api/files/dataset/${dataset_id}/upload")"

attachment_id="$(echo "$upload_attachment" | jq -r '.data.id // empty')"
if [[ -z "$attachment_id" ]]; then
  echo "[smoke-phase2] Dataset file upload failed"
  echo "$upload_attachment"
  exit 1
fi

sleep 1.6

dataset_detail="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}")"
dataset_item_id="$(echo "$dataset_detail" | jq -r '.data.items[0].id // empty')"

if [[ -z "$dataset_item_id" ]]; then
  echo "[smoke-phase2] Dataset item was not generated"
  echo "$dataset_detail"
  exit 1
fi

annotation_payload="$(cat <<JSON
{
  "dataset_item_id": "$dataset_item_id",
  "task_type": "segmentation",
  "source": "manual",
  "status": "annotated",
  "payload": {
    "boxes": [
      {"id":"box-1","x":40,"y":55,"width":120,"height":95,"label":"region-1"}
    ],
    "polygons": [
      {"id":"poly-1","label":"region-1","points":[{"x":50,"y":60},{"x":180,"y":65},{"x":170,"y":145},{"x":60,"y":150}]}
    ]
  }
}
JSON
)"

upsert_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$annotation_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations")"

saved_status="$(echo "$upsert_result" | jq -r '.data.status // empty')"
if [[ "$saved_status" != "annotated" ]]; then
  echo "[smoke-phase2] Annotation upsert did not reach expected status"
  echo "$upsert_result"
  exit 1
fi

annotations_list="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
polygon_count="$(echo "$annotations_list" | jq -r '.data[0].payload.polygons | length // 0')"
if [[ "$polygon_count" -lt 1 ]]; then
  echo "[smoke-phase2] Segmentation polygons were not persisted"
  echo "$annotations_list"
  exit 1
fi

inference_request='{"model_version_id":"mv-2","input_attachment_id":"f-1","task_type":"detection"}'
inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$inference_request" \
  "${BASE_URL}/api/inference/runs")"

inference_run_id="$(echo "$inference_result" | jq -r '.data.id // empty')"
fallback_source="$(echo "$inference_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
fallback_reason="$(echo "$inference_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"

if [[ -z "$inference_run_id" ]]; then
  echo "[smoke-phase2] Inference run was not created"
  echo "$inference_result"
  exit 1
fi

if [[ "$fallback_source" != "mock_fallback" || -z "$fallback_reason" ]]; then
  echo "[smoke-phase2] YOLO runtime fallback assertion failed"
  echo "$inference_result"
  exit 1
fi

ocr_inference_request='{"model_version_id":"mv-1","input_attachment_id":"f-3","task_type":"ocr"}'
ocr_inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$ocr_inference_request" \
  "${BASE_URL}/api/inference/runs")"

ocr_inference_run_id="$(echo "$ocr_inference_result" | jq -r '.data.id // empty')"
ocr_fallback_source="$(echo "$ocr_inference_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
ocr_fallback_reason="$(echo "$ocr_inference_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"

if [[ -z "$ocr_inference_run_id" ]]; then
  echo "[smoke-phase2] OCR inference run was not created"
  echo "$ocr_inference_result"
  exit 1
fi

if [[ "$ocr_fallback_source" != "mock_fallback" || -z "$ocr_fallback_reason" ]]; then
  echo "[smoke-phase2] PaddleOCR runtime fallback assertion failed"
  echo "$ocr_inference_result"
  exit 1
fi

doctr_training_request='{"name":"doctr-smoke-job","task_type":"ocr","framework":"doctr","dataset_id":"d-1","dataset_version_id":"dv-1","base_model":"doctr-base","config":{"epochs":"1","batch_size":"1"}}'
doctr_training_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$doctr_training_request" \
  "${BASE_URL}/api/training/jobs")"
doctr_training_job_id="$(echo "$doctr_training_result" | jq -r '.data.id // empty')"
if [[ -z "$doctr_training_job_id" ]]; then
  echo "[smoke-phase2] docTR training job creation failed"
  echo "$doctr_training_result"
  exit 1
fi

doctr_job_status=""
for _ in $(seq 1 50); do
  doctr_job_detail="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    "${BASE_URL}/api/training/jobs/${doctr_training_job_id}")"
  doctr_job_status="$(echo "$doctr_job_detail" | jq -r '.data.job.status // empty')"
  if [[ "$doctr_job_status" == "completed" ]]; then
    break
  fi
  sleep 0.2
done

if [[ "$doctr_job_status" != "completed" ]]; then
  echo "[smoke-phase2] docTR training job did not complete in time"
  echo "$doctr_job_detail"
  exit 1
fi

doctr_model_request='{"name":"doctr-phase2-smoke-model","description":"docTR phase2 smoke model","model_type":"ocr","visibility":"workspace"}'
doctr_model_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$doctr_model_request" \
  "${BASE_URL}/api/models/draft")"
doctr_model_id="$(echo "$doctr_model_result" | jq -r '.data.id // empty')"
if [[ -z "$doctr_model_id" ]]; then
  echo "[smoke-phase2] docTR model draft creation failed"
  echo "$doctr_model_result"
  exit 1
fi

doctr_register_request="$(cat <<JSON
{"model_id":"${doctr_model_id}","training_job_id":"${doctr_training_job_id}","version_name":"doctr-smoke-v1"}
JSON
)"
doctr_register_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$doctr_register_request" \
  "${BASE_URL}/api/model-versions/register")"
doctr_model_version_id="$(echo "$doctr_register_result" | jq -r '.data.id // empty')"
if [[ -z "$doctr_model_version_id" ]]; then
  echo "[smoke-phase2] docTR model version registration failed"
  echo "$doctr_register_result"
  exit 1
fi

doctr_inference_request="$(cat <<JSON
{"model_version_id":"${doctr_model_version_id}","input_attachment_id":"f-3","task_type":"ocr"}
JSON
)"
doctr_inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$doctr_inference_request" \
  "${BASE_URL}/api/inference/runs")"
doctr_inference_run_id="$(echo "$doctr_inference_result" | jq -r '.data.id // empty')"
doctr_fallback_source="$(echo "$doctr_inference_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
doctr_fallback_reason="$(echo "$doctr_inference_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"

if [[ -z "$doctr_inference_run_id" ]]; then
  echo "[smoke-phase2] docTR inference run was not created"
  echo "$doctr_inference_result"
  exit 1
fi

if [[ "$doctr_fallback_source" != "mock_fallback" || -z "$doctr_fallback_reason" ]]; then
  echo "[smoke-phase2] docTR runtime fallback assertion failed"
  echo "$doctr_inference_result"
  exit 1
fi

echo "[smoke-phase2] PASS"
echo "dataset_id=${dataset_id}"
echo "dataset_item_id=${dataset_item_id}"
echo "annotation_status=${saved_status}"
echo "polygon_count=${polygon_count}"
echo "yolo_inference_run_id=${inference_run_id}"
echo "yolo_fallback_source=${fallback_source}"
echo "yolo_fallback_reason=${fallback_reason}"
echo "paddleocr_inference_run_id=${ocr_inference_run_id}"
echo "paddleocr_fallback_source=${ocr_fallback_source}"
echo "paddleocr_fallback_reason=${ocr_fallback_reason}"
echo "doctr_training_job_id=${doctr_training_job_id}"
echo "doctr_model_version_id=${doctr_model_version_id}"
echo "doctr_inference_run_id=${doctr_inference_run_id}"
echo "doctr_fallback_source=${doctr_fallback_source}"
echo "doctr_fallback_reason=${doctr_fallback_reason}"
