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
INFERENCE_RUN_RECOVERY_MAX_TRIES="${INFERENCE_RUN_RECOVERY_MAX_TRIES:-240}"
INFERENCE_RUN_RECOVERY_INTERVAL_SECONDS="${INFERENCE_RUN_RECOVERY_INTERVAL_SECONDS:-1}"
INFERENCE_RUN_POST_RETRY_MAX_ATTEMPTS="${INFERENCE_RUN_POST_RETRY_MAX_ATTEMPTS:-2}"
INFERENCE_RUN_POST_RETRY_INTERVAL_SECONDS="${INFERENCE_RUN_POST_RETRY_INTERVAL_SECONDS:-2}"
PHASE2_RETRY_MAX_ATTEMPTS="${PHASE2_RETRY_MAX_ATTEMPTS:-3}"
PHASE2_RETRY_INTERVAL_SECONDS="${PHASE2_RETRY_INTERVAL_SECONDS:-2}"
OCR_CLOSURE_RETRY_MAX_ATTEMPTS="${OCR_CLOSURE_RETRY_MAX_ATTEMPTS:-2}"
OCR_CLOSURE_RETRY_INTERVAL_SECONDS="${OCR_CLOSURE_RETRY_INTERVAL_SECONDS:-3}"
VERIFY_SKIP_HEALTHZ="${VERIFY_SKIP_HEALTHZ:-0}"
OCR_CLOSURE_STRICT_LOCAL_COMMAND="${OCR_CLOSURE_STRICT_LOCAL_COMMAND:-false}"
OCR_CLOSURE_REQUIRE_REAL_MODE="${OCR_CLOSURE_REQUIRE_REAL_MODE:-false}"
OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION="${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION:-false}"
OCR_CLOSURE_WAIT_POLLS="${OCR_CLOSURE_WAIT_POLLS:-2400}"
OCR_CLOSURE_WAIT_SLEEP_SEC="${OCR_CLOSURE_WAIT_SLEEP_SEC:-0.25}"
REAL_CLOSURE_STRICT_REGISTRATION="${REAL_CLOSURE_STRICT_REGISTRATION:-false}"
REAL_CLOSURE_REQUIRE_REAL_MODE="${REAL_CLOSURE_REQUIRE_REAL_MODE:-false}"
REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION="${REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION:-false}"
REAL_CLOSURE_ALLOW_OCR_CALIBRATED_REGISTRATION="${REAL_CLOSURE_ALLOW_OCR_CALIBRATED_REGISTRATION:-false}"
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
INFERENCE_ATTACHMENT_ID=''
DEDICATED_REFERENCE_WORKER_ID=''
DEDICATED_REFERENCE_JOB_ID=''
DEDICATED_CANCEL_WORKER_ID=''
DEDICATED_CANCEL_JOB_ID=''
DEDICATED_TRAINING_DATASET_ID=''
DEDICATED_TRAINING_DATASET_VERSION_ID=''
RUNTIME_DEVICE_MODEL_VERSION_ID=''
RUNTIME_DEVICE_BINDING_KEY=''
RUNTIME_DEVICE_REQUEST_ID=''
RUNTIME_DEVICE_DELIVERY_ID=''
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
    --arg inference_attachment_id "${INFERENCE_ATTACHMENT_ID}" \
    --arg dedicated_reference_worker_id "${DEDICATED_REFERENCE_WORKER_ID}" \
    --arg dedicated_reference_job_id "${DEDICATED_REFERENCE_JOB_ID}" \
    --arg dedicated_cancel_worker_id "${DEDICATED_CANCEL_WORKER_ID}" \
    --arg dedicated_cancel_job_id "${DEDICATED_CANCEL_JOB_ID}" \
    --arg dedicated_training_dataset_id "${DEDICATED_TRAINING_DATASET_ID}" \
    --arg dedicated_training_dataset_version_id "${DEDICATED_TRAINING_DATASET_VERSION_ID}" \
    --arg runtime_device_model_version_id "${RUNTIME_DEVICE_MODEL_VERSION_ID}" \
    --arg runtime_device_binding_key "${RUNTIME_DEVICE_BINDING_KEY}" \
    --arg runtime_device_request_id "${RUNTIME_DEVICE_REQUEST_ID}" \
    --arg runtime_device_delivery_id "${RUNTIME_DEVICE_DELIVERY_ID}" \
    --arg ocr_closure_strict_local_command "${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" \
    --arg ocr_closure_require_real_mode "${OCR_CLOSURE_REQUIRE_REAL_MODE}" \
    --arg ocr_closure_require_pure_real_registration "${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}" \
    --arg ocr_closure_wait_polls "${OCR_CLOSURE_WAIT_POLLS}" \
    --arg ocr_closure_wait_sleep_sec "${OCR_CLOSURE_WAIT_SLEEP_SEC}" \
    --arg real_closure_strict_registration "${REAL_CLOSURE_STRICT_REGISTRATION}" \
    --arg real_closure_require_real_mode "${REAL_CLOSURE_REQUIRE_REAL_MODE}" \
    --arg real_closure_require_pure_real_registration "${REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}" \
    --arg real_closure_allow_ocr_calibrated_registration "${REAL_CLOSURE_ALLOW_OCR_CALIBRATED_REGISTRATION}" \
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
        inference_attachment_id: $inference_attachment_id,
        dedicated_reference_worker_id: $dedicated_reference_worker_id,
        dedicated_reference_job_id: $dedicated_reference_job_id,
        dedicated_cancel_worker_id: $dedicated_cancel_worker_id,
        dedicated_cancel_job_id: $dedicated_cancel_job_id,
        dedicated_training_dataset_id: $dedicated_training_dataset_id,
        dedicated_training_dataset_version_id: $dedicated_training_dataset_version_id,
        runtime_device_model_version_id: $runtime_device_model_version_id,
        runtime_device_binding_key: $runtime_device_binding_key,
        runtime_device_request_id: $runtime_device_request_id,
        runtime_device_delivery_id: $runtime_device_delivery_id
      },
      options: {
        ocr_closure_strict_local_command: $ocr_closure_strict_local_command,
        ocr_closure_require_real_mode: $ocr_closure_require_real_mode,
        ocr_closure_require_pure_real_registration: $ocr_closure_require_pure_real_registration,
        ocr_closure_wait_polls: $ocr_closure_wait_polls,
        ocr_closure_wait_sleep_sec: $ocr_closure_wait_sleep_sec,
        real_closure_strict_registration: $real_closure_strict_registration,
        real_closure_require_real_mode: $real_closure_require_real_mode,
        real_closure_require_pure_real_registration: $real_closure_require_pure_real_registration,
        real_closure_allow_ocr_calibrated_registration: $real_closure_allow_ocr_calibrated_registration
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
- Verify Options:
  - OCR_CLOSURE_STRICT_LOCAL_COMMAND=${OCR_CLOSURE_STRICT_LOCAL_COMMAND}
  - OCR_CLOSURE_REQUIRE_REAL_MODE=${OCR_CLOSURE_REQUIRE_REAL_MODE}
  - OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION=${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}
  - OCR_CLOSURE_WAIT_POLLS=${OCR_CLOSURE_WAIT_POLLS}
  - OCR_CLOSURE_WAIT_SLEEP_SEC=${OCR_CLOSURE_WAIT_SLEEP_SEC}
  - REAL_CLOSURE_STRICT_REGISTRATION=${REAL_CLOSURE_STRICT_REGISTRATION}
  - REAL_CLOSURE_REQUIRE_REAL_MODE=${REAL_CLOSURE_REQUIRE_REAL_MODE}
  - REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION=${REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}
  - REAL_CLOSURE_ALLOW_OCR_CALIBRATED_REGISTRATION=${REAL_CLOSURE_ALLOW_OCR_CALIBRATED_REGISTRATION}

## Key IDs
- attachment_id: ${ATTACHMENT_ID}
- inference_attachment_id: ${INFERENCE_ATTACHMENT_ID}
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
- runtime_device_model_version_id: ${RUNTIME_DEVICE_MODEL_VERSION_ID}
- runtime_device_binding_key: ${RUNTIME_DEVICE_BINDING_KEY}
- runtime_device_request_id: ${RUNTIME_DEVICE_REQUEST_ID}
- runtime_device_delivery_id: ${RUNTIME_DEVICE_DELIVERY_ID}

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

pick_registered_model_version_id() {
  local versions_payload="$1"
  local task_type="$2"
  local framework_filter="${3:-}"
  echo "${versions_payload}" | jq -r --arg task_type "${task_type}" --arg framework "${framework_filter}" '
    [.data[] | select(.status=="registered" and .task_type==$task_type and ($framework=="" or .framework==$framework))]
    | sort_by(.created_at // "")
    | reverse
    | .[0].id // empty
  '
}

describe_registered_model_version_candidates() {
  local versions_payload="$1"
  local task_type="$2"
  local framework_filter="${3:-}"
  echo "${versions_payload}" | jq -c --arg task_type "${task_type}" --arg framework "${framework_filter}" '
    [.data[] | select(.status=="registered" and .task_type==$task_type and ($framework=="" or .framework==$framework))
     | {id,framework,status,created_at,training_job_id}]
    | sort_by(.created_at // "")
    | reverse
  '
}

perform_inference_run() {
  local cookie_file="$1"
  local csrf_token="$2"
  local model_version_id="$3"
  local task_type="$4"
  local input_attachment_id="$5"

  local response_body
  response_body="$(mktemp)"
  local http_status=''
  local request_attempt=0
  local request_max_attempts=$((INFERENCE_RUN_POST_RETRY_MAX_ATTEMPTS + 1))
  local response_excerpt=''

  while [[ "${request_attempt}" -lt "${request_max_attempts}" ]]; do
    request_attempt=$((request_attempt + 1))
    http_status="$(
      curl -sS -o "${response_body}" -w '%{http_code}' -c "${cookie_file}" -b "${cookie_file}" \
        -X POST "${BASE_URL}/api/inference/runs" \
        -H 'Content-Type: application/json' \
        -H "x-csrf-token: ${csrf_token}" \
        -d "{\"model_version_id\":\"${model_version_id}\",\"input_attachment_id\":\"${input_attachment_id}\",\"task_type\":\"${task_type}\"}"
    )"

    if [[ "${http_status}" == "200" ]]; then
      cat "${response_body}"
      rm -f "${response_body}"
      return 0
    fi

    if [[ "${http_status}" == "504" ]]; then
      local recovered_run_id=''
      for _ in $(seq 1 "${INFERENCE_RUN_RECOVERY_MAX_TRIES}"); do
        local runs_payload
        runs_payload="$(curl -fsS -c "${cookie_file}" -b "${cookie_file}" "${BASE_URL}/api/inference/runs")"
        recovered_run_id="$(
          echo "${runs_payload}" | jq -r \
            --arg model_version_id "${model_version_id}" \
            --arg task_type "${task_type}" \
            --arg input_attachment_id "${input_attachment_id}" \
            '.data[] | select(.model_version_id==$model_version_id and .task_type==$task_type and .input_attachment_id==$input_attachment_id) | .id' \
            | head -n 1
        )"
        if [[ -n "${recovered_run_id}" ]]; then
          local recovered_payload
          recovered_payload="$(curl -fsS -c "${cookie_file}" -b "${cookie_file}" "${BASE_URL}/api/inference/runs/${recovered_run_id}")"
          echo "${recovered_payload}"
          rm -f "${response_body}"
          return 0
        fi
        sleep "${INFERENCE_RUN_RECOVERY_INTERVAL_SECONDS}"
      done
    fi

    response_excerpt="$(head -c 240 "${response_body}" | tr '\n' ' ')"
    if [[ "${request_attempt}" -lt "${request_max_attempts}" ]]; then
      echo "[docker-verify-full] inference request attempt ${request_attempt}/${request_max_attempts} failed (task=${task_type}, model_version_id=${model_version_id}, input_attachment_id=${input_attachment_id}, http_status=${http_status}). Retrying..." >&2
      sleep "${INFERENCE_RUN_POST_RETRY_INTERVAL_SECONDS}"
      continue
    fi
  done

  echo "[docker-verify-full] inference request failed (task=${task_type}, model_version_id=${model_version_id}, input_attachment_id=${input_attachment_id}, http_status=${http_status}, attempts=${request_max_attempts})" >&2
  echo "response_excerpt=${response_excerpt}" >&2
  rm -f "${response_body}"
  return 1
}

CURRENT_STEP='infrastructure health checks'
echo "[docker-verify-full] 1/19 ${CURRENT_STEP}"
bash scripts/smoke-navigation-context-hygiene.sh
if [[ "${VERIFY_SKIP_HEALTHZ}" != "1" ]]; then
  curl -fsS "${BASE_URL}/healthz" >/dev/null
fi
curl -fsS "${BASE_URL}/api/health" >/dev/null
if [[ "${VERIFY_SKIP_HEALTHZ}" == "1" ]]; then
  append_check "${CURRENT_STEP}" "passed" "navigation-context hygiene passed; api health endpoint is reachable (/healthz check skipped)"
else
  append_check "${CURRENT_STEP}" "passed" "navigation-context hygiene passed; health endpoints are reachable"
fi

CURRENT_STEP='probe login'
echo "[docker-verify-full] 2/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 3/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 4/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 5/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 6/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 7/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 8/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 9/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 10/19 ${CURRENT_STEP}"
RUNTIME_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/runtime/connectivity")"
echo "${RUNTIME_RESPONSE}" | jq -e '.success == true and (.data | length) >= 3 and ([.data[].error_kind] | all(. != null))' >/dev/null
RUNTIME_METRICS_RETENTION_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/runtime/metrics-retention")"
echo "${RUNTIME_METRICS_RETENTION_RESPONSE}" | jq -e '.success == true and (.data.max_points_per_job | tonumber) >= 8 and (.data.max_total_rows | tonumber) >= 1000 and (.data.current_total_rows | tonumber) >= 0' >/dev/null
RUNTIME_METRICS_RETENTION_JSON="$(echo "${RUNTIME_METRICS_RETENTION_RESPONSE}" | jq -c '.data')"
append_check "${CURRENT_STEP}" "passed" "runtime connectivity + metrics retention summary available"

CURRENT_STEP='detection + ocr inference'
echo "[docker-verify-full] 11/19 ${CURRENT_STEP}"
MODEL_VERSIONS_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/model-versions")"
DETECTION_MODEL_VERSION_CANDIDATES="$(describe_registered_model_version_candidates "${MODEL_VERSIONS_RESPONSE}" "detection" "")"
OCR_MODEL_VERSION_CANDIDATES_PADDLE="$(describe_registered_model_version_candidates "${MODEL_VERSIONS_RESPONSE}" "ocr" "paddleocr")"
OCR_MODEL_VERSION_CANDIDATES_ANY="$(describe_registered_model_version_candidates "${MODEL_VERSIONS_RESPONSE}" "ocr" "")"
DETECTION_MODEL_VERSION_ID="$(pick_registered_model_version_id "${MODEL_VERSIONS_RESPONSE}" "detection" "")"
OCR_MODEL_VERSION_ID="$(pick_registered_model_version_id "${MODEL_VERSIONS_RESPONSE}" "ocr" "paddleocr")"
if [[ -z "${OCR_MODEL_VERSION_ID}" ]]; then
  OCR_MODEL_VERSION_ID="$(pick_registered_model_version_id "${MODEL_VERSIONS_RESPONSE}" "ocr" "")"
fi
if [[ -z "${DETECTION_MODEL_VERSION_ID}" || -z "${OCR_MODEL_VERSION_ID}" ]]; then
  echo "[docker-verify-full] required registered detection/ocr model versions were not found (registered candidates are empty)"
  echo "detection_candidates=${DETECTION_MODEL_VERSION_CANDIDATES}"
  echo "ocr_paddle_candidates=${OCR_MODEL_VERSION_CANDIDATES_PADDLE}"
  echo "ocr_any_candidates=${OCR_MODEL_VERSION_CANDIDATES_ANY}"
  echo "${MODEL_VERSIONS_RESPONSE}"
  exit 1
fi

INFERENCE_UPLOAD_FILE_PATH="${INFERENCE_UPLOAD_FILE_PATH:-}"
if [[ -z "${INFERENCE_UPLOAD_FILE_PATH}" ]]; then
  INFERENCE_UPLOAD_FILE_PATH="$(
    find demo_data -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) -print -quit 2>/dev/null || true
  )"
