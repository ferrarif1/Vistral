#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8807}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
EXPECTED_VALID_FEEDBACK_DATASET_ID="${EXPECTED_VALID_FEEDBACK_DATASET_ID:-}"
EXPECTED_MISMATCH_FEEDBACK_DATASET_ID="${EXPECTED_MISMATCH_FEEDBACK_DATASET_ID:-}"
EXPECTED_OCR_FEEDBACK_DATASET_ID="${EXPECTED_OCR_FEEDBACK_DATASET_ID:-}"
AUTO_PREPARE_FEEDBACK_DATASETS="${AUTO_PREPARE_FEEDBACK_DATASETS:-true}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-inference-feedback-guard] jq is required."
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

wait_for_health() {
  for _ in $(seq 1 120); do
    if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

get_csrf_token() {
  curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf" | jq -r '.data.csrf_token // empty'
}

wait_attachment_ready() {
  local attachment_id="$1"
  local list_resp=""
  local attachment_status=""

  for _ in $(seq 1 120); do
    list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/inference")"
    attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"

    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi

    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-inference-feedback-guard] inference attachment entered error state."
      echo "${list_resp}"
      exit 1
    fi

    sleep 0.25
  done

  echo "[smoke-inference-feedback-guard] inference attachment not ready in time."
  echo "${list_resp}"
  exit 1
}

wait_dataset_attachment_ready() {
  local dataset_id="$1"
  local attachment_id="$2"
  local list_resp=""
  local attachment_status=""

  for _ in $(seq 1 120); do
    list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/dataset/${dataset_id}")"
    attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"

    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi

    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-inference-feedback-guard] dataset attachment entered error state."
      echo "${list_resp}"
      exit 1
    fi

    sleep 0.25
  done

  echo "[smoke-inference-feedback-guard] dataset attachment not ready in time."
  echo "${list_resp}"
  exit 1
}

create_feedback_dataset() {
  local task_type="$1"
  local run_tag="$2"
  local response=""
  local dataset_id=""
  local label_schema='{"classes":["sample"]}'

  if [[ "${task_type}" == "detection" ]]; then
    label_schema='{"classes":["defect"]}'
  fi

  response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/datasets" \
    -d "{\"name\":\"feedback-${task_type}-target-${run_tag}\",\"description\":\"feedback guard smoke ${task_type} target\",\"task_type\":\"${task_type}\",\"label_schema\":${label_schema}}")"
  dataset_id="$(echo "${response}" | jq -r '.data.id // empty')"
  if [[ -z "${dataset_id}" ]]; then
    echo "[smoke-inference-feedback-guard] failed to create ${task_type} feedback dataset."
    echo "${response}"
    exit 1
  fi

  echo "${dataset_id}"
}

