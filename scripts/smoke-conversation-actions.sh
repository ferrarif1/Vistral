#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
EXPECTED_TRAINING_DATASET_ID="${EXPECTED_TRAINING_DATASET_ID:-}"
EXPECTED_TRAINING_DATASET_VERSION_ID="${EXPECTED_TRAINING_DATASET_VERSION_ID:-}"
AUTO_PREPARE_TRAINING_TARGET="${AUTO_PREPARE_TRAINING_TARGET:-true}"
COOKIE_FILE="$(mktemp)"
LOG_FILE="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_FILE" "$LOG_FILE"
  rm -rf "$APP_DATA_DIR"
}

trap cleanup EXIT

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-conversation-actions] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-conversation-actions] python3 is required."
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
API_PORT="${API_PORT:-8795}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

wait_dataset_attachment_ready() {
  local dataset_id="$1"
  local attachment_id="$2"
  local list_resp=""
  local attachment_status=""

  for _ in $(seq 1 120); do
    list_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/files/dataset/${dataset_id}")"
    attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"

    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi
    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-conversation-actions] dataset attachment entered error state"
      echo "${list_resp}"
      exit 1
    fi

    sleep 0.2
  done

  echo "[smoke-conversation-actions] dataset attachment not ready in time"
  echo "${list_resp}"
  exit 1
}

wait_conversation_attachment_ready() {
  local attachment_id="$1"
  local list_resp=""
  local attachment_status=""

  for _ in $(seq 1 120); do
    list_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/files/conversation")"
    attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"

    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi
    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-conversation-actions] conversation attachment entered error state"
      echo "${list_resp}"
      exit 1
    fi

    sleep 0.2
  done

  echo "[smoke-conversation-actions] conversation attachment not ready in time"
  echo "${list_resp}"
  exit 1
}

prepare_trainable_detection_target() {
  local create_dataset_resp=""
  local dataset_id=""
  local upload_resp=""
  local attachment_id=""
  local dataset_detail_resp=""
  local dataset_item_ids=""
  local dataset_item_id=""
  local annotation_resp=""
  local annotation_status=""
  local split_resp=""
  local split_train_count=""
  local version_resp=""
  local version_id=""
  local run_tag

  run_tag="$(date +%s)"

  create_dataset_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -X POST \
    -d "{\"name\":\"conversation-training-target-${run_tag}\",\"description\":\"conversation actions smoke target\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}" \
    "${BASE_URL}/api/datasets")"
  dataset_id="$(echo "${create_dataset_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${dataset_id}" ]]; then
    echo "[smoke-conversation-actions] failed to create dedicated training dataset target"
    echo "${create_dataset_resp}"
    exit 1
  fi

  for suffix in 1 2; do
    upload_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
      -H 'Content-Type: application/json' \
      -H "x-csrf-token: $csrf_token" \
      -X POST \
      -d "{\"filename\":\"conversation-training-target-${run_tag}-${suffix}.jpg\"}" \
      "${BASE_URL}/api/files/dataset/${dataset_id}/upload")"
    attachment_id="$(echo "${upload_resp}" | jq -r '.data.id // empty')"
    if [[ -z "${attachment_id}" ]]; then
      echo "[smoke-conversation-actions] failed to upload sample ${suffix} for dedicated training dataset target"
      echo "${upload_resp}"
      exit 1
    fi
    wait_dataset_attachment_ready "${dataset_id}" "${attachment_id}"
  done

  dataset_detail_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${dataset_id}")"
  dataset_item_ids="$(echo "${dataset_detail_resp}" | jq -r '.data.items[].id // empty')"
  if [[ -z "${dataset_item_ids}" ]]; then
    echo "[smoke-conversation-actions] dataset items were not generated for dedicated training target"
    echo "${dataset_detail_resp}"
    exit 1
  fi

  while IFS= read -r dataset_item_id; do
    if [[ -z "${dataset_item_id}" ]]; then
      continue
    fi
    annotation_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
      -H 'Content-Type: application/json' \
      -H "x-csrf-token: $csrf_token" \
      -X POST \
      -d "{\"dataset_item_id\":\"${dataset_item_id}\",\"task_type\":\"detection\",\"source\":\"manual\",\"status\":\"annotated\",\"payload\":{\"boxes\":[{\"id\":\"box-1\",\"x\":48,\"y\":56,\"width\":132,\"height\":96,\"label\":\"defect\"}]}}" \
      "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
    annotation_status="$(echo "${annotation_resp}" | jq -r '.data.status // empty')"
    if [[ "${annotation_status}" != "annotated" ]]; then
      echo "[smoke-conversation-actions] failed to annotate dedicated training target dataset item ${dataset_item_id}"
      echo "${annotation_resp}"
      exit 1
    fi
  done <<< "${dataset_item_ids}"

  split_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -X POST \
    -d '{"train_ratio":0.5,"val_ratio":0.5,"test_ratio":0,"seed":19}' \
    "${BASE_URL}/api/datasets/${dataset_id}/split")"
  split_train_count="$(echo "${split_resp}" | jq -r '.data.split_summary.train // 0')"
  if [[ "${split_train_count}" -lt 1 ]]; then
    echo "[smoke-conversation-actions] split did not produce train items for dedicated training target"
    echo "${split_resp}"
    exit 1
  fi

  version_resp="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -X POST \
    -d "{\"version_name\":\"conversation-training-target-v1-${run_tag}\"}" \
    "${BASE_URL}/api/datasets/${dataset_id}/versions")"
  version_id="$(echo "${version_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${version_id}" ]]; then
    echo "[smoke-conversation-actions] failed to create dataset version for dedicated training target"
    echo "${version_resp}"
    exit 1
  fi

  selected_training_dataset_id="${dataset_id}"
  selected_training_dataset_version_id="${version_id}"
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

if [[ "${START_API}" == "true" ]]; then
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  API_HOST="${API_HOST}" \
  API_PORT="$API_PORT" \
  npm run dev:api >"$LOG_FILE" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  if [[ "${START_API}" == "true" ]]; then
    if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
      echo "[smoke-conversation-actions] API process exited before health check (possible port conflict)"
      cat "$LOG_FILE"
      exit 1
    fi
    echo "[smoke-conversation-actions] API failed to start"
    cat "$LOG_FILE"
  else
    echo "[smoke-conversation-actions] API is unreachable at ${BASE_URL}"
  fi
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-conversation-actions] Failed to obtain CSRF token"
  echo "$csrf_payload"
  exit 1
