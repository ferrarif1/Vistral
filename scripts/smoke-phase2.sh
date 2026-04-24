#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
EXPECT_RUNTIME_FALLBACK="${EXPECT_RUNTIME_FALLBACK:-true}"
PHASE2_ALLOW_REGISTER_FALLBACK="${PHASE2_ALLOW_REGISTER_FALLBACK:-true}"
PHASE2_DOCTR_WAIT_POLLS="${PHASE2_DOCTR_WAIT_POLLS:-240}"
PHASE2_DOCTR_WAIT_SLEEP_SEC="${PHASE2_DOCTR_WAIT_SLEEP_SEC:-0.5}"
PADDLEOCR_RUNTIME_ENDPOINT_FOR_SMOKE="${PADDLEOCR_RUNTIME_ENDPOINT_FOR_SMOKE:-http://127.0.0.1:9/unreachable}"
DOCTR_RUNTIME_ENDPOINT_FOR_SMOKE="${DOCTR_RUNTIME_ENDPOINT_FOR_SMOKE:-http://127.0.0.1:9/unreachable}"
YOLO_RUNTIME_ENDPOINT_FOR_SMOKE="${YOLO_RUNTIME_ENDPOINT_FOR_SMOKE:-http://127.0.0.1:9/unreachable}"
VISTRAL_DISABLE_INFERENCE_FALLBACK_FOR_SMOKE="${VISTRAL_DISABLE_INFERENCE_FALLBACK_FOR_SMOKE:-0}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-phase2] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-phase2] python3 is required."
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
API_PORT="${API_PORT:-8797}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

COOKIE_FILE="$(mktemp)"
LOG_FILE="$(mktemp)"
SYNTH_IMAGE_FILE=""
API_PID=""

sample_image_file="$(
  find "${ROOT_DIR}/demo_data" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit 2>/dev/null || true
)"
if [[ -z "${sample_image_file}" ]]; then
  SYNTH_IMAGE_FILE="$(mktemp "${TMPDIR:-/tmp}/phase2-sample.XXXXXX.png")"
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
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_FILE" "$LOG_FILE" "${SYNTH_IMAGE_FILE:-}"
}

trap cleanup EXIT

wait_attachment_ready() {
  local list_url="$1"
  local attachment_id="$2"
  local label="$3"
  local list_resp=""
  local attachment_status=""

  for _ in $(seq 1 120); do
    list_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${list_url}")"
    attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"

    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi

    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-phase2] ${label} attachment entered error state"
      echo "${list_resp}"
      exit 1
    fi

    sleep 0.25
  done

  echo "[smoke-phase2] ${label} attachment not ready in time"
  echo "${list_resp}"
  exit 1
}

wait_for_health() {
  for _ in $(seq 1 60); do
    if curl -sS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

is_registration_gate_rejection() {
  local response="$1"
  local error_message=""
  error_message="$(echo "${response}" | jq -r '.error.message // empty')"
  [[ "${error_message}" == *"non-real local execution evidence"* || "${error_message}" == *"restricted local execution evidence"* || "${error_message}" == *"execution_mode=local_command"* ]]
}

is_fallback_like_source() {
  local source="$1"
  [[ "$source" == *"fallback"* || "$source" == *"template"* || "$source" == *"mock"* ]]
}

is_real_inference_source() {
  local source="$1"
  [[ "$source" == *"_runtime" || "$source" == *"_local_command" ]]
}

pick_registered_model_version_id() {
  local task_type="$1"
  local framework_filter="${2:-}"
  local versions_resp=""

  versions_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/model-versions")"
  echo "${versions_resp}" | jq -r --arg task_type "${task_type}" --arg framework "${framework_filter}" '
    .data[] |
    select(.status=="registered" and .task_type==$task_type and ($framework=="" or .framework==$framework)) |
    .id
  ' | head -n 1
}

if [[ "${START_API}" == "true" ]]; then
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  LLM_CONFIG_SECRET="${LLM_CONFIG_SECRET:-smoke-phase2-${API_PORT}}" \
  PADDLEOCR_RUNTIME_ENDPOINT="${PADDLEOCR_RUNTIME_ENDPOINT_FOR_SMOKE}" \
  DOCTR_RUNTIME_ENDPOINT="${DOCTR_RUNTIME_ENDPOINT_FOR_SMOKE}" \
  YOLO_RUNTIME_ENDPOINT="${YOLO_RUNTIME_ENDPOINT_FOR_SMOKE}" \
  VISTRAL_DISABLE_INFERENCE_FALLBACK="${VISTRAL_DISABLE_INFERENCE_FALLBACK_FOR_SMOKE}" \
  MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1 \
  npm run dev:api >"$LOG_FILE" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  if [[ "${START_API}" == "true" ]]; then
    if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
      echo "[smoke-phase2] API process exited before health check (possible port conflict)"
      cat "$LOG_FILE"
      exit 1
    fi
    echo "[smoke-phase2] API failed to start"
    cat "$LOG_FILE"
  else
    echo "[smoke-phase2] API is unreachable at ${BASE_URL}"
  fi
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-phase2] Failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

if [[ -n "${AUTH_USERNAME}" ]]; then
  if [[ -z "${AUTH_PASSWORD}" ]]; then
    echo "[smoke-phase2] AUTH_PASSWORD is required when AUTH_USERNAME is set"
    exit 1
  fi

  login_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "$login_response" | jq -r '.success // false')"
  if [[ "${login_success}" != "true" ]]; then
    echo "[smoke-phase2] login failed for AUTH_USERNAME=${AUTH_USERNAME}"
    echo "$login_response"
    exit 1
  fi

  csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
  if [[ -z "$csrf_token" ]]; then
    echo "[smoke-phase2] Failed to refresh CSRF token after login"
    echo "$csrf_payload"
    exit 1
  fi
fi

