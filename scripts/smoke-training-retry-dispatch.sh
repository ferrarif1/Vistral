#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"
source "${ROOT_DIR}/scripts/lib/smoke-training-worker-common.sh"

API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-mock-pass-admin}"
WORKER_PUBLIC_HOST_DEFAULT="127.0.0.1"
if [[ "${START_API}" == "false" ]]; then
  WORKER_PUBLIC_HOST_DEFAULT="host.docker.internal"
fi
WORKER_PUBLIC_HOST="${WORKER_PUBLIC_HOST:-${WORKER_PUBLIC_HOST_DEFAULT}}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-training-retry-dispatch] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-training-retry-dispatch] python3 is required."
  exit 1
fi

if [[ "${START_API}" == "true" && -z "${API_PORT:-}" ]]; then
  API_PORT="$(smoke_pick_port)"
fi
API_PORT="${API_PORT:-8080}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
TMP_BODY="$(mktemp)"
WORKER_PROBE_LOG="$(mktemp)"
API_PID=""
PROVISIONED_WORKER_ID=""
PROVISIONED_WORKER_TOKEN=""
PROVISIONED_WORKER_NAME=""
PROVISIONED_WORKER_ENDPOINT=""
TARGET_WORKER_ID=""
WORKER_PROBE_PID=""

cleanup() {
  if [[ -n "${PROVISIONED_WORKER_ID}" ]]; then
    csrf_token="$(get_csrf_token "${COOKIE_FILE}")"
    if [[ -n "${csrf_token}" ]]; then
      curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
        -H "X-CSRF-Token: ${csrf_token}" \
        -X DELETE "${BASE_URL}/api/admin/training-workers/${PROVISIONED_WORKER_ID}" >/dev/null || true
    fi
  fi
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WORKER_PROBE_PID}" ]]; then
    kill "${WORKER_PROBE_PID}" >/dev/null 2>&1 || true
    wait "${WORKER_PROBE_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${TMP_BODY}" "${WORKER_PROBE_LOG}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

wait_for_health() {
  for _ in $(seq 1 140); do
    if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

get_csrf_token() {
  local cookie_file="$1"
  curl -sS -c "${cookie_file}" -b "${cookie_file}" \
    "${BASE_URL}/api/auth/csrf" | jq -r '.data.csrf_token // empty'
}

start_worker_probe_server() {
  local bind_host="$1"
  local port="$2"
  local runtime_profile="$3"
  python3 - "${bind_host}" "${port}" "${runtime_profile}" >"${WORKER_PROBE_LOG}" 2>&1 <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

bind_host = sys.argv[1]
port = int(sys.argv[2])
runtime_profile = sys.argv[3]
payload = json.dumps(
    {
        "runtime_profile": runtime_profile,
        "worker_version": "smoke-retry-dispatch",
        "contract_version": "training-worker-healthz.v1",
        "capabilities": ["framework:yolo", "task:detection"],
    }
).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/healthz", "/api/worker/healthz"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *_args):
        return


server = HTTPServer((bind_host, port), Handler)
server.serve_forever()
PY
  WORKER_PROBE_PID=$!

  for _ in $(seq 1 80); do
    if curl -sS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done

  echo "[smoke-training-retry-dispatch] failed to start worker probe server on port=${port}." >&2
  cat "${WORKER_PROBE_LOG}" >&2
  exit 1
}

wait_for_retryable_terminal_status() {
  local job_id="$1"
  local detail_resp status
  for _ in $(seq 1 300); do
    detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
      "${BASE_URL}/api/training/jobs/${job_id}")"
    status="$(echo "${detail_resp}" | jq -r '.data.job.status // empty')"
    if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
      return 0
    fi
    if [[ "${status}" == "completed" ]]; then
      return 2
    fi
    sleep 0.2
  done
  return 1
}