fi

if [[ -n "${AUTH_USERNAME}" ]]; then
  if [[ -z "${AUTH_PASSWORD}" ]]; then
    echo "[smoke-conversation-actions] AUTH_PASSWORD is required when AUTH_USERNAME is set"
    exit 1
  fi

  login_response="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "$login_response" | jq -r '.success // false')"
  if [[ "${login_success}" != "true" ]]; then
    echo "[smoke-conversation-actions] login failed for AUTH_USERNAME=${AUTH_USERNAME}"
    echo "$login_response"
    exit 1
  fi

  csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
  if [[ -z "$csrf_token" ]]; then
    echo "[smoke-conversation-actions] Failed to refresh CSRF token after login"
    echo "$csrf_payload"
    exit 1
  fi
fi

model_id="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/models" | jq -r '.data[0].id // empty')"
if [[ -z "$model_id" ]]; then
  echo "[smoke-conversation-actions] No visible model found"
  exit 1
fi

selected_training_dataset_id="${EXPECTED_TRAINING_DATASET_ID}"
selected_training_dataset_version_id="${EXPECTED_TRAINING_DATASET_VERSION_ID}"

if [[ -z "${selected_training_dataset_id}" && -z "${selected_training_dataset_version_id}" && "${AUTO_PREPARE_TRAINING_TARGET}" == "true" ]]; then
  prepare_trainable_detection_target
fi

if [[ -z "${selected_training_dataset_id}" ]]; then
  datasets_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets")"
  selected_training_dataset_id="$(echo "${datasets_payload}" | jq -r '.data[] | select(.task_type=="detection" and .status=="ready" and (.name | test("^(conversation-smoke-dataset-|real-det-|roundtrip-|persist-check-ds$|import-ref-test$|demo train dataset|attachment-smoke-dataset$)"; "i") | not)) | .id' | head -n 1)"
  if [[ -z "${selected_training_dataset_id}" ]]; then
    selected_training_dataset_id="$(echo "${datasets_payload}" | jq -r '.data[] | select(.task_type=="detection" and .status=="ready") | .id' | head -n 1)"
  fi
  if [[ -z "${selected_training_dataset_id}" ]]; then
    echo "[smoke-conversation-actions] No ready detection dataset found for training action. Set EXPECTED_TRAINING_DATASET_ID explicitly."
    echo "${datasets_payload}"
    exit 1
  fi
