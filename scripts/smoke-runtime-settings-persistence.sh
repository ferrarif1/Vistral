#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-mock-pass-admin}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-runtime-settings-persistence] jq is required."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-runtime-settings-persistence] python3 is required."
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
API_PORT="${API_PORT:-8808}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
API_PID=""

RUNTIME_SETTINGS_FILE="${ROOT_DIR}/.data/runtime-settings.enc.json"
RUNTIME_SETTINGS_BACKUP="$(mktemp)"
RUNTIME_SETTINGS_EXISTED=false

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi

  if [[ "${RUNTIME_SETTINGS_EXISTED}" == "true" ]]; then
    mkdir -p "$(dirname "${RUNTIME_SETTINGS_FILE}")"
    cp "${RUNTIME_SETTINGS_BACKUP}" "${RUNTIME_SETTINGS_FILE}"
  else
    rm -f "${RUNTIME_SETTINGS_FILE}"
  fi

  rm -f "${COOKIE_FILE}" "${API_LOG}" "${RUNTIME_SETTINGS_BACKUP}"
  rm -rf "${APP_DATA_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

if [[ -f "${RUNTIME_SETTINGS_FILE}" ]]; then
  RUNTIME_SETTINGS_EXISTED=true
  cp "${RUNTIME_SETTINGS_FILE}" "${RUNTIME_SETTINGS_BACKUP}"
fi
rm -f "${RUNTIME_SETTINGS_FILE}"

wait_for_health() {
  for _ in {1..120}; do
    if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

start_api() {
  APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
  UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
  TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
  PADDLEOCR_RUNTIME_ENDPOINT="${ENV_PADDLE_ENDPOINT}" \
  DOCTR_RUNTIME_ENDPOINT="${ENV_DOCTR_ENDPOINT}" \
  YOLO_RUNTIME_ENDPOINT="${ENV_YOLO_ENDPOINT}" \
  PADDLEOCR_LOCAL_MODEL_PATH="${ENV_PADDLE_LOCAL_MODEL_PATH}" \
  DOCTR_LOCAL_MODEL_PATH="${ENV_DOCTR_LOCAL_MODEL_PATH}" \
  YOLO_LOCAL_MODEL_PATH="${ENV_YOLO_LOCAL_MODEL_PATH}" \
  VISTRAL_PYTHON_BIN="${ENV_RUNTIME_PYTHON_BIN}" \
  VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK="${ENV_DISABLE_SIMULATED_TRAIN_FALLBACK}" \
  VISTRAL_DISABLE_INFERENCE_FALLBACK="${ENV_DISABLE_INFERENCE_FALLBACK}" \
  PADDLEOCR_RUNTIME_API_KEY="" \
  DOCTR_RUNTIME_API_KEY="" \
  YOLO_RUNTIME_API_KEY="" \
  PADDLEOCR_LOCAL_TRAIN_COMMAND="python3 {{repo_root}}/scripts/local-runners/paddleocr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}" \
  DOCTR_LOCAL_TRAIN_COMMAND="python3 {{repo_root}}/scripts/local-runners/doctr_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}" \
  YOLO_LOCAL_TRAIN_COMMAND="python3 {{repo_root}}/scripts/local-runners/yolo_train_runner.py --job-id {{job_id}} --dataset-id {{dataset_id}} --task-type {{task_type}} --base-model {{base_model}} --workspace-dir {{workspace_dir}} --config-path {{config_path}} --summary-path {{summary_path}} --metrics-path {{metrics_path}} --artifact-path {{artifact_path}}" \
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!

  if ! wait_for_health; then
    echo "[smoke-runtime-settings-persistence] API failed to start."
    cat "${API_LOG}"
    exit 1
  fi
}

stop_api() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
    API_PID=""
  fi
}

