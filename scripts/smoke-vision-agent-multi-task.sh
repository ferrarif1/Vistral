#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-vision-agent-multi-task] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-vision-agent-multi-task] python3 is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-alice}"
AUTH_PASSWORD="${AUTH_PASSWORD:-mock-pass}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-mock-pass-admin}"

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
API_PORT="${API_PORT:-8831}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
SAMPLE_IMAGE_FILE="$(mktemp "${TMPDIR:-/tmp}/vision-agent-multi-task.XXXXXX.png")"
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

python3 - "${SAMPLE_IMAGE_FILE}" <<'PY'
import base64
import pathlib
import sys

payload = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZlN8AAAAASUVORK5CYII="
)
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(payload))
PY

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
      echo "[smoke-vision-agent-multi-task] attachment ${attachment_id} entered error."
      echo "${resp}"
      exit 1
    fi
    sleep 0.2
  done
  echo "[smoke-vision-agent-multi-task] attachment ${attachment_id} did not become ready."
  echo "${resp}"
  exit 1
}

wait_training_job_status() {
  local job_id="$1"
  local expected_csv="$2"
  local resp=""
  local status=""

  for _ in $(seq 1 220); do
    resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
    status="$(echo "${resp}" | jq -r '.data.job.status // empty')"
    if [[ ",${expected_csv}," == *",${status},"* ]]; then
      echo "${resp}"
      return 0
    fi
    if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
      echo "[smoke-vision-agent-multi-task] training job ${job_id} entered ${status}." >&2
      echo "${resp}" >&2
      exit 1
    fi
    sleep 0.25
  done

  echo "[smoke-vision-agent-multi-task] training job ${job_id} did not reach ${expected_csv}." >&2
  echo "${resp}" >&2
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
    echo "[smoke-vision-agent-multi-task] dataset upload failed."
    echo "${upload_resp}"
    exit 1
  fi
  wait_attachment_ready "${BASE_URL}/api/files/dataset/${dataset_id}" "${attachment_id}"
  echo "${attachment_id}"
}

annotation_payload_for_task() {
  local task_type="$1"
  case "${task_type}" in
    ocr)
      jq -nc '{text:"AB-1234",transcription:"AB-1234"}'
      ;;
    detection)
      jq -nc '{boxes:[{id:"box-1",x:0,y:0,width:1,height:1,label:"target"}],polygons:[]}'
      ;;
    classification)
      jq -nc '{labels:["target"],label:"target"}'
      ;;
    segmentation)
      jq -nc '{polygons:[{id:"poly-1",label:"target",points:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]}]}'
      ;;
    obb)
      jq -nc '{boxes:[{id:"obb-1",x:0,y:0,width:1,height:1,angle:15,label:"target"}],rotated_boxes:[{id:"obb-1",cx:0.5,cy:0.5,width:1,height:1,angle:15,label:"target"}]}'
      ;;
    *)
      echo "[smoke-vision-agent-multi-task] unsupported task_type=${task_type}" >&2
      exit 1
      ;;
  esac
}

