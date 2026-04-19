#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_HOST="${API_HOST:-127.0.0.1}"
AUTH_USERNAME="${AUTH_USERNAME:-alice}"
AUTH_PASSWORD="${AUTH_PASSWORD:-mock-pass}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-ocr-fallback-guard] jq is required."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-ocr-fallback-guard] python3 is required."
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

BASE_URL="http://${API_HOST}:${API_PORT}"
COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
RUNNER_OUTPUT="$(mktemp).json"
DOCTR_RUNNER_OUTPUT="$(mktemp).json"
YOLO_RUNNER_OUTPUT="$(mktemp).json"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_FILE" "$API_LOG" "$RUNNER_OUTPUT" "$DOCTR_RUNNER_OUTPUT" "$YOLO_RUNNER_OUTPUT"
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
      echo "[smoke-ocr-fallback-guard] inference attachment entered error state"
      echo "$files_resp"
      exit 1
    fi
    sleep 0.2
  done

  echo "[smoke-ocr-fallback-guard] inference attachment not ready in time"
  echo "$files_resp"
  exit 1
}

echo "[smoke-ocr-fallback-guard] verifying template runner payload"
python3 scripts/local-runners/paddleocr_predict_runner.py \
  --model-id "m-ocr-template-check" \
  --model-version-id "mv-ocr-template-check" \
  --task-type "ocr" \
  --input-path "" \
  --filename "template-check.jpg" \
  --model-path "" \
  --output-path "$RUNNER_OUTPUT" >/dev/null

template_mode="$(jq -r '.meta.mode // empty' "$RUNNER_OUTPUT")"
template_reason="$(jq -r '.meta.template_reason // empty' "$RUNNER_OUTPUT")"
fallback_reason="$(jq -r '.meta.fallback_reason // empty' "$RUNNER_OUTPUT")"
template_line_1="$(jq -r '.ocr.lines[0].text // empty' "$RUNNER_OUTPUT")"
template_line_2="$(jq -r '.ocr.lines[1].text // empty' "$RUNNER_OUTPUT")"

if [[ "$template_mode" != "template" || -z "$template_reason" || -z "$fallback_reason" ]]; then
  echo "[smoke-ocr-fallback-guard] template runner meta assertion failed"
  cat "$RUNNER_OUTPUT"
  exit 1
fi

if [[ "$template_line_1" != "TEMPLATE_OCR_LINE_1" || "$template_line_2" != "TEMPLATE_OCR_LINE_2" ]]; then
  echo "[smoke-ocr-fallback-guard] template runner placeholder assertion failed"
  cat "$RUNNER_OUTPUT"
  exit 1
fi

echo "[smoke-ocr-fallback-guard] verifying doctr template runner payload"
python3 scripts/local-runners/doctr_predict_runner.py \
  --model-id "m-doctr-template-check" \
  --model-version-id "mv-doctr-template-check" \
  --task-type "ocr" \
  --input-path "" \
  --filename "template-check.jpg" \
  --model-path "" \
  --output-path "$DOCTR_RUNNER_OUTPUT" >/dev/null

doctr_template_mode="$(jq -r '.meta.mode // empty' "$DOCTR_RUNNER_OUTPUT")"
doctr_template_reason="$(jq -r '.meta.template_reason // empty' "$DOCTR_RUNNER_OUTPUT")"
doctr_fallback_reason="$(jq -r '.meta.fallback_reason // empty' "$DOCTR_RUNNER_OUTPUT")"
doctr_template_line_1="$(jq -r '.text_lines[0].text // empty' "$DOCTR_RUNNER_OUTPUT")"
if [[ "$doctr_template_mode" != "template" || -z "$doctr_template_reason" || -z "$doctr_fallback_reason" ]]; then
  echo "[smoke-ocr-fallback-guard] doctr template runner meta assertion failed"
  cat "$DOCTR_RUNNER_OUTPUT"
  exit 1
fi
if [[ "$doctr_template_line_1" != "TEMPLATE_OCR_LINE_1" ]]; then
  echo "[smoke-ocr-fallback-guard] doctr template placeholder assertion failed"
  cat "$DOCTR_RUNNER_OUTPUT"
  exit 1
