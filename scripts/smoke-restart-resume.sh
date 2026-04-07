#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
if [[ -z "${API_PORT:-}" ]]; then
  API_PORT="$(
    python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
  )"
fi
BASE_URL="http://${API_HOST}:${API_PORT}"
AUTH_USERNAME="${AUTH_USERNAME:-alice}"
AUTH_PASSWORD="${AUTH_PASSWORD:-mock-pass}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-restart-resume] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-restart-resume] python3 is required."
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

  if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
    echo "[smoke-restart-resume] API process exited before health check (possible port conflict)."
    cat "${API_LOG}"
    return 1
  fi

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

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
login_success="$(echo "${login_resp}" | jq -r '.success // false')"
if [[ "${login_success}" != "true" ]]; then
  echo "[smoke-restart-resume] login failed before first run."
  echo "${login_resp}"
  exit 1
fi

csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-restart-resume] failed to obtain CSRF token before first run."
  echo "${csrf_resp}"
  exit 1
fi

dataset_create_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"restart-resume-detection-$(date +%s)\",\"description\":\"restart resume smoke dataset\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}")"
detection_dataset_id="$(echo "${dataset_create_resp}" | jq -r '.data.id // empty')"
if [[ -z "${detection_dataset_id}" ]]; then
  echo "[smoke-restart-resume] failed to create detection dataset."
  echo "${dataset_create_resp}"
  exit 1
fi

dataset_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${detection_dataset_id}/upload" \
  -d "{\"filename\":\"restart-resume-detection-$(date +%s).jpg\"}")"
dataset_attachment_id="$(echo "${dataset_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dataset_attachment_id}" ]]; then
  echo "[smoke-restart-resume] failed to upload detection dataset file."
  echo "${dataset_upload_resp}"
  exit 1
fi

sleep 1.6

dataset_detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${detection_dataset_id}")"
dataset_item_id="$(echo "${dataset_detail_resp}" | jq -r '.data.items[0].id // empty')"
if [[ -z "${dataset_item_id}" ]]; then
  echo "[smoke-restart-resume] dataset item not generated from uploaded file."
  echo "${dataset_detail_resp}"
  exit 1
fi

annotation_upsert_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${detection_dataset_id}/annotations" \
  -d "{\"dataset_item_id\":\"${dataset_item_id}\",\"task_type\":\"detection\",\"source\":\"manual\",\"status\":\"annotated\",\"payload\":{\"boxes\":[{\"id\":\"box-1\",\"x\":42,\"y\":55,\"width\":128,\"height\":94,\"label\":\"defect\"}]}}")"
annotation_status="$(echo "${annotation_upsert_resp}" | jq -r '.data.status // empty')"
if [[ "${annotation_status}" != "annotated" ]]; then
  echo "[smoke-restart-resume] failed to create annotated detection sample."
  echo "${annotation_upsert_resp}"
  exit 1
fi

dataset_split_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${detection_dataset_id}/split" \
  -d '{"train_ratio":1,"val_ratio":0,"test_ratio":0,"seed":31}')"
train_count="$(echo "${dataset_split_resp}" | jq -r '.data.split_summary.train // 0')"
if [[ "${train_count}" -lt 1 ]]; then
  echo "[smoke-restart-resume] split did not produce train items."
  echo "${dataset_split_resp}"
  exit 1
fi

dataset_version_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${detection_dataset_id}/versions" \
  -d "{\"version_name\":\"restart-resume-v1-$(date +%s)\"}")"
detection_dataset_version_id="$(echo "${dataset_version_resp}" | jq -r '.data.id // empty')"
if [[ -z "${detection_dataset_version_id}" ]]; then
  echo "[smoke-restart-resume] failed to create dataset version for restart resume smoke."
  echo "${dataset_version_resp}"
  exit 1
fi

train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"restart-resume-yolo-live\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${detection_dataset_id}\",\"dataset_version_id\":\"${detection_dataset_version_id}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"40\",\"batch_size\":\"2\",\"learning_rate\":\"0.0008\"}}")"
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

# Ensure the created job has been flushed into app-state snapshot before restart.
persisted_before_restart="false"
for _ in {1..80}; do
  if [[ -f "${APP_STATE_FILE}" ]]; then
    persisted_job_count="$(jq -r --arg job_id "${job_id}" '[ (.trainingJobs // [])[]?, (.training_jobs // [])[]? ] | map(select(.id == $job_id)) | length' "${APP_STATE_FILE}" 2>/dev/null || echo "0")"
    if [[ "${persisted_job_count}" -ge 1 ]]; then
      persisted_before_restart="true"
      break
    fi
  fi
  sleep 0.15
done

if [[ "${persisted_before_restart}" != "true" ]]; then
  echo "[smoke-restart-resume] job was not persisted into app-state before restart."
  [[ -f "${APP_STATE_FILE}" ]] && cat "${APP_STATE_FILE}"
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

relogin_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
relogin_success="$(echo "${relogin_resp}" | jq -r '.success // false')"
if [[ "${relogin_success}" != "true" ]]; then
  echo "[smoke-restart-resume] login failed after restart."
  echo "${relogin_resp}"
  exit 1
fi

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
