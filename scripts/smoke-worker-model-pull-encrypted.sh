#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/lib/smoke-training-worker-common.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-worker-model-pull-encrypted] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-worker-model-pull-encrypted] python3 is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-$(smoke_pick_port)}"
WORKER_HOST="127.0.0.1"
WORKER_PORT="${WORKER_PORT:-$(smoke_pick_port)}"
BASE_URL="http://${API_HOST}:${API_PORT}"
WORKER_TOKEN="${WORKER_TOKEN:-smoke-worker-pull-token}"
RUNTIME_API_KEY="${RUNTIME_API_KEY:-smoke-yolo-public-key}"
DELIVERY_KEY="${DELIVERY_KEY:-smoke-delivery-key-123}"
LOGIN_USERNAME="${LOGIN_USERNAME:-alice}"
LOGIN_PASSWORD="${LOGIN_PASSWORD:-mock-pass}"
TRAINING_DATASET_ID="${TRAINING_DATASET_ID:-}"
TRAINING_DATASET_VERSION_ID="${TRAINING_DATASET_VERSION_ID:-}"
TRAINING_MODEL_ID="${TRAINING_MODEL_ID:-}"

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
MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1 \
YOLO_RUNTIME_API_KEY="${RUNTIME_API_KEY}" \
API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
npm run dev:api >"${API_LOG}" 2>&1 &
API_PID=$!

TRAINING_WORKER_AUTH_TOKEN="${WORKER_TOKEN}" \
CONTROL_PLANE_BASE_URL="${BASE_URL}" \
WORKER_BIND_HOST="${WORKER_HOST}" \
WORKER_BIND_PORT="${WORKER_PORT}" \
WORKER_REPO_ROOT="${ROOT_DIR}" \
WORKER_RUN_ROOT="${APP_DATA_DIR}/worker-runs" \
WORKER_MODEL_STORE_ROOT="${APP_DATA_DIR}/worker-models" \
WORKER_RUNTIME_PUBLIC_API_KEY="${RUNTIME_API_KEY}" \
WORKER_MODEL_DELIVERY_ENCRYPTION_KEY="${DELIVERY_KEY}" \
WORKER_MODEL_PACKAGE_DOWNLOAD_TIMEOUT_SECONDS=30 \
python3 training-worker/scripts/worker-train-api.py >"${WORKER_LOG}" 2>&1 &
WORKER_PID=$!

for _ in {1..180}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-worker-model-pull-encrypted] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

for _ in {1..140}; do
  if curl -fsS "http://${WORKER_HOST}:${WORKER_PORT}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if ! curl -fsS "http://${WORKER_HOST}:${WORKER_PORT}/healthz" >/dev/null 2>&1; then
  echo "[smoke-worker-model-pull-encrypted] Worker API failed to start."
  cat "${WORKER_LOG}"
  exit 1
fi

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${LOGIN_USERNAME}\",\"password\":\"${LOGIN_PASSWORD}\"}")"
if [[ "$(echo "${login_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-worker-model-pull-encrypted] login failed."
  echo "${login_resp}"
  exit 1
fi

csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-worker-model-pull-encrypted] failed to obtain CSRF token."
  echo "${csrf_resp}"
  exit 1
fi

if [[ -z "${TRAINING_DATASET_ID}" || -z "${TRAINING_DATASET_VERSION_ID}" ]]; then
  resolve_detection_training_target "${BASE_URL}" "${COOKIE_FILE}" "smoke-worker-model-pull-encrypted"
fi

if [[ -z "${TRAINING_MODEL_ID}" ]]; then
  models_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/models/my")"
  TRAINING_MODEL_ID="$(echo "${models_resp}" | jq -r '.data[] | select(.model_type=="detection") | .id' | head -n 1)"
  if [[ -z "${TRAINING_MODEL_ID}" ]]; then
    model_name="smoke-worker-pull-model-$(date +%s)"
    create_model_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
      -H "Content-Type: application/json" \
      -H "X-CSRF-Token: ${csrf_token}" \
      -X POST "${BASE_URL}/api/models/draft" \
      -d "{\"name\":\"${model_name}\",\"description\":\"smoke worker pull model\",\"model_type\":\"detection\",\"visibility\":\"workspace\"}")"
    TRAINING_MODEL_ID="$(echo "${create_model_resp}" | jq -r '.data.id // empty')"
    if [[ -z "${TRAINING_MODEL_ID}" ]]; then
      echo "[smoke-worker-model-pull-encrypted] failed to resolve or create detection model."
      echo "${models_resp}"
      echo "${create_model_resp}"
      exit 1
    fi
  fi
