# User Flows

## 1. Overview
This document defines executable flows for Vistral's AI-native conversation entry and professional engineering loop.

## 2. Flow A: Conversation + Attachment Loop (implemented)
Actor: `user`

1. open `/workspace/chat`
2. choose a model from the curated foundation catalog and optionally start a new chat session from sidebar
3. open the account menu from the sidebar footer / compact rail avatar to access language switch plus settings/logout (compact/mobile layouts may still expose auth entry in the header when needed)
4. optionally collapse the desktop sidebar for a wider canvas, or open/close the mobile sidebar drawer from the header
5. click `+` to open the composer attachment tray, then upload or pick attachments for the current draft
6. selected draft attachments appear as chips with status + remove controls beside the composer
7. send message
8. system starts conversation and returns assistant reply (mock/configured LLM, or runtime-backed `run_model_inference` result when attachment + inference intent are detected)
9. attachment tray collapses after send; sent attachments remain traceable in the corresponding message turn
10. sidebar conversation history can be synced from backend and opened to restore full message timeline
11. on desktop, hovering a history row reveals a compact overflow button; clicking it, right-clicking, or mobile long-press opens the quick menu
12. quick menu keeps rename/pin/delete actions out of the default row layout, while opening the chat stays on row click
13. when context menu is open, keyboard shortcuts `R/P/D` execute corresponding actions quickly
14. user can drag within pinned group to reorder priority chats
15. user continues messaging with attachments in context

Guest/access branch:
1. unauthenticated user opens a login-required surface
2. system offers login entry only
3. if the user needs a new account, they must ask an administrator to provision it

Operational branch inside the same flow:
1. user asks the assistant to perform a real setup action (for example create dataset / create model draft / create training job / run model inference on attached files)
2. system parses intent and available fields from current turn plus pending conversation action context
2a. when a message contains explicit setup/training intent plus OCR-ish keywords (for example plate/serial/number), the setup/training lane wins; the request must not be rerouted into OCR extraction post-processing by keyword overlap alone
2b. OCR extraction from a latest inference result is treated as a follow-up-only action; when the current turn includes new attachments, the system must first interpret the request against those current attachments
2c. when a saved LLM configuration is enabled, the system may first build a goal-oriented execution plan:
    - decide whether the user really wants a question answered, a single console action, or a broader closed-loop workflow continuation
    - choose the least-user-operation lane
    - call one or more related backend actions in sequence when that reduces user work without bypassing the same confirmation/safety gates
3. if critical fields are missing, assistant responds with a compact `requires_input` card that lists missing fields and optional suggestions
3a. for complex operational intents (for example annotation/review/training/inference scopes), the same `requires_input` card can include direct navigation links so users can jump to the relevant workspace and fetch required ids/inputs
4. once required fields are complete for high-risk mutations (create dataset/model/training job), assistant asks for explicit confirmation (`确认执行` / `confirm execute`)
5. user confirms execution in follow-up turn
6. system calls the corresponding backend API only after confirmation is received
7. assistant returns a `completed` or `failed` action card with created entity summary and next-step guidance
7a. when a request needs structured vision-task understanding before or alongside training orchestration, assistant may create/update a `VisionTask` and return its deep link as the primary continuation surface
8. for power users / agentic bridge, user can use `/ops {json}`; for normal users, natural-language intents can also be mapped to the same bridge APIs automatically; high-risk calls still require confirmation before mutation
8a. when `/ops {json}` or natural-language bridge intent has missing required parameters, assistant must return `requires_input` with explicit missing fields and allow the user to continue by supplying only those fields in follow-up turns
8b. runtime setup operations can also run from bridge (`activate_runtime_profile`, `auto_configure_runtime_settings`); both remain behind explicit high-risk confirmation
8c. conversation action cards may surface a derived "suggested next step" for training-job failures or incomplete operations; clicking an executable suggestion sends the equivalent bridge action in-thread, and mutating actions such as `retry_training_job` still pause at the same explicit confirmation gate before execution
8d. the bridge may also use a goal-orchestration lane that creates/updates a `VisionTask` first and then auto-calls follow-up actions such as `auto_advance_vision_task` when enough information is available; missing business requirements and mutating follow-up confirmation still remain in-thread

