#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-vision-task-closure] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-vision-task-closure] python3 is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-alice}"
AUTH_PASSWORD="${AUTH_PASSWORD:-mock-pass}"
VISION_TASK_SMOKE_MAX_ROUNDS="${VISION_TASK_SMOKE_MAX_ROUNDS:-3}"

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
API_PORT="${API_PORT:-8817}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
SAMPLE_IMAGE_FILE=""
API_PID=""
WAIT_TASK_PAYLOAD=""
WAIT_JOB_PAYLOAD=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${SAMPLE_IMAGE_FILE:-}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

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

wait_attachment_ready() {
  local list_url="$1"
  local attachment_id="$2"
  local label="$3"
  local resp=""
  local status=""

  for _ in $(seq 1 120); do
    resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${list_url}")"
    status="$(echo "${resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id == $id) | .status // empty')"
    if [[ "${status}" == "ready" ]]; then
      return 0
    fi
    if [[ "${status}" == "error" ]]; then
      echo "[smoke-vision-task-closure] ${label} attachment entered error state."
      echo "${resp}"
      exit 1
    fi
    sleep 0.25
  done

  echo "[smoke-vision-task-closure] ${label} attachment did not reach ready."
  echo "${resp}"
  exit 1
}

wait_vision_task_status() {
  local task_id="$1"
  local expected_csv="$2"
  local resp=""
  local status=""

  for _ in $(seq 1 200); do
    resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/vision/tasks/${task_id}")"
    status="$(echo "${resp}" | jq -r '.data.status // empty')"
    if [[ ",${expected_csv}," == *",${status},"* ]]; then
      WAIT_TASK_PAYLOAD="${resp}"
      return 0
    fi
    if [[ "${status}" == "failed" ]]; then
      echo "[smoke-vision-task-closure] vision task ${task_id} failed unexpectedly."
      echo "${resp}"
      exit 1
    fi
    sleep 0.25
  done

  echo "[smoke-vision-task-closure] vision task ${task_id} did not reach expected status: ${expected_csv}."
  echo "${resp}"
  exit 1
}

wait_training_job_status() {
  local job_id="$1"
  local expected_csv="$2"
  local resp=""
  local status=""

  for _ in $(seq 1 200); do
    resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
    status="$(echo "${resp}" | jq -r '.data.job.status // empty')"
    if [[ ",${expected_csv}," == *",${status},"* ]]; then
      WAIT_JOB_PAYLOAD="${resp}"
      return 0
    fi
    if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
      echo "[smoke-vision-task-closure] training job ${job_id} entered terminal failure status."
      echo "${resp}"
      exit 1
    fi
    sleep 0.25
  done

  echo "[smoke-vision-task-closure] training job ${job_id} did not reach expected status: ${expected_csv}."
  echo "${resp}"
  exit 1
}

SAMPLE_IMAGE_FILE="$(mktemp "${TMPDIR:-/tmp}/vision-task-smoke.XXXXXX.png")"
python3 - "${SAMPLE_IMAGE_FILE}" <<'PY'
import base64
import pathlib
import sys

payload = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZlN8AAAAASUVORK5CYII="
)
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(payload))
PY

if [[ "${START_API}" == "true" ]]; then
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  MODEL_EXPORT_ROOT="${APP_DATA_DIR}/model-exports" \
  MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND="${MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND:-1}" \
  VISTRAL_DISABLE_INFERENCE_FALLBACK="${VISTRAL_DISABLE_INFERENCE_FALLBACK:-0}" \
  VISTRAL_RUNNER_ENABLE_REAL="${VISTRAL_RUNNER_ENABLE_REAL:-0}" \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  if [[ "${START_API}" == "true" ]]; then
    echo "[smoke-vision-task-closure] API failed to start."
    cat "${API_LOG}"
  else
    echo "[smoke-vision-task-closure] API is unreachable at ${BASE_URL}."
  fi
  exit 1
fi

csrf_token="$(get_csrf_token)"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-vision-task-closure] failed to obtain initial CSRF token."
  exit 1
fi

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "$(jq -nc --arg username "${AUTH_USERNAME}" --arg password "${AUTH_PASSWORD}" '{username:$username,password:$password}')")"
login_success="$(echo "${login_resp}" | jq -r '.success // false')"
if [[ "${login_success}" != "true" ]]; then
  echo "[smoke-vision-task-closure] login failed for AUTH_USERNAME=${AUTH_USERNAME}."
  echo "${login_resp}"
  exit 1
fi

csrf_token="$(get_csrf_token)"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-vision-task-closure] failed to refresh CSRF token after login."
  exit 1
fi

sample_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -F "file=@${SAMPLE_IMAGE_FILE};type=image/png;filename=vision-task-chat-sample.png" \
  "${BASE_URL}/api/files/conversation/upload")"