fi

echo "[smoke-ocr-fallback-guard] verifying yolo template runner payload"
python3 scripts/local-runners/yolo_predict_runner.py \
  --model-id "m-yolo-template-check" \
  --model-version-id "mv-yolo-template-check" \
  --task-type "detection" \
  --input-path "" \
  --filename "template-check.jpg" \
  --model-path "" \
  --output-path "$YOLO_RUNNER_OUTPUT" >/dev/null

yolo_template_mode="$(jq -r '.meta.mode // empty' "$YOLO_RUNNER_OUTPUT")"
yolo_template_reason="$(jq -r '.meta.template_reason // empty' "$YOLO_RUNNER_OUTPUT")"
yolo_fallback_reason="$(jq -r '.meta.fallback_reason // empty' "$YOLO_RUNNER_OUTPUT")"
yolo_boxes_count="$(jq -r '(.boxes // []) | if type=="array" then length else -1 end' "$YOLO_RUNNER_OUTPUT")"
yolo_rotated_count="$(jq -r '(.rotated_boxes // []) | if type=="array" then length else -1 end' "$YOLO_RUNNER_OUTPUT")"
yolo_polygon_count="$(jq -r '(.polygons // []) | if type=="array" then length else -1 end' "$YOLO_RUNNER_OUTPUT")"
yolo_mask_count="$(jq -r '(.masks // []) | if type=="array" then length else -1 end' "$YOLO_RUNNER_OUTPUT")"
yolo_label_count="$(jq -r '(.labels // []) | if type=="array" then length else -1 end' "$YOLO_RUNNER_OUTPUT")"
yolo_template_payload="$(jq -r '.meta.template_payload // empty' "$YOLO_RUNNER_OUTPUT")"
if [[ "$yolo_template_mode" != "template" || -z "$yolo_template_reason" || -z "$yolo_fallback_reason" ]]; then
  echo "[smoke-ocr-fallback-guard] yolo template runner meta assertion failed"
  cat "$YOLO_RUNNER_OUTPUT"
  exit 1
fi
if [[ "$yolo_template_payload" != "empty_structured_output" || "$yolo_boxes_count" != "0" || "$yolo_rotated_count" != "0" || "$yolo_polygon_count" != "0" || "$yolo_mask_count" != "0" || "$yolo_label_count" != "0" ]]; then
  echo "[smoke-ocr-fallback-guard] yolo template empty-structured assertion failed"
  cat "$YOLO_RUNNER_OUTPUT"
  exit 1
fi

echo "[smoke-ocr-fallback-guard] starting API with forced OCR local-command failure"
API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
LLM_CONFIG_SECRET="smoke-ocr-fallback-guard-${API_PORT}" \
PADDLEOCR_RUNTIME_ENDPOINT="" \
PADDLEOCR_LOCAL_PREDICT_COMMAND="nonexistent_ocr_predict_command_for_guard" \
YOLO_RUNTIME_ENDPOINT="" \
YOLO_LOCAL_PREDICT_COMMAND="nonexistent_yolo_predict_command_for_guard" \
VISTRAL_BASH_PATH="/nonexistent/vistral-bash" \
VISTRAL_DISABLE_INFERENCE_FALLBACK=0 \
npm run dev:api >"$API_LOG" 2>&1 &
API_PID=$!

for _ in $(seq 1 60); do
  if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! kill -0 "$API_PID" >/dev/null 2>&1; then
  echo "[smoke-ocr-fallback-guard] API process exited before health check"
  cat "$API_LOG"
  exit 1
fi

if ! curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-ocr-fallback-guard] API failed to start"
  cat "$API_LOG"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-ocr-fallback-guard] failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

login_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}" \
  "${BASE_URL}/api/auth/login")"
if [[ "$(echo "$login_resp" | jq -r '.success')" != "true" ]]; then
  echo "[smoke-ocr-fallback-guard] login failed"
  echo "$login_resp"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-ocr-fallback-guard] failed to refresh CSRF token"
  echo "$csrf_payload"
  exit 1
fi

