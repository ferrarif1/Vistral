#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
if [[ "${START_API:-true}" == "true" && -z "${API_PORT:-}" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "[smoke-real-closure] python3 is required when auto-selecting API_PORT."
    exit 1
  fi
  API_PORT="$(
    python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
  )"
fi
API_PORT="${API_PORT:-8787}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-real-closure] jq is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
TMP_YOLO="$(mktemp)"
TMP_OCR="$(mktemp)"
TMP_COCO="$(mktemp)"
TMP_LABELME="$(mktemp)"
TMP_EXPORT="$(mktemp)"
TMP_FALLBACK_IMAGE="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${TMP_YOLO}" "${TMP_OCR}" "${TMP_COCO}" "${TMP_LABELME}" "${TMP_EXPORT}" "${TMP_FALLBACK_IMAGE}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

assert_feedback_trace() {
  local dataset_id="$1"
  local run_id="$2"
  local label="$3"
  local dataset_after_feedback=""
  local feedback_item_count=""
  local feedback_attachment_id=""
  local dataset_attachment_count=""

  dataset_after_feedback="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
  feedback_item_count="$(echo "${dataset_after_feedback}" | jq -r --arg run_id "${run_id}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
  if [[ "${feedback_item_count}" -lt 1 ]]; then
    echo "[smoke-real-closure] ${label} feedback dataset item was not created."
    echo "${dataset_after_feedback}"
    exit 1
  fi

  feedback_attachment_id="$(echo "${dataset_after_feedback}" | jq -r --arg run_id "${run_id}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .attachment_id // empty' | head -n 1)"
  dataset_attachment_count="$(echo "${dataset_after_feedback}" | jq -r --arg attachment_id "${feedback_attachment_id}" '[.data.attachments[] | select(.id == $attachment_id)] | length')"
  if [[ -z "${feedback_attachment_id}" || "${dataset_attachment_count}" -lt 1 ]]; then
    echo "[smoke-real-closure] ${label} feedback attachment is not dataset-scoped."
    echo "${dataset_after_feedback}"
    exit 1
  fi
}

if [[ "${START_API}" == "true" ]]; then
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  PADDLEOCR_RUNTIME_ENDPOINT="" \
  DOCTR_RUNTIME_ENDPOINT="" \
  YOLO_RUNTIME_ENDPOINT="" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

for _ in {1..80}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if [[ "${START_API}" == "true" ]] && ! kill -0 "${API_PID}" >/dev/null 2>&1; then
  echo "[smoke-real-closure] API process exited before health check (possible port conflict)."
  cat "${API_LOG}"
  exit 1
fi

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  if [[ "${START_API}" == "true" ]]; then
    echo "[smoke-real-closure] API failed to start."
    cat "${API_LOG}"
  else
    echo "[smoke-real-closure] API is unreachable at ${BASE_URL}."
  fi
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-real-closure] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

if [[ -n "${AUTH_USERNAME}" ]]; then
  if [[ -z "${AUTH_PASSWORD}" ]]; then
    echo "[smoke-real-closure] AUTH_PASSWORD is required when AUTH_USERNAME is set."
    exit 1
  fi

  login_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "${login_response}" | jq -r '.success // false')"
  if [[ "${login_success}" != "true" ]]; then
    echo "[smoke-real-closure] login failed for AUTH_USERNAME=${AUTH_USERNAME}."
    echo "${login_response}"
    exit 1
  fi

  csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
  if [[ -z "${csrf_token}" ]]; then
    echo "[smoke-real-closure] failed to refresh CSRF token after login."
    echo "${csrf_response}"
    exit 1
  fi
fi

task_draft_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/task-drafts/from-requirement" \
  -d '{"description":"识别列车编号并评估识别准确率"}')"
