#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-conversation-ops-bridge] jq is required."
  exit 1
fi

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8799}"
BASE_URL="http://${API_HOST}:${API_PORT}"
SMOKE_OPS_BRIDGE_EXECUTE_MUTATIONS="${SMOKE_OPS_BRIDGE_EXECUTE_MUTATIONS:-false}"

is_truthy() {
  case "${1,,}" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_FILE" "$API_LOG"
}
trap cleanup EXIT

API_PORT="$API_PORT" npm run dev:api >"$API_LOG" 2>&1 &
API_PID=$!

for _ in $(seq 1 80); do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-conversation-ops-bridge] API failed to start"
  cat "$API_LOG"
  exit 1
fi

csrf_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "$csrf_payload" | jq -r '.data.csrf_token // empty')"
if [[ -z "$csrf_token" ]]; then
  echo "[smoke-conversation-ops-bridge] failed to get csrf token"
  echo "$csrf_payload"
  exit 1
fi

me_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/users/me")"
current_role="$(echo "$me_payload" | jq -r '.data.role // empty')"
if [[ -z "$current_role" ]]; then
  echo "[smoke-conversation-ops-bridge] failed to resolve current role"
  echo "$me_payload"
  exit 1
fi

if [[ "$current_role" != "admin" ]]; then
  admin_list_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/admin/training-workers")"
  admin_list_success="$(echo "$admin_list_payload" | jq -r '.success // false')"
  admin_list_code="$(echo "$admin_list_payload" | jq -r '.error.code // empty')"
  if [[ "$admin_list_success" != "false" || "$admin_list_code" != "INSUFFICIENT_PERMISSIONS" ]]; then
    echo "[smoke-conversation-ops-bridge] expected non-admin access to admin worker list to be denied"
    echo "$admin_list_payload"
    exit 1
  fi

  admin_create_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d '{"name":"worker-admin-check","status":"online"}' \
    "${BASE_URL}/api/admin/training-workers")"
  admin_create_success="$(echo "$admin_create_payload" | jq -r '.success // false')"
  admin_create_code="$(echo "$admin_create_payload" | jq -r '.error.code // empty')"
  if [[ "$admin_create_success" != "false" || "$admin_create_code" != "INSUFFICIENT_PERMISSIONS" ]]; then
    echo "[smoke-conversation-ops-bridge] expected non-admin admin worker create to be denied"
    echo "$admin_create_payload"
    exit 1
  fi
fi

runtime_readiness_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/runtime/readiness")"
runtime_readiness_success="$(echo "$runtime_readiness_payload" | jq -r '.success // false')"
if [[ "$current_role" == "admin" ]]; then
  runtime_readiness_status="$(echo "$runtime_readiness_payload" | jq -r '.data.status // empty')"
  runtime_readiness_issue_type="$(echo "$runtime_readiness_payload" | jq -r '(.data.issues | type) // empty')"
  runtime_readiness_framework_count="$(echo "$runtime_readiness_payload" | jq -r '(.data.frameworks | length) // 0')"
  runtime_readiness_issue_field_type_errors="$(
    echo "$runtime_readiness_payload" | jq -r '
      [
        .data.issues[]?
        | select(
            ((has("remediation") and (.remediation | type != "string")))
            or
            ((has("remediation_command") and (.remediation_command | type != "string")))
          )
      ] | length
    '
  )"
  if [[ "$runtime_readiness_success" != "true" || "$runtime_readiness_status" == "" ]]; then
    echo "[smoke-conversation-ops-bridge] expected runtime readiness payload for admin"
    echo "$runtime_readiness_payload"
    exit 1
  fi
  if [[ "$runtime_readiness_issue_type" != "array" || "$runtime_readiness_framework_count" -lt 1 ]]; then
    echo "[smoke-conversation-ops-bridge] expected runtime readiness payload to include issues[] and frameworks[]"
    echo "$runtime_readiness_payload"
    exit 1
  fi
  if [[ "$runtime_readiness_issue_field_type_errors" != "0" ]]; then
    echo "[smoke-conversation-ops-bridge] expected runtime readiness optional issue fields to keep string typing"
    echo "$runtime_readiness_payload"
    exit 1
  fi
  runtime_auto_populate_local_commands="${VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS:-1}"
  if is_truthy "$runtime_auto_populate_local_commands"; then
    runtime_settings_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/settings/runtime")"
    runtime_settings_success="$(echo "$runtime_settings_payload" | jq -r '.success // false')"
    runtime_settings_missing_local_cmds="$(
      echo "$runtime_settings_payload" | jq -r '
        [
          .data.frameworks.paddleocr,
          .data.frameworks.doctr,
          .data.frameworks.yolo
        ]
        | map(select((.local_train_command // "") == "" or (.local_predict_command // "") == ""))
        | length
      '
    )"
    if [[ "$runtime_settings_success" != "true" || "$runtime_settings_missing_local_cmds" != "0" ]]; then
      echo "[smoke-conversation-ops-bridge] expected runtime settings local commands to auto-populate when enabled"
      echo "$runtime_settings_payload"
      exit 1
    fi
  fi
  runtime_auto_config_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d '{"overwrite_endpoint":false}' \
    "${BASE_URL}/api/settings/runtime/auto-configure")"
  runtime_auto_config_success="$(echo "$runtime_auto_config_payload" | jq -r '.success // false')"
  if [[ "$runtime_auto_config_success" != "true" ]]; then
    echo "[smoke-conversation-ops-bridge] expected runtime auto-config to succeed for admin"
    echo "$runtime_auto_config_payload"
    exit 1
  fi
else
  runtime_readiness_code="$(echo "$runtime_readiness_payload" | jq -r '.error.code // empty')"
  if [[ "$runtime_readiness_success" != "false" || "$runtime_readiness_code" != "INSUFFICIENT_PERMISSIONS" ]]; then
    echo "[smoke-conversation-ops-bridge] expected non-admin runtime readiness access to be denied"
    echo "$runtime_readiness_payload"
    exit 1
  fi
  runtime_auto_config_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d '{"overwrite_endpoint":false}' \
    "${BASE_URL}/api/settings/runtime/auto-configure")"
  runtime_auto_config_success="$(echo "$runtime_auto_config_payload" | jq -r '.success // false')"
  runtime_auto_config_code="$(echo "$runtime_auto_config_payload" | jq -r '.error.code // empty')"
  if [[ "$runtime_auto_config_success" != "false" || "$runtime_auto_config_code" != "INSUFFICIENT_PERMISSIONS" ]]; then
    echo "[smoke-conversation-ops-bridge] expected runtime auto-config access to be denied for non-admin"
    echo "$runtime_auto_config_payload"
    exit 1
  fi
