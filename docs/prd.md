# Product Requirements Document (PRD)

## 1. Product Overview
Vistral is an AI-native visual model platform with two workspace routes:
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
8. conversation-driven backend actions for dataset/model/training setup
9. conversation-assisted vision-task understanding and auto-orchestrated training follow-up

## 6. Access Model Clarification
- System roles: `user`, `admin`
- `owner` is a resource relation (`owner_user_id`), not a role
- public self-registration is disabled in the current product phase
- account provisioning is an administrator-only privileged action
- administrators can provision `user` or `admin` accounts from the authenticated product surface
- every authenticated user can change their own password from settings

## 7. Functional Requirements

### FR-001 Conversation Workspace
- natural language interaction
- persistent context per conversation
- attachment-driven message flow
- for operational requests (for example dataset creation, model draft creation, training job creation), the conversation layer can call backend APIs and return real execution results
- when BYO LLM is enabled, the conversation layer should first infer the user's actual operational goal, choose the least-user-operation execution lane, and may chain multiple backend actions in one guided turn (for example understand a `VisionTask` first, then auto-advance the next safe step)
- without BYO LLM planning, explicit automated / closed-loop / delivery-oriented training requests should still route through the structured `VisionTask` orchestration lane instead of falling back to a job-first form
- when required fields are missing, assistant must explicitly ask for the missing inputs instead of silently guessing critical parameters
- assistant execution results should stay readable in the timeline as compact action cards with status, missing inputs, and created-entity summary
- conversation actions may create or update a `VisionTask` so users can continue the same requirement from a dedicated detail page instead of repeating the prompt
- completed/failed operation cards may surface derived next-step actions that either navigate to the correct page or send the guarded follow-up `/ops` input back into the same thread
- when the conversation lane uses a structured `VisionTask`, its completed action summary should also surface the same agent evidence now visible on task detail:
  - evaluation suite / active metric contract
  - promotion gate interpretation
  - run comparison conclusion (including champion/challenger when available)

### FR-002 File Attachment Baseline
- conversation draft attachments appear as current-message chips while composing
- after send, attachment chips collapse from composer and remain traceable via message history or on-demand attachment tray
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

### FR-005A Agent Mode Interaction
- high-intent workflows should expose one agent-mode control surface instead of scattered status cards.
- the agent-mode surface must show:
  - current objective
  - stage progression
  - current decision/status
  - compact evidence chips
  - one primary next action
  - secondary repair/escape actions
  - disclosures for deeper diagnostics
- mutating actions remain behind explicit operator confirmation when risk is high.
- forms remain available as expert controls, collapsed by default, rather than becoming the primary visual model.

### FR-005B Pixel Lab View
- the product may provide a separate playful visualization mode for the same engineering loop, reachable from a persistent top platform switch in the shared page header.
- the Pixel Lab view must be a real workflow mirror, not a decorative landing page:
  - the main experience should render a bright daytime "model training house" with nine central workflow rooms:
    - reception / conversation command room
    - dataset warehouse
    - data processing / cleaning + annotation room
    - feature engineering / recipe room
    - training room
    - inference validation / exam room
    - model graduation / publish room
    - deployment service / runtime monitoring room
    - bug / feedback repair room
  - reception / conversation command and bug / feedback repair are first-class rooms in the central house; side rails, timeline/notification entries, assistant suggestions, and canonical links remain supporting surfaces.
  - visual mood should follow the supplied bright pixel workshop reference: blue-sky daytime background, warm wood beams, red roof, light beige walls, clear room boundaries, and readable interior controls; avoid dark blue-black cyber/night monitoring-room styling.
  - each room must reflect real API-backed state and keep one canonical follow-up path into the existing professional workflow page
  - a persistent OpenClaw assistant should stay available inside the view, understand the currently focused room context, and surface recent assistant/task interactions plus next-step actions
  - the left rail should show current project, current stage, active model, today tasks, and work notes
  - the right rail should show tasks/notifications, project statistics, and focused metric information
  - the lower workbench strip should summarize model squad status and the end-to-end training flow derived from real product records