task_type="$(echo "${task_draft_resp}" | jq -r '.data.task_type // empty')"
recommended_annotation_type="$(echo "${task_draft_resp}" | jq -r '.data.recommended_annotation_type // empty')"
metric_suggestion_count="$(echo "${task_draft_resp}" | jq -r '.data.evaluation_metric_suggestions | length // 0')"
if [[ -z "${task_type}" || -z "${recommended_annotation_type}" || "${metric_suggestion_count}" -lt 1 ]]; then
  echo "[smoke-real-closure] requirement draft response missing required fields."
  echo "${task_draft_resp}"
  exit 1
fi

image_file="$(find "${ROOT_DIR}/demo_data" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit)"
if [[ -z "${image_file}" ]]; then
  printf 'real closure synthetic image payload\n' >"${TMP_FALLBACK_IMAGE}"
  image_file="${TMP_FALLBACK_IMAGE}"
fi

dataset_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"real-det-$(date +%s)\",\"description\":\"real closure dataset\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}")"
dataset_id="$(echo "${dataset_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dataset_id}" ]]; then
  echo "[smoke-real-closure] dataset create failed."
  echo "${dataset_resp}"
  exit 1
fi

img_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${dataset_id}/upload" \
  -F "file=@${image_file}")"
img_attachment_id="$(echo "${img_upload_resp}" | jq -r '.data.id // empty')"
img_filename="$(echo "${img_upload_resp}" | jq -r '.data.filename // empty')"
if [[ -z "${img_attachment_id}" || -z "${img_filename}" ]]; then
  echo "[smoke-real-closure] image upload failed."
  echo "${img_upload_resp}"
  exit 1
fi

echo "${img_filename} defect 120 90 150 100 0.93" >"${TMP_YOLO}"

yolo_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${dataset_id}/upload" \
  -F "file=@${TMP_YOLO};filename=import-yolo.txt;type=text/plain")"
