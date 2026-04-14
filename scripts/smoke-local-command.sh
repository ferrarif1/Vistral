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

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-local-command] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-local-command] python3 is required."
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

wait_inference_attachment_ready() {
  local attachment_id="$1"
  local files_resp=""
  local attachment_status=""

  for _ in {1..120}; do
    files_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/inference")"
    attachment_status="$(echo "${files_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"
    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi
    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-local-command] inference attachment entered error state."
      echo "${files_resp}"
      exit 1
    fi
    sleep 0.2
  done

  echo "[smoke-local-command] inference attachment not ready in time."
  echo "${files_resp}"
  exit 1
}

cd "${ROOT_DIR}"

APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
LLM_CONFIG_SECRET="smoke-local-command-${API_PORT}" \
VISTRAL_PYTHON_BIN='/opt/edge-lab/python' \
YOLO_LOCAL_TRAIN_COMMAND='python3 {{repo_root}}/scripts/local-runners/yolo_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}' \
PADDLEOCR_LOCAL_TRAIN_COMMAND='python3 {{repo_root}}/scripts/local-runners/paddleocr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}' \
DOCTR_LOCAL_TRAIN_COMMAND='python3 {{repo_root}}/scripts/local-runners/doctr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}' \
YOLO_LOCAL_PREDICT_COMMAND='python3 {{repo_root}}/scripts/local-runners/yolo_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}' \
PADDLEOCR_LOCAL_PREDICT_COMMAND='python3 {{repo_root}}/scripts/local-runners/paddleocr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}' \
DOCTR_LOCAL_PREDICT_COMMAND='python3 {{repo_root}}/scripts/local-runners/doctr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}' \
MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1 \
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

if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
  echo "[smoke-local-command] API process exited before health check (possible port conflict)."
  cat "${API_LOG}"
  exit 1
fi

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-local-command] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-local-command] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

model_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions")"
detection_model_version_id="$(echo "${model_versions_resp}" | jq -r '.data[] | select(.task_type=="detection" and .status=="registered") | .id' | head -n 1)"
ocr_model_version_id="$(echo "${model_versions_resp}" | jq -r '.data[] | select(.task_type=="ocr" and .framework=="paddleocr" and .status=="registered") | .id' | head -n 1)"
if [[ -z "${ocr_model_version_id}" ]]; then
  ocr_model_version_id="$(echo "${model_versions_resp}" | jq -r '.data[] | select(.task_type=="ocr" and .status=="registered") | .id' | head -n 1)"
fi
if [[ -z "${detection_model_version_id}" || -z "${ocr_model_version_id}" ]]; then
  echo "[smoke-local-command] required detection/ocr model versions not found."
  echo "${model_versions_resp}"
  exit 1
fi

datasets_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets")"
detection_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="detection" and .status=="ready") | .id' | head -n 1)"
if [[ -z "${detection_dataset_id}" ]]; then
  detection_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="detection") | .id' | head -n 1)"
fi
ocr_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="ocr" and .status=="ready") | .id' | head -n 1)"
if [[ -z "${ocr_dataset_id}" ]]; then
  ocr_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="ocr") | .id' | head -n 1)"
fi
if [[ -z "${detection_dataset_id}" || -z "${ocr_dataset_id}" ]]; then
  echo "[smoke-local-command] required detection/ocr datasets not found."
  echo "${datasets_resp}"
  exit 1
fi

detection_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${detection_dataset_id}/versions")"
detection_dataset_version_id="$(echo "${detection_versions_resp}" | jq -r '.data[] | select((.split_summary.train // 0) > 0 and (.annotation_coverage // 0) > 0) | .id' | head -n 1)"
if [[ -z "${detection_dataset_version_id}" ]]; then
  echo "[smoke-local-command] no trainable detection dataset version found."
  echo "${detection_versions_resp}"
  exit 1
fi

ocr_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${ocr_dataset_id}/versions")"
ocr_dataset_version_id="$(echo "${ocr_versions_resp}" | jq -r '.data[] | select((.split_summary.train // 0) > 0 and (.annotation_coverage // 0) > 0) | .id' | head -n 1)"
if [[ -z "${ocr_dataset_version_id}" ]]; then
  echo "[smoke-local-command] no trainable OCR dataset version found."
  echo "${ocr_versions_resp}"
  exit 1