model_versions_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/model-versions")"
ocr_model_version_id="$(echo "$model_versions_resp" | jq -r '.data[] | select(.task_type=="ocr" and .status=="registered") | .id' | head -n 1)"
if [[ -z "$ocr_model_version_id" ]]; then
  echo "[smoke-ocr-fallback-guard] no OCR model version found"
  echo "$model_versions_resp"
  exit 1
fi
det_model_version_id="$(echo "$model_versions_resp" | jq -r '.data[] | select(.task_type=="detection" and .status=="registered") | .id' | head -n 1)"
if [[ -z "$det_model_version_id" ]]; then
  echo "[smoke-ocr-fallback-guard] no detection model version found"
  echo "$model_versions_resp"
  exit 1
fi
det_model_id="$(echo "$model_versions_resp" | jq -r --arg id "${det_model_version_id}" '.data[] | select(.id==$id) | .model_id // empty')"
if [[ -z "$det_model_id" ]]; then
  echo "[smoke-ocr-fallback-guard] failed to resolve detection model id"
  echo "$model_versions_resp"
  exit 1
fi

upload_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"filename\":\"ocr-fallback-guard-$(date +%s).jpg\"}" \
  "${BASE_URL}/api/files/inference/upload")"
input_attachment_id="$(echo "$upload_resp" | jq -r '.data.id // empty')"
if [[ -z "$input_attachment_id" ]]; then
  echo "[smoke-ocr-fallback-guard] failed to upload inference attachment"
  echo "$upload_resp"
  exit 1
fi
wait_inference_attachment_ready "${input_attachment_id}"

inference_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_version_id\":\"${ocr_model_version_id}\",\"input_attachment_id\":\"${input_attachment_id}\",\"task_type\":\"ocr\"}" \
  "${BASE_URL}/api/inference/runs")"

source_value="$(echo "$inference_resp" | jq -r '.data.normalized_output.normalized_output.source // empty')"
ocr_lines_len="$(echo "$inference_resp" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
local_reason="$(echo "$inference_resp" | jq -r '.data.raw_output.local_command_fallback_reason // empty')"
local_framework="$(echo "$inference_resp" | jq -r '.data.raw_output.local_command_framework // empty')"
attempted_command="$(echo "$inference_resp" | jq -r '.data.raw_output.attempted_command // empty')"
platform_value="$(echo "$inference_resp" | jq -r '.data.raw_output.platform // empty')"
invoice_hit="$(echo "$inference_resp" | jq -r '[.data.normalized_output.ocr.lines[]?.text // "", .data.normalized_output.ocr.words[]?.text // ""] | map(test("Invoice No\\. 2026-0402|Total: 458\\.30")) | any')"

if [[ "$source_value" != "explicit_fallback_local_command_failed" ]]; then
  echo "[smoke-ocr-fallback-guard] unexpected source: $source_value"
  echo "$inference_resp"
  exit 1
fi
if [[ "$ocr_lines_len" != "0" ]]; then
  echo "[smoke-ocr-fallback-guard] OCR lines should be empty on failed local command"
  echo "$inference_resp"
  exit 1
fi
if [[ "$invoice_hit" != "false" ]]; then
  echo "[smoke-ocr-fallback-guard] found forbidden invoice fallback text"
  echo "$inference_resp"
  exit 1
fi
if [[ -z "$local_reason" || -z "$local_framework" || -z "$attempted_command" || -z "$platform_value" ]]; then
  echo "[smoke-ocr-fallback-guard] missing fallback metadata fields"
  echo "$inference_resp"
  exit 1
fi

det_upload_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"filename\":\"det-fallback-guard-$(date +%s).jpg\"}" \
  "${BASE_URL}/api/files/inference/upload")"
det_attachment_id="$(echo "$det_upload_resp" | jq -r '.data.id // empty')"
if [[ -z "$det_attachment_id" ]]; then
  echo "[smoke-ocr-fallback-guard] failed to upload detection inference attachment"
  echo "$det_upload_resp"
  exit 1
fi
wait_inference_attachment_ready "${det_attachment_id}"

det_inference_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_version_id\":\"${det_model_version_id}\",\"input_attachment_id\":\"${det_attachment_id}\",\"task_type\":\"detection\"}" \
  "${BASE_URL}/api/inference/runs")"