login_admin() {
  local csrf_resp=""
  local csrf_token=""
  local login_resp=""
  local login_ok=""

  csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
  if [[ -z "${csrf_token}" ]]; then
    echo "[smoke-runtime-settings-persistence] failed to obtain CSRF token."
    echo "${csrf_resp}"
    exit 1
  fi

  login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
    -H "Content-Type: application/json" \
    -X POST "${BASE_URL}/api/auth/login" \
    -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
  login_ok="$(echo "${login_resp}" | jq -r '.success // false')"
  if [[ "${login_ok}" != "true" ]]; then
    echo "[smoke-runtime-settings-persistence] login failed for ${AUTH_USERNAME}."
    echo "${login_resp}"
    exit 1
  fi

  csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
  csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
  if [[ -z "${csrf_token}" ]]; then
    echo "[smoke-runtime-settings-persistence] failed to refresh CSRF token after login."
    echo "${csrf_resp}"
    exit 1
  fi

  echo "${csrf_token}"
}

ENV_PADDLE_ENDPOINT="http://env-paddle.local/predict"
ENV_DOCTR_ENDPOINT="http://env-doctr.local/predict"
ENV_YOLO_ENDPOINT="http://env-yolo.local/predict"
ENV_PADDLE_LOCAL_MODEL_PATH="/env/runtime/paddleocr-model"
ENV_DOCTR_LOCAL_MODEL_PATH="/env/runtime/doctr-model"
ENV_YOLO_LOCAL_MODEL_PATH="/env/runtime/yolo-model.pt"
ENV_RUNTIME_PYTHON_BIN="/env/runtime/python"
ENV_DISABLE_SIMULATED_TRAIN_FALLBACK="0"
ENV_DISABLE_INFERENCE_FALLBACK="0"

if [[ "${START_API}" == "true" ]]; then
  start_api
fi

csrf_token="$(login_admin)"

generated_key_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/settings/runtime/generate-api-key" \
  -d '{}')"
generated_key_value="$(echo "${generated_key_resp}" | jq -r '.data.api_key // empty')"
if [[ -z "${generated_key_value}" || "${generated_key_value}" != vsk_* ]]; then
  echo "[smoke-runtime-settings-persistence] runtime key generation endpoint assertion failed."
  echo "${generated_key_resp}"
  exit 1
fi

initial_settings="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/settings/runtime")"
initial_updated_at="$(echo "${initial_settings}" | jq -r '.data.updated_at // empty')"
initial_yolo_endpoint="$(echo "${initial_settings}" | jq -r '.data.frameworks.yolo.endpoint // empty')"
initial_yolo_local_model_path="$(echo "${initial_settings}" | jq -r '.data.frameworks.yolo.local_model_path // empty')"
initial_python_bin="$(echo "${initial_settings}" | jq -r '.data.controls.python_bin // empty')"
initial_disable_simulated_train_fallback="$(echo "${initial_settings}" | jq -r '.data.controls.disable_simulated_train_fallback // false')"
initial_disable_inference_fallback="$(echo "${initial_settings}" | jq -r '.data.controls.disable_inference_fallback // false')"
if [[ -n "${initial_updated_at}" ]]; then
  echo "[smoke-runtime-settings-persistence] expected initial updated_at to be null."
  echo "${initial_settings}"
  exit 1
fi
if [[ "${initial_yolo_endpoint}" != "${ENV_YOLO_ENDPOINT}" ]]; then
  echo "[smoke-runtime-settings-persistence] initial yolo endpoint mismatch."
  echo "${initial_settings}"
  exit 1
fi
if [[ "${initial_yolo_local_model_path}" != "${ENV_YOLO_LOCAL_MODEL_PATH}" ]]; then
  echo "[smoke-runtime-settings-persistence] initial yolo local model path mismatch."
  echo "${initial_settings}"
  exit 1
fi
if [[ "${initial_python_bin}" != "${ENV_RUNTIME_PYTHON_BIN}" || "${initial_disable_simulated_train_fallback}" != "false" || "${initial_disable_inference_fallback}" != "false" ]]; then
  echo "[smoke-runtime-settings-persistence] initial runtime control defaults mismatch."
  echo "${initial_settings}"
  exit 1
