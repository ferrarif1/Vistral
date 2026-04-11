# Vistral - AI-Native Visual Model Platform

## Overview
Vistral is an AI-native visual model platform that provides a natural language and attachment-driven interface for visual model interactions. Built on RVision's foundation, it supports two system roles (users and administrators) with comprehensive functionality for model hosting, training, approval, publishing, edge inference, and auditing.

## Vision
Unlike traditional dashboard-based interfaces, Vistral follows a conversational approach similar to ChatGPT, allowing users to interact with visual models through natural language and file attachments. The platform maintains RVision's core business logic while providing a modern, intuitive user experience across the entire site.

## Core Features
- Natural language interaction with visual models
- Attachment-driven workflows (images, documents, datasets)
- Two-role access model (users, admins) with ownership-based model permissions
- Model hosting and deployment
- Training pipeline management
- Approval and auditing workflows
- Edge inference capabilities
- Multi-step processes with progress indicators
- Advanced parameter controls (collapsed by default)
- Conversation attachments follow chat-style draft chips plus an on-demand tray, while keeping delete/status visibility
- Built-in UI language switch (Chinese default, English optional)

## Architecture
- Frontend: AI-native interface with conversational flow
- Backend: Model management, inference, and orchestration
- Infrastructure: Scalable deployment and edge computing support

## Getting Started
1. Clone the repository.
2. Read collaboration rules in `AGENTS.md`.
3. Review product contracts in:
   - `docs/prd.md`
   - `docs/ia.md`
   - `docs/flows.md`
   - `docs/data-model.md`
   - `docs/api-contract.md`
   - `docs/training-worker-onboarding.md`
   - `docs/training-platform-roadmap.md`
   - `docs/dataset-management.md`
   - `docs/visual-data-loop-evolution.md`
   - `docs/annotation-workflow.md`
   - `docs/model-runtime-architecture.md`
4. Follow the single Docker deployment path in `docs/deployment.docker.md`.
5. If a new request interrupts unfinished work, append a handoff entry to `docs/work-handoff.md` before switching context.

## Repository Working Model (How Codex should work in this repo)
- Collaboration and execution rules: `AGENTS.md`
- Product and engineering contracts: `docs/*`
- Reusable skills: `.agents/skills/`
- Delivery order: plan first, align contracts, then implement

## Contributing
Please read `docs/contributing.md` before opening a change.


## 中文文档
- 仓库说明（中文）：`README.zh-CN.md`
- 协作规则（中文）：`AGENTS.zh-CN.md`
- Setup（中文）：`docs/setup.zh-CN.md`
- Contributing（中文）：`docs/contributing.zh-CN.md`
- PRD（中文）：`docs/prd.zh-CN.md`
- IA（中文）：`docs/ia.zh-CN.md`
- Flows（中文）：`docs/flows.zh-CN.md`
- Data Model（中文）：`docs/data-model.zh-CN.md`
- API Contract（中文）：`docs/api-contract.zh-CN.md`

## License
License file is not yet added in this baseline; add one before production distribution.


## Docker Quick Start
1. `cp .env.example .env`
2. `npm run docker:up`
3. Open `http://127.0.0.1:8080`
4. Run `npm run docker:healthcheck`
5. Run `npm run docker:verify:full`
   - includes OCR fallback safety guard: failed local OCR command must return empty OCR output + explicit fallback markers, never hardcoded invoice-like text

Source-mode scripts such as `npm run dev`, `npm run dev:api`, and `npm run dev:web` remain available only for repository maintenance and debugging. They are not the primary product run path.

### Training Worker Deployment Kit
- Dedicated worker-side deployment/install assets are under `training-worker/`.
- Start with `training-worker/README.md`.
- Worker env template: `training-worker/.env.worker.example`.
- Worker scripts:
  - `training-worker/scripts/bootstrap-worker.sh`
  - `training-worker/scripts/worker-doctor.sh`
  - `training-worker/scripts/install-deps.sh`
  - `training-worker/scripts/worker-heartbeat.sh`
  - `training-worker/scripts/worker-train-api.py`
  - `training-worker/scripts/run-worker-node.sh`