Attachment states:
- `uploading`
- `processing`
- `ready`
- `error`

## 2.1 Flow A1: Shared Navigation Shell (implemented)
Actor: `user` / `admin`

1. open any shared-shell route (for example `/datasets`, `/training/jobs`, `/models/explore`)
2. use the grouped left sidebar to jump between workspaces, build/run flows, governance pages, and the single top-level settings entry
3. desktop left sidebars keep a fixed viewport height, while nav/content blocks scroll internally instead of stretching the page shell
4. optionally collapse lower-priority desktop navigation groups to keep the left panel focused on the current work lane
5. optionally collapse the desktop sidebar into a compact rail when the page needs more horizontal room
6. on mobile, open the navigation drawer from the header and dismiss it by tapping the overlay or close action
7. on desktop, open the shared account menu from the sidebar footer or compact rail avatar to reach settings or logout without leaving the current work lane; compact/mobile layouts may still use the header as fallback
8. continue the current task without losing active route context or footer controls such as language/session status

Note:
- `/workspace/console` now stays in the shared app shell and uses a professional workbench layout (`context toolbar + main work area + right inspector`) with partitioned scrolling.

## 2.2 Flow A2: Settings Surface (implemented)
Actor: `user` / `admin`

1. open `/settings` from the single settings item in the console sidebar
2. land on the default `Account` tab, with the active sub-tab visible inside the page header
3. all authenticated users can change password by entering current password plus a new password
4. administrators can also create accounts from the same `Account` tab and choose the new account role
5. administrators can review the account directory, inspect role/status/last-login fields, and filter the list before acting
6. administrators can reset another user's password directly from the directory
7. disabling an account requires an explicit reason entered inline in the directory before confirmation
8. disabled rows continue to show the stored disable reason for later review, and the same reason is written into audit metadata
9. administrators can reactivate an account directly from the directory; reactivation clears the stored disable reason
10. disabling an account immediately terminates that account's active sessions, so the disabled user must log in again after reactivation
11. safety guards block disabling the current admin session or the last active admin account
12. switch between `Account`, `LLM`, `Runtime`, `Runtime Templates`, and `Workers` using internal sub-tabs instead of separate top-level navigation items
13. optionally use `/settings/account`, `/settings/llm`, `/settings/runtime`, `/settings/runtime/templates`, or `/settings/workers` deep links to open a specific tab directly
14. in `Runtime`, admin can run one-click auto-config to fill blank local commands and probe candidate endpoints (safe mode fills blanks only; overwrite mode can replace existing endpoints)
15. when `Runtime` has no saved settings yet, the page auto-triggers one safe auto-config pass on first load to reduce manual setup before operator actions
16. runtime framework cards also support model-aware routing setup:
   - choose default base/published model and optional default model version per framework
   - bind optional model-level endpoint API keys (`model:<model_id>` / `model_version:<model_version_id>`) for remote routing
   - local mode keeps API key hidden and executes local command with explicit `model_id` + `model_version_id` payload
17. `Runtime Templates` becomes the dedicated runtime-snippet page:
   - copyable environment variable names and endpoint examples
   - health check curl samples plus request/response payload skeletons
   - no runtime readiness state machine, worker lifecycle controls, or profile activation actions
18. `Workers` becomes the dedicated worker-operations page:
   - worker registry list/status/actions
   - guided add-worker pairing and callback validation
   - worker reconfigure / activation follow-up

## 2.3 Flow A3: First-Run Onboarding (implementing)
Actor: `new user` (zero prior product knowledge)

1. user opens `/workspace/console` for the first time
2. system shows a beginner onboarding card with a plain-language closed-loop path:
   - `prepare data -> annotate/review -> train -> register version -> validate inference -> feedback`