if [[ "${EXPECT_RUNTIME_FALLBACK}" == "true" ]]; then
  runtime_controls_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d '{"runtime_config":{},"runtime_controls":{"disable_inference_fallback":false}}' \
    "${BASE_URL}/api/settings/runtime")"
  runtime_controls_saved="$(echo "$runtime_controls_resp" | jq -r '.success // false')"
  runtime_controls_error_code="$(echo "$runtime_controls_resp" | jq -r '.error.code // empty')"
  if [[ "$runtime_controls_saved" != "true" && "$runtime_controls_error_code" == "INSUFFICIENT_PERMISSIONS" ]]; then
    phase2_admin_username="${PHASE2_ADMIN_USERNAME:-admin}"
    phase2_admin_password="${PHASE2_ADMIN_PASSWORD:-mock-pass-admin}"
    admin_login_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
      -H 'Content-Type: application/json' \
      -X POST "${BASE_URL}/api/auth/login" \
      -d "{\"username\":\"${phase2_admin_username}\",\"password\":\"${phase2_admin_password}\"}")"
    admin_login_ok="$(echo "$admin_login_resp" | jq -r '.success // false')"
    if [[ "$admin_login_ok" != "true" ]]; then
      echo "[smoke-phase2] failed to elevate session for runtime settings update"
      echo "$admin_login_resp"
      exit 1
    fi
    csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
    csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
    if [[ -z "$csrf_token" ]]; then
      echo "[smoke-phase2] failed to refresh CSRF token after admin login"
      echo "$csrf_payload"
      exit 1
    fi
    runtime_controls_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
      -H 'Content-Type: application/json' \
      -H "x-csrf-token: $csrf_token" \
      -d '{"runtime_config":{},"runtime_controls":{"disable_inference_fallback":false}}' \
      "${BASE_URL}/api/settings/runtime")"
    runtime_controls_saved="$(echo "$runtime_controls_resp" | jq -r '.success // false')"
  fi
  if [[ "$runtime_controls_saved" != "true" ]]; then
    echo "[smoke-phase2] failed to relax runtime_controls.disable_inference_fallback for fallback assertions"
    echo "$runtime_controls_resp"
    exit 1
  fi
fi

create_dataset_payload='{"name":"Segmentation Smoke","description":"seg workflow smoke","task_type":"segmentation","label_schema":{"classes":["region"]}}'
created_dataset="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$create_dataset_payload" \
  "${BASE_URL}/api/datasets")"

dataset_id="$(echo "$created_dataset" | jq -r '.data.id // empty')"
if [[ -z "$dataset_id" ]]; then
  echo "[smoke-phase2] Dataset creation failed"
  echo "$created_dataset"
  exit 1
fi

upload_attachment="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"filename":"seg-smoke-image.png"}' \
  "${BASE_URL}/api/files/dataset/${dataset_id}/upload")"

attachment_id="$(echo "$upload_attachment" | jq -r '.data.id // empty')"
if [[ -z "$attachment_id" ]]; then
  echo "[smoke-phase2] Dataset file upload failed"
  echo "$upload_attachment"
  exit 1
fi

sleep 1.6

dataset_detail="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}")"
dataset_item_id="$(echo "$dataset_detail" | jq -r '.data.items[0].id // empty')"

if [[ -z "$dataset_item_id" ]]; then
  echo "[smoke-phase2] Dataset item was not generated"
  echo "$dataset_detail"
  exit 1
fi

annotation_payload="$(cat <<JSON
{
  "dataset_item_id": "$dataset_item_id",
  "task_type": "segmentation",
  "source": "manual",
  "status": "annotated",
  "payload": {
    "boxes": [
      {"id":"box-1","x":40,"y":55,"width":120,"height":95,"label":"region-1"}
    ],
    "polygons": [
      {"id":"poly-1","label":"region-1","points":[{"x":50,"y":60},{"x":180,"y":65},{"x":170,"y":145},{"x":60,"y":150}]}
    ]
  }
}
JSON
)"

upsert_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$annotation_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations")"

saved_status="$(echo "$upsert_result" | jq -r '.data.status // empty')"
annotation_id="$(echo "$upsert_result" | jq -r '.data.id // empty')"
if [[ "$saved_status" != "annotated" ]]; then
  echo "[smoke-phase2] Annotation upsert did not reach expected status"
  echo "$upsert_result"
  exit 1
fi

if [[ -z "$annotation_id" ]]; then
  echo "[smoke-phase2] Annotation id missing after upsert"
  echo "$upsert_result"
  exit 1
fi

annotations_list="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
polygon_count="$(echo "$annotations_list" | jq -r '.data[0].payload.polygons | length // 0')"
if [[ "$polygon_count" -lt 1 ]]; then
  echo "[smoke-phase2] Segmentation polygons were not persisted"
  echo "$annotations_list"
  exit 1
fi

invalid_direct_review_transition_payload="$(cat <<JSON
{
  "dataset_item_id": "$dataset_item_id",
  "task_type": "segmentation",
  "source": "manual",
  "status": "in_review",
  "payload": {
    "boxes": [
      {"id":"box-1","x":40,"y":55,"width":120,"height":95,"label":"region-1"}
    ],
    "polygons": [
      {"id":"poly-1","label":"tampered-direct-submit","points":[{"x":50,"y":60},{"x":180,"y":65},{"x":170,"y":145},{"x":60,"y":150}]}
    ]
  }
}
JSON
)"

invalid_direct_review_transition_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$invalid_direct_review_transition_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
invalid_direct_review_transition_success="$(echo "$invalid_direct_review_transition_result" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
invalid_direct_review_transition_error_code="$(echo "$invalid_direct_review_transition_result" | jq -r '.error.code // empty')"
if [[ "$invalid_direct_review_transition_success" != "false" || "$invalid_direct_review_transition_error_code" != "INVALID_STATE_TRANSITION" ]]; then
  echo "[smoke-phase2] Annotated annotation was incorrectly allowed to enter in_review via upsert"
  echo "$invalid_direct_review_transition_result"
  exit 1
fi

annotation_list_after_invalid_direct_review_transition="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
status_after_invalid_direct_review_transition="$(echo "$annotation_list_after_invalid_direct_review_transition" | jq -r --arg annotation_id "$annotation_id" '.data[] | select(.id == $annotation_id) | .status // empty')"
polygon_label_after_invalid_direct_review_transition="$(echo "$annotation_list_after_invalid_direct_review_transition" | jq -r --arg annotation_id "$annotation_id" '.data[] | select(.id == $annotation_id) | .payload.polygons[0].label // empty')"
if [[ "$status_after_invalid_direct_review_transition" != "annotated" || "$polygon_label_after_invalid_direct_review_transition" != "region-1" ]]; then
  echo "[smoke-phase2] Failed upsert mutated annotated payload or status before submit-review"
  echo "$annotation_list_after_invalid_direct_review_transition"
  exit 1
fi

submit_review_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H "x-csrf-token: $csrf_token" \
  -X POST \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations/${annotation_id}/submit-review")"
submitted_status="$(echo "$submit_review_result" | jq -r '.data.status // empty')"
if [[ "$submitted_status" != "in_review" ]]; then
  echo "[smoke-phase2] Annotation did not reach in_review after submit-review"
  echo "$submit_review_result"
  exit 1