fi

invalid_json_login_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -d '{"username":' \
  "${BASE_URL}/api/auth/login")"
invalid_json_login_success="$(echo "$invalid_json_login_payload" | jq -r '.success // false')"
invalid_json_login_code="$(echo "$invalid_json_login_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_json_login_success" != "false" || "$invalid_json_login_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for malformed login JSON"
  echo "$invalid_json_login_payload"
  exit 1
fi

models_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/models")"
model_id="$(echo "$models_payload" | jq -r '.data[0].id // empty')"
if [[ -z "$model_id" ]]; then
  echo "[smoke-conversation-ops-bridge] no model available to start conversation"
  echo "$models_payload"
  exit 1
fi

invalid_start_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$(jq -nc --arg model_id "$model_id" '{model_id:$model_id}')" \
  "${BASE_URL}/api/conversations/start")"
invalid_start_success="$(echo "$invalid_start_payload" | jq -r '.success // false')"
invalid_start_code="$(echo "$invalid_start_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_start_success" != "false" || "$invalid_start_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for missing initial_message"
  echo "$invalid_start_payload"
  exit 1
fi

invalid_training_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/training/jobs")"
invalid_training_success="$(echo "$invalid_training_payload" | jq -r '.success // false')"
invalid_training_code="$(echo "$invalid_training_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_training_success" != "false" || "$invalid_training_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid training job payload"
  echo "$invalid_training_payload"
  exit 1
fi

invalid_inference_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/inference/runs")"
invalid_inference_success="$(echo "$invalid_inference_payload" | jq -r '.success // false')"
invalid_inference_code="$(echo "$invalid_inference_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_inference_success" != "false" || "$invalid_inference_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid inference payload"
  echo "$invalid_inference_payload"
  exit 1
fi

invalid_task_draft_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/task-drafts/from-requirement")"
invalid_task_draft_success="$(echo "$invalid_task_draft_payload" | jq -r '.success // false')"
invalid_task_draft_code="$(echo "$invalid_task_draft_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_task_draft_success" != "false" || "$invalid_task_draft_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid task draft payload"
  echo "$invalid_task_draft_payload"
  exit 1
fi

invalid_model_register_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/model-versions/register")"
invalid_model_register_success="$(echo "$invalid_model_register_payload" | jq -r '.success // false')"
invalid_model_register_code="$(echo "$invalid_model_register_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_model_register_success" != "false" || "$invalid_model_register_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid model-register payload"
  echo "$invalid_model_register_payload"
  exit 1
fi

invalid_approval_submit_review_notes_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$(jq -nc --arg model_id "$model_id" '{model_id:$model_id,review_notes:123}')" \
  "${BASE_URL}/api/approvals/submit")"
invalid_approval_submit_review_notes_type_success="$(echo "$invalid_approval_submit_review_notes_type_payload" | jq -r '.success // false')"
invalid_approval_submit_review_notes_type_code="$(echo "$invalid_approval_submit_review_notes_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_approval_submit_review_notes_type_success" != "false" || "$invalid_approval_submit_review_notes_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid approvals submit review_notes type"
  echo "$invalid_approval_submit_review_notes_type_payload"
  exit 1
fi

invalid_approval_submit_review_notes_null_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$(jq -nc --arg model_id "$model_id" '{model_id:$model_id,review_notes:null}')" \
  "${BASE_URL}/api/approvals/submit")"
invalid_approval_submit_review_notes_null_success="$(echo "$invalid_approval_submit_review_notes_null_payload" | jq -r '.success // false')"
invalid_approval_submit_review_notes_null_code="$(echo "$invalid_approval_submit_review_notes_null_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_approval_submit_review_notes_null_success" != "false" || "$invalid_approval_submit_review_notes_null_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for null approvals submit review_notes"
  echo "$invalid_approval_submit_review_notes_null_payload"
  exit 1
fi

invalid_llm_save_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/settings/llm")"
invalid_llm_save_success="$(echo "$invalid_llm_save_payload" | jq -r '.success // false')"
invalid_llm_save_code="$(echo "$invalid_llm_save_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_llm_save_success" != "false" || "$invalid_llm_save_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid llm save payload"
  echo "$invalid_llm_save_payload"
  exit 1
fi

invalid_llm_save_keep_existing_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"llm_config":{},"keep_existing_api_key":"true"}' \
  "${BASE_URL}/api/settings/llm")"
invalid_llm_save_keep_existing_type_success="$(echo "$invalid_llm_save_keep_existing_type_payload" | jq -r '.success // false')"
invalid_llm_save_keep_existing_type_code="$(echo "$invalid_llm_save_keep_existing_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_llm_save_keep_existing_type_success" != "false" || "$invalid_llm_save_keep_existing_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid keep_existing_api_key type"
  echo "$invalid_llm_save_keep_existing_type_payload"
  exit 1
fi

invalid_llm_test_use_stored_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"llm_config":{},"use_stored_api_key":"yes"}' \
  "${BASE_URL}/api/settings/llm/test")"
invalid_llm_test_use_stored_type_success="$(echo "$invalid_llm_test_use_stored_type_payload" | jq -r '.success // false')"
invalid_llm_test_use_stored_type_code="$(echo "$invalid_llm_test_use_stored_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_llm_test_use_stored_type_success" != "false" || "$invalid_llm_test_use_stored_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid use_stored_api_key type"
  echo "$invalid_llm_test_use_stored_type_payload"
  exit 1
fi

invalid_runtime_activate_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/settings/runtime/activate-profile")"
invalid_runtime_activate_success="$(echo "$invalid_runtime_activate_payload" | jq -r '.success // false')"
invalid_runtime_activate_code="$(echo "$invalid_runtime_activate_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_runtime_activate_success" != "false" || "$invalid_runtime_activate_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid runtime activate payload"
  echo "$invalid_runtime_activate_payload"
  exit 1
fi

invalid_runtime_auto_config_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"overwrite_endpoint":"false"}' \
  "${BASE_URL}/api/settings/runtime/auto-configure")"