3. each step includes a direct workspace link and a completion signal derived from real workspace records
4. user can dismiss onboarding and reopen later from the same entry surface
4a. a persistent fixed help entry near the top-right of the page can reopen current-page hints at any time, even after the inline onboarding card is hidden
4b. the fixed help entry should surface the current recommended next step (the first incomplete step) with a direct action link, so beginners do not need to infer the next click from the full checklist
4c. on the first visit to a guided page, the fixed help entry may auto-open once with a lightweight page hint; after the user closes it, later visits should stay quiet unless reopened manually
4d. on `/workspace/console`, the main workspace should mirror the same starter task in a dedicated card, so the home view always exposes one primary next action even when the rest of the dashboard is still sparse
5. when no real record exists yet, onboarding cards and empty states should explicitly explain “why this step matters” and “what to click next”
5a. page-level onboarding cards should also support hide/reopen controls from the same page, and hiding must not be ignored just because steps are incomplete
5b. while visible, the inline onboarding card should default to a compact summary (`what this page is for` + `recommended next step`) and expose the full checklist only through on-demand expansion or the fixed help popover
6. key operational pages also provide lightweight page-level onboarding cards, aligned with the same loop language:
   - `/models/explore`: explain catalog scanning, readiness/risk recognition, and when to jump into owned models or version work
   - `/models/my-models`: explain how drafts, pending approvals, and ready models move through the ownership lane
   - `/models/create`: explain the model draft wizard (`metadata -> artifact -> parameters -> approval submission`)
   - `/datasets`: explain data-prep purpose, surface one starter task in the main workspace, and when empty offer a direct jump into the inline create panel
   - `/datasets/:datasetId`: explain upload/split/version progress, mirror the current next step in the main workspace, and show direct queue/version follow-up links
   - `/datasets/:datasetId/annotate`: explain review queue operation, mirror one current next step in the main workspace/queue-empty state, and keep "back to dataset / validate" links visible
   - `/training/jobs`: explain active-vs-terminal queue semantics, mirror one current next action in the main workspace, and keep clear entry points into create/detail lanes
   - `/training/jobs/new`: explain snapshot-based training and readiness gates, and mirror one current next setup action in the main workspace
   - `/training/jobs/:jobId`: explain how to read current status, logs/metrics readiness, and follow-up links back to dataset/validation
   - `/models/versions`: explain completed-training evidence, version registration, and version-lineage inspection follow-up, while mirroring the first incomplete versioning step in the main workspace and version empty/selection-empty states
   - `/inference/validate`: explain validation + feedback routing as the loop close-out, while mirroring the first incomplete validation step in the main workspace and the key empty states (`No Model Versions Yet`, `No Ready Inputs Yet`, `No Runs Yet`)
   - `/admin/models/pending`: explain admin review responsibility (`review -> decide -> audit trail`)
   - `/admin/audit`: explain how to read governance records, distinguish user vs system events, and continue into adjacent admin lanes
   - `/admin/verification-reports`: explain one focused task on this page: filter, review, and export deployment verification reports for release governance
   - `/settings/account`: explain first account setup (`identity -> password -> role-aware governance -> next settings tab`), and mirror the first incomplete setup step in the main workspace plus directory empty/filter-empty states when relevant
   - `/settings/llm`: explain first LLM setup (`preset -> key -> enable -> test -> chat`), and mirror the first incomplete setup step in the main workspace plus key blocked states
   - `/settings/runtime`: explain runtime first-run setup (`configure -> activate profile -> readiness -> validate`), and mirror the first incomplete setup step in the main workspace plus readiness/configuration empty states
   - `/settings/runtime/templates`: explain where to copy runtime env/curl/request/response templates, while keeping this page snippet-only and linking back to Runtime settings for real configuration
   - `/settings/workers`: explain worker onboarding and scheduling capacity checks (`register/pair -> validate callback -> activate -> monitor`) with one clear next action

## 3. Flow B: Model Draft -> Approval Submission (implemented)
Actor: `user` with capability

1. open `/models/create`
2. stepper flow: metadata -> model file -> parameters -> review
3. upload model files (visible/deletable/status-aware)
4. advanced parameters collapsed by default
5. submit approval request (mock)

