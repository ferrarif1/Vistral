#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
BUSINESS_USERNAME="${BUSINESS_USERNAME:-alice}"
BUSINESS_PASSWORD="${BUSINESS_PASSWORD:-mock-pass}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-mock-pass-admin}"
PROBE_USERNAME="${PROBE_USERNAME:-${BUSINESS_USERNAME}}"
PROBE_PASSWORD="${PROBE_PASSWORD:-${BUSINESS_PASSWORD}}"
POLL_MAX_TRIES="${POLL_MAX_TRIES:-20}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-0.3}"
VERIFY_SKIP_HEALTHZ="${VERIFY_SKIP_HEALTHZ:-0}"
OCR_CLOSURE_STRICT_LOCAL_COMMAND="${OCR_CLOSURE_STRICT_LOCAL_COMMAND:-false}"
REAL_CLOSURE_STRICT_REGISTRATION="${REAL_CLOSURE_STRICT_REGISTRATION:-false}"
RUN_TAG="$(date +%Y%m%d%H%M%S)"
REPORT_DIR="${REPORT_DIR:-.data/verify-reports}"
REPORT_BASENAME="${REPORT_BASENAME:-docker-verify-full-${RUN_TAG}}"
REPORT_JSON_PATH="${REPORT_DIR}/${REPORT_BASENAME}.json"
REPORT_MD_PATH="${REPORT_DIR}/${REPORT_BASENAME}.md"

if ! command -v jq >/dev/null 2>&1; then
  echo "[docker-verify-full] jq is required but not found."
  exit 1
fi

PROBE_COOKIE="$(mktemp)"
BUSINESS_COOKIE="$(mktemp)"
STARTED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CHECKS_JSON='[]'
CURRENT_STEP=''
REPORT_FINALIZED='false'

CONVERSATION_ID=''
CONVERSATION_MODEL_ID=''
MODEL_ID=''
APPROVAL_ID=''
DETECTION_RUN_ID=''
OCR_RUN_ID=''
ATTACHMENT_ID=''
DEDICATED_REFERENCE_WORKER_ID=''
DEDICATED_REFERENCE_JOB_ID=''
DEDICATED_CANCEL_WORKER_ID=''
DEDICATED_CANCEL_JOB_ID=''
DEDICATED_TRAINING_DATASET_ID=''
DEDICATED_TRAINING_DATASET_VERSION_ID=''
RUNTIME_METRICS_RETENTION_JSON='null'
CONVERSATION_UPLOAD_FILE="$(mktemp)"
MODEL_UPLOAD_FILE="$(mktemp)"

cleanup() {
  rm -f "${PROBE_COOKIE}" "${BUSINESS_COOKIE}" "${CONVERSATION_UPLOAD_FILE}" "${MODEL_UPLOAD_FILE}"
}
trap cleanup EXIT

append_check() {
  local name="$1"
  local status="$2"
  local detail="${3:-}"

  CHECKS_JSON="$(echo "${CHECKS_JSON}" | jq --arg name "${name}" --arg status "${status}" --arg detail "${detail}" '. + [{name:$name,status:$status,detail:$detail}]')"
}

finalize_report() {
  local overall_status="$1"
  local summary="$2"

  if [[ "${REPORT_FINALIZED}" == 'true' ]]; then
    return
  fi

  REPORT_FINALIZED='true'
  mkdir -p "${REPORT_DIR}"

  local finished_at_utc
  finished_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  jq -n \
    --arg status "${overall_status}" \
    --arg summary "${summary}" \
    --arg started_at_utc "${STARTED_AT_UTC}" \
    --arg finished_at_utc "${finished_at_utc}" \
    --arg base_url "${BASE_URL}" \
    --arg business_username "${BUSINESS_USERNAME}" \
    --arg probe_username "${PROBE_USERNAME}" \
    --arg conversation_id "${CONVERSATION_ID}" \
    --arg conversation_model_id "${CONVERSATION_MODEL_ID}" \
    --arg model_id "${MODEL_ID}" \
    --arg approval_id "${APPROVAL_ID}" \
    --arg detection_run_id "${DETECTION_RUN_ID}" \
    --arg ocr_run_id "${OCR_RUN_ID}" \
    --arg attachment_id "${ATTACHMENT_ID}" \
    --arg dedicated_reference_worker_id "${DEDICATED_REFERENCE_WORKER_ID}" \
    --arg dedicated_reference_job_id "${DEDICATED_REFERENCE_JOB_ID}" \
    --arg dedicated_cancel_worker_id "${DEDICATED_CANCEL_WORKER_ID}" \
    --arg dedicated_cancel_job_id "${DEDICATED_CANCEL_JOB_ID}" \
    --arg dedicated_training_dataset_id "${DEDICATED_TRAINING_DATASET_ID}" \
    --arg dedicated_training_dataset_version_id "${DEDICATED_TRAINING_DATASET_VERSION_ID}" \
    --argjson checks "${CHECKS_JSON}" \
    --argjson runtime_metrics_retention "${RUNTIME_METRICS_RETENTION_JSON}" \
    '{
      status: $status,
      summary: $summary,
      started_at_utc: $started_at_utc,
      finished_at_utc: $finished_at_utc,
      target: {
        base_url: $base_url,
        business_username: $business_username,
        probe_username: $probe_username
      },
      entities: {
        conversation_id: $conversation_id,
        conversation_model_id: $conversation_model_id,
        model_id: $model_id,
        approval_id: $approval_id,
        detection_run_id: $detection_run_id,
        ocr_run_id: $ocr_run_id,
        attachment_id: $attachment_id,
        dedicated_reference_worker_id: $dedicated_reference_worker_id,
        dedicated_reference_job_id: $dedicated_reference_job_id,
        dedicated_cancel_worker_id: $dedicated_cancel_worker_id,
        dedicated_cancel_job_id: $dedicated_cancel_job_id,
        dedicated_training_dataset_id: $dedicated_training_dataset_id,
        dedicated_training_dataset_version_id: $dedicated_training_dataset_version_id
      },
      checks: $checks,
      runtime_metrics_retention: $runtime_metrics_retention
    }' > "${REPORT_JSON_PATH}"

  local check_rows
  check_rows="$(jq -r '.checks[] | "| " + .name + " | " + .status + " | " + (.detail // "") + " |"' "${REPORT_JSON_PATH}")"
  local retention_current retention_total_cap retention_per_job_cap retention_near_cap
  retention_current="$(jq -r '.runtime_metrics_retention.current_total_rows // "n/a"' "${REPORT_JSON_PATH}")"
  retention_total_cap="$(jq -r '.runtime_metrics_retention.max_total_rows // "n/a"' "${REPORT_JSON_PATH}")"
  retention_per_job_cap="$(jq -r '.runtime_metrics_retention.max_points_per_job // "n/a"' "${REPORT_JSON_PATH}")"
  retention_near_cap="$(jq -r '.runtime_metrics_retention.near_total_cap // "n/a"' "${REPORT_JSON_PATH}")"

  cat > "${REPORT_MD_PATH}" <<MD
# Docker Verify Full Report

- Status: **${overall_status}**
- Summary: ${summary}
- Started (UTC): ${STARTED_AT_UTC}
- Finished (UTC): ${finished_at_utc}
- Base URL: ${BASE_URL}
- Business User: ${BUSINESS_USERNAME}
- Probe User: ${PROBE_USERNAME}

## Key IDs
- attachment_id: ${ATTACHMENT_ID}
- conversation_id: ${CONVERSATION_ID}
- conversation_model_id: ${CONVERSATION_MODEL_ID}
- model_id: ${MODEL_ID}
- approval_id: ${APPROVAL_ID}
- detection_run_id: ${DETECTION_RUN_ID}
- ocr_run_id: ${OCR_RUN_ID}
- dedicated_reference_worker_id: ${DEDICATED_REFERENCE_WORKER_ID}
- dedicated_reference_job_id: ${DEDICATED_REFERENCE_JOB_ID}
- dedicated_cancel_worker_id: ${DEDICATED_CANCEL_WORKER_ID}
- dedicated_cancel_job_id: ${DEDICATED_CANCEL_JOB_ID}
- dedicated_training_dataset_id: ${DEDICATED_TRAINING_DATASET_ID}
- dedicated_training_dataset_version_id: ${DEDICATED_TRAINING_DATASET_VERSION_ID}

