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
  - action cards may deep-link to `/vision/tasks/:taskId` when the backend creates or updates a structured `VisionTask`
  - completed or failed action cards may surface `Suggested next steps`; navigation links open the correct page, while executable next steps still go back through the guarded in-thread `/ops` path

### 3.4 Professional Console
- `/workspace/console`
  - shared app shell route (global left navigation + top context header), not chat-immersive layout
  - visual language should stay aligned with `notion/DESIGN.md`: warm white canvas, subtle neutral section contrast, whisper-weight borders, restrained card elevation, and one consistent blue interaction accent
  - every engineering-console page must follow the `single primary job per page` rule:
    - one page owns one core operator task only
    - other task domains may appear only as summary context or navigation links
    - do not embed a second full workflow module just because it is adjacent
  - console home should stay routing-focused: one priority queue + dedicated lane links, no embedded multi-workflow execution modules
  - professional workbench pages use a stable three-zone structure:
    - top context toolbar (`WorkspaceContextBar`) for search/filter/batch actions
    - middle main work area for operational lists/canvas/tables
    - right inspector panel for selected-object details and primary follow-up actions
  - domain-specific pages may vary information density, but should not introduce separate visual systems that break the shared Notion-inspired shell
  - left global nav, middle work area, and right inspector are independently scrollable within the shell
  - operational pages should reuse `WorkspaceWorkbench` to keep control surfaces consistent across dataset/training/model lanes
  - rollout update (2026-04): for high-frequency console routes, heavy onboarding cards are replaced with a compact single-task hint block to reduce first-screen noise while keeping clear next-action links

### 3.4.1 Single-Task Hint Rollout (2026-04)
- migrated routes:
  - `/workspace/console`
  - `/models/explore`
  - `/models/my-models`
  - `/models/create`
  - `/settings/account`
  - `/settings/llm`
  - `/settings/runtime`
  - `/settings/workers`
  - `/datasets`
  - `/training/jobs`
  - `/training/jobs/new`
  - `/training/jobs/:jobId`
  - `/models/versions`
  - `/inference/validate`
  - `/admin/models/pending`
  - `/admin/audit`
  - `/admin/verification-reports`
- interaction contract:
  - keep one primary action per page header
  - replace duplicated onboarding/next-step cards with one compact in-page hint block
  - keep cross-domain actions as links to dedicated pages, not embedded modules

### 3.5 Model Domain
- `/models/explore`
- shared overview layout: hero summary, signal cards, main catalog list, side follow-up actions
- page-level onboarding card should explain how to scan the shared catalog, recognize approved vs risky models, and continue into owned models or version work
- normal catalog views hide internal smoke/verification/demo fixtures and keep only a minimal curated sample set when demo data is required
- admin viewers can delete eligible non-foundation models inline from catalog inventories; curated foundation/base models show a protected badge instead of delete controls
- `/models/my-models`
- shared overview layout with ownership-focused status and next-step actions
- page-level onboarding card should explain how drafts, pending approvals, and ready models move through the ownership lane
- `/models/create` (stepper required)
- page-level onboarding card should explain `metadata -> artifact -> parameters -> approval submission` so first-time users understand the model draft flow
  - model file upload step may refresh artifact statuses in background, but list updates should stay quiet and only apply when file data actually changes
- `/models/versions`
- shared overview layout with persistent version-registration actions and completed-job follow-up
- page-level onboarding card should explain how to move from completed training evidence to version registration and lineage inspection follow-up
- the main workspace and version-inventory empty/selection-empty states should also mirror the first incomplete versioning step with one explicit next-action card
- completed training detail pages can deep-link here with a prefilled job so registration starts from the finished run, while model selection still stays explicit
- when a completed job has no owned model matching its task type, the registration surface should surface a direct model-draft creation path prefilled to that task type instead of silently defaulting to an unrelated model
- model-draft creation opened from a completed run should keep the version-registration handoff visible so the operator can return with the same job context

