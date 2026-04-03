#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
BASE_URL="http://${API_HOST}:${API_PORT}"

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
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${TMP_YOLO}" "${TMP_OCR}" "${TMP_COCO}" "${TMP_LABELME}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
PADDLEOCR_RUNTIME_ENDPOINT="" \
DOCTR_RUNTIME_ENDPOINT="" \
YOLO_RUNTIME_ENDPOINT="" \
npm run dev:api >"${API_LOG}" 2>&1 &
API_PID=$!

for _ in {1..80}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-real-closure] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-real-closure] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

image_file="$(find "${ROOT_DIR}/demo_data" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit)"
if [[ -z "${image_file}" ]]; then
  echo "[smoke-real-closure] no demo image found under ${ROOT_DIR}/demo_data."
  exit 1
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

train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"real-yolo-job-$(date +%s)\",\"task_type\":\"detection\",\"framework\":\"yolo\",\"dataset_id\":\"${dataset_id}\",\"base_model\":\"yolo11n\",\"config\":{\"epochs\":\"6\",\"batch_size\":\"2\",\"learning_rate\":\"0.0008\"}}")"
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
  -X POST "${BASE_URL}/api/files/conversation/upload" \
  -F "file=@${image_file}")"
infer_attachment_id="$(echo "${infer_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${infer_attachment_id}" ]]; then
  echo "[smoke-real-closure] inference input upload failed."
  echo "${infer_upload_resp}"
  exit 1
fi

for _ in {1..40}; do
  files_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/conversation")"
  status="$(echo "${files_resp}" | jq -r --arg id "${infer_attachment_id}" '.data[] | select(.id==$id) | .status // empty')"
  [[ "${status}" == "ready" ]] && break
  sleep 0.2
done

infer_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${model_version_id}\",\"input_attachment_id\":\"${infer_attachment_id}\",\"task_type\":\"detection\"}")"
yolo_source="$(echo "${infer_resp}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
yolo_box_count="$(echo "${infer_resp}" | jq -r '.data.normalized_output.boxes | length // 0')"
if [[ "${yolo_box_count}" -lt 1 ]]; then
  echo "[smoke-real-closure] yolo inference produced no boxes."
  echo "${infer_resp}"
  exit 1
fi

echo "Train No: CRH380A-1234" >"${TMP_OCR}"
ocr_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/conversation/upload" \
  -F "file=@${TMP_OCR};filename=ocr-sample.txt;type=text/plain")"
ocr_attachment_id="$(echo "${ocr_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_attachment_id}" ]]; then
  echo "[smoke-real-closure] ocr input upload failed."
  echo "${ocr_upload_resp}"
  exit 1
fi

for _ in {1..40}; do
  files_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/conversation")"
  status="$(echo "${files_resp}" | jq -r --arg id "${ocr_attachment_id}" '.data[] | select(.id==$id) | .status // empty')"
  [[ "${status}" == "ready" ]] && break
  sleep 0.2
done

ocr_infer_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"mv-1\",\"input_attachment_id\":\"${ocr_attachment_id}\",\"task_type\":\"ocr\"}")"
ocr_source="$(echo "${ocr_infer_resp}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
ocr_lines="$(echo "${ocr_infer_resp}" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
if [[ "${ocr_lines}" -lt 1 ]]; then
  echo "[smoke-real-closure] paddleocr inference produced no text lines."
  echo "${ocr_infer_resp}"
  exit 1
fi

echo "[smoke-real-closure] PASS"
echo "dataset_id=${dataset_id}"
echo "job_id=${job_id}"
echo "model_version_id=${model_version_id}"
echo "yolo_source=${yolo_source}"
echo "ocr_source=${ocr_source}"