fi
if [[ -z "${INFERENCE_UPLOAD_FILE_PATH}" ]]; then
  echo "[docker-verify-full] no image file found for inference upload (set INFERENCE_UPLOAD_FILE_PATH or add demo_data images)."
  exit 1
fi
INFERENCE_UPLOAD_FILENAME="$(basename "${INFERENCE_UPLOAD_FILE_PATH}")"

INFERENCE_UPLOAD_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/files/inference/upload" \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -F "file=@${INFERENCE_UPLOAD_FILE_PATH};filename=${INFERENCE_UPLOAD_FILENAME}")"
INFERENCE_ATTACHMENT_ID="$(echo "${INFERENCE_UPLOAD_RESPONSE}" | jq -r '.data.id // empty')"
if [[ -z "${INFERENCE_ATTACHMENT_ID}" ]]; then
  echo "[docker-verify-full] inference attachment upload failed"
  echo "${INFERENCE_UPLOAD_RESPONSE}"
  exit 1
fi

INFERENCE_ATTACHMENT_STATUS=''
INFERENCE_ATTACHMENT_DETAIL='null'
for _ in $(seq 1 "${POLL_MAX_TRIES}"); do
  INFERENCE_FILES_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
    "${BASE_URL}/api/files/inference")"
  INFERENCE_ATTACHMENT_DETAIL="$(echo "${INFERENCE_FILES_RESPONSE}" | jq -c --arg id "${INFERENCE_ATTACHMENT_ID}" '.data[] | select(.id == $id) | .')"
  INFERENCE_ATTACHMENT_STATUS="$(echo "${INFERENCE_ATTACHMENT_DETAIL}" | jq -r '.status // empty' 2>/dev/null || true)"
  if [[ "${INFERENCE_ATTACHMENT_STATUS}" == 'ready' || "${INFERENCE_ATTACHMENT_STATUS}" == 'error' ]]; then
    break
  fi
  sleep "${POLL_INTERVAL_SECONDS}"