### 3.6 Dataset Domain
- `/datasets`
  - dataset list + create entry
  - page-level onboarding card should explain this page is the "data preparation entry" and point users to dataset detail as the next lane
  - onboarding should surface minimal real-state completion signals (`has_dataset`, `has_ready_dataset`) and "what to click next"
  - the main workspace and empty state should also mirror the first incomplete dataset-prep step with one explicit starter task, including a direct jump into the inline create panel when no dataset exists yet
- `/datasets/:datasetId`
  - dataset detail
  - supports optional `?version=<dataset_version_id>` to preselect active snapshot context
  - page-level onboarding card should explain how to move from upload/split/version into annotation and training actions
  - onboarding should reflect real progress from attachments, annotation updates, and version snapshots
  - the main workspace should also mirror the first incomplete detail-step with one explicit next-action card so operators can keep moving without re-reading the full page
  - top stepper for ingestion/split/version
  - dataset attachments always visible/deletable/status-aware
  - visual sample browser area supports grid/list switch, fast filters, and bulk item operations
  - item browser filters should include at minimum search, split, item status, annotation queue status, and metadata/tag hints
  - dataset detail also surfaces annotation summary cards and direct queue links into annotation workspace (`needs_work`, `in_review`, `rejected`, `approved`)
- `/datasets/:datasetId/annotate`
  - single-sample annotation workbench layout with one current sample as the only first-screen primary task
  - supports optional `?version=<dataset_version_id>` so dataset-detail snapshot context can stay visible while reviewing queues
  - this route is an exception to the heavier onboarding-card pattern: first screen should stay operational, while deeper guidance moves into shortcut help / secondary entry points
  - default page structure should stay focused:
    - lightweight top header with `back to dataset`, dataset/version/sample identity, queue position, previous/next, full-screen, and shortcut help
    - center split work area with canvas as the dominant visual surface
    - right inspector with exactly three tabs: `annotation`, `prediction compare`, `sample info`
    - fixed bottom action bar with `undo`, `redo`, `save in progress`, `submit review`, `previous`, `next`
  - queue filtering belongs to dataset detail / sample browser; annotation page should only keep current queue position plus previous/next sample navigation
  - review controls should not occupy first screen unless the current sample status is `in_review`
  - prediction compare, low-confidence context, and pre-annotation actions must stay behind the right-side secondary tabs or overflow actions
  - OCR editing should prioritize the simplest action first:
    - line text input + add action stay visible
    - optional controls such as confidence and region binding should be demoted behind a compact disclosure
  - new-region labeling should minimize clicks: after creating a new region, class selection should surface immediately
  - the current-sample summary should absorb the latest review conclusion (status / reason / comment) so annotators do not need to compare two separate cards for the same sample
  - secondary context (for example shortcut sheets, review-session history, low-confidence radar, and workspace return points) should be collapsed or demoted by default so first-time users are not forced to parse every tool at once
  - shared app navigation should auto-collapse on this route to maximize canvas width, while still allowing manual re-expand
  - user-facing copy in this workspace should avoid raw enum/status ids where a plain-language label is available
  - detection box + OCR text annotation
  - submit-review and approve/reject actions
  - filtered item queues plus persistent latest-review context for rework

### 3.7 Training Domain
- `/training/jobs`
  - job list
  - supports optional dataset/version scope context via query params (`?dataset=<id>&version=<id>`) so dataset-detail snapshot actions can open a filtered operational view
  - page-level onboarding card should explain queue semantics (`active` vs `terminal`) and next actions (`new run`, `detail`)
  - the main workspace and empty states should mirror the first incomplete training-control step with one explicit next-action card
  - initial page load may show blocking loading state, but background refresh must stay non-jumping and only update visible state when job data actually changes
  - manual refresh remains available for operators who want explicit control