fi

detection_infer_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -d "{\"filename\":\"local-command-detection-$(date +%s).jpg\"}")"
detection_input_attachment_id="$(echo "${detection_infer_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${detection_input_attachment_id}" ]]; then
  echo "[smoke-local-command] failed to upload detection inference attachment."
  echo "${detection_infer_upload_resp}"
  exit 1
fi
wait_inference_attachment_ready "${detection_input_attachment_id}"

ocr_infer_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -d "{\"filename\":\"local-command-ocr-$(date +%s).jpg\"}")"
ocr_input_attachment_id="$(echo "${ocr_infer_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_input_attachment_id}" ]]; then
  echo "[smoke-local-command] failed to upload OCR inference attachment."
  echo "${ocr_infer_upload_resp}"
  exit 1
fi
wait_inference_attachment_ready "${ocr_input_attachment_id}"

train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"local-command-yolo\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${detection_dataset_id}\",\"dataset_version_id\":\"${detection_dataset_version_id}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"5\",\"batch_size\":\"2\",\"learning_rate\":\"0.0008\"}}")"
job_id="$(echo "${train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${job_id}" ]]; then
  echo "[smoke-local-command] training job create failed."
  echo "${train_resp}"
  exit 1
fi

job_detail=""
job_status=""
for _ in {1..120}; do
  job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  job_status="$(echo "${job_detail}" | jq -r '.data.job.status // empty')"
  if [[ "${job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
    echo "[smoke-local-command] training job ended with ${job_status}."
    echo "${job_detail}"
    exit 1
  fi
  sleep 0.25
done

if [[ "${job_status}" != "completed" ]]; then
  echo "[smoke-local-command] training job timeout."
  echo "${job_detail}"
  exit 1
fi

map_metric="$(echo "${job_detail}" | jq -r '.data.metrics | map(select(.metric_name=="map")) | sort_by(.step) | last | .metric_value // empty')"
if [[ -z "${map_metric}" || "${map_metric}" == "null" ]]; then
  echo "[smoke-local-command] expected map metric from local runner."
  echo "${job_detail}"
  exit 1
fi

map_series_count="$(echo "${job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="map")] | length')"
if [[ "${map_series_count}" -lt 3 ]]; then
  echo "[smoke-local-command] expected map metric series with multiple steps."
  echo "${job_detail}"
  exit 1
fi

yolo_mode="$(echo "${job_detail}" | jq -r '.data.job.execution_mode // empty')"
if [[ "${yolo_mode}" != "local_command" ]]; then
  echo "[smoke-local-command] expected YOLO execution_mode=local_command, got ${yolo_mode}."
  echo "${job_detail}"
  exit 1
fi

log_has_local="$(echo "${job_detail}" | jq -r '[.data.logs[] | select(test("local command"; "i"))] | length')"
if [[ "${log_has_local}" -lt 1 ]]; then
  echo "[smoke-local-command] expected local command log markers."
  echo "${job_detail}"
  exit 1
fi

inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${detection_input_attachment_id}\",\"task_type\":\"detection\"}")"
source="$(echo "${inference_resp}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
if [[ "${source}" != "yolo_local_command" ]]; then
  echo "[smoke-local-command] expected yolo_local_command source, got ${source}."
  echo "${inference_resp}"
  exit 1
fi

paddle_inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${ocr_model_version_id}\",\"input_attachment_id\":\"${ocr_input_attachment_id}\",\"task_type\":\"ocr\"}")"
paddle_source="$(echo "${paddle_inference_resp}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
if [[ "${paddle_source}" != "paddleocr_local_command" ]]; then
  echo "[smoke-local-command] expected paddleocr_local_command source, got ${paddle_source}."
  echo "${paddle_inference_resp}"
  exit 1
fi

