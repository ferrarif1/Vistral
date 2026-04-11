# Information Architecture

## 1. Purpose
Define executable route and page structure for the AI-native conversation workspace plus professional engineering console.

## 2. Access Rules
- System roles are only `user` and `admin`.
- `owner` is resource relation, not system role.
- public self-registration is disabled.
- administrators provision accounts from authenticated account settings.

## 3. Route Map

### 3.1 Auth
- `/auth/login`
- `/auth/register` redirects to `/auth/login` and no longer exposes public self-registration UI

### 3.2 Entry
- `/`
  - redirects to `/workspace/chat`
  - professional console remains directly accessible via `/workspace/console`

### 3.3 Conversation Workspace
- `/workspace/chat`
  - dedicated immersive chat shell (chat-style left sidebar + centered timeline + floating composer)
  - top header stays lightweight and keeps model/mode context only; language switch is moved into the account menu opened from the sidebar footer / compact rail avatar
  - model selector shows the curated foundation/base model catalog used for future training and normal chat entry
  - sidebar uses server-backed conversation history with sync + click-to-restore conversation detail
  - desktop sidebar keeps a fixed viewport height and uses internal scroll regions instead of stretching with the page
  - desktop sidebar supports collapse/expand so the conversation canvas can switch between focused and browsing modes
  - mobile sidebar behaves as a temporary drawer opened from the header and dismissed by overlay tap or close action
  - sidebar history is shown as a direct conversation list (no search box, no quick-link block, no recency section title)
  - when history is empty, the list area stays blank (no placeholder title text)
  - pinned chats still support drag-to-reorder
  - desktop conversation rows keep actions hidden by default; hover reveals a compact overflow button so the list stays visually clean like a chat-first workspace
  - conversation item overflow/context menu supports rename/pin/delete quick actions, while opening a chat stays on row click (right-click on desktop, long-press on mobile also opens the menu)
  - context menu supports keyboard navigation (`ArrowUp/ArrowDown`, `Enter`, `Esc`) and quick keys (`R/P/D`)
  - mobile long-press uses lightweight haptic feedback when browser vibration API is available
  - sidebar footer keeps a non-collapsible account card trigger showing avatar, username, and role (`User` / `Admin`)
  - on-demand attachment tray inside composer context
  - current-draft attachments surface as chips while composing and collapse after send
  - attachment tray background refresh stays quiet and only updates visible draft/file state when attachment data actually changes
  - assistant messages can render compact operation cards for real backend actions (`create_dataset`, `create_model_draft`, `create_training_job`)
  - when operation input is incomplete, conversation stays in the same thread and requests only the missing fields needed to continue

### 3.4 Professional Console
- `/workspace/console`
  - shared app shell route (global left navigation + top context header), not chat-immersive layout
  - professional workbench pages use a stable three-zone structure:
    - top context toolbar (`WorkspaceContextBar`) for search/filter/batch actions
    - middle main work area for operational lists/canvas/tables
    - right inspector panel for selected-object details and primary follow-up actions
  - left global nav, middle work area, and right inspector are independently scrollable within the shell
  - operational pages should reuse `WorkspaceWorkbench` to keep control surfaces consistent across dataset/training/model lanes

### 3.5 Model Domain
- `/models/explore`
- shared overview layout: hero summary, signal cards, main catalog list, side follow-up actions
- normal catalog views hide internal smoke/verification/demo fixtures and keep only a minimal curated sample set when demo data is required
- admin viewers can delete eligible non-foundation models inline from catalog inventories; curated foundation/base models show a protected badge instead of delete controls
- `/models/my-models`
- shared overview layout with ownership-focused status and next-step actions
- `/models/create` (stepper required)
  - model file upload step may refresh artifact statuses in background, but list updates should stay quiet and only apply when file data actually changes
- `/models/versions`
- shared overview layout with persistent version-registration actions and completed-job follow-up

### 3.6 Dataset Domain
- `/datasets`
  - dataset list + create entry
- `/datasets/:datasetId`
  - dataset detail
  - supports optional `?version=<dataset_version_id>` to preselect active snapshot context
  - top stepper for ingestion/split/version
  - dataset attachments always visible/deletable/status-aware
  - visual sample browser area supports grid/list switch, fast filters, and bulk item operations
  - item browser filters should include at minimum search, split, item status, annotation queue status, and metadata/tag hints
  - dataset detail also surfaces annotation summary cards and direct queue links into annotation workspace (`needs_work`, `in_review`, `rejected`, `approved`)
