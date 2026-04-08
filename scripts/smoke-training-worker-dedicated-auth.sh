#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/lib/smoke-training-worker-common.sh"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-training-worker-dedicated-auth] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-training-worker-dedicated-auth] python3 is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-$(smoke_pick_port)}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"
START_API="${START_API:-true}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-mock-pass-admin}"
WORKER_PUBLIC_HOST="${WORKER_PUBLIC_HOST:-127.0.0.1}"
WORKER_BIND_HOST="${WORKER_BIND_HOST:-127.0.0.1}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
API_PID=""
WORKER_PIDS=()
WORKER_LOGS=()

cleanup() {
  for pid in "${WORKER_PIDS[@]:-}"; do
    kill "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" >/dev/null 2>&1 || true
  done
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}"
  rm -f "${WORKER_LOGS[@]:-}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

wait_for_url() {
  local url="$1"
  local label="$2"
  local tries="${3:-160}"
  local sleep_seconds="${4:-0.2}"
  for _ in $(seq 1 "${tries}"); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${sleep_seconds}"
  done
  echo "[smoke-training-worker-dedicated-auth] ${label} failed: ${url}"
  return 1
}

start_api() {
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  TRAINING_WORKER_DISPATCH_TIMEOUT_MS=120000 \
  TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL=0 \
  TRAINING_WORKER_DISPATCH_BASE_URL="${BASE_URL}" \
  TRAINING_WORKER_INLINE_PACKAGE_MAX_BYTES=1 \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!

  if ! wait_for_url "${BASE_URL}/api/health" "API" 180 0.2; then
    cat "${API_LOG}"
    exit 1
  fi
}

