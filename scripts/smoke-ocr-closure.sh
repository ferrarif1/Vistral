#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-}"
AUTH_PASSWORD="${AUTH_PASSWORD:-}"
OCR_CLOSURE_STRICT_LOCAL_COMMAND="${OCR_CLOSURE_STRICT_LOCAL_COMMAND:-true}"
OCR_CLOSURE_REQUIRE_REAL_MODE="${OCR_CLOSURE_REQUIRE_REAL_MODE:-${OCR_CLOSURE_STRICT_LOCAL_COMMAND}}"
OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION="${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION:-false}"
OCR_CLOSURE_ALLOW_NON_REAL_LOCAL_COMMAND="${OCR_CLOSURE_ALLOW_NON_REAL_LOCAL_COMMAND:-false}"
OCR_CLOSURE_GENERATE_TEXT_SAMPLE="${OCR_CLOSURE_GENERATE_TEXT_SAMPLE:-true}"
DEMO_DIR="${DEMO_DIR:-${ROOT_DIR}/demo_data}"
DEFAULT_VENV_PYTHON="${ROOT_DIR}/.data/runtime-python/.venv/bin/python"
if [[ -x "${DEFAULT_VENV_PYTHON}" ]]; then
  PYTHON_BIN="${PYTHON_BIN:-${DEFAULT_VENV_PYTHON}}"
else
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-ocr-closure] jq is required."
  exit 1
fi

RUNNER_ENABLE_REAL_VALUE="${VISTRAL_RUNNER_ENABLE_REAL:-0}"
if [[ "${OCR_CLOSURE_REQUIRE_REAL_MODE}" == "true" ]]; then
  RUNNER_ENABLE_REAL_VALUE="1"
fi
ALLOW_NON_REAL_LOCAL_COMMAND_VALUE="${MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND:-0}"
if [[ "${OCR_CLOSURE_ALLOW_NON_REAL_LOCAL_COMMAND}" == "true" ]]; then
  ALLOW_NON_REAL_LOCAL_COMMAND_VALUE="1"
fi
VISTRAL_DISABLE_INFERENCE_FALLBACK_VALUE="${VISTRAL_DISABLE_INFERENCE_FALLBACK:-}"
if [[ -z "${VISTRAL_DISABLE_INFERENCE_FALLBACK_VALUE}" ]]; then
  if [[ "${OCR_CLOSURE_REQUIRE_REAL_MODE}" == "true" ]]; then
    VISTRAL_DISABLE_INFERENCE_FALLBACK_VALUE="1"
  else
    VISTRAL_DISABLE_INFERENCE_FALLBACK_VALUE="0"
  fi
fi

if [[ "${OCR_CLOSURE_REQUIRE_REAL_MODE}" == "true" ]]; then
  OCR_CLOSURE_WAIT_POLLS="${OCR_CLOSURE_WAIT_POLLS:-720}"
else
  # Non-real-mode local OCR runners can still take several minutes on loaded hosts.
  # Keep defaults resilient for docker:verify:full to avoid flaky timeouts.
  OCR_CLOSURE_WAIT_POLLS="${OCR_CLOSURE_WAIT_POLLS:-2400}"
fi
OCR_CLOSURE_WAIT_SLEEP_SEC="${OCR_CLOSURE_WAIT_SLEEP_SEC:-0.25}"

if ! "${PYTHON_BIN}" -V >/dev/null 2>&1; then
  echo "[smoke-ocr-closure] python runtime is required. missing PYTHON_BIN=${PYTHON_BIN}"
  exit 1
fi

if [[ "${START_API}" == "true" && -z "${API_PORT:-}" ]]; then
  API_PORT="$(
    "${PYTHON_BIN}" - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
  )"
fi
API_PORT="${API_PORT:-8801}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
TMP_OCR_IMPORT="$(mktemp)"
TMP_INFERENCE_FILE="$(mktemp)"
TMP_SYNTH_IMAGE=""
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${TMP_OCR_IMPORT}" "${TMP_INFERENCE_FILE}" "${TMP_SYNTH_IMAGE:-}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

wait_for_health() {
  for _ in {1..100}; do
    if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  return 1
}

wait_attachment_ready() {
  local list_url="$1"
  local attachment_id="$2"
  local label="$3"
  local list_resp=""
  local attachment_status=""

  for _ in {1..120}; do
    list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${list_url}")"
    attachment_status="$(echo "${list_resp}" | jq -r --arg id "${attachment_id}" '.data[] | select(.id==$id) | .status // empty')"

    if [[ "${attachment_status}" == "ready" ]]; then
      return 0
    fi

    if [[ "${attachment_status}" == "error" ]]; then
      echo "[smoke-ocr-closure] ${label} attachment entered error state."
      echo "${list_resp}"
      exit 1
    fi

    sleep 0.25
  done

  echo "[smoke-ocr-closure] ${label} attachment not ready in time."
  echo "${list_resp}"
  exit 1
}

