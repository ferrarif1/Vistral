#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
START_API="${START_API:-true}"
AUTH_USERNAME="${AUTH_USERNAME:-admin}"
AUTH_PASSWORD="${AUTH_PASSWORD:-mock-pass-admin}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-runtime-device-access] jq is required."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-runtime-device-access] python3 is required."
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

API_PORT="${API_PORT:-8787}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
SYNTH_IMAGE_FILE=""
OLD_KEY_RESPONSE_FILE="$(mktemp)"
REVOKED_KEY_RESPONSE_FILE="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}" "${SYNTH_IMAGE_FILE:-}" "${OLD_KEY_RESPONSE_FILE}" "${REVOKED_KEY_RESPONSE_FILE}"
}
trap cleanup EXIT

pick_registered_ocr_model_version() {
  local versions_resp="$1"
  local preferred
  preferred="$(
    echo "${versions_resp}" | jq -r '
      [.data[] | select(.status=="registered" and .task_type=="ocr" and .framework=="paddleocr" and ((.artifact_attachment_id // "") != ""))]
      | sort_by(.created_at // "")
      | reverse
      | .[0].id // empty
    '
  )"
  if [[ -n "${preferred}" ]]; then
    echo "${preferred}"
    return 0
  fi
  echo "${versions_resp}" | jq -r '
    [.data[] | select(.status=="registered" and .task_type=="ocr" and ((.artifact_attachment_id // "") != ""))]
    | sort_by(.created_at // "")
    | reverse
    | .[0].id // empty
  '
}

if [[ "${START_API}" == "true" ]]; then
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  LLM_CONFIG_SECRET="${LLM_CONFIG_SECRET:-smoke-runtime-device-access-${API_PORT}}" \
  VISTRAL_DISABLE_INFERENCE_FALLBACK="${VISTRAL_DISABLE_INFERENCE_FALLBACK:-0}" \
  MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND="${MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND:-1}" \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

for _ in $(seq 1 80); do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if [[ "${START_API}" == "true" ]] && ! kill -0 "${API_PID}" >/dev/null 2>&1; then
  echo "[smoke-runtime-device-access] API process exited before health check."
  cat "${API_LOG}"
  exit 1
fi

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-runtime-device-access] API is unreachable at ${BASE_URL}."
  if [[ "${START_API}" == "true" ]]; then
    cat "${API_LOG}"
  fi
  exit 1
fi

csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-runtime-device-access] failed to get csrf token."
  echo "${csrf_resp}"
  exit 1
fi

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/auth/login" \
  -d "{\"username\":\"${AUTH_USERNAME}\",\"password\":\"${AUTH_PASSWORD}\"}")"
login_ok="$(echo "${login_resp}" | jq -r '.success // false')"
if [[ "${login_ok}" != "true" ]]; then
  echo "[smoke-runtime-device-access] login failed for ${AUTH_USERNAME}."
  echo "${login_resp}"
  exit 1
fi

csrf_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_resp}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-runtime-device-access] failed to refresh csrf token after login."
  echo "${csrf_resp}"
  exit 1
fi

model_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions")"
ocr_model_version_id="$(pick_registered_ocr_model_version "${model_versions_resp}")"
ocr_artifact_attachment_id="$(
  echo "${model_versions_resp}" | jq -r --arg id "${ocr_model_version_id}" '.data[] | select(.id==$id) | .artifact_attachment_id // empty'
)"

if [[ -z "${ocr_model_version_id}" || -z "${ocr_artifact_attachment_id}" ]]; then
  echo "[smoke-runtime-device-access] no registered OCR model version with artifact found, running ocr-closure bootstrap."
  ocr_closure_output="$(
    env \
      START_API=false \
      BASE_URL="${BASE_URL}" \
      AUTH_USERNAME="${AUTH_USERNAME}" \
      AUTH_PASSWORD="${AUTH_PASSWORD}" \
      OCR_CLOSURE_STRICT_LOCAL_COMMAND=false \
      OCR_CLOSURE_REQUIRE_REAL_MODE=false \
      MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND="${MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND:-1}" \
      bash "${ROOT_DIR}/scripts/smoke-ocr-closure.sh"
  )"
  bootstrap_ocr_model_version_id="$(echo "${ocr_closure_output}" | awk -F= '/^paddle_model_version_id=/{print $2; exit}')"
  if [[ -z "${bootstrap_ocr_model_version_id}" ]]; then
    bootstrap_ocr_model_version_id="$(echo "${ocr_closure_output}" | awk -F= '/^doctr_model_version_id=/{print $2; exit}')"
  fi

  model_versions_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/model-versions")"
  if [[ -n "${bootstrap_ocr_model_version_id}" ]]; then
    ocr_model_version_id="${bootstrap_ocr_model_version_id}"
  else
    ocr_model_version_id="$(pick_registered_ocr_model_version "${model_versions_resp}")"
  fi
  ocr_artifact_attachment_id="$(
    echo "${model_versions_resp}" | jq -r --arg id "${ocr_model_version_id}" '.data[] | select(.id==$id) | .artifact_attachment_id // empty'
  )"
fi

if [[ -z "${ocr_model_version_id}" || -z "${ocr_artifact_attachment_id}" ]]; then
  echo "[smoke-runtime-device-access] still no registered OCR model version with artifact available."
  echo "${model_versions_resp}"
  exit 1
fi

ocr_task_type="$(
  echo "${model_versions_resp}" | jq -r --arg id "${ocr_model_version_id}" '.data[] | select(.id==$id) | .task_type // empty'
)"
if [[ "${ocr_task_type}" != "ocr" ]]; then
  echo "[smoke-runtime-device-access] selected model version is not OCR task type."
  echo "model_version_id=${ocr_model_version_id} task_type=${ocr_task_type}"
  exit 1
fi

sample_image_file="$(
  find "${ROOT_DIR}/demo_data" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit 2>/dev/null || true
)"
if [[ -z "${sample_image_file}" ]]; then
  SYNTH_IMAGE_FILE="$(mktemp "${TMPDIR:-/tmp}/runtime-device-access-sample.XXXXXX.png")"
  python3 - "${SYNTH_IMAGE_FILE}" <<'PY'