login_admin() {
  local login_resp
  login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}")"
  if [[ "$(echo "${login_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-worker-dedicated-auth] admin login failed."
    echo "${login_resp}"
    exit 1
  fi
}

csrf_token() {
  curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf" | jq -r '.data.csrf_token // empty'
}

CURRENT_WORKER_ID=""
CURRENT_WORKER_NAME=""
CURRENT_WORKER_ENDPOINT=""
CURRENT_WORKER_TOKEN=""
CURRENT_PAIRING_TOKEN=""

create_and_claim_dedicated_worker() {
  local worker_name="$1"
  local worker_port="$2"
  local csrf="$3"
  local bootstrap_resp claim_resp claimed_endpoint

  CURRENT_WORKER_NAME="${worker_name}"
  CURRENT_WORKER_ENDPOINT="http://${WORKER_PUBLIC_HOST}:${worker_port}"

  bootstrap_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf}" \
    -X POST "${BASE_URL}/api/admin/training-workers/bootstrap-sessions" \
    -d "{\"deployment_mode\":\"script\",\"worker_profile\":\"yolo\",\"control_plane_base_url\":\"${BASE_URL}\",\"worker_name\":\"${worker_name}\",\"worker_public_host\":\"${WORKER_PUBLIC_HOST}\",\"worker_bind_port\":${worker_port},\"max_concurrency\":1}")"
  if [[ "$(echo "${bootstrap_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-worker-dedicated-auth] failed to create bootstrap session."
    echo "${bootstrap_resp}"
    exit 1
  fi

  CURRENT_PAIRING_TOKEN="$(echo "${bootstrap_resp}" | jq -r '.data.pairing_token // empty')"
  CURRENT_WORKER_ID="$(echo "${bootstrap_resp}" | jq -r '.data.worker_id // empty')"
  if [[ -z "${CURRENT_PAIRING_TOKEN}" || -z "${CURRENT_WORKER_ID}" ]]; then
    echo "[smoke-training-worker-dedicated-auth] bootstrap response missing pairing token or worker id."
    echo "${bootstrap_resp}"
    exit 1
  fi

  claim_resp="$(curl -sS \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/runtime/training-workers/bootstrap-sessions/claim" \
    -d "{\"pairing_token\":\"${CURRENT_PAIRING_TOKEN}\"}")"
  if [[ "$(echo "${claim_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-worker-dedicated-auth] bootstrap claim failed."
    echo "${claim_resp}"
    exit 1
  fi

  CURRENT_WORKER_TOKEN="$(echo "${claim_resp}" | jq -r '.data.config_defaults.training_worker_auth_token // empty')"
  claimed_endpoint="$(echo "${claim_resp}" | jq -r '.data.config_defaults.worker_endpoint // empty')"
  if [[ -z "${CURRENT_WORKER_TOKEN}" || "${claimed_endpoint}" != "${CURRENT_WORKER_ENDPOINT}" ]]; then
    echo "[smoke-training-worker-dedicated-auth] claim response missing dedicated token or endpoint hint."
    echo "${claim_resp}"
    exit 1
  fi
}

start_worker_process() {
  local worker_port="$1"
  local run_root="$2"
  local local_train_command="${3:-}"
  local worker_log
  worker_log="$(mktemp)"
  WORKER_LOGS+=("${worker_log}")

  local worker_probe_url
  worker_probe_url="http://127.0.0.1:${worker_port}/healthz"

  if [[ -n "${local_train_command}" ]]; then
    TRAINING_WORKER_AUTH_TOKEN="${CURRENT_WORKER_TOKEN}" \
    CONTROL_PLANE_BASE_URL="${BASE_URL}" \
    WORKER_BIND_HOST="${WORKER_BIND_HOST}" \
    WORKER_BIND_PORT="${worker_port}" \
    WORKER_ID="${CURRENT_WORKER_ID}" \
    WORKER_NAME="${CURRENT_WORKER_NAME}" \
    WORKER_ENDPOINT="${CURRENT_WORKER_ENDPOINT}" \
    WORKER_CAPABILITIES='framework:yolo,task:detection' \
    WORKER_MAX_CONCURRENCY=1 \
    WORKER_REPO_ROOT="${ROOT_DIR}" \
    WORKER_RUN_ROOT="${run_root}" \
    WORKER_PACKAGE_DOWNLOAD_TIMEOUT_SECONDS=20 \
    WORKER_LOCAL_TRAIN_COMMAND="${local_train_command}" \
    python3 training-worker/scripts/worker-train-api.py >"${worker_log}" 2>&1 &
  else
    TRAINING_WORKER_AUTH_TOKEN="${CURRENT_WORKER_TOKEN}" \
    CONTROL_PLANE_BASE_URL="${BASE_URL}" \
    WORKER_BIND_HOST="${WORKER_BIND_HOST}" \
    WORKER_BIND_PORT="${worker_port}" \
    WORKER_ID="${CURRENT_WORKER_ID}" \
    WORKER_NAME="${CURRENT_WORKER_NAME}" \
    WORKER_ENDPOINT="${CURRENT_WORKER_ENDPOINT}" \
    WORKER_CAPABILITIES='framework:yolo,task:detection' \
    WORKER_MAX_CONCURRENCY=1 \
    WORKER_REPO_ROOT="${ROOT_DIR}" \
    WORKER_RUN_ROOT="${run_root}" \
    WORKER_PACKAGE_DOWNLOAD_TIMEOUT_SECONDS=20 \
    python3 training-worker/scripts/worker-train-api.py >"${worker_log}" 2>&1 &
  fi
  WORKER_PIDS+=("$!")

  if ! wait_for_url "${worker_probe_url}" "worker API" 120 0.2; then
    cat "${worker_log}"
    exit 1
  fi
}

send_heartbeat() {
  local heartbeat_resp
  heartbeat_resp="$(curl -sS \
    -H "Content-Type: application/json" \
    -H "X-Training-Worker-Token: ${CURRENT_WORKER_TOKEN}" \
    -X POST "${BASE_URL}/api/runtime/training-workers/heartbeat" \
    -d "{\"worker_id\":\"${CURRENT_WORKER_ID}\",\"name\":\"${CURRENT_WORKER_NAME}\",\"endpoint\":\"${CURRENT_WORKER_ENDPOINT}\",\"status\":\"online\",\"enabled\":true,\"max_concurrency\":1,\"reported_load\":0.05,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
  if [[ "$(echo "${heartbeat_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-worker-dedicated-auth] heartbeat failed."
    echo "${heartbeat_resp}"
    exit 1
  fi
  if [[ "$(echo "${heartbeat_resp}" | jq -r '.data.auth_mode // empty')" != "dedicated" ]]; then
    echo "[smoke-training-worker-dedicated-auth] heartbeat did not expose dedicated auth mode."
    echo "${heartbeat_resp}"
    exit 1
  fi
}

wait_bootstrap_online() {
  local status_resp bootstrap_status
  for _ in {1..60}; do
    status_resp="$(curl -sS \
      -H "Content-Type: application/json" \
      -X POST "${BASE_URL}/api/runtime/training-workers/bootstrap-sessions/status" \
      -d "{\"pairing_token\":\"${CURRENT_PAIRING_TOKEN}\"}")"
    if [[ "$(echo "${status_resp}" | jq -r '.success // false')" != "true" ]]; then
      echo "[smoke-training-worker-dedicated-auth] bootstrap status query failed."
      echo "${status_resp}"
      exit 1
    fi
    bootstrap_status="$(echo "${status_resp}" | jq -r '.data.status // empty')"
    if [[ "${bootstrap_status}" == "online" ]]; then
      return 0
    fi
    sleep 0.3
  done
  echo "[smoke-training-worker-dedicated-auth] bootstrap session did not reach online."
  echo "${status_resp}"
  exit 1
}

disable_worker() {
  local worker_id="$1"
  local csrf="$2"
  local patch_resp
  patch_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf}" \
    -X PATCH "${BASE_URL}/api/admin/training-workers/${worker_id}" \
    -d '{"status":"offline","enabled":false}')"
  if [[ "$(echo "${patch_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-worker-dedicated-auth] failed to disable worker ${worker_id}."
    echo "${patch_resp}"
    exit 1
  fi
}

run_reference_package_flow() {
  local csrf="$1"
  local worker_port="$2"
  local create_job_resp job_id execution_target detail_resp job_status reference_log_count inline_log_count

  create_and_claim_dedicated_worker "dedicated-reference-worker" "${worker_port}" "${csrf}"
  start_worker_process "${worker_port}" "${APP_DATA_DIR}/worker-runs-reference"
  send_heartbeat
  wait_bootstrap_online

  create_job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf}" \
    -X POST "${BASE_URL}/api/training/jobs" \
    -d "{\"name\":\"dedicated-reference-job\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${TRAINING_DATASET_ID}\",\"dataset_version_id\":\"${TRAINING_DATASET_VERSION_ID}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"2\",\"batch_size\":\"1\"}}")"
  job_id="$(echo "${create_job_resp}" | jq -r '.data.id // empty')"
  execution_target="$(echo "${create_job_resp}" | jq -r '.data.execution_target // empty')"
  if [[ -z "${job_id}" || "${execution_target}" != "worker" ]]; then
    echo "[smoke-training-worker-dedicated-auth] dedicated reference job was not scheduled to worker."
    echo "${create_job_resp}"
    exit 1
  fi

  job_status=""
  for _ in {1..180}; do
    detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
    if [[ "$(echo "${detail_resp}" | jq -r '.success // false')" != "true" ]]; then
      echo "[smoke-training-worker-dedicated-auth] failed to fetch reference job detail."
      echo "${detail_resp}"
      exit 1
    fi
    job_status="$(echo "${detail_resp}" | jq -r '.data.job.status // empty')"
    if [[ "${job_status}" == "completed" ]]; then
      break
    fi
    if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
      echo "[smoke-training-worker-dedicated-auth] reference job ended in unexpected status: ${job_status}"
      echo "${detail_resp}"
      exit 1
    fi
    sleep 0.4
  done

  if [[ "${job_status}" != "completed" ]]; then
    echo "[smoke-training-worker-dedicated-auth] reference job did not complete in time."
    echo "${detail_resp}"
    exit 1
  fi

  reference_log_count="$(echo "${detail_resp}" | jq -r '[.data.logs[] | select(test("referenced dataset package|Downloaded referenced dataset package"))] | length')"
  inline_log_count="$(echo "${detail_resp}" | jq -r '[.data.logs[] | select(test("inline dataset package"))] | length')"
  if [[ "${reference_log_count}" -le 0 ]]; then
    if [[ "${START_API}" == "true" || "${START_API}" == "1" ]]; then
      echo "[smoke-training-worker-dedicated-auth] reference package logs not found in local API mode."
      echo "${detail_resp}"
      exit 1
    fi
    if [[ "${inline_log_count}" -le 0 ]]; then
      echo "[smoke-training-worker-dedicated-auth] neither reference-package nor inline-package logs were found."
      echo "${detail_resp}"
      exit 1
    fi
  fi

  echo "reference_worker_id=${CURRENT_WORKER_ID}"
  echo "reference_job_id=${job_id}"
  echo "reference_log_count=${reference_log_count}"
  echo "reference_inline_log_count=${inline_log_count}"

  disable_worker "${CURRENT_WORKER_ID}" "${csrf}"
}

run_cancel_flow() {
  local csrf="$1"
  local worker_port="$2"
  local create_job_resp job_id detail_resp status cancel_resp final_detail final_status cancel_log_count

  create_and_claim_dedicated_worker "dedicated-cancel-worker" "${worker_port}" "${csrf}"
  start_worker_process "${worker_port}" "${APP_DATA_DIR}/worker-runs-cancel" 'python3 -c "import time; time.sleep(30)"'
  send_heartbeat
  wait_bootstrap_online

  create_job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf}" \
    -X POST "${BASE_URL}/api/training/jobs" \
    -d "{\"name\":\"dedicated-cancel-job\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${TRAINING_DATASET_ID}\",\"dataset_version_id\":\"${TRAINING_DATASET_VERSION_ID}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"3\",\"batch_size\":\"1\"}}")"
  job_id="$(echo "${create_job_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${job_id}" ]]; then
    echo "[smoke-training-worker-dedicated-auth] failed to create cancel job."
    echo "${create_job_resp}"
    exit 1
  fi

  for _ in {1..100}; do
    detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
    status="$(echo "${detail_resp}" | jq -r '.data.job.status // empty')"
    if [[ "${status}" == "running" || "${status}" == "preparing" ]]; then
      break
    fi
    sleep 0.2
  done

  cancel_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "X-CSRF-Token: ${csrf}" \
    -X POST "${BASE_URL}/api/training/jobs/${job_id}/cancel")"
  if [[ "$(echo "${cancel_resp}" | jq -r '.success // false')" != "true" || "$(echo "${cancel_resp}" | jq -r '.data.status // empty')" != "cancelled" ]]; then
    echo "[smoke-training-worker-dedicated-auth] cancel request failed."
    echo "${cancel_resp}"
    exit 1
  fi

  final_status=""
  for _ in {1..120}; do
    final_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
    final_status="$(echo "${final_detail}" | jq -r '.data.job.status // empty')"
    if [[ "${final_status}" == "cancelled" ]]; then
      break
    fi
    sleep 0.2
  done

  if [[ "${final_status}" != "cancelled" ]]; then
    echo "[smoke-training-worker-dedicated-auth] final cancel status is not cancelled."
    echo "${final_detail}"
    exit 1
  fi

  cancel_log_count="$(echo "${final_detail}" | jq -r '[.data.logs[] | select(test("Worker cancel request|Cancellation requested by user"))] | length')"
  if [[ "${cancel_log_count}" -le 0 ]]; then
    echo "[smoke-training-worker-dedicated-auth] expected cancel logs are missing."
    echo "${final_detail}"
    exit 1
  fi

  echo "cancel_worker_id=${CURRENT_WORKER_ID}"
  echo "cancel_job_id=${job_id}"
  echo "cancel_log_count=${cancel_log_count}"
}

if [[ "${START_API}" == "true" || "${START_API}" == "1" ]]; then
  start_api
else
  if ! wait_for_url "${BASE_URL}/api/health" "API" 180 0.2; then
    echo "[smoke-training-worker-dedicated-auth] API is unreachable at ${BASE_URL}"
    exit 1
  fi
fi
login_admin
CSRF_TOKEN="$(csrf_token)"
if [[ -z "${CSRF_TOKEN}" ]]; then
  echo "[smoke-training-worker-dedicated-auth] failed to obtain CSRF token."
  exit 1
fi

resolve_detection_training_target "${BASE_URL}" "${COOKIE_FILE}" "smoke-training-worker-dedicated-auth"

REFERENCE_PORT="$(smoke_pick_port)"
CANCEL_PORT="$(smoke_pick_port)"

REFERENCE_OUTPUT="$(run_reference_package_flow "${CSRF_TOKEN}" "${REFERENCE_PORT}")"
CANCEL_OUTPUT="$(run_cancel_flow "${CSRF_TOKEN}" "${CANCEL_PORT}")"

echo "[smoke-training-worker-dedicated-auth] PASS"
echo "${REFERENCE_OUTPUT}"
echo "${CANCEL_OUTPUT}"
echo "training_dataset_id=${TRAINING_DATASET_ID}"
echo "training_dataset_version_id=${TRAINING_DATASET_VERSION_ID}"
