#!/usr/bin/env bash
set -euo pipefail

smoke_pick_port() {
  python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

resolve_detection_training_target() {
  local base_url="$1"
  local cookie_file="$2"
  local script_label="${3:-smoke-training-worker}"

  local dataset_id="${EXPECTED_TRAINING_DATASET_ID:-}"
  local dataset_version_id="${EXPECTED_TRAINING_DATASET_VERSION_ID:-}"
  local datasets_payload versions_payload

  if [[ -z "${dataset_id}" && -n "${dataset_version_id}" ]]; then
    echo "[${script_label}] EXPECTED_TRAINING_DATASET_VERSION_ID requires EXPECTED_TRAINING_DATASET_ID."
    exit 1
  fi

  if [[ -z "${dataset_id}" ]]; then
    datasets_payload="$(curl -sS -c "${cookie_file}" -b "${cookie_file}" "${base_url}/api/datasets")"
    dataset_id="$(echo "${datasets_payload}" | jq -r '.data[] | select(.task_type=="detection" and .status=="ready") | .id' | head -n 1)"
    if [[ -z "${dataset_id}" ]]; then
      echo "[${script_label}] No ready detection dataset found. Set EXPECTED_TRAINING_DATASET_ID explicitly."
      echo "${datasets_payload}"
      exit 1
    fi
  fi

  if [[ -z "${dataset_version_id}" ]]; then
    versions_payload="$(curl -sS -c "${cookie_file}" -b "${cookie_file}" "${base_url}/api/datasets/${dataset_id}/versions")"
    dataset_version_id="$(echo "${versions_payload}" | jq -r '.data[] | select((.split_summary.train // 0) > 0 and (.annotation_coverage // 0) > 0) | .id' | head -n 1)"
    if [[ -z "${dataset_version_id}" ]]; then
      echo "[${script_label}] No trainable detection dataset version found for dataset=${dataset_id}."
      echo "[${script_label}] A trainable version requires split_summary.train > 0 and annotation_coverage > 0."
      echo "[${script_label}] Set EXPECTED_TRAINING_DATASET_VERSION_ID explicitly or prepare a trainable version."
      echo "${versions_payload}"
      exit 1
    fi
  fi

  TRAINING_DATASET_ID="${dataset_id}"
  TRAINING_DATASET_VERSION_ID="${dataset_version_id}"
  export TRAINING_DATASET_ID
  export TRAINING_DATASET_VERSION_ID
}