- the view should preserve explicit operator action boundaries. It may deep-link to training, annotation, model-version, and inference pages, but must not perform high-risk mutations silently.
- when inference validation is the current phase, the view should let users choose or accept an auto-selected dataset/model-version pair and jump into the validation lane as a visible "exam" action.

### FR-005C Model Training Workshop
- the product may provide `/training-workshop` as a focused pixel-style training-flow visualization for demos, onboarding, and operator comprehension.
- the workshop is narrower than Pixel Lab and must keep exactly three process rooms:
  - dataset warehouse: dataset selection, ingest, version tags, and sample storage.
  - training lab: data cleanup, labeling/review, training, progress, and tuning.
  - inference exam room: validation dataset choice, metric generation, human confirmation, and publish handoff.
- only one active model character is rendered in the scene at a time. Other base-model personalities may appear in the selector list only.
- supported workshop stages are `idle`, `dataset_selecting`, `dataset_preparing`, `labeling_or_reviewing`, `training`, `tuning`, `inference_validating`, `human_review_required`, `publishing`, `completed`, and `failed`.
- the workshop may run fully on mock state for presentation, but must expose an adapter that maps real Vistral training task statuses into the same stage model.
- `human_review_required` remains a governance boundary: demo playback may pause there, but publish requires an explicit operator action.
- when assets are absent, the page may use local CSS fallback visuals; production asset replacement must stay centralized under `public/assets/vistral-workshop/`.

### FR-005D Pixel Workshop Visual System
- the shared authenticated workspace may adopt the Pixel Workshop visual system across professional pages, not only `/workspace/pixel-lab`.
- this is a presentation layer over the existing product routes. It must not fork page responsibilities, data ownership, state machines, or API contracts.
- the product-level interaction blueprint should use the supplied `src-img/方案效果总览.png` console prototype for structure:
  - a game HUD top bar for brand, service status, version, mode switch, settings/help, and session controls.
  - a central model-training-house room map for the core workflow.
  - a persistent right-side OpenClaw assistant/chat dock that can use the current route and focused room context.
  - lower operational panels for model roles, timeline/events, resource health, and work notes.
  - a bottom pixel room navigation bar as the primary cross-route movement model.
- the final visual mood should continue to follow `src-img/新工作台.png`: bright daytime sky, red roof, warm wood, light beige walls, readable pixel panels, and friendly training-workshop energy. The darker console prototype is structural guidance only, not the color/lighting target.
- the central house follows the nine-room product desktop structure from the overview reference while using the newer bright daytime material palette.
- shared page primitives should carry the visual language first:
  - the authenticated AppShell uses a pixel-game HUD and bottom room navigation instead of duplicating the room map in a traditional left sidebar.
  - `WorkspacePage` chooses route-aware room context from the centralized workshop asset pack; assets may appear as room cards, headers, characters, or state panels, but must not be used as a full-screen wallpaper substitute for real UI.
  - `WorkspacePage` also exposes a compact room-context strip with the current room name, purpose, and canonical follow-up links.
  - `PageHeader`, shared cards, workbench panels, forms, tables, and unified state feedback inherit the same pixel-workshop treatment.
  - domain-specific pages can add room-specific details, but should avoid page-local decorative systems.
  - custom-layout routes that do not use `WorkspacePage` (for example the chat workspace and focused training workshop) must still render the same room-context and asset language.
  - specialist workspaces such as annotation full-screen mode and training cockpit should keep their operational layout, but their headers, panels, action bars, and telemetry cards must remain visually connected to the Pixel Workshop shell.
- route-to-room visual mapping should stay aligned with the workflow:
  - datasets and annotation use data warehouse / cleaning-room assets.
  - training launch, job list, detail, cockpit, and workshop use training-room assets.
  - inference validation uses exam-room assets.
  - model versions and governance use graduation / publish-room assets.
  - runtime, workers, and settings use monitoring-room assets.
  - conversation and vision-task pages use command-room assets.
