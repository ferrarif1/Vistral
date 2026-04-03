#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
PROBE_PASSWORD="${PROBE_PASSWORD:-healthcheck123}"
BUSINESS_USERNAME="${BUSINESS_USERNAME:-alice}"
BUSINESS_PASSWORD="${BUSINESS_PASSWORD:-mock-pass}"
POLL_MAX_TRIES="${POLL_MAX_TRIES:-20}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-0.3}"
VERIFY_SKIP_HEALTHZ="${VERIFY_SKIP_HEALTHZ:-0}"
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
PROBE_USERNAME="verify-$(date +%s)"
STARTED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CHECKS_JSON='[]'
CURRENT_STEP=''
REPORT_FINALIZED='false'

CONVERSATION_ID=''
MODEL_ID=''
APPROVAL_ID=''
DETECTION_RUN_ID=''
OCR_RUN_ID=''
ATTACHMENT_ID=''
RUNTIME_METRICS_RETENTION_JSON='null'

cleanup() {
  rm -f "${PROBE_COOKIE}" "${BUSINESS_COOKIE}"
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
    --arg model_id "${MODEL_ID}" \
    --arg approval_id "${APPROVAL_ID}" \
    --arg detection_run_id "${DETECTION_RUN_ID}" \
    --arg ocr_run_id "${OCR_RUN_ID}" \
    --arg attachment_id "${ATTACHMENT_ID}" \
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
        model_id: $model_id,
        approval_id: $approval_id,
        detection_run_id: $detection_run_id,
        ocr_run_id: $ocr_run_id,
        attachment_id: $attachment_id
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
- model_id: ${MODEL_ID}
- approval_id: ${APPROVAL_ID}
- detection_run_id: ${DETECTION_RUN_ID}
- ocr_run_id: ${OCR_RUN_ID}

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
echo "[docker-verify-full] 1/9 ${CURRENT_STEP}"
if [[ "${VERIFY_SKIP_HEALTHZ}" != "1" ]]; then
  curl -fsS "${BASE_URL}/healthz" >/dev/null
fi
curl -fsS "${BASE_URL}/api/health" >/dev/null
if [[ "${VERIFY_SKIP_HEALTHZ}" == "1" ]]; then
  append_check "${CURRENT_STEP}" "passed" "api health endpoint is reachable (/healthz check skipped)"
else
  append_check "${CURRENT_STEP}" "passed" "health endpoints are reachable"
fi

CURRENT_STEP='probe register + login'
echo "[docker-verify-full] 2/9 ${CURRENT_STEP}"
curl -fsS -c "${PROBE_COOKIE}" -b "${PROBE_COOKIE}" \
  -X POST "${BASE_URL}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${PROBE_USERNAME}\",\"password\":\"${PROBE_PASSWORD}\"}" | \
  jq -e ".success == true and .data.username == \"${PROBE_USERNAME}\" and .data.role == \"user\"" >/dev/null

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
append_check "${CURRENT_STEP}" "passed" "probe user register/login/me succeeded and wrong-password was rejected"

CURRENT_STEP='business account login'
echo "[docker-verify-full] 3/9 ${CURRENT_STEP}"
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

CURRENT_STEP='conversation attachment upload lifecycle'
echo "[docker-verify-full] 4/9 ${CURRENT_STEP}"
ATTACHMENT_UPLOAD_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/files/conversation/upload" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"filename\":\"verify-${RUN_TAG}.jpg\"}")"
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
echo "[docker-verify-full] 5/9 ${CURRENT_STEP}"
CONVERSATION_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/conversations/start" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"model_id\":\"m-1\",\"initial_message\":\"deployment verify ${RUN_TAG}\",\"attachment_ids\":[\"${ATTACHMENT_ID}\"]}")"
CONVERSATION_ID="$(echo "${CONVERSATION_RESPONSE}" | jq -r '.data.conversation.id')"

if [[ -z "${CONVERSATION_ID}" || "${CONVERSATION_ID}" == 'null' ]]; then
  echo "[docker-verify-full] failed to start conversation"
  echo "${CONVERSATION_RESPONSE}"
  exit 1