done
if [[ "${INFERENCE_ATTACHMENT_STATUS}" != 'ready' ]]; then
  echo "[docker-verify-full] inference attachment did not become ready"
  echo "inference_attachment_id=${INFERENCE_ATTACHMENT_ID} status=${INFERENCE_ATTACHMENT_STATUS}"
  echo "inference_attachment_detail=${INFERENCE_ATTACHMENT_DETAIL}"
  echo "${INFERENCE_FILES_RESPONSE}"
  exit 1
fi

DETECTION_RESPONSE="$(perform_inference_run "${BUSINESS_COOKIE}" "${BUSINESS_CSRF}" "${DETECTION_MODEL_VERSION_ID}" "detection" "${INFERENCE_ATTACHMENT_ID}")"
if ! echo "${DETECTION_RESPONSE}" | jq -e '.success == true and (.data.id | type == "string") and (.data.normalized_output.normalized_output.source | type == "string") and ((.data.normalized_output.boxes // []) | type == "array") and ((.data.raw_output.runtime_fallback_reason // .data.raw_output.local_command_fallback_reason // .data.raw_output.meta.fallback_reason // "") | type == "string")' >/dev/null; then
  echo "[docker-verify-full] detection inference response shape assertion failed (source/boxes/run)"
  echo "detection_candidates=${DETECTION_MODEL_VERSION_CANDIDATES}"
  echo "${DETECTION_RESPONSE}"
  exit 1
