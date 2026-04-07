#!/usr/bin/env bash
set -euo pipefail

cd /app

WORKER_ENV_FILE="${WORKER_ENV_FILE:-/worker-state/.env.worker}"
export WORKER_ENV_FILE

mkdir -p "$(dirname "${WORKER_ENV_FILE}")"
mkdir -p "${WORKER_RUN_ROOT:-/worker-state/runs}"

if [[ ! -f "${WORKER_ENV_FILE}" ]]; then
  cp training-worker/.env.worker.example "${WORKER_ENV_FILE}"
  echo "[worker-entrypoint] created ${WORKER_ENV_FILE} from template."
fi

exec bash training-worker/scripts/run-worker-node.sh
