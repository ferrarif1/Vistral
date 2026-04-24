#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-dataset-delete-consistency] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-dataset-delete-consistency] python3 is required."
  exit 1
fi

if [[ "${START_API}" == "true" && -z "${API_PORT:-}" ]]; then
  API_PORT="$(
    python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
  )"
fi
API_PORT="${API_PORT:-8811}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
DOWNLOAD_FILE="$(mktemp)"
SYNTH_IMAGE_FILE=""
API_PID=""
csrf_token=""

sample_image_file="$(
  find "${ROOT_DIR}/demo_data" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit 2>/dev/null || true
)"
if [[ -z "${sample_image_file}" ]]; then
  SYNTH_IMAGE_FILE="$(mktemp "${TMPDIR:-/tmp}/dataset-delete-consistency.XXXXXX.png")"
  python3 - "${SYNTH_IMAGE_FILE}" <<'PY'
import base64
import pathlib
import sys

payload = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZlN8AAAAASUVORK5CYII="
)
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(payload))
PY
  sample_image_file="${SYNTH_IMAGE_FILE}"
fi

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${DOWNLOAD_FILE}" "${SYNTH_IMAGE_FILE:-}"
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

refresh_csrf_token() {
  csrf_token="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf" | jq -r '.data.csrf_token // empty')"
}

wait_dataset_attachment_ready() {
  local dataset_id="$1"
  local attachment_id="$2"
  local label="$3"
  local list_resp=""
  local attachment_status=""

  for _ in $(seq 1 120); do
    list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/dataset/${dataset_id}")"
    attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"

    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi

    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-dataset-delete-consistency] ${label} entered error state."
      echo "${list_resp}"
      exit 1
    fi

    sleep 0.25
  done

  echo "[smoke-dataset-delete-consistency] ${label} not ready in time."
  echo "${list_resp}"
  exit 1
}

create_dataset() {
  local dataset_name="$1"
  local created_dataset=""
  local dataset_id=""

  created_dataset="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/datasets" \
    -d "{\"name\":\"${dataset_name}\",\"description\":\"dataset delete consistency smoke\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}")"
  dataset_id="$(echo "${created_dataset}" | jq -r '.data.id // empty')"
  if [[ -z "${dataset_id}" ]]; then
    echo "[smoke-dataset-delete-consistency] failed to create dataset ${dataset_name}."
    echo "${created_dataset}"
    exit 1
  fi

  echo "${dataset_id}"
}