fi
DETECTION_RUN_ID="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.id')"
if [[ -z "${DETECTION_RUN_ID}" || "${DETECTION_RUN_ID}" == 'null' ]]; then
  echo "[docker-verify-full] detection inference failed"
  echo "detection_candidates=${DETECTION_MODEL_VERSION_CANDIDATES}"
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

OCR_RESPONSE="$(perform_inference_run "${BUSINESS_COOKIE}" "${BUSINESS_CSRF}" "${OCR_MODEL_VERSION_ID}" "ocr" "${INFERENCE_ATTACHMENT_ID}")"
if ! echo "${OCR_RESPONSE}" | jq -e '.success == true and (.data.id | type == "string") and (.data.normalized_output.normalized_output.source | type == "string") and ((.data.normalized_output.ocr.lines // []) | type == "array") and ((.data.raw_output.runtime_fallback_reason // .data.raw_output.local_command_fallback_reason // .data.raw_output.meta.fallback_reason // "") | type == "string")' >/dev/null; then
  echo "[docker-verify-full] ocr inference response shape assertion failed (source/lines/run)"
  echo "ocr_paddle_candidates=${OCR_MODEL_VERSION_CANDIDATES_PADDLE}"
  echo "ocr_any_candidates=${OCR_MODEL_VERSION_CANDIDATES_ANY}"
  echo "${OCR_RESPONSE}"
  exit 1