wait_training_job_completed() {
  local job_id="$1"
  local label="$2"
  local job_detail=""
  local job_status=""

  for (( attempt=0; attempt<OCR_CLOSURE_WAIT_POLLS; attempt+=1 )); do
    job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
    job_status="$(echo "${job_detail}" | jq -r '.data.job.status // empty')"

    if [[ "${job_status}" == "completed" ]]; then
      printf '%s\n' "${job_detail}"
      return 0
    fi

    if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
      echo "[smoke-ocr-closure] ${label} training job ended with ${job_status}."
      echo "${job_detail}"
      exit 1
    fi

    sleep "${OCR_CLOSURE_WAIT_SLEEP_SEC}"
  done

  echo "[smoke-ocr-closure] ${label} training job timeout."
  echo "${job_detail}"
  exit 1
}

is_registration_gate_rejection() {
  local response="$1"
  local error_message=""
  error_message="$(echo "${response}" | jq -r '.error.message // empty')"
  [[ "${error_message}" == *"non-real local execution evidence"* || "${error_message}" == *"restricted local execution evidence"* || "${error_message}" == *"execution_mode=local_command"* ]]
}

pick_registered_model_version_id() {
  local task_type="$1"
  local framework_filter="${2:-}"
  local versions_resp=""

  versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions")"
  echo "${versions_resp}" | jq -r --arg task_type "${task_type}" --arg framework "${framework_filter}" '
    .data[] |
    select(.status=="registered" and .task_type==$task_type and ($framework=="" or .framework==$framework)) |
    .id
  ' | head -n 1
}

if [[ "${START_API}" == "true" ]]; then
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  PADDLEOCR_RUNTIME_ENDPOINT="" \
  DOCTR_RUNTIME_ENDPOINT="" \
  YOLO_RUNTIME_ENDPOINT="" \
  YOLO_LOCAL_TRAIN_COMMAND="${PYTHON_BIN} {{repo_root}}/scripts/local-runners/yolo_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}" \
  PADDLEOCR_LOCAL_TRAIN_COMMAND="${PYTHON_BIN} {{repo_root}}/scripts/local-runners/paddleocr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}" \
  DOCTR_LOCAL_TRAIN_COMMAND="${PYTHON_BIN} {{repo_root}}/scripts/local-runners/doctr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}" \
  PADDLEOCR_LOCAL_PREDICT_COMMAND="${PYTHON_BIN} {{repo_root}}/scripts/local-runners/paddleocr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}" \
  DOCTR_LOCAL_PREDICT_COMMAND="${PYTHON_BIN} {{repo_root}}/scripts/local-runners/doctr_predict_runner.py --model-id {{model_id}} --model-version-id {{model_version_id}} --task-type {{task_type}} --input-path {{input_path}} --filename {{filename}} --output-path {{output_path}}" \
  VISTRAL_PADDLEOCR_LANG="${VISTRAL_PADDLEOCR_LANG:-en}" \
  PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK="${PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK:-True}" \
  VISTRAL_RUNNER_ENABLE_REAL="${RUNNER_ENABLE_REAL_VALUE}" \
  VISTRAL_DISABLE_INFERENCE_FALLBACK="${VISTRAL_DISABLE_INFERENCE_FALLBACK_VALUE}" \
  LLM_CONFIG_SECRET="${LLM_CONFIG_SECRET:-smoke-ocr-closure-${API_PORT}}" \
  MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND="${ALLOW_NON_REAL_LOCAL_COMMAND_VALUE}" \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

if ! wait_for_health; then
  if [[ "${START_API}" == "true" ]]; then
    if ! kill -0 "${API_PID}" >/dev/null 2>&1; then
      echo "[smoke-ocr-closure] API process exited before health check (possible port conflict)."
      cat "${API_LOG}"
      exit 1
    fi
    echo "[smoke-ocr-closure] API failed to start."
    cat "${API_LOG}"
  else
    echo "[smoke-ocr-closure] API is unreachable at ${BASE_URL}."
  fi
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-ocr-closure] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

if [[ -n "${AUTH_USERNAME}" ]]; then
  if [[ -z "${AUTH_PASSWORD}" ]]; then
    echo "[smoke-ocr-closure] AUTH_PASSWORD is required when AUTH_USERNAME is set."
    exit 1
  fi

  login_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_success="$(echo "${login_response}" | jq -r '.success // false')"
  if [[ "${login_success}" != "true" ]]; then
    echo "[smoke-ocr-closure] login failed for AUTH_USERNAME=${AUTH_USERNAME}."
    echo "${login_response}"
    exit 1
  fi

  csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
  if [[ -z "${csrf_token}" ]]; then
    echo "[smoke-ocr-closure] failed to refresh CSRF token after login."
    echo "${csrf_response}"
    exit 1
  fi
fi

