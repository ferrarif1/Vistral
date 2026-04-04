#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-dataset-export-roundtrip] jq is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
TMP_YOLO_IMPORT="$(mktemp)"
TMP_YOLO_EXPORT="$(mktemp)"
TMP_COCO_EXPORT="$(mktemp)"
TMP_LABELME_EXPORT="$(mktemp)"
TMP_OCR_IMPORT="$(mktemp)"
TMP_OCR_EXPORT="$(mktemp)"
TMP_SEG_LABELME_IMPORT="$(mktemp)"
TMP_SEG_LABELME_EXPORT="$(mktemp)"
TMP_FALLBACK_IMAGE="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${TMP_YOLO_IMPORT}" "${TMP_YOLO_EXPORT}" "${TMP_COCO_EXPORT}" "${TMP_LABELME_EXPORT}" "${TMP_OCR_IMPORT}" "${TMP_OCR_EXPORT}" "${TMP_SEG_LABELME_IMPORT}" "${TMP_SEG_LABELME_EXPORT}" "${TMP_FALLBACK_IMAGE}"
}
trap cleanup EXIT

wait_dataset_attachment_ready() {
  local dataset_id="$1"
  local attachment_id="$2"
  local attempts=0
  local status=""
  while true; do
    detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
    status="$(echo "${detail}" | jq -r --arg id "${attachment_id}" '.data.attachments[] | select(.id==$id) | .status // empty')"
    if [[ "${status}" == "ready" ]]; then
      return 0
    fi
    attempts=$((attempts + 1))
    if [[ ${attempts} -gt 60 ]]; then
      echo "[smoke-dataset-export-roundtrip] timeout waiting attachment ready: dataset=${dataset_id}, attachment=${attachment_id}."
      echo "${detail}"
      return 1
    fi
    sleep 0.2
  done
}

cd "${ROOT_DIR}"

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

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  if [[ "${START_API}" == "true" ]]; then
    echo "[smoke-dataset-export-roundtrip] API failed to start."
    cat "${API_LOG}"
  else
    echo "[smoke-dataset-export-roundtrip] API is unreachable at ${BASE_URL}."
  fi
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

if [[ -n "${AUTH_USERNAME}" ]]; then
  if [[ -z "${AUTH_PASSWORD}" ]]; then
    echo "[smoke-dataset-export-roundtrip] AUTH_PASSWORD is required when AUTH_USERNAME is set."
    exit 1
  fi

  login_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "${login_response}" | jq -r '.success // false')"
  if [[ "${login_success}" != "true" ]]; then
    echo "[smoke-dataset-export-roundtrip] login failed for AUTH_USERNAME=${AUTH_USERNAME}."
    echo "${login_response}"
    exit 1
  fi

  csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
  if [[ -z "${csrf_token}" ]]; then
    echo "[smoke-dataset-export-roundtrip] failed to refresh CSRF token after login."
    echo "${csrf_response}"
    exit 1
  fi
fi

image_file="$(find "${ROOT_DIR}/demo_data" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit)"
if [[ -z "${image_file}" ]]; then
  printf 'roundtrip synthetic image payload\n' >"${TMP_FALLBACK_IMAGE}"
  image_file="${TMP_FALLBACK_IMAGE}"
fi