fi

echo "${CONVERSATION_RESPONSE}" | jq -e '.success == true and (.data.messages | length) >= 2' >/dev/null
append_check "${CURRENT_STEP}" "passed" "conversation ${CONVERSATION_ID} created with assistant reply"

CURRENT_STEP='model draft -> model file -> approval submit'
echo "[docker-verify-full] 6/9 ${CURRENT_STEP}"
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

MODEL_FILE_UPLOAD_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/files/model/${MODEL_ID}/upload" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"filename\":\"artifact-${RUN_TAG}.onnx\"}")"
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
echo "[docker-verify-full] 7/9 ${CURRENT_STEP}"
RUNTIME_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/runtime/connectivity")"
echo "${RUNTIME_RESPONSE}" | jq -e '.success == true and (.data | length) >= 3 and ([.data[].error_kind] | all(. != null))' >/dev/null
RUNTIME_METRICS_RETENTION_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  "${BASE_URL}/api/runtime/metrics-retention")"
echo "${RUNTIME_METRICS_RETENTION_RESPONSE}" | jq -e '.success == true and (.data.max_points_per_job | tonumber) >= 8 and (.data.max_total_rows | tonumber) >= 1000 and (.data.current_total_rows | tonumber) >= 0' >/dev/null
RUNTIME_METRICS_RETENTION_JSON="$(echo "${RUNTIME_METRICS_RETENTION_RESPONSE}" | jq -c '.data')"
append_check "${CURRENT_STEP}" "passed" "runtime connectivity + metrics retention summary available"

CURRENT_STEP='detection + ocr inference'
echo "[docker-verify-full] 8/9 ${CURRENT_STEP}"
DETECTION_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"model_version_id\":\"mv-2\",\"input_attachment_id\":\"${ATTACHMENT_ID}\",\"task_type\":\"detection\"}")"
DETECTION_RUN_ID="$(echo "${DETECTION_RESPONSE}" | jq -r '.data.id')"
if [[ -z "${DETECTION_RUN_ID}" || "${DETECTION_RUN_ID}" == 'null' ]]; then
  echo "[docker-verify-full] detection inference failed"
  echo "${DETECTION_RESPONSE}"
  exit 1
fi
echo "${DETECTION_RESPONSE}" | jq -e '.success == true and (.data.normalized_output.boxes | length) >= 1' >/dev/null

OCR_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d "{\"model_version_id\":\"mv-1\",\"input_attachment_id\":\"${ATTACHMENT_ID}\",\"task_type\":\"ocr\"}")"
OCR_RUN_ID="$(echo "${OCR_RESPONSE}" | jq -r '.data.id')"
if [[ -z "${OCR_RUN_ID}" || "${OCR_RUN_ID}" == 'null' ]]; then
  echo "[docker-verify-full] ocr inference failed"
  echo "${OCR_RESPONSE}"
  exit 1
fi
echo "${OCR_RESPONSE}" | jq -e '.success == true and (.data.normalized_output.ocr.lines | length) >= 1' >/dev/null
append_check "${CURRENT_STEP}" "passed" "detection run ${DETECTION_RUN_ID} and ocr run ${OCR_RUN_ID} succeeded"

CURRENT_STEP='inference feedback to dataset'
echo "[docker-verify-full] 9/9 ${CURRENT_STEP}"
FEEDBACK_RESPONSE="$(curl -fsS -c "${BUSINESS_COOKIE}" -b "${BUSINESS_COOKIE}" \
  -X POST "${BASE_URL}/api/inference/runs/${DETECTION_RUN_ID}/feedback" \
  -H 'Content-Type: application/json' \
  -H "x-csrf-token: ${BUSINESS_CSRF}" \
  -d '{"dataset_id":"d-2","reason":"deployment_verify"}')"
echo "${FEEDBACK_RESPONSE}" | jq -e '.success == true and .data.feedback_dataset_id == "d-2"' >/dev/null
append_check "${CURRENT_STEP}" "passed" "inference feedback linked to dataset d-2"

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
