# Setup Guide

## 1) Prerequisites
- Git
- A POSIX shell environment
- Your preferred editor/IDE
- Docker Engine + Docker Compose

Optional for repository maintenance only:
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

## 4) Single Docker Path
```bash
cp .env.example .env
npm run docker:up
```

Open `http://127.0.0.1:8080`.

Recommended verification:
```bash
npm run docker:healthcheck
npm run docker:verify:full
```

## 5) Optional source-mode maintenance
This mode is kept only for internal repository debugging and Codex maintenance. It is not the primary product run path.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

Useful deployment helpers:
```bash
npm run docker:healthcheck
npm run docker:verify:full
npm run smoke:account-governance
npm run smoke:admin:verification-reports
npm run smoke:conversation-actions
npm run smoke:demo:train-data
npm run smoke:ocr-closure
npm run smoke:real-closure
npm run smoke:inference-feedback-guard
npm run smoke:no-seed-hardcoding
npm run smoke:core-closure
npm run smoke:restart-resume
npm run smoke:local-command
npm run smoke:execution-fields
npm run smoke:runner-real-fallback
npm run smoke:runner-real-upload
npm run smoke:runner-real-positive
npm run smoke:runtime-metrics-retention
npm run smoke:training-metrics-export
npm run smoke:training-metrics-export-csv
npm run smoke:dataset-export-roundtrip
npm run smoke:admin:verification-retention
npm run smoke:verify-report-retention-e2e
```

`smoke:conversation-actions` environment knobs:
- `EXPECTED_TRAINING_DATASET_ID`
- `EXPECTED_TRAINING_DATASET_VERSION_ID`
- `AUTO_PREPARE_TRAINING_TARGET` (default `true`)

`smoke:inference-feedback-guard` environment knobs:
- `EXPECTED_VALID_FEEDBACK_DATASET_ID`
- `EXPECTED_OCR_FEEDBACK_DATASET_ID`
- `EXPECTED_MISMATCH_FEEDBACK_DATASET_ID`
- `AUTO_PREPARE_FEEDBACK_DATASETS` (default `true`)

`smoke:dataset-export-roundtrip` currently covers:
- detection: yolo/coco/labelme export->import roundtrip
- ocr: ocr export->import roundtrip
- segmentation: labelme polygon export->import roundtrip

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
- bundled runner templates under `scripts/local-runners/` are used by default when explicit local command env vars are not set
- `VISTRAL_RUNNER_ENABLE_REAL` (set `1` to attempt dependency-backed real framework branch in local runners; default keeps template mode)
- `VISTRAL_YOLO_MODEL_PATH`
- `VISTRAL_PADDLEOCR_LANG` / `VISTRAL_PADDLEOCR_USE_GPU`
- `VISTRAL_DOCTR_DET_ARCH` / `VISTRAL_DOCTR_RECO_ARCH`
- local command templates are available under `scripts/local-runners/`
- placeholder examples: `{{repo_root}}`, `{{job_id}}`, `{{dataset_id}}`, `{{task_type}}`, `{{metrics_path}}`, `{{output_path}}`

`docker:verify:full` writes audit-style reports to `.data/verify-reports/`.
It now also validates account governance, conversation operational actions, phase2 annotation/review + launch-readiness gates (including dataset-version ownership under the selected dataset), dataset export/import roundtrip (detection/ocr/segmentation), and runs real closure smoke with YOLO/PaddleOCR/docTR against the target deployment.
By default it runs OCR closure in non-strict mode (`OCR_CLOSURE_STRICT_LOCAL_COMMAND=false`) so deployment verification can tolerate simulated fallback when local commands are unavailable.

Strict OCR closure options:
- `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run smoke:ocr-closure`
- `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run docker:verify:full`

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
Use local images under `demo_data/train` to quickly build a detection dataset with real file upload:
```bash
npm run smoke:demo:train-data
```

Optional controls:
- `MAX_FILES=120 npm run smoke:demo:train-data` limit uploaded files (0 means all files)
- `START_API=false BASE_URL=http://127.0.0.1:8080 npm run smoke:demo:train-data` reuse an already running API
- `START_API=false BASE_URL=http://127.0.0.1:8080 AUTH_USERNAME=alice AUTH_PASSWORD=mock-pass npm run smoke:demo:train-data` reuse deployed API with authenticated session

## 8) Real Closure Smoke (upload -> import -> train -> version -> inference -> feedback)
Run a stronger end-to-end smoke check:
```bash
npm run smoke:real-closure
```
This check now includes:
- YOLO detection training + registration + inference + feedback loop
- PaddleOCR OCR inference
- docTR OCR training + registration + inference

Optional controls:
- `START_API=false BASE_URL=http://127.0.0.1:8080 AUTH_USERNAME=alice AUTH_PASSWORD=mock-pass npm run smoke:real-closure`