image_file="$(find "${DEMO_DIR}" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit 2>/dev/null || true)"
if [[ -z "${image_file}" ]]; then
  printf 'ocr closure fallback payload\n' >"${TMP_INFERENCE_FILE}"
  image_file="${TMP_INFERENCE_FILE}"
fi

ocr_line_1="VISTRAL OCR 1022"
ocr_line_2="TRAINING SAMPLE 08"
if [[ "${OCR_CLOSURE_GENERATE_TEXT_SAMPLE}" == "true" ]]; then
  synth_base="$(mktemp -t ocr-closure-image)"
  TMP_SYNTH_IMAGE="${synth_base}.png"
  mv "${synth_base}" "${TMP_SYNTH_IMAGE}"
  set +e
  "${PYTHON_BIN}" - "${TMP_SYNTH_IMAGE}" "${ocr_line_1}" "${ocr_line_2}" <<'PY'
import sys
from PIL import Image, ImageDraw, ImageFont

target = sys.argv[1]
line1 = sys.argv[2]
line2 = sys.argv[3]

image = Image.new('RGB', (1280, 720), color='white')
draw = ImageDraw.Draw(image)
try:
    font = ImageFont.truetype("DejaVuSans.ttf", 64)
except Exception:
    font = ImageFont.load_default()

draw.text((90, 180), line1, fill='black', font=font)
draw.text((90, 320), line2, fill='black', font=font)
image.save(target, format='PNG')
PY
  synth_code=$?
  set -e
  if [[ "${synth_code}" -eq 0 ]]; then
    image_file="${TMP_SYNTH_IMAGE}"
  fi
fi

dataset_payload="$(jq -nc \
  --arg name "ocr-closure-$(date +%s)" \
  --arg description "OCR closure smoke dataset" \
  '{name: $name, description: $description, task_type: "ocr", label_schema: {classes: ["text"]}}'
)"
dataset_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets" \
  -d "${dataset_payload}")"
