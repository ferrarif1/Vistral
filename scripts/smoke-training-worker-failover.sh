#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/lib/smoke-training-worker-common.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-training-worker-failover] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-training-worker-failover] python3 is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-$(smoke_pick_port)}"
WORKER_HOST="127.0.0.1"
WORKER_PORT="${WORKER_PORT:-$(smoke_pick_port)}"
DEAD_WORKER_PORT="${DEAD_WORKER_PORT:-$(smoke_pick_port)}"
BASE_URL="http://${API_HOST}:${API_PORT}"
WORKER_TOKEN="${WORKER_TOKEN:-smoke-worker-failover-token}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
WORKER_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
API_PID=""
WORKER_PID=""

cleanup() {
  if [[ -n "${WORKER_PID}" ]]; then
    kill "${WORKER_PID}" >/dev/null 2>&1 || true
    wait "${WORKER_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${WORKER_LOG}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
TRAINING_WORKER_SHARED_TOKEN="${WORKER_TOKEN}" \
TRAINING_WORKER_DISPATCH_TIMEOUT_MS=120000 \
TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL=0 \
TRAINING_WORKER_DISPATCH_MAX_ATTEMPTS=3 \
TRAINING_WORKER_DISPATCH_RETRY_BASE_MS=120 \
TRAINING_WORKER_DISPATCH_BASE_URL="${BASE_URL}" \
API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
npm run dev:api >"${API_LOG}" 2>&1 &
API_PID=$!

TRAINING_WORKER_SHARED_TOKEN="${WORKER_TOKEN}" \
WORKER_BIND_HOST="${WORKER_HOST}" \
WORKER_BIND_PORT="${WORKER_PORT}" \
WORKER_REPO_ROOT="${ROOT_DIR}" \
WORKER_RUN_ROOT="${APP_DATA_DIR}/worker-runs" \
python3 training-worker/scripts/worker-train-api.py >"${WORKER_LOG}" 2>&1 &
WORKER_PID=$!

for _ in {1..150}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-training-worker-failover] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

for _ in {1..100}; do
  if curl -fsS "http://${WORKER_HOST}:${WORKER_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if ! curl -fsS "http://${WORKER_HOST}:${WORKER_PORT}/healthz" >/dev/null 2>&1; then
  echo "[smoke-training-worker-failover] Worker API failed to start."
  cat "${WORKER_LOG}"
  exit 1
