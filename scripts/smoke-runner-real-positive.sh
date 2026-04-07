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
  echo "[smoke-runner-real-positive] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-runner-real-positive] python3 is required."
  exit 1
fi

REAL_MODEL_PATH="${REAL_YOLO_MODEL_PATH:-${VISTRAL_YOLO_MODEL_PATH:-}}"
if [[ -z "${REAL_MODEL_PATH}" ]]; then
  echo "[smoke-runner-real-positive] SKIP: REAL_YOLO_MODEL_PATH or VISTRAL_YOLO_MODEL_PATH is not set."
  exit 0
fi
if [[ ! -f "${REAL_MODEL_PATH}" ]]; then
  echo "[smoke-runner-real-positive] SKIP: model file not found: ${REAL_MODEL_PATH}"
  exit 0
fi
if ! python3 -c "import ultralytics" >/dev/null 2>&1; then
  echo "[smoke-runner-real-positive] SKIP: python package ultralytics is unavailable."
  exit 0
fi

DEMO_IMAGE="$(find "${ROOT_DIR}/demo_data/train" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.bmp' \) | head -n 1 || true)"
if [[ -z "${DEMO_IMAGE}" ]]; then
  echo "[smoke-runner-real-positive] SKIP: no image found under demo_data/train."
  exit 0
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
VISTRAL_YOLO_MODEL_PATH="${REAL_MODEL_PATH}" \
YOLO_LOCAL_PREDICT_COMMAND='python3 {{repo_root}}/scripts/local-runners/yolo_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}' \
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
  echo "[smoke-runner-real-positive] API process exited before health check (possible port conflict)."
  cat "${API_LOG}"
  exit 1
fi

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-runner-real-positive] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-runner-real-positive] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

model_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions")"
detection_model_version_id="$(echo "${model_versions_resp}" | jq -r '.data[] | select(.task_type=="detection" and .status=="registered") | .id' | head -n 1)"
if [[ -z "${detection_model_version_id}" ]]; then
  echo "[smoke-runner-real-positive] no registered detection model version found."
  echo "${model_versions_resp}"
  exit 1
fi

upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -F "file=@${DEMO_IMAGE}" \
  "${BASE_URL}/api/files/inference/upload")"
attachment_id="$(echo "${upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${attachment_id}" ]]; then
  echo "[smoke-runner-real-positive] upload failed."
  echo "${upload_resp}"
  exit 1
fi

attachment_status=""
for _ in {1..120}; do
  list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/inference")"
  attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"
  if [[ "${attachment_status}" == "ready" ]]; then
    break
  fi
  if [[ "${attachment_status}" == "error" ]]; then
    echo "[smoke-runner-real-positive] uploaded attachment entered error state."
    echo "${list_resp}"
    exit 1
  fi
  sleep 0.25
done

if [[ "${attachment_status}" != "ready" ]]; then
  echo "[smoke-runner-real-positive] uploaded attachment not ready in time."
  echo "${list_resp}"
  exit 1
fi

infer_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${attachment_id}\",\"task_type\":\"detection\"}")"

execution_source="$(echo "${infer_resp}" | jq -r '.data.execution_source // empty')"
runner_mode="$(echo "${infer_resp}" | jq -r '.data.raw_output.meta.mode // empty')"
fallback_reason="$(echo "${infer_resp}" | jq -r '.data.raw_output.meta.fallback_reason // empty')"
if [[ "${execution_source}" != "yolo_local_command" ]]; then
  echo "[smoke-runner-real-positive] expected execution_source=yolo_local_command, got ${execution_source}."
  echo "${infer_resp}"
  exit 1
fi
if [[ "${runner_mode}" != "real" ]]; then
  echo "[smoke-runner-real-positive] expected runner mode real, got ${runner_mode}."
  echo "${infer_resp}"
  exit 1
fi
if [[ -n "${fallback_reason}" ]]; then
  echo "[smoke-runner-real-positive] expected empty fallback_reason, got ${fallback_reason}."
  echo "${infer_resp}"
  exit 1
fi

echo "[smoke-runner-real-positive] PASS"
echo "attachment_id=${attachment_id}"
echo "execution_source=${execution_source}"
echo "runner_mode=${runner_mode}"