- `/datasets/:datasetId/annotate`
  - sample review workbench layout (sample + annotation + review context + metadata in one workspace)
  - supports optional `?version=<dataset_version_id>` so dataset-detail snapshot context can stay visible while reviewing queues
  - detection box + OCR text annotation
  - submit-review and approve/reject actions
  - filtered item queues plus persistent latest-review context for rework

### 3.7 Training Domain
- `/training/jobs`
  - job list
  - supports optional dataset/version scope context via query params (`?dataset=<id>&version=<id>`) so dataset-detail snapshot actions can open a filtered operational view
  - initial page load may show blocking loading state, but background refresh must stay non-jumping and only update visible state when job data actually changes
  - manual refresh remains available for operators who want explicit control
- `/training/jobs/new`
  - create training job wizard (stepper required, advanced params collapsed)
  - dataset step binds an explicit dataset-version snapshot, not an implicit latest dataset state
  - selected dataset-version readiness summary stays visible before launch (dataset status, split summary, annotation coverage, train-split availability)
- `/training/jobs/:jobId`
  - detail: status, logs, metrics, scheduler decision snapshot + history timeline

### 3.8 Inference Validation Domain
- `/inference/validate`
  - runtime connectivity diagnostics (PaddleOCR/docTR/YOLO)
  - supports optional dataset/version scope context via query params (`?dataset=<id>&version=<id>`) from dataset-detail snapshot actions
  - upload image
  - choose model version
  - run inference
  - show raw + normalized output
  - feedback-to-dataset action (target dataset task type must match inference run task type)

### 3.9 Settings
- `/settings`
  - single top-level settings surface inside the shared console navigation
  - internal tabs split settings into:
    - `account`
    - `llm`
    - `runtime`
  - `/settings/account` is the default destination so password and account management stay easy to find
  - all authenticated users can change password in the `account` tab
  - administrators also see account provisioning controls, account directory, password reset actions, and disable/reactivate actions in the same `account` tab
  - disabling from the account directory requires an inline reason field before confirm, while reactivation stays lightweight
  - account rows expose at minimum role, status, created timestamp, last login timestamp, and stored disable reason when status is `disabled`
  - `/settings/llm` and `/settings/runtime` remain valid deep links that open the matching tab

### 3.10 Admin
- `/admin/models/pending`
- `/admin/audit`
- `/admin/verification-reports`

## 4. Shared UI Contracts
- route-level page modules should be lazy-loaded by default so non-active workspaces do not block first paint
- `AppShell`: unified global navigation with grouped sections, active-route context, desktop collapse, and mobile drawer behavior
- `LeftSidebarShell`: fixed-height left navigation/sidebar with internal scrolling plus optional collapsible secondary blocks and collapsible console nav groups
- `SessionMenu`: shared account pill/menu used by console and chat surfaces for session-aware settings/logout actions
- `StateBlock`: empty/loading/error/success
- `AttachmentUploader`: visible + deletable + status list
- `StepIndicator`: mandatory for multi-step flows
- `AdvancedSection`: only low-frequency or advanced controls should collapse by default; compatibility-only fallback inputs should stay open when they are the primary available path
- `DatasetItemBrowser`: shared sample browser block for dataset item grids/lists, filters, and batch actions
- `BulkActionBar`: shared batch operation bar for item-level split/status/tag/metadata actions
- `SampleReviewWorkbench`: unified item review layout used by annotation/review-heavy screens
- background refresh must be visibility-aware and should run only while transient states exist (for example `uploading`, `processing`, active jobs, active review queues)
- dense operational inventories (for example dataset items and annotation queues) should prefer fixed-height internal scroll with windowed rendering instead of mounting every row at once

## 5. Page-Level Interaction Contracts

### 5.1 Dataset Detail
- top stepper for `Upload -> Organize -> Version`
- attachment list stays visible
- split/version actions are explicit operations
- visual sample browser supports both scanning and triage actions in-place (not only a static detail list)
- item-level batch actions are available for repetitive curation operations
- annotation summary stays visible in the same page so operators can see ready-for-review, rejected, and approved counts before leaving the dataset
- quick links can open annotation workspace with queue/item context already selected (and carry selected dataset-version context when available)
- version-operation links should be able to open training jobs and inference validation with dataset/version scope context preserved
- initial page load may show blocking loading state, but background refresh must stay quiet and only update visible state when dataset/attachment/item/version data actually changes
- manual refresh remains available so operators can explicitly pull the latest dataset state when needed