import base64
import pathlib
import sys
payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ZlN8AAAAASUVORK5CYII="
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(payload))
PY
  sample_image_file="${SYNTH_IMAGE_FILE}"
fi

image_base64="$(
  python3 - "${sample_image_file}" <<'PY'
import base64
import pathlib
import sys
print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode("ascii"))
PY
)"

issue_payload="$(
  jq -nc --arg model_version_id "${ocr_model_version_id}" --arg device_name "robot-dog-unit-01" --argjson max_calls 20 '{
    model_version_id: $model_version_id,
    device_name: $device_name,
    max_calls: $max_calls
  }'
)"
issue_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/runtime/device-access/issue" \
  -d "${issue_payload}")"
issue_ok="$(echo "${issue_resp}" | jq -r '.success // false')"
if [[ "${issue_ok}" != "true" ]]; then
  echo "[smoke-runtime-device-access] issue device access failed."
  echo "${issue_resp}"
  exit 1
fi
device_binding_key="$(echo "${issue_resp}" | jq -r '.data.record.binding_key // empty')"
issued_api_key="$(echo "${issue_resp}" | jq -r '.data.api_key // empty')"
if [[ -z "${device_binding_key}" || -z "${issued_api_key}" ]]; then
  echo "[smoke-runtime-device-access] missing binding key or api key in issue response."
  echo "${issue_resp}"
  exit 1
fi

list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/runtime/device-access?model_version_id=${ocr_model_version_id}")"
list_ok="$(echo "${list_resp}" | jq -r '.success // false')"
if [[ "${list_ok}" != "true" ]]; then
  echo "[smoke-runtime-device-access] list device access failed."
  echo "${list_resp}"
  exit 1
fi
list_count="$(
  echo "${list_resp}" | jq -r --arg key "${device_binding_key}" '[.data[] | select(.binding_key==$key)] | length'
)"
if [[ "${list_count}" -lt 1 ]]; then
  echo "[smoke-runtime-device-access] issued binding key not found in list response."
  echo "${list_resp}"
  exit 1
fi
initial_used_calls="$(
  echo "${list_resp}" | jq -r --arg key "${device_binding_key}" '.data[] | select(.binding_key==$key) | .used_calls // -1' | head -n 1
)"
if [[ "${initial_used_calls}" != "0" ]]; then
  echo "[smoke-runtime-device-access] newly issued key should start with used_calls=0."
  echo "${list_resp}"
  exit 1