invalid_runtime_auto_config_type_success="$(echo "$invalid_runtime_auto_config_type_payload" | jq -r '.success // false')"
invalid_runtime_auto_config_type_code="$(echo "$invalid_runtime_auto_config_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_runtime_auto_config_type_success" != "false" || "$invalid_runtime_auto_config_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid runtime auto-config overwrite_endpoint type"
  echo "$invalid_runtime_auto_config_type_payload"
  exit 1
fi

invalid_runtime_settings_keep_existing_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"runtime_config":{},"keep_existing_api_keys":"true"}' \
  "${BASE_URL}/api/settings/runtime")"
invalid_runtime_settings_keep_existing_type_success="$(echo "$invalid_runtime_settings_keep_existing_type_payload" | jq -r '.success // false')"
invalid_runtime_settings_keep_existing_type_code="$(echo "$invalid_runtime_settings_keep_existing_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_runtime_settings_keep_existing_type_success" != "false" || "$invalid_runtime_settings_keep_existing_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid keep_existing_api_keys type"
  echo "$invalid_runtime_settings_keep_existing_type_payload"
  exit 1
fi

invalid_runtime_settings_controls_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"runtime_config":{},"runtime_controls":{"disable_inference_fallback":"false"}}' \
  "${BASE_URL}/api/settings/runtime")"
invalid_runtime_settings_controls_type_success="$(echo "$invalid_runtime_settings_controls_type_payload" | jq -r '.success // false')"
invalid_runtime_settings_controls_type_code="$(echo "$invalid_runtime_settings_controls_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_runtime_settings_controls_type_success" != "false" || "$invalid_runtime_settings_controls_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid runtime_controls boolean type"
  echo "$invalid_runtime_settings_controls_type_payload"
  exit 1
fi

invalid_runtime_settings_runtime_config_shape_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"runtime_config":"not-an-object"}' \
  "${BASE_URL}/api/settings/runtime")"
invalid_runtime_settings_runtime_config_shape_success="$(echo "$invalid_runtime_settings_runtime_config_shape_payload" | jq -r '.success // false')"
invalid_runtime_settings_runtime_config_shape_code="$(echo "$invalid_runtime_settings_runtime_config_shape_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_runtime_settings_runtime_config_shape_success" != "false" || "$invalid_runtime_settings_runtime_config_shape_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid runtime_config shape"
  echo "$invalid_runtime_settings_runtime_config_shape_payload"
  exit 1
fi

invalid_runtime_settings_runtime_controls_shape_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"runtime_config":{},"runtime_controls":"not-an-object"}' \
  "${BASE_URL}/api/settings/runtime")"
invalid_runtime_settings_runtime_controls_shape_success="$(echo "$invalid_runtime_settings_runtime_controls_shape_payload" | jq -r '.success // false')"
invalid_runtime_settings_runtime_controls_shape_code="$(echo "$invalid_runtime_settings_runtime_controls_shape_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_runtime_settings_runtime_controls_shape_success" != "false" || "$invalid_runtime_settings_runtime_controls_shape_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid runtime_controls shape"
  echo "$invalid_runtime_settings_runtime_controls_shape_payload"
  exit 1
fi

invalid_runtime_settings_python_bin_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"runtime_config":{},"runtime_controls":{"python_bin":123}}' \
  "${BASE_URL}/api/settings/runtime")"
invalid_runtime_settings_python_bin_type_success="$(echo "$invalid_runtime_settings_python_bin_type_payload" | jq -r '.success // false')"
invalid_runtime_settings_python_bin_type_code="$(echo "$invalid_runtime_settings_python_bin_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_runtime_settings_python_bin_type_success" != "false" || "$invalid_runtime_settings_python_bin_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid runtime_controls.python_bin type"
  echo "$invalid_runtime_settings_python_bin_type_payload"
  exit 1
fi

invalid_approval_approve_json_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"notes":' \
  "${BASE_URL}/api/approvals/ar-nonexistent/approve")"
invalid_approval_approve_json_success="$(echo "$invalid_approval_approve_json_payload" | jq -r '.success // false')"
invalid_approval_approve_json_code="$(echo "$invalid_approval_approve_json_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_approval_approve_json_success" != "false" || "$invalid_approval_approve_json_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for malformed approvals approve JSON"
  echo "$invalid_approval_approve_json_payload"
  exit 1
fi

invalid_approval_approve_notes_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"notes":123}' \
  "${BASE_URL}/api/approvals/ar-nonexistent/approve")"
invalid_approval_approve_notes_type_success="$(echo "$invalid_approval_approve_notes_type_payload" | jq -r '.success // false')"
invalid_approval_approve_notes_type_code="$(echo "$invalid_approval_approve_notes_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_approval_approve_notes_type_success" != "false" || "$invalid_approval_approve_notes_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid approvals approve notes type"
  echo "$invalid_approval_approve_notes_type_payload"
  exit 1
fi

invalid_approval_approve_notes_null_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"notes":null}' \
  "${BASE_URL}/api/approvals/ar-nonexistent/approve")"
invalid_approval_approve_notes_null_success="$(echo "$invalid_approval_approve_notes_null_payload" | jq -r '.success // false')"
invalid_approval_approve_notes_null_code="$(echo "$invalid_approval_approve_notes_null_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_approval_approve_notes_null_success" != "false" || "$invalid_approval_approve_notes_null_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for null approvals approve notes"
  echo "$invalid_approval_approve_notes_null_payload"
  exit 1
fi

invalid_approval_reject_notes_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"reason":"x","notes":123}' \
  "${BASE_URL}/api/approvals/ar-nonexistent/reject")"
invalid_approval_reject_notes_type_success="$(echo "$invalid_approval_reject_notes_type_payload" | jq -r '.success // false')"
invalid_approval_reject_notes_type_code="$(echo "$invalid_approval_reject_notes_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_approval_reject_notes_type_success" != "false" || "$invalid_approval_reject_notes_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid approvals reject notes type"
  echo "$invalid_approval_reject_notes_type_payload"
  exit 1
fi

invalid_approval_reject_notes_null_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"reason":"x","notes":null}' \
  "${BASE_URL}/api/approvals/ar-nonexistent/reject")"
invalid_approval_reject_notes_null_success="$(echo "$invalid_approval_reject_notes_null_payload" | jq -r '.success // false')"
invalid_approval_reject_notes_null_code="$(echo "$invalid_approval_reject_notes_null_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_approval_reject_notes_null_success" != "false" || "$invalid_approval_reject_notes_null_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for null approvals reject notes"
  echo "$invalid_approval_reject_notes_null_payload"
  exit 1