fi

save_payload="$(jq -nc '{
  runtime_config: {
    paddleocr: {
      endpoint: "http://saved-paddle.local/predict",
      api_key: "saved-paddle-key",
      local_model_path: "/saved/runtime/paddleocr-model",
      local_train_command: "python3 /opt/runner/paddle_train.py",
      local_predict_command: "python3 /opt/runner/paddle_predict.py"
    },
    doctr: {
      endpoint: "http://saved-doctr.local/predict",
      api_key: "saved-doctr-key",
      local_model_path: "/saved/runtime/doctr-model",
      local_train_command: "python3 /opt/runner/doctr_train.py",
      local_predict_command: "python3 /opt/runner/doctr_predict.py"
    },
    yolo: {
      endpoint: "http://saved-yolo.local/predict",
      api_key: "saved-yolo-key",
      model_api_keys: {
        "model:m-foundation-yolo": "saved-yolo-model-key"
      },
      model_api_key_policies: {
        "model:m-foundation-yolo": {
          api_key: "saved-yolo-model-key",
          expires_at: null,
          max_calls: null,
          used_calls: 0,
          last_used_at: null
        }
      },
      local_model_path: "/saved/runtime/yolo-model.pt",
      local_train_command: "python3 /opt/runner/yolo_train.py",
      local_predict_command: "python3 /opt/runner/yolo_predict.py"
    }
  },
  runtime_controls: {
    python_bin: "/saved/runtime/python",
    disable_simulated_train_fallback: true,
    disable_inference_fallback: true
  },
  keep_existing_api_keys: true
}')"

saved_settings="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/settings/runtime" \
  -d "${save_payload}")"

saved_updated_at="$(echo "${saved_settings}" | jq -r '.data.updated_at // empty')"
saved_yolo_endpoint="$(echo "${saved_settings}" | jq -r '.data.frameworks.yolo.endpoint // empty')"
saved_yolo_local_model_path="$(echo "${saved_settings}" | jq -r '.data.frameworks.yolo.local_model_path // empty')"
saved_yolo_has_key="$(echo "${saved_settings}" | jq -r '.data.frameworks.yolo.has_api_key // false')"
saved_yolo_masked="$(echo "${saved_settings}" | jq -r '.data.frameworks.yolo.api_key_masked // empty')"
saved_yolo_model_key_present="$(echo "${saved_settings}" | jq -r '.data.frameworks.yolo.model_api_keys_meta["model:m-foundation-yolo"].has_api_key // false')"
saved_yolo_model_key_expiry_status="$(echo "${saved_settings}" | jq -r '.data.frameworks.yolo.model_api_keys_meta["model:m-foundation-yolo"].expires_status // empty')"
saved_python_bin="$(echo "${saved_settings}" | jq -r '.data.controls.python_bin // empty')"
saved_disable_simulated_train_fallback="$(echo "${saved_settings}" | jq -r '.data.controls.disable_simulated_train_fallback // false')"
saved_disable_inference_fallback="$(echo "${saved_settings}" | jq -r '.data.controls.disable_inference_fallback // false')"
if [[ -z "${saved_updated_at}" || "${saved_yolo_endpoint}" != "http://saved-yolo.local/predict" || "${saved_yolo_local_model_path}" != "/saved/runtime/yolo-model.pt" || "${saved_yolo_has_key}" != "true" || -z "${saved_yolo_masked}" || "${saved_yolo_model_key_present}" != "true" || "${saved_yolo_model_key_expiry_status}" != "none" || "${saved_python_bin}" != "/saved/runtime/python" || "${saved_disable_simulated_train_fallback}" != "true" || "${saved_disable_inference_fallback}" != "true" ]]; then
  echo "[smoke-runtime-settings-persistence] save runtime settings assertions failed."
  echo "${saved_settings}"
  exit 1