fi

if [[ -z "${selected_training_dataset_version_id}" ]]; then
  versions_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets/${selected_training_dataset_id}/versions")"
  selected_training_dataset_version_id="$(echo "${versions_payload}" | jq -r '.data[] | select((.split_summary.train // 0) > 0 and (.annotation_coverage // 0) > 0) | .id' | head -n 1)"
  if [[ -z "${selected_training_dataset_version_id}" ]]; then
    echo "[smoke-conversation-actions] No trainable dataset version found (requires train split > 0 and annotation_coverage > 0). Set EXPECTED_TRAINING_DATASET_VERSION_ID explicitly."
    echo "${versions_payload}"
    exit 1
  fi
fi

dataset_name="conversation-smoke-dataset-$(date +%s)"
dataset_started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${model_id}\",\"initial_message\":\"帮我创建一个检测数据集，名字叫${dataset_name}\",\"attachment_ids\":[]}" \
  "${BASE_URL}/api/conversations/start")"

dataset_conversation_id="$(echo "$dataset_started" | jq -r '.data.conversation.id // empty')"
dataset_action="$(echo "$dataset_started" | jq -r '.data.messages[1].metadata.conversation_action.action // empty')"
dataset_status="$(echo "$dataset_started" | jq -r '.data.messages[1].metadata.conversation_action.status // empty')"
dataset_id="$(echo "$dataset_started" | jq -r '.data.messages[1].metadata.conversation_action.created_entity_id // empty')"

if [[ "$dataset_action" == "create_dataset" && "$dataset_status" == "requires_input" ]]; then
  dataset_confirmation_phrase="$(echo "$dataset_started" | jq -r '.data.messages[1].metadata.conversation_action.confirmation_phrase // "确认执行"')"
  dataset_confirmed="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d "{\"conversation_id\":\"${dataset_conversation_id}\",\"content\":\"${dataset_confirmation_phrase}\",\"attachment_ids\":[]}" \
    "${BASE_URL}/api/conversations/message")"
  dataset_action="$(echo "$dataset_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
  dataset_status="$(echo "$dataset_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
  dataset_id="$(echo "$dataset_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.created_entity_id // empty')"
fi

if [[ "$dataset_action" != "create_dataset" || "$dataset_status" != "completed" || -z "$dataset_id" ]]; then
  echo "[smoke-conversation-actions] Dataset conversation action failed"
  echo "$dataset_started"
  exit 1
fi

model_name="conversation-smoke-model-$(date +%s)"
model_started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${model_id}\",\"initial_message\":\"帮我创建一个OCR模型草稿，名字叫${model_name}\",\"attachment_ids\":[]}" \
  "${BASE_URL}/api/conversations/start")"

model_conversation_id="$(echo "$model_started" | jq -r '.data.conversation.id // empty')"
model_action="$(echo "$model_started" | jq -r '.data.messages[1].metadata.conversation_action.action // empty')"
model_status="$(echo "$model_started" | jq -r '.data.messages[1].metadata.conversation_action.status // empty')"
model_draft_id="$(echo "$model_started" | jq -r '.data.messages[1].metadata.conversation_action.created_entity_id // empty')"

if [[ "$model_action" == "create_model_draft" && "$model_status" == "requires_input" ]]; then
  model_confirmation_phrase="$(echo "$model_started" | jq -r '.data.messages[1].metadata.conversation_action.confirmation_phrase // "确认执行"')"
  model_confirmed="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d "{\"conversation_id\":\"${model_conversation_id}\",\"content\":\"${model_confirmation_phrase}\",\"attachment_ids\":[]}" \
    "${BASE_URL}/api/conversations/message")"
  model_action="$(echo "$model_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
  model_status="$(echo "$model_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
  model_draft_id="$(echo "$model_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.created_entity_id // empty')"
fi

