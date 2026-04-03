#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
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

yolo_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d '{"model_version_id":"mv-2","input_attachment_id":"f-1","task_type":"detection"}')"
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
  -d '{"model_version_id":"mv-1","input_attachment_id":"f-3","task_type":"ocr"}')"
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