Admin review path:
- `/admin/models/pending` approve/reject
- `/admin/audit` observe audit records
- admin can also delete a non-foundation model from model inventory when no dependent model versions or conversations exist; successful deletion removes model-scoped attachments plus related approval requests and records an audit event
- if dependent model versions or conversations still exist, delete action is blocked and UI must explain that the model must be cleaned up through those dependencies first

## 4. Flow C: Dataset Management (Phase 1 skeleton, implemented)
Actor: `user`

1. open `/datasets`
2. create dataset with `task_type`
3. open `/datasets/:datasetId`
4. upload dataset files
5. run split operation (`train/val/test`)
6. create dataset version snapshot

## 4.1 Flow C1: Dataset Sample Browser + Batch Curation (evolution track)
Actor: `user`

1. open `/datasets/:datasetId`
2. switch item view mode (`grid` / `list`) based on current task
3. apply fast filters (search, split, item status, queue status, class/tag/metadata hints)
4. metadata filter supports both fuzzy keyword and `key=value` expression (for example `source=inference_feedback`, `feedback_reason=missing_detection`, `tag:low_confidence=true`)
5. select multiple items from filtered results
6. execute batch item operations (for example split/status/metadata updates) through one action bar
7. optionally save current filters (including slice-derived filters) as reusable views and apply/delete those views in-place
8. verify resulting queue distribution (`needs_work` / `in_review` / `rejected` / `approved`)
9. jump into annotation workspace with queue/item context preselected (and keep `version` context when launched from a dataset snapshot)
10. open training jobs or inference validation from a dataset-version action with preserved query context (`/training/jobs?dataset=<id>&version=<id>`, `/inference/validate?dataset=<id>&version=<id>`)

## 5. Flow D: Annotation Workflow (Phase 2 minimum, implementing now)
Actor: `user` (annotator), `user/admin` (reviewer by capability)

Status machine:
- `unannotated -> in_progress -> annotated -> in_review -> approved`
- rejection: `in_review -> rejected -> in_progress`

Minimum actions:
- detection box annotation (draw/move/resize)
- OCR text annotation
- segmentation polygon input (minimal)
- save, undo, continue edit
- submit to review
- approve/reject with persistent review context
- reject requires an explicit reason code

Current phase target:
1. open `/datasets/:datasetId`
2. review annotation summary and queue slices in dataset detail, then jump into one focused queue (`needs_work`, `in_review`, `rejected`, `approved`)
3. open `/datasets/:datasetId/annotate` (optional `?version=<dataset_version_id>` keeps snapshot context during review)
4. land directly on one current sample with the canvas ready for editing; page first screen shows only sample identity, queue position, canvas, right-side tabs, and bottom action bar
5. annotate current sample first; prediction compare, low-confidence context, pre-annotation, and extra metadata stay in secondary tabs
6. save as `in_progress` when pausing work, or submit `annotated -> in_review` when current sample is ready
7. before submit-review, client auto-saves unsaved canvas changes
8. before previous/next sample navigation, client blocks and asks whether to save unsaved changes
9. keyboard path remains equivalent to the primary UI path: `B/V` tool switch, `Ctrl/Cmd+S` save, `Enter` submit review, `ArrowLeft/ArrowRight` previous/next sample
10. once an item enters `in_review`, annotation payload becomes read-only in the upsert path; only the review endpoint may move it to `approved`/`rejected`
11. when rejected, reviewer must provide `review_reason_code`; latest review reason/comment remain visible during rework until next review, and moving the item back to `in_progress` should keep the same item open inside the `needs_work` queue before any further edits

## 5.1 Flow D1: Single-Sample Review Workbench (evolution track)
Actor: `user` (annotator/reviewer by capability)

1. open one dataset item from queue/browser
2. inspect sample preview and current annotation payload in the dominant center canvas
3. use right-side tabs to switch between `annotation`, `prediction compare`, and `sample info`
4. compare annotation with prediction overlays only when needed, without replacing the main labeling flow
5. update annotation or review decision without leaving the workbench context
6. move to next queue item with keyboard/buttons while preserving queue focus

