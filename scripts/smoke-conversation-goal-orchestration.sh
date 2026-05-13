#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-conversation-goal-orchestration] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-conversation-goal-orchestration] python3 is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-alice}"
AUTH_PASSWORD="${AUTH_PASSWORD:-mock-pass}"
EXPECT_REAL_DELIVERY="${EXPECT_REAL_DELIVERY:-false}"
PYTHON_BIN="${PYTHON_BIN:-${VISTRAL_PYTHON_BIN:-python3}}"

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
API_PORT="${API_PORT:-8841}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
SAMPLE_IMAGE_FILE="$(mktemp "${TMPDIR:-/tmp}/conversation-goal-orchestration.XXXXXX.png")"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${SAMPLE_IMAGE_FILE}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

if [[ "${EXPECT_REAL_DELIVERY}" == "true" ]]; then
  "${PYTHON_BIN}" - "${SAMPLE_IMAGE_FILE}" <<'PY'
from pathlib import Path
import sys
from PIL import Image, ImageDraw

path = Path(sys.argv[1])
image = Image.new("RGB", (64, 64), "white")
draw = ImageDraw.Draw(image)
draw.rectangle((8, 8, 55, 55), fill=(220, 40, 40), outline=(40, 40, 40), width=2)
image.save(path)
PY
else
  python3 - "${SAMPLE_IMAGE_FILE}" <<'PY'
import base64
import pathlib
import sys

payload = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZlN8AAAAASUVORK5CYII="
)
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(payload))
PY
fi

wait_for_health() {
  for _ in $(seq 1 160); do
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

post_json() {
  local path="$1"
  local body="$2"
  curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H 'Content-Type: application/json' \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}${path}" \
    -d "${body}"
}

wait_attachment_ready() {
  local list_url="$1"
  local attachment_id="$2"
  local resp=""
  local status=""

  for _ in $(seq 1 120); do
    resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${list_url}")"
    status="$(echo "${resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id == $id) | .status // empty')"
    if [[ "${status}" == "ready" ]]; then
      return 0
    fi
    if [[ "${status}" == "error" ]]; then
      echo "[smoke-conversation-goal-orchestration] attachment ${attachment_id} entered error."
      echo "${resp}"
      exit 1
    fi
    sleep 0.2
  done
  echo "[smoke-conversation-goal-orchestration] attachment ${attachment_id} did not become ready."
  echo "${resp}"
  exit 1
}

upload_dataset_image() {
  local dataset_id="$1"
  local filename="$2"
  local upload_resp=""
  upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "X-CSRF-Token: ${csrf_token}" \
    -F "file=@${SAMPLE_IMAGE_FILE};type=image/png;filename=${filename}" \
    "${BASE_URL}/api/files/dataset/${dataset_id}/upload")"
  local attachment_id
  attachment_id="$(echo "${upload_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${attachment_id}" ]]; then
    echo "[smoke-conversation-goal-orchestration] dataset upload failed."
    echo "${upload_resp}"
    exit 1
  fi
  wait_attachment_ready "${BASE_URL}/api/files/dataset/${dataset_id}" "${attachment_id}"
  echo "${attachment_id}"
}