- Cross-machine default: worker keeps `WORKER_USE_REQUEST_PATHS=false` and writes into local `WORKER_RUN_ROOT`.
- Existing local command templates remain in `scripts/local-runners/` (shared by control-plane runtime adapters).

### Auth (username/password)
- Login is username/password based.
- Public self-registration is disabled.
- Default seeded accounts in mock store:
  - `alice / mock-pass` (user)
  - `admin / mock-pass-admin` (admin)
- New accounts are provisioned by `admin` users from the authenticated settings surface.
- Every authenticated user can change their own password from account settings.
- Administrators can reset another user's password, disable/reactivate accounts, and inspect `last_login_at` from the same account directory.

### Validation Commands
- `npm run data:cleanup-test`
  - safely prunes extra prototype test artifacts (stale verify reports/runtime caches/log noise) while keeping active app-state references
- `npm run data:reset:foundation`
  - rewrites persisted app-state to a minimal baseline: keep accounts + curated foundation models, drop seeded/test runtime entities (datasets/items/annotations/versions/training/inference/audit noise)
  - also purges local runtime storage roots by default (`UPLOAD_STORAGE_ROOT`, `TRAINING_WORKDIR_ROOT`, `MODEL_EXPORT_ROOT`, `.data/runtime-local-predict`)
  - set `RESET_FOUNDATION_PURGE_STORAGE=0` to keep local files while only resetting app-state
- `npm run smoke:foundation-reset`
  - verifies both reset and minimal-bootstrap guards:
    - `data:reset:foundation` removes runtime seed/test entities while preserving curated foundation models
    - `APP_STATE_BOOTSTRAP_MODE=minimal` first bootstrap does not create dataset/training/inference seed rows
- `npm run smoke:adapter-no-placeholder`
  - verifies adapter anti-placeholder guarantees:
    - `evaluate()` reads file-backed metrics (or returns empty metrics when missing)
    - `export()` writes real local artifact path (no `/mock-artifacts/...`)
    - `load_model()` succeeds only with existing artifact and fails explicitly when missing