fi
initial_issued_at="$(
  echo "${list_resp}" | jq -r --arg key "${device_binding_key}" '.data[] | select(.binding_key==$key) | .issued_at // empty' | head -n 1
)"
if [[ -z "${initial_issued_at}" ]]; then
  echo "[smoke-runtime-device-access] issued device access should expose issued_at."
  echo "${list_resp}"
  exit 1
fi

public_inference_payload="$(
  jq -nc \
    --arg model_version_id "${ocr_model_version_id}" \
    --arg task_type "ocr" \
    --arg filename "device-input.png" \
    --arg mime_type "image/png" \
    --arg image_base64 "${image_base64}" \
    '{
      model_version_id: $model_version_id,
      task_type: $task_type,
      filename: $filename,
      mime_type: $mime_type,
      image_base64: $image_base64
    }'
)"
public_inference_resp="$(curl -sS \
  -H "Authorization: Bearer ${issued_api_key}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/runtime/public/inference" \
  -d "${public_inference_payload}")"
if ! echo "${public_inference_resp}" | jq -e --arg key "${device_binding_key}" '.success == true and .data.runtime_auth_binding_key == $key and (.data.request_id | type == "string")' >/dev/null; then
  echo "[smoke-runtime-device-access] public inference with issued key failed."
  echo "${public_inference_resp}"
  exit 1
fi
public_inference_run_request_id="$(echo "${public_inference_resp}" | jq -r '.data.request_id // empty')"

model_package_payload="$(
  jq -nc \
    --arg model_version_id "${ocr_model_version_id}" \
    --arg encryption_key "robot-dog-delivery-secret" \
    '{
      model_version_id: $model_version_id,
      encryption_key: $encryption_key
    }'
)"
model_package_resp="$(curl -sS \
  -H "Authorization: Bearer ${issued_api_key}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/runtime/public/model-package" \
  -d "${model_package_payload}")"
if ! echo "${model_package_resp}" | jq -e --arg key "${device_binding_key}" '.success == true and .data.runtime_auth_binding_key == $key and .data.encryption.algorithm == "aes-256-gcm" and (.data.delivery_id | type == "string")' >/dev/null; then
  echo "[smoke-runtime-device-access] public model package with issued key failed."
  echo "${model_package_resp}"
  exit 1
fi
delivery_id="$(echo "${model_package_resp}" | jq -r '.data.delivery_id // empty')"

post_use_list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/runtime/device-access?model_version_id=${ocr_model_version_id}")"
post_use_used_calls="$(
  echo "${post_use_list_resp}" | jq -r --arg key "${device_binding_key}" '.data[] | select(.binding_key==$key) | .used_calls // -1' | head -n 1
)"
if [[ "${post_use_used_calls}" -lt "2" ]]; then
  echo "[smoke-runtime-device-access] used_calls should be >=2 after inference + model package."
  echo "${post_use_list_resp}"
  exit 1
fi

lifecycle_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/runtime/device-access/lifecycle?model_version_id=${ocr_model_version_id}")"
if ! echo "${lifecycle_resp}" | jq -e \
  --arg request_id "${public_inference_run_request_id}" \
  --arg delivery_id "${delivery_id}" \
  --arg key "${device_binding_key}" \
  '.success == true
    and ([.data.public_inference_invocations[] | select(.request_id == $request_id and .runtime_auth_binding_key == $key)] | length) >= 1
    and ([.data.model_package_deliveries[] | select(.delivery_id == $delivery_id and .runtime_auth_binding_key == $key)] | length) >= 1' >/dev/null; then
  echo "[smoke-runtime-device-access] lifecycle snapshot missing expected inference/delivery records."
  echo "${lifecycle_resp}"
  exit 1
fi

rotate_payload="$(
  jq -nc --arg model_version_id "${ocr_model_version_id}" --arg binding_key "${device_binding_key}" '{
    model_version_id: $model_version_id,
    binding_key: $binding_key
  }'
)"
rotate_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/runtime/device-access/rotate" \
  -d "${rotate_payload}")"