fi

invalid_in_review_upsert_payload="$(cat <<JSON
{
  "dataset_item_id": "$dataset_item_id",
  "task_type": "segmentation",
  "source": "manual",
  "status": "in_review",
  "payload": {
    "boxes": [
      {"id":"box-1","x":40,"y":55,"width":120,"height":95,"label":"region-1"}
    ],
    "polygons": [
      {"id":"poly-1","label":"tampered-in-review","points":[{"x":50,"y":60},{"x":180,"y":65},{"x":170,"y":145},{"x":60,"y":150}]}
    ]
  }
}
JSON
)"

invalid_in_review_upsert_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$invalid_in_review_upsert_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
invalid_in_review_upsert_success="$(echo "$invalid_in_review_upsert_result" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
invalid_in_review_upsert_error_code="$(echo "$invalid_in_review_upsert_result" | jq -r '.error.code // empty')"
if [[ "$invalid_in_review_upsert_success" != "false" || "$invalid_in_review_upsert_error_code" != "INVALID_STATE_TRANSITION" ]]; then
  echo "[smoke-phase2] In-review annotation was incorrectly editable through upsert"
  echo "$invalid_in_review_upsert_result"
  exit 1
fi

annotation_list_after_invalid_in_review_upsert="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
status_after_invalid_in_review_upsert="$(echo "$annotation_list_after_invalid_in_review_upsert" | jq -r --arg annotation_id "$annotation_id" '.data[] | select(.id == $annotation_id) | .status // empty')"
polygon_label_after_invalid_in_review_upsert="$(echo "$annotation_list_after_invalid_in_review_upsert" | jq -r --arg annotation_id "$annotation_id" '.data[] | select(.id == $annotation_id) | .payload.polygons[0].label // empty')"
if [[ "$status_after_invalid_in_review_upsert" != "in_review" || "$polygon_label_after_invalid_in_review_upsert" != "region-1" ]]; then
  echo "[smoke-phase2] Failed upsert mutated in_review payload or status"
  echo "$annotation_list_after_invalid_in_review_upsert"
  exit 1
fi

invalid_reject_review_payload='{"status":"rejected","quality_score":0.5,"review_comment":"missing reason should fail"}'
invalid_reject_review_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$invalid_reject_review_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations/${annotation_id}/review")"
invalid_reject_review_success="$(echo "$invalid_reject_review_result" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
invalid_reject_review_error_code="$(echo "$invalid_reject_review_result" | jq -r '.error.code // empty')"
invalid_reject_review_error_message="$(echo "$invalid_reject_review_result" | jq -r '.error.message // empty')"
if [[ "$invalid_reject_review_success" != "false" || "$invalid_reject_review_error_code" != "VALIDATION_ERROR" || "$invalid_reject_review_error_message" != *"review_reason_code"* ]]; then
  echo "[smoke-phase2] Rejected review without reason was not blocked as expected"
  echo "$invalid_reject_review_result"
  exit 1
fi

annotation_list_after_invalid_reject="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
status_after_invalid_reject="$(echo "$annotation_list_after_invalid_reject" | jq -r --arg annotation_id "$annotation_id" '.data[] | select(.id == $annotation_id) | .status // empty')"
if [[ "$status_after_invalid_reject" != "in_review" ]]; then
  echo "[smoke-phase2] Annotation status changed unexpectedly after invalid rejected review"
  echo "$annotation_list_after_invalid_reject"
  exit 1
fi

review_payload='{"status":"rejected","review_reason_code":"polygon_issue","quality_score":0.51,"review_comment":"Polygon needs cleaner boundary."}'
review_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$review_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations/${annotation_id}/review")"
review_status="$(echo "$review_result" | jq -r '.data.status // empty')"
review_reason_code="$(echo "$review_result" | jq -r '.data.latest_review.review_reason_code // empty')"
if [[ "$review_status" != "rejected" || "$review_reason_code" != "polygon_issue" ]]; then
  echo "[smoke-phase2] Rejected review reason was not persisted"
  echo "$review_result"
  exit 1
fi

invalid_rejected_upsert_payload="$(cat <<JSON
{
  "dataset_item_id": "$dataset_item_id",
  "task_type": "segmentation",
  "source": "manual",
  "status": "rejected",
  "payload": {
    "boxes": [
      {"id":"box-1","x":40,"y":55,"width":120,"height":95,"label":"region-1"}
    ],
    "polygons": [
      {"id":"poly-1","label":"tampered-rejected","points":[{"x":50,"y":60},{"x":180,"y":65},{"x":170,"y":145},{"x":60,"y":150}]}
    ]
  }
}
JSON
)"

invalid_rejected_upsert_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$invalid_rejected_upsert_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
invalid_rejected_upsert_success="$(echo "$invalid_rejected_upsert_result" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
invalid_rejected_upsert_error_code="$(echo "$invalid_rejected_upsert_result" | jq -r '.error.code // empty')"
if [[ "$invalid_rejected_upsert_success" != "false" || "$invalid_rejected_upsert_error_code" != "INVALID_STATE_TRANSITION" ]]; then
  echo "[smoke-phase2] Rejected annotation was incorrectly editable without reopening to in_progress"
  echo "$invalid_rejected_upsert_result"
  exit 1
fi

annotation_list_after_invalid_rejected_upsert="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
status_after_invalid_rejected_upsert="$(echo "$annotation_list_after_invalid_rejected_upsert" | jq -r --arg annotation_id "$annotation_id" '.data[] | select(.id == $annotation_id) | .status // empty')"
polygon_label_after_invalid_rejected_upsert="$(echo "$annotation_list_after_invalid_rejected_upsert" | jq -r --arg annotation_id "$annotation_id" '.data[] | select(.id == $annotation_id) | .payload.polygons[0].label // empty')"
if [[ "$status_after_invalid_rejected_upsert" != "rejected" || "$polygon_label_after_invalid_rejected_upsert" != "region-1" ]]; then
  echo "[smoke-phase2] Failed upsert mutated rejected payload or status"
  echo "$annotation_list_after_invalid_rejected_upsert"
  exit 1
fi

rework_payload="$(cat <<JSON
{
  "dataset_item_id": "$dataset_item_id",
  "task_type": "segmentation",
  "source": "manual",
  "status": "in_progress",
  "payload": {
    "boxes": [
      {"id":"box-1","x":40,"y":55,"width":120,"height":95,"label":"region-1"}
    ],
    "polygons": [
      {"id":"poly-1","label":"region-1","points":[{"x":50,"y":60},{"x":180,"y":65},{"x":170,"y":145},{"x":60,"y":150}]}
    ]
  }
}
JSON
)"