paddle_train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"local-command-paddleocr\",\"task_type\":\"ocr\",\"framework\":\"paddleocr\",\"dataset_id\":\"${ocr_dataset_id}\",\"dataset_version_id\":\"${ocr_dataset_version_id}\",\"base_model\":\"paddleocr-PP-OCRv4\",\"config\":{\"epochs\":\"4\",\"batch_size\":\"2\",\"learning_rate\":\"0.0007\"}}")"
paddle_job_id="$(echo "${paddle_train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${paddle_job_id}" ]]; then
  echo "[smoke-local-command] failed to create PaddleOCR training job."
  echo "${paddle_train_resp}"
  exit 1
fi

paddle_job_status=""
paddle_job_detail=""
for _ in {1..120}; do
  paddle_job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${paddle_job_id}")"
  paddle_job_status="$(echo "${paddle_job_detail}" | jq -r '.data.job.status // empty')"
  if [[ "${paddle_job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${paddle_job_status}" == "failed" || "${paddle_job_status}" == "cancelled" ]]; then
    echo "[smoke-local-command] PaddleOCR job ended with ${paddle_job_status}."
    echo "${paddle_job_detail}"
    exit 1
  fi
  sleep 0.25
done

paddle_mode="$(echo "${paddle_job_detail}" | jq -r '.data.job.execution_mode // empty')"
if [[ "${paddle_mode}" != "local_command" ]]; then
  echo "[smoke-local-command] expected PaddleOCR execution_mode=local_command, got ${paddle_mode}."
  echo "${paddle_job_detail}"
  exit 1
fi

paddle_accuracy="$(echo "${paddle_job_detail}" | jq -r '.data.metrics | map(select(.metric_name=="accuracy")) | sort_by(.step) | last | .metric_value // empty')"
if [[ -z "${paddle_accuracy}" || "${paddle_accuracy}" == "null" ]]; then
  echo "[smoke-local-command] expected PaddleOCR accuracy metric."
  echo "${paddle_job_detail}"
  exit 1
fi

paddle_accuracy_series="$(echo "${paddle_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="accuracy")] | length')"
if [[ "${paddle_accuracy_series}" -lt 3 ]]; then
  echo "[smoke-local-command] expected PaddleOCR accuracy series with multiple steps."
  echo "${paddle_job_detail}"
  exit 1
fi

paddle_norm_edit_distance_series="$(echo "${paddle_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="norm_edit_distance")] | length')"
paddle_norm_edit_distance_key="$(echo "${paddle_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]? | select(.=="norm_edit_distance")] | length')"
if [[ "${paddle_norm_edit_distance_series}" -lt 3 || "${paddle_norm_edit_distance_key}" -lt 1 ]]; then
  echo "[smoke-local-command] expected PaddleOCR norm_edit_distance metric persistence."
  echo "${paddle_job_detail}"
  exit 1
fi

doctr_job_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"local-command-doctr\",\"task_type\":\"ocr\",\"framework\":\"doctr\",\"dataset_id\":\"${ocr_dataset_id}\",\"dataset_version_id\":\"${ocr_dataset_version_id}\",\"base_model\":\"doctr-db-resnet50\",\"config\":{\"epochs\":\"2\",\"batch_size\":\"2\",\"learning_rate\":\"0.0005\"}}")"
doctr_job_id="$(echo "${doctr_job_resp}" | jq -r '.data.id // empty')"
if [[ -z "${doctr_job_id}" ]]; then
  echo "[smoke-local-command] failed to create docTR training job."
  echo "${doctr_job_resp}"
  exit 1
fi

doctr_job_status=""
for _ in {1..120}; do
  doctr_job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${doctr_job_id}")"
  doctr_job_status="$(echo "${doctr_job_detail}" | jq -r '.data.job.status // empty')"
  if [[ "${doctr_job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${doctr_job_status}" == "failed" || "${doctr_job_status}" == "cancelled" ]]; then
    echo "[smoke-local-command] docTR job ended with ${doctr_job_status}."
    echo "${doctr_job_detail}"
    exit 1
  fi
  sleep 0.25
done

doctr_mode="$(echo "${doctr_job_detail}" | jq -r '.data.job.execution_mode // empty')"
if [[ "${doctr_mode}" != "local_command" ]]; then
  echo "[smoke-local-command] expected docTR execution_mode=local_command, got ${doctr_mode}."
  echo "${doctr_job_detail}"
  exit 1
