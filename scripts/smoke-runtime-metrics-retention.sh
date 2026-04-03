#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
BASE_URL="http://${API_HOST}:${API_PORT}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-runtime-metrics-retention] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-runtime-metrics-retention] python3 is required."
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
TRAINING_METRICS_MAX_POINTS_PER_JOB=9 \
TRAINING_METRICS_MAX_TOTAL_ROWS=1200 \
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
  echo "[smoke-runtime-metrics-retention] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-runtime-metrics-retention] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d '{"name":"retention-cap-test","task_type":"detection","framework":"yolo","dataset_id":"d-2","dataset_version_id":"dv-2","base_model":"yolo11n","config":{"epochs":"12","batch_size":"2","learning_rate":"0.0007"}}')"
job_id="$(echo "${job_resp}" | jq -r '.data.id // empty')"
if [[ -z "${job_id}" ]]; then
  echo "[smoke-runtime-metrics-retention] training job create failed."
  echo "${job_resp}"
  exit 1
fi

status=""
detail=""
for _ in {1..160}; do
  detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  status="$(echo "${detail}" | jq -r '.data.job.status // empty')"
  if [[ "${status}" == "completed" ]]; then
    break
  fi
  if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
    echo "[smoke-runtime-metrics-retention] training job ended with ${status}."
    echo "${detail}"
    exit 1
  fi
  sleep 0.25
done

if [[ "${status}" != "completed" ]]; then
  echo "[smoke-runtime-metrics-retention] training job timeout."
  echo "${detail}"
  exit 1
fi

metric_rows="$(echo "${detail}" | jq -r '.data.metrics | length')"
metric_names="$(echo "${detail}" | jq -r '[.data.metrics[].metric_name] | unique | length')"
max_allowed_rows=$((metric_names * 9))
if [[ "${metric_rows}" -gt "${max_allowed_rows}" ]]; then
  echo "[smoke-runtime-metrics-retention] metric rows exceed cap: rows=${metric_rows}, unique=${metric_names}, cap=${max_allowed_rows}."
  echo "${detail}"
  exit 1
fi

summary_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/runtime/metrics-retention")"
max_points="$(echo "${summary_resp}" | jq -r '.data.max_points_per_job // empty')"
max_total="$(echo "${summary_resp}" | jq -r '.data.max_total_rows // empty')"
current_total="$(echo "${summary_resp}" | jq -r '.data.current_total_rows // empty')"
if [[ "${max_points}" != "9" ]]; then
  echo "[smoke-runtime-metrics-retention] expected max_points_per_job=9, got ${max_points}."
  echo "${summary_resp}"
  exit 1
fi
if [[ "${max_total}" != "1200" ]]; then
  echo "[smoke-runtime-metrics-retention] expected max_total_rows=1200, got ${max_total}."
  echo "${summary_resp}"
  exit 1
fi
if [[ -z "${current_total}" || "${current_total}" -gt 1200 ]]; then
  echo "[smoke-runtime-metrics-retention] current_total_rows invalid: ${current_total}."
  echo "${summary_resp}"
  exit 1
fi

echo "[smoke-runtime-metrics-retention] PASS"
echo "job_id=${job_id}"
echo "metric_rows=${metric_rows}"
echo "max_allowed_rows=${max_allowed_rows}"
echo "current_total_rows=${current_total}"
