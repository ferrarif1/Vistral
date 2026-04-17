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

Worker-machine deployment/install assets are centralized in:
- `training-worker/README.md`
- `training-worker/.env.worker.example`
- `training-worker/scripts/install-deps.sh`
- `training-worker/scripts/worker-heartbeat.sh`
- `training-worker/scripts/worker-train-api.py`
- `training-worker/scripts/run-worker-node.sh`
- recommended for cross-machine deployment: keep worker `WORKER_USE_REQUEST_PATHS=false` so worker uses local `WORKER_RUN_ROOT`

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
npm run data:cleanup-test
npm run data:reset:foundation
npm run smoke:foundation-reset
npm run smoke:adapter-no-placeholder
npm run smoke:training-template-guard
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
npm run smoke:ocr-fallback-guard
npm run smoke:training-metrics-export
npm run smoke:training-metrics-export-csv
npm run smoke:dataset-export-roundtrip
npm run smoke:training-worker-scheduler
npm run smoke:training-worker-dispatch
npm run smoke:training-worker-cancel
npm run smoke:admin:verification-retention
npm run smoke:verify-report-retention-e2e
```

`smoke:conversation-actions` environment knobs:
- `EXPECTED_TRAINING_DATASET_ID`
- `EXPECTED_TRAINING_DATASET_VERSION_ID`
- `AUTO_PREPARE_TRAINING_TARGET` (default `true`)

Worker scheduler/dispatch/cancel/failover/package/dedicated-auth smoke knobs:
- `EXPECTED_TRAINING_DATASET_ID`
- `EXPECTED_TRAINING_DATASET_VERSION_ID`
  - when omitted, scripts auto-select a ready detection dataset + trainable version (`split_summary.train > 0` and `annotation_coverage > 0`)

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
- `YOLO_LOCAL_MODEL_PATH=/abs/path/to/yolo.pt npm run smoke:runner-real-positive`
- for stable PaddleOCR local runtime, prefer dependency combo:
  - `python3 -m pip install --extra-index-url https://download.pytorch.org/whl/cpu "numpy==1.26.4" "paddlepaddle==3.2.0" "paddleocr==3.4.0" "torch==2.5.1+cpu" "torchvision==0.20.1+cpu" "ultralytics==8.4.37" "python-doctr==1.0.1"`
- Script auto-skips when model file or `ultralytics` dependency is missing.

Persistence-related env vars (prototype):
- `UPLOAD_STORAGE_ROOT` (default `.data/uploads`)
- `TRAINING_WORKDIR_ROOT` (default `.data/training-jobs`)
- `APP_STATE_STORE_PATH` (default `.data/app-state.json`)
- `APP_STATE_PERSIST_INTERVAL_MS` (default `1200`, min `400`)
- `APP_STATE_BOOTSTRAP_MODE` (`full` default | `minimal`)
  - `minimal` only affects first bootstrap when `APP_STATE_STORE_PATH` does not exist yet
  - for existing state files, use `npm run data:reset:foundation` to clean test/seed runtime records while keeping account + curated foundation model baseline
- `RESET_FOUNDATION_PURGE_STORAGE` (default `1` for `data:reset:foundation`)
  - `1`: reset state and purge local runtime storage roots
  - `0`: reset state only (keep local files)