det_source="$(echo "$det_inference_resp" | jq -r '.data.normalized_output.normalized_output.source // empty')"
det_boxes_len="$(echo "$det_inference_resp" | jq -r '.data.normalized_output.boxes | length // 0')"
det_labels_len="$(echo "$det_inference_resp" | jq -r '.data.normalized_output.labels | length // 0')"
det_reason="$(echo "$det_inference_resp" | jq -r '.data.raw_output.local_command_fallback_reason // empty')"
if [[ "$det_source" != "explicit_fallback_local_command_failed" ]]; then
  echo "[smoke-ocr-fallback-guard] unexpected detection source: $det_source"
  echo "$det_inference_resp"
  exit 1
fi
if [[ "$det_boxes_len" != "0" || "$det_labels_len" != "0" ]]; then
  echo "[smoke-ocr-fallback-guard] detection fallback should return empty structured predictions"
  echo "$det_inference_resp"
  exit 1
fi
if [[ -z "$det_reason" ]]; then
  echo "[smoke-ocr-fallback-guard] detection fallback reason missing"
  echo "$det_inference_resp"
  exit 1
fi

echo "[smoke-ocr-fallback-guard] verifying conversation fallback wording is not misleading"
conversation_start_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${det_model_id}\",\"initial_message\":\"请帮我做目标检测推理并告诉我结果\",\"attachment_ids\":[\"${det_attachment_id}\"]}" \
  "${BASE_URL}/api/conversations/start")"
conversation_assistant_summary="$(echo "$conversation_start_resp" | jq -r '.data.messages[-1].content // empty')"
if [[ -z "$conversation_assistant_summary" ]]; then
  echo "[smoke-ocr-fallback-guard] conversation summary missing"
  echo "$conversation_start_resp"
  exit 1
fi
if [[ "$conversation_assistant_summary" == *"已完成目标检测推理"* ]]; then
  echo "[smoke-ocr-fallback-guard] conversation summary should not claim real detection in fallback mode"
  echo "$conversation_start_resp"
  exit 1
fi
if [[ "$conversation_assistant_summary" != *"回退/模板结果"* \
   && "$conversation_assistant_summary" != *"fallback/template output"* \
   && "$conversation_assistant_summary" != *"降级输出"* \
   && "$conversation_assistant_summary" != *"degraded output"* ]]; then
  echo "[smoke-ocr-fallback-guard] conversation summary missing degraded warning wording"
  echo "$conversation_start_resp"
  exit 1
fi

echo "[smoke-ocr-fallback-guard] verifying frontend warning contract markers"
if ! rg -n "Current result is not real output|Current output is degraded and not from real OCR recognition|当前结果为(回退/模板结果|降级输出)，不是真实 OCR 识别" src/pages/InferenceValidationPage.tsx >/dev/null; then
  echo "[smoke-ocr-fallback-guard] missing fallback warning text in frontend"
  exit 1
fi
if ! rg -n "No OCR text recognized|No text recognized or this run produced no real OCR output|未识别到文本 / 本次运行未产生真实 OCR 结果" src/pages/InferenceValidationPage.tsx >/dev/null; then
  echo "[smoke-ocr-fallback-guard] missing empty-ocr warning text in frontend"
  exit 1
fi
if ! rg -n "local_command_fallback_reason|runtime_fallback_reason|includes\\('mock'\\)|includes\\('template'\\)|includes\\('fallback'\\)" src/pages/InferenceValidationPage.tsx >/dev/null; then
  echo "[smoke-ocr-fallback-guard] missing fallback detection logic markers in frontend"
  exit 1
fi
if ! rg -n "raw_output.meta" src/pages/InferenceValidationPage.tsx >/dev/null; then
  echo "[smoke-ocr-fallback-guard] missing template mode detection marker in frontend"
  exit 1
fi

echo "[smoke-ocr-fallback-guard] PASS"
echo "  source=${source_value}"
echo "  local_reason=${local_reason}"
echo "  attempted_command=${attempted_command}"
echo "  det_source=${det_source}"