if [[ "$model_action" != "create_model_draft" || "$model_status" != "completed" || -z "$model_draft_id" ]]; then
  echo "[smoke-conversation-actions] Model-draft conversation action failed"
  echo "$model_started"
  exit 1
fi

job_name="conversation-smoke-job-$(date +%s)"
training_started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${model_id}\",\"initial_message\":\"帮我创建一个检测训练任务，名字叫${job_name}\",\"attachment_ids\":[]}" \
  "${BASE_URL}/api/conversations/start")"

training_conversation_id="$(echo "$training_started" | jq -r '.data.conversation.id // empty')"
training_action="$(echo "$training_started" | jq -r '.data.messages[1].metadata.conversation_action.action // empty')"
training_status="$(echo "$training_started" | jq -r '.data.messages[1].metadata.conversation_action.status // empty')"
training_missing_dataset="$(echo "$training_started" | jq -r '.data.messages[1].metadata.conversation_action.missing_fields[]? | select(.=="dataset_id")')"

if [[ "$training_action" != "create_training_job" || "$training_status" != "requires_input" || "$training_missing_dataset" != "dataset_id" ]]; then
  echo "[smoke-conversation-actions] Training conversation action did not request dataset input"
  echo "$training_started"
  exit 1
fi

training_extraction_conflict_upload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"filename":"conversation-training-intent-ocr.bmp"}' \
  "${BASE_URL}/api/files/conversation/upload")"
training_extraction_conflict_attachment_id="$(echo "$training_extraction_conflict_upload" | jq -r '.data.id // empty')"
if [[ -z "$training_extraction_conflict_attachment_id" ]]; then
  echo "[smoke-conversation-actions] failed to upload attachment for extraction-conflict training intent check"
  echo "$training_extraction_conflict_upload"
  exit 1
fi
wait_conversation_attachment_ready "${training_extraction_conflict_attachment_id}"

training_extraction_conflict_started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${model_id}\",\"initial_message\":\"帮我训练一个识别图片上车号等文字的模型\",\"attachment_ids\":[\"${training_extraction_conflict_attachment_id}\"]}" \
  "${BASE_URL}/api/conversations/start")"

training_extraction_conflict_action="$(echo "$training_extraction_conflict_started" | jq -r '.data.messages[1].metadata.conversation_action.action // empty')"
training_extraction_conflict_status="$(echo "$training_extraction_conflict_started" | jq -r '.data.messages[1].metadata.conversation_action.status // empty')"
training_extraction_conflict_missing_dataset="$(echo "$training_extraction_conflict_started" | jq -r '.data.messages[1].metadata.conversation_action.missing_fields[]? | select(.=="dataset_id")')"

if [[ "$training_extraction_conflict_action" != "create_training_job" || "$training_extraction_conflict_status" != "requires_input" || "$training_extraction_conflict_missing_dataset" != "dataset_id" ]]; then
  echo "[smoke-conversation-actions] Training intent with extraction keywords was hijacked unexpectedly"
  echo "$training_extraction_conflict_started"
  exit 1
fi

training_short_prompt_started="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"model_id\":\"${model_id}\",\"initial_message\":\"训练识别车号的模型\",\"attachment_ids\":[\"${training_extraction_conflict_attachment_id}\"]}" \
  "${BASE_URL}/api/conversations/start")"

training_short_prompt_action="$(echo "$training_short_prompt_started" | jq -r '.data.messages[1].metadata.conversation_action.action // empty')"
training_short_prompt_status="$(echo "$training_short_prompt_started" | jq -r '.data.messages[1].metadata.conversation_action.status // empty')"
training_short_prompt_missing_dataset="$(echo "$training_short_prompt_started" | jq -r '.data.messages[1].metadata.conversation_action.missing_fields[]? | select(.=="dataset_id")')"

if [[ "$training_short_prompt_action" != "create_training_job" || "$training_short_prompt_status" != "requires_input" || "$training_short_prompt_missing_dataset" != "dataset_id" ]]; then
  echo "[smoke-conversation-actions] Short Chinese training intent was not resolved as create_training_job"
  echo "$training_short_prompt_started"
  exit 1
fi

