#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-.data/runtime-python/.venv}"
MODELS_DIR="${MODELS_DIR:-.data/runtime-models}"
YOLO_MODEL_PATH="${YOLO_MODEL_PATH:-${MODELS_DIR}/yolo11n.pt}"
AUTO_DOWNLOAD_YOLO_MODEL="${AUTO_DOWNLOAD_YOLO_MODEL:-1}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "[setup-real-training-env] python binary not found: ${PYTHON_BIN}"
  exit 1
fi

echo "[setup-real-training-env] creating venv: ${VENV_DIR}"
"${PYTHON_BIN}" -m venv "${VENV_DIR}"

PIP_BIN="${VENV_DIR}/bin/pip"
PY_BIN="${VENV_DIR}/bin/python"

echo "[setup-real-training-env] upgrading pip/setuptools/wheel"
"${PIP_BIN}" install --upgrade pip setuptools wheel

echo "[setup-real-training-env] installing real runtime dependencies"
"${PIP_BIN}" install "numpy<2" "paddlepaddle==3.2.0" "paddleocr==3.4.0" ultralytics python-doctr

mkdir -p "${MODELS_DIR}"

if [[ "${AUTO_DOWNLOAD_YOLO_MODEL}" == "1" && ! -f "${YOLO_MODEL_PATH}" ]]; then
  echo "[setup-real-training-env] trying to download YOLO model to ${YOLO_MODEL_PATH}"
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fL "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt" -o "${YOLO_MODEL_PATH}"; then
      echo "[setup-real-training-env] warning: direct model download failed; please provide model file manually."
    fi
  else
    echo "[setup-real-training-env] warning: curl not found; skip model download."
  fi
fi

if [[ ! -f "${YOLO_MODEL_PATH}" ]]; then
  echo "[setup-real-training-env] warning: YOLO model file is missing at ${YOLO_MODEL_PATH}"
  echo "[setup-real-training-env] place a yolo11n-compatible weight file there or set YOLO_LOCAL_MODEL_PATH manually."
fi

echo "[setup-real-training-env] DONE"
echo "[setup-real-training-env] next:"
echo "  export PATH=\"${ROOT_DIR}/${VENV_DIR}/bin:\$PATH\""
echo "  export YOLO_LOCAL_MODEL_PATH=\"${ROOT_DIR}/${YOLO_MODEL_PATH}\""
echo "  npm run doctor:real-training-readiness"
echo "  npm run smoke:runner-real-positive"