- `VERIFICATION_REPORTS_DIR` (default `.data/verify-reports`)
- `TRAINING_METRICS_MAX_POINTS_PER_JOB` (default `180`)
- `TRAINING_METRICS_MAX_TOTAL_ROWS` (default `20000`)
- `YOLO_LOCAL_TRAIN_COMMAND` / `PADDLEOCR_LOCAL_TRAIN_COMMAND` / `DOCTR_LOCAL_TRAIN_COMMAND`
- `YOLO_LOCAL_PREDICT_COMMAND` / `PADDLEOCR_LOCAL_PREDICT_COMMAND` / `DOCTR_LOCAL_PREDICT_COMMAND`
- `VISTRAL_PYTHON_BIN` (optional python executable override for bundled local runners; Docker default is `/opt/vistral-venv/bin/python`)
- `API_NODE_BASE_IMAGE` (API image base; default `docker.m.daocloud.io/library/node:20-bookworm-slim`)
- `API_DEBIAN_APT_MIRROR` (API image apt mirror; default `http://mirrors.tuna.tsinghua.edu.cn/debian`)
- `API_DEBIAN_APT_SECURITY_MIRROR` (API image apt security mirror; default `http://mirrors.tuna.tsinghua.edu.cn/debian-security`)
- `API_PIP_INDEX_URL` (API image python package mirror; default `https://pypi.tuna.tsinghua.edu.cn/simple`)
- `API_PIP_EXTRA_INDEX_URL` (default `https://download.pytorch.org/whl/cpu`; used as default torch wheel index in Docker build)
- `API_PIP_TORCH_INDEX_URL` (optional explicit override for torch/torchvision wheel index; when empty, Docker build reuses `API_PIP_EXTRA_INDEX_URL`)
- `API_PIP_TRUSTED_HOST` (trusted host used with `API_PIP_INDEX_URL`; default `pypi.tuna.tsinghua.edu.cn`)
- `LOCAL_RUNNER_TIMEOUT_MS` (default `1800000`)
- `VISTRAL_AUTO_BOOTSTRAP_YOLO_MODEL` (default `1`; API startup auto-fetches `yolo11n.pt` from ModelScope when local YOLO model is missing)
- `VISTRAL_AUTO_BOOTSTRAP_PADDLEOCR_MODELS` (default `1`; API startup warms PaddleOCR models and writes bootstrap marker)
- `VISTRAL_AUTO_BOOTSTRAP_DOCTR_MODELS` (default `1`; API startup warms docTR models and writes bootstrap marker)
- `VISTRAL_RUNTIME_BOOTSTRAP_BLOCKING` (default `0`; `1` means API waits for bootstrap completion before listen)
- `VISTRAL_RUNTIME_BOOTSTRAP_TIMEOUT_MS` (default `180000`; timeout for startup runtime bootstrap tasks)
- `VISTRAL_RUNTIME_MODELS_ROOT` (default `.data/runtime-models`; runtime models/caches/markers root)
- `PADDLE_HOME` (default `.data/runtime-models/paddle-home`; persisted Paddle cache root)
- `HF_HOME` (default `.data/runtime-models/hf-home`; persisted HuggingFace cache root)
- `DOCTR_CACHE_DIR` (default `.data/runtime-models/doctr-cache`; persisted docTR cache root)
- `VISTRAL_DOCTR_PRESEEDED_MODELS_DIR` (default `.data/runtime-models/doctr-preseed`; optional local directory for preseeded docTR model files copied into `DOCTR_CACHE_DIR/models` before warmup)
- `VISTRAL_DOCTR_PRESEEDED_MODELS_URLS` (optional comma-separated model file URLs for pre-seeding docTR cache in restricted networks)
- `ULTRALYTICS_CONFIG_DIR` (default `.data/runtime-models/ultralytics`; persisted Ultralytics cache/config root)
- `VISTRAL_DISABLE_SIMULATED_TRAIN_FALLBACK` (`1` by default in the app runtime; set explicitly to `0` only if you intentionally want compatibility fallback when the local train runner command is missing/unavailable)
- `VISTRAL_DISABLE_INFERENCE_FALLBACK` (`1` by default in the app runtime; set explicitly to `0` only if you intentionally want template/fallback prediction output)
- bundled runner templates under `scripts/local-runners/` are used by default when explicit local command env vars are not set
- `VISTRAL_RUNTIME_AUTO_POPULATE_LOCAL_COMMANDS` (default `1`; auto-fills blank runtime local command fields with bundled templates in Runtime Settings/readiness)
- `VISTRAL_RUNTIME_AUTO_ENDPOINT_CANDIDATES_JSON` (optional JSON object to override/append endpoint probe candidates used by runtime auto-config, for example `{"yolo":["http://10.0.0.5:9394/predict"]}`)
- `VISTRAL_RUNNER_ENABLE_REAL` (default `auto`; bundled local runners attempt real execution unless explicitly disabled with `0/false/no/off/disabled`)
- `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK` (default `True`; disable Paddle model-source connectivity pre-check to reduce runtime jitter)
- `MODEL_VERSION_REGISTER_ALLOW_NON_REAL_LOCAL_COMMAND` (default `0`; when `0`, model-version registration rejects local-command jobs with template/fallback/non-real artifact evidence)
- `PADDLEOCR_LOCAL_MODEL_PATH`
- `DOCTR_LOCAL_MODEL_PATH`
- `YOLO_LOCAL_MODEL_PATH` (preferred; YOLO also accepts legacy `VISTRAL_YOLO_MODEL_PATH` / `REAL_YOLO_MODEL_PATH`)
- `VISTRAL_PADDLEOCR_LANG` / `VISTRAL_PADDLEOCR_USE_GPU`
- `VISTRAL_DOCTR_DET_ARCH` / `VISTRAL_DOCTR_RECO_ARCH`
- `TRAINING_WORKER_AUTH_TOKEN` (preferred for `/api/runtime/training-workers/heartbeat`; shared fallback remains optional)
- `TRAINING_WORKER_HEARTBEAT_TTL_MS` (default `45000`, stale heartbeat threshold for scheduling)
- `TRAINING_WORKER_DISPATCH_TIMEOUT_MS` (default `1800000`, control-plane -> worker train dispatch timeout)
- `TRAINING_WORKER_DISPATCH_FALLBACK_LOCAL` (default `1`, allow local fallback when worker dispatch fails)
- `TRAINING_WORKER_INLINE_PACKAGE_MAX_FILES` (default `800`, max file count for inline dataset package sent to worker)
- `TRAINING_WORKER_INLINE_PACKAGE_MAX_BYTES` (default `41943040`, max total bytes for inline dataset package sent to worker)
- local command templates are available under `scripts/local-runners/`
- placeholder examples: `{{python_bin}}`, `{{repo_root}}`, `{{job_id}}`, `{{dataset_id}}`, `{{task_type}}`, `{{metrics_path}}`, `{{output_path}}`