fi

invalid_heartbeat_json_payload="$(curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"name":' \
  "${BASE_URL}/api/runtime/training-workers/heartbeat")"
invalid_heartbeat_json_success="$(echo "$invalid_heartbeat_json_payload" | jq -r '.success // false')"
invalid_heartbeat_json_code="$(echo "$invalid_heartbeat_json_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_heartbeat_json_success" != "false" || "$invalid_heartbeat_json_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for malformed worker heartbeat JSON"
  echo "$invalid_heartbeat_json_payload"
  exit 1
fi

invalid_heartbeat_type_payload="$(curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"name":"worker-smoke","reported_load":"bad-value"}' \
  "${BASE_URL}/api/runtime/training-workers/heartbeat")"
invalid_heartbeat_type_success="$(echo "$invalid_heartbeat_type_payload" | jq -r '.success // false')"
invalid_heartbeat_type_code="$(echo "$invalid_heartbeat_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_heartbeat_type_success" != "false" || "$invalid_heartbeat_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid worker heartbeat reported_load type"
  echo "$invalid_heartbeat_type_payload"
  exit 1
fi

invalid_worker_bootstrap_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"deployment_mode":"k8s","worker_profile":"yolo","control_plane_base_url":"http://127.0.0.1:8080"}' \
  "${BASE_URL}/api/admin/training-workers/bootstrap-sessions")"
invalid_worker_bootstrap_success="$(echo "$invalid_worker_bootstrap_payload" | jq -r '.success // false')"
invalid_worker_bootstrap_code="$(echo "$invalid_worker_bootstrap_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_worker_bootstrap_success" != "false" || "$invalid_worker_bootstrap_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid worker bootstrap deployment_mode"
  echo "$invalid_worker_bootstrap_payload"
  exit 1
fi

invalid_worker_create_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"name":"worker-smoke","status":"paused"}' \
  "${BASE_URL}/api/admin/training-workers")"
invalid_worker_create_success="$(echo "$invalid_worker_create_payload" | jq -r '.success // false')"
invalid_worker_create_code="$(echo "$invalid_worker_create_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_worker_create_success" != "false" || "$invalid_worker_create_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid worker create status enum"
  echo "$invalid_worker_create_payload"
  exit 1
fi

invalid_worker_create_enabled_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"name":"worker-smoke","enabled":"true"}' \
  "${BASE_URL}/api/admin/training-workers")"
invalid_worker_create_enabled_type_success="$(echo "$invalid_worker_create_enabled_type_payload" | jq -r '.success // false')"
invalid_worker_create_enabled_type_code="$(echo "$invalid_worker_create_enabled_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_worker_create_enabled_type_success" != "false" || "$invalid_worker_create_enabled_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid worker create enabled type"
  echo "$invalid_worker_create_enabled_type_payload"
  exit 1
fi

invalid_worker_patch_payload="$(curl -sS -X PATCH -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"max_concurrency":"heavy"}' \
  "${BASE_URL}/api/admin/training-workers/tw-nonexistent")"
invalid_worker_patch_success="$(echo "$invalid_worker_patch_payload" | jq -r '.success // false')"
invalid_worker_patch_code="$(echo "$invalid_worker_patch_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_worker_patch_success" != "false" || "$invalid_worker_patch_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid worker patch max_concurrency type"
  echo "$invalid_worker_patch_payload"
  exit 1
fi

invalid_worker_patch_endpoint_type_payload="$(curl -sS -X PATCH -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"endpoint":123}' \
  "${BASE_URL}/api/admin/training-workers/tw-nonexistent")"
invalid_worker_patch_endpoint_type_success="$(echo "$invalid_worker_patch_endpoint_type_payload" | jq -r '.success // false')"
invalid_worker_patch_endpoint_type_code="$(echo "$invalid_worker_patch_endpoint_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_worker_patch_endpoint_type_success" != "false" || "$invalid_worker_patch_endpoint_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid worker patch endpoint type"
  echo "$invalid_worker_patch_endpoint_type_payload"
  exit 1
fi

invalid_heartbeat_capabilities_type_payload="$(curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"name":"worker-smoke","capabilities":[1]}' \
  "${BASE_URL}/api/runtime/training-workers/heartbeat")"
invalid_heartbeat_capabilities_type_success="$(echo "$invalid_heartbeat_capabilities_type_payload" | jq -r '.success // false')"
invalid_heartbeat_capabilities_type_code="$(echo "$invalid_heartbeat_capabilities_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_heartbeat_capabilities_type_success" != "false" || "$invalid_heartbeat_capabilities_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid heartbeat capabilities type"
  echo "$invalid_heartbeat_capabilities_type_payload"
  exit 1
fi

invalid_file_upload_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/files/conversation/upload")"
invalid_file_upload_success="$(echo "$invalid_file_upload_payload" | jq -r '.success // false')"
invalid_file_upload_code="$(echo "$invalid_file_upload_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_file_upload_success" != "false" || "$invalid_file_upload_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid conversation filename upload payload"
  echo "$invalid_file_upload_payload"
  exit 1
fi

invalid_model_draft_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/models/draft")"
invalid_model_draft_success="$(echo "$invalid_model_draft_payload" | jq -r '.success // false')"
invalid_model_draft_code="$(echo "$invalid_model_draft_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_model_draft_success" != "false" || "$invalid_model_draft_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid model draft payload"
  echo "$invalid_model_draft_payload"
  exit 1
fi

invalid_dataset_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/datasets")"
invalid_dataset_success="$(echo "$invalid_dataset_payload" | jq -r '.success // false')"
invalid_dataset_code="$(echo "$invalid_dataset_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_dataset_success" != "false" || "$invalid_dataset_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid dataset payload"
  echo "$invalid_dataset_payload"
  exit 1
fi

invalid_dataset_json_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"name":' \
  "${BASE_URL}/api/datasets")"
invalid_dataset_json_success="$(echo "$invalid_dataset_json_payload" | jq -r '.success // false')"
invalid_dataset_json_code="$(echo "$invalid_dataset_json_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_dataset_json_success" != "false" || "$invalid_dataset_json_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for malformed dataset JSON"
  echo "$invalid_dataset_json_payload"
  exit 1
fi

invalid_dataset_item_split_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"filename":"sample.jpg","split":"holdout"}' \
  "${BASE_URL}/api/datasets/d-nonexistent/items")"
