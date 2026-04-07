#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-training-worker-health-penalty] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-training-worker-health-penalty] python3 is required."
  exit 1
fi

pick_port() {
  python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-$(pick_port)}"
WORKER_HOST="127.0.0.1"
WORKER_PORT="${WORKER_PORT:-$(pick_port)}"
DEAD_WORKER_PORT="${DEAD_WORKER_PORT:-$(pick_port)}"
BASE_URL="http://${API_HOST}:${API_PORT}"
WORKER_TOKEN="${WORKER_TOKEN:-smoke-worker-health-token}"

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
TRAINING_WORKER_FAILURE_PENALTY_WINDOW_MS=1800000 \
TRAINING_WORKER_FAILURE_COOLDOWN_MS=600000 \
TRAINING_WORKER_FAILURE_PENALTY_STEP=1 \
TRAINING_WORKER_FAILURE_PENALTY_CAP=2 \
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
  echo "[smoke-training-worker-health-penalty] API failed to start."
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
  echo "[smoke-training-worker-health-penalty] Worker API failed to start."
  cat "${WORKER_LOG}"
  exit 1
fi

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"admin","password":"mock-pass-admin"}')"
if [[ "$(echo "${login_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-training-worker-health-penalty] admin login failed."
  echo "${login_resp}"
  exit 1
fi

csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-training-worker-health-penalty] failed to obtain CSRF token."
  echo "${csrf_resp}"
  exit 1
fi

dead_worker_endpoint="http://${WORKER_HOST}:${DEAD_WORKER_PORT}"
live_worker_endpoint="http://${WORKER_HOST}:${WORKER_PORT}"

create_dead_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/admin/training-workers" \
  -d "{\"name\":\"dead-worker\",\"endpoint\":\"${dead_worker_endpoint}\",\"max_concurrency\":1,\"enabled\":true,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
dead_worker_id="$(echo "${create_dead_worker_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dead_worker_id}" ]]; then
  echo "[smoke-training-worker-health-penalty] failed to create dead worker."
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
  echo "[smoke-training-worker-health-penalty] failed to create live worker."
  echo "${create_live_worker_resp}"
  exit 1
fi

dead_heartbeat_resp="$(curl -sS \
  -H "Content-Type: application/json" \
  -H "X-Training-Worker-Token: ${WORKER_TOKEN}" \
  -X POST "${BASE_URL}/api/runtime/training-workers/heartbeat" \
  -d "{\"worker_id\":\"${dead_worker_id}\",\"name\":\"dead-worker\",\"endpoint\":\"${dead_worker_endpoint}\",\"status\":\"online\",\"enabled\":true,\"max_concurrency\":1,\"reported_load\":0.01,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
if [[ "$(echo "${dead_heartbeat_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-training-worker-health-penalty] dead worker heartbeat failed."
  echo "${dead_heartbeat_resp}"
  exit 1
fi

live_heartbeat_resp="$(curl -sS \
  -H "Content-Type: application/json" \
  -H "X-Training-Worker-Token: ${WORKER_TOKEN}" \
  -X POST "${BASE_URL}/api/runtime/training-workers/heartbeat" \
  -d "{\"worker_id\":\"${live_worker_id}\",\"name\":\"live-worker\",\"endpoint\":\"${live_worker_endpoint}\",\"status\":\"online\",\"enabled\":true,\"max_concurrency\":1,\"reported_load\":0.9,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
if [[ "$(echo "${live_heartbeat_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-training-worker-health-penalty] live worker heartbeat failed."
  echo "${live_heartbeat_resp}"
  exit 1
fi

create_job_a_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d '{"name":"penalty-seed-job","task_type":"detection","framework":"yolo","dataset_id":"d-2","dataset_version_id":"dv-2","base_model":"yolo11n","config":{"epochs":"2","batch_size":"1"}}')"
job_a_id="$(echo "${create_job_a_resp}" | jq -r '.data.id // empty')"
job_a_worker_id="$(echo "${create_job_a_resp}" | jq -r '.data.scheduled_worker_id // empty')"
if [[ -z "${job_a_id}" || "${job_a_worker_id}" != "${dead_worker_id}" ]]; then
  echo "[smoke-training-worker-health-penalty] expected first job to pick dead worker."
  echo "${create_job_a_resp}"
  exit 1
fi

job_a_status=""
for _ in {1..220}; do
  detail_a_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_a_id}")"
  if [[ "$(echo "${detail_a_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-worker-health-penalty] failed to fetch job A detail."
    echo "${detail_a_resp}"
    exit 1
  fi
  job_a_status="$(echo "${detail_a_resp}" | jq -r '.data.job.status // empty')"
  if [[ "${job_a_status}" == "completed" ]]; then
    break
  fi
  if [[ "${job_a_status}" == "failed" || "${job_a_status}" == "cancelled" ]]; then
    echo "[smoke-training-worker-health-penalty] job A ended in unexpected status: ${job_a_status}"
    echo "${detail_a_resp}"
    exit 1
  fi
  sleep 0.4
done

if [[ "${job_a_status}" != "completed" ]]; then
  echo "[smoke-training-worker-health-penalty] job A did not complete in time."
  echo "${detail_a_resp}"
  exit 1
fi

create_job_b_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d '{"name":"penalty-followup-job","task_type":"detection","framework":"yolo","dataset_id":"d-2","dataset_version_id":"dv-2","base_model":"yolo11n","config":{"epochs":"1","batch_size":"1"}}')"
job_b_id="$(echo "${create_job_b_resp}" | jq -r '.data.id // empty')"
job_b_worker_id="$(echo "${create_job_b_resp}" | jq -r '.data.scheduled_worker_id // empty')"
if [[ -z "${job_b_id}" || "${job_b_worker_id}" != "${live_worker_id}" ]]; then
  echo "[smoke-training-worker-health-penalty] expected second job to avoid failed worker and pick live worker."
  echo "${create_job_b_resp}"
  exit 1
fi

echo "[smoke-training-worker-health-penalty] PASS"
echo "job_a_id=${job_a_id}"
echo "job_b_id=${job_b_id}"
echo "failed_worker=${dead_worker_id}"
echo "selected_worker_after_penalty=${job_b_worker_id}"