rework_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$rework_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
rework_status="$(echo "$rework_result" | jq -r '.data.status // empty')"
rework_review_reason_code="$(echo "$rework_result" | jq -r '.data.latest_review.review_reason_code // empty')"
rework_review_comment="$(echo "$rework_result" | jq -r '.data.latest_review.review_comment // empty')"
if [[ "$rework_status" != "in_progress" || "$rework_review_reason_code" != "polygon_issue" || "$rework_review_comment" != "Polygon needs cleaner boundary." ]]; then
  echo "[smoke-phase2] Rework transition did not preserve latest review context"
  echo "$rework_result"
  exit 1
fi

reannotate_payload="$(cat <<JSON
{
  "dataset_item_id": "$dataset_item_id",
  "task_type": "segmentation",
  "source": "manual",
  "status": "annotated",
  "payload": {
    "boxes": [
      {"id":"box-1","x":40,"y":55,"width":120,"height":95,"label":"region-1"}
    ],
    "polygons": [
      {"id":"poly-1","label":"region-1","points":[{"x":50,"y":60},{"x":180,"y":65},{"x":170,"y":145},{"x":60,"y":150}]}
    ]
  }
}
JSON
)"

reannotate_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$reannotate_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
reannotate_status="$(echo "$reannotate_result" | jq -r '.data.status // empty')"
if [[ "$reannotate_status" != "annotated" ]]; then
  echo "[smoke-phase2] Re-annotation did not return to annotated before second review cycle"
  echo "$reannotate_result"
  exit 1
fi

resubmit_review_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H "x-csrf-token: $csrf_token" \
  -X POST \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations/${annotation_id}/submit-review")"
resubmitted_status="$(echo "$resubmit_review_result" | jq -r '.data.status // empty')"
if [[ "$resubmitted_status" != "in_review" ]]; then
  echo "[smoke-phase2] Annotation did not return to in_review during second review cycle"
  echo "$resubmit_review_result"
  exit 1
fi

invalid_approved_review_payload='{"status":"approved","review_reason_code":"polygon_issue","quality_score":0.95,"review_comment":"approved cannot include reason code"}'
invalid_approved_review_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$invalid_approved_review_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations/${annotation_id}/review")"
invalid_approved_review_success="$(echo "$invalid_approved_review_result" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
invalid_approved_review_error_code="$(echo "$invalid_approved_review_result" | jq -r '.error.code // empty')"
invalid_approved_review_error_message="$(echo "$invalid_approved_review_result" | jq -r '.error.message // empty')"
if [[ "$invalid_approved_review_success" != "false" || "$invalid_approved_review_error_code" != "VALIDATION_ERROR" || "$invalid_approved_review_error_message" != *"cannot include"* || "$invalid_approved_review_error_message" != *"review_reason_code"* ]]; then
  echo "[smoke-phase2] Approved review with reason code was not blocked as expected"
  echo "$invalid_approved_review_result"
  exit 1
fi

approved_review_payload='{"status":"approved","quality_score":0.95,"review_comment":"Boundary is now acceptable."}'
approved_review_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$approved_review_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations/${annotation_id}/review")"
approved_status="$(echo "$approved_review_result" | jq -r '.data.status // empty')"
approved_latest_review_status="$(echo "$approved_review_result" | jq -r '.data.latest_review.status // empty')"
approved_latest_review_reason_code="$(echo "$approved_review_result" | jq -r '.data.latest_review.review_reason_code')"
if [[ "$approved_status" != "approved" || "$approved_latest_review_status" != "approved" || "$approved_latest_review_reason_code" != "null" ]]; then
  echo "[smoke-phase2] Approved review result did not satisfy expected contract"
  echo "$approved_review_result"
  exit 1
fi

invalid_approved_upsert_payload="$(cat <<JSON
{
  "dataset_item_id": "$dataset_item_id",
  "task_type": "segmentation",
  "source": "manual",
  "status": "approved",
  "payload": {
    "boxes": [
      {"id":"box-1","x":40,"y":55,"width":120,"height":95,"label":"region-1"}
    ],
    "polygons": [
      {"id":"poly-1","label":"tampered-approved","points":[{"x":50,"y":60},{"x":180,"y":65},{"x":170,"y":145},{"x":60,"y":150}]}
    ]
  }
}
JSON
)"

invalid_approved_upsert_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$invalid_approved_upsert_payload" \
  "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
invalid_approved_upsert_success="$(echo "$invalid_approved_upsert_result" | jq -r 'if .success == true then "true" elif .success == false then "false" else "" end')"
invalid_approved_upsert_error_code="$(echo "$invalid_approved_upsert_result" | jq -r '.error.code // empty')"
if [[ "$invalid_approved_upsert_success" != "false" || "$invalid_approved_upsert_error_code" != "INVALID_STATE_TRANSITION" ]]; then
  echo "[smoke-phase2] Approved annotation was incorrectly editable through upsert"
  echo "$invalid_approved_upsert_result"
  exit 1
fi

annotation_list_after_invalid_approved_upsert="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
status_after_invalid_approved_upsert="$(echo "$annotation_list_after_invalid_approved_upsert" | jq -r --arg annotation_id "$annotation_id" '.data[] | select(.id == $annotation_id) | .status // empty')"
polygon_label_after_invalid_approved_upsert="$(echo "$annotation_list_after_invalid_approved_upsert" | jq -r --arg annotation_id "$annotation_id" '.data[] | select(.id == $annotation_id) | .payload.polygons[0].label // empty')"
if [[ "$status_after_invalid_approved_upsert" != "approved" || "$polygon_label_after_invalid_approved_upsert" != "region-1" ]]; then
  echo "[smoke-phase2] Failed upsert mutated approved payload or status"
  echo "$annotation_list_after_invalid_approved_upsert"
  exit 1
fi

model_versions_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/model-versions")"
detection_model_version_id="$(echo "$model_versions_result" | jq -r '.data[] | select(.task_type=="detection" and .status=="registered") | .id' | head -n 1)"
ocr_model_version_id="$(echo "$model_versions_result" | jq -r '.data[] | select(.task_type=="ocr" and .framework=="paddleocr" and .status=="registered") | .id' | head -n 1)"
if [[ -z "$ocr_model_version_id" ]]; then
  ocr_model_version_id="$(echo "$model_versions_result" | jq -r '.data[] | select(.task_type=="ocr" and .status=="registered") | .id' | head -n 1)"
