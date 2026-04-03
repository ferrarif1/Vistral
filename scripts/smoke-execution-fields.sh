#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
BASE_URL="http://${API_HOST}:${API_PORT}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-execution-fields] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-execution-fields] python3 is required."
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
YOLO_LOCAL_TRAIN_COMMAND='python3 {{repo_root}}/scripts/local-runners/yolo_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}' \
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

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-execution-fields] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-execution-fields] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

# 1) YOLO local-command training should persist execution_mode=local_command
local_job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d '{"name":"exec-mode-local","task_type":"detection","framework":"yolo","dataset_id":"d-2","dataset_version_id":"dv-2","base_model":"yolo11n","config":{"epochs":"4","batch_size":"2","learning_rate":"0.0008"}}')"
local_job_id="$(echo "${local_job_resp}" | jq -r '.data.id // empty')"
if [[ -z "${local_job_id}" ]]; then
  echo "[smoke-execution-fields] failed to create local-command training job."
  echo "${local_job_resp}"
  exit 1
fi

local_job_status=""
local_job_detail=""
for _ in {1..140}; do
  local_job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${local_job_id}")"
  local_job_status="$(echo "${local_job_detail}" | jq -r '.data.job.status // empty')"
  if [[ "${local_job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${local_job_status}" == "failed" || "${local_job_status}" == "cancelled" ]]; then
    echo "[smoke-execution-fields] local-command job ended with ${local_job_status}."
    echo "${local_job_detail}"
    exit 1
  fi
  sleep 0.25
done

if [[ "${local_job_status}" != "completed" ]]; then
  echo "[smoke-execution-fields] local-command job timeout."
  echo "${local_job_detail}"
  exit 1
fi

local_mode="$(echo "${local_job_detail}" | jq -r '.data.job.execution_mode // empty')"
if [[ "${local_mode}" != "local_command" ]]; then
  echo "[smoke-execution-fields] expected local job execution_mode=local_command, got ${local_mode}."
  echo "${local_job_detail}"
  exit 1
fi

# 2) PaddleOCR without local train command should persist execution_mode=simulated
sim_job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d '{"name":"exec-mode-simulated","task_type":"ocr","framework":"paddleocr","dataset_id":"d-1","dataset_version_id":"dv-1","base_model":"paddleocr-PP-OCRv4","config":{"epochs":"4","batch_size":"2","learning_rate":"0.001"}}')"
sim_job_id="$(echo "${sim_job_resp}" | jq -r '.data.id // empty')"
if [[ -z "${sim_job_id}" ]]; then
  echo "[smoke-execution-fields] failed to create simulated training job."
  echo "${sim_job_resp}"
  exit 1
fi

sim_job_status=""
sim_job_detail=""
for _ in {1..140}; do
  sim_job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${sim_job_id}")"
  sim_job_status="$(echo "${sim_job_detail}" | jq -r '.data.job.status // empty')"
  if [[ "${sim_job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${sim_job_status}" == "failed" || "${sim_job_status}" == "cancelled" ]]; then
    echo "[smoke-execution-fields] simulated job ended with ${sim_job_status}."
    echo "${sim_job_detail}"
    exit 1
  fi
  sleep 0.25
done

if [[ "${sim_job_status}" != "completed" ]]; then
  echo "[smoke-execution-fields] simulated job timeout."
  echo "${sim_job_detail}"
  exit 1
fi

sim_mode="$(echo "${sim_job_detail}" | jq -r '.data.job.execution_mode // empty')"
if [[ "${sim_mode}" != "simulated" ]]; then
  echo "[smoke-execution-fields] expected simulated job execution_mode=simulated, got ${sim_mode}."
  echo "${sim_job_detail}"
  exit 1
fi

# 3) Inference run should persist explicit execution_source and match normalized source.
infer_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d '{"model_version_id":"mv-2","input_attachment_id":"f-1","task_type":"detection"}')"

execution_source="$(echo "${infer_resp}" | jq -r '.data.execution_source // empty')"
normalized_source="$(echo "${infer_resp}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
if [[ -z "${execution_source}" || -z "${normalized_source}" ]]; then
  echo "[smoke-execution-fields] inference source fields missing."
  echo "${infer_resp}"
  exit 1
fi

if [[ "${execution_source}" != "${normalized_source}" ]]; then
  echo "[smoke-execution-fields] execution_source mismatch: ${execution_source} != ${normalized_source}."
  echo "${infer_resp}"
  exit 1
fi

echo "[smoke-execution-fields] PASS"
echo "local_job_id=${local_job_id}"
echo "local_mode=${local_mode}"
echo "sim_job_id=${sim_job_id}"
echo "sim_mode=${sim_mode}"
echo "execution_source=${execution_source}"