- `/training/jobs/new`
  - default surface is an agent-style launcher, not a dense wizard:
    - one natural-language goal input
    - one dataset / dataset-version snapshot selection
    - one compact progress indicator (`goal -> snapshot -> launch`)
    - when goal text is present or the page is opened from a `VisionTask`, Smart Launch should keep or create that task context so the launched run stays attached to the same orchestration lane
  - dataset selection still binds an explicit dataset-version snapshot, not an implicit latest dataset state
  - selected dataset-version readiness summary stays visible before launch (dataset status, split summary, annotation coverage, train-split availability)
  - task/framework/base-model/core-param choices should be auto-derived when possible and only exposed for manual override inside collapsed expert controls
  - onboarding card should frame this page as "tell the agent what to train, confirm the snapshot, then launch"
  - the main workspace should mirror the first incomplete training-setup step with one explicit next-action card, and blocked states should point back to dataset detail or runtime settings when relevant instead of expanding more configuration by default
- `/training/jobs/:jobId`
  - detail: status, logs, metrics, and artifact readiness for one run
  - scheduler history, raw fallback reasons, and technical identifiers should stay in advanced disclosure by default
  - first screen should prioritize evidence inspection (status/logs/metrics/artifacts), while cross-domain next steps stay as lightweight links
  - detail should expose a direct `Open cockpit` continuation into the dedicated visualization surface
  - when the run is linked to a `VisionTask`, the first-screen next-step area should prefer one direct `Continue as agent` action over a menu of separate manual sub-tools
  - completed runs should expose a direct version-registration handoff into `/models/versions` with the job context prefilled
  - when no owned model matches the completed job's task type, the detail page should also expose a direct model-draft creation path prefilled to that task type
- `/training/jobs/:jobId/cockpit`
  - dedicated training cockpit for one run
  - accessible from both training list and training detail without removing the existing detail page responsibilities
  - should be treated as a secondary expert visualization surface rather than the primary training entry
  - keeps one professional telemetry layout: top run summary, cinematic training scene, stage flow rail, metric/resource center, auto-tuning panel, and event stream
  - the cinematic training scene should feel like one restrained 3D execution theater rather than a dashboard banner:
    - left dataset structure is rendered as a thumbnail album / sample gallery, with a visibly active mini-batch being selected from the gallery
    - dataset-side file/count signal should visibly decrease as training advances, while still honoring `derived` semantics when live file counts are unavailable
    - center interaction lane should read as real training logic: sampled batch -> augmentation / normalization -> forward pass toward the model core
    - right model structure should render pulsing/vector-like parameter particles so optimization looks active, not static
    - scene footer should carry compact parameter/metric curves that stay synchronized with the current run snapshot
    - the scene should read through one dominant cinematic path, not many separate animated widgets; inactive regions should remain mostly steady so the operator always knows where to look
    - overall styling should feel like a premium film-style control console: dark, sharp, minimal, and technical, with motion reserved for the live training path and convergence signals
  - supports mode switch between `live` and `demo`
  - `demo` mode must expose playback controls (`play`, `pause`, `replay`, `1x/2x/4x`)
  - playback state should stay readable in-page (`playing`, `paused`, `finished`) so demo sessions never look frozen by accident
  - `live` mode should prefer real backend data, while missing tuning/resource feeds stay clearly marked as unavailable or derived instead of pretending to be persisted truth
  - current degradation messaging should stay inside the same page instead of auto-forcing demo mode when only part of the telemetry surface is missing
  - all cockpit user-visible copy should resolve through the shared i18n layer, including stage labels, trial statuses, empty states, and demo/live helper text
  - on narrower screens the cockpit should reflow in one stable order: cinematic scene, summary, stage flow, metrics, resources, auto tuning, event stream

### 3.7A Vision Orchestration Domain
- `/vision/tasks`
  - list of visible vision-task records for the current owner/admin scope
  - first screen should answer only three questions:
    - which task is blocked by missing requirements
    - which task is currently training
    - which task is ready for the next operator action
  - filters should stay lightweight (`status` first); row click opens detail; one explicit `Continue as agent` control may call task auto-advance, but it must remain a visible operator action rather than an always-on background mutation
  - every visible task row/card should surface:
    - current recommendation title
    - one-line rationale
    - linked entities needed to continue (`dataset`, `training job`, `model version`)