fi
OCR_RUN_ID="$(echo "${OCR_RESPONSE}" | jq -r '.data.id')"
if [[ -z "${OCR_RUN_ID}" || "${OCR_RUN_ID}" == 'null' ]]; then
  echo "[docker-verify-full] ocr inference failed"
  echo "ocr_paddle_candidates=${OCR_MODEL_VERSION_CANDIDATES_PADDLE}"
  echo "ocr_any_candidates=${OCR_MODEL_VERSION_CANDIDATES_ANY}"
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
append_check "${CURRENT_STEP}" "passed" "input_attachment=${INFERENCE_ATTACHMENT_ID}; detection run ${DETECTION_RUN_ID} (${DETECTION_MODEL_VERSION_ID}) source=${DETECTION_SOURCE_VALUE} boxes=${DETECTION_BOX_COUNT} fallback=${DETECTION_RUNTIME_FALLBACK_REASON:-${DETECTION_LOCAL_FALLBACK_REASON:-${DETECTION_TEMPLATE_REASON:-none}}}; ocr run ${OCR_RUN_ID} (${OCR_MODEL_VERSION_ID}) source=${OCR_SOURCE_VALUE} lines=${OCR_LINE_COUNT} fallback=${OCR_RUNTIME_FALLBACK_REASON:-${OCR_LOCAL_FALLBACK_REASON:-${OCR_TEMPLATE_REASON:-none}}}"

