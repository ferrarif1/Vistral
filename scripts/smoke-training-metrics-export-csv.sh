#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
BASE_URL="http://${API_HOST}:${API_PORT}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-training-metrics-export-csv] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-training-metrics-export-csv] python3 is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
CSV_HEADERS="$(mktemp)"
CSV_BODY="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${CSV_HEADERS}" "${CSV_BODY}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
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
  echo "[smoke-training-metrics-export-csv] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-training-metrics-export-csv] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

datasets_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets")"
detection_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="detection" and .status=="ready") | .id' | head -n 1)"
if [[ -z "${detection_dataset_id}" ]]; then
  detection_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="detection") | .id' | head -n 1)"
fi
if [[ -z "${detection_dataset_id}" ]]; then
  echo "[smoke-training-metrics-export-csv] no detection dataset found."
  echo "${datasets_resp}"
  exit 1
fi

detection_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${detection_dataset_id}/versions")"
detection_dataset_version_id="$(echo "${detection_versions_resp}" | jq -r '.data[] | select((.split_summary.train // 0) > 0 and (.annotation_coverage // 0) > 0) | .id' | head -n 1)"
if [[ -z "${detection_dataset_version_id}" ]]; then
  echo "[smoke-training-metrics-export-csv] no trainable detection dataset version found."
  echo "${detection_versions_resp}"
  exit 1
fi

train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"metrics-export-csv-test\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${detection_dataset_id}\",\"dataset_version_id\":\"${detection_dataset_version_id}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"9\",\"batch_size\":\"2\",\"learning_rate\":\"0.0007\"}}")"
job_id="$(echo "${train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${job_id}" ]]; then
  echo "[smoke-training-metrics-export-csv] training job create failed."
  echo "${train_resp}"
  exit 1
fi

status=""
detail=""
for _ in {1..140}; do
  detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  status="$(echo "${detail}" | jq -r '.data.job.status // empty')"
  if [[ "${status}" == "completed" ]]; then
    break
  fi
  if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
    echo "[smoke-training-metrics-export-csv] training job ended with ${status}."
    echo "${detail}"
    exit 1
  fi
  sleep 0.25
done

if [[ "${status}" != "completed" ]]; then
  echo "[smoke-training-metrics-export-csv] training job timeout."
  echo "${detail}"
  exit 1
fi

http_code="$(
  curl -sS -D "${CSV_HEADERS}" -o "${CSV_BODY}" \
    -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -w '%{http_code}' \
    "${BASE_URL}/api/training/jobs/${job_id}/metrics-export?format=csv"
)"

if [[ "${http_code}" != "200" ]]; then
  echo "[smoke-training-metrics-export-csv] expected 200, got ${http_code}."
  cat "${CSV_HEADERS}"
  cat "${CSV_BODY}"
  exit 1
fi

content_type="$(grep -i '^Content-Type:' "${CSV_HEADERS}" | head -n 1 | tr -d '\r' | cut -d' ' -f2-)"
if [[ "${content_type}" != text/csv* ]]; then
  echo "[smoke-training-metrics-export-csv] expected text/csv content type, got '${content_type}'."
  cat "${CSV_HEADERS}"
  exit 1
fi

expected_header='training_job_id,metric_name,step,metric_value,recorded_at'
csv_header="$(head -n 1 "${CSV_BODY}" | tr -d '\r')"
if [[ "${csv_header}" != "${expected_header}" ]]; then
  echo "[smoke-training-metrics-export-csv] csv header mismatch."
  echo "expected=${expected_header}"
  echo "actual=${csv_header}"
  cat "${CSV_BODY}"
  exit 1
fi

line_count="$(wc -l < "${CSV_BODY}" | tr -d ' ')"
if [[ -z "${line_count}" || "${line_count}" -lt 2 ]]; then
  echo "[smoke-training-metrics-export-csv] expected at least one data row."
  cat "${CSV_BODY}"
  exit 1
fi

job_rows="$(grep -c "^${job_id}," "${CSV_BODY}" || true)"
if [[ "${job_rows}" -lt 1 ]]; then
  echo "[smoke-training-metrics-export-csv] expected job id '${job_id}' rows in csv."
  cat "${CSV_BODY}"
  exit 1
fi

map_rows="$(grep -c ",map," "${CSV_BODY}" || true)"
if [[ "${map_rows}" -lt 1 ]]; then
  echo "[smoke-training-metrics-export-csv] expected map metric rows."
  cat "${CSV_BODY}"
  exit 1
fi

echo "[smoke-training-metrics-export-csv] PASS"
echo "job_id=${job_id}"
echo "content_type=${content_type}"
echo "line_count=${line_count}"
echo "map_rows=${map_rows}"