- missing room assets should be generated or added into `public/assets/vistral-workshop/`, with source intent documented. Pages must retain CSS/SVG fallback visuals if a raster asset is absent.
- all AI-native hard requirements remain unchanged: visible/deletable/status-aware attachments, top steppers for multi-step flows, collapsed expert controls, consistent empty/error/loading/success states, and explicit confirmation for high-risk mutations.

### FR-006 Dataset Management
- create/manage datasets
- upload image/video/archive files
- dataset ingestion should support folder-selected local bundles and `.zip` bundle import from the dataset detail workflow
- bundle import should recognize image files plus paired annotation payloads, then reuse the existing dataset attachment + annotation import contracts instead of creating a second hidden dataset state
- after bundle import, the workflow should optionally auto-run split + dataset-version snapshot preparation so the operator can continue directly into training launch
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
- single-sample focused workspace: one current sample, one primary job, no parallel queue/review/filter modules competing with the canvas
- canvas-first layout: lightweight header, large center canvas, right-side secondary tabs, fixed bottom action bar
- primary operator path must stay obvious within 3 seconds: `annotate -> save / submit -> next sample`
- bottom action bar keeps only one primary forward action (`submit review` or contextual review decision)
- duplicated actions are not allowed in multiple page regions with the same semantics
- annotation workspace must support keyboard shortcuts at minimum:
  - `B` draw box
  - `V` select/edit
  - `Delete` delete selected region
  - `Ctrl/Cmd+S` save in progress
  - `ArrowLeft / ArrowRight` previous / next sample
  - `Enter` submit review
- full-screen annotation mode is required
- status flow: `unannotated -> in_progress -> annotated -> in_review -> approved/rejected`

### FR-008 Pre-Annotation and Review
- run pre-annotation with selected model version
- manual correction and review sampling
- reject/rework path with audit notes
- prediction comparison, low-confidence triage, pre-annotation actions, and extra sample metadata must be secondary surfaces and cannot displace the annotation canvas from first-screen focus
- review actions should only take primary space when the current sample is actually in `in_review`; otherwise the annotation workspace stays focused on labeling

### FR-009A Agent training orchestration (architecture)
- the model-training agent is defined as **perception + policy + execution separation**: deterministic refresh of `VisionModelingTask` recommendations, guarded mutations via existing APIs, and conversational explanation without bypassing validation; see `docs/agent-training-orchestration.md`
- Agent Training Studio (`/workspace/console`) must align its primary CTA with `agent_next_action` when global training blockers do not override, as specified in `docs/flows.md` Flow J §12.2

### FR-009 Training Jobs
- create training job
- the primary training entry should feel agentic: user provides a natural-language goal plus a dataset (or dataset-version scope), and the system infers task type / framework / base model / recommended core params by default
- explicit task/framework/base-model/dispatch overrides must remain available only as expert controls, collapsed by default
- training recommendation must be recipe-backed rather than ad-hoc:
  - each supported `task_type + framework` pair has a named `TrainingRecipe`
  - each recipe defines default params, allowed overrides, validation ranges, units, UI control hints, and runner mapping
  - agent-created plans must explain which recipe was selected and why
  - user overrides must be persisted as part of the submitted job config snapshot
- training launch must use one consolidated real-readiness gate:
  - dataset size / ready visual sample count
  - train/val/test split quality
  - annotation coverage and label completeness
  - class balance / long-tail warnings for detection, segmentation, and classification
  - OCR charset coverage and text-label completeness for OCR
  - runtime dependency readiness, GPU/CPU/device availability, worker eligibility, and fallback policy
  - expected artifact evidence required for model registration
