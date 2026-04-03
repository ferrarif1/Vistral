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
- Persistent file upload states (visible, deletable, status-indicated)
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
   - `docs/training-platform-roadmap.md`
   - `docs/dataset-management.md`
   - `docs/annotation-workflow.md`
   - `docs/model-runtime-architecture.md`
4. Follow local setup instructions in `docs/setup.md`.
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


## Development (Round 1 Baseline)
1. `npm install`
2. `npm run dev` (runs API + web together)
3. Open `http://127.0.0.1:5173`

### Auth (username/password)
- Public registration and login are username/password based.
- Default seeded accounts in mock store:
  - `alice / mock-pass` (user)
  - `admin / mock-pass-admin` (admin)
- Public registration always creates role `user`; it never creates `admin`.

### Validation Commands
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run smoke:phase2`
  - verifies segmentation annotation persistence plus YOLO/PaddleOCR/docTR runtime fallback behavior in the mock loop
- `npm run smoke:attachments`
  - verifies multipart upload/read/delete loops for conversation/model/dataset attachments
- `npm run smoke:conversation-context`
  - verifies conversation message attachment order follows the selected context order
- `npm run smoke:runtime-success`
  - verifies YOLO/PaddleOCR/docTR runtime success path with a local runtime mock server
- `npm run smoke:admin:verification-reports`
  - verifies `/api/admin/verification-reports` permission boundary (`user` denied, `admin` allowed)
- `npm run smoke:demo:train-data`
  - imports images from `demo_data/train` into a new detection dataset, waits for upload lifecycle completion, then creates split + dataset version
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
- `npm run smoke:runtime-metrics-retention`
  - verifies runtime metrics-retention summary endpoint and per-job series downsampling caps
- `npm run smoke:training-metrics-export`
  - verifies `/api/training/jobs/{id}/metrics-export` payload for metric timeline download
- `npm run smoke:training-metrics-export-csv`
  - verifies `/api/training/jobs/{id}/metrics-export?format=csv` download headers and csv rows
- `npm run smoke:admin:verification-retention`
  - verifies `/api/admin/verification-reports` exposes `runtime_metrics_retention` from verify report JSON
- `npm run smoke:verify-report-retention-e2e`
  - runs `docker-verify-full` against local API and asserts `runtime_metrics_retention` is consistent between report file and admin API

### Prototype persistence and restart behavior
- Business state is persisted to local JSON snapshot file (`.data/app-state.json` by default).
- Configure path with `APP_STATE_STORE_PATH`.
- Flush interval is configurable with `APP_STATE_PERSIST_INTERVAL_MS` (minimum 400ms, default 1200ms).
- Verification report directory can be overridden by `VERIFICATION_REPORTS_DIR`.
- Training metric retention controls:
  - `TRAINING_METRICS_MAX_POINTS_PER_JOB` (default `180`)
  - `TRAINING_METRICS_MAX_TOTAL_ROWS` (default `20000`)
- On API restart, unfinished training jobs (`queued/preparing/running/evaluating`) are automatically re-queued and resumed by the local executor.
- LLM settings remain separately encrypted in `.data/llm-config.enc.json`.
- Optional local command adapters:
  - `YOLO_LOCAL_TRAIN_COMMAND`, `PADDLEOCR_LOCAL_TRAIN_COMMAND`, `DOCTR_LOCAL_TRAIN_COMMAND`
  - `YOLO_LOCAL_PREDICT_COMMAND`, `PADDLEOCR_LOCAL_PREDICT_COMMAND`, `DOCTR_LOCAL_PREDICT_COMMAND`
  - command timeout: `LOCAL_RUNNER_TIMEOUT_MS`
  - optional real-runner switch: `VISTRAL_RUNNER_ENABLE_REAL=1`
  - optional real-runner hints:
    - `VISTRAL_YOLO_MODEL_PATH`
    - `VISTRAL_PADDLEOCR_LANG`, `VISTRAL_PADDLEOCR_USE_GPU`
    - `VISTRAL_DOCTR_DET_ARCH`, `VISTRAL_DOCTR_RECO_ARCH`
  - reusable runner templates: `scripts/local-runners/`
  - template placeholders include `{{repo_root}}`, `{{job_id}}`, `{{dataset_id}}`, `{{task_type}}`, `{{metrics_path}}`, `{{output_path}}`

### Implemented in this round
- Shared app shell and unified theme
- Dual work entry: AI-native conversation workspace + professional console
- Conversation workflow with attachment upload/status/delete and assistant responses
  - conversation workspace now uses an immersive chat-style shell (left chat sidebar + centered timeline + floating composer)
  - attachment controls include local file picker, open/preview support, and in-context include/exclude actions
  - current-message attachment context now has explicit selection chips, quick include-all-ready, and clear-context actions
- Bring-your-own LLM settings page (`/settings/llm`) for OpenAI-compatible providers (for example ChatAnywhere)
- Runtime settings page (`/settings/runtime`) for in-app runtime connectivity diagnostics and integration templates
- Model pages: explore / my-models / create (stepper + advanced collapsed)
- Auth mock: login/register/logout with browser session cookie (`register` cannot create `admin`)
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
- Start full stack: `docker compose up --build -d`
- Internal registry mode (no local build): `docker compose -f docker-compose.registry.yml up -d`
- Build images helper: `npm run docker:images:build`
- Build and push helper: `npm run docker:images:build-push`
- Offline export helper: `npm run docker:images:save`
- Offline import + up helper: `npm run docker:images:load-up`
- Deployment self-check: `npm run docker:healthcheck`
- Full deployment E2E verify: `npm run docker:verify:full`
- Release bundle generator: `npm run docker:release:bundle`
- Release bundle with fresh verification: `VERIFY_BASE_URL=http://127.0.0.1:8080 npm run docker:release:bundle:verified`
- Pin report for bundle: `VERIFY_REPORT_PATH=.data/verify-reports/<report>.json npm run docker:release:bundle`
- Enforce report freshness: `VERIFY_REPORT_MAX_AGE_SECONDS=1800 npm run docker:release:bundle`
- E2E verify outputs report files under `.data/verify-reports/` (JSON + Markdown)
- Web entry: `http://127.0.0.1:8080`
- API health: `http://127.0.0.1:8080/api/health`
- Stop: `docker compose down`

Docker services:
- `vistral-web`: nginx serving frontend + reverse proxy for `/api/*`
- `vistral-api`: Node backend runtime (session auth, mock workflows, runtime bridge diagnostics)