fi

job_name="smoke-worker-pull-$(date +%s)"
create_job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"${job_name}\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${TRAINING_DATASET_ID}\",\"dataset_version_id\":\"${TRAINING_DATASET_VERSION_ID}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"1\",\"batch_size\":\"1\"}}")"
job_id="$(echo "${create_job_resp}" | jq -r '.data.id // empty')"
if [[ -z "${job_id}" ]]; then
  echo "[smoke-worker-model-pull-encrypted] failed to create training job."
  echo "${create_job_resp}"
  exit 1
fi

job_status=""
for _ in {1..280}; do
  detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  if [[ "$(echo "${detail_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-worker-model-pull-encrypted] failed to fetch training job detail."
    echo "${detail_resp}"
    exit 1
  fi
  job_status="$(echo "${detail_resp}" | jq -r '.data.job.status // empty')"
  if [[ "${job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
    echo "[smoke-worker-model-pull-encrypted] training job ended unexpectedly: ${job_status}"
    echo "${detail_resp}"
    exit 1
  fi
  sleep 0.4
done
if [[ "${job_status}" != "completed" ]]; then
  echo "[smoke-worker-model-pull-encrypted] training job did not complete in time."
  echo "${detail_resp}"
  exit 1
fi

version_name="smoke-pull-$(date +%s)"
register_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/model-versions/register" \
  -d "{\"model_id\":\"${TRAINING_MODEL_ID}\",\"training_job_id\":\"${job_id}\",\"version_name\":\"${version_name}\"}")"
model_version_id="$(echo "${register_resp}" | jq -r '.data.id // empty')"
if [[ -z "${model_version_id}" ]]; then
  echo "[smoke-worker-model-pull-encrypted] model version registration failed."
  echo "${register_resp}"
  exit 1
fi

pull_resp="$(curl -sS \
  -H "Content-Type: application/json" \
  -H "X-Training-Worker-Token: ${WORKER_TOKEN}" \
  -X POST "http://${WORKER_HOST}:${WORKER_PORT}/api/worker/models/pull-encrypted" \
  -d "{\"model_version_id\":\"${model_version_id}\",\"output_relative_dir\":\"smoke-pull\",\"overwrite\":true}")"
pull_ok="$(echo "${pull_resp}" | jq -r '.accepted // false')"
local_model_path="$(echo "${pull_resp}" | jq -r '.deployment.local_model_path // empty')"
metadata_path="$(echo "${pull_resp}" | jq -r '.metadata_path // empty')"
binding="$(echo "${pull_resp}" | jq -r '.deployment.runtime_auth_binding // empty')"
sha256="$(echo "${pull_resp}" | jq -r '.deployment.sha256 // empty')"
if [[ "${pull_ok}" != "true" || -z "${local_model_path}" || -z "${metadata_path}" ]]; then
  echo "[smoke-worker-model-pull-encrypted] worker model pull/deploy failed."
  echo "${pull_resp}"
  exit 1
fi
if [[ ! -f "${local_model_path}" ]]; then
  echo "[smoke-worker-model-pull-encrypted] deployed model file not found: ${local_model_path}"
  echo "${pull_resp}"
  exit 1
fi
if [[ ! -f "${metadata_path}" ]]; then
  echo "[smoke-worker-model-pull-encrypted] deployment metadata file not found: ${metadata_path}"
  echo "${pull_resp}"
  exit 1
fi
if [[ -z "${binding}" ]]; then
  echo "[smoke-worker-model-pull-encrypted] deployment metadata missing runtime_auth_binding."
  echo "${pull_resp}"
  exit 1
fi
if [[ "${#sha256}" -ne 64 ]]; then
  echo "[smoke-worker-model-pull-encrypted] deployment sha256 looks invalid: ${sha256}"
  echo "${pull_resp}"
  exit 1
fi

echo "[smoke-worker-model-pull-encrypted] PASS"
echo "training_job_id=${job_id}"
echo "model_version_id=${model_version_id}"
echo "runtime_auth_binding=${binding}"
echo "local_model_path=${local_model_path}"
echo "metadata_path=${metadata_path}"