sample_attachment_id="$(echo "${sample_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${sample_attachment_id}" ]]; then
  echo "[smoke-vision-task-closure] failed to upload sample conversation image."
  echo "${sample_upload_resp}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/conversation" "${sample_attachment_id}" "conversation sample"

missing_understand_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/vision/tasks/understand" \
  -d "$(jq -nc \
    --arg prompt "Train a detection model for the target object shown in this sample." \
    --arg attachment_id "${sample_attachment_id}" \
    '{prompt:$prompt, attachment_ids:[$attachment_id]}')")"
missing_task_id="$(echo "${missing_understand_resp}" | jq -r '.data.task.id // empty')"
missing_task_status="$(echo "${missing_understand_resp}" | jq -r '.data.task.status // empty')"
missing_task_can_start="$(echo "${missing_understand_resp}" | jq -r '.data.can_start_training // false')"
missing_dataset_id_flag="$(echo "${missing_understand_resp}" | jq -r '[.data.task.missing_requirements[]? | select(. == "dataset_id")] | length')"
missing_example_images_flag="$(echo "${missing_understand_resp}" | jq -r '[.data.task.missing_requirements[]? | select(. == "example_images")] | length')"
if [[ -z "${missing_task_id}" || "${missing_task_status}" != "requires_input" || "${missing_task_can_start}" != "false" || "${missing_dataset_id_flag}" -lt 1 || "${missing_example_images_flag}" -ne 0 ]]; then
  echo "[smoke-vision-task-closure] missing-requirements understand response did not match contract."
  echo "${missing_understand_resp}"
  exit 1
fi

missing_auto_advance_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/vision/tasks/${missing_task_id}/auto-advance" \
  -d '{"max_rounds":3}')"
missing_auto_advance_action="$(echo "${missing_auto_advance_resp}" | jq -r '.data.action // empty')"
missing_auto_advance_message="$(echo "${missing_auto_advance_resp}" | jq -r '.data.message // empty')"
if [[ "${missing_auto_advance_action}" != "requires_input" || "${missing_auto_advance_message}" != *"dataset_id"* ]]; then
  echo "[smoke-vision-task-closure] auto-advance did not preserve requires_input behavior."
  echo "${missing_auto_advance_resp}"
  exit 1
fi

run_tag="$(date +%s)"
dataset_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "$(jq -nc --arg name "vision-task-smoke-${run_tag}" '{name:$name,description:"vision task closure smoke dataset",task_type:"detection",label_schema:{classes:["target"]}}')")"
dataset_id="$(echo "${dataset_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dataset_id}" ]]; then
  echo "[smoke-vision-task-closure] failed to create detection dataset."
  echo "${dataset_resp}"
  exit 1
fi

dataset_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -F "file=@${SAMPLE_IMAGE_FILE};type=image/png;filename=vision-task-dataset-sample.png" \
  "${BASE_URL}/api/files/dataset/${dataset_id}/upload")"
dataset_attachment_id="$(echo "${dataset_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dataset_attachment_id}" ]]; then
  echo "[smoke-vision-task-closure] failed to upload dataset sample."
  echo "${dataset_upload_resp}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/dataset/${dataset_id}" "${dataset_attachment_id}" "dataset sample"

dataset_upload_resp_2="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -F "file=@${SAMPLE_IMAGE_FILE};type=image/png;filename=vision-task-dataset-sample-2.png" \
  "${BASE_URL}/api/files/dataset/${dataset_id}/upload")"
dataset_attachment_id_2="$(echo "${dataset_upload_resp_2}" | jq -r '.data.id // empty')"
if [[ -z "${dataset_attachment_id_2}" ]]; then
  echo "[smoke-vision-task-closure] failed to upload second dataset sample."
  echo "${dataset_upload_resp_2}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/dataset/${dataset_id}" "${dataset_attachment_id_2}" "dataset sample 2"

dataset_detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}")"
dataset_item_ids="$(
  echo "${dataset_detail_resp}" | jq -r '
    .data.items[]
    | select(
        .attachment_id == "'"${dataset_attachment_id}"'"
        or
        .attachment_id == "'"${dataset_attachment_id_2}"'"
      )
    | .id // empty
  '
)"
dataset_item_count="$(echo "${dataset_item_ids}" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "${dataset_item_count}" != "2" ]]; then
  echo "[smoke-vision-task-closure] expected two dataset items for uploaded samples."
  echo "${dataset_detail_resp}"
  exit 1
fi