# Detection: source dataset -> export yolo -> import into target dataset
det_src_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"roundtrip-det-src-$(date +%s)\",\"description\":\"roundtrip source detection\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}")"
det_src_id="$(echo "${det_src_resp}" | jq -r '.data.id // empty')"
if [[ -z "${det_src_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to create source detection dataset."
  echo "${det_src_resp}"
  exit 1
fi

det_img_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${det_src_id}/upload" \
  -F "file=@${image_file}")"
det_img_attachment_id="$(echo "${det_img_upload_resp}" | jq -r '.data.id // empty')"
det_img_filename="$(echo "${det_img_upload_resp}" | jq -r '.data.filename // empty')"
if [[ -z "${det_img_attachment_id}" || -z "${det_img_filename}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload source detection image."
  echo "${det_img_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${det_src_id}" "${det_img_attachment_id}"

echo "${det_img_filename} defect 120 88 160 110 0.94" >"${TMP_YOLO_IMPORT}"
yolo_import_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${det_src_id}/upload" \
  -F "file=@${TMP_YOLO_IMPORT};filename=roundtrip-import-yolo.txt;type=text/plain")"
yolo_import_attachment_id="$(echo "${yolo_import_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${yolo_import_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload yolo import file."
  echo "${yolo_import_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${det_src_id}" "${yolo_import_attachment_id}"

yolo_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${det_src_id}/import" \
  -d "{\"format\":\"yolo\",\"attachment_id\":\"${yolo_import_attachment_id}\"}")"
yolo_import_total="$(echo "${yolo_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${yolo_import_total}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] source yolo import did not modify annotations."
  echo "${yolo_import_resp}"
  exit 1
fi

yolo_export_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${det_src_id}/export" \
  -d '{"format":"yolo"}')"
yolo_export_attachment_id="$(echo "${yolo_export_resp}" | jq -r '.data.attachment_id // empty')"
if [[ -z "${yolo_export_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] source yolo export did not produce attachment."
  echo "${yolo_export_resp}"
  exit 1
fi

curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/files/${yolo_export_attachment_id}/content" >"${TMP_YOLO_EXPORT}"
yolo_export_format="$(jq -r '.format // empty' "${TMP_YOLO_EXPORT}")"
yolo_export_items="$(jq -r '.items | length // 0' "${TMP_YOLO_EXPORT}")"
yolo_export_boxes="$(jq -r '.items[0].boxes | length // 0' "${TMP_YOLO_EXPORT}")"
if [[ "${yolo_export_format}" != "yolo" || "${yolo_export_items}" -lt 1 || "${yolo_export_boxes}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] source yolo export content is invalid."
  cat "${TMP_YOLO_EXPORT}"
  exit 1
fi

det_target_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"roundtrip-det-target-$(date +%s)\",\"description\":\"roundtrip target detection\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}")"
det_target_id="$(echo "${det_target_resp}" | jq -r '.data.id // empty')"
if [[ -z "${det_target_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to create target detection dataset."
  echo "${det_target_resp}"
  exit 1
fi

yolo_roundtrip_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${det_target_id}/upload" \
  -F "file=@${TMP_YOLO_EXPORT};filename=roundtrip-yolo-export.json;type=application/json")"
yolo_roundtrip_attachment_id="$(echo "${yolo_roundtrip_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${yolo_roundtrip_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload yolo export into target dataset."
  echo "${yolo_roundtrip_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${det_target_id}" "${yolo_roundtrip_attachment_id}"

yolo_roundtrip_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${det_target_id}/import" \
  -d "{\"format\":\"yolo\",\"attachment_id\":\"${yolo_roundtrip_attachment_id}\"}")"
yolo_roundtrip_total="$(echo "${yolo_roundtrip_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${yolo_roundtrip_total}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] yolo roundtrip import did not modify annotations."
  echo "${yolo_roundtrip_import_resp}"
  exit 1
fi

det_target_annotations_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${det_target_id}/annotations")"
det_target_boxes="$(echo "${det_target_annotations_resp}" | jq -r '[.data[] | (.payload.boxes // []) | length] | add // 0')"
if [[ "${det_target_boxes}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] target detection dataset has no imported boxes after roundtrip."
  echo "${det_target_annotations_resp}"
  exit 1
fi

# Detection: source dataset -> export coco -> import into target dataset
coco_export_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${det_src_id}/export" \
  -d '{"format":"coco"}')"
coco_export_attachment_id="$(echo "${coco_export_resp}" | jq -r '.data.attachment_id // empty')"
if [[ -z "${coco_export_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] source coco export did not produce attachment."
  echo "${coco_export_resp}"
  exit 1
fi

curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/files/${coco_export_attachment_id}/content" >"${TMP_COCO_EXPORT}"
coco_export_format="$(jq -r '.format // empty' "${TMP_COCO_EXPORT}")"
coco_export_images="$(jq -r '.images | length // 0' "${TMP_COCO_EXPORT}")"
coco_export_annotations="$(jq -r '.annotations | length // 0' "${TMP_COCO_EXPORT}")"
coco_export_categories="$(jq -r '.categories | length // 0' "${TMP_COCO_EXPORT}")"
if [[ "${coco_export_format}" != "coco" || "${coco_export_images}" -lt 1 || "${coco_export_annotations}" -lt 1 || "${coco_export_categories}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] source coco export content is invalid."
  cat "${TMP_COCO_EXPORT}"
  exit 1
fi

det_target_coco_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"roundtrip-det-target-coco-$(date +%s)\",\"description\":\"roundtrip target detection coco\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}")"
det_target_coco_id="$(echo "${det_target_coco_resp}" | jq -r '.data.id // empty')"
if [[ -z "${det_target_coco_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to create target detection dataset for coco."
  echo "${det_target_coco_resp}"
  exit 1
fi

coco_roundtrip_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${det_target_coco_id}/upload" \
  -F "file=@${TMP_COCO_EXPORT};filename=roundtrip-coco-export.json;type=application/json")"
coco_roundtrip_attachment_id="$(echo "${coco_roundtrip_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${coco_roundtrip_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload coco export into target dataset."
  echo "${coco_roundtrip_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${det_target_coco_id}" "${coco_roundtrip_attachment_id}"

coco_roundtrip_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${det_target_coco_id}/import" \
  -d "{\"format\":\"coco\",\"attachment_id\":\"${coco_roundtrip_attachment_id}\"}")"
coco_roundtrip_total="$(echo "${coco_roundtrip_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${coco_roundtrip_total}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] coco roundtrip import did not modify annotations."
  echo "${coco_roundtrip_import_resp}"
  exit 1
fi

det_target_coco_annotations_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${det_target_coco_id}/annotations")"
det_target_coco_boxes="$(echo "${det_target_coco_annotations_resp}" | jq -r '[.data[] | (.payload.boxes // []) | length] | add // 0')"
if [[ "${det_target_coco_boxes}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] target detection coco dataset has no imported boxes after roundtrip."
  echo "${det_target_coco_annotations_resp}"
  exit 1
fi

# Detection: source dataset -> export labelme -> import into target dataset
labelme_export_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${det_src_id}/export" \
  -d '{"format":"labelme"}')"
labelme_export_attachment_id="$(echo "${labelme_export_resp}" | jq -r '.data.attachment_id // empty')"
if [[ -z "${labelme_export_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] source labelme export did not produce attachment."
  echo "${labelme_export_resp}"
  exit 1
fi

curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/files/${labelme_export_attachment_id}/content" >"${TMP_LABELME_EXPORT}"
labelme_export_format="$(jq -r '.format // empty' "${TMP_LABELME_EXPORT}")"
labelme_export_items="$(jq -r '.items | length // 0' "${TMP_LABELME_EXPORT}")"
labelme_export_shapes="$(jq -r '.items[0].shapes | length // 0' "${TMP_LABELME_EXPORT}")"
if [[ "${labelme_export_format}" != "labelme" || "${labelme_export_items}" -lt 1 || "${labelme_export_shapes}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] source labelme export content is invalid."
  cat "${TMP_LABELME_EXPORT}"
  exit 1
fi

det_target_labelme_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"roundtrip-det-target-labelme-$(date +%s)\",\"description\":\"roundtrip target detection labelme\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}")"
det_target_labelme_id="$(echo "${det_target_labelme_resp}" | jq -r '.data.id // empty')"
if [[ -z "${det_target_labelme_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to create target detection dataset for labelme."
  echo "${det_target_labelme_resp}"
  exit 1
fi

labelme_roundtrip_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${det_target_labelme_id}/upload" \
  -F "file=@${TMP_LABELME_EXPORT};filename=roundtrip-labelme-export.json;type=application/json")"
labelme_roundtrip_attachment_id="$(echo "${labelme_roundtrip_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${labelme_roundtrip_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload labelme export into target dataset."
  echo "${labelme_roundtrip_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${det_target_labelme_id}" "${labelme_roundtrip_attachment_id}"

labelme_roundtrip_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${det_target_labelme_id}/import" \
  -d "{\"format\":\"labelme\",\"attachment_id\":\"${labelme_roundtrip_attachment_id}\"}")"
labelme_roundtrip_total="$(echo "${labelme_roundtrip_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${labelme_roundtrip_total}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] labelme roundtrip import did not modify annotations."
  echo "${labelme_roundtrip_import_resp}"
  exit 1
fi

det_target_labelme_annotations_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${det_target_labelme_id}/annotations")"
det_target_labelme_boxes="$(echo "${det_target_labelme_annotations_resp}" | jq -r '[.data[] | (.payload.boxes // []) | length] | add // 0')"
if [[ "${det_target_labelme_boxes}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] target detection labelme dataset has no imported boxes after roundtrip."
  echo "${det_target_labelme_annotations_resp}"
  exit 1
fi

# OCR: source dataset -> export ocr -> import into target dataset
ocr_src_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"roundtrip-ocr-src-$(date +%s)\",\"description\":\"roundtrip source ocr\",\"task_type\":\"ocr\",\"label_schema\":{\"classes\":[\"text\"]}}")"
ocr_src_id="$(echo "${ocr_src_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_src_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to create source ocr dataset."
  echo "${ocr_src_resp}"
  exit 1
fi

ocr_img_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${ocr_src_id}/upload" \
  -F "file=@${image_file}")"
ocr_img_attachment_id="$(echo "${ocr_img_upload_resp}" | jq -r '.data.id // empty')"
ocr_img_filename="$(echo "${ocr_img_upload_resp}" | jq -r '.data.filename // empty')"
if [[ -z "${ocr_img_attachment_id}" || -z "${ocr_img_filename}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload source ocr image."
  echo "${ocr_img_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${ocr_src_id}" "${ocr_img_attachment_id}"

printf "%s\tTrain No CRH380A-1022\t0.95\n" "${ocr_img_filename}" >"${TMP_OCR_IMPORT}"
ocr_import_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${ocr_src_id}/upload" \
  -F "file=@${TMP_OCR_IMPORT};filename=roundtrip-import-ocr.txt;type=text/plain")"
ocr_import_attachment_id="$(echo "${ocr_import_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_import_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload ocr import file."
  echo "${ocr_import_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${ocr_src_id}" "${ocr_import_attachment_id}"

ocr_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${ocr_src_id}/import" \
  -d "{\"format\":\"ocr\",\"attachment_id\":\"${ocr_import_attachment_id}\"}")"
ocr_import_total="$(echo "${ocr_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${ocr_import_total}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] source ocr import did not modify annotations."
  echo "${ocr_import_resp}"
  exit 1
fi

ocr_export_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${ocr_src_id}/export" \
  -d '{"format":"ocr"}')"
ocr_export_attachment_id="$(echo "${ocr_export_resp}" | jq -r '.data.attachment_id // empty')"
if [[ -z "${ocr_export_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] source ocr export did not produce attachment."
  echo "${ocr_export_resp}"
  exit 1
fi

curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/files/${ocr_export_attachment_id}/content" >"${TMP_OCR_EXPORT}"
ocr_export_format="$(jq -r '.format // empty' "${TMP_OCR_EXPORT}")"
ocr_export_items="$(jq -r '.items | length // 0' "${TMP_OCR_EXPORT}")"
ocr_export_lines="$(jq -r '.items[0].lines | length // 0' "${TMP_OCR_EXPORT}")"
if [[ "${ocr_export_format}" != "ocr" || "${ocr_export_items}" -lt 1 || "${ocr_export_lines}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] source ocr export content is invalid."
  cat "${TMP_OCR_EXPORT}"
  exit 1
fi

ocr_target_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"roundtrip-ocr-target-$(date +%s)\",\"description\":\"roundtrip target ocr\",\"task_type\":\"ocr\",\"label_schema\":{\"classes\":[\"text\"]}}")"
ocr_target_id="$(echo "${ocr_target_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_target_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to create target ocr dataset."
  echo "${ocr_target_resp}"
  exit 1
fi

ocr_roundtrip_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${ocr_target_id}/upload" \
  -F "file=@${TMP_OCR_EXPORT};filename=roundtrip-ocr-export.json;type=application/json")"
ocr_roundtrip_attachment_id="$(echo "${ocr_roundtrip_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_roundtrip_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload ocr export into target dataset."
  echo "${ocr_roundtrip_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${ocr_target_id}" "${ocr_roundtrip_attachment_id}"

ocr_roundtrip_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${ocr_target_id}/import" \
  -d "{\"format\":\"ocr\",\"attachment_id\":\"${ocr_roundtrip_attachment_id}\"}")"
ocr_roundtrip_total="$(echo "${ocr_roundtrip_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${ocr_roundtrip_total}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] ocr roundtrip import did not modify annotations."
  echo "${ocr_roundtrip_import_resp}"
  exit 1
fi

ocr_target_annotations_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${ocr_target_id}/annotations")"
ocr_target_lines="$(echo "${ocr_target_annotations_resp}" | jq -r '[.data[] | (.payload.lines // []) | length] | add // 0')"
if [[ "${ocr_target_lines}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] target ocr dataset has no imported lines after roundtrip."
  echo "${ocr_target_annotations_resp}"
  exit 1
fi

# Segmentation: source dataset -> export labelme -> import into target dataset (polygon roundtrip)
seg_src_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"roundtrip-seg-src-$(date +%s)\",\"description\":\"roundtrip source segmentation\",\"task_type\":\"segmentation\",\"label_schema\":{\"classes\":[\"region\"]}}")"
seg_src_id="$(echo "${seg_src_resp}" | jq -r '.data.id // empty')"
if [[ -z "${seg_src_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to create source segmentation dataset."
  echo "${seg_src_resp}"
  exit 1
fi

seg_img_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${seg_src_id}/upload" \
  -F "file=@${image_file}")"
seg_img_attachment_id="$(echo "${seg_img_upload_resp}" | jq -r '.data.id // empty')"
seg_img_filename="$(echo "${seg_img_upload_resp}" | jq -r '.data.filename // empty')"
if [[ -z "${seg_img_attachment_id}" || -z "${seg_img_filename}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload source segmentation image."
  echo "${seg_img_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${seg_src_id}" "${seg_img_attachment_id}"

cat >"${TMP_SEG_LABELME_IMPORT}" <<JSON
{
  "imagePath": "${seg_img_filename}",
  "shapes": [
    {
      "label": "region",
      "shape_type": "polygon",
      "points": [[120, 90], [280, 110], [260, 300], [110, 260]]
    }
  ]
}
JSON

seg_labelme_import_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${seg_src_id}/upload" \
  -F "file=@${TMP_SEG_LABELME_IMPORT};filename=roundtrip-seg-import-labelme.json;type=application/json")"
seg_labelme_import_attachment_id="$(echo "${seg_labelme_import_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${seg_labelme_import_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload segmentation labelme import file."
  echo "${seg_labelme_import_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${seg_src_id}" "${seg_labelme_import_attachment_id}"

seg_labelme_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${seg_src_id}/import" \
  -d "{\"format\":\"labelme\",\"attachment_id\":\"${seg_labelme_import_attachment_id}\"}")"
seg_labelme_import_total="$(echo "${seg_labelme_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${seg_labelme_import_total}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] source segmentation labelme import did not modify annotations."
  echo "${seg_labelme_import_resp}"
  exit 1
fi

seg_src_annotations_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${seg_src_id}/annotations")"
seg_src_polygons="$(echo "${seg_src_annotations_resp}" | jq -r '[.data[] | (.payload.polygons // []) | length] | add // 0')"
if [[ "${seg_src_polygons}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] source segmentation dataset has no polygons after import."
  echo "${seg_src_annotations_resp}"
  exit 1
fi

seg_labelme_export_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${seg_src_id}/export" \
  -d '{"format":"labelme"}')"
seg_labelme_export_attachment_id="$(echo "${seg_labelme_export_resp}" | jq -r '.data.attachment_id // empty')"
if [[ -z "${seg_labelme_export_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] source segmentation labelme export did not produce attachment."
  echo "${seg_labelme_export_resp}"
  exit 1
fi

curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/files/${seg_labelme_export_attachment_id}/content" >"${TMP_SEG_LABELME_EXPORT}"
seg_export_format="$(jq -r '.format // empty' "${TMP_SEG_LABELME_EXPORT}")"
seg_export_items="$(jq -r '.items | length // 0' "${TMP_SEG_LABELME_EXPORT}")"
seg_export_polygon_shapes="$(jq -r '[.items[]?.shapes[]? | select(.shape_type == "polygon")] | length' "${TMP_SEG_LABELME_EXPORT}")"
if [[ "${seg_export_format}" != "labelme" || "${seg_export_items}" -lt 1 || "${seg_export_polygon_shapes}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] source segmentation labelme export content is invalid."
  cat "${TMP_SEG_LABELME_EXPORT}"
  exit 1
fi

seg_target_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "{\"name\":\"roundtrip-seg-target-$(date +%s)\",\"description\":\"roundtrip target segmentation\",\"task_type\":\"segmentation\",\"label_schema\":{\"classes\":[\"region\"]}}")"
seg_target_id="$(echo "${seg_target_resp}" | jq -r '.data.id // empty')"
if [[ -z "${seg_target_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to create target segmentation dataset."
  echo "${seg_target_resp}"
  exit 1
fi

seg_roundtrip_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${seg_target_id}/upload" \
  -F "file=@${TMP_SEG_LABELME_EXPORT};filename=roundtrip-seg-labelme-export.json;type=application/json")"
seg_roundtrip_attachment_id="$(echo "${seg_roundtrip_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${seg_roundtrip_attachment_id}" ]]; then
  echo "[smoke-dataset-export-roundtrip] failed to upload segmentation labelme export into target dataset."
  echo "${seg_roundtrip_upload_resp}"
  exit 1
fi
wait_dataset_attachment_ready "${seg_target_id}" "${seg_roundtrip_attachment_id}"

seg_roundtrip_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${seg_target_id}/import" \
  -d "{\"format\":\"labelme\",\"attachment_id\":\"${seg_roundtrip_attachment_id}\"}")"
seg_roundtrip_total="$(echo "${seg_roundtrip_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${seg_roundtrip_total}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] segmentation labelme roundtrip import did not modify annotations."
  echo "${seg_roundtrip_import_resp}"
  exit 1
fi

seg_target_annotations_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${seg_target_id}/annotations")"
seg_target_polygons="$(echo "${seg_target_annotations_resp}" | jq -r '[.data[] | (.payload.polygons // []) | length] | add // 0')"
if [[ "${seg_target_polygons}" -lt 1 ]]; then
  echo "[smoke-dataset-export-roundtrip] target segmentation dataset has no polygons after roundtrip."
  echo "${seg_target_annotations_resp}"
  exit 1
fi

echo "[smoke-dataset-export-roundtrip] PASS"
echo "det_source=${det_src_id}"
echo "det_target=${det_target_id}"
echo "det_target_coco=${det_target_coco_id}"
echo "det_target_labelme=${det_target_labelme_id}"
echo "ocr_source=${ocr_src_id}"
echo "ocr_target=${ocr_target_id}"
echo "seg_source=${seg_src_id}"
echo "seg_target=${seg_target_id}"
