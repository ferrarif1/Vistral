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
  - Dual work entry:
    - AI-native conversation workspace
    - professional console

### 3.3 Conversation Workspace
- `/workspace/chat`
  - dedicated immersive chat shell (chat-style left sidebar + centered timeline + floating composer)
  - top header stays lightweight: language switch remains visible, while desktop account actions move to the sidebar footer / compact rail avatar; compact or mobile header can still expose auth entry as a fallback
  - model selector shows the curated foundation/base model catalog used for future training and normal chat entry
  - sidebar uses server-backed conversation history with sync + click-to-restore conversation detail
  - desktop sidebar keeps a fixed viewport height and uses internal scroll regions instead of stretching with the page
  - desktop sidebar supports collapse/expand so the conversation canvas can switch between focused and browsing modes
  - mobile sidebar behaves as a temporary drawer opened from the header and dismissed by overlay tap or close action
  - sidebar history is grouped by recency buckets (Pinned/Today/Yesterday/Previous 7 Days/Older)
  - pinned chats support drag-to-reorder inside the pinned group
  - conversation item context menu supports open/rename/pin/delete quick actions (right-click on desktop, long-press on mobile)
  - context menu supports keyboard navigation (`ArrowUp/ArrowDown`, `Enter`, `Esc`) and quick keys (`O/R/P/D`)
  - mobile long-press uses lightweight haptic feedback when browser vibration API is available
  - sidebar supports local hide/clear controls with explicit "show hidden" recovery
  - sidebar secondary blocks (for example quick links or workspace preferences) can be collapsed independently to reduce clutter
  - on-demand attachment tray inside composer context
  - current-draft attachments surface as chips while composing and collapse after send
  - attachment tray background refresh stays quiet and only updates visible draft/file state when attachment data actually changes
  - assistant messages can render compact operation cards for real backend actions (`create_dataset`, `create_model_draft`, `create_training_job`)
  - when operation input is incomplete, conversation stays in the same thread and requests only the missing fields needed to continue

### 3.4 Professional Console
- `/workspace/console`
  - operational snapshots and quick links
  - uses the shared `AppShell` navigation with grouped sections for workspaces, build/run flows, governance, and settings
  - desktop sidebar keeps a fixed viewport height; navigation scrolls internally so long menus do not push content off-screen
  - desktop navigation groups can collapse independently so operators can hide lower-priority menus without losing route context
  - desktop sidebar supports collapse/expand into a compact rail so operators can widen content-heavy pages
  - desktop account actions use the same sidebar footer / compact rail menu as chat so settings and logout stay anchored in one predictable place
  - mobile navigation uses a temporary drawer opened from the header and dismissed by overlay tap or close action

### 3.5 Model Domain
- `/models/explore`
- shared overview layout: hero summary, signal cards, main catalog list, side follow-up actions
- normal catalog views hide internal smoke/verification/demo fixtures and keep only a minimal curated sample set when demo data is required
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
  - top stepper for ingestion/split/version
  - dataset attachments always visible/deletable/status-aware
- `/datasets/:datasetId/annotate`
  - minimal annotation workspace
  - detection box + OCR text annotation
  - submit-review and approve/reject actions

### 3.7 Training Domain
- `/training/jobs`
  - job list
  - initial page load may show blocking loading state, but background refresh must stay non-jumping and only update visible state when job data actually changes
  - manual refresh remains available for operators who want explicit control
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
- `AppShell`: unified global navigation with grouped sections, active-route context, desktop collapse, and mobile drawer behavior
- `LeftSidebarShell`: fixed-height left navigation/sidebar with internal scrolling plus optional collapsible secondary blocks and collapsible console nav groups
- `SessionMenu`: shared account pill/menu used by console and chat surfaces for session-aware settings/logout actions
- `StateBlock`: empty/loading/error/success
- `AttachmentUploader`: visible + deletable + status list
- `StepIndicator`: mandatory for multi-step flows
- `AdvancedSection`: advanced params collapsed by default

## 5. Page-Level Interaction Contracts

### 5.1 Dataset Detail
- top stepper for `Upload -> Organize -> Version`
- attachment list stays visible
- split/version actions are explicit operations
- initial page load may show blocking loading state, but background refresh must stay quiet and only update visible state when dataset/attachment/item/version data actually changes
- manual refresh remains available so operators can explicitly pull the latest dataset state when needed

### 5.2 Annotation Workspace
- top stepper for `Select Item -> Annotate -> Review`
- initial page load may show blocking loading state, but background refresh must not keep resetting the current item or canvas when server data has not changed
- manual refresh remains available so annotators can pull the latest review/pre-annotation state on demand

### 5.3 Training Job Creation
- top stepper for `Task -> Data -> Params -> Review`
- advanced hyperparameters remain collapsed initially

### 5.4 Inference Validation
- reusable uploader and state blocks
- runtime diagnostics panel with refresh action and per-framework status
- output panel displays:
  - model metadata
  - raw output
  - normalized output
- one-click send to dataset feedback
- initial page load may show blocking loading state, but background refresh must stay quiet and only update visible state when versions/datasets/attachments/runs actually change
- runtime diagnostics refresh stays explicit/manual so connectivity cards do not keep jumping during normal validation work

### 5.5 Model Overview Pages
- `/models/explore`, `/models/my-models`, and `/models/versions` use the shared overview layout (`hero -> signals -> main list + side actions`)
- primary inventory stays in the main column; creation or follow-up actions stay visible in the side column
- loading, empty, error, and success states use the same `StateBlock` semantics as dataset and training pages

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