### 5.2 Annotation Workspace
- top stepper for `Select Item -> Annotate -> Review`
- sample review workbench keeps sample preview, annotation payload, metadata, and latest review context aligned in one task surface
- item rail supports focused queue filters (`all`, `needs_work`, `in_review`, `rejected`, `approved`) without losing the current selection when background data is unchanged
- latest review detail card stays visible for rejected/rework items so annotators can see why the previous review failed
- when a rejected item is explicitly moved back to `in_progress`, the workspace should keep the same item selected and shift into `needs_work` so rework can continue without losing context
- deep links from dataset detail can preselect queue filter, item id, and optional dataset-version context
- initial page load may show blocking loading state, but background refresh must not keep resetting the current item or canvas when server data has not changed
- manual refresh remains available so annotators can pull the latest review/pre-annotation state on demand

### 5.3 Training Job Creation
- top stepper for `Task -> Data -> Params -> Review`
- dataset selection must be paired with an explicit dataset-version snapshot before submit
- page keeps a visible launch-readiness summary for the selected dataset version (dataset status, split summary, annotation coverage, train-split availability)
- launch action must stay disabled when selected dataset version has `annotation_coverage <= 0` or no train split items
- when runtime strict training fallback guard is off, launch action also requires explicit operator confirmation in the review step before submit
- when runtime strict mode status is unavailable (runtime settings load failure), launch action remains disabled until status is recoverable
- advanced hyperparameters remain collapsed initially

### 5.4 Inference Validation
- reusable uploader and state blocks
- runtime diagnostics panel with refresh action and per-framework status
- output panel displays:
  - model metadata
  - raw output
  - normalized output
- one-click send to dataset feedback
- feedback target selector should only offer datasets with matching `task_type` for the selected run/version
- initial page load may show blocking loading state, but background refresh must stay quiet and only update visible state when versions/datasets/attachments/runs actually change
- runtime diagnostics refresh stays explicit/manual so connectivity cards do not keep jumping during normal validation work

### 5.5 Model Overview Pages
- `/models/explore`, `/models/my-models`, and `/models/versions` use the shared overview layout (`hero -> signals -> main list + side actions`)
- primary inventory stays in the main column; creation or follow-up actions stay visible in the side column
- loading, empty, error, and success states use the same `StateBlock` semantics as dataset and training pages
- when current user is `admin`, model inventory rows also expose inline delete controls for eligible non-foundation models; deletion stays blocked with clear feedback when dependent conversations or model versions still exist

### 5.6 Settings Surface
- `/settings` acts as the single settings entry in the console sidebar
- tab switch stays inside the page so operators can move between `LLM` and `Runtime` without scanning the global navigation again
- tab state remains obvious in the page header, while deep links can still open a specific tab directly

### 5.7 LLM Settings Tab
- uses a shared overview layout with saved-config summary, editable form, and action/troubleshooting side panels
- masked key state remains visible while editing so users can tell whether save/test will reuse the stored key
- save, test, reload, clear, and preset actions stay close to the form without hiding connection advice

### 5.8 Runtime Settings Tab
- runtime connectivity checks for all frameworks and single framework
- integration templates (env vars, request/response payload examples, health-check curl)
- advanced template section collapsed by default
- page keeps diagnostics, execution summary, and template guidance in one shared overview layout
- execution summary also surfaces the latest framework-specific metric keys sampled from recent completed training jobs without requiring a separate detail-page jump
  - admin runtime tab also hosts training-worker control plane blocks:
  - worker registry list (`online/offline/draining`, heartbeat freshness, load score, concurrency)
  - worker scheduler score breakdown view (`scheduler_score`, load component, health penalty, capability bonus, recent dispatch failures/cooldown)
  - guided `Add Worker` onboarding wizard with deployment mode selector (`Docker` recommended / script fallback)
  - `Add Worker` wizard can optionally prefill worker public host / IP and bind port so generated startup commands and `/setup` URL hints are immediately usable on remote nodes
  - pairing-token generation plus downloadable/copyable worker startup templates
  - pending worker onboarding list with validation state (`bootstrap_created`, `pairing`, `validation_failed`, `awaiting_confirmation`, `online`)
  - add/edit/remove worker actions
  - scheduler policy hints (load-aware assignment and fallback conditions)

### 5.9 Admin Verification Reports
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
- visual-data-loop evolution track (reference: `docs/visual-data-loop-evolution.md`) incrementally upgrades dataset browser/review/version workflows without replacing chat-first IA.