CURRENT_STEP='inference feedback to dataset'
echo "[docker-verify-full] 12/19 ${CURRENT_STEP}"
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
if [[ "${detection_feedback_source_attachment_id}" != "${INFERENCE_ATTACHMENT_ID}" || "${detection_feedback_metadata_run_id}" != "${DETECTION_RUN_ID}" ]]; then
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
if [[ "${ocr_feedback_source_attachment_id}" != "${INFERENCE_ATTACHMENT_ID}" || "${ocr_feedback_metadata_run_id}" != "${OCR_RUN_ID}" ]]; then
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
if [[ "${detection_idempotent_item_count}" != "1" || "${detection_idempotent_reason}" != "${IDEMPOTENT_DETECTION_REASON}" || "${detection_idempotent_source_attachment_id}" != "${INFERENCE_ATTACHMENT_ID}" ]]; then
  echo "[docker-verify-full] detection feedback idempotency expectation failed"
  echo "${DETECTION_DATASET_AFTER_IDEMPOTENT}"
  exit 1
fi

OCR_DATASET_AFTER_IDEMPOTENT="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/datasets/${OCR_FEEDBACK_DATASET_ID}")"
ocr_idempotent_item_count="$(echo "${OCR_DATASET_AFTER_IDEMPOTENT}" | jq -r --arg run_id "${OCR_RUN_ID}" '[.data.items[] | select((.metadata.inference_run_id // "") == $run_id)] | length')"
ocr_idempotent_reason="$(echo "${OCR_DATASET_AFTER_IDEMPOTENT}" | jq -r --arg run_id "${OCR_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.feedback_reason // empty' | head -n 1)"
ocr_idempotent_source_attachment_id="$(echo "${OCR_DATASET_AFTER_IDEMPOTENT}" | jq -r --arg run_id "${OCR_RUN_ID}" '.data.items[] | select((.metadata.inference_run_id // "") == $run_id) | .metadata.source_attachment_id // empty' | head -n 1)"
if [[ "${ocr_idempotent_item_count}" != "1" || "${ocr_idempotent_reason}" != "${IDEMPOTENT_OCR_REASON}" || "${ocr_idempotent_source_attachment_id}" != "${INFERENCE_ATTACHMENT_ID}" ]]; then
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
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -F "file=@${INFERENCE_UPLOAD_FILE_PATH};filename=verify-feedback-reuse-${RUN_TAG}.jpg")"
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
echo "[docker-verify-full] 13/19 ${CURRENT_STEP}"
PHASE2_OUTPUT=''
PHASE2_ATTEMPTS_USED=0
phase2_exit_code=1
for attempt in $(seq 1 "${PHASE2_RETRY_MAX_ATTEMPTS}"); do
  PHASE2_ATTEMPTS_USED="${attempt}"
  set +e
  PHASE2_OUTPUT="$(START_API=false BASE_URL="${BASE_URL}" AUTH_USERNAME="${BUSINESS_USERNAME}" AUTH_PASSWORD="${BUSINESS_PASSWORD}" EXPECT_RUNTIME_FALLBACK=false bash scripts/smoke-phase2.sh 2>&1)"
  phase2_exit_code=$?
  set -e

  if [[ "${phase2_exit_code}" -eq 0 ]]; then
    break
  fi

  echo "[docker-verify-full] smoke-phase2 attempt ${attempt}/${PHASE2_RETRY_MAX_ATTEMPTS} failed (exit=${phase2_exit_code})" >&2
  echo "${PHASE2_OUTPUT}" >&2
  if [[ "${attempt}" -lt "${PHASE2_RETRY_MAX_ATTEMPTS}" ]]; then
    sleep "${PHASE2_RETRY_INTERVAL_SECONDS}"
  fi
done
if [[ "${phase2_exit_code}" -ne 0 ]]; then
  echo "[docker-verify-full] smoke-phase2 failed after ${PHASE2_ATTEMPTS_USED} attempts"
  exit "${phase2_exit_code}"
fi
echo "${PHASE2_OUTPUT}"
PHASE2_DATASET_ID="$(echo "${PHASE2_OUTPUT}" | awk -F= '/^dataset_id=/{print $2; exit}')"
PHASE2_NO_TRAIN_VERSION_ID="$(echo "${PHASE2_OUTPUT}" | awk -F= '/^no_train_gate_version_id=/{print $2; exit}')"
if [[ -z "${PHASE2_DATASET_ID}" || -z "${PHASE2_NO_TRAIN_VERSION_ID}" ]]; then
  echo "[docker-verify-full] phase2 output missing required ids"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "phase2 dataset=${PHASE2_DATASET_ID}, no-train gate version=${PHASE2_NO_TRAIN_VERSION_ID}, attempts=${PHASE2_ATTEMPTS_USED}"