fi

revoke_model_binding_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/settings/runtime/revoke-api-key" \
  -d '{"framework":"yolo","binding_key":"model:m-foundation-yolo"}')"
revoke_model_binding_present="$(echo "${revoke_model_binding_resp}" | jq -r '.data.frameworks.yolo.model_api_keys_meta["model:m-foundation-yolo"].has_api_key // false')"
if [[ "${revoke_model_binding_present}" != "false" ]]; then
  echo "[smoke-runtime-settings-persistence] revoke model binding runtime key failed."
  echo "${revoke_model_binding_resp}"
  exit 1
fi

revoke_framework_key_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/settings/runtime/revoke-api-key" \
  -d '{"framework":"yolo","binding_key":"framework"}')"
revoke_framework_has_key="$(echo "${revoke_framework_key_resp}" | jq -r '.data.frameworks.yolo.has_api_key // false')"
if [[ "${revoke_framework_has_key}" != "false" ]]; then
  echo "[smoke-runtime-settings-persistence] revoke framework runtime key failed."
  echo "${revoke_framework_key_resp}"
  exit 1
fi

rotate_framework_key_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/settings/runtime/rotate-api-key" \
  -d '{"framework":"yolo","binding_key":"framework"}')"
rotated_framework_key_value="$(echo "${rotate_framework_key_resp}" | jq -r '.data.api_key // empty')"
rotated_framework_has_key="$(echo "${rotate_framework_key_resp}" | jq -r '.data.settings.frameworks.yolo.has_api_key // false')"
if [[ -z "${rotated_framework_key_value}" || "${rotated_framework_key_value}" != vsk_* || "${rotated_framework_has_key}" != "true" ]]; then
  echo "[smoke-runtime-settings-persistence] rotate framework runtime key failed."
  echo "${rotate_framework_key_resp}"
  exit 1
fi

rotate_model_binding_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/settings/runtime/rotate-api-key" \
  -d '{"framework":"yolo","binding_key":"model:m-foundation-yolo"}')"
rotated_model_binding_key_value="$(echo "${rotate_model_binding_resp}" | jq -r '.data.api_key // empty')"
rotated_model_binding_present="$(echo "${rotate_model_binding_resp}" | jq -r '.data.settings.frameworks.yolo.model_api_keys_meta["model:m-foundation-yolo"].has_api_key // false')"
rotated_model_binding_used_calls="$(echo "${rotate_model_binding_resp}" | jq -r '.data.settings.frameworks.yolo.model_api_keys_meta["model:m-foundation-yolo"].used_calls // -1')"
rotated_model_binding_expiry_status="$(echo "${rotate_model_binding_resp}" | jq -r '.data.settings.frameworks.yolo.model_api_keys_meta["model:m-foundation-yolo"].expires_status // empty')"
if [[ -z "${rotated_model_binding_key_value}" || "${rotated_model_binding_key_value}" != vsk_* || "${rotated_model_binding_present}" != "true" || "${rotated_model_binding_used_calls}" != "0" || "${rotated_model_binding_expiry_status}" != "none" ]]; then
  echo "[smoke-runtime-settings-persistence] rotate model binding runtime key failed."
  echo "${rotate_model_binding_resp}"
  exit 1
fi

yolo_connectivity="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/runtime/connectivity?framework=yolo")"
yolo_connectivity_endpoint="$(echo "${yolo_connectivity}" | jq -r '.data[0].endpoint // empty')"
if [[ "${yolo_connectivity_endpoint}" != "http://saved-yolo.local/predict" ]]; then
  echo "[smoke-runtime-settings-persistence] runtime connectivity did not read saved yolo endpoint."
  echo "${yolo_connectivity}"
  exit 1
fi

if [[ "${START_API}" == "true" ]]; then
  stop_api
  start_api
fi

csrf_token="$(login_admin)"