## Runtime Metrics Retention
- current_total_rows: ${retention_current}
- max_total_rows: ${retention_total_cap}
- max_points_per_job: ${retention_per_job_cap}
- near_total_cap: ${retention_near_cap}

## Checks
| Check | Status | Detail |
| --- | --- | --- |
${check_rows}
MD
}

on_error() {
  local exit_code="$1"
  local line="$2"
  local cmd="$3"

  trap - ERR

  if [[ -n "${CURRENT_STEP}" ]]; then
    append_check "${CURRENT_STEP}" "failed" "line ${line}: ${cmd}"
  fi

  finalize_report "failed" "verification failed"

  echo "[docker-verify-full] FAILED"
  echo "  report_json=${REPORT_JSON_PATH}"
  echo "  report_md=${REPORT_MD_PATH}"
  exit "${exit_code}"
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

get_csrf_token() {
  local cookie_file="$1"
  curl -fsS -c "${cookie_file}" -b "${cookie_file}" \
    "${BASE_URL}/api/auth/csrf" | jq -r '.data.csrf_token'
}

CURRENT_STEP='infrastructure health checks'
echo "[docker-verify-full] 1/18 ${CURRENT_STEP}"
if [[ "${VERIFY_SKIP_HEALTHZ}" != "1" ]]; then
  curl -fsS "${BASE_URL}/healthz" >/dev/null
fi
curl -fsS "${BASE_URL}/api/health" >/dev/null
if [[ "${VERIFY_SKIP_HEALTHZ}" == "1" ]]; then
  append_check "${CURRENT_STEP}" "passed" "api health endpoint is reachable (/healthz check skipped)"
else
  append_check "${CURRENT_STEP}" "passed" "health endpoints are reachable"
fi

CURRENT_STEP='probe login'
echo "[docker-verify-full] 2/18 ${CURRENT_STEP}"
curl -fsS -c "${PROBE_COOKIE}" -b "${PROBE_COOKIE}" \
  -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${PROBE_USERNAME}\",\"password\":\"${PROBE_PASSWORD}\"}" | \
  jq -e ".success == true and .data.username == \"${PROBE_USERNAME}\"" >/dev/null

curl -sS -c "${PROBE_COOKIE}" -b "${PROBE_COOKIE}" \
  -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${PROBE_USERNAME}\",\"password\":\"wrong-password\"}" | \
  jq -e '.success == false' >/dev/null

curl -fsS -c "${PROBE_COOKIE}" -b "${PROBE_COOKIE}" \
  "${BASE_URL}/api/users/me" | \
  jq -e ".success == true and .data.username == \"${PROBE_USERNAME}\" and .data.role == \"user\"" >/dev/null
append_check "${CURRENT_STEP}" "passed" "probe user login/me succeeded and wrong-password was rejected"

CURRENT_STEP='business account login'
echo "[docker-verify-full] 3/18 ${CURRENT_STEP}"
curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${BUSINESS_USERNAME}\",\"password\":\"${BUSINESS_PASSWORD}\"}" | \
  jq -e ".success == true and .data.username == \"${BUSINESS_USERNAME}\"" >/dev/null

BUSINESS_CSRF="$(get_csrf_token "${BUSINESS_COOKIE}")"
if [[ -z "${BUSINESS_CSRF}" || "${BUSINESS_CSRF}" == 'null' ]]; then
  echo "[docker-verify-full] failed to obtain business csrf token"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "business user login and csrf succeeded"

CURRENT_STEP='resolve conversation model'
echo "[docker-verify-full] 4/18 ${CURRENT_STEP}"
CONVERSATION_MODEL_ID="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/models" | jq -r '.data[0].id // empty')"
if [[ -z "${CONVERSATION_MODEL_ID}" ]]; then
  CONVERSATION_MODEL_RESP="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
    -X POST "${BASE_URL}/api/models/draft" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: ${BUSINESS_CSRF}" \
    -d "{\"name\":\"verify-conversation-model-${RUN_TAG}\",\"description\":\"deployment verification conversation seed\",\"model_type\":\"detection\",\"visibility\":\"private\"}")"
  CONVERSATION_MODEL_ID="$(echo "${CONVERSATION_MODEL_RESP}" | jq -r '.data.id // empty')"
fi
if [[ -z "${CONVERSATION_MODEL_ID}" || "${CONVERSATION_MODEL_ID}" == 'null' ]]; then
  echo "[docker-verify-full] failed to resolve/create conversation model"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "conversation_model=${CONVERSATION_MODEL_ID}"

CURRENT_STEP='account governance'
echo "[docker-verify-full] 5/18 ${CURRENT_STEP}"
ACCOUNT_GOVERNANCE_OUTPUT="$(START_API=false BASE_URL="${BASE_URL}" ADMIN_USERNAME="${ADMIN_USERNAME}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" bash scripts/smoke-account-governance.sh)"
echo "${ACCOUNT_GOVERNANCE_OUTPUT}"
ACCOUNT_GOVERNANCE_CREATED_USER_ID="$(echo "${ACCOUNT_GOVERNANCE_OUTPUT}" | awk -F= '/^created_user_id=/{print $2; exit}')"
ACCOUNT_GOVERNANCE_CREATED_USERNAME="$(echo "${ACCOUNT_GOVERNANCE_OUTPUT}" | awk -F= '/^created_username=/{print $2; exit}')"
ACCOUNT_GOVERNANCE_ADMIN_ID="$(echo "${ACCOUNT_GOVERNANCE_OUTPUT}" | awk -F= '/^admin_id=/{print $2; exit}')"
if [[ -z "${ACCOUNT_GOVERNANCE_CREATED_USER_ID}" || -z "${ACCOUNT_GOVERNANCE_CREATED_USERNAME}" || -z "${ACCOUNT_GOVERNANCE_ADMIN_ID}" ]]; then
  echo "[docker-verify-full] account-governance output missing required ids"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "created_user=${ACCOUNT_GOVERNANCE_CREATED_USERNAME}(${ACCOUNT_GOVERNANCE_CREATED_USER_ID}), admin=${ACCOUNT_GOVERNANCE_ADMIN_ID}"

CURRENT_STEP='conversation attachment upload lifecycle'
echo "[docker-verify-full] 6/18 ${CURRENT_STEP}"
printf 'docker verify conversation upload payload (%s)\n' "${RUN_TAG}" >"${CONVERSATION_UPLOAD_FILE}"
ATTACHMENT_UPLOAD_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/files/conversation/upload" \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -F "file=@${CONVERSATION_UPLOAD_FILE};filename=verify-${RUN_TAG}.jpg;type=image/jpeg")"
ATTACHMENT_ID="$(echo "${ATTACHMENT_UPLOAD_RESPONSE}" | jq -r '.data.id')"
if [[ -z "${ATTACHMENT_ID}" || "${ATTACHMENT_ID}" == 'null' ]]; then
  echo "[docker-verify-full] failed to create conversation attachment"
  echo "${ATTACHMENT_UPLOAD_RESPONSE}"
  exit 1
fi

ATTACHMENT_STATUS=''
for _ in $(seq 1 "${POLL_MAX_TRIES}"); do
  ATTACHMENT_LIST_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
    "${BASE_URL}/api/files/conversation")"
  ATTACHMENT_STATUS="$(echo "${ATTACHMENT_LIST_RESPONSE}" | jq -r ".data[] | select(.id == \"${ATTACHMENT_ID}\") | .status" | head -n 1)"
  if [[ "${ATTACHMENT_STATUS}" == 'ready' || "${ATTACHMENT_STATUS}" == 'error' ]]; then
    break
  fi
  sleep "${POLL_INTERVAL_SECONDS}"