CURRENT_STEP='dataset export/import roundtrip'
echo "[docker-verify-full] 14/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 15/19 ${CURRENT_STEP}"
REAL_CLOSURE_OUTPUT="$(START_API=false REAL_CLOSURE_STRICT_REGISTRATION="${REAL_CLOSURE_STRICT_REGISTRATION}" REAL_CLOSURE_REQUIRE_REAL_MODE="${REAL_CLOSURE_REQUIRE_REAL_MODE}" REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION="${REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}" REAL_CLOSURE_ALLOW_OCR_CALIBRATED_REGISTRATION="${REAL_CLOSURE_ALLOW_OCR_CALIBRATED_REGISTRATION}" BASE_URL="${BASE_URL}" AUTH_USERNAME="${BUSINESS_USERNAME}" AUTH_PASSWORD="${BUSINESS_PASSWORD}" bash scripts/smoke-real-closure.sh)"
echo "${REAL_CLOSURE_OUTPUT}"

REAL_CLOSURE_YOLO_SOURCE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^yolo_source=/{print $2; exit}')"
REAL_CLOSURE_OCR_SOURCE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^ocr_source=/{print $2; exit}')"
REAL_CLOSURE_DOCTR_SOURCE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^doctr_source=/{print $2; exit}')"
REAL_CLOSURE_YOLO_REGISTER_MODE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^yolo_register_mode=/{print $2; exit}')"
REAL_CLOSURE_DOCTR_REGISTER_MODE="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^doctr_register_mode=/{print $2; exit}')"
REAL_CLOSURE_NEW_OCR_MODEL_ID="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^new_ocr_model_id=/{print $2; exit}')"
REAL_CLOSURE_NEW_OCR_VERSION_ID="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^new_ocr_model_version_id=/{print $2; exit}')"
REAL_CLOSURE_NEW_OCR_JOB_ID="$(echo "${REAL_CLOSURE_OUTPUT}" | awk -F= '/^new_ocr_training_job_id=/{print $2; exit}')"
if [[ -z "${REAL_CLOSURE_YOLO_SOURCE}" || -z "${REAL_CLOSURE_OCR_SOURCE}" || -z "${REAL_CLOSURE_DOCTR_SOURCE}" ]]; then
  echo "[docker-verify-full] real closure output missing inference sources"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "sources: yolo=${REAL_CLOSURE_YOLO_SOURCE}, paddleocr=${REAL_CLOSURE_OCR_SOURCE}, doctr=${REAL_CLOSURE_DOCTR_SOURCE}; register_modes: yolo=${REAL_CLOSURE_YOLO_REGISTER_MODE:-unknown}, doctr=${REAL_CLOSURE_DOCTR_REGISTER_MODE:-unknown}; new_ocr_model=${REAL_CLOSURE_NEW_OCR_MODEL_ID:-unknown}; new_ocr_version=${REAL_CLOSURE_NEW_OCR_VERSION_ID:-unknown}; new_ocr_job=${REAL_CLOSURE_NEW_OCR_JOB_ID:-unknown}; strict_registration=${REAL_CLOSURE_STRICT_REGISTRATION}; require_real_mode=${REAL_CLOSURE_REQUIRE_REAL_MODE}; require_pure_real_registration=${REAL_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}"

CURRENT_STEP='ocr closure smoke (paddleocr + doctr)'
echo "[docker-verify-full] 16/19 ${CURRENT_STEP}"
OCR_CLOSURE_OUTPUT=''
OCR_CLOSURE_ATTEMPTS_USED=0
ocr_closure_exit_code=1
for attempt in $(seq 1 "${OCR_CLOSURE_RETRY_MAX_ATTEMPTS}"); do
  OCR_CLOSURE_ATTEMPTS_USED="${attempt}"
  set +e
  OCR_CLOSURE_OUTPUT="$(
    START_API=false \
    OCR_CLOSURE_STRICT_LOCAL_COMMAND="${OCR_CLOSURE_STRICT_LOCAL_COMMAND}" \
    OCR_CLOSURE_REQUIRE_REAL_MODE="${OCR_CLOSURE_REQUIRE_REAL_MODE}" \
    OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION="${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}" \
    OCR_CLOSURE_WAIT_POLLS="${OCR_CLOSURE_WAIT_POLLS}" \
    OCR_CLOSURE_WAIT_SLEEP_SEC="${OCR_CLOSURE_WAIT_SLEEP_SEC}" \
    BASE_URL="${BASE_URL}" \
    AUTH_USERNAME="${BUSINESS_USERNAME}" \
    AUTH_PASSWORD="${BUSINESS_PASSWORD}" \
    bash scripts/smoke-ocr-closure.sh 2>&1
  )"
  ocr_closure_exit_code=$?
  set -e

  if [[ "${ocr_closure_exit_code}" -eq 0 ]]; then
    break
  fi

  echo "[docker-verify-full] smoke-ocr-closure attempt ${attempt}/${OCR_CLOSURE_RETRY_MAX_ATTEMPTS} failed (exit=${ocr_closure_exit_code})" >&2
  echo "${OCR_CLOSURE_OUTPUT}" >&2
  if [[ "${attempt}" -lt "${OCR_CLOSURE_RETRY_MAX_ATTEMPTS}" ]]; then
    sleep "${OCR_CLOSURE_RETRY_INTERVAL_SECONDS}"
  fi