- `/vision/tasks/:taskId`
  - dedicated continuation page for one structured vision-task record
  - top of page should keep:
    - prompt summary
    - current status
    - primary metric snapshot
    - next recommended action
    - recommendation rationale / evidence
    - evaluation suite
    - promotion gate status
    - run comparison decision
  - the main page action should read as one agent continuation control first; manual training / registration / feedback operations are secondary escape hatches
  - task detail should also show a compact agent decision history so engineers can understand why the system moved from train -> wait -> register -> feedback
  - task detail should include one explicit evidence section explaining:
    - which evaluation suite / threshold the agent is using
    - why the best run is currently considered best
    - who is champion and who is challenger
    - whether the result is strong enough to promote now
    - whether the safer next move is train again or collect more data
  - main sections should expose structured understanding, dataset inspection, training plan, auto-tune history, validation report, and missing requirements without forcing the engineer back into the chat thread
  - quick actions can open linked dataset, training job, model version, or feedback dataset directly, but those linked domains still own their own primary workflows

### 3.8 Inference Validation Domain
- `/inference/validate`
- runtime readiness summary only (reachable / unreachable / not configured) with link to `/settings/runtime` for full diagnostics/configuration
- supports optional dataset/version scope context via query params (`?dataset=<id>&version=<id>`) from dataset-detail snapshot actions
- also accepts direct model-version prefill via `?modelVersion=<id>` for validation links coming from chat or other action cards
- onboarding card should explain the validation-to-feedback loop in plain language and keep follow-up links to scoped dataset/annotation lanes visible
- the main workspace and key empty states (`No Model Versions Yet`, `No Ready Inputs Yet`, `No Runs Yet`) should mirror the first incomplete validation step with one explicit next-action card
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
    - `runtime_templates`
    - `workers`
  - `/settings/account` is the default destination so password and account management stay easy to find
  - `/settings/account` should include a first-run onboarding card that explains `confirm identity -> rotate password -> (admin) directory governance -> continue to LLM/runtime`
  - the main workspace should also mirror the first incomplete account-setup step with one explicit next-action card, and admin directory empty/filter-empty states should reuse the same guidance where relevant
  - all authenticated users can change password in the `account` tab
  - administrators also see account provisioning controls, account directory, password reset actions, and disable/reactivate actions in the same `account` tab
  - disabling from the account directory requires an inline reason field before confirm, while reactivation stays lightweight
  - account rows expose at minimum role, status, created timestamp, last login timestamp, and stored disable reason when status is `disabled`
  - `/settings/llm`, `/settings/runtime`, `/settings/runtime/templates`, and `/settings/workers` remain valid deep links that open the matching tab
  - `/settings/llm` should include a first-run onboarding card that explains `preset -> key -> enable -> test -> continue to chat`
  - the main workspace and key blocked states on `/settings/llm` should mirror the first incomplete LLM-setup step with one explicit next-action card
- `/settings/runtime` should include a first-run onboarding card that explains "configure frameworks -> activate profile -> verify readiness -> continue to validation" with real status signals
- the main workspace and readiness/configuration empty states on `/settings/runtime` should mirror the first incomplete runtime-setup step with one explicit next-action card
- `/settings/runtime` must stay focused on runtime configuration + readiness checks only; connection snippets/examples should link out to `/settings/runtime/templates` instead of being embedded as another full module
- `/settings/runtime` should act as the runtime operations sample page for the compact console pattern:
  - compact page header with one primary action: `Run readiness check`
  - compact KPI row limited to:
    - reachable frameworks
    - unconfigured frameworks
    - active profile
    - open issues
  - onboarding / bootstrap / manual-confirmation guidance should merge into one checklist:
    - expanded while setup is incomplete
    - collapsed into one status strip after setup becomes healthy
  - framework inventory should be table-first with columns:
    - framework
    - status
    - endpoint
    - API key
    - last checked
    - actions
  - right inspector should keep only one compact "next runtime step" card by default; duplicated runtime/worker summary cards should be removed from first screen
  - runtime readiness should default to a summary panel:
    - errors
    - warnings
    - suggestions
    - current runtime mode
  - raw issue codes, remediation commands, callback payloads, and internal diagnostics should stay behind an advanced disclosure or drawer
