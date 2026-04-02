# Information Architecture

## 1. Purpose
Define executable route and page structure for the AI-native conversation workspace plus professional engineering console.

## 2. Access Rules
- System roles are only `user` and `admin`.
- `owner` is resource relation, not system role.
- `/auth/register` creates only `user`.

## 3. Route Map

### 3.1 Auth
- `/auth/login`
- `/auth/register`

### 3.2 Entry
- `/`
  - Dual work entry:
    - AI-native conversation workspace
    - professional console

### 3.3 Conversation Workspace
- `/workspace/chat`
  - timeline + composer + persistent attachment panel

### 3.4 Professional Console
- `/workspace/console`
  - operational snapshots and quick links

### 3.5 Model Domain
- `/models/explore`
- `/models/my-models`
- `/models/create` (stepper required)
- `/models/versions`

### 3.6 Dataset Domain
- `/datasets`
  - dataset list + create entry
- `/datasets/:datasetId`
  - dataset detail
  - top stepper for ingestion/split/version
  - dataset attachments always visible/deletable/status-aware
- `/datasets/:datasetId/annotate`
  - minimal annotation workspace
  - detection box + OCR text annotation
  - submit-review and approve/reject actions

### 3.7 Training Domain
- `/training/jobs`
  - job list
- `/training/jobs/new`
  - create training job wizard (stepper required, advanced params collapsed)
- `/training/jobs/:jobId`
  - detail: status, logs, metrics

### 3.8 Inference Validation Domain
- `/inference/validate`
  - upload image
  - choose model version
  - run inference
  - show raw + normalized output
  - feedback-to-dataset action

### 3.9 Settings
- `/settings/llm`

### 3.10 Admin
- `/admin/models/pending`
- `/admin/audit`

## 4. Shared UI Contracts
- `AppShell`: unified global navigation
- `StateBlock`: empty/loading/error/success
- `AttachmentUploader`: visible + deletable + status list
- `StepIndicator`: mandatory for multi-step flows
- `AdvancedSection`: advanced params collapsed by default

## 5. Page-Level Interaction Contracts

### 5.1 Dataset Detail
- top stepper for `Upload -> Organize -> Version`
- attachment list stays visible
- split/version actions are explicit operations

### 5.2 Training Job Creation
- top stepper for `Task -> Data -> Params -> Review`
- advanced hyperparameters remain collapsed initially

### 5.3 Inference Validation
- reusable uploader and state blocks
- output panel displays:
  - model metadata
  - raw output
  - normalized output
- one-click send to dataset feedback

## 6. Responsive Baseline
- Mobile: stacked single-column layout
- Desktop: side navigation + content frame
- Stepper and upload statuses remain readable on all breakpoints

## 7. Phase Boundary
- Phase 1 focuses on skeleton pages + mock APIs.
- Phase 2 introduces and now starts implementing minimal annotation workspace and review loop.
- Phase 3+ integrates real framework adapters and executors.
