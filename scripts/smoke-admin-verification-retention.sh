#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8787}"
BASE_URL="http://${API_HOST}:${API_PORT}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-admin-verification-retention] jq is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
APP_DATA_DIR="$(mktemp -d)"
REPORTS_DIR="${ROOT_DIR}/.data/verify-reports"
REPORT_FILE="${REPORTS_DIR}/docker-verify-full-retention-smoke-$(date +%s).json"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}"
  rm -rf "${APP_DATA_DIR}"
  rm -f "${REPORT_FILE}"
}
trap cleanup EXIT

mkdir -p "${REPORTS_DIR}"
cat > "${REPORT_FILE}" <<'JSONEOF'
{
  "status": "passed",
  "summary": "retention smoke report",
  "started_at_utc": "2026-04-03T15:20:00Z",
  "finished_at_utc": "2026-04-03T15:20:30Z",
  "target": {
    "base_url": "http://127.0.0.1:8080",
    "business_username": "alice",
    "probe_username": "verify-smoke"
  },
  "entities": {
    "model_id": "m-1",
    "approval_id": "ar-1"
  },
  "checks": [
    {
      "name": "runtime connectivity + metrics retention summary available",
      "status": "passed",
      "detail": "ok"
    }
  ],
  "runtime_metrics_retention": {
    "max_points_per_job": 180,
    "max_total_rows": 20000,
    "current_total_rows": 640,
    "visible_job_count": 14,
    "jobs_with_metrics": 9,
    "max_rows_single_job": 90,
    "near_total_cap": false,
    "top_jobs": [
      { "training_job_id": "tj-982", "rows": 90 }
    ]
  }
}
JSONEOF

cd "${ROOT_DIR}"

APP_STATE_STORE_PATH="${APP_DATA_DIR}/app-state.json" \
UPLOAD_STORAGE_ROOT="${APP_DATA_DIR}/uploads" \
TRAINING_WORKDIR_ROOT="${APP_DATA_DIR}/training" \
API_HOST="${API_HOST}" \
API_PORT="${API_PORT}" \
npm run dev:api >"${API_LOG}" 2>&1 &
API_PID=$!

for _ in {1..100}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-admin-verification-retention] API failed to start."
  cat "${API_LOG}"
  exit 1
fi

login_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -X POST "${BASE_URL}/api/auth/login" \
  -d '{"username":"admin","password":"mock-pass-admin"}')"
if [[ "$(echo "${login_resp}" | jq -r '.success')" != "true" ]]; then
  echo "[smoke-admin-verification-retention] admin login failed."
  echo "${login_resp}"
  exit 1
fi

report_filename="$(basename "${REPORT_FILE}")"
reports_resp="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/admin/verification-reports")"
found="$(echo "${reports_resp}" | jq -r --arg filename "${report_filename}" '.data[] | select(.filename==$filename) | .filename // empty')"
if [[ -z "${found}" ]]; then
  echo "[smoke-admin-verification-retention] expected report not found in API response."
  echo "${reports_resp}"
  exit 1
fi

max_points="$(echo "${reports_resp}" | jq -r --arg filename "${report_filename}" '.data[] | select(.filename==$filename) | .runtime_metrics_retention.max_points_per_job // empty')"
current_rows="$(echo "${reports_resp}" | jq -r --arg filename "${report_filename}" '.data[] | select(.filename==$filename) | .runtime_metrics_retention.current_total_rows // empty')"
if [[ "${max_points}" != "180" ]]; then
  echo "[smoke-admin-verification-retention] expected max_points_per_job=180, got ${max_points}."
  echo "${reports_resp}"
  exit 1
fi
if [[ "${current_rows}" != "640" ]]; then
  echo "[smoke-admin-verification-retention] expected current_total_rows=640, got ${current_rows}."
  echo "${reports_resp}"
  exit 1
fi

echo "[smoke-admin-verification-retention] PASS"
echo "report=${report_filename}"
echo "max_points=${max_points}"
echo "current_rows=${current_rows}"