- `/settings/runtime` should make the two runtime connection paths explicit for beginners:
  - `local mode`: run through local command / bundled runner on this machine, keep endpoint blank, and do not ask for API key unless user switches away from local mode
  - `endpoint mode`: call a remote runtime endpoint, keep endpoint visible, and show API key only as optional endpoint auth
- `/settings/runtime` should present the first-run setup as explicit path choices before exposing raw maintenance knobs:
  - `local quick setup`: recommended single-machine path with the fewest required decisions
  - `profile activation`: for environments where deployment/runtime profiles are already prepared
  - `custom framework setup`: for operators who need to edit per-framework mode/endpoint/auth manually
- `/settings/runtime` should expose a one-click "prepare local-only draft" action so new users can convert all frameworks to local-first configuration without manually clearing endpoint/auth fields
- `/settings/runtime` should also expose a one-click "apply local quick setup" action that saves local-only draft + current runtime controls in one step before readiness checks
- low-frequency runtime controls should be collapsed behind `AdvancedSection` by default, including:
  - overwrite auto-config / clear settings maintenance actions
  - strict fallback controls
  - raw local command overrides
  - model/model-version-specific endpoint auth routing
- `/settings/runtime/templates` should be the single runtime connection-template page:
  - purpose: copyable env vars, health-check curl, and request/response schema examples
  - should not include runtime readiness state machine, worker lifecycle controls, or runtime profile activation
  - runtime page can provide only navigation entry + brief summary to this page
- `/settings/workers` should be the single worker-operations page:
  - compact page header with one primary action: `Add Worker`
  - compact KPI row focused on worker capacity (`online`, `draining`, `offline`, `pending pairing`)
  - worker inventory should be table-first with row detail in a drawer
  - add/edit/remove/enable/draining actions stay on worker page only
  - worker pairing/bootstrap sessions (token, setup URL, callback validation, activation) stay on worker page only
  - runtime page should keep only navigation entry to worker page (no embedded worker lifecycle module and no worker-capacity KPI in runtime KPI row)

### 3.10 Admin
- `/admin/models/pending`
- queue-first review page: list/table for pending requests + decision drawer; adjacent admin lanes are links only
- `/admin/audit`
- page-level onboarding card should explain how to read governance records, distinguish user vs system actions, and jump back to adjacent admin lanes
- `/admin/verification-reports`
- page-level onboarding card should explain one focused task on this page: filter, review, and export deployment verification evidence for release governance