upload_attachment_for_dataset() {
  local dataset_id="$1"
  local upload_label="$2"
  local upload_resp=""
  local attachment_id=""

  upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/files/dataset/${dataset_id}/upload" \
    -F "file=@${sample_image_file};filename=${upload_label}.png;type=image/png")"
  attachment_id="$(echo "${upload_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${attachment_id}" ]]; then
    echo "[smoke-dataset-delete-consistency] failed to upload ${upload_label}."
    echo "${upload_resp}"
    exit 1
  fi

  wait_dataset_attachment_ready "${dataset_id}" "${attachment_id}" "${upload_label}"
  echo "${attachment_id}"
}

find_dataset_item_by_attachment() {
  local dataset_id="$1"
  local attachment_id="$2"
  local detail_resp=""
  local item_id=""

  detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
  item_id="$(echo "${detail_resp}" | jq -r --arg aid "${attachment_id}" '.data.items[] | select(.attachment_id==$aid) | .id // empty' | head -n 1)"
  if [[ -z "${item_id}" ]]; then
    echo "[smoke-dataset-delete-consistency] failed to resolve dataset item for attachment ${attachment_id}."
    echo "${detail_resp}"
    exit 1
  fi

  echo "${item_id}"
}

create_annotation_for_item() {
  local dataset_id="$1"
  local item_id="$2"
  local annotation_resp=""
  local annotation_id=""

  annotation_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/datasets/${dataset_id}/annotations" \
    -d "{\"dataset_item_id\":\"${item_id}\",\"task_type\":\"detection\",\"source\":\"manual\",\"status\":\"annotated\",\"payload\":{\"boxes\":[{\"id\":\"box-smoke\",\"x\":18,\"y\":22,\"width\":60,\"height\":48,\"label\":\"defect\"}]}}")"
  annotation_id="$(echo "${annotation_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${annotation_id}" ]]; then
    echo "[smoke-dataset-delete-consistency] failed to create annotation for item ${item_id}."
    echo "${annotation_resp}"
    exit 1
  fi
}

assert_file_readable() {
  local attachment_id="$1"
  local label="$2"
  local status_code=""
  status_code="$(curl -s -o "${DOWNLOAD_FILE}" -w "%{http_code}" -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/${attachment_id}/content")"
  if [[ "${status_code}" != "200" ]]; then
    echo "[smoke-dataset-delete-consistency] ${label} file content expected 200, got ${status_code}."
    exit 1
  fi
}

assert_cleanup_complete() {
  local dataset_id="$1"
  local item_id="$2"
  local attachment_id="$3"
  local scenario="$4"
  local dataset_resp=""
  local annotations_resp=""
  local item_exists=""
  local attachment_exists=""
  local annotation_exists=""
  local file_status=""

  dataset_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
  item_exists="$(echo "${dataset_resp}" | jq -r --arg item_id "${item_id}" '[.data.items[] | select(.id==$item_id)] | length')"
  attachment_exists="$(echo "${dataset_resp}" | jq -r --arg attachment_id "${attachment_id}" '[.data.attachments[] | select(.id==$attachment_id)] | length')"
  if [[ "${item_exists}" != "0" || "${attachment_exists}" != "0" ]]; then
    echo "[smoke-dataset-delete-consistency] ${scenario} cleanup incomplete in dataset detail."
    echo "${dataset_resp}"
    exit 1
  fi

  annotations_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
  annotation_exists="$(echo "${annotations_resp}" | jq -r --arg item_id "${item_id}" '[.data[] | select(.dataset_item_id==$item_id)] | length')"
  if [[ "${annotation_exists}" != "0" ]]; then
    echo "[smoke-dataset-delete-consistency] ${scenario} annotation cleanup incomplete."
    echo "${annotations_resp}"
    exit 1
  fi

  file_status="$(curl -s -o /dev/null -w "%{http_code}" -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/files/${attachment_id}/content")"
  if [[ "${file_status}" != "404" ]]; then
    echo "[smoke-dataset-delete-consistency] ${scenario} file expected 404 after cleanup, got ${file_status}."
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
    if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
      echo "[smoke-dataset-delete-consistency] API process exited before health check (possible port conflict)."
      cat "${API_LOG}"
      exit 1
    fi
    echo "[smoke-dataset-delete-consistency] API failed to start."
    cat "${API_LOG}"
  else
    echo "[smoke-dataset-delete-consistency] API is unreachable at ${BASE_URL}."
  fi
  exit 1
fi

refresh_csrf_token
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-dataset-delete-consistency] failed to obtain CSRF token."
  exit 1
fi

if [[ -n "${AUTH_USERNAME}" ]]; then
  if [[ -z "${AUTH_PASSWORD}" ]]; then
    echo "[smoke-dataset-delete-consistency] AUTH_PASSWORD is required when AUTH_USERNAME is set."
    exit 1
  fi

  login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "${login_resp}" | jq -r '.success // false')"
  if [[ "${login_success}" != "true" ]]; then
    echo "[smoke-dataset-delete-consistency] login failed for AUTH_USERNAME=${AUTH_USERNAME}."
    echo "${login_resp}"
    exit 1
  fi
  refresh_csrf_token
  if [[ -z "${csrf_token}" ]]; then
    echo "[smoke-dataset-delete-consistency] failed to refresh CSRF token after login."
    exit 1
  fi
