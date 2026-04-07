#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${WORKER_ENV_FILE:-${WORKER_ROOT}/.env.worker}"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

CONTROL_PLANE_BASE_URL="${CONTROL_PLANE_BASE_URL:-}"
TRAINING_WORKER_SHARED_TOKEN="${TRAINING_WORKER_SHARED_TOKEN:-}"
TRAINING_WORKER_AUTH_TOKEN="${TRAINING_WORKER_AUTH_TOKEN:-${TRAINING_WORKER_SHARED_TOKEN}}"
WORKER_ID="${WORKER_ID:-}"
WORKER_NAME="${WORKER_NAME:-${WORKER_ID:-unnamed-worker}}"
WORKER_ENDPOINT="${WORKER_ENDPOINT:-}"
WORKER_STATUS="${WORKER_STATUS:-online}"
WORKER_ENABLED="${WORKER_ENABLED:-true}"
WORKER_MAX_CONCURRENCY="${WORKER_MAX_CONCURRENCY:-1}"
WORKER_CAPABILITIES="${WORKER_CAPABILITIES:-}"
HEARTBEAT_INTERVAL_SECONDS="${HEARTBEAT_INTERVAL_SECONDS:-15}"
WORKER_REPORTED_LOAD="${WORKER_REPORTED_LOAD:-}"

if [[ -z "${CONTROL_PLANE_BASE_URL}" ]]; then
  echo "error: CONTROL_PLANE_BASE_URL is required." >&2
  exit 1
fi
if [[ -z "${TRAINING_WORKER_AUTH_TOKEN}" ]]; then
  echo "error: TRAINING_WORKER_AUTH_TOKEN is required." >&2
  exit 1
fi
if [[ -z "${WORKER_ID}" ]]; then
  echo "error: WORKER_ID is required." >&2
  exit 1
fi

CONTROL_PLANE_BASE_URL="${CONTROL_PLANE_BASE_URL%/}"
HEARTBEAT_URL="${CONTROL_PLANE_BASE_URL}/api/runtime/training-workers/heartbeat"

detect_load() {
  if [[ -n "${WORKER_REPORTED_LOAD}" ]]; then
    echo "${WORKER_REPORTED_LOAD}"
    return
  fi

  local cpu_count load_1m normalized
  cpu_count="1"
  load_1m="0"

  if command -v nproc >/dev/null 2>&1; then
    cpu_count="$(nproc)"
  elif command -v getconf >/dev/null 2>&1; then
    cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
  fi
  [[ -z "${cpu_count}" || "${cpu_count}" == "0" ]] && cpu_count="1"

  if [[ -r /proc/loadavg ]]; then
    load_1m="$(awk '{print $1}' /proc/loadavg)"
  elif command -v uptime >/dev/null 2>&1; then
    load_1m="$(uptime | awk -F'load averages?: ' '{print $2}' | awk -F', ' '{print $1}' | tr -d ' ')"
  fi
  [[ -z "${load_1m}" ]] && load_1m="0"

  normalized="$(awk -v l="${load_1m}" -v c="${cpu_count}" 'BEGIN { if (c <= 0) c = 1; v = l / c; if (v < 0) v = 0; printf "%.3f", v }')"
  echo "${normalized}"
}

build_capabilities_json() {
  if [[ -z "${WORKER_CAPABILITIES}" ]]; then
    echo "[]"
    return
  fi

  local result token first
  result="["
  first="true"
  IFS=',' read -r -a tokens <<< "${WORKER_CAPABILITIES}"
  for token in "${tokens[@]}"; do
    token="$(echo "${token}" | xargs)"
    [[ -z "${token}" ]] && continue
    if [[ "${first}" == "true" ]]; then
      result="${result}\"${token}\""
      first="false"
    else
      result="${result},\"${token}\""
    fi
  done
  result="${result}]"
  echo "${result}"
}

send_heartbeat_once() {
  local reported_load capabilities_json host_name payload
  reported_load="$(detect_load)"
  capabilities_json="$(build_capabilities_json)"
  host_name="$(hostname 2>/dev/null || echo unknown)"

  payload="$(printf '{"worker_id":"%s","name":"%s","endpoint":"%s","status":"%s","enabled":%s,"max_concurrency":%s,"reported_load":%s,"capabilities":%s,"metadata":{"host":"%s","source":"worker-heartbeat.sh"}}' \
    "${WORKER_ID}" \
    "${WORKER_NAME}" \
    "${WORKER_ENDPOINT}" \
    "${WORKER_STATUS}" \
    "${WORKER_ENABLED}" \
    "${WORKER_MAX_CONCURRENCY}" \
    "${reported_load}" \
    "${capabilities_json}" \
    "${host_name}")"

  curl --silent --show-error --fail \
    --max-time 12 \
    -X POST "${HEARTBEAT_URL}" \
    -H "Content-Type: application/json" \
    -H "X-Training-Worker-Token: ${TRAINING_WORKER_AUTH_TOKEN}" \
    -d "${payload}" >/dev/null

  printf '[worker-heartbeat] sent worker_id=%s status=%s load=%s time=%s\n' \
    "${WORKER_ID}" "${WORKER_STATUS}" "${reported_load}" "$(date '+%Y-%m-%d %H:%M:%S')"
}

if [[ "${1:-}" == "--once" ]]; then
  send_heartbeat_once
  exit 0
fi

echo "[worker-heartbeat] loop started, target=${HEARTBEAT_URL}, interval=${HEARTBEAT_INTERVAL_SECONDS}s"
while true; do
  if ! send_heartbeat_once; then
    echo "[worker-heartbeat] request failed, retrying in ${HEARTBEAT_INTERVAL_SECONDS}s" >&2
  fi
  sleep "${HEARTBEAT_INTERVAL_SECONDS}"
done