## 4. Shared UI Contracts
- route-level page modules should be lazy-loaded by default so non-active workspaces do not block first paint
- `AppShell`: unified global navigation with grouped sections, active-route context, desktop collapse, and mobile drawer behavior
- `LeftSidebarShell`: fixed-height left navigation/sidebar with internal scrolling plus optional collapsible secondary blocks and collapsible console nav groups
- `SessionMenu`: shared account pill/menu used by console and chat surfaces for session-aware settings/logout actions
- `StateBlock`: empty/loading/error/success
- `AttachmentUploader`: visible + deletable + status list
- `StepIndicator`: mandatory for multi-step flows
- `AdvancedSection`: only low-frequency or advanced controls should collapse by default; compatibility-only fallback inputs should stay open when they are the primary available path
- page-level onboarding cards should share the same hide/reopen behavior and persist local dismiss state per route
- page-level onboarding cards should also feed a shared current-page help entry (fixed top-right button + lightweight hint panel) so inline guide dismissal never removes access to help
- when inline onboarding remains visible, it should avoid repeating the full step checklist by default; operators can expand the checklist only when they need the detailed refresher
- `DatasetItemBrowser`: shared sample browser block for dataset item grids/lists, filters, and batch actions
- `BulkActionBar`: shared batch operation bar for item-level split/status/tag/metadata actions
- `SampleReviewWorkbench`: unified item review layout used by annotation/review-heavy screens
- engineering-console pages should converge on a compact page toolkit:
  - `PageHeader`: compact title + one-sentence purpose + single primary action
  - `KPIStatRow`: compact 3-5 stat row for current-page summary only
  - `FilterToolbar`: search/filter/refresh strip with wrapped controls
  - `StatusTable`: table-first inventory for jobs/models/datasets/audit/report/worker lists
  - `HealthSummaryPanel`: compact readiness / warning / suggestion summary without raw diagnostics by default
  - `SectionCard`: thin content section wrapper for non-tabular content
  - `InlineAlert`: short in-flow success/warning/error notice without oversized state blocks
  - `DetailDrawer`: row-selected secondary detail surface for lists and logs
  - `ActionBar`: primary / secondary / tertiary action grouping
  - `ConfirmDangerDialog`: explicit confirmation for delete / disable / clear / revoke flows
- background refresh must be visibility-aware and should run only while transient states exist (for example `uploading`, `processing`, active jobs, active review queues)
- dense operational inventories (for example dataset items and annotation queues) should prefer fixed-height internal scroll with windowed rendering instead of mounting every row at once

## 4.1 Console Page Templates
- list page:
  - `PageHeader -> KPIStatRow -> FilterToolbar -> StatusTable -> optional DetailDrawer`
  - avoid stacked record cards when rows need comparison, filtering, or sorting
- detail page:
  - `PageHeader -> context summary -> tabs -> compact side metadata`
  - heavy follow-up workflows should be linked out, not embedded inline
- settings page:
  - `PageHeader -> HealthSummaryPanel -> config form -> advanced section`
  - diagnostics and raw maintenance details stay collapsed or in drawer by default
- audit/log page:
  - `PageHeader -> FilterToolbar -> StatusTable -> raw-detail drawer`
  - raw payloads and technical keys should be hidden until explicitly opened
- validation/result page:
  - `PageHeader -> input panel -> result panel -> feedback action area`
  - runtime/data/training issues should surface as short summaries with links to the correct page

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
- primary call-to-action areas should stay visible without requiring users to scan review-session analytics, shortcut references, or return-point controls first
- review-session history, low-confidence triage helpers, and other power-user tools should stay available but remain secondary to the active sample/review task
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

### 5.3A Vision Modeling Task
- list page should keep filters and actions lightweight enough for operators to decide in seconds whether to open detail or press `Auto advance`
- detail page should always keep one visible "next step" summary above the raw structured panels
- quick actions may launch training, continue the next round, register a model version, or mine badcases, but they must remain contextual to the task's current state
- when task detail opens inference validation from an active-learning candidate, the validation page should preserve task context and make the return path obvious instead of behaving like a detached validation workspace
- structured JSON panels are acceptable in the MVP, but the surrounding page chrome must still make the workflow understandable without reading raw payload keys first
- task detail must remain a bridge page, not a second full implementation of dataset/training/model workflows

### 5.4 Inference Validation
- reusable uploader and state blocks
- runtime lane keeps a compact read-only summary only (reachable/unreachable/not-configured counts)
- full runtime diagnostics/configuration actions must stay in `/settings/runtime` and be reached via explicit navigation
- output panel displays:
  - model metadata
  - raw output
  - normalized output
- one-click send to dataset feedback
- feedback target selector should only offer datasets with matching `task_type` for the selected run/version
- initial page load may show blocking loading state, but background refresh must stay quiet and only update visible state when versions/datasets/attachments/runs actually change