rotate_ok="$(echo "${rotate_resp}" | jq -r '.success // false')"
rotated_api_key="$(echo "${rotate_resp}" | jq -r '.data.api_key // empty')"
if [[ "${rotate_ok}" != "true" || -z "${rotated_api_key}" ]]; then
  echo "[smoke-runtime-device-access] rotate device access failed."
  echo "${rotate_resp}"
  exit 1
fi

old_key_http="$(curl -sS -o "${OLD_KEY_RESPONSE_FILE}" -w '%{http_code}' \
  -H "Authorization: Bearer ${issued_api_key}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/runtime/public/inference" \
  -d "${public_inference_payload}")"
if [[ "${old_key_http}" != "403" ]]; then
  echo "[smoke-runtime-device-access] old key should fail with 403 after rotation (got ${old_key_http})."
  cat "${OLD_KEY_RESPONSE_FILE}"
  exit 1
fi
old_key_error_code="$(jq -r '.error.code // empty' "${OLD_KEY_RESPONSE_FILE}")"
if [[ "${old_key_error_code}" != "INSUFFICIENT_PERMISSIONS" ]]; then
  echo "[smoke-runtime-device-access] old key failure code mismatch: ${old_key_error_code}"
  cat "${OLD_KEY_RESPONSE_FILE}"
  exit 1
fi

rotated_inference_resp="$(curl -sS \
  -H "Authorization: Bearer ${rotated_api_key}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/runtime/public/inference" \
  -d "${public_inference_payload}")"
if ! echo "${rotated_inference_resp}" | jq -e --arg key "${device_binding_key}" '.success == true and .data.runtime_auth_binding_key == $key' >/dev/null; then
  echo "[smoke-runtime-device-access] rotated key inference failed."
  echo "${rotated_inference_resp}"
  exit 1
fi

post_rotate_list_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  "${BASE_URL}/api/runtime/device-access?model_version_id=${ocr_model_version_id}")"
post_rotate_used_calls="$(
  echo "${post_rotate_list_resp}" | jq -r --arg key "${device_binding_key}" '.data[] | select(.binding_key==$key) | .used_calls // -1' | head -n 1
)"
if [[ "${post_rotate_used_calls}" != "1" ]]; then
  echo "[smoke-runtime-device-access] rotated key used_calls should reset and become 1 after one inference."
  echo "${post_rotate_list_resp}"
  exit 1
fi

revoke_payload="$(
  jq -nc --arg model_version_id "${ocr_model_version_id}" --arg binding_key "${device_binding_key}" '{
    model_version_id: $model_version_id,
    binding_key: $binding_key
  }'
)"
revoke_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/runtime/device-access/revoke" \
  -d "${revoke_payload}")"
revoke_ok="$(echo "${revoke_resp}" | jq -r '.success // false')"
remaining_count="$(
  echo "${revoke_resp}" | jq -r --arg key "${device_binding_key}" '[.data[] | select(.binding_key==$key)] | length'
)"
if [[ "${revoke_ok}" != "true" || "${remaining_count}" != "0" ]]; then
  echo "[smoke-runtime-device-access] revoke device access failed."
  echo "${revoke_resp}"
  exit 1
fi

revoked_key_http="$(curl -sS -o "${REVOKED_KEY_RESPONSE_FILE}" -w '%{http_code}' \
  -H "Authorization: Bearer ${rotated_api_key}" \
  -H 'Content-Type: application/json' \
  -X POST "${BASE_URL}/api/runtime/public/inference" \
  -d "${public_inference_payload}")"
if [[ "${revoked_key_http}" != "403" ]]; then
  echo "[smoke-runtime-device-access] revoked key should fail with 403 (got ${revoked_key_http})."
  cat "${REVOKED_KEY_RESPONSE_FILE}"
  exit 1
fi
revoked_key_error_code="$(jq -r '.error.code // empty' "${REVOKED_KEY_RESPONSE_FILE}")"
if [[ "${revoked_key_error_code}" != "INSUFFICIENT_PERMISSIONS" ]]; then
  echo "[smoke-runtime-device-access] revoked key failure code mismatch: ${revoked_key_error_code}"
  cat "${REVOKED_KEY_RESPONSE_FILE}"
  exit 1
fi

echo "[smoke-runtime-device-access] PASS"
echo "model_version_id=${ocr_model_version_id}"
echo "binding_key=${device_binding_key}"
echo "request_id=${public_inference_run_request_id}"
echo "delivery_id=${delivery_id}"
