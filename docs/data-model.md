# Data Model

## 1. Overview
This document defines platform-level entities for Vistral's AI-native conversation and training workflows. Contracts in this file are the source of truth for schema and API payload design.

## 2. Access and Ownership Semantics
- System roles are only `user` and `admin`.
- `owner` is a resource relationship (`owner_user_id`), not a role enum.
- Public registration creates only `user`.
- Privileged actions combine role checks with ownership/capability checks.

## 3. Shared Enums

### 3.1 Task type
- `ocr`
- `detection`
- `classification`
- `segmentation`
- `obb` (optional)

### 3.2 Framework
- `paddleocr`
- `doctr`
- `yolo`

### 3.3 File status
- `uploading`
- `processing`
- `ready`
- `error`

### 3.4 Annotation status
- `unannotated`
- `in_progress`
- `annotated`
- `in_review`
- `approved`
- `rejected`

### 3.5 Training job status
- `draft`
- `queued`
- `preparing`
- `running`
- `evaluating`
- `completed`
- `failed`
- `cancelled`

## 4. Core Entities

### 4.1 User
Attributes:
- `id` (PK)
- `username` (unique)
- `password_hash` (scrypt+salt, server-side only, never returned to client)
- `role` (`user` | `admin`)
- `capabilities` (JSON array)
- `created_at`, `updated_at`

Relationships:
- owns many `Model`
- owns many `Dataset`
- creates many `TrainingJob`

### 4.2 Model
Attributes:
- `id` (PK)
- `name`
- `description`
- `model_type`
- `owner_user_id` (FK User)
- `visibility` (`private` | `workspace` | `public`)
- `status` (`draft` | `pending_approval` | `approved` | `rejected` | `published` | `deprecated`)
- `metadata` (JSON)
- `created_at`, `updated_at`

Relationships:
- has many `ModelVersion`
- has many `ApprovalRequest`

### 4.3 Conversation
Attributes:
- `id` (PK)
- `model_id` (FK Model)
- `title`
- `status` (`active` | `completed` | `archived`)
- `created_by` (FK User)
- `created_at`, `updated_at`

Relationships:
- has many `Message`
- references many `FileAttachment` (via message/context)

### 4.4 Message
Attributes:
- `id` (PK)
- `conversation_id` (FK Conversation)
- `sender` (`user` | `assistant` | `system`)
- `content`
- `attachment_ids` (JSON array)
- `created_at`

### 4.5 FileAttachment
Attributes:
- `id` (PK)
- `filename`
- `status` (`uploading` | `processing` | `ready` | `error`)
- `owner_user_id` (FK User)
- `attached_to_type` (`Conversation` | `Model` | `Dataset` | `InferenceRun`)
- `attached_to_id` (nullable)
- `upload_error` (nullable)
- `created_at`, `updated_at`

Rule:
- upload lists must stay visible in UI and support delete actions.

### 4.6 ApprovalRequest
Attributes:
- `id` (PK)
- `model_id` (FK Model)
- `requested_by` (FK User)
- `approved_by` (FK User, nullable)
- `status` (`pending` | `approved` | `rejected`)
- `review_notes` (nullable)
- `requested_at`, `reviewed_at`

### 4.7 Dataset
Attributes:
- `id` (PK)
- `name`
- `description`
- `task_type` (TaskType)
- `status` (`draft` | `ready` | `archived`)
- `owner_user_id` (FK User)
- `label_schema` (JSON: classes, aliases, color)
- `metadata` (JSON)
- `created_at`, `updated_at`

Relationships:
- has many `DatasetItem`
- has many `DatasetVersion`
- referenced by many `TrainingJob`

### 4.8 DatasetItem
Attributes:
- `id` (PK)
- `dataset_id` (FK Dataset)
- `attachment_id` (FK FileAttachment)
- `split` (`train` | `val` | `test` | `unassigned`)
- `status` (`uploading` | `processing` | `ready` | `error`)
- `metadata` (JSON)
- `created_at`, `updated_at`

Relationships:
- has many `Annotation`

