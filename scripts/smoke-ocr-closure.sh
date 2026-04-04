#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8801}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
DEMO_DIR="${DEMO_DIR:-${ROOT_DIR}/demo_data}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-ocr-closure] jq is required."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-ocr-closure] python3 is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
TMP_OCR_IMPORT="$(mktemp)"
TMP_INFERENCE_FILE="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${TMP_OCR_IMPORT}" "${TMP_INFERENCE_FILE}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

wait_for_health() {
  for _ in {1..100}; do
    if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  return 1
}

wait_attachment_ready() {
  local list_url="$1"
  local attachment_id="$2"
  local label="$3"
  local list_resp=""
  local attachment_status=""

  for _ in {1..120}; do
    list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${list_url}")"
    attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"

    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi

    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-ocr-closure] ${label} attachment entered error state."
      echo "${list_resp}"
      exit 1
    fi

    sleep 0.25
  done

  echo "[smoke-ocr-closure] ${label} attachment not ready in time."
  echo "${list_resp}"
  exit 1
}

wait_training_job_completed() {
  local job_id="$1"
  local label="$2"
  local job_detail=""
  local job_status=""

  for _ in {1..140}; do
    job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
    job_status="$(echo "${job_detail}" | jq -r '.data.job.status // empty')"

    if [[ "${job_status}" == "completed" ]]; then
      printf '%s\n' "${job_detail}"
      return 0
    fi

    if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
      echo "[smoke-ocr-closure] ${label} training job ended with ${job_status}."
      echo "${job_detail}"
      exit 1
    fi

    sleep 0.25
  done

  echo "[smoke-ocr-closure] ${label} training job timeout."
  echo "${job_detail}"
  exit 1
}

if [[ "${START_API}" == "true" ]]; then
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  PADDLEOCR_RUNTIME_ENDPOINT="" \
  DOCTR_RUNTIME_ENDPOINT="" \
  YOLO_RUNTIME_ENDPOINT="" \
  YOLO_LOCAL_TRAIN_COMMAND='python3 {{repo_root}}/scripts/local-runners/yolo_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}' \
  PADDLEOCR_LOCAL_TRAIN_COMMAND='python3 {{repo_root}}/scripts/local-runners/paddleocr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}' \
  DOCTR_LOCAL_TRAIN_COMMAND='python3 {{repo_root}}/scripts/local-runners/doctr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}' \
  PADDLEOCR_LOCAL_PREDICT_COMMAND='python3 {{repo_root}}/scripts/local-runners/paddleocr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}' \
  DOCTR_LOCAL_PREDICT_COMMAND='python3 {{repo_root}}/scripts/local-runners/doctr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}' \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  if [[ "${START_API}" == "true" ]]; then
    echo "[smoke-ocr-closure] API failed to start."
    cat "${API_LOG}"
  else
    echo "[smoke-ocr-closure] API is unreachable at ${BASE_URL}."
  fi
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-ocr-closure] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

if [[ -n "${AUTH_USERNAME}" ]]; then
  if [[ -z "${AUTH_PASSWORD}" ]]; then
    echo "[smoke-ocr-closure] AUTH_PASSWORD is required when AUTH_USERNAME is set."
    exit 1
  fi

  login_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "${login_response}" | jq -r '.success // false')"
  if [[ "${login_success}" != "true" ]]; then
    echo "[smoke-ocr-closure] login failed for AUTH_USERNAME=${AUTH_USERNAME}."
    echo "${login_response}"
    exit 1
  fi

  csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
  if [[ -z "${csrf_token}" ]]; then
    echo "[smoke-ocr-closure] failed to refresh CSRF token after login."
    echo "${csrf_response}"
    exit 1
  fi
fi

image_file="$(find "${DEMO_DIR}" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit 2>/dev/null || true)"
if [[ -z "${image_file}" ]]; then
  printf 'ocr closure fallback payload\n' >"${TMP_INFERENCE_FILE}"
  image_file="${TMP_INFERENCE_FILE}"
fi