dataset_id="$(echo "${dataset_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dataset_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create OCR dataset."
  echo "${dataset_resp}"
  exit 1
fi

dataset_image_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${dataset_id}/upload" \
  -F "file=@${image_file}")"
dataset_image_attachment_id="$(echo "${dataset_image_upload_resp}" | jq -r '.data.id // empty')"
dataset_image_filename="$(echo "${dataset_image_upload_resp}" | jq -r '.data.filename // empty')"
if [[ -z "${dataset_image_attachment_id}" || -z "${dataset_image_filename}" ]]; then
  echo "[smoke-ocr-closure] failed to upload OCR dataset image."
  echo "${dataset_image_upload_resp}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/dataset/${dataset_id}" "${dataset_image_attachment_id}" "dataset image"

printf "%s\t%s\t0.95\n%s\t%s\t0.91\n" \
  "${dataset_image_filename}" \
  "${ocr_line_1}" \
  "${dataset_image_filename}" \
  "${ocr_line_2}" >"${TMP_OCR_IMPORT}"

ocr_import_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/dataset/${dataset_id}/upload" \
  -F "file=@${TMP_OCR_IMPORT};filename=ocr-closure-import.txt;type=text/plain")"
ocr_import_attachment_id="$(echo "${ocr_import_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${ocr_import_attachment_id}" ]]; then
  echo "[smoke-ocr-closure] failed to upload OCR import file."
  echo "${ocr_import_upload_resp}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/dataset/${dataset_id}" "${ocr_import_attachment_id}" "ocr import"

ocr_import_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/import" \
  -d "{\"format\":\"ocr\",\"attachment_id\":\"${ocr_import_attachment_id}\"}")"
ocr_import_total="$(echo "${ocr_import_resp}" | jq -r '(.data.imported // 0) + (.data.updated // 0)')"
if [[ "${ocr_import_total}" -lt 1 ]]; then
  echo "[smoke-ocr-closure] OCR import did not modify annotations."
  echo "${ocr_import_resp}"
  exit 1
fi

annotations_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/datasets/${dataset_id}/annotations")"
annotation_line_total="$(echo "${annotations_resp}" | jq -r '[.data[] | (.payload.lines // []) | length] | add // 0')"
if [[ "${annotation_line_total}" -lt 2 ]]; then
  echo "[smoke-ocr-closure] expected imported OCR lines."
  echo "${annotations_resp}"
  exit 1
fi

split_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/split" \
  -d '{"train_ratio":0.8,"val_ratio":0.1,"test_ratio":0.1,"seed":24}')"
split_train_count="$(echo "${split_resp}" | jq -r '.data.split_summary.train // 0')"
if [[ "${split_train_count}" -lt 1 ]]; then
  echo "[smoke-ocr-closure] dataset split did not produce train items."
  echo "${split_resp}"
  exit 1
fi

dataset_version_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/${dataset_id}/versions" \
  -d '{"version_name":"ocr-closure-v1"}')"
dataset_version_id="$(echo "${dataset_version_resp}" | jq -r '.data.id // empty')"
if [[ -z "${dataset_version_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create OCR dataset version."
  echo "${dataset_version_resp}"
  exit 1
fi

paddle_model_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/models/draft" \
  -d '{"name":"ocr-closure-paddle-model","description":"OCR closure paddle model","model_type":"ocr","visibility":"workspace"}')"
paddle_model_id="$(echo "${paddle_model_resp}" | jq -r '.data.id // empty')"
if [[ -z "${paddle_model_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create PaddleOCR model draft."
  echo "${paddle_model_resp}"
  exit 1
fi

doctr_model_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/models/draft" \
  -d '{"name":"ocr-closure-doctr-model","description":"OCR closure docTR model","model_type":"ocr","visibility":"workspace"}')"
doctr_model_id="$(echo "${doctr_model_resp}" | jq -r '.data.id // empty')"
if [[ -z "${doctr_model_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create docTR model draft."
  echo "${doctr_model_resp}"
  exit 1
fi

paddle_train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"ocr-closure-paddle\",\"task_type\":\"ocr\",\"framework\":\"paddleocr\",\"dataset_id\":\"${dataset_id}\",\"dataset_version_id\":\"${dataset_version_id}\",\"base_model\":\"paddleocr-PP-OCRv4\",\"config\":{\"epochs\":\"4\",\"batch_size\":\"2\",\"learning_rate\":\"0.0007\"}}")"
paddle_job_id="$(echo "${paddle_train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${paddle_job_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create PaddleOCR training job."
  echo "${paddle_train_resp}"
  exit 1
fi

paddle_job_detail="$(wait_training_job_completed "${paddle_job_id}" "PaddleOCR")"
paddle_mode="$(echo "${paddle_job_detail}" | jq -r '.data.job.execution_mode // empty')"
paddle_accuracy="$(echo "${paddle_job_detail}" | jq -r '.data.metrics | map(select(.metric_name=="accuracy")) | sort_by(.step) | last | .metric_value // empty')"
paddle_accuracy_series="$(echo "${paddle_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="accuracy")] | length')"
paddle_metric_keys="$(echo "${paddle_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]?] | length')"
paddle_norm_edit_distance_series="$(echo "${paddle_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="norm_edit_distance")] | length')"
paddle_norm_edit_distance_key="$(echo "${paddle_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]? | select(.=="norm_edit_distance")] | length')"
paddle_artifact_mode="$(echo "${paddle_job_detail}" | jq -r '.data.artifact_summary.mode // empty')"
paddle_artifact_fallback_reason="$(echo "${paddle_job_detail}" | jq -r '.data.artifact_summary.fallback_reason // empty')"
paddle_artifact_training_performed="$(echo "${paddle_job_detail}" | jq -r '.data.artifact_summary.training_performed')"
if [[ "${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" == "true" ]]; then
  if [[ "${paddle_mode}" != "local_command" || -z "${paddle_accuracy}" || "${paddle_accuracy}" == "null" || "${paddle_accuracy_series}" -lt 3 || "${paddle_metric_keys}" -lt 1 || "${paddle_norm_edit_distance_series}" -lt 3 || "${paddle_norm_edit_distance_key}" -lt 1 ]]; then
    echo "[smoke-ocr-closure] PaddleOCR training assertions failed."
    echo "${paddle_job_detail}"
    exit 1
  fi
  if [[ "${OCR_CLOSURE_REQUIRE_REAL_MODE}" == "true" ]]; then
    if [[ "${paddle_artifact_mode}" == "template" || -n "${paddle_artifact_fallback_reason}" ]]; then
      echo "[smoke-ocr-closure] PaddleOCR require-real assertions failed: template/fallback evidence detected."
      echo "${paddle_job_detail}"
      exit 1
    fi
  fi
else
  if [[ ("${paddle_mode}" != "local_command" && "${paddle_mode}" != "simulated") || -z "${paddle_accuracy}" || "${paddle_accuracy}" == "null" || "${paddle_accuracy_series}" -lt 3 || "${paddle_metric_keys}" -lt 1 ]]; then
    echo "[smoke-ocr-closure] PaddleOCR training assertions failed (non-strict mode)."
    echo "${paddle_job_detail}"
    exit 1
  fi
fi
if [[ "${paddle_artifact_mode}" == "template" ]]; then
  if [[ -z "${paddle_artifact_fallback_reason}" || "${paddle_artifact_training_performed}" != "false" ]]; then
    echo "[smoke-ocr-closure] PaddleOCR template artifact summary must include fallback_reason and training_performed=false."
    echo "${paddle_job_detail}"
    exit 1
  fi
fi

paddle_register_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/model-versions/register" \
  -d "{\"model_id\":\"${paddle_model_id}\",\"training_job_id\":\"${paddle_job_id}\",\"version_name\":\"ocr-closure-paddle-v1\",\"require_pure_real_evidence\":${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}}")"
paddle_model_version_id="$(echo "${paddle_register_resp}" | jq -r '.data.id // empty')"
paddle_artifact_attachment_id="$(echo "${paddle_register_resp}" | jq -r '.data.artifact_attachment_id // empty')"
paddle_registration_evidence_mode="$(echo "${paddle_register_resp}" | jq -r '.data.registration_evidence_mode // empty')"
paddle_registration_gate_exempted="$(echo "${paddle_register_resp}" | jq -r 'if .data.registration_gate_exempted == true then "true" elif .data.registration_gate_exempted == false then "false" else "" end')"
paddle_register_mode="created"
if [[ -z "${paddle_model_version_id}" || -z "${paddle_artifact_attachment_id}" ]]; then
  if [[ "${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" == "true" || "$(is_registration_gate_rejection "${paddle_register_resp}" && echo true || echo false)" != "true" ]]; then
    echo "[smoke-ocr-closure] failed to register PaddleOCR model version."
    echo "${paddle_register_resp}"
    exit 1
  fi

  fallback_paddle_version_id="$(pick_registered_model_version_id "ocr" "paddleocr")"
  if [[ -z "${fallback_paddle_version_id}" ]]; then
    fallback_paddle_version_id="$(pick_registered_model_version_id "ocr" "")"
  fi
  if [[ -z "${fallback_paddle_version_id}" ]]; then
    echo "[smoke-ocr-closure] registration blocked by gate and no fallback OCR model version exists for PaddleOCR step."
    echo "${paddle_register_resp}"
    exit 1
  fi
  paddle_model_version_id="${fallback_paddle_version_id}"
  paddle_artifact_attachment_id="fallback-existing-version"
  paddle_register_mode="blocked_gate_reused_existing"
fi
if [[ "${paddle_register_mode}" == "created" && "${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" == "true" ]]; then
  if [[ "${paddle_registration_gate_exempted}" == "true" || "${paddle_registration_evidence_mode}" == "non_real_local_command" ]]; then
    echo "[smoke-ocr-closure] PaddleOCR registration should stay strict (no exemption / non-real evidence)."
    echo "${paddle_register_resp}"
    exit 1
  fi
  if [[ "${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}" == "true" && "${paddle_registration_evidence_mode}" != "real" ]]; then
    echo "[smoke-ocr-closure] PaddleOCR registration expected pure real evidence mode."
    echo "${paddle_register_resp}"
    exit 1
  fi
fi

doctr_train_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/training/jobs" \
  -d "{\"name\":\"ocr-closure-doctr\",\"task_type\":\"ocr\",\"framework\":\"doctr\",\"dataset_id\":\"${dataset_id}\",\"dataset_version_id\":\"${dataset_version_id}\",\"base_model\":\"doctr-db-resnet50\",\"config\":{\"epochs\":\"3\",\"batch_size\":\"2\",\"learning_rate\":\"0.0005\"}}")"
doctr_job_id="$(echo "${doctr_train_resp}" | jq -r '.data.id // empty')"
if [[ -z "${doctr_job_id}" ]]; then
  echo "[smoke-ocr-closure] failed to create docTR training job."
  echo "${doctr_train_resp}"
  exit 1
fi

doctr_job_detail="$(wait_training_job_completed "${doctr_job_id}" "docTR")"
doctr_mode="$(echo "${doctr_job_detail}" | jq -r '.data.job.execution_mode // empty')"
doctr_f1="$(echo "${doctr_job_detail}" | jq -r '.data.metrics | map(select(.metric_name=="f1")) | sort_by(.step) | last | .metric_value // empty')"
doctr_f1_series="$(echo "${doctr_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="f1")] | length')"
doctr_accuracy="$(echo "${doctr_job_detail}" | jq -r '.data.metrics | map(select(.metric_name=="accuracy")) | sort_by(.step) | last | .metric_value // empty')"
doctr_accuracy_series="$(echo "${doctr_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="accuracy")] | length')"
doctr_primary_metric_name="f1"
doctr_primary_metric_value="${doctr_f1}"
if [[ -z "${doctr_primary_metric_value}" || "${doctr_primary_metric_value}" == "null" ]]; then
  doctr_primary_metric_name="accuracy"
  doctr_primary_metric_value="${doctr_accuracy}"
fi
doctr_metric_keys="$(echo "${doctr_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]?] | length')"
doctr_norm_edit_distance_series="$(echo "${doctr_job_detail}" | jq -r '[.data.metrics[] | select(.metric_name=="norm_edit_distance")] | length')"
doctr_norm_edit_distance_key="$(echo "${doctr_job_detail}" | jq -r '[.data.artifact_summary.metrics_keys[]? | select(.=="norm_edit_distance")] | length')"
doctr_artifact_mode="$(echo "${doctr_job_detail}" | jq -r '.data.artifact_summary.mode // empty')"
doctr_artifact_fallback_reason="$(echo "${doctr_job_detail}" | jq -r '.data.artifact_summary.fallback_reason // empty')"
doctr_artifact_training_performed="$(echo "${doctr_job_detail}" | jq -r '.data.artifact_summary.training_performed')"
if [[ "${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" == "true" ]]; then
  if [[ "${doctr_mode}" != "local_command" || -z "${doctr_f1}" || "${doctr_f1}" == "null" || "${doctr_f1_series}" -lt 3 || "${doctr_metric_keys}" -lt 1 || "${doctr_norm_edit_distance_series}" -lt 3 || "${doctr_norm_edit_distance_key}" -lt 1 ]]; then
    echo "[smoke-ocr-closure] docTR training assertions failed."
    echo "${doctr_job_detail}"
    exit 1
  fi
  if [[ "${OCR_CLOSURE_REQUIRE_REAL_MODE}" == "true" ]]; then
    if [[ "${doctr_artifact_mode}" == "template" || -n "${doctr_artifact_fallback_reason}" ]]; then
      echo "[smoke-ocr-closure] docTR require-real assertions failed: template/fallback evidence detected."
      echo "${doctr_job_detail}"
      exit 1
    fi
    if [[ -z "${doctr_primary_metric_value}" || "${doctr_primary_metric_value}" == "null" ]]; then
      echo "[smoke-ocr-closure] docTR require-real assertions failed: primary metric is empty."
      echo "${doctr_job_detail}"
      exit 1
    fi
    doctr_primary_nonzero="$("${PYTHON_BIN}" -c 'import sys
try:
    value = float(sys.argv[1])
except Exception:
    value = 0.0
print(1 if value > 0 else 0)
' "${doctr_primary_metric_value}")"
    if [[ "${doctr_primary_nonzero}" != "1" ]]; then
      echo "[smoke-ocr-closure] docTR require-real assertions failed: primary metric should be > 0."
      echo "${doctr_job_detail}"
      exit 1
    fi
  fi
else
  if [[ ("${doctr_mode}" != "local_command" && "${doctr_mode}" != "simulated") || "${doctr_metric_keys}" -lt 1 ]]; then
    echo "[smoke-ocr-closure] docTR training assertions failed (non-strict mode)."
    echo "${doctr_job_detail}"
    exit 1
  fi
  if [[ ("${doctr_f1_series}" -lt 3 || -z "${doctr_f1}" || "${doctr_f1}" == "null") && ("${doctr_accuracy_series}" -lt 3 || -z "${doctr_accuracy}" || "${doctr_accuracy}" == "null") ]]; then
    echo "[smoke-ocr-closure] docTR training metrics assertions failed (non-strict mode)."
    echo "${doctr_job_detail}"
    exit 1
  fi
fi
if [[ "${doctr_artifact_mode}" == "template" ]]; then
  if [[ -z "${doctr_artifact_fallback_reason}" || "${doctr_artifact_training_performed}" != "false" ]]; then
    echo "[smoke-ocr-closure] docTR template artifact summary must include fallback_reason and training_performed=false."
    echo "${doctr_job_detail}"
    exit 1
  fi
fi

doctr_register_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/model-versions/register" \
  -d "{\"model_id\":\"${doctr_model_id}\",\"training_job_id\":\"${doctr_job_id}\",\"version_name\":\"ocr-closure-doctr-v1\",\"require_pure_real_evidence\":${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}}")"
doctr_model_version_id="$(echo "${doctr_register_resp}" | jq -r '.data.id // empty')"
doctr_artifact_attachment_id="$(echo "${doctr_register_resp}" | jq -r '.data.artifact_attachment_id // empty')"
doctr_registration_evidence_mode="$(echo "${doctr_register_resp}" | jq -r '.data.registration_evidence_mode // empty')"
doctr_registration_gate_exempted="$(echo "${doctr_register_resp}" | jq -r 'if .data.registration_gate_exempted == true then "true" elif .data.registration_gate_exempted == false then "false" else "" end')"
doctr_register_mode="created"
if [[ -z "${doctr_model_version_id}" || -z "${doctr_artifact_attachment_id}" ]]; then
  if [[ "${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" == "true" || "$(is_registration_gate_rejection "${doctr_register_resp}" && echo true || echo false)" != "true" ]]; then
    echo "[smoke-ocr-closure] failed to register docTR model version."
    echo "${doctr_register_resp}"
    exit 1
  fi

  fallback_doctr_version_id="$(pick_registered_model_version_id "ocr" "doctr")"
  if [[ -n "${fallback_doctr_version_id}" ]]; then
    doctr_model_version_id="${fallback_doctr_version_id}"
    doctr_register_mode="blocked_gate_reused_doctr"
  else
    fallback_any_ocr_version_id="$(pick_registered_model_version_id "ocr" "")"
    if [[ -z "${fallback_any_ocr_version_id}" ]]; then
      echo "[smoke-ocr-closure] registration blocked by gate and no fallback OCR model version exists for docTR step."
      echo "${doctr_register_resp}"
      exit 1
    fi
    doctr_model_version_id="${fallback_any_ocr_version_id}"
    doctr_register_mode="blocked_gate_reused_ocr_any"
  fi
  doctr_artifact_attachment_id="fallback-existing-version"
fi
if [[ "${doctr_register_mode}" == "created" && "${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" == "true" ]]; then
  if [[ "${doctr_registration_gate_exempted}" == "true" || "${doctr_registration_evidence_mode}" == "non_real_local_command" ]]; then
    echo "[smoke-ocr-closure] docTR registration should stay strict (no exemption / non-real evidence)."
    echo "${doctr_register_resp}"
    exit 1
  fi
  if [[ "${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}" == "true" && "${doctr_registration_evidence_mode}" != "real" ]]; then
    echo "[smoke-ocr-closure] docTR registration expected pure real evidence mode."
    echo "${doctr_register_resp}"
    exit 1
  fi
fi

inference_upload_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -F "file=@${image_file}")"
inference_attachment_id="$(echo "${inference_upload_resp}" | jq -r '.data.id // empty')"
if [[ -z "${inference_attachment_id}" ]]; then
  echo "[smoke-ocr-closure] failed to upload inference input."
  echo "${inference_upload_resp}"
  exit 1
fi
wait_attachment_ready "${BASE_URL}/api/files/inference" "${inference_attachment_id}" "inference input"

paddle_inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${paddle_model_version_id}\",\"input_attachment_id\":\"${inference_attachment_id}\",\"task_type\":\"ocr\"}")"
paddle_execution_source="$(echo "${paddle_inference_resp}" | jq -r '.data.execution_source // empty')"
paddle_lines="$(echo "${paddle_inference_resp}" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
paddle_runtime_fallback_reason="$(echo "${paddle_inference_resp}" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"
paddle_local_fallback_reason="$(echo "${paddle_inference_resp}" | jq -r '.data.raw_output.local_command_fallback_reason // empty')"
paddle_inference_meta_mode="$(echo "${paddle_inference_resp}" | jq -r '.data.raw_output.meta.mode // empty')"
if [[ "${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" == "true" ]]; then
  if [[ ( "${paddle_execution_source}" != "paddleocr_local_command" && "${paddle_execution_source}" != "paddleocr_local_command_fallback" ) ]]; then
    echo "[smoke-ocr-closure] PaddleOCR inference assertions failed."
    echo "${paddle_inference_resp}"
    exit 1
  fi
  if [[ "${paddle_lines}" -lt 1 && "${OCR_CLOSURE_REQUIRE_REAL_MODE}" != "true" ]]; then
    if [[ "${paddle_inference_meta_mode}" != "template" && -z "${paddle_runtime_fallback_reason}" && -z "${paddle_local_fallback_reason}" ]]; then
      echo "[smoke-ocr-closure] PaddleOCR returned no lines without explicit fallback/template evidence."
      echo "${paddle_inference_resp}"
      exit 1
    fi
  fi
  if [[ "${OCR_CLOSURE_REQUIRE_REAL_MODE}" == "true" ]]; then
    if [[ "${paddle_lines}" -lt 1 || "${paddle_inference_meta_mode}" == "template" || -n "${paddle_runtime_fallback_reason}" || -n "${paddle_local_fallback_reason}" ]]; then
      echo "[smoke-ocr-closure] PaddleOCR inference require-real assertions failed."
      echo "${paddle_inference_resp}"
      exit 1
    fi
  fi