fi
if [[ -z "$detection_model_version_id" || -z "$ocr_model_version_id" ]]; then
  echo "[smoke-phase2] required registered model versions were not found"
  echo "$model_versions_result"
  exit 1
fi

detect_inference_upload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H "x-csrf-token: $csrf_token" \
  -F "file=@${sample_image_file};filename=phase2-detect-input.jpg" \
  "${BASE_URL}/api/files/inference/upload")"
detect_inference_attachment_id="$(echo "$detect_inference_upload" | jq -r '.data.id // empty')"
if [[ -z "$detect_inference_attachment_id" ]]; then
  echo "[smoke-phase2] failed to upload detection inference attachment"
  echo "$detect_inference_upload"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/inference" "${detect_inference_attachment_id}" "detection inference"

ocr_inference_upload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H "x-csrf-token: $csrf_token" \
  -F "file=@${sample_image_file};filename=phase2-ocr-input.jpg" \
  "${BASE_URL}/api/files/inference/upload")"
ocr_inference_attachment_id="$(echo "$ocr_inference_upload" | jq -r '.data.id // empty')"
if [[ -z "$ocr_inference_attachment_id" ]]; then
  echo "[smoke-phase2] failed to upload OCR inference attachment"
  echo "$ocr_inference_upload"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/inference" "${ocr_inference_attachment_id}" "ocr inference"

no_train_split_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"train_ratio":0,"val_ratio":1,"test_ratio":0,"seed":9}' \
  "${BASE_URL}/api/datasets/${dataset_id}/split")"
no_train_split_count="$(echo "$no_train_split_result" | jq -r '.data.split_summary.train // -1')"
if [[ "$no_train_split_count" != "0" ]]; then
  echo "[smoke-phase2] expected train split count to be 0 for no-train gate scenario"
  echo "$no_train_split_result"
  exit 1
fi

no_train_version_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"version_name":"seg-no-train-gate-v1"}' \
  "${BASE_URL}/api/datasets/${dataset_id}/versions")"
no_train_version_id="$(echo "$no_train_version_result" | jq -r '.data.id // empty')"
if [[ -z "$no_train_version_id" ]]; then
  echo "[smoke-phase2] no-train gate dataset version creation failed"
  echo "$no_train_version_result"
  exit 1
fi

no_train_training_request="$(cat <<JSON
{"name":"seg-no-train-gate-job","task_type":"segmentation","framework":"yolo","dataset_id":"${dataset_id}","dataset_version_id":"${no_train_version_id}","base_model":"yolo11n-seg","config":{"epochs":"1","batch_size":"1","learning_rate":"0.001"}}
JSON
)"
no_train_training_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$no_train_training_request" \
  "${BASE_URL}/api/training/jobs")"
no_train_training_success="$(echo "$no_train_training_result" | jq -r '.success // false')"
no_train_training_error_code="$(echo "$no_train_training_result" | jq -r '.error.code // empty')"
no_train_training_error_message="$(echo "$no_train_training_result" | jq -r '.error.message // empty')"
if [[ "$no_train_training_success" != "false" || "$no_train_training_error_code" != "VALIDATION_ERROR" || "$no_train_training_error_message" != *"train split"* ]]; then
  echo "[smoke-phase2] No-train split gate validation did not reject training launch as expected"
  echo "$no_train_training_result"
  exit 1
fi

version_mismatch_dataset_payload='{"name":"Version Mismatch Smoke","description":"cross dataset version gate","task_type":"segmentation","label_schema":{"classes":["region"]}}'
version_mismatch_dataset_created="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$version_mismatch_dataset_payload" \
  "${BASE_URL}/api/datasets")"
version_mismatch_dataset_id="$(echo "$version_mismatch_dataset_created" | jq -r '.data.id // empty')"
if [[ -z "$version_mismatch_dataset_id" ]]; then
  echo "[smoke-phase2] version-mismatch gate dataset creation failed"
  echo "$version_mismatch_dataset_created"
  exit 1
fi

version_mismatch_upload_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"filename":"version-mismatch-gate-image.png"}' \
  "${BASE_URL}/api/files/dataset/${version_mismatch_dataset_id}/upload")"
version_mismatch_attachment_id="$(echo "$version_mismatch_upload_result" | jq -r '.data.id // empty')"
if [[ -z "$version_mismatch_attachment_id" ]]; then
  echo "[smoke-phase2] version-mismatch gate dataset upload failed"
  echo "$version_mismatch_upload_result"
  exit 1
fi

sleep 1.6

version_mismatch_split_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"train_ratio":1,"val_ratio":0,"test_ratio":0,"seed":13}' \
  "${BASE_URL}/api/datasets/${version_mismatch_dataset_id}/split")"
version_mismatch_train_count="$(echo "$version_mismatch_split_result" | jq -r '.data.split_summary.train // 0')"
if [[ "$version_mismatch_train_count" -lt 1 ]]; then
  echo "[smoke-phase2] version-mismatch gate split did not produce train items"
  echo "$version_mismatch_split_result"
  exit 1
fi

version_mismatch_version_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"version_name":"seg-version-mismatch-gate-v1"}' \
  "${BASE_URL}/api/datasets/${version_mismatch_dataset_id}/versions")"
version_mismatch_version_id="$(echo "$version_mismatch_version_result" | jq -r '.data.id // empty')"
if [[ -z "$version_mismatch_version_id" ]]; then
  echo "[smoke-phase2] version-mismatch gate dataset version creation failed"
  echo "$version_mismatch_version_result"
  exit 1
fi

version_mismatch_training_request="$(cat <<JSON
{"name":"seg-version-mismatch-gate-job","task_type":"segmentation","framework":"yolo","dataset_id":"${dataset_id}","dataset_version_id":"${version_mismatch_version_id}","base_model":"yolo11n-seg","config":{"epochs":"1","batch_size":"1","learning_rate":"0.001"}}
JSON
)"
version_mismatch_training_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$version_mismatch_training_request" \
  "${BASE_URL}/api/training/jobs")"
version_mismatch_training_success="$(echo "$version_mismatch_training_result" | jq -r '.success // false')"
version_mismatch_training_error_code="$(echo "$version_mismatch_training_result" | jq -r '.error.code // empty')"
version_mismatch_training_error_message="$(echo "$version_mismatch_training_result" | jq -r '.error.message // empty')"
if [[ "$version_mismatch_training_success" != "false" || "$version_mismatch_training_error_code" != "RESOURCE_NOT_FOUND" || "$version_mismatch_training_error_message" != *"Dataset version"* || "$version_mismatch_training_error_message" != *"selected dataset"* ]]; then
  echo "[smoke-phase2] Dataset-version mismatch gate did not reject cross-dataset version launch as expected"
  echo "$version_mismatch_training_result"
  exit 1
