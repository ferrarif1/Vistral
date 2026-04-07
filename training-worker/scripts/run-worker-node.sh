#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${WORKER_ENV_FILE:-${WORKER_ROOT}/.env.worker}"

load_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
  fi
  export WORKER_ENV_FILE="${ENV_FILE}"
}

is_worker_config_ready() {
  local resolved_worker_token="${TRAINING_WORKER_AUTH_TOKEN:-${TRAINING_WORKER_SHARED_TOKEN:-}}"
  [[ -n "${CONTROL_PLANE_BASE_URL:-}" && -n "${resolved_worker_token}" && -n "${WORKER_ID:-}" ]]
}

load_env_file

WORKER_VENV_DIR="${WORKER_VENV_DIR:-.venv-worker}"
WORKER_RUN_DOCTOR_ON_START="${WORKER_RUN_DOCTOR_ON_START:-true}"
if [[ -z "${PYTHON_BIN:-}" && -x "${WORKER_ROOT}/${WORKER_VENV_DIR}/bin/python" ]]; then
  PYTHON_BIN="${WORKER_ROOT}/${WORKER_VENV_DIR}/bin/python"
else
  PYTHON_BIN="${PYTHON_BIN:-python3}"
fi

"${PYTHON_BIN}" "${SCRIPT_DIR}/worker-train-api.py" &
WORKER_API_PID=$!
HEARTBEAT_PID=""
SETUP_MODE_ANNOUNCED="false"

echo "[worker-run] worker api pid=${WORKER_API_PID}"
echo "[worker-run] python=${PYTHON_BIN}"
echo "[worker-run] setup url=http://127.0.0.1:${WORKER_BIND_PORT:-9090}/setup"

cleanup() {
  kill "${WORKER_API_PID}" >/dev/null 2>&1 || true
  if [[ -n "${HEARTBEAT_PID}" ]]; then
    kill "${HEARTBEAT_PID}" >/dev/null 2>&1 || true
  fi
  wait "${WORKER_API_PID}" >/dev/null 2>&1 || true
  if [[ -n "${HEARTBEAT_PID}" ]]; then
    wait "${HEARTBEAT_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

while true; do
  if ! kill -0 "${WORKER_API_PID}" >/dev/null 2>&1; then
    wait "${WORKER_API_PID}"
    exit $?
  fi

  if [[ -n "${HEARTBEAT_PID}" ]]; then
    if ! kill -0 "${HEARTBEAT_PID}" >/dev/null 2>&1; then
      wait "${HEARTBEAT_PID}"
      exit $?
    fi
  else
    load_env_file
    if is_worker_config_ready; then
      if [[ "${WORKER_RUN_DOCTOR_ON_START}" != "false" && "${WORKER_RUN_DOCTOR_ON_START}" != "0" ]]; then
        if ! bash "${SCRIPT_DIR}/worker-doctor.sh"; then
          echo "[worker-run] config detected but doctor did not pass; keeping setup mode until checks are green." >&2
          sleep 5
          continue
        fi
      fi

      bash "${SCRIPT_DIR}/worker-heartbeat.sh" &
      HEARTBEAT_PID=$!
      echo "[worker-run] heartbeat pid=${HEARTBEAT_PID}"
      echo "[worker-run] worker config is ready; heartbeat loop started."
    elif [[ "${SETUP_MODE_ANNOUNCED}" != "true" ]]; then
      echo "[worker-run] worker config is incomplete; setup mode active. Complete configuration in the local UI, then heartbeat will start automatically."
      SETUP_MODE_ANNOUNCED="true"
    fi
  fi
  sleep 2
done
