# API Contract

## 1. Overview
This document defines the executable API contract for Vistral's prototype and the next-stage training platform skeleton.

## 2. Base Path and Auth
- Base path: `/api`
- Prototype auth: `HttpOnly` cookie session (`vistral_session`)
- Production target: bearer token
- Mutation methods (`POST`, `PUT`, `PATCH`, `DELETE`) require `X-CSRF-Token` in prototype mode except login/register/csrf

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
Create user account.

Important constraints:
- request payload does not accept `role`
- server always creates `role=user`
- admin assignment is only bootstrap/admin-only backend operation

Request:
```json
{
  "email": "user@example.com",
  "username": "alice",
  "password": "***"
}
```

### POST /auth/login
Login and bind session cookie.

### POST /auth/logout
Logout current session.

### GET /auth/csrf
Fetch CSRF token for current session.

## 6. User Endpoint

### GET /users/me
Get current session user.

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

### POST /conversations/message
Send message to an existing conversation.

### GET /conversations/{id}
Get conversation with messages.

## 8. File Attachment Endpoints

### GET /files/conversation
List conversation-scoped attachments for current user.

### POST /files/conversation/upload
Upload conversation attachment (prototype mock uses filename input).

Request:
```json
{
  "filename": "sample.jpg"
}
```

### GET /files/model/{modelId}
List model-scoped attachments.

### POST /files/model/{modelId}/upload
Upload model artifact attachment.

### GET /files/dataset/{datasetId}
List dataset-scoped attachments.

### POST /files/dataset/{datasetId}/upload
Upload dataset source file attachment.

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

Prototype behavior:
- accepts dataset-scoped source attachment id
- generates/updates annotations with `source=import`
- returns import summary (`imported`, `updated`)

Request:
```json
{
  "format": "yolo",
  "attachment_id": "f-100"
}
```

### POST /datasets/{id}/export
Export annotations from dataset.

Prototype behavior:
- returns export summary and generated dataset-scoped export attachment metadata
- does not yet stream binary export files in this round

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

### POST /datasets/{datasetId}/annotations/{annotationId}/submit-review
Move annotation to `in_review`.

### POST /datasets/{datasetId}/annotations/{annotationId}/review
Review annotation (`approved` or `rejected`).

Request:
```json
{
  "status": "approved",
  "quality_score": 0.92,
  "review_comment": "Good quality"
}
```

### POST /datasets/{datasetId}/pre-annotations
Run model-based pre-annotation (Phase 5 scale-up, Phase 2/3 basic entry).

## 12. Training Job Endpoints

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

Server behavior (prototype):
- create in `draft` then move through mock status path (`queued -> preparing -> running -> evaluating -> completed`)
- persist mock logs and metrics

### GET /training/jobs/{id}
Get training job detail including metrics and log excerpt.

### POST /training/jobs/{id}/cancel
Cancel running/queued job.

### POST /training/jobs/{id}/retry
Retry from failed/cancelled state.

## 13. Model Version Endpoints

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

### GET /model-versions/{id}
Get model version detail.

## 14. Inference Validation Endpoints

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

Response includes both raw and normalized outputs.

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

## 15. Unified Inference Output Schema
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

## 16. Adapter Interface Contract (Runtime)
Platform adapter implementations for PaddleOCR/docTR/YOLO must expose:
- `validate_dataset()`
- `train()`
- `evaluate()`
- `predict()`
- `export()`
- `load_model()`

Adapter-specific internals are hidden behind this contract.

## 17. Error Codes
- `AUTHENTICATION_REQUIRED`
- `INSUFFICIENT_PERMISSIONS`
- `CSRF_VALIDATION_FAILED`
- `RESOURCE_NOT_FOUND`
- `VALIDATION_ERROR`
- `INVALID_STATE_TRANSITION`
- `INTERNAL_ERROR`

## 18. Versioning Strategy
- API path versioning is planned (`/v1`) for production.
- Current prototype uses stable `/api` routes; breaking changes must be documented in `PLANS.md` and migration notes.
