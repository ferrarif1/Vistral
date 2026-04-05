# API Contract

## 1. Overview
This document defines the executable API contract for Vistral's prototype and the next-stage training platform skeleton.

## 2. Base Path and Auth
- Base path: `/api`
- Prototype auth: `HttpOnly` cookie session (`vistral_session`)
- Production target: bearer token
- Mutation methods (`POST`, `PUT`, `PATCH`, `DELETE`) require `X-CSRF-Token` in prototype mode except login/register/csrf
- after explicit logout, protected endpoints return `401` until the user logs in again

## 3. Common Response Envelope

### Success
```json
{
  "success": true,
  "data": {}
}
```

### Failure
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable explanation"
  }
}
```

## 4. Shared Enums

### 4.1 Roles
- `user`
- `admin`

### 4.2 Task types
- `ocr`
- `detection`
- `classification`
- `segmentation`
- `obb`

### 4.3 Frameworks
- `paddleocr`
- `doctr`
- `yolo`

### 4.4 Annotation status
- `unannotated`
- `in_progress`
- `annotated`
- `in_review`
- `approved`
- `rejected`

### 4.5 Training job status
- `draft`
- `queued`
- `preparing`
- `running`
- `evaluating`
- `completed`
- `failed`
- `cancelled`

## 5. Authentication Endpoints

### POST /auth/register
Compatibility endpoint only. Public self-registration is disabled.

Important constraints:
- endpoint remains available only to return an explicit disabled error for stale clients
- response must be an error explaining that account provisioning is admin-only

Request:
```json
{
  "username": "alice",
  "password": "***"
}
```

### POST /auth/login
Login and bind session cookie.

Request:
```json
{
  "username": "alice",
  "password": "***"
}
```

Rules:
- disabled accounts return an explicit account-disabled error instead of opening a new authenticated session

### POST /auth/logout
Logout current session.

Notes:
- clears the current authenticated session
- backend keeps an anonymous post-logout session so `/api/users/me` and other protected endpoints remain unavailable until the user logs in again

### GET /auth/csrf
Fetch CSRF token for current session.

## 6. User Endpoint

### GET /users/me
Get current session user.

Notes:
- returns `401` when the current browser session has been explicitly logged out and is no longer bound to an authenticated user

### POST /users/me/password
Change password for current session user.

Request:
```json
{
  "current_password": "***",
  "new_password": "***"
}
```

Rules:
- all authenticated users can access this endpoint
- `current_password` must match the existing password
- `new_password` must satisfy the same minimum password policy used by account creation

## 6.1 Admin User Management

### GET /admin/users
List users visible to admin.

Rules:
- admin only
- response omits password hashes and any secret material
- each user record includes at minimum `role`, `status`, `status_reason`, `created_at`, `updated_at`, and `last_login_at`

### POST /admin/users
Create a new user account from an admin surface.

Request:
```json
{
  "username": "new-user",
  "password": "***",
  "role": "user"
}
```

Rules:
- admin only
- `role` must be `user` or `admin`
- server assigns default capabilities based on role
- duplicate usernames are rejected

### POST /admin/users/{id}/password-reset
Reset another user's password from an admin surface.

Request:
```json
{
  "new_password": "***"
}
```

Rules:
- admin only
- target user must exist
- `new_password` must satisfy the minimum password policy

### POST /admin/users/{id}/status
Disable or reactivate an account.

Request:
```json
{
  "status": "disabled",
  "reason": "Pending security review for unusual credential sharing."
}
```

Rules:
- admin only
- `status` must be `active` or `disabled`
- `reason` is required after trim when `status=disabled`
- `reason` is ignored/cleared when `status=active`
- system must reject disabling the current admin session
- system must reject disabling the last active admin account
- disabled users cannot create new authenticated sessions and should be blocked from further protected actions until reactivated
- disabling a user immediately terminates that user's existing authenticated sessions; those sessions should subsequently behave as logged-out (`401`) rather than staying half-authenticated

## 7. Conversation Endpoints

### GET /conversations
List conversations visible to current user.

### POST /conversations/start
Start a conversation.

Request:
```json
{
  "model_id": "m-1",
  "initial_message": "Analyze this image",
  "attachment_ids": ["f-1"]
}
```

Notes:
- `attachment_ids` order is preserved as the message attachment context order.
- returned message records may include optional `metadata.conversation_action` for assistant-side operational execution state

### POST /conversations/message
Send message to an existing conversation.

Notes:
- `attachment_ids` order is preserved as provided by client selection context.
- assistant may resolve operational intents in-thread:
  - `create_dataset`
  - `create_model_draft`
  - `create_training_job`
- when required inputs are missing, assistant returns `metadata.conversation_action.status=requires_input`
- when backend execution succeeds, assistant returns `metadata.conversation_action.status=completed`
- when execution fails or user cancels, assistant returns `failed` / `cancelled`

### GET /conversations/{id}
Get conversation with messages.

Message shape notes:
- `Message.metadata` is optional
- `Message.metadata.conversation_action` example:
```json
{
  "action": "create_training_job",
  "status": "requires_input",
  "summary": "Need dataset selection before creating the training job.",
  "missing_fields": ["dataset_id"],
  "collected_fields": {
    "task_type": "ocr",
    "framework": "paddleocr",
    "name": "car-number-ocr"
  },
  "suggestions": ["TrainCarOCR (d-12)", "SerialNumberBatchA (d-18)"]
}
```

### PATCH /conversations/{id}
Rename a conversation title (owner/admin only).

Request:
```json
{
  "title": "Invoice Batch Review"
}
```

Rules:
- title is required after trim
- title length must be 1-120 characters

## 7.1 LLM Settings Endpoints

### GET /settings/llm
Get the current user's saved LLM configuration view.

Notes:
- response masks the stored API key and exposes `has_api_key` + `api_key_masked`

### POST /settings/llm
Save or update the current user's LLM configuration.

Request:
```json
{
  "llm_config": {
    "enabled": true,
    "provider": "chatanywhere",
    "base_url": "https://api.chatanywhere.tech/v1",
    "api_key": "sk-xxxx",
    "model": "gpt-4o-mini",
    "temperature": 0.2
  },
  "keep_existing_api_key": false
}
```

Notes:
- when `keep_existing_api_key=true` and `llm_config.api_key` is blank, server keeps the encrypted saved key
- response remains the masked config view

### DELETE /settings/llm
Clear the current user's saved LLM configuration.

### POST /settings/llm/test
Test the current user's LLM connectivity with either a newly typed key or the saved encrypted key.

Request:
```json
{
  "llm_config": {
    "enabled": true,
    "provider": "chatanywhere",
    "base_url": "https://api.chatanywhere.tech/v1",
    "api_key": "",
    "model": "gpt-4o-mini",
    "temperature": 0.2
  },
  "use_stored_api_key": true
}
```

Notes:
- when `use_stored_api_key=true` and `llm_config.api_key` is blank, server reuses the current user's saved encrypted key for this test
- response returns a short preview string from the provider

## 8. File Attachment Endpoints

### GET /files/conversation
List conversation-scoped attachments for current user.

### POST /files/conversation/upload
Upload conversation attachment.

Supported request formats:

1. JSON filename mode (prototype compatibility):

Request:
```json
{
  "filename": "sample.jpg"
}
```

2. `multipart/form-data` mode (preferred):
- field name: `file`
- server persists uploaded binary under `UPLOAD_STORAGE_ROOT` (subdir by target type)
- response remains the standard `FileAttachment` envelope

Notes:
- both modes keep attachment lifecycle statuses (`uploading -> processing -> ready/error`)
- binary content retrieval is available for attachments uploaded via multipart mode
- `FileAttachment` includes `mime_type`, `byte_size`, `storage_backend`, `storage_path`
- current storage backend is local filesystem (`storage_backend=local`)
- prototype upload endpoints accept generic binary payloads, including BMP images and common document/image formats
- client should preflight large files and keep each upload under about `120 MB` for a smoother chat-style UX; larger payloads may be rejected with `413`

### GET /files/model/{modelId}
List model-scoped attachments.

### POST /files/model/{modelId}/upload
Upload model artifact attachment.

Supported request formats:
- JSON filename mode (prototype compatibility)
- `multipart/form-data` mode with `file` field (preferred)

Notes:
- keep each file under about `120 MB` to avoid proxy/body-size rejection (`413`)

### GET /files/dataset/{datasetId}
List dataset-scoped attachments.

### POST /files/dataset/{datasetId}/upload
Upload dataset source file attachment.

Supported request formats:
- JSON filename mode (prototype compatibility)
- `multipart/form-data` mode with `file` field (preferred)

Notes:
- keep each file under about `120 MB` to avoid proxy/body-size rejection (`413`)

### GET /files/inference
List inference-input attachments for current user.

### POST /files/inference/upload
Upload inference input attachment.

Supported request formats:
- JSON filename mode (prototype compatibility)
- `multipart/form-data` mode with `file` field (preferred)

Notes:
- uploaded attachment target is `attached_to_type=InferenceRun` and `attached_to_id=null` before run execution.
- `InferenceValidationPage` should use this endpoint instead of conversation attachment endpoints.
- keep each file under about `120 MB` to avoid proxy/body-size rejection (`413`)

### GET /files/{id}/content
Fetch binary content for a ready attachment in ownership scope.

Response:
- raw binary stream (not JSON envelope)
- headers include `Content-Type`, `Content-Length`, `Content-Disposition`

### DELETE /files/{id}
Delete attachment in ownership scope.

Attachment status values:
- `uploading`
- `processing`
- `ready`
- `error`

## 9. Model and Approval Endpoints

### GET /models
List visible models.

### GET /models/my
List owned/authorized models.

### POST /models/draft
Create model draft.

### POST /approvals/submit
Submit model approval request.

### GET /approvals
List approval requests (admin gets global list, user gets own).

### POST /approvals/{id}/approve
Approve request (admin only).

### POST /approvals/{id}/reject
Reject request (admin only).

### GET /audit/logs
Audit logs (admin only).

### GET /admin/verification-reports
List deployment verification reports generated by `docker:verify:full` (admin only).
- non-admin caller gets failure response with permission error message
- non-admin response status/code: `403` + `INSUFFICIENT_PERMISSIONS`
- response now includes optional `runtime_metrics_retention` snapshot when report JSON contains it

Response item:
```json
{
  "id": "docker-verify-full-20260402223826",
  "filename": "docker-verify-full-20260402223826.json",
  "status": "passed",
  "summary": "full deployment verification succeeded",
  "started_at_utc": "2026-04-02T14:38:26Z",
  "finished_at_utc": "2026-04-02T14:38:31Z",
  "target_base_url": "http://127.0.0.1:8080",
  "business_username": "alice",
  "probe_username": "verify-123",
  "checks_total": 9,
  "checks_failed": 0,
  "checks": [
    {
      "name": "infrastructure health checks",
      "status": "passed",
      "detail": "health endpoints are reachable"
    }
  ],
  "runtime_metrics_retention": {
    "max_points_per_job": 180,
    "max_total_rows": 20000,
    "current_total_rows": 428,
    "visible_job_count": 12,
    "jobs_with_metrics": 9,
    "max_rows_single_job": 90,
    "near_total_cap": false,
    "top_jobs": [
      { "training_job_id": "tj-982", "rows": 90 }
    ]
  },
  "entities": {
    "model_id": "m-1",
    "approval_id": "ar-1"
  }
}
```

## 10. Dataset Management Endpoints

### GET /datasets
List datasets visible to current user.

Query:
- `task_type` (optional)
- `status` (optional)

### POST /datasets
Create dataset.

Request:
```json
{
  "name": "Invoice OCR Set",
  "description": "Round-1 OCR samples",
  "task_type": "ocr",
  "label_schema": {
    "classes": ["text_line", "table", "stamp"]
  }
}
```

### GET /datasets/{id}
Get dataset detail.

### GET /datasets/{id}/items
List dataset items.

### POST /datasets/{id}/items
Add dataset item metadata record (for imported references).

Request:
```json
{
  "attachment_id": "f-120",
  "filename": "train_001.jpg",
  "split": "unassigned",
  "status": "ready",
  "metadata": {
    "source": "import_reference"
  }
}
```

Behavior:
- `attachment_id` is optional.
- when `attachment_id` is absent, server resolves existing dataset attachment by `filename`; if none exists, server creates a dataset-scoped reference attachment and then creates item metadata.
- when an item already exists for the chosen attachment, server returns the existing item (idempotent for same attachment).

### PATCH /datasets/{id}/items/{item_id}
Update an existing dataset item.

Request:
```json
{
  "split": "train",
  "status": "ready",
  "metadata": {
    "source": "import_reference",
    "note": "manual review pending"
  }
}
```

Behavior:
- any field is optional; omitted fields keep previous value.
- when `metadata` is provided, it replaces current metadata object.
- item must belong to the target dataset.

### POST /datasets/{id}/split
Save split strategy and assign `train/val/test`.

Request:
```json
{
  "train_ratio": 0.7,
  "val_ratio": 0.2,
  "test_ratio": 0.1,
  "seed": 42
}
```

### GET /datasets/{id}/versions
List dataset versions.

### POST /datasets/{id}/versions
Create dataset version snapshot.

### POST /datasets/{id}/import
Import annotations into dataset items.

Current behavior:
- accepts dataset-scoped source attachment id (must be `ready` with real stored content)
- currently supports `format=yolo|coco|labelme|ocr`
- parses import file and writes actual annotation payloads into `annotations` with `source=import`
- updates existing non-approved annotations; approved annotations stay immutable
- when import record filename has no matched ready item, server creates a metadata item record first (using existing attachment by filename when available, otherwise creating a reference attachment)
- returns import summary (`imported`, `updated`, `created_items`)

Minimum import file specifications:
- `yolo`:
  - JSON: `[{ "filename": "xxx.jpg", "boxes": [{ "x": 10, "y": 20, "width": 100, "height": 80, "label": "defect", "score": 0.9 }] }]`
  - TXT (per line): `filename label x y width height [score]`
- `coco`:
  - JSON object with `images[]`, `annotations[]`, `categories[]`
  - `annotations[].bbox = [x, y, width, height]`, mapped to payload boxes by image file name
- `labelme`:
  - JSON object (or array) with `imagePath` and `shapes[]`
  - rectangle/polygon shapes are converted to boxes; for segmentation datasets polygons are preserved
- `ocr`:
  - JSON: `[{ "filename": "xxx.jpg", "lines": [{ "text": "train no 1234", "confidence": 0.95 }] }]`
  - TXT (per line): `filename<TAB>text<TAB>confidence(optional)`

Request:
```json
{
  "format": "yolo",
  "attachment_id": "f-100"
}
```

### POST /datasets/{id}/export
Export annotations from dataset.

Current behavior:
- returns export summary and generated dataset-scoped export attachment metadata
- writes real exported file content into the attachment storage (status `ready`)
- export files are downloadable via `GET /files/{attachment_id}/content`
- format/task_type constraints align with import:
  - `yolo|coco|labelme` require detection/obb/segmentation dataset task type
  - `ocr` requires `dataset.task_type=ocr`
- output structure follows selected `format`:
  - `yolo`: JSON object with `dataset_id`, `format`, `exported_at`, `items[]` (`filename`, `boxes[]`)
  - `ocr`: JSON object with `dataset_id`, `format`, `exported_at`, `items[]` (`filename`, `lines[]`)
  - `coco`: JSON object with `dataset_id`, `format`, `exported_at`, `images[]`, `annotations[]`, `categories[]`
  - `labelme`: JSON object with `dataset_id`, `format`, `exported_at`, `items[]` (`imagePath`, `shapes[]`)

Request:
```json
{
  "format": "coco"
}
```

## 11. Annotation Endpoints (Phase 2 Minimum)

### GET /datasets/{datasetId}/annotations
List annotation records by item/status/task.

### POST /datasets/{datasetId}/annotations
Create or update annotation payload.

Request:
```json
{
  "dataset_item_id": "di-1",
  "task_type": "detection",
  "status": "in_progress",
  "source": "manual",
  "payload": {}
}
```

Rules:
- new annotations may start from `unannotated`, `in_progress`, or `annotated`
- direct upsert editing is only allowed while the record is in draft/editable states (`unannotated`, `in_progress`, `annotated`)
- once a record is in `in_review`, it becomes read-only in this endpoint; reviewer decisions must use `/review`
- a `rejected` record must first move back to `in_progress` before further edits are accepted
- `approved` records are read-only in this endpoint

### POST /datasets/{datasetId}/annotations/{annotationId}/submit-review
Move annotation to `in_review`.

### POST /datasets/{datasetId}/annotations/{annotationId}/review
Review annotation (`approved` or `rejected`).

Request:
```json
{
  "status": "approved",
  "review_reason_code": null,
  "quality_score": 0.92,
  "review_comment": "Good quality"
}
```

Rules:
- `review_reason_code` is required when `status=rejected`
- allowed codes: `box_mismatch`, `label_error`, `text_error`, `missing_object`, `polygon_issue`, `other`
- `review_reason_code` must be omitted or `null` when `status=approved`
- list/detail responses that embed `latest_review` include `review_reason_code` so the client can show persistent rework context

### POST /datasets/{datasetId}/pre-annotations
Run model-based pre-annotation on dataset ready items.

Request:
```json
{
  "model_version_id": "mv-1"
}
```

Behavior (current):
- if `model_version_id` is provided, server uses that version (task type must match dataset)
- if omitted, server picks latest visible registered model version for dataset task type
- for each ready dataset item, server runs framework `predict()` and converts output into annotation payload
- writes `source=pre_annotation`, `status=in_progress`
- skips approved annotations and items without prediction signal

## 12. Requirement Draft Endpoint

### POST /task-drafts/from-requirement
Generate a minimal training task draft from natural language requirement text.

Request:
```json
{
  "description": "识别列车编号并定位车门区域"
}
```

Response:
```json
{
  "task_type": "ocr",
  "recommended_framework": "paddleocr",
  "recommended_annotation_type": "ocr_text",
  "annotation_type": "ocr_text",
  "label_hints": ["text_line", "serial_number"],
  "dataset_suggestions": ["采集多光照车号样本"],
  "evaluation_metric_suggestions": ["accuracy", "cer", "wer"],
  "rationale": "需求以文字识别为主",
  "source": "rule"
}
```

Notes:
- first implementation is rule-based by default
- if user has enabled LLM config with valid key, server attempts LLM-enhanced draft and falls back to rule result on failure
- `annotation_type` is kept as backward-compatible alias of `recommended_annotation_type`

## 13. Training Job Endpoints

### GET /training/jobs
List training jobs.

Query:
- `task_type`
- `framework`
- `status`

### POST /training/jobs
Create training job.

Request:
```json
{
  "name": "ocr-finetune-april",
  "task_type": "ocr",
  "framework": "paddleocr",
  "dataset_id": "d-1",
  "dataset_version_id": "dv-1",
  "base_model": "paddleocr-PP-OCRv4",
  "config": {
    "epochs": 20,
    "batch_size": 16,
    "learning_rate": 0.001
  }
}
```

Request rules:
- `dataset_version_id` is required for new training jobs
- `dataset_version_id` must belong to the selected `dataset_id`
- selected dataset must already be launch-ready for training (`status=ready`)
- selected dataset version must include at least one `train` item in `split_summary`
- selected dataset version must have positive annotation coverage (`annotation_coverage > 0`)

Server behavior (current):
- create in `draft`, then queue into local single-node executor
- executor creates workspace at `TRAINING_WORKDIR_ROOT/{job_id}`
- executor writes:
  - `job-config.json`
  - `dataset-summary.json`
  - framework-ready materialized dataset assets under `materialized-dataset/`
  - `train.log`
  - `metrics.json`
  - artifact manifest file (for model version registration; may reference real exported weights through `primary_model_path`)
- job status path remains:
  `queued -> preparing -> running -> evaluating -> completed` (or `failed` / `cancelled`)
- metrics are derived from real dataset/annotation summary for this job (not fixed mock constants)
- business state snapshot is persisted in `APP_STATE_STORE_PATH` (default `.data/app-state.json`)
- on API restart, unfinished jobs in `queued/preparing/running/evaluating` are automatically re-queued
- executor now defaults to bundled local runner templates (`scripts/local-runners/*_train_runner.py`) and prefers runner-generated metrics from `{{metrics_path}}` when available
- if `<FRAMEWORK>_LOCAL_TRAIN_COMMAND` is configured (for example `YOLO_LOCAL_TRAIN_COMMAND`), it overrides bundled runner template
- when `VISTRAL_RUNNER_ENABLE_REAL=1`, bundled local runner templates attempt dependency-backed real framework execution; otherwise they stay in template mode
- if bundled runner command invocation fails (for example dependency missing), training falls back to simulated lifecycle and logs fallback reason
- for OCR frameworks, bundled `paddleocr/doctr` train runners can perform dependency-backed OCR probe execution (sampled manifest inference for metric bootstrap) when dependencies are available; when unavailable, artifact manifest keeps `mode=template` and `fallback_reason`
- OCR local runners may also emit additional OCR-shaped metric keys in `metrics.json` / artifact summary (for example `norm_edit_distance`, `word_accuracy`) alongside the canonical visible metrics, without changing the job detail response envelope
- `job.execution_mode` is returned explicitly (`simulated` | `local_command` | `unknown`)

### GET /training/jobs/{id}
Get training job detail including:
- `job`
- `metrics`
- `logs` (runtime log lines)
- `artifact_attachment_id` (if generated)
- `workspace_dir` (local executor workspace)
- `artifact_summary` (parsed runtime artifact manifest preview when available), fields include:
  - `runner`
  - `mode` (for example `real`, `real_probe`, `template`)
  - `fallback_reason` (present when local runner falls back)
  - `training_performed`
  - `primary_model_path` (if real exported weights are referenced)
  - `generated_at`
  - `sampled_items`
  - `metrics_keys` (summary of metric keys persisted in artifact)

### GET /training/jobs/{id}/metrics-export
Export normalized metric series JSON for troubleshooting.

Response:
```json
{
  "job_id": "tj-982",
  "exported_at": "2026-04-03T14:50:02.000Z",
  "total_rows": 45,
  "latest_metrics": {
    "map": 0.8112,
    "precision": 0.8451
  },
  "metrics_by_name": {
    "map": [
      { "step": 1, "value": 0.5221, "recorded_at": "2026-04-03T14:49:30.000Z" },
      { "step": 9, "value": 0.8112, "recorded_at": "2026-04-03T14:50:00.000Z" }
    ]
  }
}
```

Query option:
- `format=csv` returns CSV file download (`text/csv`) with columns:
  - `training_job_id`
  - `metric_name`
  - `step`
  - `metric_value`
  - `recorded_at`

### POST /training/jobs/{id}/cancel
Cancel running/queued job.

### POST /training/jobs/{id}/retry
Retry from failed/cancelled state.

## 14. Model Version Endpoints

### GET /model-versions
List model versions.

Query:
- `task_type`
- `framework`
- `model_id`

### POST /model-versions/register
Register model version from training job output.

Request:
```json
{
  "model_id": "m-1",
  "training_job_id": "tj-1",
  "version_name": "v2026.04.02-ocr-a"
}
```

Current rule:
- only completed jobs can register
- registration binds `artifact_attachment_id` to the generated training artifact attachment (not null for completed executor jobs)
- when the artifact attachment is a manifest JSON with `primary_model_path`, downstream inference resolves that version-bound model path first

### GET /model-versions/{id}
Get model version detail.

## 15. Inference Validation Endpoints

### GET /inference/runs
List inference runs.

### POST /inference/runs
Create inference run using model version and input attachment.

Request:
```json
{
  "model_version_id": "mv-1",
  "input_attachment_id": "f-1",
  "task_type": "ocr"
}
```

Rule:
- `input_attachment_id` should reference a ready attachment uploaded via `/files/inference/upload`.
- conversation attachment ids are still accepted for backward compatibility with existing scripts.

Response includes both raw and normalized outputs.
Response also includes explicit `execution_source` (mirrors normalized source marker).

Current execution preference:
1. framework runtime endpoint, if configured and reachable
2. version-bound local artifact path, if available to the selected model version
3. explicit local predict command / bundled local runner (bundled templates are used by default when explicit command is not configured)
4. deterministic local fallback or `mock_fallback`

`normalized_output.source` semantics:
- `<framework>_runtime`: runtime endpoint call succeeded
- `<framework>_local_command`: local predict command (`<FRAMEWORK>_LOCAL_PREDICT_COMMAND`) succeeded
- `<framework>_local`: no runtime endpoint configured, local deterministic inferencer used
- `mock_fallback`: runtime endpoint configured but call failed, fallback output returned with `raw_output.runtime_fallback_reason`

### GET /inference/runs/{id}
Get inference run detail.

### POST /inference/runs/{id}/feedback
Send failed sample back to dataset.

Request:
```json
{
  "dataset_id": "d-1",
  "reason": "missed_detection"
}
```

Behavior:
- server sets `inference_runs.feedback_dataset_id` to target dataset id.
- target dataset `task_type` must match the inference run `task_type`; otherwise request fails with validation error.
- if run input attachment is already dataset-scoped on the target dataset, server reuses it.
- otherwise server clones input attachment into a new dataset-scoped attachment (`attached_to_type=Dataset`, `attached_to_id=<dataset_id>`), preserving mime/size/local binary when available.
- server upserts one dataset item for this feedback run and records metadata:
  - `inference_run_id`
  - `feedback_reason`
  - `source_attachment_id`
- repeated feedback submission for the same run+dataset is idempotent at dataset-item level (updates metadata instead of creating duplicate item rows).

## 16. Runtime Connectivity Endpoint

### GET /runtime/connectivity
Check runtime bridge connectivity for framework adapters.

Query:
- `framework` (optional): `paddleocr | doctr | yolo`

Behavior:
- when `framework` is omitted, server returns all frameworks
- result indicates if endpoint is configured and currently reachable
- no API keys are returned in response

Response item:
```json
{
  "framework": "yolo",
  "configured": true,
  "reachable": true,
  "endpoint": "http://127.0.0.1:9393/predict",
  "source": "reachable",
  "error_kind": "none",
  "checked_at": "2026-04-02T00:00:00.000Z",
  "message": "Runtime endpoint responded with compatible payload."
}
```

`error_kind` enum:
- `none`
- `timeout`
- `network`
- `http_status`
- `invalid_payload`
- `unknown`

### GET /runtime/metrics-retention
Get current training metrics retention usage summary (scoped to jobs visible to current user).

Behavior:
- returns configured caps and current visible usage
- helps operators understand whether metric retention is close to limits
- does not expose jobs outside current permission scope

Response:
```json
{
  "max_points_per_job": 180,
  "max_total_rows": 20000,
  "current_total_rows": 428,
  "visible_job_count": 12,
  "jobs_with_metrics": 9,
  "max_rows_single_job": 90,
  "near_total_cap": false,
  "top_jobs": [
    { "training_job_id": "tj-982", "rows": 90 },
    { "training_job_id": "tj-400", "rows": 35 }
  ]
}
```

## 17. Unified Inference Output Schema
Used by `/inference/runs*` and adapter predict APIs.

```json
{
  "image": {
    "filename": "sample.jpg",
    "width": 1280,
    "height": 720,
    "source_attachment_id": "f-1"
  },
  "task_type": "detection",
  "framework": "yolo",
  "model": {
    "model_id": "m-1",
    "model_version_id": "mv-1",
    "name": "Defect Detector",
    "version": "v1"
  },
  "boxes": [
    { "x": 100, "y": 120, "width": 80, "height": 40, "label": "scratch", "score": 0.91 }
  ],
  "rotated_boxes": [],
  "polygons": [],
  "masks": [],
  "labels": [],
  "ocr": {
    "lines": [],
    "words": []
  },
  "raw_output": {},
  "normalized_output": {
    "version": "v1"
  }
}
```

## 18. Adapter Interface Contract (Runtime)
Platform adapter implementations for PaddleOCR/docTR/YOLO must expose:
- `validate_dataset()`
- `train()`
- `evaluate()`
- `predict()`
- `export()`
- `load_model()`

Adapter-specific internals are hidden behind this contract.

## 19. Error Codes
- `AUTHENTICATION_REQUIRED`
- `INSUFFICIENT_PERMISSIONS`
- `CSRF_VALIDATION_FAILED`
- `RESOURCE_NOT_FOUND`
- `VALIDATION_ERROR`
- `INVALID_STATE_TRANSITION`
- `INTERNAL_ERROR`

Implemented status mapping (prototype):
- `AUTHENTICATION_REQUIRED` -> `401`
- `INSUFFICIENT_PERMISSIONS` -> `403`
- `CSRF_VALIDATION_FAILED` -> `403`
- `RESOURCE_NOT_FOUND` -> `404`
- `PAYLOAD_TOO_LARGE` -> `413`
- `VALIDATION_ERROR` -> `400`
- `INVALID_STATE_TRANSITION` -> `409`
- `INTERNAL_ERROR` -> `500`

Implementation note:
- backend uses message-pattern classification first (for permission/not-found/state errors), implemented in shared error normalizer
- explicit message mapping is kept as fallback for edge cases

## 20. Versioning Strategy
- API path versioning is planned (`/v1`) for production.
- Current prototype uses stable `/api` routes; breaking changes must be documented in `PLANS.md` and migration notes.