done

if [[ "${ATTACHMENT_STATUS}" != 'ready' ]]; then
  echo "[docker-verify-full] attachment did not become ready"
  echo "attachment_id=${ATTACHMENT_ID} status=${ATTACHMENT_STATUS}"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "attachment ${ATTACHMENT_ID} reached ready state"

CURRENT_STEP='start conversation with attachment'
echo "[docker-verify-full] 7/18 ${CURRENT_STEP}"
CONVERSATION_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/conversations/start" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"model_id\":\"${CONVERSATION_MODEL_ID}\",\"initial_message\":\"deployment verify ${RUN_TAG}\",\"attachment_ids\":[\"${ATTACHMENT_ID}\"]}")"
CONVERSATION_ID="$(echo "${CONVERSATION_RESPONSE}" | jq -r '.data.conversation.id')"

if [[ -z "${CONVERSATION_ID}" || "${CONVERSATION_ID}" == 'null' ]]; then
  echo "[docker-verify-full] failed to start conversation"
  echo "${CONVERSATION_RESPONSE}"
  exit 1
fi

echo "${CONVERSATION_RESPONSE}" | jq -e '.success == true and (.data.messages | length) >= 2' >/dev/null
append_check "${CURRENT_STEP}" "passed" "conversation ${CONVERSATION_ID} created with assistant reply"

CURRENT_STEP='conversation operational actions'
echo "[docker-verify-full] 8/18 ${CURRENT_STEP}"
CONVERSATION_ACTIONS_OUTPUT="$(START_API=false BASE_URL="${BASE_URL}" AUTH_USERNAME="${BUSINESS_USERNAME}" AUTH_PASSWORD="${BUSINESS_PASSWORD}" bash scripts/smoke-conversation-actions.sh)"
echo "${CONVERSATION_ACTIONS_OUTPUT}"
CONVERSATION_ACTIONS_DATASET_ID="$(echo "${CONVERSATION_ACTIONS_OUTPUT}" | awk -F= '/^dataset_id=/{print $2; exit}')"
CONVERSATION_ACTIONS_MODEL_DRAFT_ID="$(echo "${CONVERSATION_ACTIONS_OUTPUT}" | awk -F= '/^model_draft_id=/{print $2; exit}')"
CONVERSATION_ACTIONS_TRAINING_JOB_ID="$(echo "${CONVERSATION_ACTIONS_OUTPUT}" | awk -F= '/^training_job_id=/{print $2; exit}')"
CONVERSATION_ACTIONS_TRAINING_DATASET_ID="$(echo "${CONVERSATION_ACTIONS_OUTPUT}" | awk -F= '/^training_dataset_id=/{print $2; exit}')"
CONVERSATION_ACTIONS_TRAINING_DATASET_VERSION_ID="$(echo "${CONVERSATION_ACTIONS_OUTPUT}" | awk -F= '/^training_dataset_version_id=/{print $2; exit}')"
if [[ -z "${CONVERSATION_ACTIONS_DATASET_ID}" || -z "${CONVERSATION_ACTIONS_MODEL_DRAFT_ID}" || -z "${CONVERSATION_ACTIONS_TRAINING_JOB_ID}" || -z "${CONVERSATION_ACTIONS_TRAINING_DATASET_ID}" || -z "${CONVERSATION_ACTIONS_TRAINING_DATASET_VERSION_ID}" ]]; then
  echo "[docker-verify-full] conversation-actions output missing required ids"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "dataset=${CONVERSATION_ACTIONS_DATASET_ID}, model_draft=${CONVERSATION_ACTIONS_MODEL_DRAFT_ID}, training_job=${CONVERSATION_ACTIONS_TRAINING_JOB_ID}, training_dataset=${CONVERSATION_ACTIONS_TRAINING_DATASET_ID}, training_dataset_version=${CONVERSATION_ACTIONS_TRAINING_DATASET_VERSION_ID}"

CURRENT_STEP='model draft -> model file -> approval submit'
echo "[docker-verify-full] 9/18 ${CURRENT_STEP}"
MODEL_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/models/draft" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"name\":\"verify-model-${RUN_TAG}\",\"description\":\"deployment verification\",\"model_type\":\"detection\",\"visibility\":\"private\"}")"
MODEL_ID="$(echo "${MODEL_RESPONSE}" | jq -r '.data.id')"
if [[ -z "${MODEL_ID}" || "${MODEL_ID}" == 'null' ]]; then
  echo "[docker-verify-full] failed to create model draft"
  echo "${MODEL_RESPONSE}"
  exit 1
fi

printf 'docker verify model artifact payload (%s)\n' "${RUN_TAG}" >"${MODEL_UPLOAD_FILE}"
MODEL_FILE_UPLOAD_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/files/model/${MODEL_ID}/upload" \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -F "file=@${MODEL_UPLOAD_FILE};filename=artifact-${RUN_TAG}.onnx;type=application/octet-stream")"
MODEL_ATTACHMENT_ID="$(echo "${MODEL_FILE_UPLOAD_RESPONSE}" | jq -r '.data.id')"

if [[ -z "${MODEL_ATTACHMENT_ID}" || "${MODEL_ATTACHMENT_ID}" == 'null' ]]; then
  echo "[docker-verify-full] failed to upload model artifact"
  echo "${MODEL_FILE_UPLOAD_RESPONSE}"
  exit 1
fi

MODEL_ATTACHMENT_STATUS=''
for _ in $(seq 1 "${POLL_MAX_TRIES}"); do
  MODEL_FILE_LIST_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
    "${BASE_URL}/api/files/model/${MODEL_ID}")"
  MODEL_ATTACHMENT_STATUS="$(echo "${MODEL_FILE_LIST_RESPONSE}" | jq -r ".data[] | select(.id == \"${MODEL_ATTACHMENT_ID}\") | .status" | head -n 1)"
  if [[ "${MODEL_ATTACHMENT_STATUS}" == 'ready' || "${MODEL_ATTACHMENT_STATUS}" == 'error' ]]; then
    break
  fi
  sleep "${POLL_INTERVAL_SECONDS}"
done

if [[ "${MODEL_ATTACHMENT_STATUS}" != 'ready' ]]; then
  echo "[docker-verify-full] model artifact did not become ready"
  echo "model_attachment_id=${MODEL_ATTACHMENT_ID} status=${MODEL_ATTACHMENT_STATUS}"
  exit 1
fi

APPROVAL_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/approvals/submit" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"model_id\":\"${MODEL_ID}\",\"review_notes\":\"deployment verify\",\"parameter_snapshot\":{\"epochs\":\"1\",\"batch_size\":\"1\"}}")"
echo "${APPROVAL_RESPONSE}" | jq -e '.success == true and .data.status == "pending"' >/dev/null
APPROVAL_ID="$(echo "${APPROVAL_RESPONSE}" | jq -r '.data.id')"
append_check "${CURRENT_STEP}" "passed" "model ${MODEL_ID} submitted as approval ${APPROVAL_ID}"

CURRENT_STEP='runtime connectivity contract'
echo "[docker-verify-full] 10/18 ${CURRENT_STEP}"
RUNTIME_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/runtime/connectivity")"
echo "${RUNTIME_RESPONSE}" | jq -e '.success == true and (.data | length) >= 3 and ([.data[].error_kind] | all(. != null))' >/dev/null
RUNTIME_METRICS_RETENTION_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/runtime/metrics-retention")"
echo "${RUNTIME_METRICS_RETENTION_RESPONSE}" | jq -e '.success == true and (.data.max_points_per_job | tonumber) >= 8 and (.data.max_total_rows | tonumber) >= 1000 and (.data.current_total_rows | tonumber) >= 0' >/dev/null
RUNTIME_METRICS_RETENTION_JSON="$(echo "${RUNTIME_METRICS_RETENTION_RESPONSE}" | jq -c '.data')"
append_check "${CURRENT_STEP}" "passed" "runtime connectivity + metrics retention summary available"

