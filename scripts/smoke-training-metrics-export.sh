#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
BASE_URL="http://${API_HOST}:${API_PORT}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-training-metrics-export] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-training-metrics-export] python3 is required."
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
  echo "[smoke-training-metrics-export] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-training-metrics-export] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d '{"name":"metrics-export-test","task_type":"detection","framework":"yolo","dataset_id":"d-2","dataset_version_id":"dv-2","base_model":"yolo11n","config":{"epochs":"9","batch_size":"2","learning_rate":"0.0007"}}')"
job_id="$(echo "${train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${job_id}" ]]; then
  echo "[smoke-training-metrics-export] training job create failed."
  echo "${train_resp}"
  exit 1
fi

status=""
detail=""
for _ in {1..140}; do
  detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  status="$(echo "${detail}" | jq -r '.data.job.status // empty')"
  if [[ "${status}" == "completed" ]]; then
    break
  fi
  if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
    echo "[smoke-training-metrics-export] training job ended with ${status}."
    echo "${detail}"
    exit 1
  fi
  sleep 0.25
done

if [[ "${status}" != "completed" ]]; then
  echo "[smoke-training-metrics-export] training job timeout."
  echo "${detail}"
  exit 1
fi

export_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}/metrics-export")"
export_job_id="$(echo "${export_resp}" | jq -r '.data.job_id // empty')"
rows="$(echo "${export_resp}" | jq -r '.data.total_rows // empty')"
map_latest="$(echo "${export_resp}" | jq -r '.data.latest_metrics.map // empty')"
map_points="$(echo "${export_resp}" | jq -r '.data.metrics_by_name.map | length // 0')"

if [[ "${export_job_id}" != "${job_id}" ]]; then
  echo "[smoke-training-metrics-export] export job_id mismatch: ${export_job_id} != ${job_id}."
  echo "${export_resp}"
  exit 1
fi
if [[ -z "${rows}" || "${rows}" -le 0 ]]; then
  echo "[smoke-training-metrics-export] expected total_rows > 0, got ${rows}."
  echo "${export_resp}"
  exit 1
fi
if [[ -z "${map_latest}" ]]; then
  echo "[smoke-training-metrics-export] expected latest map metric."
  echo "${export_resp}"
  exit 1
fi
if [[ -z "${map_points}" || "${map_points}" -lt 2 ]]; then
  echo "[smoke-training-metrics-export] expected map series length >= 2, got ${map_points}."
  echo "${export_resp}"
  exit 1
fi

echo "[smoke-training-metrics-export] PASS"
echo "job_id=${job_id}"
echo "rows=${rows}"
echo "map_latest=${map_latest}"
echo "map_points=${map_points}"