else
  if [[ "${paddle_execution_source}" == "paddleocr_local_command" || "${paddle_execution_source}" == "paddleocr_local" ]]; then
    if [[ "${paddle_lines}" -lt 1 ]]; then
      echo "[smoke-ocr-closure] PaddleOCR inference returned no text lines without fallback source."
      echo "${paddle_inference_resp}"
      exit 1
    fi
  elif [[ "${paddle_execution_source}" == *"fallback"* ]]; then
    if [[ -z "${paddle_runtime_fallback_reason}" && -z "${paddle_local_fallback_reason}" ]]; then
      echo "[smoke-ocr-closure] PaddleOCR fallback source missing fallback reason."
      echo "${paddle_inference_resp}"
      exit 1
    fi
  else
    echo "[smoke-ocr-closure] PaddleOCR inference assertions failed (non-strict mode)."
    echo "${paddle_inference_resp}"
    exit 1
  fi
fi

doctr_inference_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -d "{\"model_version_id\":\"${doctr_model_version_id}\",\"input_attachment_id\":\"${inference_attachment_id}\",\"task_type\":\"ocr\"}")"
doctr_execution_source="$(echo "${doctr_inference_resp}" | jq -r '.data.execution_source // empty')"
doctr_lines="$(echo "${doctr_inference_resp}" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
doctr_runtime_fallback_reason="$(echo "${doctr_inference_resp}" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"
doctr_local_fallback_reason="$(echo "${doctr_inference_resp}" | jq -r '.data.raw_output.local_command_fallback_reason // empty')"
doctr_inference_meta_mode="$(echo "${doctr_inference_resp}" | jq -r '.data.raw_output.meta.mode // empty')"
if [[ "${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" == "true" ]]; then
  if [[ ( "${doctr_execution_source}" != "doctr_local_command" && "${doctr_execution_source}" != "doctr_local_command_fallback" ) ]]; then
    echo "[smoke-ocr-closure] docTR inference assertions failed."
    echo "${doctr_inference_resp}"
    exit 1
  fi
  if [[ "${doctr_lines}" -lt 1 && "${OCR_CLOSURE_REQUIRE_REAL_MODE}" != "true" ]]; then
    if [[ "${doctr_inference_meta_mode}" != "template" && -z "${doctr_runtime_fallback_reason}" && -z "${doctr_local_fallback_reason}" ]]; then
      echo "[smoke-ocr-closure] docTR returned no lines without explicit fallback/template evidence."
      echo "${doctr_inference_resp}"
      exit 1
    fi
  fi
  if [[ "${OCR_CLOSURE_REQUIRE_REAL_MODE}" == "true" ]]; then
    if [[ "${doctr_lines}" -lt 1 || "${doctr_inference_meta_mode}" == "template" || -n "${doctr_runtime_fallback_reason}" || -n "${doctr_local_fallback_reason}" ]]; then
      echo "[smoke-ocr-closure] docTR inference require-real assertions failed."
      echo "${doctr_inference_resp}"
      exit 1
    fi
  fi