assert_feedback_trace() {
  local dataset_id="$1"
  local run_id="$2"
  local label="$3"
  local expected_source_attachment_id="${4:-}"
  local expected_reason="${5:-}"
  local dataset_after_feedback=""
  local feedback_item_count=""
  local feedback_attachment_id=""
  local dataset_attachment_count=""
  local metadata_source_attachment_id=""
  local metadata_inference_run_id=""
  local metadata_feedback_reason=""

  dataset_after_feedback="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
  feedback_item_count="$(echo "${dataset_after_feedback}" | jq -r --arg run_id "${run_id}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
  if [[ "${feedback_item_count}" -lt 1 ]]; then
    echo "[smoke-inference-feedback-guard] ${label} feedback dataset item was not created."
    echo "${dataset_after_feedback}"
    exit 1
  fi

  feedback_attachment_id="$(echo "${dataset_after_feedback}" | jq -r --arg run_id "${run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .attachment_id // empty' | head -n 1)"
  dataset_attachment_count="$(echo "${dataset_after_feedback}" | jq -r --arg attachment_id "${feedback_attachment_id}" '[.data.attachments[] | select(.id == $attachment_id)] | length')"
  if [[ -z "${feedback_attachment_id}" || "${dataset_attachment_count}" -lt 1 ]]; then
    echo "[smoke-inference-feedback-guard] ${label} feedback attachment is not dataset-scoped."
    echo "${dataset_after_feedback}"
    exit 1
  fi

  metadata_source_attachment_id="$(echo "${dataset_after_feedback}" | jq -r --arg run_id "${run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.source_attachment_id // empty' | head -n 1)"
  metadata_inference_run_id="$(echo "${dataset_after_feedback}" | jq -r --arg run_id "${run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.inference_run_id // empty' | head -n 1)"
  metadata_feedback_reason="$(echo "${dataset_after_feedback}" | jq -r --arg run_id "${run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.feedback_reason // empty' | head -n 1)"
  if [[ "${metadata_inference_run_id}" != "${run_id}" ]]; then
    echo "[smoke-inference-feedback-guard] ${label} feedback metadata.inference_run_id mismatch."
    echo "${dataset_after_feedback}"
    exit 1
  fi
  if [[ -n "${expected_source_attachment_id}" && "${metadata_source_attachment_id}" != "${expected_source_attachment_id}" ]]; then
    echo "[smoke-inference-feedback-guard] ${label} feedback metadata.source_attachment_id mismatch."
    echo "${dataset_after_feedback}"
    exit 1
  fi
  if [[ -n "${expected_reason}" && "${metadata_feedback_reason}" != "${expected_reason}" ]]; then
    echo "[smoke-inference-feedback-guard] ${label} feedback metadata.feedback_reason mismatch."
    echo "${dataset_after_feedback}"
    exit 1
  fi
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
    echo "[smoke-inference-feedback-guard] API failed to start."
    cat "${API_LOG}"
  else
    echo "[smoke-inference-feedback-guard] API is unreachable at ${BASE_URL}."
  fi
  exit 1
fi

csrf_token="$(get_csrf_token)"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-inference-feedback-guard] failed to obtain CSRF token."
  exit 1
fi

if [[ -n "${AUTH_USERNAME}" ]]; then
  if [[ -z "${AUTH_PASSWORD}" ]]; then
    echo "[smoke-inference-feedback-guard] AUTH_PASSWORD is required when AUTH_USERNAME is set."
    exit 1
  fi

  login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "${login_resp}" | jq -r '.success // false')"
  if [[ "${login_success}" != "true" ]]; then
    echo "[smoke-inference-feedback-guard] login failed for AUTH_USERNAME=${AUTH_USERNAME}."
    echo "${login_resp}"
    exit 1
  fi

  csrf_token="$(get_csrf_token)"
  if [[ -z "${csrf_token}" ]]; then
    echo "[smoke-inference-feedback-guard] failed to refresh CSRF token after login."
    exit 1
  fi
fi

model_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions")"
detection_model_version_id="$(echo "${model_versions_resp}" | jq -r '.data[] | select(.task_type=="detection" and .status=="registered") | .id' | head -n 1)"
ocr_model_version_id="$(echo "${model_versions_resp}" | jq -r '.data[] | select(.task_type=="ocr" and .status=="registered") | .id' | head -n 1)"
if [[ -z "${detection_model_version_id}" || -z "${ocr_model_version_id}" ]]; then
  echo "[smoke-inference-feedback-guard] required detection/ocr registered model versions were not found."
  echo "${model_versions_resp}"
  exit 1
fi

inference_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -d "{\"filename\":\"feedback-guard-input-$(date +%s).jpg\"}")"
input_attachment_id="$(echo "${inference_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${input_attachment_id}" ]]; then
  echo "[smoke-inference-feedback-guard] failed to upload inference attachment."
  echo "${inference_upload_resp}"
  exit 1
fi
wait_attachment_ready "${input_attachment_id}"

inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${input_attachment_id}\",\"task_type\":\"detection\"}")"
detection_run_id="$(echo "${inference_resp}" | jq -r '.data.id // empty')"
if [[ -z "${detection_run_id}" ]]; then
  echo "[smoke-inference-feedback-guard] failed to create detection inference run."
  echo "${inference_resp}"
  exit 1
fi

ocr_inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${ocr_model_version_id}\",\"input_attachment_id\":\"${input_attachment_id}\",\"task_type\":\"ocr\"}")"
ocr_run_id="$(echo "${ocr_inference_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_run_id}" ]]; then
  echo "[smoke-inference-feedback-guard] failed to create ocr inference run."
  echo "${ocr_inference_resp}"
  exit 1
fi

datasets_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets")"
detection_feedback_dataset_id="${EXPECTED_VALID_FEEDBACK_DATASET_ID}"
mismatch_feedback_dataset_id="${EXPECTED_MISMATCH_FEEDBACK_DATASET_ID}"
ocr_feedback_dataset_id="${EXPECTED_OCR_FEEDBACK_DATASET_ID}"

if [[ -z "${detection_feedback_dataset_id}" && -z "${mismatch_feedback_dataset_id}" && -z "${ocr_feedback_dataset_id}" && "${AUTO_PREPARE_FEEDBACK_DATASETS}" == "true" ]]; then
  run_tag="$(date +%s)"
  detection_feedback_dataset_id="$(create_feedback_dataset "detection" "${run_tag}")"
  ocr_feedback_dataset_id="$(create_feedback_dataset "ocr" "${run_tag}")"
  mismatch_feedback_dataset_id="${ocr_feedback_dataset_id}"
fi

if [[ -z "${detection_feedback_dataset_id}" ]]; then
  detection_feedback_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="detection" and (.name | test("^(conversation-smoke-dataset-|real-det-|roundtrip-|persist-check-ds$|import-ref-test$|demo train dataset|attachment-smoke-dataset$|feedback-(detection|ocr)-target-)"; "i") | not)) | .id' | head -n 1)"