fi

inference_request="$(cat <<JSON
{"model_version_id":"${detection_model_version_id}","input_attachment_id":"${detect_inference_attachment_id}","task_type":"detection"}
JSON
)"
inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$inference_request" \
  "${BASE_URL}/api/inference/runs")"

inference_run_id="$(echo "$inference_result" | jq -r '.data.id // empty')"
fallback_source="$(echo "$inference_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
fallback_reason="$(echo "$inference_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"
fallback_local_reason="$(echo "$inference_result" | jq -r '.data.raw_output.local_command_fallback_reason // empty')"
fallback_meta_reason="$(echo "$inference_result" | jq -r '.data.raw_output.meta.fallback_reason // empty')"
fallback_template_mode="$(echo "$inference_result" | jq -r '.data.raw_output.meta.mode // empty')"
fallback_template_marker="$(echo "$inference_result" | jq -r '.data.raw_output.local_command_template_mode // false')"

if [[ -z "$inference_run_id" ]]; then
  echo "[smoke-phase2] Inference run was not created"
  echo "$inference_result"
  exit 1
fi

if [[ "${EXPECT_RUNTIME_FALLBACK}" == "true" ]]; then
  if is_fallback_like_source "$fallback_source" || [[ "$fallback_template_mode" == "template" || "$fallback_template_marker" == "true" ]]; then
    if [[ -z "$fallback_reason" && -z "$fallback_local_reason" && -z "$fallback_meta_reason" ]]; then
      echo "[smoke-phase2] YOLO fallback path was selected but fallback reason metadata is missing"
      echo "$inference_result"
      exit 1
    fi
  elif ! is_real_inference_source "$fallback_source"; then
    echo "[smoke-phase2] YOLO inference source is neither fallback-like nor real-runtime/local-command"
    echo "$inference_result"
    exit 1
  fi
else
  if [[ -z "$fallback_source" ]]; then
    echo "[smoke-phase2] YOLO inference source should not be empty"
    echo "$inference_result"
    exit 1
  fi
fi

ocr_inference_request="$(cat <<JSON
{"model_version_id":"${ocr_model_version_id}","input_attachment_id":"${ocr_inference_attachment_id}","task_type":"ocr"}
JSON
)"
ocr_inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$ocr_inference_request" \
  "${BASE_URL}/api/inference/runs")"

ocr_inference_run_id="$(echo "$ocr_inference_result" | jq -r '.data.id // empty')"
ocr_fallback_source="$(echo "$ocr_inference_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
ocr_fallback_reason="$(echo "$ocr_inference_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"
ocr_fallback_local_reason="$(echo "$ocr_inference_result" | jq -r '.data.raw_output.local_command_fallback_reason // empty')"
ocr_fallback_meta_reason="$(echo "$ocr_inference_result" | jq -r '.data.raw_output.meta.fallback_reason // empty')"
ocr_fallback_template_mode="$(echo "$ocr_inference_result" | jq -r '.data.raw_output.meta.mode // empty')"
ocr_fallback_template_marker="$(echo "$ocr_inference_result" | jq -r '.data.raw_output.local_command_template_mode // false')"

if [[ -z "$ocr_inference_run_id" ]]; then
  echo "[smoke-phase2] OCR inference run was not created"
  echo "$ocr_inference_result"
  exit 1
fi

if [[ "${EXPECT_RUNTIME_FALLBACK}" == "true" ]]; then
  if is_fallback_like_source "$ocr_fallback_source" || [[ "$ocr_fallback_template_mode" == "template" || "$ocr_fallback_template_marker" == "true" ]]; then
    if [[ -z "$ocr_fallback_reason" && -z "$ocr_fallback_local_reason" && -z "$ocr_fallback_meta_reason" ]]; then
      echo "[smoke-phase2] PaddleOCR fallback path was selected but fallback reason metadata is missing"
      echo "$ocr_inference_result"
      exit 1
    fi
  elif ! is_real_inference_source "$ocr_fallback_source"; then
    echo "[smoke-phase2] PaddleOCR inference source is neither fallback-like nor real-runtime/local-command"
    echo "$ocr_inference_result"
    exit 1
  fi
else
  if [[ -z "$ocr_fallback_source" ]]; then
    echo "[smoke-phase2] PaddleOCR inference source should not be empty"
    echo "$ocr_inference_result"
    exit 1
  fi
fi

ocr_training_dataset_list="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets")"
ocr_training_dataset_id="$(echo "$ocr_training_dataset_list" | jq -r '.data[] | select(.task_type=="ocr" and .status=="ready") | .id' | head -n 1)"
if [[ -z "$ocr_training_dataset_id" ]]; then
  ocr_training_dataset_id="$(echo "$ocr_training_dataset_list" | jq -r '.data[] | select(.task_type=="ocr") | .id' | head -n 1)"
fi
if [[ -z "$ocr_training_dataset_id" ]]; then
  ocr_training_dataset_create_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -X POST \
    -d "{\"name\":\"phase2-doctr-ocr-target-$(date +%s)\",\"description\":\"phase2 doctr ocr training target\",\"task_type\":\"ocr\",\"label_schema\":{\"classes\":[\"text_line\"]}}" \
    "${BASE_URL}/api/datasets")"
  ocr_training_dataset_id="$(echo "$ocr_training_dataset_create_resp" | jq -r '.data.id // empty')"
  if [[ -z "$ocr_training_dataset_id" ]]; then
    echo "[smoke-phase2] failed to create OCR dataset for docTR training smoke"
    echo "$ocr_training_dataset_create_resp"
    exit 1
  fi

  ocr_training_upload_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -X POST \
    -d "{\"filename\":\"phase2-doctr-ocr-target-$(date +%s).jpg\"}" \
    "${BASE_URL}/api/files/dataset/${ocr_training_dataset_id}/upload")"
  ocr_training_attachment_id="$(echo "$ocr_training_upload_resp" | jq -r '.data.id // empty')"
  if [[ -z "$ocr_training_attachment_id" ]]; then
    echo "[smoke-phase2] failed to upload OCR dataset sample for docTR training smoke"
    echo "$ocr_training_upload_resp"
    exit 1
  fi
  wait_attachment_ready "${BASE_URL}/api/files/dataset/${ocr_training_dataset_id}" "${ocr_training_attachment_id}" "ocr training dataset"

  ocr_training_dataset_detail="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${ocr_training_dataset_id}")"
  ocr_training_item_id="$(echo "$ocr_training_dataset_detail" | jq -r '.data.items[0].id // empty')"
  if [[ -z "$ocr_training_item_id" ]]; then
    echo "[smoke-phase2] OCR training dataset item was not generated"
    echo "$ocr_training_dataset_detail"
    exit 1
  fi

  ocr_training_annotation_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -X POST \
    -d "{\"dataset_item_id\":\"${ocr_training_item_id}\",\"task_type\":\"ocr\",\"source\":\"manual\",\"status\":\"annotated\",\"payload\":{\"lines\":[{\"text\":\"phase2 doctr target sample\",\"confidence\":0.99}]}}" \
    "${BASE_URL}/api/datasets/${ocr_training_dataset_id}/annotations")"
  ocr_training_annotation_status="$(echo "$ocr_training_annotation_resp" | jq -r '.data.status // empty')"
  if [[ "$ocr_training_annotation_status" != "annotated" ]]; then
    echo "[smoke-phase2] failed to annotate OCR training dataset sample"
    echo "$ocr_training_annotation_resp"
    exit 1
  fi