prepare_retryable_job() {
  local job_id="$1"
  local csrf_token="$2"
  local detail_resp status cancel_resp cancel_status cancel_error_code

  cancel_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/training/jobs/${job_id}/cancel")"
  cancel_status="$(echo "${cancel_resp}" | jq -r '.data.status // empty')"
  if [[ "${cancel_status}" == "cancelled" ]]; then
    wait_for_retryable_terminal_status "${job_id}"
    return $?
  fi
  cancel_error_code="$(echo "${cancel_resp}" | jq -r '.error.code // empty')"
  if [[ "${cancel_error_code}" == "INVALID_STATE_TRANSITION" ]]; then
    detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
      "${BASE_URL}/api/training/jobs/${job_id}")"
    status="$(echo "${detail_resp}" | jq -r '.data.job.status // empty')"
    if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
      return 0
    fi
    if [[ "${status}" == "completed" ]]; then
      return 2
    fi
  fi

  for _ in $(seq 1 140); do
    detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
      "${BASE_URL}/api/training/jobs/${job_id}")"
    status="$(echo "${detail_resp}" | jq -r '.data.job.status // empty')"

    if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
      return 0
    fi
    if [[ "${status}" == "completed" ]]; then
      return 2
    fi

    if [[ "${status}" == "queued" || "${status}" == "preparing" || "${status}" == "running" ]]; then
      cancel_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
        -H "X-CSRF-Token: ${csrf_token}" \
        -X POST "${BASE_URL}/api/training/jobs/${job_id}/cancel")"
      cancel_status="$(echo "${cancel_resp}" | jq -r '.data.status // empty')"
      if [[ "${cancel_status}" == "cancelled" ]]; then
        wait_for_retryable_terminal_status "${job_id}"
        return $?
      fi
      cancel_error_code="$(echo "${cancel_resp}" | jq -r '.error.code // empty')"
      if [[ "${cancel_error_code}" == "INVALID_STATE_TRANSITION" ]]; then
        detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
          "${BASE_URL}/api/training/jobs/${job_id}")"
        status="$(echo "${detail_resp}" | jq -r '.data.job.status // empty')"
        if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
          return 0
        fi
        if [[ "${status}" == "completed" ]]; then
          return 2
        fi
      fi
      echo "[smoke-training-retry-dispatch] failed to cancel job=${job_id}."
      echo "${cancel_resp}"
      exit 1
    fi

    sleep 0.2
  done

  return 1
}

