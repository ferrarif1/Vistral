#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

REAL_YOLO_MODEL_PATH="${REAL_YOLO_MODEL_PATH:-${VISTRAL_YOLO_MODEL_PATH:-}}"
STATUS="ready"
ISSUES=()
NOTES=()

append_issue() {
  ISSUES+=("$1")
  STATUS="not_ready"
}

append_note() {
  NOTES+=("$1")
}

if ! command -v python3 >/dev/null 2>&1; then
  append_issue "python3_not_found"
else
  append_note "python3=$(python3 --version 2>/dev/null | tr -d '\n')"
fi

check_python_module() {
  local module_name="$1"
  local issue_key="$2"
  if ! python3 - <<PY >/dev/null 2>&1
import importlib.util
import sys
sys.exit(0 if importlib.util.find_spec("${module_name}") else 1)
PY
  then
    append_issue "${issue_key}"
  else
    append_note "python_module_${module_name}=ok"
  fi
}

if command -v python3 >/dev/null 2>&1; then
  check_python_module "ultralytics" "missing_python_module_ultralytics"
  check_python_module "paddleocr" "missing_python_module_paddleocr"
  check_python_module "doctr" "missing_python_module_doctr"
fi

if command -v python3 >/dev/null 2>&1; then
  numpy_version="$(
    python3 - <<'PY' 2>/dev/null
import importlib.util
if not importlib.util.find_spec("numpy"):
    print("")
else:
    import numpy as np
    print(getattr(np, "__version__", ""))
PY
  )"
  if [[ -n "${numpy_version}" ]]; then
    append_note "numpy_version=${numpy_version}"
    numpy_major="${numpy_version%%.*}"
    if [[ "${numpy_major}" =~ ^[0-9]+$ ]] && [[ "${numpy_major}" -ge 2 ]]; then
      append_issue "numpy_major_gte_2_may_break_torch_real_branch"
    fi
  fi
fi

if [[ -z "${REAL_YOLO_MODEL_PATH}" ]]; then
  append_issue "missing_real_yolo_model_path_env"
else
  if [[ ! -f "${REAL_YOLO_MODEL_PATH}" ]]; then
    append_issue "real_yolo_model_path_not_found:${REAL_YOLO_MODEL_PATH}"
  else
    append_note "real_yolo_model_path=${REAL_YOLO_MODEL_PATH}"
  fi
fi

if [[ "${STATUS}" == "ready" ]]; then
  echo "[doctor-real-training-readiness] PASS"
else
  echo "[doctor-real-training-readiness] NOT_READY"
fi

printf '%s\n' "{"
printf '  "status": "%s",\n' "${STATUS}"
printf '  "issues": ['
if [[ ${#ISSUES[@]} -gt 0 ]]; then
  for idx in "${!ISSUES[@]}"; do
    if [[ "${idx}" -gt 0 ]]; then
      printf ', '
    fi
    printf '"%s"' "${ISSUES[$idx]}"
  done
fi
printf '],\n'
printf '  "notes": ['
if [[ ${#NOTES[@]} -gt 0 ]]; then
  for idx in "${!NOTES[@]}"; do
    if [[ "${idx}" -gt 0 ]]; then
      printf ', '
    fi
    printf '"%s"' "${NOTES[$idx]}"
  done
fi
printf ']\n'
printf '%s\n' "}"

if [[ "${STATUS}" != "ready" ]]; then
  cat <<'EOF'
[doctor-real-training-readiness] next_steps:
  1. Install Python deps for real branch:
     python3 -m pip install "numpy<2" ultralytics paddleocr python-doctr
  2. Set model path (existing local weight file):
     export VISTRAL_YOLO_MODEL_PATH=/absolute/path/to/yolo11n.pt
  3. Re-run:
     npm run doctor:real-training-readiness
  4. Then run positive real check:
     npm run smoke:runner-real-positive
EOF
  exit 2
fi