### 5.5 Model Overview Pages
- `/models/explore`, `/models/my-models`, and `/models/versions` use the shared overview layout (`hero -> signals -> main list + side actions`)
- primary inventory stays in the main column; creation or follow-up actions stay visible in the side column
- loading, empty, error, and success states use the same `StateBlock` semantics as dataset and training pages
- when current user is `admin`, model inventory rows also expose inline delete controls for eligible non-foundation models; deletion stays blocked with clear feedback when dependent conversations or model versions still exist

### 5.6 Settings Surface
- `/settings` acts as the single settings entry in the console sidebar
- tab switch stays inside the page so operators can move between `LLM`, `Runtime`, `Runtime Templates`, and `Workers` without scanning the global navigation again
- tab state remains obvious in the page header, while deep links can still open a specific tab directly
- `Account` tab should provide beginner guidance for both regular users and admins, with role-aware steps and direct links to the next setup tabs
- settings entry card should surface a compact runtime quick-start snapshot (`progress`, `next action`, `local-only active or endpoint count`) so users can understand runtime setup status before opening the runtime tab

### 5.7 LLM Settings Tab
- uses a shared overview layout with saved-config summary, editable form, and action/troubleshooting side panels
- masked key state remains visible while editing so users can tell whether save/test will reuse the stored key
- save, test, reload, clear, and preset actions stay close to the form without hiding connection advice
- tab-level onboarding card should guide beginner setup order and compute completion from saved config + connection test status

### 5.8 Runtime Settings Tab
- runtime connectivity checks for all frameworks and single framework
- this tab is for runtime configuration + readiness only; connection templates must be linked out to `/settings/runtime/templates`
- page keeps diagnostics and runtime execution summary in one shared overview layout, without embedding full snippet/template modules
- execution summary also surfaces the latest framework-specific metric keys sampled from recent completed training jobs without requiring a separate detail-page jump
- tab-level onboarding card should show beginner actions in order and read completion state from real runtime/profile/readiness records
- each framework card should expose an explicit connection mode switch (`local` / `endpoint`) instead of mixing both mental models in a single undifferentiated form
- each framework card should expose model-aware controls:
  - default model + optional default model-version selectors should include both curated foundation baselines and eligible published/registered versions
  - endpoint mode should support model-level auth key bindings (`model:*`, `model_version:*`) in addition to framework-level API key
- when framework card is in `local` mode:
  - endpoint input should be hidden or strongly de-emphasized
  - API key input should stay hidden because it is not needed for local execution
  - local command/model path guidance should become the primary visible explanation
- when framework card is in `endpoint` mode:
  - endpoint input stays primary
  - API key input remains optional and is described only as remote endpoint auth
- the tab should provide a compact single-machine quick-start path before advanced worker/distributed controls so zero-knowledge operators can reach a usable local setup first
- that quick-start path should include explicit actions in order: `prepare local-only draft -> apply local quick setup -> run readiness checks`
- onboarding completion logic should treat a saved local-only configuration as a valid "configured framework baseline" even when no external endpoint is configured
- the quick-start block should display step-level progress/completion signals and only one recommended next action at a time, then offer direct jump to inference validation after completion

### 5.8.1 Runtime Templates Tab
- dedicated snippet page for runtime endpoint integration
- contains copyable env variable names, health-check curl samples, and request/response payload examples
- does not include runtime profile activation, readiness state machine, or worker lifecycle operations
- links back to Runtime Settings for actual runtime configuration and readiness checks

### 5.9 Worker Settings Tab
- worker inventory is table-first with row-level detail drawer
- worker onboarding/pairing is handled here (not in runtime tab): setup URL, token, callback validation, activation
- worker mutate actions stay here: add/edit/remove, enable/disable, draining/resume, reconfigure
- this tab should keep one clear primary action (`Add Worker`) while other operations stay secondary/tertiary

### 5.10 Admin Verification Reports
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
