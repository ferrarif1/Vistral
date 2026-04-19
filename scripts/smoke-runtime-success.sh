#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_HOST="${API_HOST:-127.0.0.1}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-mock-pass-admin}"
VISTRAL_DISABLE_INFERENCE_FALLBACK_FOR_SMOKE="${VISTRAL_DISABLE_INFERENCE_FALLBACK_FOR_SMOKE:-0}"
DOCTR_WAIT_POLLS="${DOCTR_WAIT_POLLS:-240}"
DOCTR_WAIT_SLEEP_SEC="${DOCTR_WAIT_SLEEP_SEC:-0.5}"

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
DOCTR_SMOKE_EXPECTED_MISSING_FILE="vistral-smoke-doctr-missing.bin"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
RUNTIME_LOG="$(mktemp)"
SYNTH_IMAGE_FILE=""
API_PID=""
RUNTIME_PID=""

sample_image_file="$(
  find "${ROOT_DIR}/demo_data" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit 2>/dev/null || true
)"
if [[ -z "${sample_image_file}" ]]; then
  SYNTH_IMAGE_FILE="$(mktemp "${TMPDIR:-/tmp}/runtime-success-sample.XXXXXX.png")"
  python3 - "${SYNTH_IMAGE_FILE}" <<'PY'
import base64
import pathlib
import sys

payload = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZlN8AAAAASUVORK5CYII="
)
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(payload))
PY
  sample_image_file="${SYNTH_IMAGE_FILE}"
fi

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi

  if [[ -n "$RUNTIME_PID" ]]; then
    kill "$RUNTIME_PID" >/dev/null 2>&1 || true
    wait "$RUNTIME_PID" >/dev/null 2>&1 || true
  fi

  rm -f "$COOKIE_FILE" "$API_LOG" "$RUNTIME_LOG" "${SYNTH_IMAGE_FILE:-}"
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
LLM_CONFIG_SECRET="smoke-runtime-success-${API_PORT}" \
PADDLEOCR_RUNTIME_ENDPOINT="$RUNTIME_ENDPOINT" \
DOCTR_RUNTIME_ENDPOINT="$RUNTIME_ENDPOINT" \
YOLO_RUNTIME_ENDPOINT="$RUNTIME_ENDPOINT" \
VISTRAL_DISABLE_INFERENCE_FALLBACK="${VISTRAL_DISABLE_INFERENCE_FALLBACK_FOR_SMOKE}" \
VISTRAL_DOCTR_EXPECTED_MODEL_FILES="${DOCTR_SMOKE_EXPECTED_MISSING_FILE}" \
MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1 \
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

login_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
login_ok="$(echo "$login_payload" | jq -r '.success // false')"
if [[ "$login_ok" != "true" ]]; then
  echo "[smoke-runtime-success] admin login failed"
  echo "$login_payload"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-runtime-success] Failed to refresh CSRF token after login"
  echo "$csrf_payload"
  exit 1
fi

runtime_controls_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"runtime_config":{},"runtime_controls":{"disable_inference_fallback":false}}' \
  "${BASE_URL}/api/settings/runtime")"
runtime_controls_saved="$(echo "$runtime_controls_resp" | jq -r '.success // false')"
if [[ "$runtime_controls_saved" != "true" ]]; then
  echo "[smoke-runtime-success] failed to relax runtime_controls.disable_inference_fallback"
  echo "$runtime_controls_resp"
  exit 1
fi

runtime_endpoint_seed_payload="$(
  jq -nc --arg endpoint "$RUNTIME_ENDPOINT" '{
    runtime_config: {
      paddleocr: { endpoint: $endpoint },
      doctr: { endpoint: $endpoint },
      yolo: { endpoint: $endpoint }
    },
    keep_existing_api_keys: true
  }'
)"
runtime_endpoint_seed_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$runtime_endpoint_seed_payload" \
  "${BASE_URL}/api/settings/runtime")"
runtime_endpoint_seed_ok="$(echo "$runtime_endpoint_seed_resp" | jq -r '.success // false')"
if [[ "$runtime_endpoint_seed_ok" != "true" ]]; then
  echo "[smoke-runtime-success] failed to seed runtime endpoints"
  echo "$runtime_endpoint_seed_resp"
  exit 1
fi