- `npm run smoke:training-template-guard`
  - verifies bundled local train runners (`yolo/paddleocr/doctr`) always emit explicit non-real evidence in template mode:
    - `mode=template`
    - `training_performed=false`
    - non-empty `fallback_reason` and `template_reason`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run smoke:auth-session`
  - verifies public registration is disabled, admin-only account provisioning works, account disable/reactivate + admin password reset rules hold, and per-user password change takes effect
- `npm run smoke:account-governance`
  - verifies admin account operations (`create`, `disable/reactivate`, `password-reset`), self-disable guard, session invalidation after disable, and user self password change
- `npm run smoke:phase2`
  - verifies segmentation annotation persistence, review-state contract guards (rejected reason required / approved reason forbidden), rework latest-review context retention, training launch readiness gates (`train split > 0`, `annotation_coverage > 0`, and dataset-version ownership under the selected dataset), plus YOLO/PaddleOCR/docTR runtime fallback behavior in the mock loop
- `npm run smoke:attachments`
  - verifies multipart upload/read/delete loops for conversation/model/dataset attachments
- `npm run smoke:conversation-context`
  - verifies conversation message attachment order follows the selected context order
- `npm run smoke:conversation-actions`
  - verifies conversation can request missing fields and then create real dataset/model-draft/training-job entities via backend APIs
  - when `EXPECTED_TRAINING_DATASET_ID` / `EXPECTED_TRAINING_DATASET_VERSION_ID` are not provided, it auto-prepares a trainable detection dataset/version target by default (`AUTO_PREPARE_TRAINING_TARGET=true`)
- `npm run smoke:conversation-ops-bridge`
  - validates natural-language ops bridge end-to-end: intent routing, missing-field prompts, follow-up parameter completion, and high-risk confirmation gate
- `npm run smoke:runtime-profile-activation`
  - validates runtime profile activation from env-provided profiles: profile list visibility, `active_profile_id` switch, and activated framework config projection in response view
- `npm run smoke:inference-feedback-guard`
  - verifies `POST /api/inference/runs/{id}/feedback` for both detection and OCR loops: rejects cross-task datasets, accepts matching-task datasets, and keeps dataset item/attachment traceability
  - validates idempotency for repeated feedback on the same run+dataset (no duplicate dataset items; metadata reason is updated)
  - validates dataset-scoped attachment reuse when run input attachment already belongs to target dataset (no cloned attachment)
  - validates feedback metadata integrity (`inference_run_id`, `source_attachment_id`, `feedback_reason`) on created/upserted dataset items
  - by default auto-prepares dedicated feedback datasets (`AUTO_PREPARE_FEEDBACK_DATASETS=true`); can be overridden via `EXPECTED_VALID_FEEDBACK_DATASET_ID`, `EXPECTED_OCR_FEEDBACK_DATASET_ID`, and `EXPECTED_MISMATCH_FEEDBACK_DATASET_ID`
- `npm run smoke:no-seed-hardcoding`
  - guards against hardcoded seed entity ids (`d-*`, `dv-*`, `mv-*`, `f-*`, etc.) in smoke/verify scripts so deployment-mode tests stay portable
- `npm run smoke:core-closure`
  - runs the core closure suite (`no-seed-hardcoding` + `foundation-reset` + `adapter-no-placeholder` + `training-template-guard` + `model-version-register-gate` + `account-governance` + `phase2` + `conversation-actions` + `inference-feedback-guard` + `real-closure` + `ocr-closure` + `training-worker-dedicated-auth`) in one command
- `npm run smoke:llm-settings`
  - verifies LLM settings save/edit/clear flow, including keeping the saved key while editing and loading encrypted config after API restart
- `npm run smoke:runtime-settings-persistence`
  - verifies runtime settings save/reload/clear flow (including encrypted persistence across API restart and adapter fallback to env defaults after clear)
- `npm run smoke:runtime-success`
  - verifies YOLO/PaddleOCR/docTR runtime success path with a local runtime mock server
- `npm run smoke:ocr-fallback-guard`
  - verifies OCR fallback safety contract end-to-end:
    - local command failure returns empty OCR lines/words (no hardcoded business text)
    - fallback metadata includes reason/framework/platform/attempted command
    - template runner emits explicit placeholder text (`TEMPLATE_OCR_LINE_1/2`) with fallback/template reasons
    - inference validation page warning markers are present for fallback/template outputs
- `npm run smoke:admin:verification-reports`
  - verifies `/api/admin/verification-reports` permission boundary (`user` denied, `admin` allowed)
- `npm run smoke:demo:train-data`
  - imports local files via real multipart upload into a new detection dataset, waits for upload lifecycle completion, then creates split + dataset version
- `npm run smoke:ocr-closure`
  - validates a dedicated OCR closure on real uploaded data: OCR import -> PaddleOCR/docTR local-command training -> metrics/artifact summary -> model-version register -> inference upload/run
  - default is strict local-command assertions; use `OCR_CLOSURE_STRICT_LOCAL_COMMAND=false npm run smoke:ocr-closure` for fallback-tolerant checks
  - to enforce non-template/non-fallback OCR evidence, run `OCR_CLOSURE_REQUIRE_REAL_MODE=true npm run smoke:ocr-closure` (auto-enables `VISTRAL_RUNNER_ENABLE_REAL=1`)
  - by default this smoke prefers `.data/runtime-python/.venv/bin/python` when present; override with `PYTHON_BIN=/path/to/python`
  - closure now generates a synthetic OCR text image by default for stable real-mode metric checks (`OCR_CLOSURE_GENERATE_TEXT_SAMPLE=false` to disable)
  - for slow first-time model warmup, tune wait with `OCR_CLOSURE_WAIT_POLLS` and `OCR_CLOSURE_WAIT_SLEEP_SEC`
- `npm run smoke:real-closure`
  - validates a more complete real closure: requirement draft -> dataset upload/import/export -> YOLO training -> model version register -> YOLO/PaddleOCR/docTR inference -> detection/OCR feedback loops with dataset traceability
  - by default this smoke prefers `.data/runtime-python/.venv/bin/python` when present; override with `PYTHON_BIN=/path/to/python`
  - closure now generates a synthetic OCR text image by default for stable OCR train/inference checks (`REAL_CLOSURE_GENERATE_TEXT_SAMPLE=false` to disable)
  - to enforce non-template/non-fallback OCR evidence, run `REAL_CLOSURE_REQUIRE_REAL_MODE=true npm run smoke:real-closure` (auto-enables `VISTRAL_RUNNER_ENABLE_REAL=1`)
  - for slow first-time model warmup, tune wait with `REAL_CLOSURE_YOLO_WAIT_POLLS`/`REAL_CLOSURE_YOLO_WAIT_SLEEP_SEC` and `REAL_CLOSURE_DOCTR_WAIT_POLLS`/`REAL_CLOSURE_DOCTR_WAIT_SLEEP_SEC`
- `npm run smoke:restart-resume`
  - verifies app-state persistence and automatic training-job resume after API restart
- `npm run smoke:local-command`
  - verifies YOLO local train/predict command adapters (`*_LOCAL_*_COMMAND`) and real metric/source plumbing
- `npm run smoke:execution-fields`
  - verifies explicit persistence contract for `training_jobs.execution_mode` and `inference_runs.execution_source`
- `npm run smoke:runner-real-fallback`
  - verifies `VISTRAL_RUNNER_ENABLE_REAL=1` fallback behavior (`meta.mode=template` + `meta.fallback_reason`) when real dependencies/model path are unavailable
- `npm run smoke:runner-real-upload`
  - verifies real file upload path + YOLO real-runner fallback reason (`model_path_not_found`) under `VISTRAL_RUNNER_ENABLE_REAL=1`
- `npm run smoke:runner-real-positive`
  - optional positive test for real YOLO branch (`meta.mode=real`); skips automatically when model/dependency prerequisites are missing
- `npm run doctor:real-training-readiness`
  - checks whether current machine is ready for real local training/inference branch (`ultralytics`/`paddleocr`/`doctr` + `VISTRAL_YOLO_MODEL_PATH`)
- `npm run setup:real-training-env`
  - bootstraps a local Python venv, installs real-branch deps, and tries to prepare a YOLO weight file for positive real-mode checks
- `npm run smoke:runtime-metrics-retention`
  - verifies runtime metrics-retention summary endpoint and per-job series downsampling caps
- `npm run smoke:training-metrics-export`
  - verifies `/api/training/jobs/{id}/metrics-export` payload for metric timeline download
- `npm run smoke:training-metrics-export-csv`
  - verifies `/api/training/jobs/{id}/metrics-export?format=csv` download headers and csv rows
- `npm run smoke:dataset-export-roundtrip`
  - verifies YOLO/COCO/LabelMe/OCR export file content and cross-dataset export->import roundtrip (including segmentation polygon labelme loop)
- `npm run smoke:admin:verification-retention`
  - verifies `/api/admin/verification-reports` exposes `runtime_metrics_retention` from verify report JSON
- `npm run smoke:verify-report-retention-e2e`
  - runs `docker-verify-full` against local API and asserts `runtime_metrics_retention` is consistent between report file and admin API
- `npm run smoke:training-worker-dispatch`
  - validates scheduled worker jobs are dispatched to worker endpoint, worker response metrics are ingested, and training reaches `completed`
- `npm run smoke:training-worker-cancel`
  - validates cancel propagation for worker-running jobs (control-plane cancel -> worker cancel endpoint -> final `cancelled`)
- `npm run smoke:training-worker-failover`
  - validates worker dispatch failover path (first worker fails -> scheduler re-dispatches to another online worker -> job completes)
- `npm run smoke:training-worker-health-penalty`
  - validates scheduler health-penalty behavior across jobs (recently failed worker is deprioritized for subsequent scheduling)
- `npm run smoke:training-worker-package-reference`
  - forces reference package dispatch mode (`reference_json_v1`) and validates worker package download + training completion path
- `npm run smoke:training-worker-dedicated-auth`
  - validates bootstrap-issued dedicated worker auth end-to-end: claim -> heartbeat -> reference package dispatch -> cancel propagation
  - worker smoke scripts also accept `EXPECTED_TRAINING_DATASET_ID` / `EXPECTED_TRAINING_DATASET_VERSION_ID`; when omitted they auto-select a ready detection dataset + trainable version

### Prototype persistence and restart behavior
- Business state is persisted to local JSON snapshot file (`.data/app-state.json` by default).
- Configure path with `APP_STATE_STORE_PATH`.
- Flush interval is configurable with `APP_STATE_PERSIST_INTERVAL_MS` (minimum 400ms, default 1200ms).
- Bootstrap seed mode is configurable with `APP_STATE_BOOTSTRAP_MODE`:
  - `full` (default): prototype seed baseline
  - `minimal`: first bootstrap without existing app-state keeps only accounts + curated foundation models
- Verification report directory can be overridden by `VERIFICATION_REPORTS_DIR`.
- Training metric retention controls:
  - `TRAINING_METRICS_MAX_POINTS_PER_JOB` (default `180`)
  - `TRAINING_METRICS_MAX_TOTAL_ROWS` (default `20000`)
- On API restart, unfinished training jobs (`queued/preparing/running/evaluating`) are automatically re-queued and resumed by the local executor.
- LLM settings remain separately encrypted in `.data/llm-config.enc.json`.
- Optional local command adapters:
  - `YOLO_LOCAL_TRAIN_COMMAND`, `PADDLEOCR_LOCAL_TRAIN_COMMAND`, `DOCTR_LOCAL_TRAIN_COMMAND`
  - `YOLO_LOCAL_PREDICT_COMMAND`, `PADDLEOCR_LOCAL_PREDICT_COMMAND`, `DOCTR_LOCAL_PREDICT_COMMAND`
  - optional bundled-runner python override: `VISTRAL_PYTHON_BIN` (fallbacks: `PYTHON_BIN`, then platform default `python3`/`python`)
  - command timeout: `LOCAL_RUNNER_TIMEOUT_MS`
  - strict non-simulated train fallback switch: `VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK=1` (fail fast when local runner command is missing/unavailable)
  - strict non-fallback inference switch: `VISTRAL_DISABLE_INFERENCE_FALLBACK=1` (runtime/local predict must return real output; template/fallback outputs are rejected)
  - optional real-runner switch: `VISTRAL_RUNNER_ENABLE_REAL=1`
  - optional real-runner hints:
    - `VISTRAL_YOLO_MODEL_PATH`
    - `VISTRAL_PADDLEOCR_LANG`, `VISTRAL_PADDLEOCR_USE_GPU`
    - `VISTRAL_DOCTR_DET_ARCH`, `VISTRAL_DOCTR_RECO_ARCH`
  - reusable runner templates: `scripts/local-runners/`
  - template placeholders include `{{python_bin}}`, `{{repo_root}}`, `{{job_id}}`, `{{dataset_id}}`, `{{task_type}}`, `{{metrics_path}}`, `{{output_path}}`
- Worker dispatch controls:
  - `TRAINING_WORKER_SHARED_TOKEN`
  - `TRAINING_WORKER_HEARTBEAT_TTL_MS`
  - `TRAINING_WORKER_DISPATCH_TIMEOUT_MS`
  - `TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL`
  - `TRAINING_WORKER_DISPATCH_MAX_ATTEMPTS`
  - `TRAINING_WORKER_DISPATCH_RETRY_BASE_MS`
  - `TRAINING_WORKER_FAILURE_PENALTY_WINDOW_MS`
  - `TRAINING_WORKER_FAILURE_COOLDOWN_MS`
  - `TRAINING_WORKER_FAILURE_PENALTY_STEP`
  - `TRAINING_WORKER_FAILURE_PENALTY_CAP`
  - `TRAINING_WORKER_INLINE_PACKAGE_MAX_FILES`
  - `TRAINING_WORKER_INLINE_PACKAGE_MAX_BYTES`
  - `TRAINING_WORKER_DISPATCH_BASE_URL` (required when dispatch switches to reference package mode)
  - `TRAINING_WORKER_PACKAGE_STORAGE_ROOT`
  - `TRAINING_WORKER_PACKAGE_TTL_MS`
  - `TRAINING_WORKER_REFERENCE_PACKAGE_MAX_FILES`
  - `TRAINING_WORKER_REFERENCE_PACKAGE_MAX_BYTES`

### Implemented in this round
- Shared app shell and unified theme
- Two workspace routes: AI-native conversation workspace + professional console
- Conversation workflow with attachment upload/status/delete and assistant responses
  - conversation workspace now uses an immersive chat-style shell (left chat sidebar + centered timeline + floating composer)
  - attachment controls include local file picker, open/preview support, and in-context include/exclude actions
  - conversation attachments now behave like a chat-style draft flow: selected chips stay with the current draft, and the full attachment tray opens only on demand
- Bring-your-own LLM settings page (`/settings/llm`) for OpenAI-compatible providers (for example ChatAnywhere)
- Runtime settings page (`/settings/runtime`) for in-app runtime connectivity diagnostics and integration templates
- Model pages: explore / my-models / create (stepper + advanced collapsed)
- Auth mock: login/logout with browser session cookie, admin-only account provisioning, and per-user password change
- Admin approval queue page (`/admin/models/pending`) with approve/reject actions
- Admin audit page (`/admin/audit`) for governance event visibility
- Admin verification reports page (`/admin/verification-reports`) for deployment acceptance evidence
  - includes filter/search/date-range/sort, quick range shortcuts (7/30 days), pagination, collapsible check details, and filtered JSON export
- Ownership-based model filtering and create permission via capabilities
- Initial schema in `db/schema.sql`
- Inference page runtime diagnostics panel (in-app connectivity check for PaddleOCR/docTR/YOLO)

### LLM Key Safety
- Do not commit API keys into repository files.
- LLM key configuration is encrypted at rest in local prototype data (`.data/llm-config.enc.json`) using `LLM_CONFIG_SECRET`.
- Browser holds only masked key view; raw key is submitted on save/test and managed server-side for this prototype.
- Ensure `.data/` remains git-ignored and set `LLM_CONFIG_SECRET` before local usage.
- For ChatAnywhere compatibility, `Base URL` accepts:
  - `https://api.chatanywhere.tech/v1`
  - `https://api.chatanywhere.tech/v1/chat/completions`
