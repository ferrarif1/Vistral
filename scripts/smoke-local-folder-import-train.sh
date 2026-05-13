#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
if [[ "${START_API:-true}" == "true" && -z "${API_PORT:-}" ]]; then
  API_PORT="$(
    python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
  )"
fi
API_PORT="${API_PORT:-8787}"
BASE_URL="${BASE_URL:-http://${API_HOST}:${API_PORT}}"
START_API="${START_API:-true}"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-local-folder-import-train] jq is required."
  exit 1
fi

COOKIE_FILE="$(mktemp)"
API_LOG="$(mktemp)"
FIXTURE_DIR="$(mktemp -d)"
API_PID=""

cleanup() {
  if [[ -n "${API_PID}" ]]; then
    kill "${API_PID}" >/dev/null 2>&1 || true
    wait "${API_PID}" >/dev/null 2>&1 || true
  fi
  rm -f "${COOKIE_FILE}" "${API_LOG}"
  rm -rf "${FIXTURE_DIR}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

mkdir -p "${FIXTURE_DIR}/JPEGImages" "${FIXTURE_DIR}/Annotations"
cat >"${FIXTURE_DIR}/classes.txt" <<'EOF'
defect
normal
EOF

for index in 1 2 3 4 5 6 7; do
  printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=' | base64 --decode >"${FIXTURE_DIR}/JPEGImages/sample-${index}.png"
  cat >"${FIXTURE_DIR}/Annotations/sample-${index}.xml" <<EOF
<annotation>
  <folder>JPEGImages</folder>
  <filename>sample-${index}.png</filename>
  <size><width>100</width><height>80</height><depth>3</depth></size>
  <object>
    <name>defect</name>
    <bndbox><xmin>10</xmin><ymin>12</ymin><xmax>70</xmax><ymax>55</ymax></bndbox>
  </object>
</annotation>
EOF
done

if [[ "${START_API}" == "true" ]]; then
  API_HOST="${API_HOST}" \
  API_PORT="${API_PORT}" \
  VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK=false \
  VISTRAL_DISABLE_INFERENCE_FALLBACK=false \
  MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1 \
  LOCAL_FOLDER_TRAINING_DEFAULT_EPOCHS=1 \
  npm run dev:api >"${API_LOG}" 2>&1 &
  API_PID=$!
fi

for _ in {1..240}; do
  if curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -fsS "${BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "[smoke-local-folder-import-train] API is unreachable at ${BASE_URL}."
  cat "${API_LOG}"
  exit 1
fi

csrf_response="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/auth/csrf")"
csrf_token="$(echo "${csrf_response}" | jq -r '.data.csrf_token // empty')"
if [[ -z "${csrf_token}" ]]; then
  echo "[smoke-local-folder-import-train] failed to obtain CSRF token."
  echo "${csrf_response}"
  exit 1
fi

scan_response="$(jq -n --arg folder "${FIXTURE_DIR}" '{
  folder_path: $folder,
  task_type: "detection",
  framework: "yolo",
  manual_validation_count: 5
}' | curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/local-folder/scan" \
  -d @-)"

paired_count="$(echo "${scan_response}" | jq -r '.data.paired_count // 0')"
format="$(echo "${scan_response}" | jq -r '.data.detected_format // empty')"
if [[ "${format}" != "voc" || "${paired_count}" -ne 7 ]]; then
  echo "[smoke-local-folder-import-train] scan failed."
  echo "${scan_response}"
  exit 1
fi

workflow_response="$(jq -n --arg folder "${FIXTURE_DIR}" '{
  folder_path: $folder,
  dataset_name: "smoke-local-folder",
  task_type: "detection",
  framework: "yolo",
  manual_validation_count: 5,
  train_ratio: 0.8,
  val_ratio: 0.2,
  seed: 42,
  execution_target: "control_plane"
}' | curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: ${csrf_token}" \
  -X POST "${BASE_URL}/api/datasets/local-folder/import-and-train" \
  -d @-)"

success="$(echo "${workflow_response}" | jq -r '.success // false')"
dataset_id="$(echo "${workflow_response}" | jq -r '.data.dataset.id // empty')"
job_id="$(echo "${workflow_response}" | jq -r '.data.training_job.id // empty')"
holdout_count="$(echo "${workflow_response}" | jq -r '.data.manual_validation_items | length // 0')"
train_count="$(echo "${workflow_response}" | jq -r '.data.split_summary.train // 0')"
test_count="$(echo "${workflow_response}" | jq -r '.data.split_summary.test // 0')"
if [[ "${success}" != "true" || -z "${dataset_id}" || -z "${job_id}" || "${holdout_count}" -ne 5 || "${test_count}" -ne 5 || "${train_count}" -lt 1 ]]; then
  echo "[smoke-local-folder-import-train] import-and-train did not produce expected records."
  echo "${workflow_response}"
  exit 1
fi

for _ in {1..80}; do
  job_detail="$(curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}")"
  job_status="$(echo "${job_detail}" | jq -r '.data.job.status // empty')"
  metric_count="$(echo "${job_detail}" | jq -r '.data.metrics | length // 0')"
  if [[ "${job_status}" == "completed" && "${metric_count}" -gt 0 ]]; then
    finalize_response="$(jq -n '{
      model_name: "smoke-local-folder-model",
      version_name: "smoke-local-folder-v1",
      run_manual_validation: true
    }' | curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" \
      -H "Content-Type: application/json" \
      -H "X-CSRF-Token: ${csrf_token}" \
      -X POST "${BASE_URL}/api/training/jobs/${job_id}/local-folder-finalize" \
      -d @-)"
    finalize_status="$(echo "${finalize_response}" | jq -r '.data.registration_status // empty')"
    finalize_runs="$(echo "${finalize_response}" | jq -r '.data.inference_runs | length // 0')"
    model_version_id="$(echo "${finalize_response}" | jq -r '.data.model_version.id // empty')"
    if [[ "${finalize_status}" != "registered" || "${finalize_runs}" -ne 5 || -z "${model_version_id}" ]]; then
      echo "[smoke-local-folder-import-train] finalize did not register and run holdout inference."
      echo "${finalize_response}"
      exit 1
    fi
    echo "[smoke-local-folder-import-train] PASS dataset=${dataset_id} job=${job_id} holdout=${holdout_count}"
    exit 0
  fi
  if [[ "${job_status}" == "failed" || "${job_status}" == "cancelled" ]]; then
    echo "[smoke-local-folder-import-train] training ended unexpectedly: ${job_status}"
    echo "${job_detail}"
    exit 1
  fi
  sleep 0.3
done

echo "[smoke-local-folder-import-train] training did not complete before timeout."
curl -sS -c "${COOKIE_FILE}" -b "${COOKIE_FILE}" "${BASE_URL}/api/training/jobs/${job_id}"
exit 1