### 4.9 Annotation
Attributes:
- `id` (PK)
- `dataset_item_id` (FK DatasetItem)
- `task_type` (TaskType)
- `source` (`manual` | `import` | `pre_annotation`)
- `status` (AnnotationStatus)
- `payload` (JSON normalized annotation payload)
- `annotated_by` (FK User)
- `created_at`, `updated_at`

### 4.10 AnnotationReview
Attributes:
- `id` (PK)
- `annotation_id` (FK Annotation)
- `reviewer_user_id` (FK User)
- `status` (`approved` | `rejected`)
- `quality_score` (nullable float)
- `review_comment` (nullable)
- `created_at`

### 4.11 DatasetVersion
Attributes:
- `id` (PK)
- `dataset_id` (FK Dataset)
- `version_name`
- `split_summary` (JSON)
- `item_count`
- `annotation_coverage` (float)
- `created_by` (FK User)
- `created_at`

### 4.12 TrainingJob
Attributes:
- `id` (PK)
- `name`
- `task_type` (TaskType)
- `framework` (Framework)
- `status` (TrainingJobStatus)
- `dataset_id` (FK Dataset)
- `dataset_version_id` (FK DatasetVersion, nullable)
- `base_model`
- `config` (JSON)
- `log_excerpt` (nullable)
- `submitted_by` (FK User)
- `created_at`, `updated_at`

Relationships:
- has many `TrainingMetric`
- can produce one or more `ModelVersion`

### 4.13 TrainingMetric
Attributes:
- `id` (PK)
- `training_job_id` (FK TrainingJob)
- `metric_name` (for example `map`, `cer`, `wer`, `precision`, `recall`)
- `metric_value` (float)
- `step` (int)
- `recorded_at`

### 4.14 ModelVersion
Attributes:
- `id` (PK)
- `model_id` (FK Model)
- `training_job_id` (FK TrainingJob, nullable)
- `version_name`
- `task_type` (TaskType)
- `framework` (Framework)
- `status` (`registered` | `deprecated`)
- `metrics_summary` (JSON)
- `artifact_attachment_id` (FK FileAttachment, nullable)
- `created_by` (FK User)
- `created_at`

### 4.15 InferenceRun
Attributes:
- `id` (PK)
- `model_version_id` (FK ModelVersion)
- `input_attachment_id` (FK FileAttachment)
- `task_type` (TaskType)
- `framework` (Framework)
- `status` (`queued` | `running` | `completed` | `failed`)
- `raw_output` (JSON)
- `normalized_output` (JSON)
- `feedback_dataset_id` (FK Dataset, nullable)
- `created_by` (FK User)
- `created_at`, `updated_at`

## 5. State Transition Rules

### 5.1 Annotation
- `unannotated -> in_progress -> annotated -> in_review -> approved`
- rejection path: `in_review -> rejected -> in_progress`

### 5.2 TrainingJob
- `draft -> queued -> preparing -> running -> evaluating -> completed`
- failure path: `running|evaluating -> failed`
- manual stop: `queued|preparing|running -> cancelled`

### 5.3 ModelVersion
- register path: training/evaluation completion creates `registered`
- lifecycle can move to `deprecated`

## 6. Unified Inference Output Storage
`InferenceRun.normalized_output` must support:
- image metadata
- `task_type`, `framework`
- model metadata
- `boxes`, `rotated_boxes`, `polygons`, `masks`, `labels`
- OCR lines/words/confidence
- full `raw_output`

## 7. Indexes and Constraints (minimum)
- unique: `users.username`
- index: `models.owner_user_id, models.status`
- index: `datasets.owner_user_id, datasets.task_type`
- index: `dataset_items.dataset_id, dataset_items.split`
- index: `annotations.dataset_item_id, annotations.status`
- index: `training_jobs.dataset_id, training_jobs.status`
- index: `training_metrics.training_job_id, training_metrics.metric_name`
- index: `model_versions.model_id, model_versions.created_at`
- index: `inference_runs.model_version_id, inference_runs.created_at`

## 8. Security and Audit Notes
- sensitive operations (approval, role-sensitive actions, training state transitions) must create audit logs
- file and inference artifacts should remain traceable to user + resource ownership
- key material remains outside plain-text source control