while IFS= read -r dataset_item_id; do
  [[ -n "${dataset_item_id}" ]] || continue
  annotation_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H 'Content-Type: application/json' \
    -H "X-CSRF-Token: ${csrf_token}" \
    -X POST "${BASE_URL}/api/datasets/${dataset_id}/annotations" \
    -d "$(jq -nc --arg dataset_item_id "${dataset_item_id}" '
      {
        dataset_item_id: $dataset_item_id,
        task_type: "detection",
        source: "manual",
        status: "annotated",
        payload: {
          boxes: [
            {
              id: "box-1",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              label: "target"
            }
          ],
          polygons: []
        }
      }
    ')")"
  annotation_status="$(echo "${annotation_resp}" | jq -r '.data.status // empty')"
  if [[ "${annotation_status}" != "annotated" ]]; then
    echo "[smoke-vision-task-closure] failed to create annotated dataset item."
    echo "${annotation_resp}"
    exit 1
  fi
done <<< "${dataset_item_ids}"

split_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/split" \
  -d '{"train_ratio":0.5,"val_ratio":0.5,"test_ratio":0,"seed":17}')"
train_count="$(echo "${split_resp}" | jq -r '.data.split_summary.train // 0')"
val_count="$(echo "${split_resp}" | jq -r '.data.split_summary.val // 0')"
if [[ "${train_count}" -lt 1 || "${val_count}" -lt 1 ]]; then
  echo "[smoke-vision-task-closure] dataset split did not produce both train and validation items."
  echo "${split_resp}"
  exit 1
fi

version_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/versions" \
  -d '{"version_name":"vision-task-smoke-v1"}')"
dataset_version_id="$(echo "${version_resp}" | jq -r '.data.id // empty')"
version_train_count="$(echo "${version_resp}" | jq -r '.data.split_summary.train // 0')"
version_annotation_coverage="$(echo "${version_resp}" | jq -r '.data.annotation_coverage // 0')"
if [[ -z "${dataset_version_id}" || "${version_train_count}" -lt 1 || "${version_annotation_coverage}" == "0" || "${version_annotation_coverage}" == "0.0" ]]; then
  echo "[smoke-vision-task-closure] dataset version did not satisfy training readiness gates."
  echo "${version_resp}"
  exit 1
fi

ready_understand_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/vision/tasks/understand" \
  -d "$(jq -nc \
    --arg prompt "Train a detection model for the target object shown in this sample image." \
    --arg attachment_id "${sample_attachment_id}" \
    --arg dataset_id "${dataset_id}" \
    --arg dataset_version_id "${dataset_version_id}" \
    '{prompt:$prompt, attachment_ids:[$attachment_id], dataset_id:$dataset_id, dataset_version_id:$dataset_version_id}')")"
ready_task_id="$(echo "${ready_understand_resp}" | jq -r '.data.task.id // empty')"
ready_task_status="$(echo "${ready_understand_resp}" | jq -r '.data.task.status // empty')"
ready_task_can_start="$(echo "${ready_understand_resp}" | jq -r '.data.can_start_training // false')"
ready_task_missing_count="$(echo "${ready_understand_resp}" | jq -r '(.data.task.missing_requirements | length) // 0')"
if [[ -z "${ready_task_id}" || "${ready_task_status}" != "plan_ready" || "${ready_task_can_start}" != "true" || "${ready_task_missing_count}" -ne 0 ]]; then
  echo "[smoke-vision-task-closure] ready understand response did not match contract."
  echo "${ready_understand_resp}"
  exit 1
fi

auto_continue_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/vision/tasks/${ready_task_id}/auto-continue" \
  -d "$(jq -nc --argjson max_rounds "${VISION_TASK_SMOKE_MAX_ROUNDS}" '{max_rounds:$max_rounds}')")"
launched="$(echo "${auto_continue_resp}" | jq -r '.data.launched // false')"
continue_reason="$(echo "${auto_continue_resp}" | jq -r '.data.reason // empty')"
training_job_id="$(echo "${auto_continue_resp}" | jq -r '.data.training_job_id // empty')"
if [[ "${launched}" != "true" || "${continue_reason}" != "round_started" || -z "${training_job_id}" ]]; then
  echo "[smoke-vision-task-closure] auto-continue failed to launch training."
  echo "${auto_continue_resp}"
  exit 1
fi

wait_training_job_status "${training_job_id}" "completed"
job_detail_resp="${WAIT_JOB_PAYLOAD}"
job_execution_mode="$(echo "${job_detail_resp}" | jq -r '.data.job.execution_mode // empty')"
job_artifact_mode="$(echo "${job_detail_resp}" | jq -r '.data.artifact_summary.mode // empty')"
if [[ "${job_execution_mode}" != "local_command" ]]; then
  echo "[smoke-vision-task-closure] training job did not use local_command execution."
  echo "${job_detail_resp}"
  exit 1
fi
if [[ -z "${job_artifact_mode}" ]]; then
  echo "[smoke-vision-task-closure] training job artifact summary is missing."
  echo "${job_detail_resp}"
  exit 1
fi