fi

ocr_training_versions="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${ocr_training_dataset_id}/versions")"
ocr_training_dataset_version_id="$(echo "$ocr_training_versions" | jq -r '.data[] | select((.split_summary.train // 0) > 0 and (.annotation_coverage // 0) > 0) | .id' | head -n 1)"
if [[ -z "$ocr_training_dataset_version_id" ]]; then
  ocr_split_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d '{"train_ratio":0.8,"val_ratio":0.1,"test_ratio":0.1,"seed":17}' \
    "${BASE_URL}/api/datasets/${ocr_training_dataset_id}/split")"
  ocr_split_train_count="$(echo "$ocr_split_resp" | jq -r '.data.split_summary.train // 0')"
  if [[ "$ocr_split_train_count" -lt 1 ]]; then
    echo "[smoke-phase2] OCR dataset split did not produce train items for docTR training smoke"
    echo "$ocr_split_resp"
    exit 1
  fi

  ocr_version_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d "{\"version_name\":\"phase2-doctr-ocr-$(date +%s)\"}" \
    "${BASE_URL}/api/datasets/${ocr_training_dataset_id}/versions")"
  ocr_training_dataset_version_id="$(echo "$ocr_version_resp" | jq -r '.data.id // empty')"
  if [[ -z "$ocr_training_dataset_version_id" ]]; then
    echo "[smoke-phase2] OCR dataset version creation failed for docTR training smoke"
    echo "$ocr_version_resp"
    exit 1
  fi
fi

doctr_training_request="$(cat <<JSON
{"name":"doctr-smoke-job","task_type":"ocr","framework":"doctr","dataset_id":"${ocr_training_dataset_id}","dataset_version_id":"${ocr_training_dataset_version_id}","base_model":"doctr-base","config":{"epochs":"1","batch_size":"1"}}
JSON
)"
doctr_training_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$doctr_training_request" \
  "${BASE_URL}/api/training/jobs")"
doctr_training_job_id="$(echo "$doctr_training_result" | jq -r '.data.id // empty')"
if [[ -z "$doctr_training_job_id" ]]; then
  echo "[smoke-phase2] docTR training job creation failed"
  echo "$doctr_training_result"
  exit 1
fi

doctr_job_status=""
for _ in $(seq 1 "${PHASE2_DOCTR_WAIT_POLLS}"); do
  doctr_job_detail="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    "${BASE_URL}/api/training/jobs/${doctr_training_job_id}")"
  doctr_job_status="$(echo "$doctr_job_detail" | jq -r '.data.job.status // empty')"
  if [[ "$doctr_job_status" == "completed" ]]; then
    break
  fi
  sleep "${PHASE2_DOCTR_WAIT_SLEEP_SEC}"
done

if [[ "$doctr_job_status" != "completed" ]]; then
  echo "[smoke-phase2] docTR training job did not complete in time"
  echo "$doctr_job_detail"
  exit 1
fi

doctr_model_request='{"name":"doctr-phase2-smoke-model","description":"docTR phase2 smoke model","model_type":"ocr","visibility":"workspace"}'
doctr_model_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$doctr_model_request" \
  "${BASE_URL}/api/models/draft")"
doctr_model_id="$(echo "$doctr_model_result" | jq -r '.data.id // empty')"
if [[ -z "$doctr_model_id" ]]; then
  echo "[smoke-phase2] docTR model draft creation failed"
  echo "$doctr_model_result"
  exit 1
fi

doctr_register_request="$(cat <<JSON
{"model_id":"${doctr_model_id}","training_job_id":"${doctr_training_job_id}","version_name":"doctr-smoke-v1"}
JSON
)"
doctr_register_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$doctr_register_request" \
  "${BASE_URL}/api/model-versions/register")"
doctr_model_version_id="$(echo "$doctr_register_result" | jq -r '.data.id // empty')"
doctr_register_mode="created"
if [[ -z "$doctr_model_version_id" ]]; then
  if [[ "${PHASE2_ALLOW_REGISTER_FALLBACK}" != "true" || "$(is_registration_gate_rejection "$doctr_register_result" && echo true || echo false)" != "true" ]]; then
    echo "[smoke-phase2] docTR model version registration failed"
    echo "$doctr_register_result"
    exit 1
  fi

  doctr_model_version_id="$(pick_registered_model_version_id "ocr" "doctr")"
  if [[ -n "$doctr_model_version_id" ]]; then
    doctr_register_mode="blocked_gate_reused_doctr"
  else
    doctr_model_version_id="$(pick_registered_model_version_id "ocr" "")"
    if [[ -z "$doctr_model_version_id" ]]; then
      echo "[smoke-phase2] docTR registration blocked and no fallback OCR model version exists"
      echo "$doctr_register_result"
      exit 1
    fi
    doctr_register_mode="blocked_gate_reused_ocr_any"
  fi
fi

doctr_inference_request="$(cat <<JSON
{"model_version_id":"${doctr_model_version_id}","input_attachment_id":"${ocr_inference_attachment_id}","task_type":"ocr"}
JSON
)"
doctr_inference_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$doctr_inference_request" \
  "${BASE_URL}/api/inference/runs")"