prepare_dataset_version() {
  local task_type="$1"
  local run_tag="$2"
  local dataset_resp=""
  local classes_json='["target"]'
  if [[ "${task_type}" == "ocr" ]]; then
    classes_json='[]'
  fi
  dataset_resp="$(post_json "/api/datasets" "$(jq -nc \
    --arg name "vision-agent-${task_type}-${run_tag}" \
    --arg task_type "${task_type}" \
    --argjson classes "${classes_json}" \
    '{name:$name,description:"vision agent multi-task smoke dataset",task_type:$task_type,label_schema:{classes:$classes}}')")"
  local dataset_id
  dataset_id="$(echo "${dataset_resp}" | jq -r '.data.id // empty')"
  if [[ -z "${dataset_id}" ]]; then
    echo "[smoke-vision-agent-multi-task] failed to create dataset for ${task_type}."
    echo "${dataset_resp}"
    exit 1
  fi

  local attachment_1 attachment_2
  attachment_1="$(upload_dataset_image "${dataset_id}" "${task_type}-sample-1.png")"
  attachment_2="$(upload_dataset_image "${dataset_id}" "${task_type}-sample-2.png")"

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
    echo "[smoke-vision-agent-multi-task] expected two dataset items for ${task_type}."
    echo "${detail_resp}"
    exit 1
  fi

  while IFS= read -r item_id; do
    [[ -n "${item_id}" ]] || continue
    local payload annotation_resp annotation_status
    payload="$(annotation_payload_for_task "${task_type}")"
    annotation_resp="$(post_json "/api/datasets/${dataset_id}/annotations" "$(jq -nc \
      --arg item_id "${item_id}" \
      --arg task_type "${task_type}" \
      --argjson payload "${payload}" \
      '{dataset_item_id:$item_id,task_type:$task_type,source:"manual",status:"annotated",payload:$payload}')")"
    annotation_status="$(echo "${annotation_resp}" | jq -r '.data.status // empty')"
    if [[ "${annotation_status}" != "annotated" ]]; then
      echo "[smoke-vision-agent-multi-task] failed to annotate ${task_type} item."
      echo "${annotation_resp}"
      exit 1
    fi
  done <<< "${item_ids}"

  local split_resp train_count val_count
  split_resp="$(post_json "/api/datasets/${dataset_id}/split" '{"train_ratio":0.5,"val_ratio":0.5,"test_ratio":0,"seed":17}')"
  train_count="$(echo "${split_resp}" | jq -r '.data.split_summary.train // 0')"
  val_count="$(echo "${split_resp}" | jq -r '.data.split_summary.val // 0')"
  if [[ "${train_count}" -lt 1 || "${val_count}" -lt 1 ]]; then
    echo "[smoke-vision-agent-multi-task] split failed for ${task_type}."
    echo "${split_resp}"
    exit 1
  fi

  local version_resp version_id coverage
  version_resp="$(post_json "/api/datasets/${dataset_id}/versions" "$(jq -nc --arg version_name "vision-agent-${task_type}-v1" '{version_name:$version_name}')")"
  version_id="$(echo "${version_resp}" | jq -r '.data.id // empty')"
  coverage="$(echo "${version_resp}" | jq -r '.data.annotation_coverage // 0')"
  if [[ -z "${version_id}" || "${coverage}" == "0" || "${coverage}" == "0.0" ]]; then
    echo "[smoke-vision-agent-multi-task] dataset version was not trainable for ${task_type}."
    echo "${version_resp}"
    exit 1
  fi

  jq -nc --arg dataset_id "${dataset_id}" --arg version_id "${version_id}" --arg attachment_id "${attachment_1}" \
    '{dataset_id:$dataset_id,version_id:$version_id,attachment_id:$attachment_id}'
}