yolo_attachment_id="$(echo "${yolo_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${yolo_attachment_id}" ]]; then
  echo "[smoke-real-closure] yolo import file upload failed."
  echo "${yolo_upload_resp}"
  exit 1
fi

wait_ready_attempts=0
while true; do
  detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
  image_status="$(echo "${detail}" | jq -r --arg id "${img_attachment_id}" '.data.attachments[] | select(.id==$id) | .status')"
  yolo_status="$(echo "${detail}" | jq -r --arg id "${yolo_attachment_id}" '.data.attachments[] | select(.id==$id) | .status')"
  if [[ "${image_status}" == "ready" && "${yolo_status}" == "ready" ]]; then
    break
  fi
  wait_ready_attempts=$((wait_ready_attempts + 1))
  if [[ ${wait_ready_attempts} -gt 50 ]]; then
    echo "[smoke-real-closure] timeout waiting dataset uploads ready."
    echo "${detail}"
    exit 1
  fi
  sleep 0.2
done

import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/import" \
  -d "{\"format\":\"yolo\",\"attachment_id\":\"${yolo_attachment_id}\"}")"
import_total="$(echo "${import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${import_total}" -lt 1 ]]; then
  echo "[smoke-real-closure] yolo import did not modify annotations."
  echo "${import_resp}"
  exit 1
fi

cat >"${TMP_COCO}" <<JSON
{
  "images": [
    { "id": 1, "file_name": "${img_filename}" }
  ],
  "categories": [
    { "id": 1, "name": "defect" }
  ],
  "annotations": [
    { "id": 1, "image_id": 1, "category_id": 1, "bbox": [130, 95, 120, 90], "score": 0.88 }
  ]
}
JSON

coco_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${dataset_id}/upload" \
  -F "file=@${TMP_COCO};filename=import-coco.json;type=application/json")"
coco_attachment_id="$(echo "${coco_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${coco_attachment_id}" ]]; then
  echo "[smoke-real-closure] coco import file upload failed."
  echo "${coco_upload_resp}"
  exit 1
fi

for _ in {1..40}; do
  detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
  coco_status="$(echo "${detail}" | jq -r --arg id "${coco_attachment_id}" '.data.attachments[] | select(.id==$id) | .status // empty')"
  [[ "${coco_status}" == "ready" ]] && break
  sleep 0.2
done

coco_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/import" \
  -d "{\"format\":\"coco\",\"attachment_id\":\"${coco_attachment_id}\"}")"
coco_import_total="$(echo "${coco_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${coco_import_total}" -lt 1 ]]; then
  echo "[smoke-real-closure] coco import did not modify annotations."
  echo "${coco_import_resp}"
  exit 1
fi

cat >"${TMP_LABELME}" <<JSON
{
  "imagePath": "${img_filename}",
  "shapes": [
    {
      "label": "defect",
      "shape_type": "polygon",
      "points": [[160, 110], [240, 110], [250, 180], [150, 185]]
    }
  ]
}
JSON

labelme_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${dataset_id}/upload" \
  -F "file=@${TMP_LABELME};filename=import-labelme.json;type=application/json")"
labelme_attachment_id="$(echo "${labelme_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${labelme_attachment_id}" ]]; then
  echo "[smoke-real-closure] labelme import file upload failed."
  echo "${labelme_upload_resp}"
  exit 1
fi

for _ in {1..40}; do
  detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
  labelme_status="$(echo "${detail}" | jq -r --arg id "${labelme_attachment_id}" '.data.attachments[] | select(.id==$id) | .status // empty')"
  [[ "${labelme_status}" == "ready" ]] && break
  sleep 0.2
done

labelme_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/import" \
  -d "{\"format\":\"labelme\",\"attachment_id\":\"${labelme_attachment_id}\"}")"
labelme_import_total="$(echo "${labelme_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${labelme_import_total}" -lt 1 ]]; then
  echo "[smoke-real-closure] labelme import did not modify annotations."
  echo "${labelme_import_resp}"
  exit 1
fi

export_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/export" \
  -d '{"format":"yolo"}')"
export_attachment_id="$(echo "${export_resp}" | jq -r '.data.attachment_id // empty')"
export_total="$(echo "${export_resp}" | jq -r '.data.exported // 0')"
if [[ -z "${export_attachment_id}" || "${export_total}" -lt 1 ]]; then
  echo "[smoke-real-closure] yolo export did not produce attachment/content."
  echo "${export_resp}"
  exit 1
fi

curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/files/${export_attachment_id}/content" >"${TMP_EXPORT}"
export_format="$(jq -r '.format // empty' "${TMP_EXPORT}")"
export_items_count="$(jq -r '.items | length // 0' "${TMP_EXPORT}")"
export_box_count="$(jq -r '.items[0].boxes | length // 0' "${TMP_EXPORT}")"
if [[ "${export_format}" != "yolo" || "${export_items_count}" -lt 1 || "${export_box_count}" -lt 1 ]]; then
  echo "[smoke-real-closure] yolo export attachment content is invalid."
  cat "${TMP_EXPORT}"
  exit 1
fi

split_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/split" \
  -d '{"train_ratio":0.8,"val_ratio":0.1,"test_ratio":0.1,"seed":42}')"
split_train_count="$(echo "${split_resp}" | jq -r '.data.split_summary.train // 0')"
if [[ "${split_train_count}" -lt 1 ]]; then
  echo "[smoke-real-closure] dataset split did not produce train items."
  echo "${split_resp}"
  exit 1
fi

det_version_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/versions" \
  -d '{"version_name":"real-closure-det-v1"}')"
det_dataset_version_id="$(echo "${det_version_resp}" | jq -r '.data.id // empty')"
if [[ -z "${det_dataset_version_id}" ]]; then
  echo "[smoke-real-closure] detection dataset version creation failed."
  echo "${det_version_resp}"
  exit 1
fi

train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"real-yolo-job-$(date +%s)\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${dataset_id}\",\"dataset_version_id\":\"${det_dataset_version_id}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"6\",\"batch_size\":\"2\",\"learning_rate\":\"0.0008\"}}")"
job_id="$(echo "${train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${job_id}" ]]; then
  echo "[smoke-real-closure] training job create failed."
  echo "${train_resp}"
  exit 1
fi

job_status=""
job_detail=""
for _ in {1..100}; do
  job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  job_status="$(echo "${job_detail}" | jq -r '.data.job.status // empty')"
  if [[ "${job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
    echo "[smoke-real-closure] training job ended with ${job_status}."
    echo "${job_detail}"
    exit 1
  fi
  sleep 0.3
done

if [[ "${job_status}" != "completed" ]]; then
  echo "[smoke-real-closure] training job timeout."
  echo "${job_detail}"
  exit 1
fi

log_count="$(echo "${job_detail}" | jq -r '.data.logs | length // 0')"
metric_count="$(echo "${job_detail}" | jq -r '.data.metrics | length // 0')"
artifact_id="$(echo "${job_detail}" | jq -r '.data.artifact_attachment_id // empty')"
if [[ "${log_count}" -lt 3 || "${metric_count}" -lt 1 || -z "${artifact_id}" ]]; then
  echo "[smoke-real-closure] training detail missing logs/metrics/artifact."
  echo "${job_detail}"
  exit 1
fi

model_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/models/draft" \
  -d "{\"name\":\"real-yolo-model-$(date +%s)\",\"description\":\"real closure model\",\"model_type\":\"detection\",\"visibility\":\"workspace\"}")"
model_id="$(echo "${model_resp}" | jq -r '.data.id // empty')"
if [[ -z "${model_id}" ]]; then
  echo "[smoke-real-closure] model draft creation failed."
  echo "${model_resp}"
  exit 1
fi

register_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/model-versions/register" \
  -d "{\"model_id\":\"${model_id}\",\"training_job_id\":\"${job_id}\",\"version_name\":\"real-yolo-v1\"}")"
model_version_id="$(echo "${register_resp}" | jq -r '.data.id // empty')"
version_artifact_id="$(echo "${register_resp}" | jq -r '.data.artifact_attachment_id // empty')"
if [[ -z "${model_version_id}" || -z "${version_artifact_id}" ]]; then
  echo "[smoke-real-closure] model version registration failed."
  echo "${register_resp}"
  exit 1
fi

pre_annotation_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/pre-annotations" \
  -d "{\"model_version_id\":\"${model_version_id}\"}")"
pre_total="$(echo "${pre_annotation_resp}" | jq -r '(.data.created // 0) + (.data.updated // 0)')"
if [[ "${pre_total}" -lt 1 ]]; then
  echo "[smoke-real-closure] pre-annotation did not create/update records."
  echo "${pre_annotation_resp}"
  exit 1
fi

pre_annotation_meta_framework="$(echo "${pre_annotation_resp}" | jq -r '.data.annotations[] | select(.source=="pre_annotation") | .payload.pre_annotation_meta.framework // empty' | head -n 1)"
if [[ "${pre_annotation_meta_framework}" != "yolo" ]]; then
  echo "[smoke-real-closure] pre-annotation payload meta is not from yolo."
  echo "${pre_annotation_resp}"
  exit 1
fi

infer_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -F "file=@${image_file}")"
infer_attachment_id="$(echo "${infer_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${infer_attachment_id}" ]]; then
  echo "[smoke-real-closure] inference input upload failed."
  echo "${infer_upload_resp}"
  exit 1
fi

for _ in {1..40}; do
  files_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/inference")"
  status="$(echo "${files_resp}" | jq -r --arg id "${infer_attachment_id}" '.data[] | select(.id==$id) | .status // empty')"
  [[ "${status}" == "ready" ]] && break
  sleep 0.2
done

infer_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${model_version_id}\",\"input_attachment_id\":\"${infer_attachment_id}\",\"task_type\":\"detection\"}")"
yolo_run_id="$(echo "${infer_resp}" | jq -r '.data.id // empty')"
yolo_source="$(echo "${infer_resp}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
yolo_box_count="$(echo "${infer_resp}" | jq -r '.data.normalized_output.boxes | length // 0')"
if [[ -z "${yolo_run_id}" || "${yolo_box_count}" -lt 1 ]]; then
  echo "[smoke-real-closure] yolo inference produced no boxes."
  echo "${infer_resp}"
  exit 1
fi

datasets_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets")"
mismatch_feedback_dataset_id="$(echo "${datasets_resp}" | jq -r '.data[] | select(.task_type!="detection") | .id' | head -n 1)"
if [[ -z "${mismatch_feedback_dataset_id}" ]]; then
  mismatch_dataset_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/datasets" \
    -d "{\"name\":\"real-closure-mismatch-$(date +%s)\",\"description\":\"feedback mismatch guard\",\"task_type\":\"ocr\",\"label_schema\":{\"classes\":[\"text\"]}}")"
  mismatch_feedback_dataset_id="$(echo "${mismatch_dataset_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${mismatch_feedback_dataset_id}" ]]; then
    echo "[smoke-real-closure] failed to create mismatch dataset."
    echo "${mismatch_dataset_resp}"
    exit 1
  fi
fi

mismatch_feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${yolo_run_id}/feedback" \
  -d "{\"dataset_id\":\"${mismatch_feedback_dataset_id}\",\"reason\":\"task_mismatch_guard\"}")"
mismatch_feedback_success="$(echo "${mismatch_feedback_resp}" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
mismatch_feedback_error_code="$(echo "${mismatch_feedback_resp}" | jq -r '.error.code // empty')"
mismatch_feedback_message="$(echo "${mismatch_feedback_resp}" | jq -r '.error.message // empty')"
if [[ "${mismatch_feedback_success}" != "false" || "${mismatch_feedback_error_code}" != "VALIDATION_ERROR" || "${mismatch_feedback_message}" != *"task_type"* || "${mismatch_feedback_message}" != *"match"* ]]; then
  echo "[smoke-real-closure] inference feedback task-type mismatch guard failed."
  echo "${mismatch_feedback_resp}"
  exit 1
fi

feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${yolo_run_id}/feedback" \
  -d "{\"dataset_id\":\"${dataset_id}\",\"reason\":\"missed_detection\"}")"
feedback_dataset_id="$(echo "${feedback_resp}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${feedback_dataset_id}" != "${dataset_id}" ]]; then
  echo "[smoke-real-closure] inference feedback did not bind target dataset."
  echo "${feedback_resp}"
  exit 1
fi

assert_feedback_trace "${dataset_id}" "${yolo_run_id}" "detection"

echo "Train No: CRH380A-1234" >"${TMP_OCR}"
ocr_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -F "file=@${TMP_OCR};filename=ocr-sample.txt;type=text/plain")"
ocr_attachment_id="$(echo "${ocr_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_attachment_id}" ]]; then
  echo "[smoke-real-closure] ocr input upload failed."
  echo "${ocr_upload_resp}"
  exit 1
fi

for _ in {1..40}; do
  files_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/inference")"
  status="$(echo "${files_resp}" | jq -r --arg id "${ocr_attachment_id}" '.data[] | select(.id==$id) | .status // empty')"
  [[ "${status}" == "ready" ]] && break
  sleep 0.2
done

ocr_model_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions")"
ocr_model_version_id="$(echo "${ocr_model_versions_resp}" | jq -r '.data[] | select(.task_type=="ocr" and .framework=="paddleocr" and .status=="registered") | .id' | head -n 1)"
if [[ -z "${ocr_model_version_id}" ]]; then
  ocr_model_version_id="$(echo "${ocr_model_versions_resp}" | jq -r '.data[] | select(.task_type=="ocr" and .status=="registered") | .id' | head -n 1)"
fi
if [[ -z "${ocr_model_version_id}" ]]; then
  echo "[smoke-real-closure] no registered OCR model version found for OCR inference step."
  echo "${ocr_model_versions_resp}"
  exit 1
fi

ocr_infer_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${ocr_model_version_id}\",\"input_attachment_id\":\"${ocr_attachment_id}\",\"task_type\":\"ocr\"}")"
ocr_run_id="$(echo "${ocr_infer_resp}" | jq -r '.data.id // empty')"
ocr_source="$(echo "${ocr_infer_resp}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
ocr_lines="$(echo "${ocr_infer_resp}" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
if [[ -z "${ocr_run_id}" || "${ocr_lines}" -lt 1 ]]; then
  echo "[smoke-real-closure] paddleocr inference produced no text lines."
  echo "${ocr_infer_resp}"
  exit 1
fi

ocr_dataset_id="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets" | jq -r '.data[] | select(.task_type == "ocr") | .id' | head -n 1)"
if [[ -z "${ocr_dataset_id}" ]]; then
  ocr_dataset_create_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/datasets" \
    -d "{\"name\":\"real-closure-ocr-target-$(date +%s)\",\"description\":\"real closure doctr ocr target\",\"task_type\":\"ocr\",\"label_schema\":{\"classes\":[\"text_line\"]}}")"
  ocr_dataset_id="$(echo "${ocr_dataset_create_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${ocr_dataset_id}" ]]; then
    echo "[smoke-real-closure] failed to create OCR dataset for doctr training."
    echo "${ocr_dataset_create_resp}"
    exit 1
  fi

  ocr_dataset_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/files/dataset/${ocr_dataset_id}/upload" \
    -d "{\"filename\":\"real-closure-ocr-target-$(date +%s).jpg\"}")"
  ocr_dataset_attachment_id="$(echo "${ocr_dataset_upload_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${ocr_dataset_attachment_id}" ]]; then
    echo "[smoke-real-closure] failed to upload OCR dataset sample for doctr training."
    echo "${ocr_dataset_upload_resp}"
    exit 1
  fi

  ocr_dataset_attachment_status=""
  for _ in {1..120}; do
    ocr_dataset_files_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/dataset/${ocr_dataset_id}")"
    ocr_dataset_attachment_status="$(echo "${ocr_dataset_files_resp}" | jq -r --arg id "${ocr_dataset_attachment_id}" '.data[] | select(.id==$id) | .status // empty')"
    if [[ "${ocr_dataset_attachment_status}" == "ready" ]]; then
      break
    fi
    if [[ "${ocr_dataset_attachment_status}" == "error" ]]; then
      echo "[smoke-real-closure] OCR dataset sample attachment entered error state."
      echo "${ocr_dataset_files_resp}"
      exit 1
    fi
    sleep 0.2
  done

  if [[ "${ocr_dataset_attachment_status}" != "ready" ]]; then
    echo "[smoke-real-closure] OCR dataset sample attachment not ready in time."
    echo "${ocr_dataset_files_resp}"
    exit 1
  fi

  ocr_dataset_detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${ocr_dataset_id}")"
  ocr_dataset_item_id="$(echo "${ocr_dataset_detail_resp}" | jq -r '.data.items[0].id // empty')"
  if [[ -z "${ocr_dataset_item_id}" ]]; then
    echo "[smoke-real-closure] OCR dataset item was not generated."
    echo "${ocr_dataset_detail_resp}"
    exit 1
  fi

  ocr_annotation_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/datasets/${ocr_dataset_id}/annotations" \
    -d "{\"dataset_item_id\":\"${ocr_dataset_item_id}\",\"task_type\":\"ocr\",\"source\":\"manual\",\"status\":\"annotated\",\"payload\":{\"lines\":[{\"text\":\"real closure doctr sample\",\"confidence\":0.99}]}}")"
  ocr_annotation_status="$(echo "${ocr_annotation_resp}" | jq -r '.data.status // empty')"
  if [[ "${ocr_annotation_status}" != "annotated" ]]; then
    echo "[smoke-real-closure] failed to annotate OCR dataset sample for doctr training."
    echo "${ocr_annotation_resp}"
    exit 1
  fi
fi

ocr_dataset_version_id="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${ocr_dataset_id}/versions" | jq -r '.data[0].id // empty')"
if [[ -z "${ocr_dataset_version_id}" ]]; then
  ocr_split_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/datasets/${ocr_dataset_id}/split" \
    -d '{"train_ratio":0.8,"val_ratio":0.1,"test_ratio":0.1,"seed":42}')"
  ocr_split_train_count="$(echo "${ocr_split_resp}" | jq -r '.data.split_summary.train // 0')"
  if [[ "${ocr_split_train_count}" -lt 1 ]]; then
    echo "[smoke-real-closure] ocr dataset split did not produce train items."
    echo "${ocr_split_resp}"
    exit 1
  fi

  ocr_version_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/datasets/${ocr_dataset_id}/versions" \
    -d '{"version_name":"real-closure-ocr-v1"}')"
  ocr_dataset_version_id="$(echo "${ocr_version_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${ocr_dataset_version_id}" ]]; then
    echo "[smoke-real-closure] ocr dataset version creation failed."
    echo "${ocr_version_resp}"
    exit 1
  fi
fi

ocr_mismatch_feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${ocr_run_id}/feedback" \
  -d "{\"dataset_id\":\"${dataset_id}\",\"reason\":\"task_mismatch_ocr_guard\"}")"
ocr_mismatch_feedback_success="$(echo "${ocr_mismatch_feedback_resp}" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
ocr_mismatch_feedback_error_code="$(echo "${ocr_mismatch_feedback_resp}" | jq -r '.error.code // empty')"
ocr_mismatch_feedback_message="$(echo "${ocr_mismatch_feedback_resp}" | jq -r '.error.message // empty')"
if [[ "${ocr_mismatch_feedback_success}" != "false" || "${ocr_mismatch_feedback_error_code}" != "VALIDATION_ERROR" || "${ocr_mismatch_feedback_message}" != *"task_type"* || "${ocr_mismatch_feedback_message}" != *"match"* ]]; then
  echo "[smoke-real-closure] ocr inference feedback task-type mismatch guard failed."
  echo "${ocr_mismatch_feedback_resp}"
  exit 1
fi

ocr_feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${ocr_run_id}/feedback" \
  -d "{\"dataset_id\":\"${ocr_dataset_id}\",\"reason\":\"ocr_low_confidence\"}")"
ocr_feedback_dataset_id="$(echo "${ocr_feedback_resp}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${ocr_feedback_dataset_id}" != "${ocr_dataset_id}" ]]; then
  echo "[smoke-real-closure] paddleocr feedback did not bind OCR dataset."
  echo "${ocr_feedback_resp}"
  exit 1
fi
assert_feedback_trace "${ocr_dataset_id}" "${ocr_run_id}" "paddleocr"

doctr_train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"real-doctr-job-$(date +%s)\",\"task_type\":\"ocr\",\"framework\":\"doctr\",\"dataset_id\":\"${ocr_dataset_id}\",\"dataset_version_id\":\"${ocr_dataset_version_id}\",\"base_model\":\"doctr-crnn\",\"config\":{\"epochs\":\"3\",\"batch_size\":\"2\",\"learning_rate\":\"0.001\"}}")"
doctr_job_id="$(echo "${doctr_train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${doctr_job_id}" ]]; then
  echo "[smoke-real-closure] doctr training job create failed."
  echo "${doctr_train_resp}"
  exit 1
fi

doctr_job_status=""
doctr_job_detail=""
for _ in {1..80}; do
  doctr_job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${doctr_job_id}")"
  doctr_job_status="$(echo "${doctr_job_detail}" | jq -r '.data.job.status // empty')"
  if [[ "${doctr_job_status}" == "completed" ]]; then
    break
  fi
  if [[ "${doctr_job_status}" == "failed" || "${doctr_job_status}" == "cancelled" ]]; then
    echo "[smoke-real-closure] doctr training job ended with ${doctr_job_status}."
    echo "${doctr_job_detail}"
    exit 1
  fi
  sleep 0.3
done

if [[ "${doctr_job_status}" != "completed" ]]; then
  echo "[smoke-real-closure] doctr training job timeout."
  echo "${doctr_job_detail}"
  exit 1
fi

doctr_model_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/models/draft" \
  -d "{\"name\":\"real-doctr-model-$(date +%s)\",\"description\":\"real closure doctr model\",\"model_type\":\"ocr\",\"visibility\":\"workspace\"}")"
doctr_model_id="$(echo "${doctr_model_resp}" | jq -r '.data.id // empty')"
if [[ -z "${doctr_model_id}" ]]; then
  echo "[smoke-real-closure] doctr model draft creation failed."
  echo "${doctr_model_resp}"
  exit 1
fi

doctr_register_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/model-versions/register" \
  -d "{\"model_id\":\"${doctr_model_id}\",\"training_job_id\":\"${doctr_job_id}\",\"version_name\":\"real-doctr-v1\"}")"
doctr_model_version_id="$(echo "${doctr_register_resp}" | jq -r '.data.id // empty')"
doctr_artifact_id="$(echo "${doctr_register_resp}" | jq -r '.data.artifact_attachment_id // empty')"
if [[ -z "${doctr_model_version_id}" || -z "${doctr_artifact_id}" ]]; then
  echo "[smoke-real-closure] doctr model version registration failed."
  echo "${doctr_register_resp}"
  exit 1
fi

doctr_infer_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${doctr_model_version_id}\",\"input_attachment_id\":\"${ocr_attachment_id}\",\"task_type\":\"ocr\"}")"
doctr_run_id="$(echo "${doctr_infer_resp}" | jq -r '.data.id // empty')"
doctr_source="$(echo "${doctr_infer_resp}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
doctr_lines="$(echo "${doctr_infer_resp}" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
if [[ -z "${doctr_run_id}" || "${doctr_lines}" -lt 1 ]]; then
  echo "[smoke-real-closure] doctr inference produced no text lines."
  echo "${doctr_infer_resp}"
  exit 1
fi

doctr_feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs/${doctr_run_id}/feedback" \
  -d "{\"dataset_id\":\"${ocr_dataset_id}\",\"reason\":\"doctr_recheck\"}")"
doctr_feedback_dataset_id="$(echo "${doctr_feedback_resp}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${doctr_feedback_dataset_id}" != "${ocr_dataset_id}" ]]; then
  echo "[smoke-real-closure] doctr feedback did not bind OCR dataset."
  echo "${doctr_feedback_resp}"
  exit 1
fi
assert_feedback_trace "${ocr_dataset_id}" "${doctr_run_id}" "doctr"

echo "[smoke-real-closure] PASS"
echo "dataset_id=${dataset_id}"
echo "job_id=${job_id}"
echo "model_version_id=${model_version_id}"
echo "doctr_job_id=${doctr_job_id}"
echo "doctr_model_version_id=${doctr_model_version_id}"
echo "yolo_run_id=${yolo_run_id}"
echo "ocr_run_id=${ocr_run_id}"
echo "doctr_run_id=${doctr_run_id}"
echo "yolo_source=${yolo_source}"
echo "ocr_source=${ocr_source}"
echo "doctr_source=${doctr_source}"