runtime_readiness_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/runtime/readiness")"
runtime_readiness_ok="$(echo "$runtime_readiness_resp" | jq -r '.success // false')"
runtime_readiness_bootstrap_assets_array="$(
  echo "$runtime_readiness_resp" | jq -r '(.data.bootstrap_assets | type) == "array"'
)"
runtime_readiness_doctr_asset_count="$(
  echo "$runtime_readiness_resp" | jq -r '[.data.bootstrap_assets[]? | select(.framework=="doctr")] | length'
)"
runtime_readiness_doctr_expected_count="$(
  echo "$runtime_readiness_resp" | jq -r --arg expected "${DOCTR_SMOKE_EXPECTED_MISSING_FILE}" '[.data.bootstrap_assets[]? | select(.framework=="doctr") | .expected_files[]? | select(.name==$expected)] | length'
)"
runtime_readiness_doctr_missing_count="$(
  echo "$runtime_readiness_resp" | jq -r --arg expected "${DOCTR_SMOKE_EXPECTED_MISSING_FILE}" '[.data.bootstrap_assets[]? | select(.framework=="doctr") | .missing_files[]? | select(.==$expected)] | length'
)"
if [[ "$runtime_readiness_ok" != "true" || "$runtime_readiness_bootstrap_assets_array" != "true" || "$runtime_readiness_doctr_asset_count" -lt 1 || "$runtime_readiness_doctr_expected_count" -lt 1 || "$runtime_readiness_doctr_missing_count" -lt 1 ]]; then
  echo "[smoke-runtime-success] runtime readiness bootstrap_assets contract assertion failed"
  echo "$runtime_readiness_resp"
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
  -H "x-csrf-token: $csrf_token" \
  -F "file=@${sample_image_file};filename=runtime-success-detection-$(date +%s).jpg" \
  "${BASE_URL}/api/files/inference/upload")"
detection_input_attachment_id="$(echo "$detection_upload_resp" | jq -r '.data.id // empty')"
if [[ -z "$detection_input_attachment_id" ]]; then
  echo "[smoke-runtime-success] failed to upload detection inference attachment"
  echo "$detection_upload_resp"
  exit 1
fi
wait_inference_attachment_ready "${detection_input_attachment_id}"

ocr_upload_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H "x-csrf-token: $csrf_token" \
  -F "file=@${sample_image_file};filename=runtime-success-ocr-$(date +%s).jpg" \
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
for _ in $(seq 1 "${DOCTR_WAIT_POLLS}"); do
  doctr_job_detail="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/training/jobs/${doctr_training_job_id}")"
  doctr_job_status="$(echo "$doctr_job_detail" | jq -r '.data.job.status // empty')"
  if [[ "$doctr_job_status" == "completed" ]]; then
    break
  fi
  if [[ "$doctr_job_status" == "failed" || "$doctr_job_status" == "cancelled" ]]; then
    echo "[smoke-runtime-success] docTR training job ended unexpectedly: ${doctr_job_status}"
    echo "$doctr_job_detail"
    exit 1
  fi
  sleep "${DOCTR_WAIT_SLEEP_SEC}"
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

runtime_policy_binding_key="model_version:${detection_model_version_id}"

save_runtime_policy_settings() {
  local policy_payload="$1"
  local save_resp=""
  save_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d "$policy_payload" \
    "${BASE_URL}/api/settings/runtime")"
  local save_ok=""
  save_ok="$(echo "$save_resp" | jq -r '.success // false')"
  if [[ "$save_ok" != "true" ]]; then
    echo "[smoke-runtime-success] failed to save runtime policy settings"
    echo "$save_resp"
    exit 1
  fi
}

quota_exhausted_payload="$(
  jq -nc \
    --arg endpoint "$RUNTIME_ENDPOINT" \
    --arg binding "$runtime_policy_binding_key" \
    '{
      runtime_config: {
        paddleocr: { endpoint: $endpoint, api_key: "", model_api_keys: {}, model_api_key_policies: {} },
        doctr: { endpoint: $endpoint, api_key: "", model_api_keys: {}, model_api_key_policies: {} },
        yolo: {
          endpoint: $endpoint,
          api_key: "",
          model_api_keys: { ($binding): "" },
          model_api_key_policies: {
            ($binding): {
              api_key: "mv-quota-key",
              expires_at: null,
              max_calls: 1,
              used_calls: 0,
              last_used_at: null
            }
          }
        }
      },
      keep_existing_api_keys: false
    }'
)"
save_runtime_policy_settings "$quota_exhausted_payload"

yolo_quota_seed_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${detection_input_attachment_id}\",\"task_type\":\"detection\"}" \
  "${BASE_URL}/api/inference/runs")"
yolo_quota_seed_source="$(echo "$yolo_quota_seed_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
if [[ "$yolo_quota_seed_source" != "yolo_runtime" ]]; then
  echo "[smoke-runtime-success] runtime model API key quota seed-call failed"
  echo "$yolo_quota_seed_result"
  exit 1
fi

yolo_quota_block_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${detection_input_attachment_id}\",\"task_type\":\"detection\"}" \
  "${BASE_URL}/api/inference/runs")"