assert_agent_plan_and_train() {
  local task_type="$1"
  local prompt="$2"
  local expected_recipe="$3"
  local expected_metric="$4"
  local expected_direction="$5"
  local context_json="$6"
  local dataset_id version_id attachment_id understand_resp task_id task_status can_start recipe_id recipe_version params_count readiness_summary
  dataset_id="$(echo "${context_json}" | jq -r '.dataset_id')"
  version_id="$(echo "${context_json}" | jq -r '.version_id')"
  attachment_id="$(echo "${context_json}" | jq -r '.attachment_id')"
  understand_resp="$(post_json "/api/vision/tasks/understand" "$(jq -nc \
    --arg prompt "${prompt}" \
    --arg attachment_id "${attachment_id}" \
    --arg dataset_id "${dataset_id}" \
    --arg version_id "${version_id}" \
      '{prompt:$prompt,attachment_ids:[$attachment_id],dataset_id:$dataset_id,dataset_version_id:$version_id}')")"
  task_id="$(echo "${understand_resp}" | jq -r '.data.task.id // empty')"
  task_status="$(echo "${understand_resp}" | jq -r '.data.task.status // empty')"
  can_start="$(echo "${understand_resp}" | jq -r '.data.can_start_training // false')"
  recipe_id="$(echo "${understand_resp}" | jq -r '.data.task.training_plan.recipe_id // empty')"
  recipe_version="$(echo "${understand_resp}" | jq -r '.data.task.training_plan.recipe_version // empty')"
  params_count="$(echo "${understand_resp}" | jq -r '(.data.task.training_plan.param_contract | length) // 0')"
  readiness_summary="$(echo "${understand_resp}" | jq -r '.data.task.training_plan.readiness_summary // empty')"
  if [[ -z "${task_id}" || "${task_status}" != "plan_ready" || "${can_start}" != "true" || "${recipe_id}" != "${expected_recipe}" || -z "${recipe_version}" || "${params_count}" -lt 1 || -z "${readiness_summary}" ]]; then
    echo "[smoke-vision-agent-multi-task] agent plan failed for ${task_type}."
    echo "${understand_resp}"
    exit 1
  fi
  echo "[smoke-vision-agent-multi-task] ${task_type} plan -> ${recipe_id}@${recipe_version}"

  local auto_continue_resp launched reason training_job_id
  auto_continue_resp="$(post_json "/api/vision/tasks/${task_id}/auto-continue" '{"max_rounds":1}')"
  launched="$(echo "${auto_continue_resp}" | jq -r '.data.launched // false')"
  reason="$(echo "${auto_continue_resp}" | jq -r '.data.reason // empty')"
  training_job_id="$(echo "${auto_continue_resp}" | jq -r '.data.training_job_id // empty')"
  if [[ "${launched}" != "true" || "${reason}" != "round_started" || -z "${training_job_id}" ]]; then
    echo "[smoke-vision-agent-multi-task] auto-continue did not launch for ${task_type}."
    echo "${auto_continue_resp}"
    exit 1
  fi

  local job_detail_resp job_recipe_id job_recipe_version job_dataset_version_id readiness_status resolved_params_count execution_mode artifact_mode
  job_detail_resp="$(wait_training_job_status "${training_job_id}" "completed")"
  job_recipe_id="$(echo "${job_detail_resp}" | jq -r '.data.job.config.recipe_id // empty')"
  job_recipe_version="$(echo "${job_detail_resp}" | jq -r '.data.job.config.recipe_version // empty')"
  job_dataset_version_id="$(echo "${job_detail_resp}" | jq -r '.data.job.dataset_version_id // empty')"
  readiness_status="$(echo "${job_detail_resp}" | jq -r '(.data.job.config.readiness_snapshot // "{}" | fromjson? | .status) // empty')"
  resolved_params_count="$(echo "${job_detail_resp}" | jq -r '(.data.job.config.resolved_params // "{}" | fromjson? | length) // 0')"
  execution_mode="$(echo "${job_detail_resp}" | jq -r '.data.job.execution_mode // empty')"
  artifact_mode="$(echo "${job_detail_resp}" | jq -r '.data.artifact_summary.mode // empty')"
  if [[ "${job_recipe_id}" != "${expected_recipe}" || -z "${job_recipe_version}" || "${job_dataset_version_id}" != "${version_id}" || -z "${readiness_status}" || "${readiness_status}" == "blocked" || "${resolved_params_count}" -lt 1 || -z "${execution_mode}" || -z "${artifact_mode}" ]]; then
    echo "[smoke-vision-agent-multi-task] training job evidence failed for ${task_type}."
    echo "${job_detail_resp}"
    exit 1
  fi

  local task_detail_resp task_job_id auto_log_count evidence_ref_count suite_metric suite_direction gate_status gate_reason comparison_decision comparison_candidates next_action
  task_detail_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/vision/tasks/${task_id}")"
  task_job_id="$(echo "${task_detail_resp}" | jq -r '.data.training_job_id // empty')"
  auto_log_count="$(echo "${task_detail_resp}" | jq -r '[.data.agent_decision_log[]? | select(.action == "start_training" and .outcome == "executed" and .source_layer == "auto_advance")] | length')"
  evidence_ref_count="$(echo "${task_detail_resp}" | jq -r --arg job_id "training_job:${training_job_id}" '[.data.agent_decision_log[]?.evidence_refs[]? | select(. == $job_id)] | length')"
  suite_metric="$(echo "${task_detail_resp}" | jq -r '.data.evaluation_suite.primary_metric // empty')"
  suite_direction="$(echo "${task_detail_resp}" | jq -r '.data.evaluation_suite.direction // empty')"
  gate_status="$(echo "${task_detail_resp}" | jq -r '.data.promotion_gate.status // empty')"
  gate_reason="$(echo "${task_detail_resp}" | jq -r '.data.promotion_gate.reason // empty')"
  comparison_decision="$(echo "${task_detail_resp}" | jq -r '.data.run_comparison.decision // empty')"
  comparison_candidates="$(echo "${task_detail_resp}" | jq -r '(.data.run_comparison.candidates | length) // 0')"
  next_action="$(echo "${task_detail_resp}" | jq -r '.data.agent_next_action.action // empty')"
  if [[ "${task_job_id}" != "${training_job_id}" || "${auto_log_count}" -lt 1 || "${evidence_ref_count}" -lt 1 || "${suite_metric}" != "${expected_metric}" || "${suite_direction}" != "${expected_direction}" || -z "${gate_status}" || -z "${comparison_decision}" || "${comparison_candidates}" -lt 1 || -z "${next_action}" ]]; then
    echo "[smoke-vision-agent-multi-task] vision task audit evidence failed for ${task_type}."
    echo "${task_detail_resp}"
    exit 1
  fi
  if [[ "${artifact_mode}" == "template" && ( "${gate_status}" == "pass" || "${next_action}" == "register_model" ) ]]; then
    echo "[smoke-vision-agent-multi-task] template artifact must not be treated as registerable for ${task_type}."
    echo "${task_detail_resp}"
    exit 1
  fi
  if [[ "${artifact_mode}" == "template" && "${gate_reason}" == *"artifact"* && "${next_action}" != "fix_runtime" ]]; then
    echo "[smoke-vision-agent-multi-task] template artifact blocker must recommend fix_runtime for ${task_type}."
    echo "${task_detail_resp}"
    exit 1
  fi

  local delivery_resp delivery_action delivery_model_version_id delivery_gate_status delivery_training_job_id
  delivery_resp="$(post_json "/api/vision/tasks/${task_id}/auto-advance" '{"max_rounds":1,"deliver_model":true,"wait_timeout_ms":5000,"wait_poll_ms":200}')"
  delivery_action="$(echo "${delivery_resp}" | jq -r '.data.action // empty')"
  delivery_model_version_id="$(echo "${delivery_resp}" | jq -r '.data.model_version_id // empty')"
  delivery_gate_status="$(echo "${delivery_resp}" | jq -r '.data.task.promotion_gate.status // empty')"
  delivery_training_job_id="$(echo "${delivery_resp}" | jq -r '.data.training_job_id // empty')"
  if [[ "${artifact_mode}" == "template" && ( "${delivery_action}" == "registered" || -n "${delivery_model_version_id}" || "${delivery_gate_status}" == "pass" ) ]]; then
    echo "[smoke-vision-agent-multi-task] delivery mode must stop before registering template artifacts for ${task_type}."
    echo "${delivery_resp}"
    exit 1
  fi
  if [[ "${artifact_mode}" == "template" && "${gate_reason}" == *"artifact"* && ( "${delivery_action}" != "fix_runtime" || "${delivery_training_job_id}" != "${training_job_id}" ) ]]; then
    echo "[smoke-vision-agent-multi-task] delivery mode must stop at fix_runtime without launching another template round for ${task_type}."
    echo "${delivery_resp}"
    exit 1
  fi

  echo "[smoke-vision-agent-multi-task] ${task_type} trained -> ${training_job_id} (${execution_mode}/${artifact_mode}, ${suite_metric}/${suite_direction}, gate=${gate_status}, next=${next_action})"
}

