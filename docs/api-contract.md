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
  - `run_model_inference` (attachment + inference intent keywords => auto run inference using conversation model's latest registered version)
- assistant can post-process latest OCR inference for extraction intents (plate/serial/number keywords) and return extracted candidate content
- when required inputs are missing, assistant returns `metadata.conversation_action.status=requires_input`
- high-risk mutating operations (`create_*`) require explicit confirmation before backend execution; assistant returns `missing_fields=["confirmation"]` plus `requires_confirmation=true`
- when backend execution succeeds, assistant returns `metadata.conversation_action.status=completed`
- when execution fails or user cancels, assistant returns `failed` / `cancelled`
- advanced console bridge (LLM/tool-like call): message can use `/ops {json}` to invoke selected console APIs directly in conversation
  - natural-language route is also supported for common intents (for example: “查看训练任务”, “导出 d-12 的 OCR 标注”, “取消训练任务 tj-101”); server maps intent to bridge API automatically
  - when natural-language intent is recognized but required IDs/params are missing, assistant returns structured `requires_input` with explicit `missing_fields`
  - user can reply with only the missing value(s) in follow-up turn; server merges them into pending bridge payload and continues execution flow (including high-risk confirmation gate)
  - supported `api`:
    - read: `list_datasets`, `list_models`, `list_model_versions`, `list_training_jobs`, `list_inference_runs`, `list_dataset_annotations`
    - execute: `run_inference`, `create_dataset_version`, `export_dataset_annotations`
    - mutating/high-risk: `create_dataset`, `create_model_draft`, `create_training_job`, `register_model_version`, `submit_approval_request`, `send_inference_feedback`, `cancel_training_job`, `retry_training_job`, `upsert_dataset_annotation`, `review_dataset_annotation`, `import_dataset_annotations`, `run_dataset_pre_annotations`, `activate_runtime_profile`
  - high-risk bridge APIs (all mutating actions above) require explicit confirmation before execution

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
  "requires_confirmation": false,
  "confirmation_phrase": null,
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

## 7.2 Runtime Settings Endpoints

### GET /settings/runtime
Get saved runtime adapter settings view.

Notes:
- admin scope only
- API keys are masked in response (`has_api_key`, `api_key_masked`)
- local train/predict command templates are returned as plain text fields for editing
- response includes `active_profile_id` + `available_profiles` for one-click runtime profile activation

Response:
```json
{
  "updated_at": "2026-04-10T02:30:00.000Z",
  "active_profile_id": "saved",
  "available_profiles": [
    {
      "id": "saved",
      "label": "Saved runtime settings",
      "description": "Current persisted runtime configuration used by API runtime adapters.",
      "source": "saved",
      "frameworks": {
        "paddleocr": {
          "endpoint": "http://127.0.0.1:9393/predict",
          "local_train_command": "python3 .../paddleocr_train_runner.py ...",
          "local_predict_command": "python3 .../paddleocr_predict_runner.py ...",
          "has_api_key": true,
          "api_key_masked": "sk-a...9f2b"
        },
        "doctr": {
          "endpoint": "",
          "local_train_command": "",
          "local_predict_command": "",
          "has_api_key": false,
          "api_key_masked": "Not set"
        },
        "yolo": {
          "endpoint": "http://127.0.0.1:9394/predict",
          "local_train_command": "python3 .../yolo_train_runner.py ...",
          "local_predict_command": "python3 .../yolo_predict_runner.py ...",
          "has_api_key": false,
          "api_key_masked": "Not set"
        }
      }
    }
  ],
  "frameworks": {
    "paddleocr": {
      "endpoint": "http://127.0.0.1:9393/predict",
      "local_train_command": "python3 .../paddleocr_train_runner.py ...",
      "local_predict_command": "python3 .../paddleocr_predict_runner.py ...",
      "has_api_key": true,
      "api_key_masked": "sk-a...9f2b"
    },
    "doctr": {
      "endpoint": "",
      "local_train_command": "",
      "local_predict_command": "",
      "has_api_key": false,
      "api_key_masked": "Not set"
    },
    "yolo": {
      "endpoint": "http://127.0.0.1:9394/predict",
      "local_train_command": "python3 .../yolo_train_runner.py ...",
      "local_predict_command": "python3 .../yolo_predict_runner.py ...",
      "has_api_key": false,
      "api_key_masked": "Not set"
    }
  },
  "controls": {
    "python_bin": "/opt/vistral/.venv/bin/python",
    "disable_simulated_train_fallback": false,
    "disable_inference_fallback": false
  }
}
```

### POST /settings/runtime
Save/update runtime adapter settings.

Request:
```json
{
  "runtime_config": {
    "paddleocr": {
      "endpoint": "http://127.0.0.1:9393/predict",
      "api_key": "",
      "local_train_command": "python3 .../paddleocr_train_runner.py ...",
      "local_predict_command": "python3 .../paddleocr_predict_runner.py ..."
    },
    "doctr": {
      "endpoint": "",
      "api_key": "",
      "local_train_command": "",
      "local_predict_command": ""
    },
    "yolo": {
      "endpoint": "http://127.0.0.1:9394/predict",
      "api_key": "",
      "local_train_command": "python3 .../yolo_train_runner.py ...",
      "local_predict_command": "python3 .../yolo_predict_runner.py ..."
    }
  },
  "runtime_controls": {
    "python_bin": "/opt/vistral/.venv/bin/python",
    "disable_simulated_train_fallback": false,
    "disable_inference_fallback": false
  },
  "keep_existing_api_keys": true
}
```

Notes:
- admin scope only
- when `keep_existing_api_keys=true`, blank `api_key` fields keep previously saved secret values
- `runtime_controls.python_bin` can override bundled runner python executable (`{{python_bin}}` placeholder)
- `runtime_controls.disable_simulated_train_fallback=true` forces train to fail fast when local runner is unavailable
- `runtime_controls.disable_inference_fallback=true` forces inference to fail fast instead of returning template/fallback outputs
- response is the same masked settings view as `GET /settings/runtime`
- save operation sets `active_profile_id` to `saved`

### POST /settings/runtime/activate-profile
Activate one runtime profile in one click.

Request:
```json
{
  "profile_id": "prod-realtime"
}
```

Notes:
- admin scope only
- profile source can be `saved` or deployment env profiles from `VISTRAL_RUNTIME_PROFILES_JSON`
- activating a profile copies its framework endpoint/api-key/local command templates into effective runtime settings
- response is the same masked settings view as `GET /settings/runtime`

### DELETE /settings/runtime
Clear UI-saved runtime settings and return to env-default fallback mode.

Notes:
- admin scope only
- response is the masked settings view
- after clear, adapter resolution falls back to environment variables until a new save is made

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
Fetch binary content for a ready attachment in readable resource scope.

Response:
- raw binary stream (not JSON envelope)
- headers include `Content-Type`, `Content-Length`, `Content-Disposition`

Read access rules:
- admin can always read
- attachment owner can read
- non-owner can read when they have access to the bound resource:
  - dataset attachment: can read if dataset access is allowed
  - model attachment: can read if model access is allowed
  - conversation attachment: can read if conversation access is allowed
  - inference attachment: can read if linked inference run/model-version access is allowed

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

### DELETE /admin/models/{id}
Delete a model from the catalog (admin only).

Rules:
- admin only
- curated foundation/base models are protected and must return a validation error instead of being deleted
- deletion is blocked when any `ModelVersion` still references the model
- deletion is blocked when any `Conversation` still references the model
- successful deletion removes:
  - the `Model` record
  - model-scoped `FileAttachment` records and stored binaries
  - related `ApprovalRequest` records
- successful deletion writes an audit log entry for governance traceability

Response:
```json
{
  "removed": true
}
```

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

Rules:
- split assignment targets trainable visual samples only (ready image attachments).
- non-visual helper files (for example import `.txt/.json` payload attachments) are excluded from split assignment.
- when `train_ratio > 0` and trainable sample count is non-zero, server guarantees at least one `train` sample.

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

Response notes:
- each job item includes scheduler metadata fields:
  - `execution_target`
  - `scheduled_worker_id`
  - `scheduler_note`
  - `scheduler_decision` (nullable structured decision snapshot)
  - `scheduler_decision_history` (ordered structured decision timeline)

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
- scheduler stores control-plane assignment metadata:
  - `job.execution_target` (`control_plane` | `worker`)
  - `job.scheduled_worker_id` (nullable)
  - `job.scheduler_note` (nullable; load snapshot/fallback reason)
  - `job.scheduler_decision` (nullable structured snapshot, including trigger/attempt/score/fallback/excluded-workers/decided-at)
  - `job.scheduler_decision_history` (ordered list of structured scheduler snapshots across create/resume/retry/reschedule/failover/fallback)

### GET /training/jobs/{id}
Get training job detail including:
- `job`
- `metrics`
- `logs` (runtime log lines)
- `artifact_attachment_id` (if generated)
- `workspace_dir` (local executor workspace)
- `job.scheduler_decision` for latest persisted scheduling transition snapshot
- `job.scheduler_decision_history` for full persisted scheduling timeline
- `artifact_summary` (parsed runtime artifact manifest preview when available), fields include:
  - `runner`
  - `mode` (for example `real`, `real_probe`, `template`)
  - `fallback_reason` (present for non-real local execution, including template default reason)
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
- registration is blocked when `training_jobs.execution_mode` is `simulated` or `unknown`
- registration is also blocked when local-command artifact summary indicates non-real execution evidence (`mode=template`, explicit `fallback_reason`, or `training_performed=false`) unless `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1`
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
4. explicit fallback result with traceable reason fields

`normalized_output.source` semantics:
- `<framework>_runtime`: runtime endpoint call succeeded
- `<framework>_local_command`: local predict command (`<FRAMEWORK>_LOCAL_PREDICT_COMMAND`) succeeded
- `explicit_fallback_runtime_failed`: runtime endpoint configured but call failed; fallback output returned with `raw_output.runtime_fallback_reason`
- `explicit_fallback_local_command_failed`: local command execution failed; fallback output returned with:
  - `raw_output.local_command_fallback_reason`
  - `raw_output.local_command_framework`
  - `raw_output.platform`
  - `raw_output.attempted_command`
- `base_empty`: baseline empty output (for example OCR fallback-safe empty lines/words)

Template-mode marker rule:
- when bundled local runner returns `raw_output.meta.mode=template`, frontend should treat the run as non-real output even if source is `<framework>_local_command`.
- for template-mode local command runs, backend also mirrors `meta.fallback_reason` into `raw_output.local_command_fallback_reason` so API consumers can read one canonical fallback-reason field.

OCR fallback safety rule:
- if local OCR predict command fails, fallback must return empty OCR arrays (`ocr.lines=[]`, `ocr.words=[]`) and must not inject business-looking sample text.

Generic fallback safety rule:
- if runtime/local command hard-fails and explicit fallback is applied, normalized structured predictions should default to empty arrays for all task payload groups (`boxes`, `rotated_boxes`, `polygons`, `masks`, `labels`, `ocr.lines`, `ocr.words`) unless runtime/local command actually returned those signals.

Local command execution rule:
- local command execution should prefer direct Python invocation when command template resolves to Python script execution.
- shell fallback must be cross-platform:
  - Windows: `ComSpec`/`cmd.exe`
  - POSIX: `${SHELL}` or `/bin/sh`
  - optional override: `VISTRAL_BASH_PATH`
- spawn failures must include platform + attempted command + resolved shell path (when applicable).

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

## 17. Training Worker Control Plane Endpoints

### GET /admin/training-workers
List training worker nodes visible to admin.

Rules:
- admin only
- response includes heartbeat/load/capacity plus scheduler-derived in-flight counters
- response also includes scheduler score breakdown for observability:
  - `scheduler_score` (lower is preferred)
  - `scheduler_load_component`
  - `scheduler_health_penalty`
  - `scheduler_capability_bonus`
  - `dispatch_recent_failures`
  - `dispatch_consecutive_failures`
  - `dispatch_last_failure_at`
  - `dispatch_last_success_at`
  - `dispatch_cooldown_active`

### GET /admin/training-workers/bootstrap-sessions
List pending or recent worker bootstrap sessions visible to admin.

Rules:
- admin only
- response is ordered by newest first
- bootstrap sessions are short-lived operator onboarding records and may include `expired` state

Response item shape:
```json
{
  "id": "twbs-501",
  "status": "bootstrap_created",
  "deployment_mode": "docker",
  "worker_profile": "yolo",
  "pairing_token": "vtw_8d9d6e...",
  "token_preview": "vtw_8d9d...e812",
  "control_plane_base_url": "http://10.0.0.10:8080",
  "worker_id": "tw-yolo-b7d9",
  "worker_name": "yolo-worker-b",
  "worker_public_host": "10.0.0.22",
  "worker_bind_port": 9090,
  "worker_endpoint_hint": "http://10.0.0.22:9090",
  "worker_runtime_profile": "yolo",
  "capabilities": ["framework:yolo", "task:detection"],
  "max_concurrency": 1,
  "issued_auth_mode": "dedicated",
  "issued_auth_token_preview": "vtwa_92fa...7bc1",
  "docker_command": "docker run ...",
  "script_command": "WORKER_BOOTSTRAP_TOKEN=... bash training-worker/scripts/run-worker-node.sh",
  "setup_url_hint": "http://10.0.0.22:9090/setup",
  "claimed_at": null,
  "last_seen_at": null,
  "callback_checked_at": null,
  "callback_validation_message": null,
  "compatibility": {
    "status": "unknown",
    "message": "Compatibility check has not run yet.",
    "expected_runtime_profile": "yolo",
    "reported_runtime_profile": null,
    "reported_worker_version": null,
    "reported_contract_version": null,
    "missing_capabilities": []
  },
  "linked_worker_id": null,
  "metadata": {
    "recommended_image": "vistral-training-worker:local"
  },
  "created_at": "2026-04-07T08:00:00.000Z",
  "expires_at": "2026-04-07T08:20:00.000Z"
}
```

### POST /admin/training-workers/bootstrap-sessions
Create a short-lived worker bootstrap session from admin runtime settings.

Request:
```json
{
  "deployment_mode": "docker",
  "worker_profile": "yolo",
  "control_plane_base_url": "http://10.0.0.10:8080",
  "worker_name": "yolo-worker-b",
  "worker_public_host": "10.0.0.22",
  "worker_bind_port": 9090,
  "max_concurrency": 1
}
```

Rules:
- admin only
- `deployment_mode` must be `docker` or `script`
- `worker_profile` must be `yolo`, `paddleocr`, `doctr`, or `mixed`
- `worker_public_host` is optional but recommended for cross-machine workers so the generated worker endpoint / `/setup` URL are immediately usable
- `worker_bind_port` is optional and defaults to `9090`
- control plane returns copyable startup templates plus a short-lived pairing token
- bootstrap-created workers now prefer a dedicated per-worker auth token behind the pairing exchange; operators should not need to manually paste the long-lived control-plane shared token

### GET /admin/training-workers/bootstrap-sessions/{id}/bundle
Download a worker bootstrap bundle script for operator handoff.

Rules:
- admin only
- returns a downloadable shell script attachment
- bundle includes the current pairing token, selected deployment mode startup command, and next-step `/setup` guidance
- bundle is intended for trusted operator delivery inside the same infrastructure boundary

### POST /admin/training-workers
Create a training worker node manually from admin control plane.

Request:
```json
{
  "name": "gpu-worker-b",
  "endpoint": "http://10.10.0.22:9090",
  "max_concurrency": 2,
  "enabled": true,
  "capabilities": ["framework:yolo", "task:detection"],
  "metadata": {
    "ip": "10.10.0.22",
    "zone": "rack-b"
  }
}
```

### PATCH /admin/training-workers/{id}
Update worker mutable fields.

Supported fields:
- `name`
- `endpoint`
- `status` (`online` | `offline` | `draining`)
- `enabled`
- `max_concurrency`
- `capabilities`
- `metadata`

### DELETE /admin/training-workers/{id}
Remove worker node from scheduling pool.

Rules:
- admin only
- worker with active in-flight jobs cannot be removed

### POST /runtime/training-workers/bootstrap-sessions/claim
Worker-local setup service exchanges a short-lived pairing token for resolved worker config defaults.

Request:
```json
{
  "pairing_token": "vtw_8d9d6e..."
}
```

Response:
```json
{
  "bootstrap_session": {
    "id": "twbs-501",
    "status": "pairing",
    "worker_id": "tw-yolo-b7d9",
    "worker_name": "yolo-worker-b"
  },
  "config_defaults": {
    "control_plane_base_url": "http://10.0.0.10:8080",
    "training_worker_auth_token": "vtwa_worker_specific_secret",
    "worker_id": "tw-yolo-b7d9",
    "worker_name": "yolo-worker-b",
    "worker_endpoint": "http://10.0.0.22:9090",
    "worker_status": "online",
    "worker_enabled": "true",
    "worker_max_concurrency": "1",
    "worker_capabilities": "framework:yolo,task:detection",
    "worker_runtime_profile": "yolo"
  }
}
```

Rules:
- intended for worker-local onboarding service, not end-user browsers
- token must be unexpired
- successful claim moves bootstrap session from `bootstrap_created` to `pairing`
- response may already include preconfigured `worker_endpoint` defaults when admin supplied `worker_public_host` / `worker_bind_port`
- response may still require worker-local UI to collect writable run-root and other machine-local values before final apply

### POST /runtime/training-workers/bootstrap-sessions/status
Worker-local setup service checks the latest control-plane status for a short-lived bootstrap session.

Request:
```json
{
  "pairing_token": "vtw_8d9d6e..."
}
```

Response:
```json
{
  "id": "twbs-501",
  "status": "awaiting_confirmation",
  "worker_id": "tw-yolo-b7d9",
  "worker_name": "yolo-worker-b",
  "worker_endpoint_hint": "http://10.0.0.22:9090",
  "compatibility": {
    "status": "warning",
    "message": "Worker health payload does not report runtime_profile; keep worker package updated.",
    "expected_runtime_profile": "yolo",
    "reported_runtime_profile": null,
    "reported_worker_version": "0.1.0",
    "reported_contract_version": "training-worker-healthz.v1",
    "missing_capabilities": []
  },
  "callback_validation_message": "Waiting for worker heartbeat to publish a callback endpoint.",
  "last_seen_at": "2026-04-07T08:03:00.000Z",
  "callback_checked_at": "2026-04-07T08:03:00.000Z"
}
```

Rules:
- intended for worker-local onboarding service, not end-user browsers
- token must be unexpired
- endpoint is read-only and does not change bootstrap session state by itself
- worker-local setup UIs can poll this endpoint after `claim` / `apply` to show whether the worker really reached `online`, is still `awaiting_confirmation`, or is stuck in `validation_failed`
- response includes `compatibility` snapshot for worker-version/profile/capability checks

### POST /admin/training-workers/bootstrap-sessions/{id}/validate-callback
Retry callback validation from control plane to the linked worker endpoint.

Rules:
- admin only
- session must exist and must already know either `linked_worker_id` or `worker_endpoint_hint`
- success advances session to `online` when callback and compatibility checks pass
- compatibility warning still allows success but must be reflected in `compatibility.status=warning`
- hard incompatibility (for example runtime profile mismatch) keeps session in `validation_failed`
- failure keeps session in `validation_failed` and the linked worker out of schedulable `online` state

### POST /admin/training-workers/{id}/activate
Explicitly activate a worker after callback validation from admin control plane.

Rules:
- admin only
- worker must exist
- control plane re-runs callback validation against worker endpoint before activation
- callback validation failure returns error and forces worker/session into non-online state (`offline` / `validation_failed`)
- compatibility hard-fail from health payload (for example profile mismatch) is treated as activation failure
- callback validation success sets worker `status=online` and, when bootstrap session exists, updates it to `online`

Response shape:
```json
{
  "worker": {
    "id": "tw-yolo-b7d9",
    "status": "online",
    "effective_status": "online"
  },
  "bootstrap_session": {
    "id": "twbs-501",
    "status": "online"
  }
}
```

### POST /admin/training-workers/{id}/reconfigure-session
Create a new bootstrap session for an existing worker (upgrade/reconfigure flow).

Rules:
- admin only
- worker must exist
- response shape is the same as normal bootstrap-session records
- session should be prefilled from existing worker endpoint/capabilities when available
- this operation does not remove/replace the existing worker record; it only prepares a guided reconfigure pairing flow

### POST /runtime/training-workers/heartbeat
Worker self-reports heartbeat and load to control plane.

Auth:
- header `X-Training-Worker-Token`
- accepted credentials:
  - dedicated per-worker token issued during bootstrap pairing
  - control-plane shared fallback token from `TRAINING_WORKER_SHARED_TOKEN` for legacy/manual workers

Request:
```json
{
  "worker_id": "tw-22",
  "name": "gpu-worker-b",
  "endpoint": "http://10.10.0.22:9090",
  "status": "online",
  "enabled": true,
  "max_concurrency": 2,
  "reported_load": 0.35,
  "capabilities": ["framework:yolo", "task:detection"],
  "metadata": {
    "ip": "10.10.0.22"
  }
}
```

Behavior:
- updates existing worker by `worker_id` or auto-registers new worker when not found
- heartbeat stale timeout uses `TRAINING_WORKER_HEARTBEAT_TTL_MS`
- scheduler treats stale worker as unavailable
- when heartbeat matches an active bootstrap session `worker_id`, control plane should run callback validation against worker health endpoint before advancing session/worker to `online`

### GET /runtime/training-workers/dataset-packages/{package_id}
Internal control-plane endpoint for worker dataset package download.

Auth:
- header `X-Training-Worker-Token`
- accepts the scheduled worker's dedicated token; shared token remains valid as compatibility fallback

Response:
- standard success envelope whose `data` is an `inline_base64_v1` dataset package payload
- package must be within TTL; expired or unknown package ids return error

### Worker execution contract (control-plane -> worker service)
This is the worker-machine service contract used when a job is scheduled to `execution_target=worker`.
It is not a public end-user API under Vistral control-plane `/api`; it is an internal node-to-node contract.

Endpoint (worker side):
- `POST {worker.endpoint}/api/worker/train`

Auth:
- header `X-Training-Worker-Token`
- control plane should prefer the scheduled worker's dedicated token; shared token remains valid as compatibility fallback

Request payload (minimum):
```json
{
  "job_id": "tj-1201",
  "framework": "yolo",
  "task_type": "detection",
  "dataset_id": "d-2",
  "dataset_version_id": "dv-2",
  "base_model": "yolo11n",
  "config": {
    "epochs": "30",
    "batch_size": "16"
  },
  "dataset_summary": {
    "total_items": 120
  },
  "dataset_package": {
    "format": "reference_json_v1",
    "package_id": "twpkg-501",
    "download_url": "http://10.0.0.10:8080/api/runtime/training-workers/dataset-packages/twpkg-501",
    "expires_at": "2026-04-07T10:22:33.100Z",
    "root_relative": "materialized-dataset/yolo",
    "total_files": 12,
    "total_bytes": 1048576
  }
}
```

`dataset_package` supports:
- `inline_base64_v1`: embeds files directly via `files[]` with base64 payload
- `reference_json_v1`: includes `package_id`, `download_url`, and TTL metadata; worker must fetch inline package json from control plane using worker token

Scheduler context note:
- control plane may include `scheduler` object for observability (`execution_target`, `scheduled_worker_id`, `scheduler_note`, `scheduler_decision`)
- worker can treat this as read-only metadata and does not need to mutate scheduler fields

Path compatibility note:
- worker may receive optional `workspace` path hints from control plane
- for cross-machine deployment, worker should default to local workspace root and ignore foreign absolute paths unless explicitly configured to trust request paths
- when `dataset_package` is present, worker should reconstruct files under local workspace and rewrite any materialized dataset path references to local paths
- when `download_url` is relative, worker should resolve it against `CONTROL_PLANE_BASE_URL`

Response payload (minimum):
```json
{
  "accepted": true,
  "execution_mode": "local_command",
  "log_preview": "yolo worker command finished",
  "logs": ["..."],
  "metrics": {
    "map": 0.71,
    "precision": 0.78,
    "recall": 0.69
  },
  "metric_series": [
    { "step": 1, "metrics": { "map": 0.42 } },
    { "step": 2, "metrics": { "map": 0.48 } }
  ],
  "artifact_payload": {
    "runner": "worker-local-runner",
    "mode": "template"
  }
}
```

Worker cancellation endpoint (worker side):
- `POST {worker.endpoint}/api/worker/cancel`

Request:
```json
{
  "job_id": "tj-1201"
}
```

Behavior:
- worker should stop running process for `job_id` when active
- control plane may call this endpoint when user requests cancel on a worker-running job
- response should include whether there was an active process at cancel time

Control-plane behavior:
- success: persist returned logs/metrics/artifact summary into job runtime outputs
- dispatch failure: control plane may reselect another eligible online worker and retry dispatch within the same run
- retry policy is bounded by scheduler runtime settings (`TRAINING_WORKER_DISPATCH_MAX_ATTEMPTS`, `TRAINING_WORKER_DISPATCH_RETRY_BASE_MS`), then fallback/terminal behavior applies
- scheduler candidate scoring may apply recent dispatch-failure penalty/cooldown (`TRAINING_WORKER_FAILURE_PENALTY_WINDOW_MS`, `TRAINING_WORKER_FAILURE_COOLDOWN_MS`) before selecting next worker
- failure: if fallback policy is enabled, switch to control-plane local execution and append dispatch-failure reason into scheduler/log context

### Worker local setup endpoints
Worker service also exposes local onboarding/setup endpoints for operator-driven GUI configuration.

Endpoints (worker side):
- `GET {worker.endpoint}/setup`
- `GET {worker.endpoint}/api/local/setup/state`
- `POST {worker.endpoint}/api/local/setup/detect`
- `POST {worker.endpoint}/api/local/setup/pair`
- `POST {worker.endpoint}/api/local/setup/validate`
- `POST {worker.endpoint}/api/local/setup/apply`

Notes:
- these endpoints are intended for local/operator setup use on the worker machine
- common setup path:
  - start worker node in setup mode
  - open `/setup`
  - paste pairing token or use the token injected by startup command
  - let worker-local service claim config defaults from control plane
  - fill/confirm worker identity + callback endpoint
  - validate
  - apply
- `apply` persists worker config into local env file and updates in-process config; when worker is supervised by `run-worker-node.sh`, heartbeat can start automatically after config becomes valid

## 18. Unified Inference Output Schema
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

## 19. Adapter Interface Contract (Runtime)
Platform adapter implementations for PaddleOCR/docTR/YOLO must expose:
- `validate_dataset()`
- `train()`
- `evaluate()`
- `predict()`
- `export()`
- `load_model()`

Adapter-specific internals are hidden behind this contract.

Current adapter behavior constraints:
- `evaluate()` should prefer file-backed metrics (`metrics.json` summary/series) from job workspace and only return empty metrics when no evaluable artifact exists.
- `export()` should generate a real local export artifact path (under configurable storage root), not a synthetic `/mock-artifacts/...` path.
- `load_model()` should validate artifact existence before returning a handle; missing artifacts should return explicit failure instead of fake success handles.

## 20. Error Codes
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

## 21. Versioning Strategy
- API path versioning is planned (`/v1`) for production.
- Current prototype uses stable `/api` routes; breaking changes must be documented in `PLANS.md` and migration notes.