else
  if [[ "${doctr_execution_source}" == "doctr_local_command" || "${doctr_execution_source}" == "doctr_local" ]]; then
    if [[ "${doctr_lines}" -lt 1 ]]; then
      echo "[smoke-ocr-closure] docTR inference returned no text lines without fallback source."
      echo "${doctr_inference_resp}"
      exit 1
    fi
  elif [[ "${doctr_register_mode}" == "blocked_gate_reused_ocr_any" && ( "${doctr_execution_source}" == "paddleocr_local_command" || "${doctr_execution_source}" == "paddleocr_local" ) ]]; then
    if [[ "${doctr_lines}" -lt 1 ]]; then
      echo "[smoke-ocr-closure] fallback OCR inference (reused version) returned no text lines."
      echo "${doctr_inference_resp}"
      exit 1
    fi
  elif [[ "${doctr_register_mode}" == "blocked_gate_reused_ocr_any" && "${doctr_execution_source}" == *"fallback"* ]]; then
    if [[ -z "${doctr_runtime_fallback_reason}" && -z "${doctr_local_fallback_reason}" ]]; then
      echo "[smoke-ocr-closure] fallback OCR inference (reused version) missing fallback reason."
      echo "${doctr_inference_resp}"
      exit 1
    fi
  elif [[ "${doctr_execution_source}" == *"fallback"* ]]; then
    if [[ -z "${doctr_runtime_fallback_reason}" && -z "${doctr_local_fallback_reason}" ]]; then
      echo "[smoke-ocr-closure] docTR fallback source missing fallback reason."
      echo "${doctr_inference_resp}"
      exit 1
    fi
  else
    echo "[smoke-ocr-closure] docTR inference assertions failed (non-strict mode)."
    echo "${doctr_inference_resp}"
    exit 1
  fi