CURRENT_STEP='detection + ocr inference'
echo "[docker-verify-full] 11/18 ${CURRENT_STEP}"
MODEL_VERSIONS_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/model-versions")"
DETECTION_MODEL_VERSION_ID="$(echo "${MODEL_VERSIONS_RESPONSE}" | jq -r '.data[] | select(.task_type=="detection" and .status=="registered") | .id' | head -n 1)"
OCR_MODEL_VERSION_ID="$(echo "${MODEL_VERSIONS_RESPONSE}" | jq -r '.data[] | select(.task_type=="ocr" and .framework=="paddleocr" and .status=="registered") | .id' | head -n 1)"
if [[ -z "${OCR_MODEL_VERSION_ID}" ]]; then
  OCR_MODEL_VERSION_ID="$(echo "${MODEL_VERSIONS_RESPONSE}" | jq -r '.data[] | select(.task_type=="ocr" and .status=="registered") | .id' | head -n 1)"
fi
if [[ -z "${DETECTION_MODEL_VERSION_ID}" || -z "${OCR_MODEL_VERSION_ID}" ]]; then
  echo "[docker-verify-full] required registered detection/ocr model versions were not found"
  echo "${MODEL_VERSIONS_RESPONSE}"
  exit 1
fi

DETECTION_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"model_version_id\":\"${DETECTION_MODEL_VERSION_ID}\",\"input_attachment_id\":\"${ATTACHMENT_ID}\",\"task_type\":\"detection\"}")"
DETECTION_RUN_ID="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.id')"
if [[ -z "${DETECTION_RUN_ID}" || "${DETECTION_RUN_ID}" == 'null' ]]; then
  echo "[docker-verify-full] detection inference failed"
  echo "${DETECTION_RESPONSE}"
  exit 1
fi
DETECTION_SOURCE_VALUE="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
DETECTION_BOX_COUNT="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.normalized_output.boxes | length // 0')"
DETECTION_RUNTIME_FALLBACK_REASON="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"
DETECTION_LOCAL_FALLBACK_REASON="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.raw_output.local_command_fallback_reason // empty')"
DETECTION_TEMPLATE_MODE="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.raw_output.meta.mode // empty')"
DETECTION_TEMPLATE_MARKER="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.raw_output.local_command_template_mode // false')"
DETECTION_TEMPLATE_REASON="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.raw_output.meta.fallback_reason // empty')"
if [[ "${DETECTION_BOX_COUNT}" -lt 1 ]]; then
  if [[ "${DETECTION_SOURCE_VALUE}" != *"fallback"* && "${DETECTION_SOURCE_VALUE}" != *"template"* && "${DETECTION_SOURCE_VALUE}" != *"mock"* && "${DETECTION_TEMPLATE_MODE}" != "template" && "${DETECTION_TEMPLATE_MARKER}" != "true" ]]; then
    echo "[docker-verify-full] detection inference returned empty boxes without explicit fallback/template markers"
    echo "${DETECTION_RESPONSE}"
    exit 1
  fi
  if [[ -z "${DETECTION_RUNTIME_FALLBACK_REASON}" && -z "${DETECTION_LOCAL_FALLBACK_REASON}" && -z "${DETECTION_TEMPLATE_REASON}" ]]; then
    echo "[docker-verify-full] detection inference returned empty boxes without explicit fallback markers"
    echo "${DETECTION_RESPONSE}"
    exit 1
  fi
fi

OCR_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"model_version_id\":\"${OCR_MODEL_VERSION_ID}\",\"input_attachment_id\":\"${ATTACHMENT_ID}\",\"task_type\":\"ocr\"}")"
OCR_RUN_ID="$(echo "${OCR_RESPONSE}" | jq -r '.data.id')"
if [[ -z "${OCR_RUN_ID}" || "${OCR_RUN_ID}" == 'null' ]]; then
  echo "[docker-verify-full] ocr inference failed"
  echo "${OCR_RESPONSE}"
  exit 1
fi
OCR_SOURCE_VALUE="$(echo "${OCR_RESPONSE}" | jq -r '.data.normalized_output.normalized_output.source // empty')"
OCR_LINE_COUNT="$(echo "${OCR_RESPONSE}" | jq -r '.data.normalized_output.ocr.lines | length // 0')"
OCR_RUNTIME_FALLBACK_REASON="$(echo "${OCR_RESPONSE}" | jq -r '.data.raw_output.runtime_fallback_reason // empty')"
OCR_LOCAL_FALLBACK_REASON="$(echo "${OCR_RESPONSE}" | jq -r '.data.raw_output.local_command_fallback_reason // empty')"
OCR_TEMPLATE_MODE="$(echo "${OCR_RESPONSE}" | jq -r '.data.raw_output.meta.mode // empty')"
OCR_TEMPLATE_MARKER="$(echo "${OCR_RESPONSE}" | jq -r '.data.raw_output.local_command_template_mode // false')"
OCR_TEMPLATE_REASON="$(echo "${OCR_RESPONSE}" | jq -r '.data.raw_output.meta.fallback_reason // empty')"
if [[ "${OCR_LINE_COUNT}" -lt 1 ]]; then
  if [[ "${OCR_SOURCE_VALUE}" != *"fallback"* && "${OCR_SOURCE_VALUE}" != *"template"* && "${OCR_SOURCE_VALUE}" != *"mock"* && "${OCR_TEMPLATE_MODE}" != "template" && "${OCR_TEMPLATE_MARKER}" != "true" ]]; then
    echo "[docker-verify-full] ocr inference returned empty lines without explicit fallback/template markers"
    echo "${OCR_RESPONSE}"
    exit 1
  fi
  if [[ -z "${OCR_RUNTIME_FALLBACK_REASON}" && -z "${OCR_LOCAL_FALLBACK_REASON}" && -z "${OCR_TEMPLATE_REASON}" ]]; then
    echo "[docker-verify-full] ocr inference returned empty lines without explicit fallback markers"
    echo "${OCR_RESPONSE}"
    exit 1
  fi
fi
append_check "${CURRENT_STEP}" "passed" "detection run ${DETECTION_RUN_ID} (${DETECTION_MODEL_VERSION_ID}) source=${DETECTION_SOURCE_VALUE} and ocr run ${OCR_RUN_ID} (${OCR_MODEL_VERSION_ID}) source=${OCR_SOURCE_VALUE} succeeded"

CURRENT_STEP='inference feedback to dataset'
echo "[docker-verify-full] 12/18 ${CURRENT_STEP}"
DATASETS_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/datasets")"
DETECTION_FEEDBACK_DATASET_ID="$(echo "${DATASETS_RESPONSE}" | jq -r '.data[] | select(.task_type=="detection") | .id' | head -n 1)"
if [[ -z "${DETECTION_FEEDBACK_DATASET_ID}" && -n "${CONVERSATION_ACTIONS_TRAINING_DATASET_ID}" ]]; then
  DETECTION_FEEDBACK_DATASET_ID="${CONVERSATION_ACTIONS_TRAINING_DATASET_ID}"
fi
if [[ -z "${DETECTION_FEEDBACK_DATASET_ID}" ]]; then
  echo "[docker-verify-full] no detection dataset found for valid feedback path"
  echo "${DATASETS_RESPONSE}"
  exit 1
fi

OCR_FEEDBACK_DATASET_ID="$(echo "${DATASETS_RESPONSE}" | jq -r '.data[] | select(.task_type=="ocr") | .id' | head -n 1)"
if [[ -z "${OCR_FEEDBACK_DATASET_ID}" ]]; then
  OCR_DATASET_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
    -X POST "${BASE_URL}/api/datasets" \
    -H 'Content-Type: application/json' \
    -H "x-csrf-token: ${BUSINESS_CSRF}" \
    -d "{\"name\":\"verify-feedback-ocr-${RUN_TAG}\",\"description\":\"auto ocr feedback dataset\",\"task_type\":\"ocr\",\"label_schema\":{\"classes\":[\"text\"]}}")"
  OCR_FEEDBACK_DATASET_ID="$(echo "${OCR_DATASET_RESPONSE}" | jq -r '.data.id // empty')"
  if [[ -z "${OCR_FEEDBACK_DATASET_ID}" ]]; then
    echo "[docker-verify-full] failed to create ocr feedback dataset"
    echo "${OCR_DATASET_RESPONSE}"
    exit 1
  fi