if [[ "${START_API}" == "true" ]]; then
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  MODEL_EXPORT_ROOT="${APP_DATA_DIR}/model-exports" \
  VISTRAL_RUNNER_ENABLE_REAL="${VISTRAL_RUNNER_ENABLE_REAL:-0}" \
  VISTRAL_DISABLE_INFERENCE_FALLBACK="${VISTRAL_DISABLE_INFERENCE_FALLBACK:-0}" \
  MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND="${MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND:-0}" \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  echo "[smoke-vision-agent-multi-task] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

csrf_token="$(get_csrf_token)"
login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "$(jq -nc --arg username "${AUTH_USERNAME}" --arg password "${AUTH_PASSWORD}" '{username:$username,password:$password}')")"
if [[ "$(echo "${login_resp}" | jq -r '.success // false')" != "true" ]]; then
  echo "[smoke-vision-agent-multi-task] login failed."
  echo "${login_resp}"
  exit 1
fi
csrf_token="$(get_csrf_token)"

if [[ "${START_API}" == "true" ]]; then
  csrf_token="$(get_csrf_token)"
  admin_login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "$(jq -nc --arg username "${ADMIN_USERNAME}" --arg password "${ADMIN_PASSWORD}" '{username:$username,password:$password}')")"
  if [[ "$(echo "${admin_login_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-vision-agent-multi-task] admin login failed for runtime readiness check."
    echo "${admin_login_resp}"
    exit 1
  fi
  csrf_token="$(get_csrf_token)"
  runtime_readiness_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/runtime/readiness")"
  agent_delivery_status="$(echo "${runtime_readiness_resp}" | jq -r '.data.agent_delivery.status // empty')"
  agent_delivery_action="$(echo "${runtime_readiness_resp}" | jq -r '.data.agent_delivery.recommended_action // empty')"
  agent_delivery_doctor_command_count="$(echo "${runtime_readiness_resp}" | jq -r '[.data.agent_delivery.commands[]? | select(. == "npm run doctor:real-training-readiness")] | length')"
  real_training_doctor_status="$(echo "${runtime_readiness_resp}" | jq -r '.data.real_training_doctor.status // empty')"
  real_training_doctor_command_count="$(echo "${runtime_readiness_resp}" | jq -r '[.data.real_training_doctor.commands[]? | select(. == "npm run doctor:real-training-readiness")] | length')"
  if [[ "${agent_delivery_status}" != "blocked" || "${agent_delivery_action}" != "enable_real_runner" || "${agent_delivery_doctor_command_count}" -lt 1 || -z "${real_training_doctor_status}" || "${real_training_doctor_command_count}" -lt 1 ]]; then
    echo "[smoke-vision-agent-multi-task] runtime readiness must expose blocked agent_delivery when real runner is disabled."
    echo "${runtime_readiness_resp}"
    exit 1
  fi

  prepare_resp="$(post_json "/api/settings/runtime/prepare-real-training" '{"overwrite_endpoint":false}')"
  prepare_success="$(echo "${prepare_resp}" | jq -r '.success // false')"
  prepare_train_guard="$(echo "${prepare_resp}" | jq -r '.data.settings.controls.disable_simulated_train_fallback // empty')"
  prepare_infer_guard="$(echo "${prepare_resp}" | jq -r '.data.settings.controls.disable_inference_fallback // empty')"
  prepare_readiness_doctor="$(echo "${prepare_resp}" | jq -r '.data.readiness.real_training_doctor.status // empty')"
  prepare_command_count="$(echo "${prepare_resp}" | jq -r '[.data.commands[]? | select(. == "npm run doctor:real-training-readiness")] | length')"
  if [[ "${prepare_success}" != "true" || "${prepare_train_guard}" != "true" || "${prepare_infer_guard}" != "true" || -z "${prepare_readiness_doctor}" || "${prepare_command_count}" -lt 1 ]]; then
    echo "[smoke-vision-agent-multi-task] prepare-real-training must save strict guards and return readiness commands."
    echo "${prepare_resp}"
    exit 1
  fi

  csrf_token="$(get_csrf_token)"
  login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H 'Content-Type: application/json' \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "$(jq -nc --arg username "${AUTH_USERNAME}" --arg password "${AUTH_PASSWORD}" '{username:$username,password:$password}')")"
  if [[ "$(echo "${login_resp}" | jq -r '.success // false')" != "true" ]]; then
    echo "[smoke-vision-agent-multi-task] login failed after admin runtime readiness check."
    echo "${login_resp}"
    exit 1
  fi
  csrf_token="$(get_csrf_token)"
fi

recipe_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/recipes")"
for recipe_id in yolo-detection-default paddleocr-ocr-default yolo-classification-default yolo-segmentation-default yolo-obb-default; do
  if [[ "$(echo "${recipe_resp}" | jq -r --arg id "${recipe_id}" '[.data[] | select(.recipe_id == $id)] | length')" -lt 1 ]]; then
    echo "[smoke-vision-agent-multi-task] missing recipe ${recipe_id}."
    echo "${recipe_resp}"
    exit 1
  fi
done

run_tag="$(date +%s)"
ocr_ctx="$(prepare_dataset_version "ocr" "${run_tag}")"
detection_ctx="$(prepare_dataset_version "detection" "${run_tag}")"
classification_ctx="$(prepare_dataset_version "classification" "${run_tag}")"
segmentation_ctx="$(prepare_dataset_version "segmentation" "${run_tag}")"
obb_ctx="$(prepare_dataset_version "obb" "${run_tag}")"

assert_agent_plan_and_train "ocr" "Train an OCR model to read serial text AB-1234." "paddleocr-ocr-default" "cer" "lower_is_better" "${ocr_ctx}"
assert_agent_plan_and_train "detection" "Train a detection model to find the target object." "yolo-detection-default" "map" "higher_is_better" "${detection_ctx}"
assert_agent_plan_and_train "classification" "Train a classification model to classify the target state." "yolo-classification-default" "accuracy" "higher_is_better" "${classification_ctx}"
assert_agent_plan_and_train "segmentation" "Train a segmentation model to segment the target mask." "yolo-segmentation-default" "miou" "higher_is_better" "${segmentation_ctx}"
assert_agent_plan_and_train "obb" "Train an OBB rotated box model with oriented boxes for the target." "yolo-obb-default" "map_obb" "higher_is_better" "${obb_ctx}"

echo "[smoke-vision-agent-multi-task] PASS"