## 6. Flow E: Training Job Workflow (Phase 1 skeleton, Phase 3 runtime)
Actor: `user`

1. open `/training/jobs/new`
2. stepper flow:
   - Step 1 task + framework
   - Step 2 dataset + dataset version snapshot + base model
   - Step 3 parameters (advanced collapsed)
   - Step 4 review + submit
3. select a dataset version snapshot, confirm launch readiness (dataset status / split summary / annotation coverage), then create training job
   - launch is blocked when `split_summary.train <= 0` or `annotation_coverage <= 0`
   - when runtime strict training guard (`disable_simulated_train_fallback`) is off, launch also requires explicit risk confirmation from the operator before submit
   - when runtime strict mode status cannot be loaded, launch remains blocked until runtime settings become available again
4. job transitions through:
   - `draft`
   - `queued`
   - `preparing`
   - `running`
   - `evaluating`
   - `completed` (or `failed` / `cancelled`)
5. view logs and metrics in `/training/jobs/:jobId`
5a. open `/training/jobs/:jobId/cockpit` when the operator needs the visual execution surface:
   - top summary keeps run name/status/epoch/runtime/best metric/device
   - flow rail shows current stage plus completed/upcoming stages
   - center area visualizes metric curves and resource monitoring
   - right-side tuning panel shows candidate generation, trial progress, best-trial promotion, and applied-parameter updates
   - bottom event stream keeps timestamps, highlighted milestones, and log continuity
5b. cockpit supports two execution modes:
   - `live`: poll current training detail and map the result into cockpit view state without disrupting the rest of the page
   - `demo`: replay deterministic mock training/tuning/resource events with playback controls (`play`, `pause`, `replay`, `1x/2x/4x`)
5c. when backend lacks tuning/resource streams, cockpit may leave those panels empty/derived in `live` mode, while `demo` mode continues to provide a full presentation-grade animation lane
6. from job detail, operators can jump to scoped inference validation and scoped jobs list with the same dataset/version context
6a. when a completed job has no owned model matching its task type, the detail page should surface a direct prefilled model-draft creation path so the operator can create the missing model before registering the version
6b. model-draft creation opened from a completed job should keep the version-registration handoff visible so the operator can return with the same job context
7. when opening job detail from a scoped jobs list, query scope should stay preserved across navigation (`dataset`, `version`)
8. training detail also exposes scheduler decision history (latest snapshot plus prior reschedule/failover/fallback entries) for auditability
9. when a completed job is ready for promotion, open `/models/versions` with the job prefilled so version registration starts from the finished run
10. version registration still requires selecting an owned model, but the completed job and suggested version name should already be filled in
11. for cross-machine model handoff, worker can deploy encrypted artifact via:
   - `POST /api/worker/models/pull-encrypted` (worker-auth protected)
   - worker internally calls `POST /api/runtime/public/model-package` (runtime bearer key) and decrypts payload locally

## 6.1 Flow E1: Vision Modeling Task Orchestration (implemented MVP)
Actor: `user`

1. start from `/workspace/chat` (natural-language requirement + optional sample images) or from a direct API call to `POST /api/vision/tasks/understand`
2. system builds a structured `VisionTask`:
   - task understanding/spec
   - dataset inspection profile
   - recipe-based training plan
   - missing requirements list
3. when critical inputs are missing (`dataset_id`, non-image examples, trainability issues, unknown task type), task lands in `requires_input` and the assistant/task page exposes direct follow-up links
4. operator opens `/vision/tasks/:taskId` from chat or `/vision/tasks` list to continue outside the original conversation turn
5. task detail keeps one recommended next action visible:
   - `Launch training` when no job exists and requirements are already complete
   - `Start round 1` / `Run next round` for auto-tune iteration
   - `Register model` once metrics pass and no model version exists yet
   - `Mine badcases` after model registration when no feedback dataset exists yet