fi

MISMATCH_DETECTION_DATASET_ID="${OCR_FEEDBACK_DATASET_ID}"
mismatch_detection_feedback_response="$(curl -sS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs/${DETECTION_RUN_ID}/feedback" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"dataset_id\":\"${MISMATCH_DETECTION_DATASET_ID}\",\"reason\":\"deployment_verify_mismatch_detection\"}")"
mismatch_detection_feedback_success="$(echo "${mismatch_detection_feedback_response}" | jq -r '.success // false')"
mismatch_detection_feedback_error_code="$(echo "${mismatch_detection_feedback_response}" | jq -r '.error.code // empty')"
mismatch_detection_feedback_error_message="$(echo "${mismatch_detection_feedback_response}" | jq -r '.error.message // empty')"
if [[ "${mismatch_detection_feedback_success}" != "false" || "${mismatch_detection_feedback_error_code}" != "VALIDATION_ERROR" || "${mismatch_detection_feedback_error_message}" != *"task_type"* || "${mismatch_detection_feedback_error_message}" != *"match"* ]]; then
  echo "[docker-verify-full] detection mismatch feedback should be rejected with validation error"
  echo "${mismatch_detection_feedback_response}"
  exit 1
fi

MISMATCH_OCR_DATASET_ID="${DETECTION_FEEDBACK_DATASET_ID}"
mismatch_ocr_feedback_response="$(curl -sS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs/${OCR_RUN_ID}/feedback" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"dataset_id\":\"${MISMATCH_OCR_DATASET_ID}\",\"reason\":\"deployment_verify_mismatch_ocr\"}")"
mismatch_ocr_feedback_success="$(echo "${mismatch_ocr_feedback_response}" | jq -r '.success // false')"
mismatch_ocr_feedback_error_code="$(echo "${mismatch_ocr_feedback_response}" | jq -r '.error.code // empty')"
mismatch_ocr_feedback_error_message="$(echo "${mismatch_ocr_feedback_response}" | jq -r '.error.message // empty')"
if [[ "${mismatch_ocr_feedback_success}" != "false" || "${mismatch_ocr_feedback_error_code}" != "VALIDATION_ERROR" || "${mismatch_ocr_feedback_error_message}" != *"task_type"* || "${mismatch_ocr_feedback_error_message}" != *"match"* ]]; then
  echo "[docker-verify-full] ocr mismatch feedback should be rejected with validation error"
  echo "${mismatch_ocr_feedback_response}"
  exit 1
fi

DETECTION_FEEDBACK_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs/${DETECTION_RUN_ID}/feedback" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"dataset_id\":\"${DETECTION_FEEDBACK_DATASET_ID}\",\"reason\":\"deployment_verify_detection\"}")"
detection_feedback_success="$(echo "${DETECTION_FEEDBACK_RESPONSE}" | jq -r '.success // false')"
detection_feedback_dataset_id="$(echo "${DETECTION_FEEDBACK_RESPONSE}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${detection_feedback_success}" != "true" || "${detection_feedback_dataset_id}" != "${DETECTION_FEEDBACK_DATASET_ID}" ]]; then
  echo "[docker-verify-full] detection valid feedback path failed"
  echo "${DETECTION_FEEDBACK_RESPONSE}"
  exit 1
fi

OCR_FEEDBACK_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs/${OCR_RUN_ID}/feedback" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"dataset_id\":\"${OCR_FEEDBACK_DATASET_ID}\",\"reason\":\"deployment_verify_ocr\"}")"
ocr_feedback_success="$(echo "${OCR_FEEDBACK_RESPONSE}" | jq -r '.success // false')"
ocr_feedback_dataset_id="$(echo "${OCR_FEEDBACK_RESPONSE}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${ocr_feedback_success}" != "true" || "${ocr_feedback_dataset_id}" != "${OCR_FEEDBACK_DATASET_ID}" ]]; then
  echo "[docker-verify-full] ocr valid feedback path failed"
  echo "${OCR_FEEDBACK_RESPONSE}"
  exit 1
fi

