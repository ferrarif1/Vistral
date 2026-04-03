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
  - dedicated immersive chat shell (chat-style left sidebar + centered timeline + floating composer)
  - sidebar uses server-backed conversation history with sync + click-to-restore conversation detail
  - sidebar history is grouped by recency buckets (Pinned/Today/Yesterday/Previous 7 Days/Older)
  - pinned chats support drag-to-reorder inside the pinned group
  - conversation item context menu supports open/rename/pin/delete quick actions (right-click on desktop, long-press on mobile)
  - context menu supports keyboard navigation (`ArrowUp/ArrowDown`, `Enter`, `Esc`) and quick keys (`O/R/P/D`)
  - mobile long-press uses lightweight haptic feedback when browser vibration API is available
  - sidebar supports local hide/clear controls with explicit "show hidden" recovery
  - persistent attachment strip with status + delete controls inside composer context

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
  - runtime connectivity diagnostics (PaddleOCR/docTR/YOLO)
  - upload image
  - choose model version
  - run inference
  - show raw + normalized output
  - feedback-to-dataset action

### 3.9 Settings
- `/settings/llm`
- `/settings/runtime`

### 3.10 Admin
- `/admin/models/pending`
- `/admin/audit`
- `/admin/verification-reports`

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
- runtime diagnostics panel with refresh action and per-framework status
- output panel displays:
  - model metadata
  - raw output
  - normalized output
- one-click send to dataset feedback

### 5.4 Runtime Settings
- runtime connectivity checks for all frameworks and single framework
- integration templates (env vars, request/response payload examples, health-check curl)
- advanced template section collapsed by default

### 5.5 Admin Verification Reports
- support filtering by status, base URL, and keyword
- support date-range filtering and report ordering (latest/oldest/failed-first)
- support quick date presets (last 7 days / last 30 days / clear)
- checks detail is collapsible per report to reduce operational list noise
- support pagination and filtered JSON export for release governance evidence
- default ordering prefers failed reports first for governance triage
- page is used for deployment go/no-go governance review

## 6. Responsive Baseline
- Mobile: stacked single-column layout
- Desktop: side navigation + content frame
- Stepper and upload statuses remain readable on all breakpoints

## 7. Phase Boundary
- Phase 1 focuses on skeleton pages + mock APIs.
- Phase 2 introduces and now starts implementing minimal annotation workspace and review loop.
- Phase 3+ integrates real framework adapters and executors.