reloaded_settings="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/settings/runtime")"
reloaded_yolo_endpoint="$(echo "${reloaded_settings}" | jq -r '.data.frameworks.yolo.endpoint // empty')"
reloaded_yolo_local_model_path="$(echo "${reloaded_settings}" | jq -r '.data.frameworks.yolo.local_model_path // empty')"
reloaded_updated_at="$(echo "${reloaded_settings}" | jq -r '.data.updated_at // empty')"
reloaded_python_bin="$(echo "${reloaded_settings}" | jq -r '.data.controls.python_bin // empty')"
reloaded_disable_simulated_train_fallback="$(echo "${reloaded_settings}" | jq -r '.data.controls.disable_simulated_train_fallback // false')"
reloaded_disable_inference_fallback="$(echo "${reloaded_settings}" | jq -r '.data.controls.disable_inference_fallback // false')"
if [[ "${reloaded_yolo_endpoint}" != "http://saved-yolo.local/predict" || "${reloaded_yolo_local_model_path}" != "/saved/runtime/yolo-model.pt" || -z "${reloaded_updated_at}" || "${reloaded_python_bin}" != "/saved/runtime/python" || "${reloaded_disable_simulated_train_fallback}" != "true" || "${reloaded_disable_inference_fallback}" != "true" ]]; then
  echo "[smoke-runtime-settings-persistence] saved runtime settings were not persisted across restart."
  echo "${reloaded_settings}"
  exit 1
fi

clear_settings_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X DELETE "${BASE_URL}/api/settings/runtime")"
clear_updated_at="$(echo "${clear_settings_resp}" | jq -r '.data.updated_at // empty')"
clear_yolo_endpoint="$(echo "${clear_settings_resp}" | jq -r '.data.frameworks.yolo.endpoint // empty')"
clear_yolo_local_model_path="$(echo "${clear_settings_resp}" | jq -r '.data.frameworks.yolo.local_model_path // empty')"
clear_python_bin="$(echo "${clear_settings_resp}" | jq -r '.data.controls.python_bin // empty')"
clear_disable_simulated_train_fallback="$(echo "${clear_settings_resp}" | jq -r '.data.controls.disable_simulated_train_fallback // false')"
clear_disable_inference_fallback="$(echo "${clear_settings_resp}" | jq -r '.data.controls.disable_inference_fallback // false')"
if [[ -n "${clear_updated_at}" || "${clear_yolo_endpoint}" != "${ENV_YOLO_ENDPOINT}" || "${clear_yolo_local_model_path}" != "${ENV_YOLO_LOCAL_MODEL_PATH}" || "${clear_python_bin}" != "${ENV_RUNTIME_PYTHON_BIN}" || "${clear_disable_simulated_train_fallback}" != "false" || "${clear_disable_inference_fallback}" != "false" ]]; then
  echo "[smoke-runtime-settings-persistence] clear runtime settings did not fall back to env defaults."
  echo "${clear_settings_resp}"
  exit 1
fi

post_clear_connectivity="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/runtime/connectivity?framework=yolo")"
post_clear_connectivity_endpoint="$(echo "${post_clear_connectivity}" | jq -r '.data[0].endpoint // empty')"
if [[ "${post_clear_connectivity_endpoint}" != "${ENV_YOLO_ENDPOINT}" ]]; then
  echo "[smoke-runtime-settings-persistence] runtime connectivity did not switch back to env endpoint after clear."
  echo "${post_clear_connectivity}"
  exit 1
fi

echo "[smoke-runtime-settings-persistence] PASS"
echo "saved_updated_at=${saved_updated_at}"
echo "reloaded_updated_at=${reloaded_updated_at}"
echo "saved_yolo_endpoint=${saved_yolo_endpoint}"
echo "saved_yolo_local_model_path=${saved_yolo_local_model_path}"
echo "env_yolo_endpoint=${ENV_YOLO_ENDPOINT}"
echo "env_yolo_local_model_path=${ENV_YOLO_LOCAL_MODEL_PATH}"