6. `Auto advance` follows the same state-aware sequence:
   - `requires_input` -> return missing requirements only
   - no training job yet -> start next round
   - job still running -> wait
   - metrics passed and no model version -> register model
   - model version exists but no feedback dataset -> mine badcases
   - otherwise -> closed-loop state, no further mutation
7. task detail keeps deep links to dataset, training job, model version, and feedback dataset so the engineer can move into the owning page for deeper work
8. owner/admin visibility applies to task list/detail, and runtime sync keeps validation report + status aligned with the linked training job/model version

## 7. Flow F: Model Version Registration
Actor: `user`

1. completed training job becomes registerable only when `execution_mode=local_command`
1a. if artifact summary signals non-real local execution (`mode=template`, explicit `fallback_reason`, or `training_performed=false`), registration must be blocked unless `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1`
2. register model version in `/models/versions`
2a. if the completed job has no owned model that matches its task type, the registration surface should surface a direct model-draft creation path prefilled to that task type instead of silently selecting an unrelated model
2b. after successful registration, the page should expose a direct inference-validation next step for the newly created version
3. model version is linked to model + dataset + training job + metrics

## 8. Flow G: Inference Validation + Feedback Loop
Actor: `user`

1. open `/inference/validate`
2. review runtime summary (reachable/unreachable/not-configured) and jump to `/settings/runtime` when readiness/configuration issues need fixing
3. upload inference image
4. select model version
4a. the page also accepts a direct model-version prefill via `?modelVersion=<id>` for chat/action links, while `?dataset=<id>&version=<id>` continues to carry dataset-version context for scoped feedback routing
5. run inference
6. inspect visualized predictions + raw output + normalized output
6a. when run source indicates fallback/template (`source` contains `mock` / `template` / `fallback` or raw fallback reason exists), UI must show explicit warning that this is not real OCR output
6b. when OCR run returns empty lines in fallback mode, UI must show explicit empty-result guidance instead of business-like default text
7. if failure sample, click feedback action to send sample to a dataset with matching task type
8. system records `feedback_dataset_id`, ensures a dataset-scoped attachment exists in target dataset, and upserts a traceable dataset item for next-round annotation/training
9. validation side actions should keep one scoped annotation queue jump while preserving dataset/version context
10. annotation quick link additionally carries `meta=inference_run_id=<run_id>` so annotation workspace can prefilter feedback samples for the selected inference run
11. runtime auth resolution for remote inference follows:
    - `model_version` bound key first (`model_version:<model_version_id>`)
    - then `model` bound key (`model:<model_id>`)
    - then framework-level fallback key (`<framework>.api_key`)
12. for remote clients without web session, control plane also exposes bearer-key public runtime APIs:
    - `POST /api/runtime/public/inference` (inline base64 input)
    - `POST /api/runtime/public/model-package` (AES-256-GCM encrypted model artifact payload)

## 9. Closed Business Loop 1: OCR Fine-tune
1. create OCR dataset
2. annotate/import OCR labels
3. choose `paddleocr` or `doctr`
4. run training
5. evaluate OCR metrics (accuracy/CER/WER)
6. register model version
7. validate inference
8. feedback errors to dataset

## 10. Closed Business Loop 2: Detection Fine-tune
1. create detection dataset
2. annotate/import boxes
3. choose `yolo`
4. run training
5. evaluate detection metrics (mAP/precision/recall)
6. register model version
7. validate inference
8. feedback errors to dataset

## 10.1 Version-Centric Loop Guardrail (all task types)
1. dataset curation and review changes are committed before version snapshot creation
2. training/export/evaluation paths are launched from explicit dataset-version snapshots
3. inference feedback returns samples into dataset curation queues for the next version cycle

## 11. Flow H: Deployment Verification Governance
Actor: `admin`

1. run `docker:verify:full` to generate report files (includes OCR fallback safety guard verification)
2. open `/admin/verification-reports`
3. filter by status/base url/date range or search by filename/business user
4. optionally apply quick range preset (last 7 days / last 30 days)
5. apply report ordering (latest/oldest/failed-first; default failed-first)
6. paginate and inspect failed checks in report detail panel
7. export filtered reports as JSON for release evidence
8. decide go/no-go for intranet rollout handoff