doctr_inference_run_id="$(echo "$doctr_inference_result" | jq -r '.data.id // empty')"
doctr_fallback_source="$(echo "$doctr_inference_result" | jq -r '.data.normalized_output.normalized_output.source // empty')"
doctr_fallback_reason="$(echo "$doctr_inference_result" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"
doctr_fallback_local_reason="$(echo "$doctr_inference_result" | jq -r '.data.raw_output.local_command_fallback_reason // empty')"
doctr_fallback_meta_reason="$(echo "$doctr_inference_result" | jq -r '.data.raw_output.meta.fallback_reason // empty')"
doctr_fallback_template_mode="$(echo "$doctr_inference_result" | jq -r '.data.raw_output.meta.mode // empty')"
doctr_fallback_template_marker="$(echo "$doctr_inference_result" | jq -r '.data.raw_output.local_command_template_mode // false')"

if [[ -z "$doctr_inference_run_id" ]]; then
  echo "[smoke-phase2] docTR inference run was not created"
  echo "$doctr_inference_result"
  exit 1
fi

if [[ "${EXPECT_RUNTIME_FALLBACK}" == "true" ]]; then
  if is_fallback_like_source "$doctr_fallback_source" || [[ "$doctr_fallback_template_mode" == "template" || "$doctr_fallback_template_marker" == "true" ]]; then
    if [[ -z "$doctr_fallback_reason" && -z "$doctr_fallback_local_reason" && -z "$doctr_fallback_meta_reason" ]]; then
      echo "[smoke-phase2] docTR fallback path was selected but fallback reason metadata is missing"
      echo "$doctr_inference_result"
      exit 1
    fi
  elif ! is_real_inference_source "$doctr_fallback_source"; then
    echo "[smoke-phase2] docTR inference source is neither fallback-like nor real-runtime/local-command"
    echo "$doctr_inference_result"
    exit 1
  fi
else
  if [[ -z "$doctr_fallback_source" ]]; then
    echo "[smoke-phase2] docTR inference source should not be empty"
    echo "$doctr_inference_result"
    exit 1
  fi
fi

coverage_dataset_payload='{"name":"Coverage Gate Smoke","description":"coverage gate validation","task_type":"detection","label_schema":{"classes":["carriage"]}}'
coverage_dataset_created="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$coverage_dataset_payload" \
  "${BASE_URL}/api/datasets")"
coverage_dataset_id="$(echo "$coverage_dataset_created" | jq -r '.data.id // empty')"
if [[ -z "$coverage_dataset_id" ]]; then
  echo "[smoke-phase2] Coverage gate dataset creation failed"
  echo "$coverage_dataset_created"
  exit 1
fi

coverage_upload_attachment="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"filename":"coverage-gate-image.png"}' \
  "${BASE_URL}/api/files/dataset/${coverage_dataset_id}/upload")"
coverage_attachment_id="$(echo "$coverage_upload_attachment" | jq -r '.data.id // empty')"
if [[ -z "$coverage_attachment_id" ]]; then
  echo "[smoke-phase2] Coverage gate upload failed"
  echo "$coverage_upload_attachment"
  exit 1
fi

sleep 1.6

coverage_split_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"train_ratio":1,"val_ratio":0,"test_ratio":0,"seed":7}' \
  "${BASE_URL}/api/datasets/${coverage_dataset_id}/split")"
coverage_split_train="$(echo "$coverage_split_result" | jq -r '.data.split_summary.train // 0')"
if [[ "$coverage_split_train" -lt 1 ]]; then
  echo "[smoke-phase2] Coverage gate split did not produce train item"
  echo "$coverage_split_result"
  exit 1
fi

coverage_version_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"version_name":"coverage-gate-v1"}' \
  "${BASE_URL}/api/datasets/${coverage_dataset_id}/versions")"
coverage_version_id="$(echo "$coverage_version_result" | jq -r '.data.id // empty')"
coverage_value="$(echo "$coverage_version_result" | jq -r '.data.annotation_coverage // -1')"
if [[ -z "$coverage_version_id" || "$coverage_value" != "0" ]]; then
  echo "[smoke-phase2] Coverage gate dataset version was not created with zero coverage"
  echo "$coverage_version_result"
  exit 1
fi

coverage_training_request="$(cat <<JSON
{"name":"coverage-gate-job","task_type":"detection","framework":"yolo","dataset_id":"${coverage_dataset_id}","dataset_version_id":"${coverage_version_id}","base_model":"yolo11n","config":{"epochs":"1","batch_size":"1","learning_rate":"0.001"}}
JSON
)"
coverage_training_result="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$coverage_training_request" \
  "${BASE_URL}/api/training/jobs")"
coverage_training_success="$(echo "$coverage_training_result" | jq -r '.success // false')"
coverage_training_error_code="$(echo "$coverage_training_result" | jq -r '.error.code // empty')"
coverage_training_error_message="$(echo "$coverage_training_result" | jq -r '.error.message // empty')"
if [[ "$coverage_training_success" != "false" || "$coverage_training_error_code" != "VALIDATION_ERROR" || "$coverage_training_error_message" != *"annotation coverage"* ]]; then
  echo "[smoke-phase2] Coverage gate validation did not reject zero-coverage training launch as expected"
  echo "$coverage_training_result"
  exit 1
fi

echo "[smoke-phase2] PASS"
echo "dataset_id=${dataset_id}"
echo "dataset_item_id=${dataset_item_id}"
echo "annotation_status=${saved_status}"
echo "polygon_count=${polygon_count}"
echo "yolo_inference_run_id=${inference_run_id}"
echo "yolo_fallback_source=${fallback_source}"
echo "yolo_fallback_reason=${fallback_reason}"
echo "paddleocr_inference_run_id=${ocr_inference_run_id}"
echo "paddleocr_fallback_source=${ocr_fallback_source}"
echo "paddleocr_fallback_reason=${ocr_fallback_reason}"
echo "doctr_training_job_id=${doctr_training_job_id}"
echo "doctr_model_version_id=${doctr_model_version_id}"
echo "doctr_register_mode=${doctr_register_mode}"
echo "doctr_inference_run_id=${doctr_inference_run_id}"
echo "doctr_fallback_source=${doctr_fallback_source}"
echo "doctr_fallback_reason=${doctr_fallback_reason}"
echo "no_train_gate_version_id=${no_train_version_id}"
echo "version_mismatch_gate_version_id=${version_mismatch_version_id}"
echo "coverage_gate_dataset_id=${coverage_dataset_id}"
echo "coverage_gate_version_id=${coverage_version_id}"