fi
if [[ -z "${detection_feedback_dataset_id}" ]]; then
  detection_feedback_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="detection") | .id' | head -n 1)"
fi
if [[ -z "${detection_feedback_dataset_id}" ]]; then
  echo "[smoke-inference-feedback-guard] no detection dataset found for valid feedback path."
  echo "${datasets_resp}"
  exit 1
fi

if [[ -z "${ocr_feedback_dataset_id}" ]]; then
  ocr_feedback_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="ocr" and (.name | test("^(feedback-(detection|ocr)-target-)"; "i") | not)) | .id' | head -n 1)"
fi
if [[ -z "${ocr_feedback_dataset_id}" ]]; then
  ocr_feedback_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type=="ocr") | .id' | head -n 1)"
fi
if [[ -z "${ocr_feedback_dataset_id}" ]]; then
  ocr_feedback_dataset_id="$(create_feedback_dataset "ocr" "$(date +%s)")"
fi

if [[ -z "${mismatch_feedback_dataset_id}" ]]; then
  mismatch_feedback_dataset_id="${ocr_feedback_dataset_id}"
fi
if [[ -z "${mismatch_feedback_dataset_id}" ]]; then
  mismatch_feedback_dataset_id="$(create_feedback_dataset "ocr" "$(date +%s)")"
fi

mismatch_feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${detection_run_id}/feedback" \
  -d "{\"dataset_id\":\"${mismatch_feedback_dataset_id}\",\"reason\":\"wrong-task-dataset\"}")"
mismatch_success="$(echo "${mismatch_feedback_resp}" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
mismatch_error_code="$(echo "${mismatch_feedback_resp}" | jq -r '.error.code // empty')"
mismatch_message="$(echo "${mismatch_feedback_resp}" | jq -r '.error.message // empty')"
if [[ "${mismatch_success}" != "false" || "${mismatch_error_code}" != "VALIDATION_ERROR" || "${mismatch_message}" != *"task_type"* || "${mismatch_message}" != *"match"* ]]; then
  echo "[smoke-inference-feedback-guard] mismatch guard failed."
  echo "${mismatch_feedback_resp}"
  exit 1
fi

ocr_mismatch_feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${ocr_run_id}/feedback" \
  -d "{\"dataset_id\":\"${detection_feedback_dataset_id}\",\"reason\":\"wrong-task-dataset-ocr\"}")"
ocr_mismatch_success="$(echo "${ocr_mismatch_feedback_resp}" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
ocr_mismatch_error_code="$(echo "${ocr_mismatch_feedback_resp}" | jq -r '.error.code // empty')"
ocr_mismatch_message="$(echo "${ocr_mismatch_feedback_resp}" | jq -r '.error.message // empty')"
if [[ "${ocr_mismatch_success}" != "false" || "${ocr_mismatch_error_code}" != "VALIDATION_ERROR" || "${ocr_mismatch_message}" != *"task_type"* || "${ocr_mismatch_message}" != *"match"* ]]; then
  echo "[smoke-inference-feedback-guard] ocr mismatch guard failed."
  echo "${ocr_mismatch_feedback_resp}"
  exit 1
fi

