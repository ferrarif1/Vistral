#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/lib/smoke-training-worker-common.sh"

API_HOST="${API_HOST:-127.0.0.1}"
if [[ -z "${API_PORT:-}" ]]; then
  API_PORT="$(smoke_pick_port)"
fi
BASE_URL="http://${API_HOST}:${API_PORT}"
WORKER_TOKEN="${WORKER_TOKEN:-smoke-training-worker-token}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-training-worker-scheduler] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-training-worker-scheduler] python3 is required."
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

APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
TRAINING_WORKER_SHARED_TOKEN="${WORKER_TOKEN}" \
API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
npm run dev:api >"${API_LOG}" 2>&1 &
API_PID=$!

for _ in {1..120}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
  echo "[smoke-training-worker-scheduler] API process exited before health check."
  cat "${API_LOG}"
  exit 1
fi

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-training-worker-scheduler] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"admin","password":"mock-pass-admin"}')"
login_ok="$(echo "${login_resp}" | jq -r '.success // false')"
if [[ "${login_ok}" != "true" ]]; then
  echo "[smoke-training-worker-scheduler] admin login failed."
  echo "${login_resp}"
  exit 1
fi

csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-training-worker-scheduler] failed to obtain CSRF token."
  echo "${csrf_resp}"
  exit 1
fi

resolve_detection_training_target "${BASE_URL}" "${COOKIE_FILE}" "smoke-training-worker-scheduler"

create_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/admin/training-workers" \
  -d '{"name":"gpu-worker-b","endpoint":"http://10.0.0.22:9090","max_concurrency":2,"enabled":true,"capabilities":["framework:yolo","task:detection"]}')"
worker_id="$(echo "${create_worker_resp}" | jq -r '.data.id // empty')"
if [[ -z "${worker_id}" ]]; then
  echo "[smoke-training-worker-scheduler] failed to create training worker."
  echo "${create_worker_resp}"
  exit 1
fi

heartbeat_resp="$(curl -sS \
  -H "Content-Type: application/json" \
  -H "X-Training-Worker-Token: ${WORKER_TOKEN}" \
  -X POST "${BASE_URL}/api/runtime/training-workers/heartbeat" \
  -d "{\"worker_id\":\"${worker_id}\",\"name\":\"gpu-worker-b\",\"endpoint\":\"http://10.0.0.22:9090\",\"status\":\"online\",\"enabled\":true,\"max_concurrency\":2,\"reported_load\":0.18,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
heartbeat_ok="$(echo "${heartbeat_resp}" | jq -r '.success // false')"
if [[ "${heartbeat_ok}" != "true" ]]; then
  echo "[smoke-training-worker-scheduler] worker heartbeat failed."
  echo "${heartbeat_resp}"
  exit 1
fi

job_1_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"worker-scheduled-job\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${TRAINING_DATASET_ID}\",\"dataset_version_id\":\"${TRAINING_DATASET_VERSION_ID}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"1\",\"batch_size\":\"1\"}}")"
job_1_target="$(echo "${job_1_resp}" | jq -r '.data.execution_target // empty')"
job_1_worker_id="$(echo "${job_1_resp}" | jq -r '.data.scheduled_worker_id // empty')"
if [[ "${job_1_target}" != "worker" || "${job_1_worker_id}" != "${worker_id}" ]]; then
  echo "[smoke-training-worker-scheduler] expected first job to be scheduled to worker."
  echo "${job_1_resp}"
  exit 1
fi

offline_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X PATCH "${BASE_URL}/api/admin/training-workers/${worker_id}" \
  -d '{"status":"offline","enabled":false}')"
offline_status="$(echo "${offline_worker_resp}" | jq -r '.data.status // empty')"
if [[ "${offline_status}" != "offline" ]]; then
  echo "[smoke-training-worker-scheduler] failed to set worker offline."
  echo "${offline_worker_resp}"
  exit 1
fi

job_2_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"fallback-local-job\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${TRAINING_DATASET_ID}\",\"dataset_version_id\":\"${TRAINING_DATASET_VERSION_ID}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"1\",\"batch_size\":\"1\"}}")"
job_2_target="$(echo "${job_2_resp}" | jq -r '.data.execution_target // empty')"
job_2_worker_id="$(echo "${job_2_resp}" | jq -r '.data.scheduled_worker_id // empty')"
if [[ "${job_2_target}" != "control_plane" || -n "${job_2_worker_id}" ]]; then
  echo "[smoke-training-worker-scheduler] expected second job to fallback to control plane."
  echo "${job_2_resp}"
  exit 1
fi

echo "[smoke-training-worker-scheduler] PASS"
echo "worker_id=${worker_id}"
echo "job_1_target=${job_1_target}"
echo "job_2_target=${job_2_target}"
echo "training_dataset_id=${TRAINING_DATASET_ID}"
echo "training_dataset_version_id=${TRAINING_DATASET_VERSION_ID}"