- every new training job must bind to an explicit dataset version snapshot instead of an implicit "latest" dataset state
- training launch readiness must surface at least dataset status, selected dataset-version split summary, and annotation coverage before submit
- training launch must be blocked when selected dataset version has zero annotation coverage (`annotation_coverage <= 0`)
- training launch may also be initiated from a structured `VisionTask`, but the actual submitted job must still persist the explicit dataset + dataset-version snapshot + framework + base model choices
- base model choices exposed in normal workspace flows must come from a curated foundation catalog suitable for future fine-tuning
- internal smoke/verification/demo fixtures must not remain visible in the default workspace catalog; when sample records are needed, keep at most 1-2 curated examples
- the product-wide visual system may use the Pixel Workshop skin as the shared authenticated workspace language: pixel-house atmosphere, room-backed surfaces, restrained motion, and one consistent blue primary interaction accent
- shared layout, chat workspace, workbench pages, Pixel Lab, and training cockpit should inherit one coherent workshop system rather than keeping page-specific visual dialects; cockpit may remain cinematic, but not as an isolated dark sci-fi theme
- configure parameters and submit, but the default path should minimize visible form work and let the system auto-fill a launchable plan whenever possible
- when Smart Launch includes a natural-language goal (or comes from a structured `VisionTask`), it should create or reuse that `VisionTask` as the durable orchestration anchor so training detail can keep a direct "continue as agent" handoff toward model output
- support start/cancel/retry lifecycle
- completed training should hand off into model registration as directly as possible so the user experiences one continuous "dataset -> train -> model" lane rather than many separate training sub-tools
- provide a dedicated training visualization cockpit for one run, accessible from both training job list and training detail without replacing the existing detail workflow
- cockpit, worker routing, scheduler evidence, and other deep operational diagnostics should be treated as secondary/expert continuations, not first-screen blockers on the default launch path
- training cockpit must support `live` and `demo` modes:
  - `live`: consume real training-job status, metric timeline, and logs from backend APIs with non-jumping refresh
  - `demo`: replay a deterministic mock timeline for presentation, screenshots, and product demos when backend tuning/resource streams are not available
- training cockpit must keep all user-visible cockpit copy inside the existing i18n system; Chinese-default environments must not leak raw fallback English from panel/chart/hook internals
- training cockpit must keep live-state degradation explicit:
  - `real`: value comes from backend-backed training evidence
  - `derived`: value is a front-end visualization derived from related telemetry/config and must be labeled as such
  - `unavailable`: this data stream is currently absent and the UI should explain that absence instead of fabricating persisted truth
- training cockpit must visualize at minimum:
  - stage progression from data preparation to registration/publish handoff
  - metric curves (for example `loss`, `val_loss`, `accuracy`, `mAP`, `learning_rate`)
  - resource usage (`gpu`, `gpu_memory`, `cpu`, `memory`, throughput, `eta`)
  - auto-tuning attempts (candidate params, trial status, best selection, applied config)
  - timestamped event/log stream with highlighted important events
- training cockpit should include one cinematic training-scene surface above the dense telemetry panels:
  - dataset-side structure should present as a thumbnail album / mini-gallery rather than abstract bars, so operators can immediately understand the scene still represents real sample images
  - the active mini-batch should be visually sampled from that thumbnail album, then pushed through an augmentation / forward-pass lane toward the model core
  - dataset file/count indicators may be derived in the frontend when the backend does not expose file-level depletion, but derived status must remain visually consistent with existing `derived` semantics
  - model-side visuals should show parameter-vector or optimization activity through animated particles / nodes / pulse fields instead of static decoration
  - the interaction between dataset thumbnails and the model core should match training logic: sampled batch -> transformed input -> model forward / optimization response, instead of arbitrary decorative motion
  - the same scene should expose a compact parameter-curve band so operators can correlate the cinematic motion with actual metric/parameter change
  - scene motion discipline matters as much as spectacle: prefer one dominant transfer corridor plus a restrained model-core response, and avoid multiple equally loud animations competing for attention
  - the desired tone is closer to a premium cinematic control-room / hacker-console surface than a dashboard full of independent widgets; peripheral elements should mostly stay calm while only the active training path carries motion
