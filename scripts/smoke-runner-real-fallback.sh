#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
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

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-runner-real-fallback] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-runner-real-fallback] python3 is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

wait_inference_attachment_ready() {
  local attachment_id="$1"
  local list_resp=""
  local attachment_status=""

  for _ in {1..120}; do
    list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/inference")"
    attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"
    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi
    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-runner-real-fallback] attachment entered error state."
      echo "${list_resp}"
      exit 1
    fi
    sleep 0.25
  done

  echo "[smoke-runner-real-fallback] attachment not ready in time."
  echo "${list_resp}"
  exit 1
}

cd "${ROOT_DIR}"

APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
VISTRAL_RUNNER_ENABLE_REAL=1 \
YOLO_LOCAL_PREDICT_COMMAND='python3 {{repo_root}}/scripts/local-runners/yolo_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}' \
PADDLEOCR_LOCAL_PREDICT_COMMAND='python3 {{repo_root}}/scripts/local-runners/paddleocr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}' \
API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
npm run dev:api >"${API_LOG}" 2>&1 &
API_PID=$!

for _ in {1..100}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
  echo "[smoke-runner-real-fallback] API process exited before health check (possible port conflict)."
  cat "${API_LOG}"
  exit 1
fi

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-runner-real-fallback] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-runner-real-fallback] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

model_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions")"
detection_model_version_id="$(echo "${model_versions_resp}" | jq -r '.data[] | select(.task_type=="detection" and .status=="registered") | .id' | head -n 1)"
ocr_model_version_id="$(echo "${model_versions_resp}" | jq -r '.data[] | select(.task_type=="ocr" and .framework=="paddleocr" and .status=="registered") | .id' | head -n 1)"
if [[ -z "${ocr_model_version_id}" ]]; then
  ocr_model_version_id="$(echo "${model_versions_resp}" | jq -r '.data[] | select(.task_type=="ocr" and .status=="registered") | .id' | head -n 1)"
fi
if [[ -z "${detection_model_version_id}" || -z "${ocr_model_version_id}" ]]; then
  echo "[smoke-runner-real-fallback] required detection/ocr model versions not found."
  echo "${model_versions_resp}"
  exit 1
fi

detection_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -d "{\"filename\":\"runner-fallback-detection-$(date +%s).jpg\"}")"
detection_attachment_id="$(echo "${detection_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${detection_attachment_id}" ]]; then
  echo "[smoke-runner-real-fallback] failed to upload detection attachment."
  echo "${detection_upload_resp}"
  exit 1
fi
wait_inference_attachment_ready "${detection_attachment_id}"

ocr_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -d "{\"filename\":\"runner-fallback-ocr-$(date +%s).jpg\"}")"
ocr_attachment_id="$(echo "${ocr_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_attachment_id}" ]]; then
  echo "[smoke-runner-real-fallback] failed to upload OCR attachment."
  echo "${ocr_upload_resp}"
  exit 1
fi
wait_inference_attachment_ready "${ocr_attachment_id}"

yolo_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${detection_attachment_id}\",\"task_type\":\"detection\"}")"
yolo_source="$(echo "${yolo_resp}" | jq -r '.data.execution_source // empty')"
yolo_mode="$(echo "${yolo_resp}" | jq -r '.data.raw_output.meta.mode // empty')"
yolo_reason="$(echo "${yolo_resp}" | jq -r '.data.raw_output.meta.fallback_reason // empty')"
if [[ "${yolo_source}" != "yolo_local_command" ]]; then
  echo "[smoke-runner-real-fallback] expected yolo_local_command source, got ${yolo_source}."
  echo "${yolo_resp}"
  exit 1
fi
if [[ "${yolo_mode}" != "template" ]]; then
  echo "[smoke-runner-real-fallback] expected YOLO template mode fallback, got ${yolo_mode}."
  echo "${yolo_resp}"
  exit 1
fi
if [[ -z "${yolo_reason}" ]]; then
  echo "[smoke-runner-real-fallback] expected YOLO fallback reason in meta."
  echo "${yolo_resp}"
  exit 1
fi

paddle_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${ocr_model_version_id}\",\"input_attachment_id\":\"${ocr_attachment_id}\",\"task_type\":\"ocr\"}")"
paddle_source="$(echo "${paddle_resp}" | jq -r '.data.execution_source // empty')"
paddle_mode="$(echo "${paddle_resp}" | jq -r '.data.raw_output.meta.mode // empty')"
paddle_reason="$(echo "${paddle_resp}" | jq -r '.data.raw_output.meta.fallback_reason // empty')"
if [[ "${paddle_source}" != "paddleocr_local_command" ]]; then
  echo "[smoke-runner-real-fallback] expected paddleocr_local_command source, got ${paddle_source}."
  echo "${paddle_resp}"
  exit 1
fi
if [[ "${paddle_mode}" != "template" ]]; then
  echo "[smoke-runner-real-fallback] expected PaddleOCR template mode fallback, got ${paddle_mode}."
  echo "${paddle_resp}"
  exit 1
fi
if [[ -z "${paddle_reason}" ]]; then
  echo "[smoke-runner-real-fallback] expected PaddleOCR fallback reason in meta."
  echo "${paddle_resp}"
  exit 1
fi

echo "[smoke-runner-real-fallback] PASS"
echo "yolo_reason=${yolo_reason}"
echo "paddle_reason=${paddle_reason}"