invalid_dataset_item_split_success="$(echo "$invalid_dataset_item_split_payload" | jq -r '.success // false')"
invalid_dataset_item_split_code="$(echo "$invalid_dataset_item_split_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_dataset_item_split_success" != "false" || "$invalid_dataset_item_split_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid dataset item split enum"
  echo "$invalid_dataset_item_split_payload"
  exit 1
fi

invalid_dataset_split_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"train_ratio":"0.7","val_ratio":0.2,"test_ratio":0.1,"seed":42}' \
  "${BASE_URL}/api/datasets/d-nonexistent/split")"
invalid_dataset_split_type_success="$(echo "$invalid_dataset_split_type_payload" | jq -r '.success // false')"
invalid_dataset_split_type_code="$(echo "$invalid_dataset_split_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_dataset_split_type_success" != "false" || "$invalid_dataset_split_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid dataset split number types"
  echo "$invalid_dataset_split_type_payload"
  exit 1
fi

invalid_dataset_version_name_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"version_name":123}' \
  "${BASE_URL}/api/datasets/d-nonexistent/versions")"
invalid_dataset_version_name_type_success="$(echo "$invalid_dataset_version_name_type_payload" | jq -r '.success // false')"
invalid_dataset_version_name_type_code="$(echo "$invalid_dataset_version_name_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_dataset_version_name_type_success" != "false" || "$invalid_dataset_version_name_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid dataset version_name type"
  echo "$invalid_dataset_version_name_type_payload"
  exit 1
fi

invalid_pre_annotations_model_version_type_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{"model_version_id":123}' \
  "${BASE_URL}/api/datasets/d-nonexistent/pre-annotations")"
invalid_pre_annotations_model_version_type_success="$(echo "$invalid_pre_annotations_model_version_type_payload" | jq -r '.success // false')"
invalid_pre_annotations_model_version_type_code="$(echo "$invalid_pre_annotations_model_version_type_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_pre_annotations_model_version_type_success" != "false" || "$invalid_pre_annotations_model_version_type_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid pre-annotations model_version_id type"
  echo "$invalid_pre_annotations_model_version_type_payload"
  exit 1
fi

start_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$(jq -nc --arg model_id "$model_id" '{model_id:$model_id,initial_message:"hi"}')" \
  "${BASE_URL}/api/conversations/start")"
conversation_id="$(echo "$start_payload" | jq -r '.data.conversation.id // empty')"
start_user_attachment_ids="$(echo "$start_payload" | jq -c '.data.messages[] | select(.sender=="user") | .attachment_ids' | head -n 1)"
if [[ -z "$conversation_id" ]]; then
  echo "[smoke-conversation-ops-bridge] failed to start conversation"
  echo "$start_payload"
  exit 1
fi
if [[ "$start_user_attachment_ids" != "[]" ]]; then
  echo "[smoke-conversation-ops-bridge] expected omitted attachment_ids to normalize as []"
  echo "$start_payload"
  exit 1
fi

invalid_rename_payload="$(curl -sS -X PATCH -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d '{}' \
  "${BASE_URL}/api/conversations/${conversation_id}")"
invalid_rename_success="$(echo "$invalid_rename_payload" | jq -r '.success // false')"
invalid_rename_code="$(echo "$invalid_rename_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_rename_success" != "false" || "$invalid_rename_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for invalid conversation rename payload"
  echo "$invalid_rename_payload"
  exit 1
fi

msg_without_attachments_field="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$(jq -nc --arg cid "$conversation_id" '{conversation_id:$cid,content:"no attachment field message"}')" \
  "${BASE_URL}/api/conversations/message")"
msg_without_attachments_ids="$(echo "$msg_without_attachments_field" | jq -c '.data.messages[] | select(.sender=="user") | .attachment_ids' | tail -n 1)"
if [[ "$msg_without_attachments_ids" != "[]" ]]; then
  echo "[smoke-conversation-ops-bridge] expected omitted message attachment_ids to normalize as []"
  echo "$msg_without_attachments_field"
  exit 1
fi

invalid_message_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: $csrf_token" \
  -d "$(jq -nc --arg cid "$conversation_id" '{conversation_id:$cid}')" \
  "${BASE_URL}/api/conversations/message")"
invalid_message_success="$(echo "$invalid_message_payload" | jq -r '.success // false')"
invalid_message_code="$(echo "$invalid_message_payload" | jq -r '.error.code // empty')"
if [[ "$invalid_message_success" != "false" || "$invalid_message_code" != "VALIDATION_ERROR" ]]; then
  echo "[smoke-conversation-ops-bridge] expected validation error for missing content"
  echo "$invalid_message_payload"
  exit 1
fi

send_message() {
  local content="$1"
  curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: $csrf_token" \
    -d "$(jq -nc --arg cid "$conversation_id" --arg c "$content" '{conversation_id:$cid,content:$c,attachment_ids:[]}')" \
    "${BASE_URL}/api/conversations/message"
}

msg_read="$(send_message "帮我查看训练任务")"
read_action="$(echo "$msg_read" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
read_status="$(echo "$msg_read" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
read_first_link="$(echo "$msg_read" | jq -r '.data.messages[-1].metadata.conversation_action.action_links[0].href // empty')"
if [[ "$read_action" != "console_api_call" || "$read_status" != "completed" ]]; then
  echo "[smoke-conversation-ops-bridge] expected list-training-jobs action completed"
  echo "$msg_read"
  exit 1
fi
if [[ "$read_first_link" != "/training/jobs" ]]; then
  echo "[smoke-conversation-ops-bridge] expected training-jobs action link on list_training_jobs"
  echo "$msg_read"
  exit 1
fi