fi

echo "[smoke-ocr-closure] PASS"
echo "dataset_id=${dataset_id}"
echo "dataset_version_id=${dataset_version_id}"
echo "paddle_job_id=${paddle_job_id}"
echo "paddle_model_version_id=${paddle_model_version_id}"
echo "paddle_register_mode=${paddle_register_mode}"
echo "paddle_registration_evidence_mode=${paddle_registration_evidence_mode}"
echo "paddle_registration_gate_exempted=${paddle_registration_gate_exempted}"
echo "paddle_accuracy=${paddle_accuracy}"
echo "doctr_job_id=${doctr_job_id}"
echo "doctr_model_version_id=${doctr_model_version_id}"
echo "doctr_register_mode=${doctr_register_mode}"
echo "doctr_registration_evidence_mode=${doctr_registration_evidence_mode}"
echo "doctr_registration_gate_exempted=${doctr_registration_gate_exempted}"
echo "doctr_f1=${doctr_f1}"
echo "doctr_accuracy=${doctr_accuracy}"
echo "doctr_primary_metric_name=${doctr_primary_metric_name}"
echo "doctr_primary_metric_value=${doctr_primary_metric_value}"
echo "inference_attachment_id=${inference_attachment_id}"
echo "paddle_execution_source=${paddle_execution_source}"
echo "doctr_execution_source=${doctr_execution_source}"
echo "ocr_closure_require_real_mode=${OCR_CLOSURE_REQUIRE_REAL_MODE}"
echo "ocr_closure_require_pure_real_registration=${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}"
