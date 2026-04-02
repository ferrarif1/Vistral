# Product Requirements Document (PRD)

## 1. Product Overview
Vistral is an AI-native visual model platform with two work entries:
1. conversational workspace (natural language + attachments)
2. professional engineering console (dataset/annotation/training/model-version/inference operations)

The platform keeps a strict two-role system (`user`, `admin`) and ownership/capability-based authorization.

## 2. Problem Statement
Engineers currently rely on fragmented tools for dataset prep, annotation, training, and inference verification. This increases handoff costs and slows iteration.

Vistral must provide one closed-loop platform where engineers can:
- prepare datasets
- annotate and review
- fine-tune models
- evaluate and register versions
- validate inference
- feed error samples back for retraining

## 3. Target Users
1. `user`: engineer/researcher/operator performing day-to-day model workflows
2. `admin`: governance/audit/approval/system operations

## 4. Task and Framework Scope

### 4.1 Task scope
- OCR
- detection
- classification
- segmentation
- optional OBB

### 4.2 Framework responsibilities
- PaddleOCR: OCR baseline
- docTR: OCR alternative
- YOLO: detection baseline with extension toward classification/segmentation/OBB

## 5. Core Use Cases
1. AI-native conversation with attachments
2. dataset creation and management
3. online annotation and review
4. pre-annotation and correction
5. fine-tuning training job management
6. evaluation and model version registration
7. inference validation and error feedback loop

## 6. Access Model Clarification
- System roles: `user`, `admin`
- `owner` is a resource relation (`owner_user_id`), not a role
- register endpoint cannot create admin accounts
- admin assignment only via bootstrap/admin-only backend path

## 7. Functional Requirements

### FR-001 Conversation Workspace
- natural language interaction
- persistent context per conversation
- attachment-driven message flow

### FR-002 File Attachment Baseline
- uploads remain visible in context
- each upload is deletable
- status at minimum: `uploading`, `processing`, `ready`, `error`

### FR-003 Unified Stepper Requirement
- all multi-step workflows must display top stepper
- current step, total step, completion hints are explicit

### FR-004 Advanced Parameters
- advanced sections are collapsed by default
- users can expand progressively

### FR-005 Consistent State Feedback
- all pages must use unified empty/loading/error/success patterns

### FR-006 Dataset Management
- create/manage datasets
- upload image/video/archive files
- sample list/detail
- label class management
- train/val/test split
- dataset versioning
- annotation import formats: YOLO/COCO/LabelMe/OCR
- export endpoint contract reserved

### FR-007 Online Annotation
- detection boxes
- rotated boxes (OBB baseline)
- polygon/segmentation
- OCR text input/correction
- save/undo/continue editing
- status flow: `unannotated -> in_progress -> annotated -> in_review -> approved/rejected`

### FR-008 Pre-Annotation and Review
- run pre-annotation with selected model version
- manual correction and review sampling
- reject/rework path with audit notes

### FR-009 Training Jobs
- create training job
- choose task type/framework/base model
- configure parameters and submit
- support start/cancel/retry lifecycle
- status flow: `draft -> queued -> preparing -> running -> evaluating -> completed/failed/cancelled`

### FR-010 Evaluation and Model Versioning
- OCR metrics: accuracy/CER/WER
- detection metrics: mAP/precision/recall
- store error sample analysis
- register model version with training linkage
- compare model versions

### FR-011 Inference Validation
- upload image and run inference with selected model version
- show raw output + normalized output
- persist inference runs
- one-click feedback sample back to dataset

### FR-012 Adapter Abstraction
Framework integrations must follow unified trainer interface:
- `validate_dataset()`
- `train()`
- `evaluate()`
- `predict()`
- `export()`
- `load_model()`

## 8. Non-Functional Requirements

### NFR-001 Performance
- page interactions under 2s for baseline operations
- long-running jobs have visible status transitions and logs

### NFR-002 Security
- in-transit encryption
- secure secret handling
- role/ownership checks on all mutating APIs
- audit logs for privileged actions

### NFR-003 Reliability
- resumable multi-step flows
- clear failure states and retry paths

### NFR-004 Extensibility
- framework adapters added without breaking API/UI contracts

## 9. Delivery Strategy
- Phase 1: schema/API/page skeleton + mock loops
- Phase 2: minimal online annotation loop
- Phase 3: PaddleOCR/docTR/YOLO adapters
- Phase 4: OCR + detection business loop closure
- Phase 5: pre-annotation scale-up, active learning, distributed execution

## 10. Out of Scope (Current Round)
- production-grade distributed training orchestration
- full collaborative annotation suite
- advanced benchmarking dashboards beyond baseline metrics