fi

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"admin","password":"mock-pass-admin"}')"
if [[ "$(echo "${login_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-training-worker-failover] admin login failed."
  echo "${login_resp}"
  exit 1
fi

csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-training-worker-failover] failed to obtain CSRF token."
  echo "${csrf_resp}"
  exit 1
fi

resolve_detection_training_target "${BASE_URL}" "${COOKIE_FILE}" "smoke-training-worker-failover"

dead_worker_endpoint="http://${WORKER_HOST}:${DEAD_WORKER_PORT}"
live_worker_endpoint="http://${WORKER_HOST}:${WORKER_PORT}"

create_dead_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/admin/training-workers" \
  -d "{\"name\":\"dead-worker\",\"endpoint\":\"${dead_worker_endpoint}\",\"max_concurrency\":1,\"enabled\":true,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
dead_worker_id="$(echo "${create_dead_worker_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dead_worker_id}" ]]; then
  echo "[smoke-training-worker-failover] failed to create dead worker."
  echo "${create_dead_worker_resp}"
  exit 1
fi

create_live_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/admin/training-workers" \
  -d "{\"name\":\"live-worker\",\"endpoint\":\"${live_worker_endpoint}\",\"max_concurrency\":1,\"enabled\":true,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
live_worker_id="$(echo "${create_live_worker_resp}" | jq -r '.data.id // empty')"
if [[ -z "${live_worker_id}" ]]; then
  echo "[smoke-training-worker-failover] failed to create live worker."
  echo "${create_live_worker_resp}"
  exit 1
fi

dead_heartbeat_resp="$(curl -sS \
  -H "Content-Type: application/json" \
  -H "X-Training-Worker-Token: ${WORKER_TOKEN}" \
  -X POST "${BASE_URL}/api/runtime/training-workers/heartbeat" \
  -d "{\"worker_id\":\"${dead_worker_id}\",\"name\":\"dead-worker\",\"endpoint\":\"${dead_worker_endpoint}\",\"status\":\"online\",\"enabled\":true,\"max_concurrency\":1,\"reported_load\":0.01,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
if [[ "$(echo "${dead_heartbeat_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-training-worker-failover] dead worker heartbeat failed."
  echo "${dead_heartbeat_resp}"
  exit 1
fi

live_heartbeat_resp="$(curl -sS \
  -H "Content-Type: application/json" \
  -H "X-Training-Worker-Token: ${WORKER_TOKEN}" \
  -X POST "${BASE_URL}/api/runtime/training-workers/heartbeat" \
  -d "{\"worker_id\":\"${live_worker_id}\",\"name\":\"live-worker\",\"endpoint\":\"${live_worker_endpoint}\",\"status\":\"online\",\"enabled\":true,\"max_concurrency\":1,\"reported_load\":0.8,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
if [[ "$(echo "${live_heartbeat_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-training-worker-failover] live worker heartbeat failed."
  echo "${live_heartbeat_resp}"
  exit 1
fi

create_job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"failover-worker-job\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${TRAINING_DATASET_ID}\",\"dataset_version_id\":\"${TRAINING_DATASET_VERSION_ID}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"2\",\"batch_size\":\"1\"}}")"
job_id="$(echo "${create_job_resp}" | jq -r '.data.id // empty')"
scheduled_worker_id="$(echo "${create_job_resp}" | jq -r '.data.scheduled_worker_id // empty')"
if [[ -z "${job_id}" || "${scheduled_worker_id}" != "${dead_worker_id}" ]]; then
  echo "[smoke-training-worker-failover] expected initial scheduler pick to be dead worker."
  echo "${create_job_resp}"
  exit 1
fi

job_status=""
for _ in {1..220}; do
  detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  if [[ "$(echo "${detail_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-worker-failover] failed to fetch job detail."
    echo "${detail_resp}"
    exit 1
  fi
  job_status="$(echo "${detail_resp}" | jq -r '.data.job.status // empty')"
  if [[ "${job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
    echo "[smoke-training-worker-failover] job ended in unexpected status: ${job_status}"
    echo "${detail_resp}"
    exit 1
  fi
  sleep 0.4
done

if [[ "${job_status}" != "completed" ]]; then
  echo "[smoke-training-worker-failover] job did not complete in time."
  echo "${detail_resp}"
  exit 1
fi

failed_log_count="$(echo "${detail_resp}" | jq -r --arg worker "${dead_worker_id}" '[.data.logs[] | select(test("Worker dispatch failed") and contains($worker))] | length')"
rescheduled_log_count="$(echo "${detail_resp}" | jq -r '[.data.logs[] | select(test("Rescheduled worker dispatch"))] | length')"
completed_worker_id="$(echo "${detail_resp}" | jq -r '.data.job.scheduled_worker_id // empty')"
scheduler_history_len="$(echo "${detail_resp}" | jq -r '.data.job.scheduler_decision_history | length')"
has_redispatch_history="$(echo "${detail_resp}" | jq -r '[.data.job.scheduler_decision_history[] | select(.trigger == "dispatch_redispatch")] | length')"
if [[ "${failed_log_count}" -le 0 || "${rescheduled_log_count}" -le 0 || "${completed_worker_id}" != "${live_worker_id}" || "${scheduler_history_len}" -lt 2 || "${has_redispatch_history}" -le 0 ]]; then
  echo "[smoke-training-worker-failover] failover evidence not found."
  echo "${detail_resp}"
  exit 1
fi

echo "[smoke-training-worker-failover] PASS"
echo "job_id=${job_id}"
echo "failed_worker=${dead_worker_id}"
echo "rescheduled_worker=${live_worker_id}"
echo "training_dataset_id=${TRAINING_DATASET_ID}"
echo "training_dataset_version_id=${TRAINING_DATASET_VERSION_ID}"
