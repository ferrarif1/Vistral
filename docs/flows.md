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
3. if critical fields are missing, assistant responds with a compact `requires_input` card that lists missing fields and optional suggestions
3a. for complex operational intents (for example annotation/review/training/inference scopes), the same `requires_input` card can include direct navigation links so users can jump to the relevant workspace and fetch required ids/inputs
4. once required fields are complete for high-risk mutations (create dataset/model/training job), assistant asks for explicit confirmation (`确认执行` / `confirm execute`)
5. user confirms execution in follow-up turn
6. system calls the corresponding backend API only after confirmation is received
7. assistant returns a `completed` or `failed` action card with created entity summary and next-step guidance
8. for power users / agentic bridge, user can use `/ops {json}`; for normal users, natural-language intents can also be mapped to the same bridge APIs automatically; high-risk calls still require confirmation before mutation

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
12. switch between `Account`, `LLM`, and `Runtime` using internal sub-tabs instead of separate top-level navigation items
13. optionally use `/settings/account`, `/settings/llm`, or `/settings/runtime` deep links to open a specific tab directly

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
2. review annotation summary and jump into a focused queue (`needs_work`, `in_review`, `rejected`, `approved`)
3. open `/datasets/:datasetId/annotate` (optional `?version=<dataset_version_id>` keeps snapshot context during review)
4. select dataset item directly or restore one from queue deep link
5. queue filters (search/split/item-status/metadata/low-confidence) remain visible as active chips and can be cleared with one click
6. metadata quick filters can prefill common triage patterns (`tag:low_confidence=true`, `inference_run_id`, top `feedback_reason`)
7. edit OCR/detection payload
8. save as `in_progress`/`annotated`
9. submit `annotated -> in_review`
10. review as `approved` or `rejected`
11. once an item enters `in_review`, annotation payload becomes read-only in the upsert path; only the review endpoint may move it to `approved`/`rejected`
12. when rejected, reviewer must provide `review_reason_code`; latest review reason/comment remain visible during rework until next review, and moving the item back to `in_progress` should keep the same item open inside the `needs_work` queue before any further edits

## 5.1 Flow D1: Single-Sample Review Workbench (evolution track)
Actor: `user` (annotator/reviewer by capability)

1. open one dataset item from queue/browser
2. inspect sample preview, current annotation payload, metadata, and latest review context in one screen
3. compare annotation with prediction overlays when available
4. update annotation or review decision without leaving the workbench context
5. move to next queue item with keyboard/buttons while preserving queue focus

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
6. from job detail, operators can jump to scoped inference validation and scoped jobs list with the same dataset/version context
7. when opening job detail from a scoped jobs list, query scope should stay preserved across navigation (`dataset`, `version`)
6. training detail also exposes scheduler decision history (latest snapshot plus prior reschedule/failover/fallback entries) for auditability

## 7. Flow F: Model Version Registration
Actor: `user`

1. completed training job becomes registerable only when `execution_mode=local_command`
1a. if artifact summary signals non-real local execution (`mode=template`, explicit `fallback_reason`, or `training_performed=false`), registration must be blocked unless `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1`
2. register model version in `/models/versions`
3. model version is linked to model + dataset + training job + metrics

## 8. Flow G: Inference Validation + Feedback Loop
Actor: `user`

1. open `/inference/validate`
2. run runtime connectivity check (PaddleOCR/docTR/YOLO) and confirm framework status
3. upload inference image
4. select model version
5. run inference
6. inspect visualized predictions + raw output + normalized output
6a. when run source indicates fallback/template (`source` contains `mock` / `template` / `fallback` or raw fallback reason exists), UI must show explicit warning that this is not real OCR output
6b. when OCR run returns empty lines in fallback mode, UI must show explicit empty-result guidance instead of business-like default text
7. if failure sample, click feedback action to send sample to a dataset with matching task type
8. system records `feedback_dataset_id`, ensures a dataset-scoped attachment exists in target dataset, and upserts a traceable dataset item for next-round annotation/training
9. validation side actions can jump directly to scoped dataset detail, annotation queue, and training jobs while preserving dataset/version context
10. annotation quick link additionally carries `meta=inference_run_id=<run_id>` so annotation workspace can prefilter feedback samples for the selected inference run

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

1. admin opens `Runtime > Add Worker`
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
13. worker local `/setup` page can poll control-plane bootstrap status so the operator sees the latest onboarding state without switching back to admin runtime settings
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