dataset_payload="$(jq -nc \
  --arg name "ocr-closure-$(date +%s)" \
  --arg description "OCR closure smoke dataset" \
  '{name: $name, description: $description, task_type: "ocr", label_schema: {classes: ["text"]}}'
)"
dataset_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "${dataset_payload}")"
dataset_id="$(echo "${dataset_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dataset_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create OCR dataset."
  echo "${dataset_resp}"
  exit 1
fi

dataset_image_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${dataset_id}/upload" \
  -F "file=@${image_file}")"
dataset_image_attachment_id="$(echo "${dataset_image_upload_resp}" | jq -r '.data.id // empty')"
dataset_image_filename="$(echo "${dataset_image_upload_resp}" | jq -r '.data.filename // empty')"
if [[ -z "${dataset_image_attachment_id}" || -z "${dataset_image_filename}" ]]; then
  echo "[smoke-ocr-closure] failed to upload OCR dataset image."
  echo "${dataset_image_upload_resp}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/dataset/${dataset_id}" "${dataset_image_attachment_id}" "dataset image"

printf "%s\tTrain No CRH380A-1022\t0.95\n%s\tCarriage 08\t0.91\n" \
  "${dataset_image_filename}" \
  "${dataset_image_filename}" >"${TMP_OCR_IMPORT}"

ocr_import_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${dataset_id}/upload" \
  -F "file=@${TMP_OCR_IMPORT};filename=ocr-closure-import.txt;type=text/plain")"
ocr_import_attachment_id="$(echo "${ocr_import_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_import_attachment_id}" ]]; then
  echo "[smoke-ocr-closure] failed to upload OCR import file."
  echo "${ocr_import_upload_resp}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/dataset/${dataset_id}" "${ocr_import_attachment_id}" "ocr import"

ocr_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/import" \
  -d "{\"format\":\"ocr\",\"attachment_id\":\"${ocr_import_attachment_id}\"}")"
ocr_import_total="$(echo "${ocr_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${ocr_import_total}" -lt 1 ]]; then
  echo "[smoke-ocr-closure] OCR import did not modify annotations."
  echo "${ocr_import_resp}"
  exit 1
fi

annotations_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
annotation_line_total="$(echo "${annotations_resp}" | jq -r '[.data[] | (.payload.lines // []) | length] | add // 0')"
if [[ "${annotation_line_total}" -lt 2 ]]; then
  echo "[smoke-ocr-closure] expected imported OCR lines."
  echo "${annotations_resp}"
  exit 1
fi

dataset_version_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/versions" \
  -d '{"version_name":"ocr-closure-v1"}')"
dataset_version_id="$(echo "${dataset_version_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dataset_version_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create OCR dataset version."
  echo "${dataset_version_resp}"
  exit 1
fi

paddle_model_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/models/draft" \
  -d '{"name":"ocr-closure-paddle-model","description":"OCR closure paddle model","model_type":"ocr","visibility":"workspace"}')"
paddle_model_id="$(echo "${paddle_model_resp}" | jq -r '.data.id // empty')"
if [[ -z "${paddle_model_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create PaddleOCR model draft."
  echo "${paddle_model_resp}"
  exit 1
fi

doctr_model_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/models/draft" \
  -d '{"name":"ocr-closure-doctr-model","description":"OCR closure docTR model","model_type":"ocr","visibility":"workspace"}')"
doctr_model_id="$(echo "${doctr_model_resp}" | jq -r '.data.id // empty')"
if [[ -z "${doctr_model_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create docTR model draft."
  echo "${doctr_model_resp}"
  exit 1
fi

paddle_train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"ocr-closure-paddle\",\"task_type\":\"ocr\",\"framework\":\"paddleocr\",\"dataset_id\":\"${dataset_id}\",\"dataset_version_id\":\"${dataset_version_id}\",\"base_model\":\"paddleocr-PP-OCRv4\",\"config\":{\"epochs\":\"4\",\"batch_size\":\"2\",\"learning_rate\":\"0.0007\"}}")"
paddle_job_id="$(echo "${paddle_train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${paddle_job_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create PaddleOCR training job."
  echo "${paddle_train_resp}"
  exit 1
fi

paddle_job_detail="$(wait_training_job_completed "${paddle_job_id}" "PaddleOCR")"
paddle_mode="$(echo "${paddle_job_detail}" | jq -r '.data.job.execution_mode // empty')"
paddle_accuracy="$(echo "${paddle_job_detail}" | jq -r '.data.metrics | map(select(.metric_name=="accuracy")) | sort_by(.step) | last | .metric_value // empty')"
paddle_accuracy_series="$(echo "${paddle_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="accuracy")] | length')"
paddle_metric_keys="$(echo "${paddle_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]?] | length')"
paddle_norm_edit_distance_series="$(echo "${paddle_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="norm_edit_distance")] | length')"
paddle_norm_edit_distance_key="$(echo "${paddle_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]? | select(.=="norm_edit_distance")] | length')"
if [[ "${paddle_mode}" != "local_command" || -z "${paddle_accuracy}" || "${paddle_accuracy}" == "null" || "${paddle_accuracy_series}" -lt 3 || "${paddle_metric_keys}" -lt 1 || "${paddle_norm_edit_distance_series}" -lt 3 || "${paddle_norm_edit_distance_key}" -lt 1 ]]; then
  echo "[smoke-ocr-closure] PaddleOCR training assertions failed."
  echo "${paddle_job_detail}"
  exit 1
fi

paddle_register_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/model-versions/register" \
  -d "{\"model_id\":\"${paddle_model_id}\",\"training_job_id\":\"${paddle_job_id}\",\"version_name\":\"ocr-closure-paddle-v1\"}")"
paddle_model_version_id="$(echo "${paddle_register_resp}" | jq -r '.data.id // empty')"
paddle_artifact_attachment_id="$(echo "${paddle_register_resp}" | jq -r '.data.artifact_attachment_id // empty')"
if [[ -z "${paddle_model_version_id}" || -z "${paddle_artifact_attachment_id}" ]]; then
  echo "[smoke-ocr-closure] failed to register PaddleOCR model version."
  echo "${paddle_register_resp}"
  exit 1
fi

doctr_train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"ocr-closure-doctr\",\"task_type\":\"ocr\",\"framework\":\"doctr\",\"dataset_id\":\"${dataset_id}\",\"dataset_version_id\":\"${dataset_version_id}\",\"base_model\":\"doctr-db-resnet50\",\"config\":{\"epochs\":\"3\",\"batch_size\":\"2\",\"learning_rate\":\"0.0005\"}}")"
doctr_job_id="$(echo "${doctr_train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${doctr_job_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create docTR training job."
  echo "${doctr_train_resp}"
  exit 1
fi

doctr_job_detail="$(wait_training_job_completed "${doctr_job_id}" "docTR")"
doctr_mode="$(echo "${doctr_job_detail}" | jq -r '.data.job.execution_mode // empty')"
doctr_f1="$(echo "${doctr_job_detail}" | jq -r '.data.metrics | map(select(.metric_name=="f1")) | sort_by(.step) | last | .metric_value // empty')"
doctr_f1_series="$(echo "${doctr_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="f1")] | length')"
doctr_metric_keys="$(echo "${doctr_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]?] | length')"
doctr_norm_edit_distance_series="$(echo "${doctr_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="norm_edit_distance")] | length')"
doctr_norm_edit_distance_key="$(echo "${doctr_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]? | select(.=="norm_edit_distance")] | length')"
if [[ "${doctr_mode}" != "local_command" || -z "${doctr_f1}" || "${doctr_f1}" == "null" || "${doctr_f1_series}" -lt 3 || "${doctr_metric_keys}" -lt 1 || "${doctr_norm_edit_distance_series}" -lt 3 || "${doctr_norm_edit_distance_key}" -lt 1 ]]; then
  echo "[smoke-ocr-closure] docTR training assertions failed."
  echo "${doctr_job_detail}"
  exit 1
fi

doctr_register_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/model-versions/register" \
  -d "{\"model_id\":\"${doctr_model_id}\",\"training_job_id\":\"${doctr_job_id}\",\"version_name\":\"ocr-closure-doctr-v1\"}")"
doctr_model_version_id="$(echo "${doctr_register_resp}" | jq -r '.data.id // empty')"
doctr_artifact_attachment_id="$(echo "${doctr_register_resp}" | jq -r '.data.artifact_attachment_id // empty')"
if [[ -z "${doctr_model_version_id}" || -z "${doctr_artifact_attachment_id}" ]]; then
  echo "[smoke-ocr-closure] failed to register docTR model version."
  echo "${doctr_register_resp}"
  exit 1
fi

inference_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -F "file=@${image_file}")"
inference_attachment_id="$(echo "${inference_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${inference_attachment_id}" ]]; then
  echo "[smoke-ocr-closure] failed to upload inference input."
  echo "${inference_upload_resp}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/inference" "${inference_attachment_id}" "inference input"

paddle_inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${paddle_model_version_id}\",\"input_attachment_id\":\"${inference_attachment_id}\",\"task_type\":\"ocr\"}")"
paddle_execution_source="$(echo "${paddle_inference_resp}" | jq -r '.data.execution_source // empty')"
paddle_lines="$(echo "${paddle_inference_resp}" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
if [[ "${paddle_execution_source}" != "paddleocr_local_command" || "${paddle_lines}" -lt 1 ]]; then
  echo "[smoke-ocr-closure] PaddleOCR inference assertions failed."
  echo "${paddle_inference_resp}"
  exit 1
fi

doctr_inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${doctr_model_version_id}\",\"input_attachment_id\":\"${inference_attachment_id}\",\"task_type\":\"ocr\"}")"
doctr_execution_source="$(echo "${doctr_inference_resp}" | jq -r '.data.execution_source // empty')"
doctr_lines="$(echo "${doctr_inference_resp}" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
if [[ "${doctr_execution_source}" != "doctr_local_command" || "${doctr_lines}" -lt 1 ]]; then
  echo "[smoke-ocr-closure] docTR inference assertions failed."
  echo "${doctr_inference_resp}"
  exit 1
fi

echo "[smoke-ocr-closure] PASS"
echo "dataset_id=${dataset_id}"
echo "dataset_version_id=${dataset_version_id}"
echo "paddle_job_id=${paddle_job_id}"
echo "paddle_model_version_id=${paddle_model_version_id}"
echo "paddle_accuracy=${paddle_accuracy}"
echo "doctr_job_id=${doctr_job_id}"
echo "doctr_model_version_id=${doctr_model_version_id}"
echo "doctr_f1=${doctr_f1}"
echo "inference_attachment_id=${inference_attachment_id}"
echo "paddle_execution_source=${paddle_execution_source}"
echo "doctr_execution_source=${doctr_execution_source}"