- Mutating API calls in prototype mode are protected with `X-CSRF-Token` tied to session.
- Error responses follow contract-aligned status/code semantics (e.g. `INSUFFICIENT_PERMISSIONS` => `403`).
  - classification is pattern-first to reduce future unmapped errors.


## Docker Deployment
- Quick guide: `docs/deployment.docker.md`
- Copy env template: `cp .env.example .env` (update secrets if needed)
- Start/update full stack (pure Docker single entry): `npm run docker:up`
- Deployment self-check: `npm run docker:healthcheck`
- Full deployment E2E verify: `npm run docker:verify:full`
  - covers auth/permissions, account governance checks, real multipart attachment lifecycle, conversation operational actions (dataset/model-draft/training-job creation), approval + inference feedback, phase2 annotation/review + training launch-readiness gates, dataset export/import roundtrip (detection/ocr/segmentation), detection real-closure smoke, dedicated OCR closure smoke, and dedicated training-worker auth dispatch/cancel smoke
  - default runs OCR closure in non-strict mode (`OCR_CLOSURE_STRICT_LOCAL_COMMAND=false`) for deployment compatibility
  - optional strict OCR closure in full verify: `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run docker:verify:full`
  - if your Docker runtime cannot resolve `host.docker.internal`, set `DEDICATED_AUTH_WORKER_PUBLIC_HOST` (and optionally `DEDICATED_AUTH_WORKER_BIND_HOST`) before running full verify
- E2E verify outputs report files under `.data/verify-reports/` (JSON + Markdown)
- Web entry: `http://127.0.0.1:8080`
- API health: `http://127.0.0.1:8080/api/health`
- Stop: `docker compose down`

Docker services:
- `vistral-web`: nginx serving frontend + reverse proxy for `/api/*`
- `vistral-api`: Node backend runtime (session auth, mock workflows, runtime bridge diagnostics)