detection_feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${detection_run_id}/feedback" \
  -d "{\"dataset_id\":\"${detection_feedback_dataset_id}\",\"reason\":\"valid-detection-feedback\"}")"
detection_feedback_success="$(echo "${detection_feedback_resp}" | jq -r '.success // false')"
detection_feedback_dataset_id_response="$(echo "${detection_feedback_resp}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${detection_feedback_success}" != "true" || "${detection_feedback_dataset_id_response}" != "${detection_feedback_dataset_id}" ]]; then
  echo "[smoke-inference-feedback-guard] detection valid feedback path failed."
  echo "${detection_feedback_resp}"
  exit 1
fi

ocr_feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${ocr_run_id}/feedback" \
  -d "{\"dataset_id\":\"${ocr_feedback_dataset_id}\",\"reason\":\"valid-ocr-feedback\"}")"
ocr_feedback_success="$(echo "${ocr_feedback_resp}" | jq -r '.success // false')"
ocr_feedback_dataset_id_response="$(echo "${ocr_feedback_resp}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${ocr_feedback_success}" != "true" || "${ocr_feedback_dataset_id_response}" != "${ocr_feedback_dataset_id}" ]]; then
  echo "[smoke-inference-feedback-guard] ocr valid feedback path failed."
  echo "${ocr_feedback_resp}"
  exit 1
fi

idempotent_detection_reason="idempotent-detection-feedback"
idempotent_detection_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${detection_run_id}/feedback" \
  -d "{\"dataset_id\":\"${detection_feedback_dataset_id}\",\"reason\":\"${idempotent_detection_reason}\"}")"
idempotent_detection_success="$(echo "${idempotent_detection_resp}" | jq -r '.success // false')"
if [[ "${idempotent_detection_success}" != "true" ]]; then
  echo "[smoke-inference-feedback-guard] detection idempotent feedback request failed."
  echo "${idempotent_detection_resp}"
  exit 1
fi

idempotent_ocr_reason="idempotent-ocr-feedback"
idempotent_ocr_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${ocr_run_id}/feedback" \
  -d "{\"dataset_id\":\"${ocr_feedback_dataset_id}\",\"reason\":\"${idempotent_ocr_reason}\"}")"
idempotent_ocr_success="$(echo "${idempotent_ocr_resp}" | jq -r '.success // false')"
if [[ "${idempotent_ocr_success}" != "true" ]]; then
  echo "[smoke-inference-feedback-guard] ocr idempotent feedback request failed."
  echo "${idempotent_ocr_resp}"
  exit 1
fi

assert_feedback_trace "${detection_feedback_dataset_id}" "${detection_run_id}" "detection" "${input_attachment_id}" "${idempotent_detection_reason}"
assert_feedback_trace "${ocr_feedback_dataset_id}" "${ocr_run_id}" "ocr" "${input_attachment_id}" "${idempotent_ocr_reason}"

detection_dataset_after_idempotent="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${detection_feedback_dataset_id}")"
detection_feedback_item_count="$(echo "${detection_dataset_after_idempotent}" | jq -r --arg run_id "${detection_run_id}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
detection_feedback_reason="$(echo "${detection_dataset_after_idempotent}" | jq -r --arg run_id "${detection_run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.feedback_reason // empty' | head -n 1)"
if [[ "${detection_feedback_item_count}" != "1" || "${detection_feedback_reason}" != "${idempotent_detection_reason}" ]]; then
  echo "[smoke-inference-feedback-guard] detection feedback idempotency expectation failed."
  echo "${detection_dataset_after_idempotent}"
  exit 1
fi

ocr_dataset_after_idempotent="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${ocr_feedback_dataset_id}")"
ocr_feedback_item_count="$(echo "${ocr_dataset_after_idempotent}" | jq -r --arg run_id "${ocr_run_id}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
ocr_feedback_reason="$(echo "${ocr_dataset_after_idempotent}" | jq -r --arg run_id "${ocr_run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.feedback_reason // empty' | head -n 1)"
if [[ "${ocr_feedback_item_count}" != "1" || "${ocr_feedback_reason}" != "${idempotent_ocr_reason}" ]]; then
  echo "[smoke-inference-feedback-guard] ocr feedback idempotency expectation failed."
  echo "${ocr_dataset_after_idempotent}"
  exit 1
fi

reuse_dataset_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"feedback-reuse-target-$(date +%s)\",\"description\":\"feedback reuse guard dataset\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}")"
reuse_dataset_id="$(echo "${reuse_dataset_resp}" | jq -r '.data.id // empty')"
if [[ -z "${reuse_dataset_id}" ]]; then
  echo "[smoke-inference-feedback-guard] failed to create reuse feedback dataset."
  echo "${reuse_dataset_resp}"
  exit 1