- auto-tuning visualization must make "system is actively searching for a better config" obvious even when the current backend only provides partial data; mock/demo output must stay decoupled from persisted training-job truth
- training cockpit demo mode must keep playback state explicit (`playing`, `paused`, `replay`, speed state, finished`) so operators can tell whether the animation is still advancing
- training cockpit should remain readable on narrower viewports by collapsing into a stable top-to-bottom order (`scene -> overview -> stage flow -> metrics -> resources -> tuning -> event stream`) without horizontal overflow
- training cockpit should respect reduced-motion preferences and retain readable current values even when hover-driven chart inspection is unavailable
- training scheduling must support control-plane/worker topology:
  - Vistral app can run as control plane on machine `A`
  - one or more training workers can run on machines `B/C/D...`
  - workers can be dynamically added/removed without service restart
  - scheduler should assign queued jobs to available workers based on current load/capacity and fallback to control-plane local execution when no worker is eligible
- status flow: `draft -> queued -> preparing -> running -> evaluating -> completed/failed/cancelled`

### FR-010 Evaluation and Model Versioning
- OCR metrics: accuracy/CER/WER
- detection metrics: mAP/precision/recall
- segmentation metrics: mIoU plus mask/polygon quality summary where available
- each task type must define an `EvaluationSuite` with:
  - primary metric
  - threshold target and threshold source
  - benchmark or dataset-version basis
  - regression comparison scope
  - gate interpretation (`pass`, `needs_review`, `fail`, `pending`)
- promotion logic must compare current run evidence with champion/challenger context before recommending registration
- failed gates must produce a specific next recommendation: tune params, clean annotations, collect data, fix runtime, train again, observe, or stop
- store error sample analysis
- register model version with training linkage
- register model version must reject jobs with `execution_mode=simulated|unknown`
- register model version must reject local-command jobs with template/fallback artifact evidence (`mode=template`, explicit `fallback_reason`, or `training_performed=false`) unless `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND=1`
- a completed `VisionTask` may register its linked model version directly from task detail, but the same evidence gate remains mandatory
- compare model versions
- administrators can remove non-foundation model records from the catalog when those models have no dependent model versions or conversations
- curated foundation/base models remain protected from deletion so the training entry catalog always keeps the intended baseline choices
- successful admin deletion must also clean up model-scoped attachments and related approval requests, and emit an audit log for governance traceability

### FR-011 Inference Validation
- upload image and run inference with selected model version
- show raw output + normalized output
- persist inference runs
- one-click feedback sample back to dataset
- feedback target dataset must match the inference run task type (for example detection run -> detection dataset)
- `VisionTask` follow-up may mine low-confidence inference runs into a feedback dataset, but the created dataset/items must still remain traceable through the same dataset/inference contracts

### FR-012 Adapter Abstraction
Framework integrations must follow unified trainer interface:
- `validate_dataset()`
- `train()`
- `evaluate()`
- `predict()`
- `export()`
- `load_model()`

### FR-013 Account and Credential Management
- public registration entry is not exposed to end users
- administrators can create accounts from an authenticated management surface
- administrators can browse an account directory, reset another user's password, and disable or reactivate accounts
- disabling an account requires an explicit administrator reason so governance actions stay explainable
- account records expose operational fields needed by the management surface, at minimum `status`, `status_reason`, and `last_login_at`
- disabled accounts cannot start new authenticated sessions and should be blocked from further protected actions until reactivated
- disabling an account immediately terminates that account's existing authenticated sessions
- reactivating an account clears the stored disable reason and still requires the user to sign in again
- the product must prevent dangerous account operations such as disabling the current admin session or disabling the last active admin account
- administrators can choose the created account role (`user` or `admin`)
- every authenticated user can change their own password by providing the current password plus a new password
- privileged account creation, password change, and account status actions must produce audit logs

### FR-014 Distributed Training Control Plane
- provide admin-manageable training worker registry (list/add/update/remove)
- provide guided worker onboarding from admin runtime settings (prefer Docker-first startup)
- provide worker heartbeat/status reporting for load-aware scheduling
- worker onboarding should support a graphical setup path after one-click worker start/install:
  - collect required connection fields without forcing manual env editing for the common case
  - validate control-plane connectivity, callback reachability, and declared capabilities before worker becomes schedulable
  - surface concrete remediation guidance when required data is missing or validation fails
- scheduler decisions must be auditable (selected worker, fallback reason, snapshot load)
- when scheduler selects a worker with reachable endpoint, control plane should dispatch an actual training execution request to that worker and ingest returned logs/metrics/artifact summary into the same training job record
- control plane should provide worker-usable dataset payload (or package reference) so cross-machine training does not depend on control-plane absolute filesystem paths
- worker unavailability or overload must not block the platform:
  - queued jobs can be re-scheduled
  - when dispatch to a selected worker fails, scheduler should try another eligible online worker before local fallback
  - re-dispatch should follow a bounded retry policy (max attempts + short backoff) to prevent endless dispatch thrashing
  - dispatch failure can fallback to control-plane local execution when fallback policy is enabled
- contracts should support rolling expansion and shrink (for example adding/removing `B/C/D` nodes during runtime)

### FR-015 Visual Data Loop Workspace Upgrade
- absorb high-value workflow mechanisms from mature visual data tooling (for example Roboflow) without cloning page structures
- keep Vistral chat-first positioning while upgrading professional workspace efficiency
- dataset detail should expose an operational sample browser:
  - grid/list browsing modes
  - fast filters (search, split, status, annotation queue status, class/tag/metadata hits)
  - bulk select + bulk item actions (at minimum split/status metadata updates)
- sample-level workflow should behave as a unified review workbench:
  - original sample, annotation payload, latest review context, metadata, and actions in one surface
- dataset versions should be first-class workflow anchors:
  - training/export/evaluation actions must remain visibly tied to explicit dataset-version snapshots
- prediction-vs-annotation comparison entry should be explicit in review/validation workflows:
  - overlay controls
  - low-confidence / likely-error triage hints
- tags and metadata must be operational:
  - editable and filterable in sample workflows
  - usable as loop signals for review routing and training scope preparation
- implementation should prioritize information architecture and operational throughput over feature count

### FR-016 Vision Modeling Task Orchestration
- users can start from a natural-language requirement plus 1-10 sample image attachments and receive a structured `VisionTask`
- the task record must persist:
  - prompt understanding result (`task_type`, expected output, constraints)
  - dataset inspection result
  - compact dataset diagnostics that tell the agent whether the next improvement should come from more data rather than more rounds:
    - duplicate / split-overlap signals
    - label-balance or long-tail signals for labeled tasks
    - charset-width signal for OCR tasks
    - one short list of recommended data actions
  - recipe-based training plan
  - validation summary from linked training jobs
  - missing requirements and backend-generated next-step guidance
  - a compact agent decision trail that explains why the current next step is recommended
  - one evaluation-suite summary that defines the active metric contract
  - a promotion-gate summary that explains whether current evidence is good enough for registration
  - a run-comparison summary that explains whether the best action is promote / train again / collect more data / observe, including champion / challenger context
  - one active-learning pool summary that explains which low-confidence / likely-error samples should be mined next and how they are clustered
- the product must expose both `/vision/tasks` and `/vision/tasks/:taskId` so engineers can reopen or continue the workflow outside the original chat turn
- `/vision/tasks` should feel like an operator inbox rather than a plain run table:
  - the first visible control should be an agent-mode panel for the highest-priority task, so the operator can understand the goal, evidence, and next step before scanning the table
  - blocked tasks
  - tasks currently training
  - tasks ready for the next agent-guided operator action
- task detail must provide one obvious follow-up action at each stage:
  - fix missing requirements
  - start or continue the next round
  - register the model version after metrics pass
  - mine badcases into a feedback dataset after registration
- task detail should also explain data quality pressure in one compact operator-readable block, so engineers can tell when “collect data” is a justified recommendation instead of a vague fallback
- when a task already has linked inference evidence, badcase mining should prefer a diversified candidate set rather than blindly taking the globally lowest scores from one failure mode
- training launches opened from `/training/jobs/new` with a goal prompt should bind back to the same `VisionTask` whenever possible, so the resulting run is not an orphaned job
- a linked training detail should expose one direct `Continue as agent` action:
  - if metrics passed, it may register the model version and auto-create the missing model draft when needed
  - if metrics did not pass, it may schedule the next round from the same task context
- auto-advance is allowed to choose the current best next step, but it must still respect the same training launch and model-registration safety gates as the manual path
- user-facing `Continue as agent` controls should call delivery mode by default so the agent attempts to produce the model version within bounded waits, instead of stopping after each intermediate mutation
- whenever runtime state changes, the linked `VisionTask` should refresh one explicit agent recommendation with:
  - recommended action
  - short summary
  - operator-facing rationale / evidence
  - whether the action still requires a visible confirmation click
- the same refresh should also produce:
  - one current promotion-gate result
  - one current run-comparison result based on linked training history

### FR-017 Smooth AI-Native Interaction System
- the product should feel closer to a conversational copilot than a traditional MLOps dashboard:
  - natural-language intent stays primary
  - compact action cards summarize mutations, missing inputs, created entities, and next steps
  - side panels and expert controls support inspection without stealing the primary flow
- major operations should provide immediate local feedback before backend completion:
  - optimistic draft state for user-submitted prompts, uploads, and job launch intent
  - non-jumping background refresh that updates only changed data
  - visible progress, cancellability, and retry paths for long-running jobs
- navigation should preserve context across modules:
  - dataset/version/task/job/model-version ids remain in query params or linked cards
  - returning from dataset, training, model version, inference, or feedback loops should not force the operator to reconstruct context
- UI surfaces should use one calm modern design system:
  - warm neutral canvas, restrained borders, compact typography, and one consistent primary blue
  - cards only for repeated items, modals, and framed tools; avoid nested card-heavy dashboards
  - dense operator surfaces should favor clear hierarchy, stable panels, and subtle motion over decorative spectacle
- the assistant must never hide uncertainty:
  - missing requirements are explicit
  - fallback/template/simulated outputs are labeled as non-real
  - agent recommendations show evidence and confirmation requirements

Reference planning document:
- `docs/visual-data-loop-evolution.md`

### FR-018 Frontend Reset: Agent Training Studio
- the authenticated frontend target is reset to the Agent Training Studio contract in `docs/frontend-reset.md`
- the Studio replaces the previous target direction of page-specific dashboards, global Pixel Workshop skinning, and Pixel Lab as a competing primary mode
- the first authenticated screen must be a usable agent workbench, not a landing page
- the Studio home must show:
  - one active objective
  - one current stage in the training loop
  - top stepper with current step, total steps, and completion hints
  - one recommended primary next action
  - evidence tied to real datasets, jobs, model versions, inference runs, runtime, workers, or governance records
  - OpenClaw/contextual assistant access without hiding the primary workflow
- all migrated routes must keep the AI-native hard requirements unchanged:
  - visible/deletable/status-aware attachments
  - top stepper for multi-step flows
  - advanced parameters collapsed by default
  - shared empty/loading/error/success semantics
  - explicit confirmation for high-risk mutations
- implementation must keep existing API, data, role, and ownership contracts unless `docs/data-model.md` and `docs/api-contract.md` are updated first

## 8. Non-Functional Requirements

### NFR-001 Performance
- page interactions under 2s for baseline operations
- long-running jobs have visible status transitions and logs
- interaction-critical UI should respond within 100-200ms locally where possible, then reconcile with backend state
- background refresh must avoid layout jumps and preserve active focus/input state

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
- Phase 5: vision-task orchestration hardening, pre-annotation scale-up, active learning, distributed execution

## 10. Out of Scope (Current Round)
- production-grade distributed training orchestration
- full collaborative annotation suite
- advanced benchmarking dashboards beyond baseline metrics