fi

doctr_f1="$(echo "${doctr_job_detail}" | jq -r '.data.metrics | map(select(.metric_name=="f1")) | sort_by(.step) | last | .metric_value // empty')"
if [[ -z "${doctr_f1}" || "${doctr_f1}" == "null" ]]; then
  echo "[smoke-local-command] expected docTR f1 metric."
  echo "${doctr_job_detail}"
  exit 1
fi

doctr_f1_series="$(echo "${doctr_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="f1")] | length')"
if [[ "${doctr_f1_series}" -lt 3 ]]; then
  echo "[smoke-local-command] expected docTR f1 series with multiple steps."
  echo "${doctr_job_detail}"
  exit 1
fi

doctr_norm_edit_distance_series="$(echo "${doctr_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="norm_edit_distance")] | length')"
if [[ "${doctr_norm_edit_distance_series}" -lt 3 ]]; then
  echo "[smoke-local-command] expected docTR norm_edit_distance series."
  echo "${doctr_job_detail}"
  exit 1
fi

doctr_artifact_mode="$(echo "${doctr_job_detail}" | jq -r '.data.artifact_summary.mode // empty')"
if [[ -z "${doctr_artifact_mode}" ]]; then
  echo "[smoke-local-command] expected artifact_summary.mode for docTR job detail."
  echo "${doctr_job_detail}"
  exit 1
fi

doctr_artifact_metrics_keys="$(echo "${doctr_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]?] | length')"
if [[ "${doctr_artifact_metrics_keys}" -lt 1 ]]; then
  echo "[smoke-local-command] expected artifact_summary.metrics_keys for docTR job detail."
  echo "${doctr_job_detail}"
  exit 1
fi

doctr_norm_edit_distance_key="$(echo "${doctr_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]? | select(.=="norm_edit_distance")] | length')"
if [[ "${doctr_norm_edit_distance_key}" -lt 1 ]]; then
  echo "[smoke-local-command] expected docTR norm_edit_distance artifact key."
  echo "${doctr_job_detail}"
  exit 1
fi

doctr_model_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/models/draft" \
  -d '{"name":"local-command-doctr-model","description":"docTR local command smoke model","model_type":"ocr","visibility":"workspace"}')"
doctr_model_id="$(echo "${doctr_model_resp}" | jq -r '.data.id // empty')"
if [[ -z "${doctr_model_id}" ]]; then
  echo "[smoke-local-command] failed to create docTR model draft."
  echo "${doctr_model_resp}"
  exit 1
fi

register_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/model-versions/register" \
  -d "{\"model_id\":\"${doctr_model_id}\",\"training_job_id\":\"${doctr_job_id}\",\"version_name\":\"doctr-local-command-v1\"}")"
doctr_model_version_id="$(echo "${register_resp}" | jq -r '.data.id // empty')"
if [[ -z "${doctr_model_version_id}" ]]; then
  echo "[smoke-local-command] failed to register docTR model version."
  echo "${register_resp}"
  exit 1
fi

doctr_inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${doctr_model_version_id}\",\"input_attachment_id\":\"${ocr_input_attachment_id}\",\"task_type\":\"ocr\"}")"
doctr_source="$(echo "${doctr_inference_resp}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
if [[ "${doctr_source}" != "doctr_local_command" ]]; then
  echo "[smoke-local-command] expected doctr_local_command source, got ${doctr_source}."
  echo "${doctr_inference_resp}"
  exit 1
fi

echo "[smoke-local-command] PASS"
echo "job_id=${job_id}"
echo "map_metric=${map_metric}"
echo "paddle_job_id=${paddle_job_id}"
echo "paddle_accuracy=${paddle_accuracy}"
echo "doctr_job_id=${doctr_job_id}"
echo "doctr_f1=${doctr_f1}"
echo "doctr_artifact_mode=${doctr_artifact_mode}"
echo "inference_source=${source}"
echo "paddle_source=${paddle_source}"
echo "doctr_source=${doctr_source}"