training_followup="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"conversation_id\":\"${training_conversation_id}\",\"content\":\"用数据集 ${selected_training_dataset_id}\",\"attachment_ids\":[]}" \
  "${BASE_URL}/api/conversations/message")"

training_followup_status="$(echo "$training_followup" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
training_followup_missing_count="$(echo "$training_followup" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | length')"
training_followup_has_missing_split="$(echo "$training_followup" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields[]? | select(.=="dataset_issue:missing_validation_split")')"

if [[ "$training_followup_status" != "requires_input" || "$training_followup_missing_count" -lt 1 ]]; then
  echo "[smoke-conversation-actions] Training conversation action did not enter requires_input after dataset selection"
  echo "$training_followup"
  exit 1
fi

if [[ "$training_followup_has_missing_split" == "dataset_issue:missing_validation_split" ]]; then
  echo "[smoke-conversation-actions] Prepared training dataset unexpectedly missed validation split"
  echo "$training_followup"
  exit 1
fi

training_example_upload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -X POST \
  -d "{\"filename\":\"conversation-training-example-$(date +%s).jpg\"}" \
  "${BASE_URL}/api/files/conversation/upload")"
training_example_attachment_id="$(echo "$training_example_upload" | jq -r '.data.id // empty')"
if [[ -z "$training_example_attachment_id" ]]; then
  echo "[smoke-conversation-actions] failed to upload training example image attachment"
  echo "$training_example_upload"
  exit 1
fi
wait_conversation_attachment_ready "${training_example_attachment_id}"

training_final="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "{\"conversation_id\":\"${training_conversation_id}\",\"content\":\"版本用 ${selected_training_dataset_version_id}，验收目标 mAP50>=0.60\",\"attachment_ids\":[\"${training_example_attachment_id}\"]}" \
  "${BASE_URL}/api/conversations/message")"

training_final_status="$(echo "$training_final" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
training_job_id="$(echo "$training_final" | jq -r '.data.messages[-1].metadata.conversation_action.created_entity_id // empty')"
training_dataset_id="$(echo "$training_final" | jq -r '.data.messages[-1].metadata.conversation_action.collected_fields.dataset_id // empty')"
training_dataset_version_id="$(echo "$training_final" | jq -r '.data.messages[-1].metadata.conversation_action.collected_fields.dataset_version_id // empty')"

if [[ "$training_final_status" == "requires_input" ]]; then
  training_missing_confirmation="$(echo "$training_final" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields[]? | select(.=="confirmation")')"
  if [[ "$training_missing_confirmation" == "confirmation" ]]; then
    training_confirmed="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
      -H 'Content-Type: application/json' \
      -H "x-csrf-token: $csrf_token" \
      -d "{\"conversation_id\":\"${training_conversation_id}\",\"content\":\"确认执行\",\"attachment_ids\":[\"${training_example_attachment_id}\"]}" \
      "${BASE_URL}/api/conversations/message")"
    training_final="$training_confirmed"
    training_final_status="$(echo "$training_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
    training_job_id="$(echo "$training_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.created_entity_id // empty')"
    training_dataset_id="$(echo "$training_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.collected_fields.dataset_id // empty')"
    training_dataset_version_id="$(echo "$training_confirmed" | jq -r '.data.messages[-1].metadata.conversation_action.collected_fields.dataset_version_id // empty')"
  fi
fi

if [[ "$training_final_status" != "completed" || -z "$training_job_id" || "$training_dataset_id" != "$selected_training_dataset_id" || "$training_dataset_version_id" != "$selected_training_dataset_version_id" ]]; then
  echo "[smoke-conversation-actions] Training conversation completion failed"
  echo "$training_final"
  exit 1
fi

job_exists="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/training/jobs" | jq -r --arg JOB_ID "$training_job_id" '[.data[] | select(.id==$JOB_ID)] | length')"
if [[ "$job_exists" != "1" ]]; then
  echo "[smoke-conversation-actions] Created training job not visible in training jobs list"
  exit 1
fi

echo "[smoke-conversation-actions] PASS"
echo "dataset_id=${dataset_id}"
echo "model_draft_id=${model_draft_id}"
echo "training_job_id=${training_job_id}"
echo "training_dataset_id=${selected_training_dataset_id}"
echo "training_dataset_version_id=${selected_training_dataset_version_id}"