msg_missing="$(send_message "取消训练任务")"
missing_status="$(echo "$msg_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
missing_fields="$(echo "$msg_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
if [[ "$missing_status" != "requires_input" || "$missing_fields" != *"job_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected missing job_id"
  echo "$msg_missing"
  exit 1
fi

msg_fill="$(send_message "tj-det-1")"
fill_status="$(echo "$msg_fill" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
fill_requires_confirm="$(echo "$msg_fill" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
fill_missing="$(echo "$msg_fill" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
fill_confirmation_phrase="$(echo "$msg_fill" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$fill_status" != "requires_input" || "$fill_requires_confirm" != "true" || "$fill_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation requirement after filling job_id"
  echo "$msg_fill"
  exit 1
fi
if [[ -z "$fill_confirmation_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation phrase for high-risk API"
  echo "$msg_fill"
  exit 1
fi
if [[ "$fill_confirmation_phrase" != "确认执行" ]]; then
  echo "[smoke-conversation-ops-bridge] expected zh confirmation phrase continuity for zh intent flow"
  echo "$msg_fill"
  exit 1
fi

msg_wrong_confirm="$(send_message "yes, execute")"
wrong_confirm_status="$(echo "$msg_wrong_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
wrong_confirm_missing="$(echo "$msg_wrong_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
if [[ "$wrong_confirm_status" != "requires_input" || "$wrong_confirm_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected strict confirmation phrase guard before execution"
  echo "$msg_wrong_confirm"
  exit 1
fi

msg_confirm="$(send_message "$fill_confirmation_phrase")"
confirm_action="$(echo "$msg_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
confirm_status="$(echo "$msg_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
if [[ "$confirm_action" != "console_api_call" ]]; then
  echo "[smoke-conversation-ops-bridge] expected console_api_call after confirmation"
  echo "$msg_confirm"
  exit 1
fi
if [[ "$confirm_status" != "completed" && "$confirm_status" != "failed" ]]; then
  echo "[smoke-conversation-ops-bridge] expected terminal status after confirmation"
  echo "$msg_confirm"
  exit 1
fi

msg_export_missing="$(send_message "导出标注")"
export_status="$(echo "$msg_export_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
export_missing="$(echo "$msg_export_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
export_first_link="$(echo "$msg_export_missing" | jq -r '.data.messages[-1].metadata.conversation_action.action_links[0].href // empty')"
if [[ "$export_status" != "requires_input" || "$export_missing" != *"dataset_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected missing dataset_id on export"
  echo "$msg_export_missing"
  exit 1
fi
if [[ "$export_first_link" != "/datasets" ]]; then
  echo "[smoke-conversation-ops-bridge] expected dataset action link on export missing-card"
  echo "$msg_export_missing"
  exit 1
fi

msg_review_missing="$(send_message "审核标注通过")"
review_missing_status="$(echo "$msg_review_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
review_missing_fields="$(echo "$msg_review_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
review_first_link="$(echo "$msg_review_missing" | jq -r '.data.messages[-1].metadata.conversation_action.action_links[0].href // empty')"
if [[ "$review_missing_status" != "requires_input" || "$review_missing_fields" != *"annotation_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected intent switch and missing annotation_id for review"
  echo "$msg_review_missing"
  exit 1
fi
if [[ "$review_first_link" != "/datasets" ]]; then
  echo "[smoke-conversation-ops-bridge] expected dataset action link on review missing-card"
  echo "$msg_review_missing"
  exit 1
fi

msg_review_fill="$(send_message "ann-1")"
review_fill_status="$(echo "$msg_review_fill" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
review_fill_requires_confirm="$(echo "$msg_review_fill" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
review_fill_missing="$(echo "$msg_review_fill" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
review_confirmation_phrase="$(echo "$msg_review_fill" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$review_fill_status" != "requires_input" || "$review_fill_requires_confirm" != "true" || "$review_fill_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation requirement after filling annotation_id"
  echo "$msg_review_fill"
  exit 1
fi
if [[ -z "$review_confirmation_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation phrase for review high-risk API"
  echo "$msg_review_fill"
  exit 1
fi
if [[ "$review_confirmation_phrase" != "确认执行" ]]; then
  echo "[smoke-conversation-ops-bridge] expected zh confirmation phrase continuity for zh review flow"
  echo "$msg_review_fill"
  exit 1
fi

msg_review_confirm="$(send_message "$review_confirmation_phrase")"
review_confirm_action="$(echo "$msg_review_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
review_confirm_status="$(echo "$msg_review_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
if [[ "$review_confirm_action" != "console_api_call" ]]; then
  echo "[smoke-conversation-ops-bridge] expected console_api_call after review confirmation"
  echo "$msg_review_confirm"
  exit 1
fi
if [[ "$review_confirm_status" != "completed" && "$review_confirm_status" != "failed" ]]; then
  echo "[smoke-conversation-ops-bridge] expected terminal review status after confirmation"
  echo "$msg_review_confirm"
  exit 1
fi

# /ops json branch: create_dataset required params -> confirmation gate
msg_create_dataset_missing="$(send_message "/ops {\"api\":\"create_dataset\",\"params\":{\"task_type\":\"ocr\"}}")"
create_dataset_missing_status="$(echo "$msg_create_dataset_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
create_dataset_missing_fields="$(echo "$msg_create_dataset_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
if [[ "$create_dataset_missing_status" != "requires_input" || "$create_dataset_missing_fields" != *"name"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops create_dataset missing required name"
  echo "$msg_create_dataset_missing"
  exit 1
fi

msg_create_dataset_fill="$(send_message "'ops-bridge-ocr-dataset'")"
create_dataset_fill_status="$(echo "$msg_create_dataset_fill" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
create_dataset_fill_requires_confirm="$(echo "$msg_create_dataset_fill" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
create_dataset_fill_missing="$(echo "$msg_create_dataset_fill" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
create_dataset_fill_phrase="$(echo "$msg_create_dataset_fill" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$create_dataset_fill_status" != "requires_input" || "$create_dataset_fill_requires_confirm" != "true" || "$create_dataset_fill_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops create_dataset to enter confirmation gate after filling name"
  echo "$msg_create_dataset_fill"
  exit 1
fi
if [[ -z "$create_dataset_fill_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops create_dataset confirmation phrase"
  echo "$msg_create_dataset_fill"
  exit 1
fi

msg_create_dataset_wrong_followup="$(send_message "random text")"
create_dataset_wrong_followup_status="$(echo "$msg_create_dataset_wrong_followup" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
create_dataset_wrong_followup_missing="$(echo "$msg_create_dataset_wrong_followup" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
create_dataset_wrong_followup_phrase="$(echo "$msg_create_dataset_wrong_followup" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$create_dataset_wrong_followup_status" != "requires_input" || "$create_dataset_wrong_followup_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops create_dataset confirmation to remain pending after non-confirmation follow-up"
  echo "$msg_create_dataset_wrong_followup"
  exit 1
fi
if [[ "$create_dataset_wrong_followup_phrase" != "$create_dataset_fill_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops create_dataset confirmation phrase continuity"
  echo "$msg_create_dataset_wrong_followup"
  exit 1
fi

# /ops json branch: create_training_job multi-field required params (without final execute)
msg_create_job_missing="$(send_message "/ops {\"api\":\"create_training_job\",\"params\":{\"task_type\":\"detection\",\"framework\":\"yolo\"}}")"
create_job_missing_status="$(echo "$msg_create_job_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
create_job_missing_fields="$(echo "$msg_create_job_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
if [[ "$create_job_missing_status" != "requires_input" || "$create_job_missing_fields" != *"name"* || "$create_job_missing_fields" != *"dataset_id"* || "$create_job_missing_fields" != *"dataset_version_id"* || "$create_job_missing_fields" != *"base_model"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops create_training_job to report all required missing fields"
  echo "$msg_create_job_missing"
  exit 1
fi

msg_create_job_fill_name="$(send_message "'ops-bridge-train-job'")"
create_job_fill_name_status="$(echo "$msg_create_job_fill_name" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
create_job_fill_name_fields="$(echo "$msg_create_job_fill_name" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
create_job_fill_name_requires_confirm="$(echo "$msg_create_job_fill_name" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
if [[ "$create_job_fill_name_status" != "requires_input" || "$create_job_fill_name_fields" == *"name"* || "$create_job_fill_name_fields" != *"dataset_id"* || "$create_job_fill_name_requires_confirm" != "false" ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops create_training_job follow-up to consume name and keep remaining required fields"
  echo "$msg_create_job_fill_name"
  exit 1
fi

# /ops json branch: missing params -> continue fill -> high-risk confirmation -> execute
datasets_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/datasets")"
dataset_id="$(echo "$datasets_payload" | jq -r '.data[0].id // empty')"
if [[ -z "$dataset_id" ]]; then
  echo "[smoke-conversation-ops-bridge] no dataset available for /ops pre-annotation test"
  echo "$datasets_payload"
  exit 1
fi

model_versions_payload="$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" "${BASE_URL}/api/model-versions")"
model_version_id="$(echo "$model_versions_payload" | jq -r '.data[0].id // empty')"
if [[ -z "$model_version_id" ]]; then
  echo "[smoke-conversation-ops-bridge] no model version available for /ops pre-annotation test"
  echo "$model_versions_payload"
  exit 1
fi

msg_ops_missing="$(send_message "/ops {\"api\":\"run_dataset_pre_annotations\",\"params\":{\"dataset_id\":\"${dataset_id}\"}}")"
ops_missing_status="$(echo "$msg_ops_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
ops_missing_fields="$(echo "$msg_ops_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
if [[ "$ops_missing_status" != "requires_input" || "$ops_missing_fields" != *"model_version_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops missing model_version_id for run_dataset_pre_annotations"
  echo "$msg_ops_missing"
  exit 1
fi

msg_ops_fill="$(send_message "$model_version_id")"
ops_fill_status="$(echo "$msg_ops_fill" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
ops_fill_requires_confirm="$(echo "$msg_ops_fill" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
ops_fill_missing="$(echo "$msg_ops_fill" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
ops_fill_confirmation_phrase="$(echo "$msg_ops_fill" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$ops_fill_status" != "requires_input" || "$ops_fill_requires_confirm" != "true" || "$ops_fill_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops confirmation gate after filling model_version_id"
  echo "$msg_ops_fill"
  exit 1
fi
if [[ -z "$ops_fill_confirmation_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops confirmation phrase"
  echo "$msg_ops_fill"
  exit 1
fi

msg_ops_wrong_followup="$(send_message "not_confirmation_payload")"
ops_wrong_followup_status="$(echo "$msg_ops_wrong_followup" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
ops_wrong_followup_missing="$(echo "$msg_ops_wrong_followup" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
ops_wrong_followup_phrase="$(echo "$msg_ops_wrong_followup" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$ops_wrong_followup_status" != "requires_input" || "$ops_wrong_followup_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops pending confirmation to remain required after non-confirmation follow-up"
  echo "$msg_ops_wrong_followup"
  exit 1
fi
if [[ "$ops_wrong_followup_phrase" != "$ops_fill_confirmation_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops confirmation phrase continuity across follow-up turns"
  echo "$msg_ops_wrong_followup"
  exit 1
fi

if is_truthy "$SMOKE_OPS_BRIDGE_EXECUTE_MUTATIONS"; then
  msg_ops_confirm="$(send_message "$ops_fill_confirmation_phrase")"
  ops_confirm_action="$(echo "$msg_ops_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
  ops_confirm_status="$(echo "$msg_ops_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
  if [[ "$ops_confirm_action" != "console_api_call" ]]; then
    echo "[smoke-conversation-ops-bridge] expected console_api_call after /ops confirmation"
    echo "$msg_ops_confirm"
    exit 1
  fi
  if [[ "$ops_confirm_status" != "completed" && "$ops_confirm_status" != "failed" ]]; then
    echo "[smoke-conversation-ops-bridge] expected terminal status after /ops confirmation"
    echo "$msg_ops_confirm"
    exit 1
  fi
fi

# natural-language runtime profile switch with plain token should not require profile_id again
msg_nl_profile_switch="$(send_message "切换 runtime profile saved")"
nl_profile_status="$(echo "$msg_nl_profile_switch" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
nl_profile_missing="$(echo "$msg_nl_profile_switch" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
nl_profile_requires_confirm="$(echo "$msg_nl_profile_switch" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
nl_profile_confirmation_phrase="$(echo "$msg_nl_profile_switch" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$nl_profile_status" != "requires_input" || "$nl_profile_requires_confirm" != "true" || "$nl_profile_missing" != *"confirmation"* || "$nl_profile_missing" == *"profile_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected natural runtime profile switch to reach confirmation gate directly"
  echo "$msg_nl_profile_switch"
  exit 1
fi
if [[ -z "$nl_profile_confirmation_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation phrase for natural runtime profile switch"
  echo "$msg_nl_profile_switch"
  exit 1
fi

if is_truthy "$SMOKE_OPS_BRIDGE_EXECUTE_MUTATIONS"; then
  msg_nl_profile_confirm="$(send_message "$nl_profile_confirmation_phrase")"
  nl_profile_confirm_action="$(echo "$msg_nl_profile_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
  nl_profile_confirm_status="$(echo "$msg_nl_profile_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
  if [[ "$nl_profile_confirm_action" != "console_api_call" ]]; then
    echo "[smoke-conversation-ops-bridge] expected console_api_call after natural runtime profile confirmation"
    echo "$msg_nl_profile_confirm"
    exit 1
  fi
  if [[ "$nl_profile_confirm_status" != "completed" && "$nl_profile_confirm_status" != "failed" ]]; then
    echo "[smoke-conversation-ops-bridge] expected terminal status after natural runtime profile confirmation"
    echo "$msg_nl_profile_confirm"
    exit 1
  fi
fi

# /ops json branch: runtime profile activation missing params -> continue fill -> high-risk confirmation
msg_profile_missing="$(send_message "/ops {\"api\":\"activate_runtime_profile\",\"params\":{}}")"
profile_missing_status="$(echo "$msg_profile_missing" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
profile_missing_fields="$(echo "$msg_profile_missing" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
profile_missing_link="$(echo "$msg_profile_missing" | jq -r '.data.messages[-1].metadata.conversation_action.action_links[0].href // empty')"
profile_missing_suggestion="$(echo "$msg_profile_missing" | jq -r '.data.messages[-1].metadata.conversation_action.suggestions[0] // empty')"
if [[ "$profile_missing_status" != "requires_input" || "$profile_missing_fields" != *"profile_id"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops missing profile_id for activate_runtime_profile"
  echo "$msg_profile_missing"
  exit 1
fi
if [[ "$profile_missing_link" != "/settings/runtime" ]]; then
  echo "[smoke-conversation-ops-bridge] expected runtime settings action link on activate_runtime_profile missing-card"
  echo "$msg_profile_missing"
  exit 1
fi

if [[ -z "$profile_missing_suggestion" ]]; then
  echo "[smoke-conversation-ops-bridge] expected runtime profile suggestions for activate_runtime_profile"
  echo "$msg_profile_missing"
  exit 1
fi

msg_profile_fill="$(send_message "$profile_missing_suggestion")"
profile_fill_status="$(echo "$msg_profile_fill" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
profile_fill_requires_confirm="$(echo "$msg_profile_fill" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
profile_fill_missing="$(echo "$msg_profile_fill" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
profile_fill_confirmation_phrase="$(echo "$msg_profile_fill" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
if [[ "$profile_fill_status" != "requires_input" || "$profile_fill_requires_confirm" != "true" || "$profile_fill_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops confirmation gate after filling runtime profile id"
  echo "$msg_profile_fill"
  exit 1
fi
if [[ -z "$profile_fill_confirmation_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops confirmation phrase for activate_runtime_profile"
  echo "$msg_profile_fill"
  exit 1
fi

if is_truthy "$SMOKE_OPS_BRIDGE_EXECUTE_MUTATIONS"; then
  msg_profile_confirm="$(send_message "$profile_fill_confirmation_phrase")"
  profile_confirm_action="$(echo "$msg_profile_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
  profile_confirm_status="$(echo "$msg_profile_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
  if [[ "$profile_confirm_action" != "console_api_call" ]]; then
    echo "[smoke-conversation-ops-bridge] expected console_api_call after activate_runtime_profile confirmation"
    echo "$msg_profile_confirm"
    exit 1
  fi
  if [[ "$profile_confirm_status" != "completed" && "$profile_confirm_status" != "failed" ]]; then
    echo "[smoke-conversation-ops-bridge] expected terminal status after activate_runtime_profile confirmation"
    echo "$msg_profile_confirm"
    exit 1
  fi
fi

# /ops json branch: runtime auto-config should require confirmation and expose runtime settings link
msg_runtime_auto_config="$(send_message "/ops {\"api\":\"auto_configure_runtime_settings\",\"params\":{}}")"
runtime_auto_config_status="$(echo "$msg_runtime_auto_config" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
runtime_auto_config_requires_confirm="$(echo "$msg_runtime_auto_config" | jq -r '.data.messages[-1].metadata.conversation_action.requires_confirmation // false')"
runtime_auto_config_missing="$(echo "$msg_runtime_auto_config" | jq -r '.data.messages[-1].metadata.conversation_action.missing_fields | join(",")')"
runtime_auto_config_phrase="$(echo "$msg_runtime_auto_config" | jq -r '.data.messages[-1].metadata.conversation_action.confirmation_phrase // empty')"
runtime_auto_config_link="$(echo "$msg_runtime_auto_config" | jq -r '.data.messages[-1].metadata.conversation_action.action_links[0].href // empty')"
if [[ "$runtime_auto_config_status" != "requires_input" || "$runtime_auto_config_requires_confirm" != "true" || "$runtime_auto_config_missing" != *"confirmation"* ]]; then
  echo "[smoke-conversation-ops-bridge] expected /ops auto_configure_runtime_settings to enter confirmation gate"
  echo "$msg_runtime_auto_config"
  exit 1
fi
if [[ "$runtime_auto_config_link" != "/settings/runtime" ]]; then
  echo "[smoke-conversation-ops-bridge] expected runtime settings action link on auto_configure_runtime_settings card"
  echo "$msg_runtime_auto_config"
  exit 1
fi
if [[ -z "$runtime_auto_config_phrase" ]]; then
  echo "[smoke-conversation-ops-bridge] expected confirmation phrase for auto_configure_runtime_settings"
  echo "$msg_runtime_auto_config"
  exit 1
fi

if is_truthy "$SMOKE_OPS_BRIDGE_EXECUTE_MUTATIONS"; then
  msg_runtime_auto_config_confirm="$(send_message "$runtime_auto_config_phrase")"
  runtime_auto_config_confirm_action="$(echo "$msg_runtime_auto_config_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.action // empty')"
  runtime_auto_config_confirm_status="$(echo "$msg_runtime_auto_config_confirm" | jq -r '.data.messages[-1].metadata.conversation_action.status // empty')"
  if [[ "$runtime_auto_config_confirm_action" != "console_api_call" ]]; then
    echo "[smoke-conversation-ops-bridge] expected console_api_call after auto_configure_runtime_settings confirmation"
    echo "$msg_runtime_auto_config_confirm"
    exit 1
  fi
  if [[ "$runtime_auto_config_confirm_status" != "completed" && "$runtime_auto_config_confirm_status" != "failed" ]]; then
    echo "[smoke-conversation-ops-bridge] expected terminal status after auto_configure_runtime_settings confirmation"
    echo "$msg_runtime_auto_config_confirm"
    exit 1
  fi
fi

echo "[smoke-conversation-ops-bridge] PASS"