prepare_detection_dataset_version() {
  local run_tag="$1"
  local dataset_resp=""
  dataset_resp="$(post_json "/api/datasets" "$(jq -nc \
    --arg name "conversation-goal-detection-${run_tag}" \
    '{name:$name,description:"conversation goal orchestration smoke dataset",task_type:"detection",label_schema:{classes:["target"]}}')")"
  local dataset_id
  dataset_id="$(echo "${dataset_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${dataset_id}" ]]; then
    echo "[smoke-conversation-goal-orchestration] failed to create dataset."
    echo "${dataset_resp}"
    exit 1
  fi

  local attachment_1 attachment_2
  attachment_1="$(upload_dataset_image "${dataset_id}" "conversation-goal-1.png")"
  attachment_2="$(upload_dataset_image "${dataset_id}" "conversation-goal-2.png")"

  local detail_resp item_ids item_count
  detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
  item_ids="$(
    echo "${detail_resp}" | jq -r \
      --arg a1 "${attachment_1}" \
      --arg a2 "${attachment_2}" \
      '.data.items[] | select(.attachment_id == $a1 or .attachment_id == $a2) | .id'
  )"
  item_count="$(echo "${item_ids}" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "${item_count}" != "2" ]]; then
    echo "[smoke-conversation-goal-orchestration] expected two dataset items."
    echo "${detail_resp}"
    exit 1
  fi

  while IFS= read -r item_id; do
    [[ -n "${item_id}" ]] || continue
    local annotation_resp annotation_status
    annotation_resp="$(post_json "/api/datasets/${dataset_id}/annotations" "$(jq -nc \
      --arg item_id "${item_id}" \
      '{dataset_item_id:$item_id,task_type:"detection",source:"manual",status:"annotated",payload:{boxes:[{id:"box-1",x:0,y:0,width:1,height:1,label:"target"}],polygons:[]}}')")"
    annotation_status="$(echo "${annotation_resp}" | jq -r '.data.status // empty')"
    if [[ "${annotation_status}" != "annotated" ]]; then
      echo "[smoke-conversation-goal-orchestration] failed to annotate item ${item_id}."
      echo "${annotation_resp}"
      exit 1
    fi
  done <<< "${item_ids}"

  local split_resp train_count val_count
  split_resp="$(post_json "/api/datasets/${dataset_id}/split" '{"train_ratio":0.5,"val_ratio":0.5,"test_ratio":0,"seed":23}')"
  train_count="$(echo "${split_resp}" | jq -r '.data.split_summary.train // 0')"
  val_count="$(echo "${split_resp}" | jq -r '.data.split_summary.val // 0')"
  if [[ "${train_count}" -lt 1 || "${val_count}" -lt 1 ]]; then
    echo "[smoke-conversation-goal-orchestration] split failed."
    echo "${split_resp}"
    exit 1
  fi

  local version_resp version_id
  version_resp="$(post_json "/api/datasets/${dataset_id}/versions" "$(jq -nc --arg version_name "conversation-goal-v1-${run_tag}" '{version_name:$version_name}')")"
  version_id="$(echo "${version_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${version_id}" ]]; then
    echo "[smoke-conversation-goal-orchestration] failed to create dataset version."
    echo "${version_resp}"
    exit 1
  fi

  jq -nc --arg dataset_id "${dataset_id}" --arg version_id "${version_id}" \
    '{dataset_id:$dataset_id,version_id:$version_id}'
}

if [[ "${START_API}" == "true" ]]; then
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  MODEL_EXPORT_ROOT="${APP_DATA_DIR}/model-exports" \
  VISTRAL_RUNNER_ENABLE_REAL="${VISTRAL_RUNNER_ENABLE_REAL:-0}" \
  VISTRAL_PYTHON_BIN="${VISTRAL_PYTHON_BIN:-${PYTHON_BIN}}" \
  PYTHON_BIN="${PYTHON_BIN}" \
  YOLO_LOCAL_MODEL_PATH="${YOLO_LOCAL_MODEL_PATH:-${REAL_YOLO_MODEL_PATH:-${VISTRAL_YOLO_MODEL_PATH:-}}}" \
  VISTRAL_YOLO_MODEL_PATH="${VISTRAL_YOLO_MODEL_PATH:-${YOLO_LOCAL_MODEL_PATH:-${REAL_YOLO_MODEL_PATH:-}}}" \
  VISTRAL_DISABLE_INFERENCE_FALLBACK="${VISTRAL_DISABLE_INFERENCE_FALLBACK:-0}" \
  MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND="${MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND:-0}" \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  echo "[smoke-conversation-goal-orchestration] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_token="$(get_csrf_token)"
login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "$(jq -nc --arg username "${AUTH_USERNAME}" --arg password "${AUTH_PASSWORD}" '{username:$username,password:$password}')")"
if [[ "$(echo "${login_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-conversation-goal-orchestration] login failed."
  echo "${login_resp}"
  exit 1
fi
csrf_token="$(get_csrf_token)"

model_id="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/models" | jq -r '.data[0].id // empty')"
if [[ -z "${model_id}" ]]; then
  echo "[smoke-conversation-goal-orchestration] no visible model found."
  exit 1
fi

run_tag="$(date +%s)"
context_json="$(prepare_detection_dataset_version "${run_tag}")"
dataset_id="$(echo "${context_json}" | jq -r '.dataset_id')"
version_id="$(echo "${context_json}" | jq -r '.version_id')"

initial_message="请自动闭环训练并交付一个检测模型，用数据集 ${dataset_id}，epochs:1，batch_size:2，验收目标 mAP50>=0"
started_resp="$(post_json "/api/conversations/start" "$(jq -nc \
  --arg model_id "${model_id}" \
  --arg initial_message "${initial_message}" \
  '{model_id:$model_id,initial_message:$initial_message,attachment_ids:[]}')")"

conversation_id="$(echo "${started_resp}" | jq -r '.data.conversation.id // empty')"
initial_action="$(echo "${started_resp}" | jq -r '.data.messages[1].metadata.conversation_action.action // empty')"
initial_status="$(echo "${started_resp}" | jq -r '.data.messages[1].metadata.conversation_action.status // empty')"
initial_api="$(echo "${started_resp}" | jq -r '.data.messages[1].metadata.conversation_action.collected_fields.api // empty')"
initial_task_id="$(echo "${started_resp}" | jq -r '.data.messages[1].metadata.conversation_action.created_entity_id // empty')"
initial_task_type="$(echo "${started_resp}" | jq -r '.data.messages[1].metadata.conversation_action.collected_fields.task_type // empty')"
confirmation_phrase="$(echo "${started_resp}" | jq -r '.data.messages[1].metadata.conversation_action.confirmation_phrase // empty')"
missing_confirmation="$(echo "${started_resp}" | jq -r '.data.messages[1].metadata.conversation_action.missing_fields[]? | select(.=="confirmation")')"

if [[ -z "${conversation_id}" || "${initial_action}" != "console_api_call" || "${initial_status}" != "requires_input" || "${initial_api}" != "goal_orchestration" || -z "${initial_task_id}" || "${initial_task_type}" != "detection" || -z "${confirmation_phrase}" || "${missing_confirmation}" != "confirmation" ]]; then
  echo "[smoke-conversation-goal-orchestration] natural training delivery request did not queue goal orchestration confirmation."
  echo "${started_resp}"
  exit 1
fi

confirmed_resp="$(post_json "/api/conversations/message" "$(jq -nc \
  --arg conversation_id "${conversation_id}" \
  --arg content "${confirmation_phrase}" \
  '{conversation_id:$conversation_id,content:$content,attachment_ids:[]}')")"

final_status="$(echo "${confirmed_resp}" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
final_api="$(echo "${confirmed_resp}" | jq -r '.data.messages[-1].metadata.conversation_action.collected_fields.api // empty')"
final_action="$(echo "${confirmed_resp}" | jq -r '.data.messages[-1].metadata.conversation_action.collected_fields.action // empty')"
training_job_id="$(echo "${confirmed_resp}" | jq -r '.data.messages[-1].metadata.conversation_action.collected_fields.training_job_id // empty')"
model_version_id="$(echo "${confirmed_resp}" | jq -r '.data.messages[-1].metadata.conversation_action.collected_fields.model_version_id // empty')"

if [[ "${final_status}" != "completed" || "${final_api}" != "goal_orchestration" || -z "${final_action}" || -z "${training_job_id}" ]]; then
  echo "[smoke-conversation-goal-orchestration] confirmed goal orchestration did not auto-advance into a training delivery action."
  echo "${confirmed_resp}"
  exit 1
fi

task_detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/vision/tasks/${initial_task_id}")"
task_dataset_id="$(echo "${task_detail_resp}" | jq -r '.data.dataset_id // empty')"
task_version_id="$(echo "${task_detail_resp}" | jq -r '.data.dataset_version_id // empty')"
task_training_job_id="$(echo "${task_detail_resp}" | jq -r '.data.training_job_id // empty')"
next_action="$(echo "${task_detail_resp}" | jq -r '.data.agent_next_action.action // empty')"
auto_log_count="$(echo "${task_detail_resp}" | jq -r '[.data.agent_decision_log[]? | select(.source_layer == "auto_advance")] | length')"
planned_epochs="$(echo "${task_detail_resp}" | jq -r '.data.training_plan.train_args.epochs // empty')"
planned_batch_size="$(echo "${task_detail_resp}" | jq -r '.data.training_plan.train_args.batch_size // empty')"
threshold_target="$(echo "${task_detail_resp}" | jq -r '.data.evaluation_suite.threshold_target // empty')"

if [[ "${task_dataset_id}" != "${dataset_id}" || "${task_version_id}" != "${version_id}" || "${task_training_job_id}" != "${training_job_id}" || -z "${next_action}" || "${auto_log_count}" -lt 1 || "${planned_epochs}" != "1" || "${planned_batch_size}" != "2" || "${threshold_target}" != "0" ]]; then
  echo "[smoke-conversation-goal-orchestration] VisionTask evidence was not linked after conversation delivery orchestration."
  echo "${task_detail_resp}"
  exit 1
fi

if [[ "${EXPECT_REAL_DELIVERY}" == "true" ]]; then
  task_model_version_id="$(echo "${task_detail_resp}" | jq -r '.data.model_version_id // empty')"
  if [[ "${final_action}" != "registered" || -z "${model_version_id}" || "${task_model_version_id}" != "${model_version_id}" ]]; then
    echo "[smoke-conversation-goal-orchestration] real delivery expected registered model version."
    echo "${confirmed_resp}"
    echo "${task_detail_resp}"
    exit 1
  fi
  version_detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions/${model_version_id}")"
  version_detail="$(echo "${version_detail_resp}" | jq -r '.data // empty')"
  evidence_mode="$(echo "${version_detail}" | jq -r '.registration_evidence_mode // empty')"
  evidence_level="$(echo "${version_detail}" | jq -r '.registration_evidence_level // empty')"
  if [[ "${evidence_mode}" != "real" || "${evidence_level}" != "standard" ]]; then
    echo "[smoke-conversation-goal-orchestration] real delivery model version did not carry real standard evidence."
    echo "${version_detail_resp}"
    exit 1
  fi
fi

if [[ -n "${model_version_id}" ]]; then
  version_count="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions/${model_version_id}" | jq -r 'if .data.id then 1 else 0 end')"
  if [[ "${version_count}" != "1" ]]; then
    echo "[smoke-conversation-goal-orchestration] returned model_version_id was not visible."
    exit 1
  fi
fi

echo "[smoke-conversation-goal-orchestration] PASS"
echo "vision_task_id=${initial_task_id}"
echo "training_job_id=${training_job_id}"
echo "next_action=${next_action}"