ensure_detection_worker() {
  local csrf_token="$1"

  local worker_port worker_name worker_endpoint worker_bind_host worker_runtime_profile
  local bootstrap_create_resp bootstrap_worker_id pairing_token claim_resp worker_token heartbeat_resp
  worker_port="$(smoke_pick_port)"
  worker_name="retry-dispatch-worker-$(date +%s)"
  worker_endpoint="http://${WORKER_PUBLIC_HOST}:${worker_port}"
  worker_bind_host="0.0.0.0"
  worker_runtime_profile="yolo"
  if [[ "${START_API}" == "true" ]]; then
    worker_bind_host="127.0.0.1"
  fi

  start_worker_probe_server "${worker_bind_host}" "${worker_port}" "${worker_runtime_profile}"

  bootstrap_create_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/admin/training-workers/bootstrap-sessions" \
    -d "{\"deployment_mode\":\"script\",\"worker_profile\":\"yolo\",\"control_plane_base_url\":\"${BASE_URL}\",\"worker_name\":\"${worker_name}\",\"worker_public_host\":\"${WORKER_PUBLIC_HOST}\",\"worker_bind_port\":${worker_port},\"max_concurrency\":1}")"
  bootstrap_worker_id="$(echo "${bootstrap_create_resp}" | jq -r '.data.worker_id // empty')"
  pairing_token="$(echo "${bootstrap_create_resp}" | jq -r '.data.pairing_token // empty')"
  if [[ -z "${bootstrap_worker_id}" || -z "${pairing_token}" ]]; then
    echo "[smoke-training-retry-dispatch] failed to create worker bootstrap session." >&2
    echo "${bootstrap_create_resp}" >&2
    exit 1
  fi
  PROVISIONED_WORKER_ID="${bootstrap_worker_id}"

  claim_resp="$(curl -sS -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/runtime/training-workers/bootstrap-sessions/claim" \
    -d "{\"pairing_token\":\"${pairing_token}\"}")"
  worker_token="$(echo "${claim_resp}" | jq -r '.data.config_defaults.training_worker_auth_token // empty')"
  local claimed_worker_id
  claimed_worker_id="$(echo "${claim_resp}" | jq -r '.data.config_defaults.worker_id // empty')"
  if [[ -z "${worker_token}" ]]; then
    echo "[smoke-training-retry-dispatch] failed to claim worker session and get auth token." >&2
    echo "${claim_resp}" >&2
    exit 1
  fi

  heartbeat_resp="$(curl -sS -H "Content-Type: application/json" \
    -H "X-Training-Worker-Token: ${worker_token}" \
    -X POST "${BASE_URL}/api/runtime/training-workers/heartbeat" \
    -d "{\"worker_id\":\"${claimed_worker_id}\",\"name\":\"${worker_name}\",\"endpoint\":\"${worker_endpoint}\",\"status\":\"online\",\"enabled\":true,\"max_concurrency\":1,\"reported_load\":0.12,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
  if [[ "$(echo "${heartbeat_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-retry-dispatch] heartbeat failed for fallback worker." >&2
    echo "${heartbeat_resp}" >&2
    exit 1
  fi

  PROVISIONED_WORKER_TOKEN="${worker_token}"
  PROVISIONED_WORKER_NAME="${worker_name}"
  PROVISIONED_WORKER_ENDPOINT="${worker_endpoint}"
  TARGET_WORKER_ID="${claimed_worker_id}"
  return 0
}

refresh_provisioned_worker_heartbeat() {
  if [[ -z "${PROVISIONED_WORKER_ID}" || -z "${PROVISIONED_WORKER_TOKEN}" ]]; then
    return 0
  fi
  local heartbeat_resp
  heartbeat_resp="$(curl -sS -H "Content-Type: application/json" \
    -H "X-Training-Worker-Token: ${PROVISIONED_WORKER_TOKEN}" \
    -X POST "${BASE_URL}/api/runtime/training-workers/heartbeat" \
    -d "{\"worker_id\":\"${PROVISIONED_WORKER_ID}\",\"name\":\"${PROVISIONED_WORKER_NAME}\",\"endpoint\":\"${PROVISIONED_WORKER_ENDPOINT}\",\"status\":\"online\",\"enabled\":true,\"max_concurrency\":1,\"reported_load\":0.1,\"capabilities\":[\"framework:yolo\",\"task:detection\"]}")"
  if [[ "$(echo "${heartbeat_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-training-retry-dispatch] failed to refresh provisioned worker heartbeat."
    echo "${heartbeat_resp}"
    exit 1
  fi
}

ensure_retry_worker_online() {
  local worker_id="$1"
  local workers_resp effective_status enabled_flag

  for _ in $(seq 1 12); do
    refresh_provisioned_worker_heartbeat || true
    workers_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
      "${BASE_URL}/api/admin/training-workers")"
    effective_status="$(echo "${workers_resp}" | jq -r --arg id "${worker_id}" '.data[] | select(.id == $id) | .effective_status // empty')"
    enabled_flag="$(echo "${workers_resp}" | jq -r --arg id "${worker_id}" '.data[] | select(.id == $id) | .enabled // false')"
    if [[ "${enabled_flag}" == "true" && "${effective_status}" == "online" ]]; then
      return 0
    fi
    sleep 0.4
  done

  echo "[smoke-training-retry-dispatch] worker is not online before retry: ${worker_id}" >&2
  echo "${workers_resp}" >&2
  return 1
}

if [[ "${START_API}" == "true" ]]; then
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  if [[ "${START_API}" == "true" ]]; then
    if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
      echo "[smoke-training-retry-dispatch] API process exited before health check (possible port conflict)."
      cat "${API_LOG}"
      exit 1
    fi
    echo "[smoke-training-retry-dispatch] API failed to start."
    cat "${API_LOG}"
  else
    echo "[smoke-training-retry-dispatch] API is unreachable at ${BASE_URL}."
  fi
  exit 1
fi

admin_login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}")"
if [[ "$(echo "${admin_login_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-training-retry-dispatch] admin login failed."
  echo "${admin_login_resp}"
  exit 1
fi

csrf_token="$(get_csrf_token "${COOKIE_FILE}")"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-training-retry-dispatch] failed to obtain csrf token."
  exit 1
fi

resolve_detection_training_target "${BASE_URL}" "${COOKIE_FILE}" "smoke-training-retry-dispatch"
ensure_detection_worker "${csrf_token}"
worker_id="${TARGET_WORKER_ID}"
if [[ -z "${worker_id}" ]]; then
  echo "[smoke-training-retry-dispatch] failed to resolve eligible worker."
  exit 1
fi

create_retryable_job() {
  local csrf_token="$1"
  local created_job_id create_job_resp prep_status ready_status ready_detail_resp

  for _ in $(seq 1 10); do
    create_job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
      -H "Content-Type: application/json" \
      -H "X-CSRF-Token: ${csrf_token}" \
      -X POST "${BASE_URL}/api/training/jobs" \
      -d "{\"name\":\"retry-dispatch-job-$(date +%s)\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${TRAINING_DATASET_ID}\",\"dataset_version_id\":\"${TRAINING_DATASET_VERSION_ID}\",\"base_model\":\"yolo11n\",\"execution_target\":\"control_plane\",\"config\":{\"epochs\":\"24\",\"batch_size\":\"2\",\"learning_rate\":\"0.0008\"}}")"
    created_job_id="$(echo "${create_job_resp}" | jq -r '.data.id // empty')"
    if [[ -z "${created_job_id}" ]]; then
      echo "[smoke-training-retry-dispatch] failed to create training job." >&2
      echo "${create_job_resp}" >&2
      exit 1
    fi

    prep_status=0
    prepare_retryable_job "${created_job_id}" "${csrf_token}" || prep_status=$?
    if [[ "${prep_status}" -eq 0 ]]; then
      ready_detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
        "${BASE_URL}/api/training/jobs/${created_job_id}")"
      ready_status="$(echo "${ready_detail_resp}" | jq -r '.data.job.status // empty')"
      if [[ "${ready_status}" != "failed" && "${ready_status}" != "cancelled" ]]; then
        continue
      fi
      echo "${created_job_id}"
      return 0
    fi
    if [[ "${prep_status}" -eq 1 || "${prep_status}" -eq 2 ]]; then
      continue
    fi
    echo "[smoke-training-retry-dispatch] failed to move job=${created_job_id} into retryable status." >&2
    exit 1
  done

  echo "[smoke-training-retry-dispatch] unable to obtain retryable training job after retries." >&2
  exit 1
}

job_invalid_combo="$(create_retryable_job "${csrf_token}")"
invalid_status="$(curl -sS -o "${TMP_BODY}" -w '%{http_code}' -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs/${job_invalid_combo}/retry" \
  -d "{\"execution_target\":\"control_plane\",\"worker_id\":\"${worker_id}\"}")"