For restricted-network environments where `doctr-static.mindee.com` is unreachable:
- place predownloaded docTR model files (for default arches: `db_resnet50-79bd7d70.pt`, `vgg16_bn_r-d108c19c.pt`) under `VISTRAL_DOCTR_PRESEEDED_MODELS_DIR`, or
- set `VISTRAL_DOCTR_PRESEEDED_MODELS_URLS` to mirrored file URLs.
Startup bootstrap copies these files into `DOCTR_CACHE_DIR/models` before docTR warmup.

Docker compose shortcut:
- host folder `./runtime-assets/doctr-preseed` is mounted to `/app/runtime-preseed/doctr` (read-only).
- run `npm run setup:doctr-preseed` to check/download preseed files into that host folder.

`docker:verify:full` writes audit-style reports to `.data/verify-reports/`.
It now also validates account governance, conversation operational actions, phase2 annotation/review + launch-readiness gates (including dataset-version ownership under the selected dataset), dataset export/import roundtrip (detection/ocr/segmentation), dedicated training-worker auth dispatch/cancel flow, OCR fallback safety guard (no misleading default OCR business text on fallback), and runs real closure smoke with YOLO/PaddleOCR/docTR against the target deployment.
By default it runs OCR closure in non-strict mode (`OCR_CLOSURE_STRICT_LOCAL_COMMAND=false`) so deployment verification can tolerate simulated fallback when local commands are unavailable.
It also runs real closure with registration-gate tolerant mode (`REAL_CLOSURE_STRICT_REGISTRATION=false`):
- smoke still attempts model-version registration first;
- when registration is rejected by non-real gate evidence (`execution_mode` mismatch or template/fallback artifact evidence), closure logs `*_register_mode=blocked_gate_*` and continues with existing registered versions for downstream inference checks.
This keeps production gate strictness while reducing deployment-verify false negatives on environments without full local-training dependencies.
If your deployment environment cannot resolve `host.docker.internal`, set `DEDICATED_AUTH_WORKER_PUBLIC_HOST` (and optionally `DEDICATED_AUTH_WORKER_BIND_HOST`) before running full verify.

Strict OCR closure options:
- `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run smoke:ocr-closure`
- `OCR_CLOSURE_STRICT_LOCAL_COMMAND=true npm run docker:verify:full`

Strict real-closure registration option:
- `REAL_CLOSURE_STRICT_REGISTRATION=true npm run smoke:real-closure`

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
- `PYTHON_BIN=/path/to/python npm run smoke:real-closure` (override Python runtime; default prefers `.data/runtime-python/.venv/bin/python` when present)
- `REAL_CLOSURE_GENERATE_TEXT_SAMPLE=false npm run smoke:real-closure` (disable synthetic OCR text image generation)
- `REAL_CLOSURE_REQUIRE_REAL_MODE=true npm run smoke:real-closure` (require non-template/non-fallback OCR evidence; auto-enables `VISTRAL_RUNNER_ENABLE_REAL=1`)
- `REAL_CLOSURE_YOLO_WAIT_POLLS=360 REAL_CLOSURE_YOLO_WAIT_SLEEP_SEC=0.3 npm run smoke:real-closure` (tune YOLO training wait window)
- `REAL_CLOSURE_DOCTR_WAIT_POLLS=720 REAL_CLOSURE_DOCTR_WAIT_SLEEP_SEC=0.3 npm run smoke:real-closure` (tune docTR training wait window)
