#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${WORKER_ENV_FILE:-${WORKER_ROOT}/.env.worker}"
EXAMPLE_ENV_FILE="${WORKER_ROOT}/.env.worker.example"

if [[ ! -f "${ENV_FILE}" ]]; then
  mkdir -p "$(dirname "${ENV_FILE}")"
  cp "${EXAMPLE_ENV_FILE}" "${ENV_FILE}"
  echo "[worker-bootstrap] created ${ENV_FILE} from template."
fi

INPUT_CONTROL_PLANE_BASE_URL="${CONTROL_PLANE_BASE_URL:-}"
INPUT_TRAINING_WORKER_AUTH_TOKEN="${TRAINING_WORKER_AUTH_TOKEN:-}"
INPUT_TRAINING_WORKER_SHARED_TOKEN="${TRAINING_WORKER_SHARED_TOKEN:-}"
INPUT_WORKER_ID="${WORKER_ID:-}"
INPUT_WORKER_NAME="${WORKER_NAME:-}"
INPUT_WORKER_ENDPOINT="${WORKER_ENDPOINT:-}"
INPUT_WORKER_PUBLIC_HOST="${WORKER_PUBLIC_HOST:-}"
INPUT_WORKER_BIND_PORT="${WORKER_BIND_PORT:-}"
INPUT_WORKER_CAPABILITIES="${WORKER_CAPABILITIES:-}"
INPUT_WORKER_MAX_CONCURRENCY="${WORKER_MAX_CONCURRENCY:-}"
INPUT_WORKER_RUNTIME_PROFILE="${WORKER_RUNTIME_PROFILE:-}"

sanitize_host_token() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-'
}

quote_env_value() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local quoted
  local tmp_file
  quoted="$(quote_env_value "${value}")"
  tmp_file="$(mktemp)"
  awk -v key="${key}" -v value="${quoted}" '
    BEGIN { replaced = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) {
        print key "=" value
      }
    }
  ' "${ENV_FILE}" > "${tmp_file}"
  mv "${tmp_file}" "${ENV_FILE}"
}

# shellcheck disable=SC1090
source "${ENV_FILE}"

HOSTNAME_SLUG="$(sanitize_host_token "$(hostname -s 2>/dev/null || echo worker)")"
DEFAULT_WORKER_ID="tw-${HOSTNAME_SLUG}"
DEFAULT_WORKER_NAME="training-worker-${HOSTNAME_SLUG}"
DEFAULT_PORT="${WORKER_BIND_PORT:-9090}"

if [[ -n "${INPUT_WORKER_BIND_PORT}" ]]; then
  set_env_value "WORKER_BIND_PORT" "${INPUT_WORKER_BIND_PORT}"
  DEFAULT_PORT="${INPUT_WORKER_BIND_PORT}"
fi

if [[ -n "${INPUT_CONTROL_PLANE_BASE_URL}" ]]; then
  set_env_value "CONTROL_PLANE_BASE_URL" "${INPUT_CONTROL_PLANE_BASE_URL}"
fi

if [[ -n "${INPUT_TRAINING_WORKER_AUTH_TOKEN}" ]]; then
  set_env_value "TRAINING_WORKER_AUTH_TOKEN" "${INPUT_TRAINING_WORKER_AUTH_TOKEN}"
fi

if [[ -n "${INPUT_TRAINING_WORKER_SHARED_TOKEN}" ]]; then
  set_env_value "TRAINING_WORKER_SHARED_TOKEN" "${INPUT_TRAINING_WORKER_SHARED_TOKEN}"
fi

if [[ -n "${INPUT_WORKER_ID}" ]]; then
  set_env_value "WORKER_ID" "${INPUT_WORKER_ID}"
elif [[ "${WORKER_ID:-}" == "" || "${WORKER_ID:-}" == "tw-local-1" ]]; then
  set_env_value "WORKER_ID" "${DEFAULT_WORKER_ID}"
fi

if [[ -n "${INPUT_WORKER_NAME}" ]]; then
  set_env_value "WORKER_NAME" "${INPUT_WORKER_NAME}"
elif [[ "${WORKER_NAME:-}" == "" || "${WORKER_NAME:-}" == "training-worker-local-1" ]]; then
  set_env_value "WORKER_NAME" "${DEFAULT_WORKER_NAME}"
fi

if [[ -n "${INPUT_WORKER_PUBLIC_HOST}" ]]; then
  set_env_value "WORKER_ENDPOINT" "http://${INPUT_WORKER_PUBLIC_HOST}:${DEFAULT_PORT}"
elif [[ -n "${INPUT_WORKER_ENDPOINT}" ]]; then
  set_env_value "WORKER_ENDPOINT" "${INPUT_WORKER_ENDPOINT}"
fi

if [[ -n "${INPUT_WORKER_CAPABILITIES}" ]]; then
  set_env_value "WORKER_CAPABILITIES" "${INPUT_WORKER_CAPABILITIES}"
fi

if [[ -n "${INPUT_WORKER_MAX_CONCURRENCY}" ]]; then
  set_env_value "WORKER_MAX_CONCURRENCY" "${INPUT_WORKER_MAX_CONCURRENCY}"
fi

if [[ -n "${INPUT_WORKER_RUNTIME_PROFILE}" ]]; then
  set_env_value "WORKER_RUNTIME_PROFILE" "${INPUT_WORKER_RUNTIME_PROFILE}"
fi

# reload latest env values before doctor / next-step decisions
# shellcheck disable=SC1090
source "${ENV_FILE}"

RESOLVED_WORKER_AUTH_TOKEN="${TRAINING_WORKER_AUTH_TOKEN:-${TRAINING_WORKER_SHARED_TOKEN:-}}"

echo "[worker-bootstrap] env prepared: ${ENV_FILE}"
echo "[worker-bootstrap] installing dependencies..."
bash "${SCRIPT_DIR}/install-deps.sh"

if [[ -n "${WORKER_BOOTSTRAP_TOKEN:-}" && ( \
  -z "${RESOLVED_WORKER_AUTH_TOKEN:-}" || \
  "${RESOLVED_WORKER_AUTH_TOKEN:-}" == "replace-with-issued-worker-token" || \
  "${RESOLVED_WORKER_AUTH_TOKEN:-}" == "replace-with-shared-token" || \
  -z "${WORKER_ID:-}" || \
  "${WORKER_ID:-}" == "tw-local-1" \
) ]]; then
  echo "[worker-bootstrap] pairing-first bootstrap detected; skipping full doctor until local /setup finishes claiming the token."
else
  echo "[worker-bootstrap] running worker doctor..."
  bash "${SCRIPT_DIR}/worker-doctor.sh"
fi

cat <<EOF
[worker-bootstrap] next:
  1. review ${ENV_FILE} and make sure CONTROL_PLANE_BASE_URL / TRAINING_WORKER_AUTH_TOKEN / WORKER_ENDPOINT are correct
  2. run a heartbeat probe:
     bash training-worker/scripts/worker-doctor.sh --heartbeat
  3. start the worker:
     bash training-worker/scripts/run-worker-node.sh
EOF