yolo_quota_block_source="$(echo "$yolo_quota_block_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
yolo_quota_block_reason="$(echo "$yolo_quota_block_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"
if [[ "$yolo_quota_block_source" != "explicit_fallback_runtime_failed" || "$yolo_quota_block_reason" != *"quota exceeded"* ]]; then
  echo "[smoke-runtime-success] runtime model API key quota guard assertion failed"
  echo "$yolo_quota_block_result"
  exit 1
fi

expired_payload="$(
  jq -nc \
    --arg endpoint "$RUNTIME_ENDPOINT" \
    --arg binding "$runtime_policy_binding_key" \
    '{
      runtime_config: {
        paddleocr: { endpoint: $endpoint, api_key: "", model_api_keys: {}, model_api_key_policies: {} },
        doctr: { endpoint: $endpoint, api_key: "", model_api_keys: {}, model_api_key_policies: {} },
        yolo: {
          endpoint: $endpoint,
          api_key: "",
          model_api_keys: { ($binding): "" },
          model_api_key_policies: {
            ($binding): {
              api_key: "mv-expired-key",
              expires_at: "2020-01-01T00:00:00Z",
              max_calls: null,
              used_calls: 0,
              last_used_at: null
            }
          }
        }
      },
      keep_existing_api_keys: false
    }'
)"
save_runtime_policy_settings "$expired_payload"

yolo_expired_block_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${detection_input_attachment_id}\",\"task_type\":\"detection\"}" \
  "${BASE_URL}/api/inference/runs")"
yolo_expired_block_source="$(echo "$yolo_expired_block_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
yolo_expired_block_reason="$(echo "$yolo_expired_block_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"
if [[ "$yolo_expired_block_source" != "explicit_fallback_runtime_failed" || "$yolo_expired_block_reason" != *"API key expired"* ]]; then
  echo "[smoke-runtime-success] runtime model API key expiry guard assertion failed"
  echo "$yolo_expired_block_result"
  exit 1
fi

success_with_counter_payload="$(
  jq -nc \
    --arg endpoint "$RUNTIME_ENDPOINT" \
    --arg binding "$runtime_policy_binding_key" \
    '{
      runtime_config: {
        paddleocr: { endpoint: $endpoint, api_key: "", model_api_keys: {}, model_api_key_policies: {} },
        doctr: { endpoint: $endpoint, api_key: "", model_api_keys: {}, model_api_key_policies: {} },
        yolo: {
          endpoint: $endpoint,
          api_key: "",
          model_api_keys: { ($binding): "" },
          model_api_key_policies: {
            ($binding): {
              api_key: "mv-ok-key",
              expires_at: null,
              max_calls: 2,
              used_calls: 0,
              last_used_at: null
            }
          }
        }
      },
      keep_existing_api_keys: false
    }'
)"
save_runtime_policy_settings "$success_with_counter_payload"

yolo_counter_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${detection_input_attachment_id}\",\"task_type\":\"detection\"}" \
  "${BASE_URL}/api/inference/runs")"
yolo_counter_source="$(echo "$yolo_counter_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
if [[ "$yolo_counter_source" != "yolo_runtime" ]]; then
  echo "[smoke-runtime-success] runtime model API key success path failed"
  echo "$yolo_counter_result"
  exit 1
fi

runtime_after_counter="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/settings/runtime")"
counter_used_calls="$(echo "$runtime_after_counter" | jq -r --arg binding "$runtime_policy_binding_key" '.data.frameworks.yolo.model_api_keys_meta[$binding].used_calls // -1')"
counter_remaining_calls="$(echo "$runtime_after_counter" | jq -r --arg binding "$runtime_policy_binding_key" '.data.frameworks.yolo.model_api_keys_meta[$binding].remaining_calls // -1')"
counter_is_expired="$(
  echo "$runtime_after_counter" | jq -r --arg binding "$runtime_policy_binding_key" '
    .data.frameworks.yolo.model_api_keys_meta[$binding].is_expired
    | if . == null then "missing" else tostring end
  '
)"
if [[ "$counter_used_calls" != "1" || "$counter_remaining_calls" != "1" || "$counter_is_expired" != "false" ]]; then
  echo "[smoke-runtime-success] runtime model API key usage counter assertion failed"
  echo "$runtime_after_counter"
  exit 1
fi

echo "[smoke-runtime-success] PASS"
echo "runtime_endpoint=${RUNTIME_ENDPOINT}"
echo "yolo_source=${yolo_source}"
echo "paddle_source=${paddle_source}"
echo "doctr_source=${doctr_source}"
echo "doctr_training_job_id=${doctr_training_job_id}"
echo "doctr_model_version_id=${doctr_model_version_id}"
echo "policy_binding=${runtime_policy_binding_key}"
echo "policy_used_calls=${counter_used_calls}"
echo "policy_remaining_calls=${counter_remaining_calls}"
