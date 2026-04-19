#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v jq >/dev/null 2>&1; then
  echo "[smoke-foundation-reset] jq is required."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "[smoke-foundation-reset] npx is required."
  exit 1
fi

TMP_STATE="$(mktemp)"
TMP_BOOTSTRAP_STATE="$(mktemp)"
TMP_UPLOAD_ROOT="$(mktemp -d)"
TMP_TRAINING_ROOT="$(mktemp -d)"
TMP_EXPORT_ROOT="$(mktemp -d)"

cleanup() {
  rm -f "$TMP_STATE" "$TMP_BOOTSTRAP_STATE"
  rm -rf "$TMP_UPLOAD_ROOT" "$TMP_TRAINING_ROOT" "$TMP_EXPORT_ROOT"
}
trap cleanup EXIT

cat >"$TMP_STATE" <<'JSON'
{
  "users": [
    {
      "id": "user-alpha",
      "username": "alice",
      "role": "user",
      "status": "active",
      "status_reason": null,
      "capabilities": ["manage_models"],
      "last_login_at": null,
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": "user-admin",
      "username": "admin",
      "role": "admin",
      "status": "active",
      "status_reason": null,
      "capabilities": ["manage_models", "global_governance"],
      "last_login_at": null,
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "userPasswordHashes": {},
  "models": [
    {
      "id": "model-foundation-yolo",
      "name": "Road Damage Detector",
      "description": "baseline",
      "model_type": "detection",
      "owner_user_id": "user-alpha",
      "visibility": "workspace",
      "status": "published",
      "metadata": {"framework": "yolo"},
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    },
    {
      "id": "model-foundation-ocr",
      "name": "Invoice OCR Assistant",
      "description": "baseline",
      "model_type": "ocr",
      "owner_user_id": "user-alpha",
      "visibility": "workspace",
      "status": "published",
      "metadata": {"framework": "paddleocr"},
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "conversations": [],
  "messages": [],
  "attachments": [],
  "datasets": [{"id":"dataset-alpha","name":"tmp","description":"tmp","task_type":"detection","status":"ready","owner_user_id":"user-alpha","label_schema":{"classes":[]},"metadata":{},"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],
  "datasetItems": [{"id":"item-alpha","dataset_id":"dataset-alpha","attachment_id":"attach-alpha","split":"train","status":"ready","metadata":{},"created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],
  "annotations": [],
  "annotationReviews": [],
  "datasetVersions": [{"id":"dataset-version-alpha","dataset_id":"dataset-alpha","version_name":"v1","split_summary":{"train":1,"val":0,"test":0,"unassigned":0},"item_count":1,"annotation_coverage":0.1,"created_by":"user-alpha","created_at":"2026-01-01T00:00:00.000Z"}],
  "trainingJobs": [{"id":"training-job-alpha","name":"tmp","task_type":"detection","framework":"yolo","status":"completed","dataset_id":"dataset-alpha","dataset_version_id":"dataset-version-alpha","base_model":"yolo11n","config":{},"execution_mode":"simulated","execution_target":"control_plane","scheduled_worker_id":null,"scheduler_note":null,"scheduler_decision":null,"scheduler_decision_history":[],"log_excerpt":null,"submitted_by":"user-alpha","created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],
  "trainingWorkerNodes": [],
  "trainingWorkerBootstrapSessions": [],
  "trainingWorkerAuthTokensByWorkerId": {},
  "trainingMetrics": [],
  "modelVersions": [],
  "inferenceRuns": [{"id":"inference-run-alpha","model_version_id":"model-version-missing","input_attachment_id":"attach-missing","task_type":"detection","framework":"yolo","status":"completed","execution_source":"base_empty","raw_output":{},"normalized_output":{"normalized_output":{"source":"base_empty"}},"feedback_dataset_id":null,"created_by":"user-alpha","created_at":"2026-01-01T00:00:00.000Z","updated_at":"2026-01-01T00:00:00.000Z"}],
  "approvalRequests": [],
  "auditLogs": []
}
JSON

echo "[smoke-foundation-reset] verifying data:reset:foundation script"
mkdir -p "$TMP_UPLOAD_ROOT/nested" "$TMP_TRAINING_ROOT/job-a" "$TMP_EXPORT_ROOT/yolo/model-version-alpha"
echo "blob" >"$TMP_UPLOAD_ROOT/nested/file.bin"
echo "blob" >"$TMP_TRAINING_ROOT/job-a/run.log"
echo "blob" >"$TMP_EXPORT_ROOT/yolo/model-version-alpha/model.bin"

APP_STATE_STORE_PATH="$TMP_STATE" \
UPLOAD_STORAGE_ROOT="$TMP_UPLOAD_ROOT" \
TRAINING_WORKDIR_ROOT="$TMP_TRAINING_ROOT" \
MODEL_EXPORT_ROOT="$TMP_EXPORT_ROOT" \
node scripts/reset-app-state-foundation.mjs >/dev/null

model_count="$(jq '.models | length' "$TMP_STATE")"
dataset_count="$(jq '.datasets | length' "$TMP_STATE")"
training_count="$(jq '.trainingJobs | length' "$TMP_STATE")"
inference_count="$(jq '.inferenceRuns | length' "$TMP_STATE")"
foundation_detection_count="$(jq '[.models[]? | select(.model_type=="detection" and ((.metadata.foundation // false) == true or (.metadata.foundation // "") == "true"))] | length' "$TMP_STATE")"
foundation_ocr_count="$(jq '[.models[]? | select(.model_type=="ocr" and ((.metadata.foundation // false) == true or (.metadata.foundation // "") == "true"))] | length' "$TMP_STATE")"

if [[ "$model_count" -lt 2 || "$foundation_detection_count" -lt 1 || "$foundation_ocr_count" -lt 1 ]]; then
  echo "[smoke-foundation-reset] expected curated foundation models after reset."
  cat "$TMP_STATE"
  exit 1
fi
if [[ "$dataset_count" != "0" || "$training_count" != "0" || "$inference_count" != "0" ]]; then
  echo "[smoke-foundation-reset] expected runtime entities to be removed after reset."
  cat "$TMP_STATE"
  exit 1
fi

upload_files_left="$(find "$TMP_UPLOAD_ROOT" -type f | wc -l | tr -d ' ')"
training_files_left="$(find "$TMP_TRAINING_ROOT" -type f | wc -l | tr -d ' ')"
export_files_left="$(find "$TMP_EXPORT_ROOT" -type f | wc -l | tr -d ' ')"
if [[ "$upload_files_left" != "0" || "$training_files_left" != "0" || "$export_files_left" != "0" ]]; then
  echo "[smoke-foundation-reset] expected storage roots to be purged by reset script."
  echo "upload_files_left=$upload_files_left training_files_left=$training_files_left export_files_left=$export_files_left"
  exit 1
fi

echo "[smoke-foundation-reset] verifying APP_STATE_BOOTSTRAP_MODE=minimal bootstrap behavior"
rm -f "$TMP_BOOTSTRAP_STATE"
bootstrap_output="$(
  APP_STATE_STORE_PATH="$TMP_BOOTSTRAP_STATE" \
  APP_STATE_BOOTSTRAP_MODE=minimal \
  npx tsx -e "import {loadPersistedAppState, models, datasets, trainingJobs, inferenceRuns} from './backend/src/store.ts'; (async()=>{await loadPersistedAppState(); console.log(JSON.stringify({models:models.map((m)=>({name:m.name,model_type:m.model_type,metadata:m.metadata})),datasets:datasets.length,trainingJobs:trainingJobs.length,inferenceRuns:inferenceRuns.length}));})();"
)"

bootstrap_models_count="$(echo "$bootstrap_output" | jq '.models | length')"
bootstrap_datasets="$(echo "$bootstrap_output" | jq '.datasets')"
bootstrap_training_jobs="$(echo "$bootstrap_output" | jq '.trainingJobs')"
bootstrap_inference_runs="$(echo "$bootstrap_output" | jq '.inferenceRuns')"
bootstrap_foundation_detection_count="$(echo "$bootstrap_output" | jq '[.models[]? | select(.model_type=="detection" and ((.metadata.foundation // false) == true or (.metadata.foundation // "") == "true"))] | length')"
bootstrap_foundation_ocr_count="$(echo "$bootstrap_output" | jq '[.models[]? | select(.model_type=="ocr" and ((.metadata.foundation // false) == true or (.metadata.foundation // "") == "true"))] | length')"

if [[ "$bootstrap_models_count" -lt 2 || "$bootstrap_foundation_detection_count" -lt 1 || "$bootstrap_foundation_ocr_count" -lt 1 ]]; then
  echo "[smoke-foundation-reset] minimal bootstrap should keep curated foundation models."
  echo "$bootstrap_output"
  exit 1
fi
if [[ "$bootstrap_datasets" != "0" || "$bootstrap_training_jobs" != "0" || "$bootstrap_inference_runs" != "0" ]]; then
  echo "[smoke-foundation-reset] minimal bootstrap should not create seed runtime entities."
  echo "$bootstrap_output"
  exit 1
fi

echo "[smoke-foundation-reset] PASS"