wait_vision_task_status "${ready_task_id}" "training_completed"
ready_task_detail_resp="${WAIT_TASK_PAYLOAD}"
ready_pass_status="$(echo "${ready_task_detail_resp}" | jq -r '.data.validation_report.summary.pass_status // empty')"
if [[ "${ready_pass_status}" != "pass" ]]; then
  echo "[smoke-vision-task-closure] vision task validation report did not pass."
  echo "${ready_task_detail_resp}"
  exit 1
fi

register_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/vision/tasks/${ready_task_id}/register-model" \
  -d "$(jq -nc --arg version_name "vision-task-smoke-${run_tag}" '{version_name:$version_name}')")"
model_version_id="$(echo "${register_resp}" | jq -r '.data.model_version.id // empty')"
registered_task_model_version_id="$(echo "${register_resp}" | jq -r '.data.task.model_version_id // empty')"
if [[ -z "${model_version_id}" || "${registered_task_model_version_id}" != "${model_version_id}" ]]; then
  echo "[smoke-vision-task-closure] register-model response is missing model version linkage."
  echo "${register_resp}"
  exit 1
fi

inference_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -F "file=@${SAMPLE_IMAGE_FILE};type=image/png;filename=vision-task-inference-sample.png" \
  "${BASE_URL}/api/files/inference/upload")"
inference_attachment_id="$(echo "${inference_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${inference_attachment_id}" ]]; then
  echo "[smoke-vision-task-closure] failed to upload inference sample."
  echo "${inference_upload_resp}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/inference" "${inference_attachment_id}" "inference sample"

inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "$(jq -nc \
    --arg model_version_id "${model_version_id}" \
    --arg input_attachment_id "${inference_attachment_id}" \
    '{model_version_id:$model_version_id,input_attachment_id:$input_attachment_id,task_type:"detection"}')")"
inference_run_id="$(echo "${inference_resp}" | jq -r '.data.id // empty')"
inference_status="$(echo "${inference_resp}" | jq -r '.data.status // empty')"
if [[ -z "${inference_run_id}" || "${inference_status}" != "completed" ]]; then
  echo "[smoke-vision-task-closure] inference run did not complete."
  echo "${inference_resp}"
  exit 1
fi

feedback_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/vision/tasks/${ready_task_id}/feedback-dataset" \
  -d '{"max_samples":5}')"
feedback_dataset_id="$(echo "${feedback_resp}" | jq -r '.data.dataset_id // empty')"
feedback_sample_count="$(echo "${feedback_resp}" | jq -r '.data.sample_count // 0')"
feedback_selected_run_count="$(echo "${feedback_resp}" | jq -r '[.data.selected_run_ids[]? | select(. == "'"${inference_run_id}"'")] | length')"
if [[ -z "${feedback_dataset_id}" || "${feedback_sample_count}" -lt 1 || "${feedback_selected_run_count}" -lt 1 ]]; then
  echo "[smoke-vision-task-closure] feedback-dataset response did not capture the linked inference run."
  echo "${feedback_resp}"
  exit 1
fi

feedback_dataset_detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${feedback_dataset_id}")"
feedback_trace_count="$(echo "${feedback_dataset_detail_resp}" | jq -r '[.data.items[] | select((.metadata.inference_run_id // "") == "'"${inference_run_id}"'")] | length')"
feedback_reason="$(echo "${feedback_dataset_detail_resp}" | jq -r '.data.items[] | select((.metadata.inference_run_id // "") == "'"${inference_run_id}"'") | .metadata.feedback_reason // empty' | head -n 1)"
if [[ "${feedback_trace_count}" -lt 1 || "${feedback_reason}" != "auto_badcase_low_confidence" ]]; then
  echo "[smoke-vision-task-closure] feedback dataset traceability check failed."
  echo "${feedback_dataset_detail_resp}"
  exit 1
fi

final_auto_advance_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/vision/tasks/${ready_task_id}/auto-advance" \
  -d '{"max_rounds":3}')"
final_action="$(echo "${final_auto_advance_resp}" | jq -r '.data.action // empty')"
final_feedback_dataset_id="$(echo "${final_auto_advance_resp}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${final_action}" != "completed" || "${final_feedback_dataset_id}" != "${feedback_dataset_id}" ]]; then
  echo "[smoke-vision-task-closure] final auto-advance did not report completed closure state."
  echo "${final_auto_advance_resp}"
  exit 1
fi

echo "[smoke-vision-task-closure] PASS"
echo "missing_task_id=${missing_task_id}"
echo "ready_task_id=${ready_task_id}"
echo "training_job_id=${training_job_id}"
echo "training_execution_mode=${job_execution_mode}"
echo "training_artifact_mode=${job_artifact_mode}"
echo "model_version_id=${model_version_id}"
echo "inference_run_id=${inference_run_id}"
echo "feedback_dataset_id=${feedback_dataset_id}"
