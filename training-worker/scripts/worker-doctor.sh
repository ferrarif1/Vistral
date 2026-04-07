#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${WORKER_ENV_FILE:-${WORKER_ROOT}/.env.worker}"

RUN_HEARTBEAT_CHECK="false"
for arg in "$@"; do
  case "${arg}" in
    --heartbeat)
      RUN_HEARTBEAT_CHECK="true"
      ;;
    *)
      echo "error: unsupported argument '${arg}'" >&2
      echo "usage: bash training-worker/scripts/worker-doctor.sh [--heartbeat]" >&2
      exit 1
      ;;
  esac
done

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

CONTROL_PLANE_BASE_URL="${CONTROL_PLANE_BASE_URL:-}"
TRAINING_WORKER_AUTH_TOKEN="${TRAINING_WORKER_AUTH_TOKEN:-}"
TRAINING_WORKER_SHARED_TOKEN="${TRAINING_WORKER_SHARED_TOKEN:-}"
RESOLVED_TRAINING_WORKER_TOKEN="${TRAINING_WORKER_AUTH_TOKEN:-${TRAINING_WORKER_SHARED_TOKEN:-}}"
WORKER_ID="${WORKER_ID:-}"
WORKER_ENDPOINT="${WORKER_ENDPOINT:-}"
WORKER_BIND_PORT="${WORKER_BIND_PORT:-9090}"
WORKER_VENV_DIR="${WORKER_VENV_DIR:-.venv-worker}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_PYTHON="${WORKER_ROOT}/${WORKER_VENV_DIR}/bin/python"
LOCAL_HEALTH_URL="http://127.0.0.1:${WORKER_BIND_PORT}/healthz"

FAIL_COUNT=0
WARN_COUNT=0

pass() {
  printf '[worker-doctor] PASS  %s\n' "$1"
}

warn() {
  printf '[worker-doctor] WARN  %s\n' "$1"
  WARN_COUNT=$((WARN_COUNT + 1))
}

fail() {
  printf '[worker-doctor] FAIL  %s\n' "$1" >&2
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

extract_host() {
  local value="${1:-}"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  value="${value%%:*}"
  printf '%s' "${value}"
}

is_local_host() {
  case "${1:-}" in
    localhost|127.0.0.1|0.0.0.0|"")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if command -v bash >/dev/null 2>&1; then
  pass "bash available"
else
  fail "bash not found"
fi

if command -v curl >/dev/null 2>&1; then
  pass "curl available"
else
  fail "curl not found"
fi

if command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  pass "python available (${PYTHON_BIN})"
else
  fail "python not found (${PYTHON_BIN})"
fi

if [[ -f "${ENV_FILE}" ]]; then
  pass "env file present (${ENV_FILE})"
else
  fail "missing ${ENV_FILE} (copy from .env.worker.example first)"
fi

if [[ -n "${CONTROL_PLANE_BASE_URL}" ]]; then
  if [[ "${CONTROL_PLANE_BASE_URL}" == "http://127.0.0.1:8080" || "${CONTROL_PLANE_BASE_URL}" == "http://localhost:8080" ]]; then
    warn "CONTROL_PLANE_BASE_URL is still local default (${CONTROL_PLANE_BASE_URL})"
  else
    pass "CONTROL_PLANE_BASE_URL configured (${CONTROL_PLANE_BASE_URL})"
  fi
else
  fail "CONTROL_PLANE_BASE_URL is required"
fi

if [[ -n "${TRAINING_WORKER_AUTH_TOKEN}" && "${TRAINING_WORKER_AUTH_TOKEN}" != "replace-with-issued-worker-token" ]]; then
  pass "TRAINING_WORKER_AUTH_TOKEN configured"
elif [[ -n "${TRAINING_WORKER_SHARED_TOKEN}" && "${TRAINING_WORKER_SHARED_TOKEN}" != "replace-with-shared-token" ]]; then
  warn "using legacy TRAINING_WORKER_SHARED_TOKEN fallback"
elif [[ -n "${RESOLVED_TRAINING_WORKER_TOKEN}" ]]; then
  pass "training worker token resolved"
else
  fail "TRAINING_WORKER_AUTH_TOKEN is missing or still placeholder"
fi

if [[ -n "${WORKER_ID}" && "${WORKER_ID}" != "tw-local-1" ]]; then
  pass "WORKER_ID configured (${WORKER_ID})"
else
  warn "WORKER_ID is still default placeholder (${WORKER_ID:-empty})"
fi

if [[ -n "${WORKER_ENDPOINT}" ]]; then
  pass "WORKER_ENDPOINT configured (${WORKER_ENDPOINT})"
else
  warn "WORKER_ENDPOINT not set; control plane may not be able to dispatch work back to this node"
fi

control_host="$(extract_host "${CONTROL_PLANE_BASE_URL}")"
worker_host="$(extract_host "${WORKER_ENDPOINT}")"
if ! is_local_host "${control_host}" && is_local_host "${worker_host}"; then
  warn "WORKER_ENDPOINT points to localhost while control plane is remote; set worker public IP/domain for dispatch"
fi

if [[ -n "${CONTROL_PLANE_BASE_URL}" ]]; then
  if curl --silent --show-error --fail --max-time 8 "${CONTROL_PLANE_BASE_URL%/}/api/auth/csrf" >/dev/null; then
    pass "control plane reachable (${CONTROL_PLANE_BASE_URL%/}/api/auth/csrf)"
  else
    fail "control plane not reachable (${CONTROL_PLANE_BASE_URL%/}/api/auth/csrf)"
  fi
fi

if [[ -x "${VENV_PYTHON}" ]]; then
  pass "worker venv detected (${VENV_PYTHON})"
  if "${VENV_PYTHON}" -c "import requests, psutil" >/dev/null 2>&1; then
    pass "worker python dependencies import cleanly"
  else
    fail "worker dependencies missing inside venv (run install-deps.sh)"
  fi
else
  warn "worker venv not found at ${VENV_PYTHON} (run install-deps.sh)"
fi

if curl --silent --show-error --fail --max-time 4 "${LOCAL_HEALTH_URL}" >/dev/null 2>&1; then
  pass "local worker API already healthy (${LOCAL_HEALTH_URL})"
else
  warn "local worker API not responding yet (${LOCAL_HEALTH_URL}); start run-worker-node.sh when ready"
fi

if [[ "${RUN_HEARTBEAT_CHECK}" == "true" ]]; then
  if bash "${SCRIPT_DIR}/worker-heartbeat.sh" --once >/dev/null; then
    pass "heartbeat check succeeded"
  else
    fail "heartbeat check failed"
  fi
fi

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  echo "[worker-doctor] summary: ${FAIL_COUNT} fail(s), ${WARN_COUNT} warning(s)." >&2
  exit 1
fi

echo "[worker-doctor] summary: healthy with ${WARN_COUNT} warning(s)."
