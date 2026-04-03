#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
BASE_URL="http://${API_HOST}:${API_PORT}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-restart-resume] jq is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
APP_STATE_FILE="${APP_DATA_DIR}/app-state.json"
UPLOAD_ROOT="${APP_DATA_DIR}/uploads"
TRAINING_ROOT="${APP_DATA_DIR}/training"
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

start_api() {
  APP_STATE_STORE_PATH="${APP_STATE_FILE}" \
  UPLOAD_STORAGE_ROOT="${UPLOAD_ROOT}" \
  TRAINING_WORKDIR_ROOT="${TRAINING_ROOT}" \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >>"${API_LOG}" 2>&1 &
  API_PID=$!

  for _ in {1..100}; do
    if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  echo "[smoke-restart-resume] API failed to start."
  cat "${API_LOG}"
  return 1
}

stop_api() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
    API_PID=""
  fi
}

cd "${ROOT_DIR}"

start_api

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-restart-resume] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d '{"name":"restart-resume-yolo","task_type":"detection","framework":"yolo","dataset_id":"d-2","dataset_version_id":"dv-2","base_model":"yolo11n","config":{"epochs":"40","batch_size":"2","learning_rate":"0.0008"}}')"
job_id="$(echo "${train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${job_id}" ]]; then
  echo "[smoke-restart-resume] failed to create training job."
  echo "${train_resp}"
  exit 1
fi

job_status=""
for _ in {1..80}; do
  detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  job_status="$(echo "${detail}" | jq -r '.data.job.status // empty')"
  if [[ "${job_status}" == "running" || "${job_status}" == "evaluating" || "${job_status}" == "preparing" ]]; then
    break
  fi
  if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
    echo "[smoke-restart-resume] job ended unexpectedly before restart: ${job_status}."
    echo "${detail}"
    exit 1
  fi
  sleep 0.2
done

if [[ "${job_status}" != "running" && "${job_status}" != "evaluating" && "${job_status}" != "preparing" ]]; then
  echo "[smoke-restart-resume] job did not reach active status before restart."
  exit 1
fi

stop_api

for _ in {1..100}; do
  [[ -f "${APP_STATE_FILE}" ]] && break
  sleep 0.1
done

if [[ ! -f "${APP_STATE_FILE}" ]]; then
  echo "[smoke-restart-resume] app state file was not persisted before restart."
  exit 1
fi

start_api

final_detail=""
final_status=""
for _ in {1..140}; do
  final_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  final_status="$(echo "${final_detail}" | jq -r '.data.job.status // empty')"
  if [[ "${final_status}" == "completed" ]]; then
    break
  fi
  if [[ "${final_status}" == "failed" || "${final_status}" == "cancelled" ]]; then
    echo "[smoke-restart-resume] resumed job ended in ${final_status}."
    echo "${final_detail}"
    exit 1
  fi
  sleep 0.25
done

if [[ "${final_status}" != "completed" ]]; then
  echo "[smoke-restart-resume] resumed job did not complete in time."
  echo "${final_detail}"
  exit 1
fi

metric_count="$(echo "${final_detail}" | jq -r '.data.metrics | length // 0')"
log_count="$(echo "${final_detail}" | jq -r '.data.logs | length // 0')"
if [[ "${metric_count}" -lt 1 || "${log_count}" -lt 3 ]]; then
  echo "[smoke-restart-resume] resumed job missing logs or metrics."
  echo "${final_detail}"
  exit 1
fi

echo "[smoke-restart-resume] PASS"
echo "job_id=${job_id}"
echo "final_status=${final_status}"