## 12. Flow I: Control Plane + Dynamic Training Workers
Actor: `admin` (control plane operator), `worker` (training node agent)

1. deploy Vistral app/API on machine `A` as control plane
2. add worker nodes (`B/C/D...`) dynamically through admin registration or worker self-heartbeat
3. workers continuously report heartbeat with load/capacity snapshot
4. user submits training jobs from normal workspace flow
5. scheduler chooses target execution node by load-aware strategy:
   - prefer `online` workers with available concurrency
   - pick lowest normalized load score
   - fallback to control-plane local executor when no eligible worker exists
6. when target is `worker`, control plane sends execution request to worker endpoint (`/api/worker/train`) with the worker's dedicated auth token and job context payload; shared token remains fallback for legacy workers
7. dispatch payload includes worker-usable dataset package metadata/files (or equivalent package reference) so worker can materialize training inputs in its own local workspace
8. worker executes training command (or deterministic fallback path) and returns logs/metrics/metric-series/artifact summary
9. control plane writes returned outputs back into the same training job runtime records (log excerpt, metrics timeline, artifact attachment)
10. if worker dispatch fails and fallback policy is enabled, control plane records dispatch failure and continues with local execution path
10a. before local fallback, control plane should attempt re-dispatch to another eligible online worker (excluding already failed nodes in this run) when available, within bounded retry attempts and short backoff intervals
11. cancel action on a worker-running job should propagate to worker cancel endpoint and abort in-flight dispatch wait
12. if a worker becomes offline/draining, new jobs are rerouted without restarting control plane
13. admin can remove/reactivate workers during runtime

## 12.1 Flow I1: Worker GUI Onboarding (implementing)
Actor: `admin` (control plane operator), `worker operator`

1. admin opens `/settings/workers` and starts `Add Worker`
2. admin selects deployment mode (`Docker` recommended or script fallback), worker profile, optional worker public host/IP, optional bind port, and generates a short-lived pairing token
3. system shows a copyable startup command or downloadable worker bundle with a prebuilt `/setup` URL when host/port were provided
4. worker operator starts the worker node with one command
5. worker local setup UI opens in `unpaired` state
6. worker operator pastes pairing token (or equivalent pairing payload)
7. worker exchanges token with control plane and loads default config, including any preconfigured worker endpoint hint
8. worker detects local resources and validates:
   - control-plane connectivity
   - worker endpoint callback reachability
   - writable workspace
   - capability/runtime availability
   - worker health payload compatibility metadata (`worker_version`, `contract_version`, `runtime_profile`, `capabilities`)
9. operator confirms worker name, concurrency, capabilities, and optional advanced settings
10. worker saves config locally and runs validation
11. worker heartbeat is accepted by control plane and triggers callback validation from control plane to worker endpoint
12. if callback validation and hard-compatibility checks pass, session and worker advance to `online`; otherwise session stays `validation_failed` and worker remains unschedulable until retry succeeds
13. worker local `/setup` page can poll control-plane bootstrap status so the operator sees the latest onboarding state without switching back to admin worker settings
14. worker enters normal heartbeat and training-accept mode
15. for an already-registered worker, admin can trigger `POST /admin/training-workers/{id}/reconfigure-session` to start a guided upgrade/reconfigure pass without deleting the existing worker record

## 13. Unified UX Constraints
- multi-step flows must have top stepper
- advanced params default to collapsed
- upload files must remain visible + deletable + status-aware
- desktop left sidebars keep fixed viewport height and use internal scrolling
- secondary sidebar blocks should collapse when density becomes distracting
- all pages use consistent empty/loading/error/success state blocks
- style and interaction semantics stay consistent across modules
- visual-data-loop enhancements should prioritize IA and operational throughput over feature bloat, while preserving chat-first product identity
- reference planning baseline: `docs/visual-data-loop-evolution.md`
