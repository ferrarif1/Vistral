#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${WORKER_ENV_FILE:-${WORKER_ROOT}/.env.worker}"
EXAMPLE_ENV_FILE="${WORKER_ROOT}/.env.worker.example"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${WORKER_VENV_DIR:-.venv-worker}"
PROFILE="${WORKER_RUNTIME_PROFILE:-base}"
VENV_PATH="${WORKER_ROOT}/${VENV_DIR}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "error: ${PYTHON_BIN} not found. Install Python 3 first." >&2
  exit 1
fi

echo "[worker-install] using python: ${PYTHON_BIN}"
echo "[worker-install] venv path: ${VENV_PATH}"
echo "[worker-install] runtime profile: ${PROFILE}"

"${PYTHON_BIN}" -m venv "${VENV_PATH}"
# shellcheck disable=SC1091
source "${VENV_PATH}/bin/activate"

python -m pip install --upgrade pip wheel setuptools
python -m pip install -r "${WORKER_ROOT}/requirements.txt"

case "${PROFILE}" in
  base)
    echo "[worker-install] base profile only."
    ;;
  yolo)
    python -m pip install "ultralytics>=8.2.0"
    ;;
  paddleocr)
    python -m pip install "paddleocr>=2.8.1"
    ;;
  doctr)
    python -m pip install "python-doctr>=0.8.1"
    ;;
  all)
    python -m pip install "ultralytics>=8.2.0" "paddleocr>=2.8.1" "python-doctr>=0.8.1"
    ;;
  *)
    echo "error: unsupported WORKER_RUNTIME_PROFILE='${PROFILE}'" >&2
    echo "supported profiles: base | yolo | paddleocr | doctr | all" >&2
    exit 1
    ;;
esac

echo "[worker-install] done."
echo "[worker-install] tip: source ${VENV_PATH}/bin/activate"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[worker-install] tip: create ${ENV_FILE} from ${EXAMPLE_ENV_FILE}"
fi