fi

run_tag="$(date +%s)"

# Scenario A: delete dataset item -> attachment + annotation + file content must be cleaned.
dataset_item_delete_id="$(create_dataset "dataset-delete-item-${run_tag}")"
attachment_item_delete_id="$(upload_attachment_for_dataset "${dataset_item_delete_id}" "item-delete-${run_tag}")"
item_to_delete_id="$(find_dataset_item_by_attachment "${dataset_item_delete_id}" "${attachment_item_delete_id}")"
create_annotation_for_item "${dataset_item_delete_id}" "${item_to_delete_id}"
assert_file_readable "${attachment_item_delete_id}" "scenario A before delete"

delete_item_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X DELETE "${BASE_URL}/api/datasets/${dataset_item_delete_id}/items/${item_to_delete_id}")"
delete_item_success="$(echo "${delete_item_resp}" | jq -r '.success // false')"
if [[ "${delete_item_success}" != "true" ]]; then
  echo "[smoke-dataset-delete-consistency] scenario A delete item failed."
  echo "${delete_item_resp}"
  exit 1
fi

delete_item_again_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X DELETE "${BASE_URL}/api/datasets/${dataset_item_delete_id}/items/${item_to_delete_id}")"
delete_item_again_success="$(echo "${delete_item_again_resp}" | jq -r '.success // false')"
if [[ "${delete_item_again_success}" != "true" ]]; then
  echo "[smoke-dataset-delete-consistency] scenario A second delete should be idempotent."
  echo "${delete_item_again_resp}"
  exit 1
fi

assert_cleanup_complete "${dataset_item_delete_id}" "${item_to_delete_id}" "${attachment_item_delete_id}" "scenario A"

# Scenario B: delete dataset attachment -> item + annotation + file content must be cleaned.
dataset_attachment_delete_id="$(create_dataset "dataset-delete-attachment-${run_tag}")"
attachment_to_delete_id="$(upload_attachment_for_dataset "${dataset_attachment_delete_id}" "attachment-delete-${run_tag}")"
item_for_attachment_delete_id="$(find_dataset_item_by_attachment "${dataset_attachment_delete_id}" "${attachment_to_delete_id}")"
create_annotation_for_item "${dataset_attachment_delete_id}" "${item_for_attachment_delete_id}"
assert_file_readable "${attachment_to_delete_id}" "scenario B before delete"

delete_attachment_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X DELETE "${BASE_URL}/api/files/${attachment_to_delete_id}")"
delete_attachment_success="$(echo "${delete_attachment_resp}" | jq -r '.success // false')"
if [[ "${delete_attachment_success}" != "true" ]]; then
  echo "[smoke-dataset-delete-consistency] scenario B delete attachment failed."
  echo "${delete_attachment_resp}"
  exit 1
fi

delete_attachment_again_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X DELETE "${BASE_URL}/api/files/${attachment_to_delete_id}")"
delete_attachment_again_success="$(echo "${delete_attachment_again_resp}" | jq -r '.success // false')"
if [[ "${delete_attachment_again_success}" != "true" ]]; then
  echo "[smoke-dataset-delete-consistency] scenario B second delete should be idempotent."
  echo "${delete_attachment_again_resp}"
  exit 1
fi

assert_cleanup_complete "${dataset_attachment_delete_id}" "${item_for_attachment_delete_id}" "${attachment_to_delete_id}" "scenario B"

echo "[smoke-dataset-delete-consistency] PASS"
echo "scenario_a_dataset_id=${dataset_item_delete_id}"
echo "scenario_a_item_id=${item_to_delete_id}"
echo "scenario_a_attachment_id=${attachment_item_delete_id}"
echo "scenario_b_dataset_id=${dataset_attachment_delete_id}"
echo "scenario_b_item_id=${item_for_attachment_delete_id}"
echo "scenario_b_attachment_id=${attachment_to_delete_id}"