done
if [[ "${ocr_closure_exit_code}" -ne 0 ]]; then
  echo "[docker-verify-full] smoke-ocr-closure failed after ${OCR_CLOSURE_ATTEMPTS_USED} attempts"
  exit "${ocr_closure_exit_code}"
fi
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
append_check "${CURRENT_STEP}" "passed" "execution_sources: paddleocr=${OCR_CLOSURE_PADDLE_SOURCE}, doctr=${OCR_CLOSURE_DOCTR_SOURCE}; metrics: paddle_accuracy=${OCR_CLOSURE_PADDLE_ACCURACY}, doctr_${OCR_CLOSURE_DOCTR_PRIMARY_NAME}=${OCR_CLOSURE_DOCTR_PRIMARY_VALUE}; register_modes: paddle=${OCR_CLOSURE_PADDLE_REGISTER_MODE:-unknown}, doctr=${OCR_CLOSURE_DOCTR_REGISTER_MODE:-unknown}; strict_local_command=${OCR_CLOSURE_STRICT_LOCAL_COMMAND}; require_real_mode=${OCR_CLOSURE_REQUIRE_REAL_MODE}; require_pure_real_registration=${OCR_CLOSURE_REQUIRE_PURE_REAL_REGISTRATION}; attempts=${OCR_CLOSURE_ATTEMPTS_USED}"

CURRENT_STEP='training worker dedicated auth smoke'
echo "[docker-verify-full] 17/19 ${CURRENT_STEP}"
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
echo "[docker-verify-full] 18/19 ${CURRENT_STEP}"
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

CURRENT_STEP='runtime device access chain'
echo "[docker-verify-full] 19/19 ${CURRENT_STEP}"
RUNTIME_DEVICE_ACCESS_OUTPUT="$(
  env \
    START_API=false \
    BASE_URL="${BASE_URL}" \
    AUTH_USERNAME="${ADMIN_USERNAME}" \
    AUTH_PASSWORD="${ADMIN_PASSWORD}" \
    bash scripts/smoke-runtime-device-access.sh
)"
echo "${RUNTIME_DEVICE_ACCESS_OUTPUT}"
RUNTIME_DEVICE_MODEL_VERSION_ID="$(echo "${RUNTIME_DEVICE_ACCESS_OUTPUT}" | awk -F= '/^model_version_id=/{print $2; exit}')"
RUNTIME_DEVICE_BINDING_KEY="$(echo "${RUNTIME_DEVICE_ACCESS_OUTPUT}" | awk -F= '/^binding_key=/{print $2; exit}')"
RUNTIME_DEVICE_REQUEST_ID="$(echo "${RUNTIME_DEVICE_ACCESS_OUTPUT}" | awk -F= '/^request_id=/{print $2; exit}')"
RUNTIME_DEVICE_DELIVERY_ID="$(echo "${RUNTIME_DEVICE_ACCESS_OUTPUT}" | awk -F= '/^delivery_id=/{print $2; exit}')"
if [[ -z "${RUNTIME_DEVICE_MODEL_VERSION_ID}" || -z "${RUNTIME_DEVICE_BINDING_KEY}" || -z "${RUNTIME_DEVICE_REQUEST_ID}" || -z "${RUNTIME_DEVICE_DELIVERY_ID}" ]]; then
  echo "[docker-verify-full] runtime-device-access output missing required values"
  exit 1
fi
append_check "${CURRENT_STEP}" "passed" "model_version=${RUNTIME_DEVICE_MODEL_VERSION_ID}, binding=${RUNTIME_DEVICE_BINDING_KEY}, request_id=${RUNTIME_DEVICE_REQUEST_ID}, delivery_id=${RUNTIME_DEVICE_DELIVERY_ID}"

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