invalid_error_code="$(jq -r '.error.code // empty' <"${TMP_BODY}")"
if [[ "${invalid_status}" != "400" || "${invalid_error_code}" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-training-retry-dispatch] expected VALIDATION_ERROR for control_plane+worker_id."
  cat "${TMP_BODY}"
  exit 1
fi

job_control_plane="$(create_retryable_job "${csrf_token}")"
retry_control_plane_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs/${job_control_plane}/retry" \
  -d '{"execution_target":"control_plane"}')"
retry_control_plane_error_code="$(echo "${retry_control_plane_resp}" | jq -r '.error.code // empty')"
if [[ "${retry_control_plane_error_code}" == "INVALID_STATE_TRANSITION" ]]; then
  job_control_plane="$(create_retryable_job "${csrf_token}")"
  retry_control_plane_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/training/jobs/${job_control_plane}/retry" \
    -d '{"execution_target":"control_plane"}')"
fi
retry_control_plane_target="$(echo "${retry_control_plane_resp}" | jq -r '.data.execution_target // empty')"
retry_control_plane_worker="$(echo "${retry_control_plane_resp}" | jq -r '.data.scheduled_worker_id // empty')"
if [[ "${retry_control_plane_target}" != "control_plane" || -n "${retry_control_plane_worker}" ]]; then
  echo "[smoke-training-retry-dispatch] control_plane retry assertion failed."
  echo "${retry_control_plane_resp}"
  exit 1
fi

job_explicit_worker="$(create_retryable_job "${csrf_token}")"
ensure_retry_worker_online "${worker_id}"
retry_explicit_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs/${job_explicit_worker}/retry" \
  -d "{\"execution_target\":\"worker\",\"worker_id\":\"${worker_id}\"}")"
retry_explicit_worker_error_code="$(echo "${retry_explicit_worker_resp}" | jq -r '.error.code // empty')"
if [[ "${retry_explicit_worker_error_code}" == "INVALID_STATE_TRANSITION" ]]; then
  job_explicit_worker="$(create_retryable_job "${csrf_token}")"
  ensure_retry_worker_online "${worker_id}"
  retry_explicit_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/training/jobs/${job_explicit_worker}/retry" \
    -d "{\"execution_target\":\"worker\",\"worker_id\":\"${worker_id}\"}")"
fi
retry_explicit_worker_target="$(echo "${retry_explicit_worker_resp}" | jq -r '.data.execution_target // empty')"
retry_explicit_worker_id="$(echo "${retry_explicit_worker_resp}" | jq -r '.data.scheduled_worker_id // empty')"
if [[ "${retry_explicit_worker_target}" != "worker" || "${retry_explicit_worker_id}" != "${worker_id}" ]]; then
  echo "[smoke-training-retry-dispatch] explicit worker retry assertion failed."
  echo "${retry_explicit_worker_resp}"
  exit 1
fi

job_auto_worker="$(create_retryable_job "${csrf_token}")"
ensure_retry_worker_online "${worker_id}"
retry_auto_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs/${job_auto_worker}/retry" \
  -d '{"execution_target":"worker"}')"
retry_auto_worker_error_code="$(echo "${retry_auto_worker_resp}" | jq -r '.error.code // empty')"
if [[ "${retry_auto_worker_error_code}" == "INVALID_STATE_TRANSITION" ]]; then
  job_auto_worker="$(create_retryable_job "${csrf_token}")"
  ensure_retry_worker_online "${worker_id}"
  retry_auto_worker_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/training/jobs/${job_auto_worker}/retry" \
    -d '{"execution_target":"worker"}')"
fi
retry_auto_worker_target="$(echo "${retry_auto_worker_resp}" | jq -r '.data.execution_target // empty')"
retry_auto_worker_id="$(echo "${retry_auto_worker_resp}" | jq -r '.data.scheduled_worker_id // empty')"
if [[ "${retry_auto_worker_target}" != "worker" || -z "${retry_auto_worker_id}" ]]; then
  echo "[smoke-training-retry-dispatch] auto worker retry assertion failed."
  echo "${retry_auto_worker_resp}"
  exit 1
fi

echo "[smoke-training-retry-dispatch] PASS"
echo "job_control_plane=${job_control_plane}"
echo "job_explicit_worker=${job_explicit_worker}"
echo "job_auto_worker=${job_auto_worker}"
echo "retry_control_plane_target=${retry_control_plane_target}"
echo "retry_explicit_worker_id=${retry_explicit_worker_id}"
echo "retry_auto_worker_id=${retry_auto_worker_id}"
echo "training_dataset_id=${TRAINING_DATASET_ID}"
echo "training_dataset_version_id=${TRAINING_DATASET_VERSION_ID}"
