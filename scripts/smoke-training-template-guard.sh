#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[smoke-training-template-guard] python3 is required."
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

CONFIG_PATH="${TMP_DIR}/config.json"
SUMMARY_PATH="${TMP_DIR}/summary.json"

cat >"${CONFIG_PATH}" <<'JSON'
{
  "config": {
    "epochs": "4",
    "batch_size": "2",
    "learning_rate": "0.001"
  },
  "materialized_dataset": {}
}
JSON

cat >"${SUMMARY_PATH}" <<'JSON'
{
  "total_items": 12,
  "ready_items": 12,
  "annotated_items": 10,
  "approved_items": 8,
  "total_boxes": 25,
  "total_lines": 44
}
JSON

run_case() {
  local case_name="$1"
  local runner_path="$2"
  local task_type="$3"
  local base_model="$4"
  local job_id="$5"
  local dataset_id="$6"

  local case_dir="${TMP_DIR}/${case_name}"
  local workspace_dir="${case_dir}/workspace"
  local metrics_path="${case_dir}/metrics.json"
  local artifact_path="${case_dir}/artifact.json"
  mkdir -p "${workspace_dir}"

  VISTRAL_RUNNER_ENABLE_REAL=0 \
    python3 "${runner_path}" \
      --job-id "${job_id}" \
      --dataset-id "${dataset_id}" \
      --task-type "${task_type}" \
      --base-model "${base_model}" \
      --workspace-dir "${workspace_dir}" \
      --config-path "${CONFIG_PATH}" \
      --summary-path "${SUMMARY_PATH}" \
      --metrics-path "${metrics_path}" \
      --artifact-path "${artifact_path}" >/dev/null

  python3 - <<'PY' "${artifact_path}" "${case_name}"
import json
import sys

artifact_path = sys.argv[1]
case_name = sys.argv[2]

with open(artifact_path, "r", encoding="utf-8") as fp:
    payload = json.load(fp)

mode = str(payload.get("mode", "")).strip()
training_performed = payload.get("training_performed", None)
fallback_reason = str(payload.get("fallback_reason", "")).strip()
template_reason = str(payload.get("template_reason", "")).strip()
metrics = payload.get("metrics", {})
metric_series = payload.get("metric_series", [])

errors = []
if mode != "template":
    errors.append(f"mode expected template, got {mode!r}")
if training_performed is not False:
    errors.append(f"training_performed expected false, got {training_performed!r}")
if not fallback_reason:
    errors.append("fallback_reason should be non-empty")
if not template_reason:
    errors.append("template_reason should be non-empty")
if fallback_reason != template_reason:
    errors.append("fallback_reason and template_reason should be equal")
if not isinstance(metrics, dict) or len(metrics) == 0:
    errors.append("metrics should be non-empty dict")
if not isinstance(metric_series, list) or len(metric_series) == 0:
    errors.append("metric_series should be non-empty list")

if errors:
    print(f"[smoke-training-template-guard] {case_name} assertion failed:")
    for item in errors:
        print(f"  - {item}")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    sys.exit(1)

print(
    f"[smoke-training-template-guard] {case_name} ok "
    f"(fallback_reason={fallback_reason}, metrics_keys={','.join(sorted(metrics.keys()))})"
)
PY
}

run_case \
  "yolo-template-train" \
  "scripts/local-runners/yolo_train_runner.py" \
  "detection" \
  "yolo11n" \
  "tj-template-yolo" \
  "d-template-yolo"

run_case \
  "paddleocr-template-train" \
  "scripts/local-runners/paddleocr_train_runner.py" \
  "ocr" \
  "paddleocr-PP-OCRv4" \
  "tj-template-paddle" \
  "d-template-paddle"

run_case \
  "doctr-template-train" \
  "scripts/local-runners/doctr_train_runner.py" \
  "ocr" \
  "doctr-db-resnet50" \
  "tj-template-doctr" \
  "d-template-doctr"

echo "[smoke-training-template-guard] PASS"