fi

reuse_attachment_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${reuse_dataset_id}/upload" \
  -d "{\"filename\":\"feedback-reuse-input-$(date +%s).jpg\"}")"
reuse_attachment_id="$(echo "${reuse_attachment_resp}" | jq -r '.data.id // empty')"
if [[ -z "${reuse_attachment_id}" ]]; then
  echo "[smoke-inference-feedback-guard] failed to upload reuse dataset attachment."
  echo "${reuse_attachment_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${reuse_dataset_id}" "${reuse_attachment_id}"

reuse_inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${detection_model_version_id}\",\"input_attachment_id\":\"${reuse_attachment_id}\",\"task_type\":\"detection\"}")"
reuse_run_id="$(echo "${reuse_inference_resp}" | jq -r '.data.id // empty')"
if [[ -z "${reuse_run_id}" ]]; then
  echo "[smoke-inference-feedback-guard] failed to create reuse-path inference run."
  echo "${reuse_inference_resp}"
  exit 1
fi

reuse_feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${reuse_run_id}/feedback" \
  -d "{\"dataset_id\":\"${reuse_dataset_id}\",\"reason\":\"reuse-dataset-attachment\"}")"
reuse_feedback_success="$(echo "${reuse_feedback_resp}" | jq -r '.success // false')"
reuse_feedback_dataset_id="$(echo "${reuse_feedback_resp}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${reuse_feedback_success}" != "true" || "${reuse_feedback_dataset_id}" != "${reuse_dataset_id}" ]]; then
  echo "[smoke-inference-feedback-guard] reuse-path feedback request failed."
  echo "${reuse_feedback_resp}"
  exit 1
fi

reuse_dataset_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${reuse_dataset_id}")"
reuse_feedback_item_count="$(echo "${reuse_dataset_detail}" | jq -r --arg run_id "${reuse_run_id}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
reuse_feedback_attachment_id="$(echo "${reuse_dataset_detail}" | jq -r --arg run_id "${reuse_run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .attachment_id // empty' | head -n 1)"
reuse_dataset_attachment_count="$(echo "${reuse_dataset_detail}" | jq -r --arg attachment_id "${reuse_attachment_id}" '[.data.attachments[] | select(.id == $attachment_id)] | length')"
if [[ "${reuse_feedback_item_count}" != "1" || "${reuse_feedback_attachment_id}" != "${reuse_attachment_id}" || "${reuse_dataset_attachment_count}" != "1" ]]; then
  echo "[smoke-inference-feedback-guard] reuse-path feedback did not reuse dataset-scoped attachment as expected."
  echo "${reuse_dataset_detail}"
  exit 1
fi
reuse_metadata_source_attachment_id="$(echo "${reuse_dataset_detail}" | jq -r --arg run_id "${reuse_run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.source_attachment_id // empty' | head -n 1)"
reuse_metadata_reason="$(echo "${reuse_dataset_detail}" | jq -r --arg run_id "${reuse_run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.feedback_reason // empty' | head -n 1)"
if [[ "${reuse_metadata_source_attachment_id}" != "${reuse_attachment_id}" || "${reuse_metadata_reason}" != "reuse-dataset-attachment" ]]; then
  echo "[smoke-inference-feedback-guard] reuse-path feedback metadata mismatch."
  echo "${reuse_dataset_detail}"
  exit 1
fi

echo "[smoke-inference-feedback-guard] PASS"
echo "run_id=${detection_run_id}"
echo "detection_run_id=${detection_run_id}"
echo "ocr_run_id=${ocr_run_id}"
echo "valid_feedback_dataset_id=${detection_feedback_dataset_id}"
echo "ocr_feedback_dataset_id=${ocr_feedback_dataset_id}"
echo "mismatch_feedback_dataset_id=${mismatch_feedback_dataset_id}"
echo "reuse_dataset_id=${reuse_dataset_id}"
echo "reuse_run_id=${reuse_run_id}"