DETECTION_DATASET_AFTER_FEEDBACK="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/datasets/${DETECTION_FEEDBACK_DATASET_ID}")"
detection_feedback_item_count="$(echo "${DETECTION_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${DETECTION_RUN_ID}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
if [[ "${detection_feedback_item_count}" -lt 1 ]]; then
  echo "[docker-verify-full] detection feedback dataset item was not created"
  echo "${DETECTION_DATASET_AFTER_FEEDBACK}"
  exit 1
fi
detection_feedback_attachment_id="$(echo "${DETECTION_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${DETECTION_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .attachment_id // empty' | head -n 1)"
detection_dataset_attachment_count="$(echo "${DETECTION_DATASET_AFTER_FEEDBACK}" | jq -r --arg attachment_id "${detection_feedback_attachment_id}" '[.data.attachments[] | select(.id == $attachment_id)] | length')"
detection_feedback_source_attachment_id="$(echo "${DETECTION_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${DETECTION_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.source_attachment_id // empty' | head -n 1)"
detection_feedback_metadata_run_id="$(echo "${DETECTION_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${DETECTION_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.inference_run_id // empty' | head -n 1)"
if [[ -z "${detection_feedback_attachment_id}" || "${detection_dataset_attachment_count}" -lt 1 ]]; then
  echo "[docker-verify-full] detection feedback attachment is not dataset-scoped"
  echo "${DETECTION_DATASET_AFTER_FEEDBACK}"
  exit 1
fi
if [[ "${detection_feedback_source_attachment_id}" != "${ATTACHMENT_ID}" || "${detection_feedback_metadata_run_id}" != "${DETECTION_RUN_ID}" ]]; then
  echo "[docker-verify-full] detection feedback metadata attachment/run linkage mismatch"
  echo "${DETECTION_DATASET_AFTER_FEEDBACK}"
  exit 1
fi

OCR_DATASET_AFTER_FEEDBACK="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/datasets/${OCR_FEEDBACK_DATASET_ID}")"
ocr_feedback_item_count="$(echo "${OCR_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${OCR_RUN_ID}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
if [[ "${ocr_feedback_item_count}" -lt 1 ]]; then
  echo "[docker-verify-full] ocr feedback dataset item was not created"
  echo "${OCR_DATASET_AFTER_FEEDBACK}"
  exit 1
fi
ocr_feedback_attachment_id="$(echo "${OCR_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${OCR_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .attachment_id // empty' | head -n 1)"
ocr_dataset_attachment_count="$(echo "${OCR_DATASET_AFTER_FEEDBACK}" | jq -r --arg attachment_id "${ocr_feedback_attachment_id}" '[.data.attachments[] | select(.id == $attachment_id)] | length')"
ocr_feedback_source_attachment_id="$(echo "${OCR_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${OCR_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.source_attachment_id // empty' | head -n 1)"
ocr_feedback_metadata_run_id="$(echo "${OCR_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${OCR_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.inference_run_id // empty' | head -n 1)"
if [[ -z "${ocr_feedback_attachment_id}" || "${ocr_dataset_attachment_count}" -lt 1 ]]; then
  echo "[docker-verify-full] ocr feedback attachment is not dataset-scoped"
  echo "${OCR_DATASET_AFTER_FEEDBACK}"
  exit 1
fi
if [[ "${ocr_feedback_source_attachment_id}" != "${ATTACHMENT_ID}" || "${ocr_feedback_metadata_run_id}" != "${OCR_RUN_ID}" ]]; then
  echo "[docker-verify-full] ocr feedback metadata attachment/run linkage mismatch"
  echo "${OCR_DATASET_AFTER_FEEDBACK}"
  exit 1
fi

IDEMPOTENT_DETECTION_REASON="deployment_verify_detection_idempotent"
IDEMPOTENT_DETECTION_FEEDBACK_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs/${DETECTION_RUN_ID}/feedback" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"dataset_id\":\"${DETECTION_FEEDBACK_DATASET_ID}\",\"reason\":\"${IDEMPOTENT_DETECTION_REASON}\"}")"
idempotent_detection_feedback_success="$(echo "${IDEMPOTENT_DETECTION_FEEDBACK_RESPONSE}" | jq -r '.success // false')"
if [[ "${idempotent_detection_feedback_success}" != "true" ]]; then
  echo "[docker-verify-full] detection idempotent feedback request failed"
  echo "${IDEMPOTENT_DETECTION_FEEDBACK_RESPONSE}"
  exit 1
fi

IDEMPOTENT_OCR_REASON="deployment_verify_ocr_idempotent"
IDEMPOTENT_OCR_FEEDBACK_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs/${OCR_RUN_ID}/feedback" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"dataset_id\":\"${OCR_FEEDBACK_DATASET_ID}\",\"reason\":\"${IDEMPOTENT_OCR_REASON}\"}")"
idempotent_ocr_feedback_success="$(echo "${IDEMPOTENT_OCR_FEEDBACK_RESPONSE}" | jq -r '.success // false')"
if [[ "${idempotent_ocr_feedback_success}" != "true" ]]; then
  echo "[docker-verify-full] ocr idempotent feedback request failed"
  echo "${IDEMPOTENT_OCR_FEEDBACK_RESPONSE}"
  exit 1
fi

DETECTION_DATASET_AFTER_IDEMPOTENT="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/datasets/${DETECTION_FEEDBACK_DATASET_ID}")"
detection_idempotent_item_count="$(echo "${DETECTION_DATASET_AFTER_IDEMPOTENT}" | jq -r --arg run_id "${DETECTION_RUN_ID}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
detection_idempotent_reason="$(echo "${DETECTION_DATASET_AFTER_IDEMPOTENT}" | jq -r --arg run_id "${DETECTION_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.feedback_reason // empty' | head -n 1)"
detection_idempotent_source_attachment_id="$(echo "${DETECTION_DATASET_AFTER_IDEMPOTENT}" | jq -r --arg run_id "${DETECTION_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.source_attachment_id // empty' | head -n 1)"
if [[ "${detection_idempotent_item_count}" != "1" || "${detection_idempotent_reason}" != "${IDEMPOTENT_DETECTION_REASON}" || "${detection_idempotent_source_attachment_id}" != "${ATTACHMENT_ID}" ]]; then
  echo "[docker-verify-full] detection feedback idempotency expectation failed"
  echo "${DETECTION_DATASET_AFTER_IDEMPOTENT}"
  exit 1
fi

OCR_DATASET_AFTER_IDEMPOTENT="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/datasets/${OCR_FEEDBACK_DATASET_ID}")"
ocr_idempotent_item_count="$(echo "${OCR_DATASET_AFTER_IDEMPOTENT}" | jq -r --arg run_id "${OCR_RUN_ID}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
ocr_idempotent_reason="$(echo "${OCR_DATASET_AFTER_IDEMPOTENT}" | jq -r --arg run_id "${OCR_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.feedback_reason // empty' | head -n 1)"
ocr_idempotent_source_attachment_id="$(echo "${OCR_DATASET_AFTER_IDEMPOTENT}" | jq -r --arg run_id "${OCR_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.source_attachment_id // empty' | head -n 1)"
if [[ "${ocr_idempotent_item_count}" != "1" || "${ocr_idempotent_reason}" != "${IDEMPOTENT_OCR_REASON}" || "${ocr_idempotent_source_attachment_id}" != "${ATTACHMENT_ID}" ]]; then
  echo "[docker-verify-full] ocr feedback idempotency expectation failed"
  echo "${OCR_DATASET_AFTER_IDEMPOTENT}"
  exit 1
fi

REUSE_FEEDBACK_DATASET_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/datasets" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"name\":\"verify-feedback-reuse-${RUN_TAG}\",\"description\":\"verify dataset-scoped attachment reuse\",\"task_type\":\"detection\",\"label_schema\":{\"classes\":[\"defect\"]}}")"
REUSE_FEEDBACK_DATASET_ID="$(echo "${REUSE_FEEDBACK_DATASET_RESPONSE}" | jq -r '.data.id // empty')"
if [[ -z "${REUSE_FEEDBACK_DATASET_ID}" ]]; then
  echo "[docker-verify-full] failed to create reuse feedback dataset"
  echo "${REUSE_FEEDBACK_DATASET_RESPONSE}"
  exit 1
fi

REUSE_FEEDBACK_ATTACHMENT_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/files/dataset/${REUSE_FEEDBACK_DATASET_ID}/upload" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"filename\":\"verify-feedback-reuse-${RUN_TAG}.jpg\"}")"
REUSE_FEEDBACK_ATTACHMENT_ID="$(echo "${REUSE_FEEDBACK_ATTACHMENT_RESPONSE}" | jq -r '.data.id // empty')"
if [[ -z "${REUSE_FEEDBACK_ATTACHMENT_ID}" ]]; then
  echo "[docker-verify-full] failed to upload reuse feedback dataset attachment"
  echo "${REUSE_FEEDBACK_ATTACHMENT_RESPONSE}"
  exit 1
fi

REUSE_FEEDBACK_ATTACHMENT_STATUS=''
for _ in $(seq 1 "${POLL_MAX_TRIES}"); do
  REUSE_DATASET_FILES_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
    "${BASE_URL}/api/files/dataset/${REUSE_FEEDBACK_DATASET_ID}")"
  REUSE_FEEDBACK_ATTACHMENT_STATUS="$(echo "${REUSE_DATASET_FILES_RESPONSE}" | jq -r --arg id "${REUSE_FEEDBACK_ATTACHMENT_ID}" '.data[] | select(.id == $id) | .status // empty')"
  if [[ "${REUSE_FEEDBACK_ATTACHMENT_STATUS}" == 'ready' || "${REUSE_FEEDBACK_ATTACHMENT_STATUS}" == 'error' ]]; then
    break
  fi
  sleep "${POLL_INTERVAL_SECONDS}"
done
if [[ "${REUSE_FEEDBACK_ATTACHMENT_STATUS}" != 'ready' ]]; then
  echo "[docker-verify-full] reuse feedback attachment did not become ready"
  echo "${REUSE_DATASET_FILES_RESPONSE}"
  exit 1
fi

REUSE_INFERENCE_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"model_version_id\":\"${DETECTION_MODEL_VERSION_ID}\",\"input_attachment_id\":\"${REUSE_FEEDBACK_ATTACHMENT_ID}\",\"task_type\":\"detection\"}")"
REUSE_RUN_ID="$(echo "${REUSE_INFERENCE_RESPONSE}" | jq -r '.data.id // empty')"
if [[ -z "${REUSE_RUN_ID}" ]]; then
  echo "[docker-verify-full] failed to create reuse-path inference run"
  echo "${REUSE_INFERENCE_RESPONSE}"
  exit 1
fi

REUSE_FEEDBACK_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs/${REUSE_RUN_ID}/feedback" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"dataset_id\":\"${REUSE_FEEDBACK_DATASET_ID}\",\"reason\":\"deployment_verify_reuse\"}")"
reuse_feedback_success="$(echo "${REUSE_FEEDBACK_RESPONSE}" | jq -r '.success // false')"
reuse_feedback_dataset_id="$(echo "${REUSE_FEEDBACK_RESPONSE}" | jq -r '.data.feedback_dataset_id // empty')"
if [[ "${reuse_feedback_success}" != "true" || "${reuse_feedback_dataset_id}" != "${REUSE_FEEDBACK_DATASET_ID}" ]]; then
  echo "[docker-verify-full] reuse-path feedback request failed"
  echo "${REUSE_FEEDBACK_RESPONSE}"
  exit 1
fi

REUSE_DATASET_AFTER_FEEDBACK="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/datasets/${REUSE_FEEDBACK_DATASET_ID}")"
reuse_feedback_item_count="$(echo "${REUSE_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${REUSE_RUN_ID}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
reuse_feedback_attachment_id="$(echo "${REUSE_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${REUSE_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .attachment_id // empty' | head -n 1)"
reuse_dataset_attachment_count="$(echo "${REUSE_DATASET_AFTER_FEEDBACK}" | jq -r --arg attachment_id "${REUSE_FEEDBACK_ATTACHMENT_ID}" '[.data.attachments[] | select(.id == $attachment_id)] | length')"
reuse_feedback_metadata_source_attachment_id="$(echo "${REUSE_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${REUSE_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.source_attachment_id // empty' | head -n 1)"
reuse_feedback_metadata_reason="$(echo "${REUSE_DATASET_AFTER_FEEDBACK}" | jq -r --arg run_id "${REUSE_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.feedback_reason // empty' | head -n 1)"
if [[ "${reuse_feedback_item_count}" != "1" || "${reuse_feedback_attachment_id}" != "${REUSE_FEEDBACK_ATTACHMENT_ID}" || "${reuse_dataset_attachment_count}" != "1" || "${reuse_feedback_metadata_source_attachment_id}" != "${REUSE_FEEDBACK_ATTACHMENT_ID}" || "${reuse_feedback_metadata_reason}" != "deployment_verify_reuse" ]]; then
  echo "[docker-verify-full] reuse-path feedback did not reuse dataset-scoped attachment"
  echo "${REUSE_DATASET_AFTER_FEEDBACK}"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "detection mismatch->${MISMATCH_DETECTION_DATASET_ID} rejected and linked->${DETECTION_FEEDBACK_DATASET_ID}; ocr mismatch->${MISMATCH_OCR_DATASET_ID} rejected and linked->${OCR_FEEDBACK_DATASET_ID}; reuse dataset=${REUSE_FEEDBACK_DATASET_ID} run=${REUSE_RUN_ID}"

CURRENT_STEP='phase2 annotation/review + launch-readiness guards'
echo "[docker-verify-full] 13/18 ${CURRENT_STEP}"
PHASE2_OUTPUT="$(START_API=false BASE_URL="${BASE_URL}" AUTH_USERNAME="${BUSINESS_USERNAME}" AUTH_PASSWORD="${BUSINESS_PASSWORD}" EXPECT_RUNTIME_FALLBACK=false bash scripts/smoke-phase2.sh)"
echo "${PHASE2_OUTPUT}"
PHASE2_DATASET_ID="$(echo "${PHASE2_OUTPUT}" | awk -F= '/^dataset_id=/{print $2; exit}')"
PHASE2_NO_TRAIN_VERSION_ID="$(echo "${PHASE2_OUTPUT}" | awk -F= '/^no_train_gate_version_id=/{print $2; exit}')"
if [[ -z "${PHASE2_DATASET_ID}" || -z "${PHASE2_NO_TRAIN_VERSION_ID}" ]]; then
  echo "[docker-verify-full] phase2 output missing required ids"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "phase2 dataset=${PHASE2_DATASET_ID}, no-train gate version=${PHASE2_NO_TRAIN_VERSION_ID}"

CURRENT_STEP='dataset export/import roundtrip'
echo "[docker-verify-full] 14/18 ${CURRENT_STEP}"
DATASET_ROUNDTRIP_OUTPUT="$(START_API=false BASE_URL="${BASE_URL}" AUTH_USERNAME="${BUSINESS_USERNAME}" AUTH_PASSWORD="${BUSINESS_PASSWORD}" bash scripts/smoke-dataset-export-roundtrip.sh)"
echo "${DATASET_ROUNDTRIP_OUTPUT}"

ROUNDTRIP_DET_TARGET="$(echo "${DATASET_ROUNDTRIP_OUTPUT}" | awk -F= '/^det_target=/{print $2; exit}')"
ROUNDTRIP_OCR_TARGET="$(echo "${DATASET_ROUNDTRIP_OUTPUT}" | awk -F= '/^ocr_target=/{print $2; exit}')"
ROUNDTRIP_SEG_TARGET="$(echo "${DATASET_ROUNDTRIP_OUTPUT}" | awk -F= '/^seg_target=/{print $2; exit}')"
if [[ -z "${ROUNDTRIP_DET_TARGET}" || -z "${ROUNDTRIP_OCR_TARGET}" || -z "${ROUNDTRIP_SEG_TARGET}" ]]; then
  echo "[docker-verify-full] dataset roundtrip smoke output missing target ids"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "roundtrip targets: det=${ROUNDTRIP_DET_TARGET}, ocr=${ROUNDTRIP_OCR_TARGET}, seg=${ROUNDTRIP_SEG_TARGET}"

CURRENT_STEP='real closure smoke (yolo + paddleocr + doctr)'
echo "[docker-verify-full] 15/18 ${CURRENT_STEP}"
REAL_CLOSURE_OUTPUT="$(START_API=false REAL_CLOSURE_STRICT_REGISTRATION="${REAL_CLOSURE_STRICT_REGISTRATION}" BASE_URL="${BASE_URL}" AUTH_USERNAME="${BUSINESS_USERNAME}" AUTH_PASSWORD="${BUSINESS_PASSWORD}" bash scripts/smoke-real-closure.sh)"
echo "${REAL_CLOSURE_OUTPUT}"

REAL_CLOSURE_YOLO_SOURCE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^yolo_source=/{print $2; exit}')"
REAL_CLOSURE_OCR_SOURCE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^ocr_source=/{print $2; exit}')"
REAL_CLOSURE_DOCTR_SOURCE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^doctr_source=/{print $2; exit}')"
REAL_CLOSURE_YOLO_REGISTER_MODE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^yolo_register_mode=/{print $2; exit}')"
REAL_CLOSURE_DOCTR_REGISTER_MODE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^doctr_register_mode=/{print $2; exit}')"
if [[ -z "${REAL_CLOSURE_YOLO_SOURCE}" || -z "${REAL_CLOSURE_OCR_SOURCE}" || -z "${REAL_CLOSURE_DOCTR_SOURCE}" ]]; then
  echo "[docker-verify-full] real closure output missing inference sources"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "sources: yolo=${REAL_CLOSURE_YOLO_SOURCE}, paddleocr=${REAL_CLOSURE_OCR_SOURCE}, doctr=${REAL_CLOSURE_DOCTR_SOURCE}; register_modes: yolo=${REAL_CLOSURE_YOLO_REGISTER_MODE:-unknown}, doctr=${REAL_CLOSURE_DOCTR_REGISTER_MODE:-unknown}"

CURRENT_STEP='ocr closure smoke (paddleocr + doctr)'
echo "[docker-verify-full] 16/18 ${CURRENT_STEP}"
OCR_CLOSURE_OUTPUT="$(START_API=false OCR_CLOSURE_STRICT_LOCAL_COMMAND="${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" BASE_URL="${BASE_URL}" AUTH_USERNAME="${BUSINESS_USERNAME}" AUTH_PASSWORD="${BUSINESS_PASSWORD}" bash scripts/smoke-ocr-closure.sh)"
echo "${OCR_CLOSURE_OUTPUT}"

OCR_CLOSURE_PADDLE_SOURCE="$(echo "${OCR_CLOSURE_OUTPUT}" | awk -F= '/^paddle_execution_source=/{print $2; exit}')"
OCR_CLOSURE_DOCTR_SOURCE="$(echo "${OCR_CLOSURE_OUTPUT}" | awk -F= '/^doctr_execution_source=/{print $2; exit}')"
OCR_CLOSURE_PADDLE_ACCURACY="$(echo "${OCR_CLOSURE_OUTPUT}" | awk -F= '/^paddle_accuracy=/{print $2; exit}')"
OCR_CLOSURE_DOCTR_PRIMARY_NAME="$(echo "${OCR_CLOSURE_OUTPUT}" | awk -F= '/^doctr_primary_metric_name=/{print $2; exit}')"
OCR_CLOSURE_DOCTR_PRIMARY_VALUE="$(echo "${OCR_CLOSURE_OUTPUT}" | awk -F= '/^doctr_primary_metric_value=/{print $2; exit}')"
OCR_CLOSURE_PADDLE_REGISTER_MODE="$(echo "${OCR_CLOSURE_OUTPUT}" | awk -F= '/^paddle_register_mode=/{print $2; exit}')"
OCR_CLOSURE_DOCTR_REGISTER_MODE="$(echo "${OCR_CLOSURE_OUTPUT}" | awk -F= '/^doctr_register_mode=/{print $2; exit}')"
if [[ -z "${OCR_CLOSURE_PADDLE_SOURCE}" || -z "${OCR_CLOSURE_DOCTR_SOURCE}" ]]; then
  echo "[docker-verify-full] ocr closure output missing execution sources."
  exit 1
fi
if [[ -z "${OCR_CLOSURE_PADDLE_ACCURACY}" || "${OCR_CLOSURE_PADDLE_ACCURACY}" == "null" ]]; then
  echo "[docker-verify-full] ocr closure output missing paddle_accuracy."
  exit 1
fi
if [[ -z "${OCR_CLOSURE_DOCTR_PRIMARY_NAME}" || -z "${OCR_CLOSURE_DOCTR_PRIMARY_VALUE}" || "${OCR_CLOSURE_DOCTR_PRIMARY_VALUE}" == "null" ]]; then
  echo "[docker-verify-full] ocr closure output missing docTR primary metric."
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "execution_sources: paddleocr=${OCR_CLOSURE_PADDLE_SOURCE}, doctr=${OCR_CLOSURE_DOCTR_SOURCE}; metrics: paddle_accuracy=${OCR_CLOSURE_PADDLE_ACCURACY}, doctr_${OCR_CLOSURE_DOCTR_PRIMARY_NAME}=${OCR_CLOSURE_DOCTR_PRIMARY_VALUE}; register_modes: paddle=${OCR_CLOSURE_PADDLE_REGISTER_MODE:-unknown}, doctr=${OCR_CLOSURE_DOCTR_REGISTER_MODE:-unknown}"

CURRENT_STEP='training worker dedicated auth smoke'
echo "[docker-verify-full] 17/18 ${CURRENT_STEP}"
DEDICATED_AUTH_WORKER_PUBLIC_HOST="${DEDICATED_AUTH_WORKER_PUBLIC_HOST:-host.docker.internal}"
DEDICATED_AUTH_WORKER_BIND_HOST="${DEDICATED_AUTH_WORKER_BIND_HOST:-0.0.0.0}"
DEDICATED_AUTH_OUTPUT="$(
  START_API=false \
  BASE_URL="${BASE_URL}" \
  ADMIN_USERNAME="${ADMIN_USERNAME}" \
  ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  WORKER_PUBLIC_HOST="${DEDICATED_AUTH_WORKER_PUBLIC_HOST}" \
  WORKER_BIND_HOST="${DEDICATED_AUTH_WORKER_BIND_HOST}" \
  bash scripts/smoke-training-worker-dedicated-auth.sh
)"
echo "${DEDICATED_AUTH_OUTPUT}"
DEDICATED_REFERENCE_WORKER_ID="$(echo "${DEDICATED_AUTH_OUTPUT}" | awk -F= '/^reference_worker_id=/{print $2; exit}')"
DEDICATED_REFERENCE_JOB_ID="$(echo "${DEDICATED_AUTH_OUTPUT}" | awk -F= '/^reference_job_id=/{print $2; exit}')"
DEDICATED_CANCEL_WORKER_ID="$(echo "${DEDICATED_AUTH_OUTPUT}" | awk -F= '/^cancel_worker_id=/{print $2; exit}')"
DEDICATED_CANCEL_JOB_ID="$(echo "${DEDICATED_AUTH_OUTPUT}" | awk -F= '/^cancel_job_id=/{print $2; exit}')"
DEDICATED_REFERENCE_LOG_COUNT="$(echo "${DEDICATED_AUTH_OUTPUT}" | awk -F= '/^reference_log_count=/{print $2; exit}')"
DEDICATED_REFERENCE_INLINE_LOG_COUNT="$(echo "${DEDICATED_AUTH_OUTPUT}" | awk -F= '/^reference_inline_log_count=/{print $2; exit}')"
DEDICATED_CANCEL_LOG_COUNT="$(echo "${DEDICATED_AUTH_OUTPUT}" | awk -F= '/^cancel_log_count=/{print $2; exit}')"
DEDICATED_TRAINING_DATASET_ID="$(echo "${DEDICATED_AUTH_OUTPUT}" | awk -F= '/^training_dataset_id=/{print $2; exit}')"
DEDICATED_TRAINING_DATASET_VERSION_ID="$(echo "${DEDICATED_AUTH_OUTPUT}" | awk -F= '/^training_dataset_version_id=/{print $2; exit}')"
if [[ -z "${DEDICATED_REFERENCE_WORKER_ID}" || -z "${DEDICATED_REFERENCE_JOB_ID}" || -z "${DEDICATED_CANCEL_WORKER_ID}" || -z "${DEDICATED_CANCEL_JOB_ID}" || -z "${DEDICATED_REFERENCE_LOG_COUNT}" || -z "${DEDICATED_CANCEL_LOG_COUNT}" ]]; then
  echo "[docker-verify-full] dedicated-auth output missing required ids"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "reference_worker=${DEDICATED_REFERENCE_WORKER_ID}, reference_job=${DEDICATED_REFERENCE_JOB_ID}, reference_logs=${DEDICATED_REFERENCE_LOG_COUNT}, reference_inline_logs=${DEDICATED_REFERENCE_INLINE_LOG_COUNT:-0}, cancel_worker=${DEDICATED_CANCEL_WORKER_ID}, cancel_job=${DEDICATED_CANCEL_JOB_ID}, cancel_logs=${DEDICATED_CANCEL_LOG_COUNT}, training_dataset=${DEDICATED_TRAINING_DATASET_ID:-unknown}, training_dataset_version=${DEDICATED_TRAINING_DATASET_VERSION_ID:-unknown}"

CURRENT_STEP='ocr fallback guard smoke'
echo "[docker-verify-full] 18/18 ${CURRENT_STEP}"
OCR_FALLBACK_GUARD_OUTPUT="$(
  AUTH_USERNAME="${BUSINESS_USERNAME}" \
  AUTH_PASSWORD="${BUSINESS_PASSWORD}" \
  bash scripts/smoke-ocr-fallback-guard.sh
)"
echo "${OCR_FALLBACK_GUARD_OUTPUT}"
OCR_FALLBACK_GUARD_SOURCE="$(echo "${OCR_FALLBACK_GUARD_OUTPUT}" | awk -F= '/^[[:space:]]*source=/{print $2; exit}')"
if [[ -z "${OCR_FALLBACK_GUARD_SOURCE}" ]]; then
  echo "[docker-verify-full] ocr fallback guard output missing source marker"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "source=${OCR_FALLBACK_GUARD_SOURCE}"

finalize_report "passed" "full deployment verification succeeded"

echo "[docker-verify-full] PASS"
echo "  probe_user=${PROBE_USERNAME}"
echo "  conversation_id=${CONVERSATION_ID}"
echo "  model_id=${MODEL_ID}"
echo "  approval_id=${APPROVAL_ID}"
echo "  detection_run_id=${DETECTION_RUN_ID}"
echo "  ocr_run_id=${OCR_RUN_ID}"
echo "  report_json=${REPORT_JSON_PATH}"
echo "  report_md=${REPORT_MD_PATH}"
