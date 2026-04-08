#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/lib/smoke-training-worker-common.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-training-worker-package-reference] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-training-worker-package-reference] python3 is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-$(smoke_pick_port)}"
WORKER_HOST="127.0.0.1"
WORKER_PORT="${WORKER_PORT:-$(smoke_pick_port)}"
BASE_URL="http://${API_HOST}:${API_PORT}"
WORKER_TOKEN="${WORKER_TOKEN:-smoke-worker-reference-token}"

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
TRAINING_WORKER_DISPATCH_TIMEOUT_MS=90000 \
TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL=0 \
TRAINING_WORKER_DISPATCH_BASE_URL="${BASE_URL}" \
TRAINING_WORKER_INLINE_PACKAGE_MAX_BYTES=1 \
API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
npm run dev:api >"${API_LOG}" 2>&1 &
API_PID=$!

TRAINING_WORKER_SHARED_TOKEN="${WORKER_TOKEN}" \
CONTROL_PLANE_BASE_URL="${BASE_URL}" \
WORKER_BIND_HOST="${WORKER_HOST}" \
WORKER_BIND_PORT="${WORKER_PORT}" \
WORKER_REPO_ROOT="${ROOT_DIR}" \
WORKER_RUN_ROOT="${APP_DATA_DIR}/worker-runs" \
WORKER_PACKAGE_DOWNLOAD_TIMEOUT_SECONDS=20 \
python3 training-worker/scripts/worker-train-api.py >"${WORKER_LOG}" 2>&1 &
WORKER_PID=$!

for _ in {1..150}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-training-worker-package-reference] API failed to start."
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
  echo "[smoke-training-worker-package-reference] Worker API failed to start."
  cat "${WORKER_LOG}"
  exit 1
fi

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"admin","password":"mock-pass-admin"}')"
if [[ "$(echo "${login_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-training-worker-package-reference] admin login failed."
  echo "${login_resp}"
  exit 1
fi

csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-training-worker-package-reference] failed to obtain CSRF token."
  echo "${csrf_resp}"
  exit 1
fi

resolve_detection_training_target "${BASE_URL}" "${COOKIE_FILE}" "smoke-training-worker-package-reference"

worker_endpoint="http://${WORKER_HOST}:${WORKER_PORT}"
create_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/admin/training-workers" \
  -d "{\"name\":\"reference-worker\",\"endpoint\":\"${worker_endpoint}\",\"max_concurrency\":1,\"enabled\":true,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
worker_id="$(echo "${create_worker_resp}" | jq -r '.data.id // empty')"
if [[ -z "${worker_id}" ]]; then
  echo "[smoke-training-worker-package-reference] failed to create worker."
  echo "${create_worker_resp}"
  exit 1
fi

heartbeat_resp="$(curl -sS \
  -H "Content-Type: application/json" \
  -H "X-Training-Worker-Token: ${WORKER_TOKEN}" \
  -X POST "${BASE_URL}/api/runtime/training-workers/heartbeat" \
  -d "{\"worker_id\":\"${worker_id}\",\"name\":\"reference-worker\",\"endpoint\":\"${worker_endpoint}\",\"status\":\"online\",\"enabled\":true,\"max_concurrency\":1,\"reported_load\":0.05,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
if [[ "$(echo "${heartbeat_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-training-worker-package-reference] heartbeat failed."
  echo "${heartbeat_resp}"
  exit 1
fi

create_job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"reference-worker-job\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${TRAINING_DATASET_ID}\",\"dataset_version_id\":\"${TRAINING_DATASET_VERSION_ID}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"2\",\"batch_size\":\"1\"}}")"
job_id="$(echo "${create_job_resp}" | jq -r '.data.id // empty')"
execution_target="$(echo "${create_job_resp}" | jq -r '.data.execution_target // empty')"
if [[ -z "${job_id}" || "${execution_target}" != "worker" ]]; then
  echo "[smoke-training-worker-package-reference] job was not scheduled to worker."
  echo "${create_job_resp}"
  exit 1
fi

job_status=""
for _ in {1..180}; do
  detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  if [[ "$(echo "${detail_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-worker-package-reference] failed to fetch job detail."
    echo "${detail_resp}"
    exit 1
  fi
  job_status="$(echo "${detail_resp}" | jq -r '.data.job.status // empty')"
  if [[ "${job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
    echo "[smoke-training-worker-package-reference] unexpected final status: ${job_status}"
    echo "${detail_resp}"
    exit 1
  fi
  sleep 0.4
done

if [[ "${job_status}" != "completed" ]]; then
  echo "[smoke-training-worker-package-reference] job did not complete in time."
  echo "${detail_resp}"
  exit 1
fi

reference_log_count="$(echo "${detail_resp}" | jq -r '[.data.logs[] | select(test("referenced dataset package"))] | length')"
if [[ "${reference_log_count}" -le 0 ]]; then
  echo "[smoke-training-worker-package-reference] expected referenced package log not found."
  echo "${detail_resp}"
  exit 1
fi

echo "[smoke-training-worker-package-reference] PASS"
echo "job_id=${job_id}"
echo "status=${job_status}"
echo "reference_log_count=${reference_log_count}"
echo "training_dataset_id=${TRAINING_DATASET_ID}"
echo "training_dataset_version_id=${TRAINING_DATASET_VERSION_ID}"
