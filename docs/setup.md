# Setup Guide

## 1) Prerequisites
- Git
- A POSIX shell environment
- Your preferred editor/IDE
- Node.js 20+
- npm 10+

## 2) Clone
```bash
git clone <your-fork-or-origin-url>
cd Vistral
```

## 3) Read Before Coding
Follow this order before making changes:
1. `README.md`
2. `AGENTS.md`
3. `.codex/config.toml`
4. `docs/prd.md`
5. `docs/ia.md`
6. `docs/flows.md`
7. `docs/data-model.md`
8. `docs/api-contract.md`

## 4) Local development
```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

## 5) Docker deployment (intranet-ready)
```bash
cp .env.example .env
docker compose up --build -d
```

Open `http://127.0.0.1:8080`.

If deployment host cannot build/pull from Docker Hub, use prebuilt registry images:
```bash
docker compose -f docker-compose.registry.yml up -d
```

Useful deployment helpers:
```bash
npm run docker:images:build
npm run docker:images:build-push
npm run docker:images:save
IMAGE_TAR=vistral-images-round1.tar npm run docker:images:load-up
npm run docker:healthcheck
npm run docker:verify:full
npm run docker:release:bundle
VERIFY_BASE_URL=http://127.0.0.1:8080 npm run docker:release:bundle:verified
npm run smoke:admin:verification-reports
npm run smoke:demo:train-data
npm run smoke:restart-resume
npm run smoke:local-command
npm run smoke:execution-fields
npm run smoke:runner-real-fallback
npm run smoke:runner-real-upload
npm run smoke:runner-real-positive
npm run smoke:runtime-metrics-retention
npm run smoke:training-metrics-export
npm run smoke:training-metrics-export-csv
npm run smoke:admin:verification-retention
npm run smoke:verify-report-retention-e2e
```

Optional positive real-runner validation:
- `REAL_YOLO_MODEL_PATH=/abs/path/to/yolo.pt npm run smoke:runner-real-positive`
- Script auto-skips when model file or `ultralytics` dependency is missing.

Persistence-related env vars (prototype):
- `UPLOAD_STORAGE_ROOT` (default `.data/uploads`)
- `TRAINING_WORKDIR_ROOT` (default `.data/training-jobs`)
- `APP_STATE_STORE_PATH` (default `.data/app-state.json`)
- `APP_STATE_PERSIST_INTERVAL_MS` (default `1200`, min `400`)
- `VERIFICATION_REPORTS_DIR` (default `.data/verify-reports`)
- `TRAINING_METRICS_MAX_POINTS_PER_JOB` (default `180`)
- `TRAINING_METRICS_MAX_TOTAL_ROWS` (default `20000`)
- `YOLO_LOCAL_TRAIN_COMMAND` / `PADDLEOCR_LOCAL_TRAIN_COMMAND` / `DOCTR_LOCAL_TRAIN_COMMAND`
- `YOLO_LOCAL_PREDICT_COMMAND` / `PADDLEOCR_LOCAL_PREDICT_COMMAND` / `DOCTR_LOCAL_PREDICT_COMMAND`
- `LOCAL_RUNNER_TIMEOUT_MS` (default `1800000`)
- `VISTRAL_RUNNER_ENABLE_REAL` (set `1` to attempt real framework branch in local runners)
- `VISTRAL_YOLO_MODEL_PATH`
- `VISTRAL_PADDLEOCR_LANG` / `VISTRAL_PADDLEOCR_USE_GPU`
- `VISTRAL_DOCTR_DET_ARCH` / `VISTRAL_DOCTR_RECO_ARCH`
- local command templates are available under `scripts/local-runners/`
- placeholder examples: `{{repo_root}}`, `{{job_id}}`, `{{dataset_id}}`, `{{task_type}}`, `{{metrics_path}}`, `{{output_path}}`

`docker:verify:full` writes audit-style reports to `.data/verify-reports/`.
`docker:release:bundle` accepts optional gates:
- `VERIFY_REPORT_PATH=<report.json|report.md>` include specific report files
- `VERIFY_REPORT_MAX_AGE_SECONDS=<seconds>` fail if selected report is too old

## 6) Baseline Validation
For docs-focused changes, run at least:
```bash
rg "docs/setup.md|docs/contributing.md" README.md
```

Then manually verify any links you touched are valid repository paths.

For code changes, run:
```bash
npm run typecheck
npm run lint
npm run build
```

## 7) Demo Dataset Import (train images)
Use local images under `demo_data/train` to quickly build a detection dataset in mock mode:
```bash
npm run smoke:demo:train-data
```

Optional controls:
- `MAX_FILES=120 npm run smoke:demo:train-data` limit uploaded files (0 means all files)
- `START_API=false BASE_URL=http://127.0.0.1:8080 npm run smoke:demo:train-data` reuse an already running API
